import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exec } from 'node:child_process';
import { loadConfig, saveConfig, configExists } from './config.ts';
import { importCsvContent } from './csv-import.ts';
import { authStatus, authorize } from './gmail.ts';
import { queueInitial, queueFollowUps, sync } from './sequence.ts';
import { listTemplates, readTemplate, writeTemplate, render } from './templates.ts';
import { eligibleForInitial, getDb, suppress } from './db.ts';

const PAGE = resolve(import.meta.dirname, '../public/index.html');

/** Auth is a browser round-trip, so the button fires it and the UI polls this. */
let authRun: { running: boolean; error: string | null } = { running: false, error: null };

function pipelineCounts(): { statuses: Record<string, number>; drafts: number; total: number } {
  const rows = getDb()
    .prepare('SELECT status, COUNT(*) AS n FROM contacts GROUP BY status')
    .all() as unknown as { status: string; n: number }[];
  const drafts = getDb()
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE state='drafted'")
    .get() as { n: number };

  const statuses: Record<string, number> = {};
  for (const r of rows) statuses[r.status] = r.n;
  return { statuses, drafts: drafts.n, total: rows.reduce((s, r) => s + r.n, 0) };
}

const routes: Record<string, (body: any) => unknown | Promise<unknown>> = {
  'GET /api/state': () => {
    const { hasCredentials, authorized } = authStatus();
    return {
      hasConfig: configExists(),
      config: configExists() ? safeConfig() : null,
      hasCredentials,
      authorized,
      authRunning: authRun.running,
      authError: authRun.error,
      // Initial template first — it's the one that actually gets edited.
      templates: orderedTemplates(),
      ...pipelineCounts(),
    };
  },

  'POST /api/config': (body) => ({ config: saveConfig(body) }),

  'GET /api/template': (body) => ({ content: readTemplate(body.name) }),

  'POST /api/template': (body) => {
    writeTemplate(body.name, body.content);
    return { saved: body.name };
  },

  'POST /api/import': (body) => {
    if (typeof body.content !== 'string' || !body.content.trim()) {
      throw new Error('That file looks empty.');
    }
    const r = importCsvContent(body.content, String(body.filename ?? 'upload.csv'));
    const byReason: Record<string, number> = {};
    for (const s of r.skipped) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
    return { inserted: r.inserted, updated: r.updated, skipped: r.skipped.length, byReason };
  },

  'POST /api/preview': (body) => {
    const cfg = loadConfig();
    const limit = Math.min(Math.max(Number(body.limit) || 3, 1), 25);
    return {
      messages: eligibleForInitial(limit).map((c) => {
        try {
          const { subject, body: text } = render(cfg.initialTemplate, c, cfg);
          return { to: c.email, subject, body: text, error: null };
        } catch (e) {
          return { to: c.email, subject: null, body: null, error: (e as Error).message };
        }
      }),
    };
  },

  'POST /api/queue': (body) => queueInitial(Math.min(Math.max(Number(body.limit) || 10, 1), 200)),
  'POST /api/followup': (body) =>
    queueFollowUps(Math.min(Math.max(Number(body.limit) || 10, 1), 200)),
  'POST /api/sync': () => sync(),

  'POST /api/suppress': (body) => {
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!email) throw new Error('Email is required.');
    suppress(email, String(body.reason ?? 'manual'));
    return { suppressed: email };
  },

  'POST /api/auth': () => {
    if (authRun.running) return { started: true };
    authRun = { running: true, error: null };
    authorize()
      .then(() => {
        authRun = { running: false, error: null };
      })
      .catch((e: Error) => {
        authRun = { running: false, error: e.message };
      });
    return { started: true };
  },
};

function orderedTemplates(): string[] {
  const all = listTemplates();
  const first = configExists() ? loadConfig().initialTemplate : 'initial.txt';
  return all.includes(first) ? [first, ...all.filter((t) => t !== first)] : all;
}

/** Never ship the whole config blindly — only the fields the UI edits. */
function safeConfig() {
  const c = loadConfig();
  return {
    me: c.me,
    signature: c.signature,
    dailyCap: c.dailyCap,
    initialTemplate: c.initialTemplate,
    followUps: c.followUps,
  };
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      // Apollo exports are text; 25 MB is far past any plausible one.
      if (size > 25 * 1024 * 1024) {
        reject(new Error('Upload too large (25 MB max).'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(raw));
      } catch {
        reject(new Error('Malformed request body.'));
      }
    });
    req.on('error', reject);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const key = `${req.method} ${url.pathname}`;

  if (key === 'GET /' || key === 'GET /index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(PAGE, 'utf8'));
    return;
  }

  const route = routes[key];
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  try {
    const body =
      req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readBody(req);
    const result = await route(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result ?? {}));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (e as Error).message }));
  }
}

export function startServer(port: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      handle(req, res).catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      });
    });

    // Loopback only. This server can create Gmail drafts and read your token,
    // so it must never be reachable from the network you're sitting on.
    server.listen(port, '127.0.0.1', () => {
      const url = `http://localhost:${port}`;
      console.log(`\n  autoapp is running at ${url}`);
      console.log('  Bound to localhost only. Ctrl-C to stop.\n');
      if (!process.env.AUTOAPP_NO_OPEN) exec(`open "${url}"`);
      resolvePromise();
    });

    server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        console.error(`Port ${port} is busy. Try: npm run web -- --port ${port + 1}`);
        process.exit(1);
      }
      throw e;
    });
  });
}

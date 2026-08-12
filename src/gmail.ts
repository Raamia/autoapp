import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { gmail_v1 } from 'googleapis';

const CREDENTIALS_PATH = resolve(process.cwd(), 'credentials.json');
const TOKEN_PATH = resolve(process.cwd(), 'token.json');

// compose  -> create drafts (and send them later, if you ever flip that on)
// readonly -> read threads to detect replies and bounces
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.readonly',
];

function oauthClient(): OAuth2Client {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      'credentials.json not found. Create an OAuth "Desktop app" client in Google Cloud\n' +
        '(with the Gmail API enabled) and save the download as credentials.json. See README.',
    );
  }
  const parsed = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'));
  const key = parsed.installed ?? parsed.web;
  if (!key) throw new Error('credentials.json: expected an "installed" or "web" client.');
  return new google.auth.OAuth2(key.client_id, key.client_secret, 'http://localhost:3000');
}

/** Interactive consent flow. Writes token.json. */
export async function authorize(): Promise<void> {
  const client = oauthClient();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force a refresh_token even on re-auth
    scope: SCOPES,
  });

  const code = await new Promise<string>((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      const params = new URL(req.url ?? '/', 'http://localhost:3000').searchParams;
      const err = params.get('error');
      const c = params.get('code');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(err ? `Authorization failed: ${err}` : 'Authorized. You can close this tab.');
      server.close();
      if (err) reject(new Error(err));
      else if (c) resolvePromise(c);
    });
    server.listen(3000, () => {
      console.log('Opening your browser to authorize Gmail access...');
      console.log(`If it doesn't open, visit:\n${url}\n`);
      exec(`open "${url}"`);
    });
    server.on('error', reject);
  });

  const { tokens } = await client.getToken(code);
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  console.log(`Saved credentials to ${TOKEN_PATH}`);
}

export function gmailClient(): gmail_v1.Gmail {
  if (!existsSync(TOKEN_PATH)) {
    throw new Error('Not authorized yet. Run: npm run autoapp -- auth');
  }
  const client = oauthClient();
  client.setCredentials(JSON.parse(readFileSync(TOKEN_PATH, 'utf8')));
  // Persist rotated refresh tokens so long-lived setups don't silently expire.
  client.on('tokens', (t) => {
    const existing = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
    writeFileSync(TOKEN_PATH, JSON.stringify({ ...existing, ...t }, null, 2), { mode: 0o600 });
  });
  return google.gmail({ version: 'v1', auth: client });
}

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

/** RFC 2047 encode a header value only when it actually needs it. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export interface DraftInput {
  from: string;
  fromName: string;
  to: string;
  toName?: string | null;
  subject: string;
  body: string;
  /** Set both to thread a follow-up onto the original conversation. */
  threadId?: string | null;
  inReplyTo?: string | null;
}

function buildMime(d: DraftInput): string {
  const toHeader = d.toName ? `${encodeHeader(d.toName)} <${d.to}>` : d.to;
  const headers = [
    `From: ${encodeHeader(d.fromName)} <${d.from}>`,
    `To: ${toHeader}`,
    `Subject: ${encodeHeader(d.subject)}`,
    'MIME-Version: 1.0',
    // Plain text only. Multipart/HTML mail from a personal account is a
    // measurable deliverability penalty on cold sends.
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];
  if (d.inReplyTo) {
    headers.push(`In-Reply-To: ${d.inReplyTo}`, `References: ${d.inReplyTo}`);
  }
  return `${headers.join('\r\n')}\r\n\r\n${d.body.replace(/\n/g, '\r\n')}`;
}

export async function createDraft(
  gmail: gmail_v1.Gmail,
  input: DraftInput,
): Promise<{ draftId: string; threadId: string | null }> {
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: {
        raw: b64url(buildMime(input)),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      },
    },
  });
  const draftId = res.data.id;
  if (!draftId) throw new Error('Gmail returned a draft with no id.');
  return { draftId, threadId: res.data.message?.threadId ?? null };
}

export async function draftExists(gmail: gmail_v1.Gmail, draftId: string): Promise<boolean> {
  try {
    await gmail.users.drafts.get({ userId: 'me', id: draftId, format: 'minimal' });
    return true;
  } catch (e) {
    if ((e as { code?: number }).code === 404) return false;
    throw e;
  }
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  rfcMessageId: string | null;
  internalDate: Date;
  labels: string[];
}

export async function getThread(
  gmail: gmail_v1.Gmail,
  threadId: string,
): Promise<ThreadMessage[]> {
  const res = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'metadata',
    metadataHeaders: ['From', 'Subject', 'Message-ID'],
  });

  return (res.data.messages ?? []).map((m) => {
    const header = (name: string): string =>
      m.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
    return {
      id: m.id!,
      threadId: m.threadId!,
      from: header('From'),
      subject: header('Subject'),
      rfcMessageId: header('Message-ID') || null,
      internalDate: new Date(Number(m.internalDate ?? 0)),
      labels: m.labelIds ?? [],
    };
  });
}

/** The address Gmail will actually send as — used to tell your messages from theirs. */
export async function getProfileEmail(gmail: gmail_v1.Gmail): Promise<string> {
  const res = await gmail.users.getProfile({ userId: 'me' });
  if (!res.data.emailAddress) throw new Error('Could not read your Gmail address.');
  return res.data.emailAddress.toLowerCase();
}

export const extractAddress = (header: string): string => {
  const m = header.match(/<([^>]+)>/);
  return (m ? m[1] : header).trim().toLowerCase();
};

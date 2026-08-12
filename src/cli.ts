#!/usr/bin/env node
import { loadConfig } from './config.ts';
import { importCsv } from './csv-import.ts';
import { authorize } from './gmail.ts';
import { queueInitial, queueFollowUps, sync } from './sequence.ts';
import { render } from './templates.ts';
import { eligibleForInitial, getDb, suppress } from './db.ts';

const USAGE = `
autoapp — Apollo CSV → reviewed Gmail drafts → follow-ups

  auth                     Authorize Gmail (one time)
  import <file.csv>        Import an Apollo export
  preview [--limit N]      Render the next N messages to stdout (no Gmail calls)
  queue [--limit N]        Create Gmail drafts for the next N contacts
  followup [--limit N]     Create follow-up drafts for silent threads
  sync                     Detect what you sent, who replied, what bounced
  status                   Pipeline counts
  suppress <email> [why]   Never contact this address

Run sync before queue/followup so today's state is current.
`;

function flag(args: string[], name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const n = Number(args[i + 1]);
  if (!Number.isFinite(n) || n < 1) throw new Error(`--${name} needs a positive number.`);
  return n;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'auth':
      await authorize();
      break;

    case 'import': {
      const path = args[0];
      if (!path) throw new Error('Usage: import <file.csv>');
      const r = importCsv(path);
      console.log(`Imported ${r.inserted} new, updated ${r.updated} existing.`);
      if (r.skipped.length) {
        console.log(`Skipped ${r.skipped.length}:`);
        const byReason = new Map<string, number>();
        for (const s of r.skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
        for (const [reason, n] of byReason) console.log(`  ${n} × ${reason}`);
      }
      break;
    }

    case 'preview': {
      const cfg = loadConfig();
      const contacts = eligibleForInitial(flag(args, 'limit', 3));
      if (!contacts.length) {
        console.log('Nothing queued to preview.');
        break;
      }
      for (const c of contacts) {
        console.log('─'.repeat(72));
        console.log(`To: ${c.email}`);
        try {
          const { subject, body } = render(cfg.initialTemplate, c, cfg);
          console.log(`Subject: ${subject}\n\n${body}`);
        } catch (e) {
          console.log(`⚠️  SKIPPED — ${(e as Error).message}`);
        }
      }
      console.log('─'.repeat(72));
      break;
    }

    case 'queue':
      await queueInitial(flag(args, 'limit', 10));
      break;

    case 'followup':
      await queueFollowUps(flag(args, 'limit', 10));
      break;

    case 'sync':
      await sync();
      break;

    case 'status': {
      const rows = getDb()
        .prepare('SELECT status, COUNT(*) AS n FROM contacts GROUP BY status ORDER BY n DESC')
        .all() as unknown as { status: string; n: number }[];
      if (!rows.length) {
        console.log('No contacts yet. Start with: import <file.csv>');
        break;
      }
      const total = rows.reduce((sum, r) => sum + r.n, 0);
      for (const r of rows) console.log(`  ${r.status.padEnd(10)} ${String(r.n).padStart(5)}`);
      console.log(`  ${'total'.padEnd(10)} ${String(total).padStart(5)}`);

      const drafts = getDb()
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE state='drafted'")
        .get() as { n: number };
      if (drafts.n) console.log(`\n  ${drafts.n} draft(s) awaiting your review in Gmail.`);
      break;
    }

    case 'suppress': {
      const email = args[0]?.toLowerCase();
      if (!email) throw new Error('Usage: suppress <email> [reason]');
      suppress(email, args.slice(1).join(' ') || 'manual');
      console.log(`${email} will never be contacted.`);
      break;
    }

    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((e: Error) => {
  console.error(`\nError: ${e.message}`);
  process.exitCode = 1;
});

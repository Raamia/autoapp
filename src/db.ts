import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Contact, Message } from './types.ts';

const DB_PATH = process.env.AUTOAPP_DB ?? resolve(process.cwd(), 'data/autoapp.db');

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id            INTEGER PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      first_name    TEXT,
      last_name     TEXT,
      title         TEXT,
      company       TEXT,
      linkedin_url  TEXT,
      source        TEXT,
      status        TEXT NOT NULL DEFAULT 'new',
      notes         TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY,
      contact_id      INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      step            INTEGER NOT NULL,
      subject         TEXT NOT NULL,
      body            TEXT NOT NULL,
      gmail_draft_id  TEXT,
      gmail_thread_id TEXT,
      gmail_message_id TEXT,
      rfc_message_id  TEXT,
      state           TEXT NOT NULL DEFAULT 'drafted',
      created_at      TEXT NOT NULL,
      sent_at         TEXT,
      -- The hard guarantee that nobody gets the same step twice, even if a
      -- command is re-run or interrupted halfway through a batch.
      UNIQUE (contact_id, step)
    );

    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY,
      contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      detail     TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS suppressions (
      email      TEXT PRIMARY KEY COLLATE NOCASE,
      reason     TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
    CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id);
    CREATE INDEX IF NOT EXISTS idx_messages_state ON messages(state);
  `);
}

export const now = (): string => new Date().toISOString();

/** Insert, or update only the fields a fresh export can improve. Never resets status. */
export function upsertContact(c: Partial<Contact> & { email: string }): 'inserted' | 'updated' {
  const d = getDb();
  const existing = d.prepare('SELECT id FROM contacts WHERE email = ?').get(c.email);
  const ts = now();

  if (existing) {
    d.prepare(
      `UPDATE contacts SET
         first_name   = COALESCE(?, first_name),
         last_name    = COALESCE(?, last_name),
         title        = COALESCE(?, title),
         company      = COALESCE(?, company),
         linkedin_url = COALESCE(?, linkedin_url),
         updated_at   = ?
       WHERE email = ?`,
    ).run(
      c.first_name ?? null,
      c.last_name ?? null,
      c.title ?? null,
      c.company ?? null,
      c.linkedin_url ?? null,
      ts,
      c.email,
    );
    return 'updated';
  }

  d.prepare(
    `INSERT INTO contacts
       (email, first_name, last_name, title, company, linkedin_url, source, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
  ).run(
    c.email,
    c.first_name ?? null,
    c.last_name ?? null,
    c.title ?? null,
    c.company ?? null,
    c.linkedin_url ?? null,
    c.source ?? null,
    ts,
    ts,
  );
  return 'inserted';
}

export function setContactStatus(contactId: number, status: string): void {
  getDb()
    .prepare('UPDATE contacts SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, now(), contactId);
}

export function logEvent(contactId: number | null, type: string, detail?: string): void {
  getDb()
    .prepare('INSERT INTO events (contact_id, type, detail, created_at) VALUES (?, ?, ?, ?)')
    .run(contactId, type, detail ?? null, now());
}

export function isSuppressed(email: string): boolean {
  return getDb().prepare('SELECT 1 FROM suppressions WHERE email = ?').get(email) !== undefined;
}

export function suppress(email: string, reason: string): void {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO suppressions (email, reason, created_at) VALUES (?, ?, ?)',
    )
    .run(email, reason, now());
}

/** Drafts created since local midnight — what the daily cap is measured against. */
export function draftsCreatedToday(): number {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?')
    .get(midnight.toISOString()) as { n: number };
  return row.n;
}

/**
 * Contacts eligible for a first message: never contacted, not suppressed,
 * and with the fields the template needs.
 */
export function eligibleForInitial(limit: number): Contact[] {
  return getDb()
    .prepare(
      `SELECT c.* FROM contacts c
       WHERE c.status = 'new'
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email)
       ORDER BY c.id
       LIMIT ?`,
    )
    .all(limit) as unknown as Contact[];
}

/**
 * Contacts due for follow-up step N: last message was sent at least
 * `afterDays` ago, they never replied, and step N doesn't exist yet.
 */
export function dueForFollowUp(step: number, afterDays: number, limit: number): Contact[] {
  const cutoff = new Date(Date.now() - afterDays * 86_400_000).toISOString();
  return getDb()
    .prepare(
      `SELECT c.* FROM contacts c
       JOIN messages prev ON prev.contact_id = c.id AND prev.step = ?
       WHERE c.status = 'active'
         AND prev.state = 'sent'
         AND prev.sent_at IS NOT NULL
         AND prev.sent_at <= ?
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = c.id AND m.step = ?)
         AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email)
       ORDER BY prev.sent_at
       LIMIT ?`,
    )
    .all(step - 1, cutoff, step, limit) as unknown as Contact[];
}

export function recordDraft(m: {
  contactId: number;
  step: number;
  subject: string;
  body: string;
  draftId: string;
  threadId: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO messages
         (contact_id, step, subject, body, gmail_draft_id, gmail_thread_id, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'drafted', ?)`,
    )
    .run(m.contactId, m.step, m.subject, m.body, m.draftId, m.threadId, now());
}

export function openDrafts(): Message[] {
  return getDb()
    .prepare("SELECT * FROM messages WHERE state = 'drafted' ORDER BY created_at")
    .all() as unknown as Message[];
}

export function threadsAwaitingReply(): Message[] {
  return getDb()
    .prepare(
      `SELECT m.* FROM messages m
       JOIN contacts c ON c.id = m.contact_id
       WHERE m.state = 'sent'
         AND m.gmail_thread_id IS NOT NULL
         AND c.status = 'active'
         AND m.step = (
           SELECT MAX(m2.step) FROM messages m2
           WHERE m2.contact_id = m.contact_id AND m2.state = 'sent'
         )`,
    )
    .all() as unknown as Message[];
}

export function markSent(
  messageId: number,
  gmailMessageId: string,
  threadId: string,
  rfcMessageId: string | null,
  sentAt: string,
): void {
  getDb()
    .prepare(
      `UPDATE messages SET state='sent', gmail_message_id=?, gmail_thread_id=?,
         rfc_message_id=?, sent_at=? WHERE id=?`,
    )
    .run(gmailMessageId, threadId, rfcMessageId, sentAt, messageId);
}

export function markDiscarded(messageId: number): void {
  getDb().prepare("UPDATE messages SET state='discarded' WHERE id=?").run(messageId);
}

export function getContact(id: number): Contact | undefined {
  return getDb().prepare('SELECT * FROM contacts WHERE id = ?').get(id) as unknown as
    | Contact
    | undefined;
}

/** Latest sent message in a contact's thread — the anchor for threading a follow-up. */
export function lastSentMessage(contactId: number): Message | undefined {
  return getDb()
    .prepare(
      "SELECT * FROM messages WHERE contact_id=? AND state='sent' ORDER BY step DESC LIMIT 1",
    )
    .get(contactId) as unknown as Message | undefined;
}

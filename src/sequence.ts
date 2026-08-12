import type { gmail_v1 } from 'googleapis';
import { loadConfig } from './config.ts';
import { render, TemplateError } from './templates.ts';
import {
  createDraft,
  draftExists,
  extractAddress,
  getProfileEmail,
  getThread,
  gmailClient,
} from './gmail.ts';
import {
  draftsCreatedToday,
  dueForFollowUp,
  eligibleForInitial,
  getContact,
  lastSentMessage,
  logEvent,
  markDiscarded,
  markSent,
  openDrafts,
  recordDraft,
  setContactStatus,
  suppress,
  threadsAwaitingReply,
} from './db.ts';
import { readResume, type LoadedAttachment } from './attachments.ts';
import type { Config, Contact } from './types.ts';

/**
 * The resume for a given step, or null. Read once per run rather than per
 * contact — the same bytes go to everyone in the batch.
 */
export function attachmentForStep(cfg: Config, step: number): LoadedAttachment | null {
  const { file, attachTo } = cfg.resume ?? { file: null, attachTo: 'none' };
  if (!file || attachTo === 'none') return null;
  if (attachTo === 'initial' && step !== 0) return null;
  if (attachTo === 'followups' && step === 0) return null;
  return readResume(file);
}

export interface QueueResult {
  created: number;
  drafted: string[];
  skipped: { who: string; reason: string }[];
  /** Set when the daily cap trimmed or blocked this run. */
  capNote: string | null;
}

export interface SyncResult {
  sent: number;
  replied: number;
  bounced: number;
  discarded: number;
  notes: string[];
}

const label = (c: Contact): string =>
  `${[c.first_name, c.last_name].filter(Boolean).join(' ') || c.email} <${c.email}>`;

const recipientName = (c: Contact): string | null =>
  [c.first_name, c.last_name].filter(Boolean).join(' ') || null;

/** How many drafts we may still create today, plus a note if we had to trim. */
function budgetForToday(cfg: Config, requested: number): { limit: number; note: string | null } {
  const used = draftsCreatedToday();
  const left = Math.max(0, cfg.dailyCap - used);
  if (left === 0) {
    return { limit: 0, note: `Daily cap reached — ${used}/${cfg.dailyCap} drafts created today.` };
  }
  if (requested > left) {
    return {
      limit: left,
      note: `Trimmed to ${left} — daily cap is ${cfg.dailyCap} and ${used} were already created today.`,
    };
  }
  return { limit: requested, note: null };
}

export async function queueInitial(requested: number): Promise<QueueResult> {
  const cfg = loadConfig();
  const { limit, note } = budgetForToday(cfg, requested);
  const result: QueueResult = { created: 0, drafted: [], skipped: [], capNote: note };
  if (limit === 0) return result;

  const contacts = eligibleForInitial(limit);
  if (contacts.length === 0) return result;

  const gmail = gmailClient();
  const attachment = attachmentForStep(cfg, 0);

  for (const contact of contacts) {
    let subject: string, body: string;
    try {
      ({ subject, body } = render(cfg.initialTemplate, contact, cfg));
    } catch (e) {
      if (e instanceof TemplateError) {
        result.skipped.push({ who: label(contact), reason: e.message });
        continue;
      }
      throw e;
    }

    const { draftId, threadId } = await createDraft(gmail, {
      from: cfg.me.email,
      fromName: cfg.me.name,
      to: contact.email,
      toName: recipientName(contact),
      subject,
      body,
      attachment,
    });

    recordDraft({ contactId: contact.id, step: 0, subject, body, draftId, threadId });
    setContactStatus(contact.id, 'active');
    result.created++;
    result.drafted.push(label(contact));
  }

  return result;
}

export async function queueFollowUps(requested: number): Promise<QueueResult> {
  const cfg = loadConfig();
  const result: QueueResult = { created: 0, drafted: [], skipped: [], capNote: null };
  if (!cfg.followUps?.length) return result;

  const { limit, note } = budgetForToday(cfg, requested);
  result.capNote = note;
  let budget = limit;
  if (budget === 0) return result;

  const gmail = gmailClient();

  for (const step of [...cfg.followUps].sort((a, b) => a.step - b.step)) {
    if (budget === 0) break;
    const due = dueForFollowUp(step.step, step.afterDays, budget);
    const attachment = attachmentForStep(cfg, step.step);

    for (const contact of due) {
      const previous = lastSentMessage(contact.id);
      if (!previous?.gmail_thread_id) continue;

      let subject: string, body: string;
      try {
        ({ subject, body } = render(step.template, contact, cfg));
      } catch (e) {
        if (e instanceof TemplateError) {
          result.skipped.push({ who: label(contact), reason: e.message });
          continue;
        }
        throw e;
      }

      const { draftId, threadId } = await createDraft(gmail, {
        from: cfg.me.email,
        fromName: cfg.me.name,
        to: contact.email,
        toName: recipientName(contact),
        // Keep Gmail's own "Re:" convention so it reads as a real thread.
        subject: subject.startsWith('Re:') ? subject : `Re: ${previous.subject}`,
        body,
        threadId: previous.gmail_thread_id,
        inReplyTo: previous.rfc_message_id,
        attachment,
      });

      recordDraft({ contactId: contact.id, step: step.step, subject, body, draftId, threadId });
      result.created++;
      result.drafted.push(`follow-up ${step.step} → ${label(contact)}`);
      budget--;
      if (budget === 0) break;
    }
  }

  return result;
}

/**
 * Reconcile local state with what actually happened in Gmail:
 * which drafts you sent, who replied, and what bounced.
 */
export async function sync(): Promise<SyncResult> {
  const gmail = gmailClient();
  const me = await getProfileEmail(gmail);
  const result: SyncResult = { sent: 0, replied: 0, bounced: 0, discarded: 0, notes: [] };

  await reconcileDrafts(gmail, me, result);
  await detectReplies(gmail, me, result);
  return result;
}

async function reconcileDrafts(
  gmail: gmail_v1.Gmail,
  me: string,
  result: SyncResult,
): Promise<void> {
  for (const msg of openDrafts()) {
    if (!msg.gmail_draft_id) continue;
    if (await draftExists(gmail, msg.gmail_draft_id)) continue; // still sitting in Drafts

    // The draft is gone: you either sent it or deleted it. The thread tells us which.
    let mine: Awaited<ReturnType<typeof getThread>>[number] | undefined;
    if (msg.gmail_thread_id) {
      try {
        const thread = await getThread(gmail, msg.gmail_thread_id);
        mine = thread.find((t) => t.labels.includes('SENT') && extractAddress(t.from) === me);
      } catch {
        mine = undefined;
      }
    }

    const contact = getContact(msg.contact_id);

    if (mine) {
      markSent(msg.id, mine.id, mine.threadId, mine.rfcMessageId, mine.internalDate.toISOString());
      result.sent++;
    } else {
      markDiscarded(msg.id);
      // You deleted the draft rather than sending it — read that as "not this person".
      setContactStatus(msg.contact_id, 'skipped');
      logEvent(msg.contact_id, 'draft_discarded', `step ${msg.step}`);
      result.discarded++;
      result.notes.push(`skipped — you deleted the draft to ${contact?.email ?? msg.contact_id}`);
    }
  }
}

async function detectReplies(
  gmail: gmail_v1.Gmail,
  me: string,
  result: SyncResult,
): Promise<void> {
  for (const msg of threadsAwaitingReply()) {
    if (!msg.gmail_thread_id) continue;

    let thread: Awaited<ReturnType<typeof getThread>>;
    try {
      thread = await getThread(gmail, msg.gmail_thread_id);
    } catch {
      continue;
    }

    const sentAt = msg.sent_at ? new Date(msg.sent_at) : new Date(0);
    const inbound = thread.filter((t) => extractAddress(t.from) !== me && t.internalDate >= sentAt);
    if (inbound.length === 0) continue;

    const contact = getContact(msg.contact_id);
    const bounce = inbound.find((t) => /mailer-daemon|postmaster/i.test(t.from));

    if (bounce) {
      setContactStatus(msg.contact_id, 'bounced');
      logEvent(msg.contact_id, 'bounce', bounce.subject);
      if (contact) suppress(contact.email, 'hard bounce');
      result.bounced++;
      result.notes.push(`bounced — ${contact?.email ?? msg.contact_id} suppressed`);
    } else {
      setContactStatus(msg.contact_id, 'replied');
      logEvent(msg.contact_id, 'reply', inbound[0].from);
      result.replied++;
      result.notes.push(`replied — ${contact?.email ?? msg.contact_id} (sequence stopped)`);
    }
  }
}

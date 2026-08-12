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
import type { Config, Contact } from './types.ts';

/** How many drafts we may still create today. */
function remainingToday(cfg: Config, requested: number): number {
  const used = draftsCreatedToday();
  const left = Math.max(0, cfg.dailyCap - used);
  if (left === 0) {
    console.log(`Daily cap reached (${used}/${cfg.dailyCap} drafts created today).`);
  } else if (requested > left) {
    console.log(`Trimming to ${left} — daily cap is ${cfg.dailyCap}, ${used} already created.`);
  }
  return Math.min(requested, left);
}

const label = (c: Contact): string =>
  `${[c.first_name, c.last_name].filter(Boolean).join(' ') || c.email} <${c.email}>`;

export async function queueInitial(requested: number): Promise<void> {
  const cfg = loadConfig();
  const limit = remainingToday(cfg, requested);
  if (limit === 0) return;

  const contacts = eligibleForInitial(limit);
  if (contacts.length === 0) {
    console.log('No contacts waiting for a first message. Import an Apollo CSV first.');
    return;
  }

  const gmail = gmailClient();
  let created = 0;
  const skipped: string[] = [];

  for (const contact of contacts) {
    let subject: string, body: string;
    try {
      ({ subject, body } = render(cfg.initialTemplate, contact, cfg));
    } catch (e) {
      if (e instanceof TemplateError) {
        skipped.push(`${label(contact)} — ${e.message}`);
        continue;
      }
      throw e;
    }

    const { draftId, threadId } = await createDraft(gmail, {
      from: cfg.me.email,
      fromName: cfg.me.name,
      to: contact.email,
      toName: [contact.first_name, contact.last_name].filter(Boolean).join(' ') || null,
      subject,
      body,
    });

    recordDraft({ contactId: contact.id, step: 0, subject, body, draftId, threadId });
    setContactStatus(contact.id, 'active');
    created++;
    console.log(`  drafted → ${label(contact)}`);
  }

  console.log(`\n${created} draft(s) created in Gmail. Review and send them yourself.`);
  if (skipped.length) {
    console.log(`\n${skipped.length} skipped (missing data — fix the CSV and re-import):`);
    for (const s of skipped) console.log(`  - ${s}`);
  }
}

export async function queueFollowUps(requested: number): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.followUps?.length) {
    console.log('No follow-up steps configured.');
    return;
  }
  let budget = remainingToday(cfg, requested);
  if (budget === 0) return;

  const gmail = gmailClient();
  let created = 0;

  for (const step of [...cfg.followUps].sort((a, b) => a.step - b.step)) {
    if (budget === 0) break;
    const due = dueForFollowUp(step.step, step.afterDays, budget);

    for (const contact of due) {
      const previous = lastSentMessage(contact.id);
      if (!previous?.gmail_thread_id) continue;

      let subject: string, body: string;
      try {
        ({ subject, body } = render(step.template, contact, cfg));
      } catch (e) {
        if (e instanceof TemplateError) continue;
        throw e;
      }

      const { draftId, threadId } = await createDraft(gmail, {
        from: cfg.me.email,
        fromName: cfg.me.name,
        to: contact.email,
        toName: [contact.first_name, contact.last_name].filter(Boolean).join(' ') || null,
        // Keep Gmail's own "Re:" convention so it reads as a real thread.
        subject: subject.startsWith('Re:') ? subject : `Re: ${previous.subject}`,
        body,
        threadId: previous.gmail_thread_id,
        inReplyTo: previous.rfc_message_id,
      });

      recordDraft({ contactId: contact.id, step: step.step, subject, body, draftId, threadId });
      created++;
      budget--;
      console.log(`  follow-up ${step.step} drafted → ${label(contact)}`);
      if (budget === 0) break;
    }
  }

  console.log(created ? `\n${created} follow-up draft(s) created.` : 'Nothing due for follow-up.');
}

/**
 * Reconcile local state with what actually happened in Gmail:
 * which drafts you sent, who replied, and what bounced.
 */
export async function sync(): Promise<void> {
  const gmail = gmailClient();
  const me = await getProfileEmail(gmail);

  const sentNow = await reconcileDrafts(gmail, me);
  const { replied, bounced } = await detectReplies(gmail, me);

  console.log(
    `Sync complete — ${sentNow} newly sent, ${replied} replied, ${bounced} bounced.`,
  );
}

async function reconcileDrafts(gmail: gmail_v1.Gmail, me: string): Promise<number> {
  let sent = 0;

  for (const msg of openDrafts()) {
    if (!msg.gmail_draft_id) continue;
    if (await draftExists(gmail, msg.gmail_draft_id)) continue; // still sitting in Drafts

    // The draft is gone: you either sent it or deleted it. The thread tells us which.
    let mine: Awaited<ReturnType<typeof getThread>>[number] | undefined;
    if (msg.gmail_thread_id) {
      try {
        const thread = await getThread(gmail, msg.gmail_thread_id);
        mine = thread.find(
          (t) => t.labels.includes('SENT') && extractAddress(t.from) === me,
        );
      } catch {
        mine = undefined;
      }
    }

    if (mine) {
      markSent(msg.id, mine.id, mine.threadId, mine.rfcMessageId, mine.internalDate.toISOString());
      sent++;
    } else {
      markDiscarded(msg.id);
      // You deleted the draft rather than sending it — read that as "not this person".
      setContactStatus(msg.contact_id, 'skipped');
      logEvent(msg.contact_id, 'draft_discarded', `step ${msg.step}`);
    }
  }
  return sent;
}

async function detectReplies(
  gmail: gmail_v1.Gmail,
  me: string,
): Promise<{ replied: number; bounced: number }> {
  let replied = 0;
  let bounced = 0;

  for (const msg of threadsAwaitingReply()) {
    if (!msg.gmail_thread_id) continue;

    let thread: Awaited<ReturnType<typeof getThread>>;
    try {
      thread = await getThread(gmail, msg.gmail_thread_id);
    } catch {
      continue;
    }

    const sentAt = msg.sent_at ? new Date(msg.sent_at) : new Date(0);
    const inbound = thread.filter(
      (t) => extractAddress(t.from) !== me && t.internalDate >= sentAt,
    );
    if (inbound.length === 0) continue;

    const contact = getContact(msg.contact_id);
    const bounce = inbound.find((t) => /mailer-daemon|postmaster/i.test(t.from));

    if (bounce) {
      setContactStatus(msg.contact_id, 'bounced');
      logEvent(msg.contact_id, 'bounce', bounce.subject);
      if (contact) suppress(contact.email, 'hard bounce');
      bounced++;
      console.log(`  bounced  ← ${contact?.email ?? msg.contact_id}`);
    } else {
      setContactStatus(msg.contact_id, 'replied');
      logEvent(msg.contact_id, 'reply', inbound[0].from);
      replied++;
      console.log(`  replied  ← ${contact?.email ?? msg.contact_id} (sequence stopped)`);
    }
  }

  return { replied, bounced };
}

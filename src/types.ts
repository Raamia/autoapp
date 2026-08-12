/** Lifecycle of a contact. Only `new` and `active` are eligible for new drafts. */
export type ContactStatus =
  | 'new' // imported, never contacted
  | 'active' // in a sequence, awaiting reply
  | 'replied' // they answered — sequence stops permanently
  | 'bounced' // hard bounce, do not retry
  | 'closed' // sequence exhausted, no reply
  | 'skipped'; // manually excluded

export type MessageState = 'drafted' | 'sent' | 'discarded';

export interface Contact {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  company: string | null;
  linkedin_url: string | null;
  source: string | null;
  status: ContactStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: number;
  contact_id: number;
  /** 0 = initial outreach, 1..n = follow-ups. */
  step: number;
  subject: string;
  body: string;
  gmail_draft_id: string | null;
  gmail_thread_id: string | null;
  gmail_message_id: string | null;
  /** RFC822 Message-ID header, needed to thread follow-ups correctly. */
  rfc_message_id: string | null;
  state: MessageState;
  created_at: string;
  sent_at: string | null;
}

export interface FollowUpConfig {
  step: number;
  afterDays: number;
  template: string;
}

export interface Config {
  me: { name: string; email: string };
  signature: string;
  /** Max drafts created per calendar day, across initial + follow-ups. */
  dailyCap: number;
  initialTemplate: string;
  followUps: FollowUpConfig[];
}

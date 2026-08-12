# autoapp

Turns an Apollo CSV export into personalized Gmail **drafts**, tracks who you
actually sent to, notices replies, and queues follow-ups for the silent ones.

Nothing is ever sent automatically. The tool writes drafts; you review and hit
send. That's deliberate — the first hundred messages are how you find out your
template is bad, and you want eyes on them.

## Setup

```bash
npm install
```

**1. Config**

`config.json` already exists — edit it with your real name, Gmail address and
signature, and set `dailyCap` (start at 20–25).

**2. Gmail credentials**

1. Go to the [Google Cloud Console](https://console.cloud.google.com/), create a project.
2. Enable the **Gmail API**.
3. OAuth consent screen → **External**, add yourself as a test user.
4. Credentials → Create credentials → **OAuth client ID** → **Desktop app**.
5. Download the JSON, save it in this folder as `credentials.json`.

```bash
npm run autoapp -- auth
```

Requests two scopes: `gmail.compose` (create drafts) and `gmail.readonly`
(read threads to detect replies).

**3. Templates**

Edit `templates/initial.txt` and the two follow-ups. Two kinds of placeholder:

- `{{first_name}}`, `{{company}}`, `{{title}}`, `{{signature}}` — filled per contact
- `[YOUR ROLE]`, `[DOMAIN]` — **you** replace these once, by hand

A contact missing a value the template needs is skipped with a warning rather
than emailed "Hi ,". If you drop `{{company}}` from a template, contacts with
no company become eligible again.

## Daily loop — web UI

```bash
npm run web
```

Opens <http://localhost:4173>. Everything is on one page: your details and the
Gmail connect button, the template editor, your resume, a drag-and-drop zone for
Apollo CSVs, and buttons for Preview / Create drafts / Sync / Follow-ups.

The server binds to `127.0.0.1` only — it can create Gmail drafts and read your
token, so it must never be reachable from the network you're on. It is not
authenticated, because nothing off your machine can reach it.

## Daily loop — CLI

Same operations, if you'd rather script it:

```bash
npm run autoapp -- import ~/Downloads/apollo-export.csv
npm run autoapp -- preview --limit 3      # read them before anything is created
npm run autoapp -- queue --limit 20       # creates Gmail drafts
# → go to Gmail, review, send the ones you like, delete the ones you don't
npm run autoapp -- sync                   # records what you sent + who replied
npm run autoapp -- followup               # drafts follow-ups for silent threads
npm run autoapp -- status
```

`sync` is the one that keeps state honest — run it before `queue` or `followup`.
It checks each draft: gone from Drafts **and** present in the thread as sent →
recorded as sent. Gone and not sent → you deleted it, so the contact is marked
`skipped` and never queued again.

## How it decides things

| Rule | Where |
|---|---|
| Nobody gets the same step twice | `UNIQUE(contact_id, step)` in the schema |
| A reply stops the whole sequence | `sync` sets status `replied` |
| Bounces are suppressed permanently | `sync` adds them to `suppressions` |
| Daily cap counts drafts, not sends | `draftsCreatedToday()` |
| Re-importing an overlapping CSV is safe | upsert on email, status never reset |

Contact status: `new → active → replied | bounced | closed | skipped`.

## Resume attachment

Drop a PDF/DOC/DOCX/TXT (10 MB max) into the Resume section. Choose when it
rides along:

| Setting | Attaches to |
|---|---|
| `initial` | The first email only — the default on first upload |
| `followups` | Follow-ups only |
| `all` | Every email in the sequence |
| `none` | Nothing (the file stays uploaded) |

The file lives in `attachments/` and is gitignored — it's a personal document
and should never be committed.

Messages without an attachment stay `text/plain`; only messages that carry the
resume become `multipart/mixed`. That matters, because an attachment on a cold
first email is a genuine spam signal, and some corporate filters quarantine mail
with attachments from unknown senders. **`followups` is the safer pattern** — the
first email asks whether they want the resume, the follow-up delivers it, and by
then you're a known sender in an existing thread.

## Volume and deliverability

Gmail's hard limits are 500 recipients/day (personal) and 2000 (Workspace), but
those are the *ban* thresholds, not safe operating levels. Cold outreach from a
personal address wants 20–40/day. The config warns above 50.

The MIME the tool builds is deliberately plain: text/plain only, no HTML, no
tracking pixel, no link in the body. Each of those is a spam signal, and open
tracking in particular buys a vanity metric in exchange for worse inbox
placement.

If this ever grows past a few hundred sends, move to a real sending service
(Resend, Postmark) on a separate domain rather than your personal Gmail — at
that volume you're in CAN-SPAM territory and you don't want your primary
address carrying the reputation risk.

## Files

```
src/cli.ts          command dispatch
src/server.ts       local HTTP API behind the web UI
public/index.html   the whole UI — one file, no build step
src/db.ts           schema + every query that decides who gets contacted
src/csv-import.ts   Apollo column mapping, dedupe, validation
src/attachments.ts  resume storage, filename sanitizing, size/type limits
src/templates.ts    {{var}} rendering, fails loudly on missing data
src/gmail.ts        OAuth, MIME building, drafts, thread reads
src/sequence.ts     queue / follow-up / sync orchestration
```

The UI and the CLI call the same functions in `sequence.ts`, so they can't drift
apart — a rule enforced in one is enforced in both.

State lives in `data/autoapp.db` (SQLite). `credentials.json`, `token.json`,
`config.json`, `*.csv` and `data/` are all gitignored — none of them should
ever be committed.

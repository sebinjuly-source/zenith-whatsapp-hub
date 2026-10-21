# Zenith WhatsApp Hub

One server for several WhatsApp numbers (hiring, guests, …): pulls each number's **full chat history**,
keeps it in Postgres, and lets you, Google Apps Script and AI agents read, search and send — with
per-number rules for delays, daily limits, sending hours and draft-for-approval.

- **Engine:** [Baileys](https://github.com/WhiskeySockets/Baileys) v7 (WhatsApp Web protocol, linked device — your phone keeps working normally)
- **Storage:** Postgres (Supabase in production; an embedded local Postgres when `DATABASE_URL` is empty). WhatsApp logins are stored in the database too, so Render wipes/restarts don't log you out.
- **Dashboard:** `/` — task board per number, numbers & QR/pairing-code linking (choose full / recent / no history), inbox, drafts/outbox, per-number settings, activity
- **REST API:** `/api/*` — see below
- **MCP for AI agents:** `/mcp/<API_KEY>`
- **Meta WhatsApp Cloud API numbers** alongside linked phones (templates, 24 h window, prices, health check)

**→ Full guide (numbers, daily flow, every page, sending rules, Meta, AI tools, REST, speed): [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)**

## Run locally

```bash
npm install
cp .env.example .env   # set API_KEY (and DATABASE_URL to use Supabase)
npm start              # http://localhost:3000
npm test
```

## Deploy (Render free + Supabase free)

1. Supabase → new project → **Project Settings → Database → Connection string → Session pooler** (IPv4; Render can't reach the direct IPv6 host). That's `DATABASE_URL`.
2. Render → New → Blueprint → this repo (uses `render.yaml`). Fill `API_KEY` (long random string) and `DATABASE_URL`.
   Optional: `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` to keep saved media in Supabase Storage (create a private bucket `whatsapp-media`) instead of the database.
3. Keep the free instance awake: an Apps Script time-driven trigger every 10 min calling `<server>/health` (snippet on the dashboard's *Connect AI & apps* page).
4. Open the dashboard, add a number, scan the QR (or use a pairing code). **Keep the phone online with WhatsApp open, and don't redeploy, until "Full history synced" shows.**

Only one server may run a given number at a time (a second one gets "Running elsewhere").

## Everyday features

- **Templates** — saved messages with {name}/{first_name}/{phone} (from the contact) and any other {field}; optional file. Inbox "Template…" picker, bulk sends, MCP.
- **Reminders** — "Remind me" hides a chat until a date; it comes back on top as *Reminder due*. "Done" closes it. A new message from them reopens it.
- **Reply to a message** — "↪ reply" in the inbox quotes it; REST replyTo, MCP reply_to_message_id.
- **One person across numbers** — contact panel "Also on", MCP find_person.
- **Rules** — per number: when (person/group, new/known sender, message types, words) → tag, status, save file, board task, auto-reply template (once per person per day), remind later.
- **Lists + automatic follow-ups** — import a batch (Lists page, MCP import_list, REST /api/lists/import, or the Google Sheet script). Each person's status (not messaged / sent / replied / failed / opted out) is worked out from the real WhatsApp messages since the list's start date. "Message not-messaged + failed" sends each person their own prepared message. Follow-ups: silent for N days → a follow-up quoting your last message, up to N times, checked every 10 min.
- **Pipeline** — per person: stage (interested → date_given → visited/trial → selected → joined; or no_show / not_interested / rejected) and visit date. Automatic: ask interested people for a date, reminder before the visit + owner task, "did they come?" task. Warm leads go before bulk sends and follow-ups. Closed stages are never messaged again.
- **Follow-up timing** — per number: not before followupStart (default 21:00), at most followupDailyMax (default 5) a day, only on days with no first messages to new people.
- **Playbook** — your rules for the AI, stored in the hub (Settings page), sent to every MCP client as server instructions and via get_playbook.
- **App** — installable (PWA) on PC and phone. On this PC: Desktop shortcut "WhatsApp Hub" (cloud) and "WhatsApp Hub (local – full history linking)" (scripts/start-local.cmd).
- **Google Sheets (optional)** — apps-script/ListSync.gs: paste into the sheet's Apps Script, set the API key and column names, run setup(). It pushes rows to the hub and writes status columns back every 15 min.
- **Alerts** — set ALERT_PHONE to get a WhatsApp when a number is logged out or offline for 15+ min.
- **Idempotency** — idempotencyKey / Idempotency-Key header: a retried request never sends twice.

## Reliability notes

- WhatsApp's encryption keys live in memory (like a file-based bot) and are saved to Postgres in the background (~0.3 s), so sending never waits on the database.
- A per-number lease in Postgres guarantees only one server runs a number (PC first sync → Render hand-over, overlapping Render deploys).
- Every send has a time limit; an interrupted send is marked failed, never re-sent blindly. Your own/API sends jump ahead of bulk sends.
- Messages that arrive while the server is offline are delivered by WhatsApp on reconnect. After ~14 days offline WhatsApp unlinks the device — re-link with "Recent" to fill the gap.
- On Render the server pings itself every 10 min so the free plan doesn't sleep.

## Linking & history

- Linked as a desktop companion that requests full history. WhatsApp sends history **only when a device is first linked**; the phone decides how far back (usually years). Older gaps for one chat: "Fetch older from phone" (best effort).
- Chats/contacts you **blocked** are included and tagged; chats you **deleted** on the phone are gone.
- Contacts shared as cards (vCards) are parsed — searchable by name/number and listed by the `list_shared_contacts` tool.
- Media: only metadata is stored; files are fetched from WhatsApp on demand. Per-number auto-save for PDFs and images (only from people you've chatted with, size limit, heavily-forwarded files skipped). Very old media may have expired on WhatsApp's servers.
- WhatsApp unlinks companions if the phone is offline ~14 days. Max 4 linked devices per number.

## Sending rules

| Who sends | Goes out |
|---|---|
| You (dashboard), REST API, Apps Script | immediately, ≥ 5 s apart |
| AI agents (MCP) and campaigns | **draft for approval** or **automatic** (per number); random delay (min 5 s), daily cap, sending hours/days, "typing…" |

Replies with an opt-out word ("stop", "not interested", …) tag the contact `opted-out`.

## REST API (header `x-api-key: <API_KEY>` or `?key=<API_KEY>`)

| Method | Path | Body / query |
|---|---|---|
| POST | `/api/send` | `{ account?, to, text?, attachment?: { url \| base64, fileName?, caption?, as? }, wait? = true }` |
| POST | `/webhook` | old whatsapp-form-bot body `{ phone, message, imageUrl?, documentUrl?, account? }` → `200 Success` |
| GET | `/api/accounts` | numbers, status, stats |
| GET | `/api/accounts/:id/chats` | `q, kind=direct\|group, tag, waiting=1, limit, offset` |
| GET | `/api/accounts/:id/chats/:jid/messages` | `limit, before, after` |
| GET | `/api/search` | `q, account, chat, fromMe, since, until, type, limit` |
| PATCH | `/api/accounts/:id/contacts/:jid` | `{ addTags, removeTags, leadStatus, notes, summary, markReviewed }` |
| GET | `/api/outbox` · POST `/api/outbox/:id/approve` · `/reject` | drafts & queue (`?task=` filters by task) |
| POST | `/api/bulk` | `{ account, title, text (uses {name}), recipients: [{ to, name, … }], attachment?, scheduledAt?, skipIfContactedDays? }` → one task |
| GET/POST/PATCH | `/api/tasks` · `/api/tasks/:id` · POST `/api/tasks/:id/approve` · `/cancel` | task board |
| GET | `/api/media/:id/:jid/:msgId` | file (`?save=1` keeps a copy) |

`account` = account id (e.g. `hiring`) or its phone number; omitted = default number.
Phone numbers: `9198…`, `+91 98…`, or 10-digit Indian numbers (91 is added).

## MCP tools

See [docs/HOW-IT-WORKS.md §6](docs/HOW-IT-WORKS.md) for the full current list (lists & funnel, Meta templates,
health check, timeline, move_messages, Board cards via `list_tasks kind=reply`, …).

All return compact one-line-per-item text with small default limits; agents save summaries/tags with
`update_contact` (+ `mark_reviewed`) so later sessions don't re-read whole chats.

```bash
claude mcp add --transport http --scope user whatsapp https://<server>/mcp/<API_KEY>
```

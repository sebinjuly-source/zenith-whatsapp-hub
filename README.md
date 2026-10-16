# Zenith WhatsApp Hub

One server for several WhatsApp numbers (hiring, guests, …): pulls each number's **full chat history**,
keeps it in Postgres, and lets you, Google Apps Script and AI agents read, search and send — with
per-number rules for delays, daily limits, sending hours and draft-for-approval.

- **Engine:** [Baileys](https://github.com/WhiskeySockets/Baileys) v7 (WhatsApp Web protocol, linked device — your phone keeps working normally)
- **Storage:** Postgres (Supabase in production; an embedded local Postgres when `DATABASE_URL` is empty). WhatsApp logins are stored in the database too, so Render wipes/restarts don't log you out.
- **Dashboard:** `/` — numbers & QR/pairing-code linking, inbox, drafts/outbox, per-number settings, activity
- **REST API:** `/api/*` — see below
- **MCP for AI agents:** `/mcp/<API_KEY>`

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
| GET | `/api/outbox` · POST `/api/outbox/:id/approve` · `/reject` | drafts & queue |
| GET | `/api/media/:id/:jid/:msgId` | file (`?save=1` keeps a copy) |

`account` = account id (e.g. `hiring`) or its phone number; omitted = default number.
Phone numbers: `9198…`, `+91 98…`, or 10-digit Indian numbers (91 is added).

## MCP tools

`list_accounts, list_chats, get_messages, search_messages, list_shared_contacts, find_followups, get_contact,
update_contact, send_message, list_outbox, approve_draft, reject_draft, save_media, fetch_older_messages`

All return compact one-line-per-item text with small default limits; agents save summaries/tags with
`update_contact` (+ `mark_reviewed`) so later sessions don't re-read whole chats.

```bash
claude mcp add --transport http --scope user whatsapp https://<server>/mcp/<API_KEY>
```

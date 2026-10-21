# Zenith WhatsApp Hub — how it works and how to use it

One server that runs all of Zenith's WhatsApp numbers, keeps every chat in one database, and lets you, Google
Sheets/Apps Script and AI assistants (Claude) read, search and send — with your rules for pace, limits, approval and
cost. Live at **https://zenith-whatsapp-hub.onrender.com** (dashboard, REST API, MCP for AI).

---

## 1. The numbers

| Number | Id in the hub | Type | Used for |
|---|---|---|---|
| Hotel +91 86601 27003 | `guests` (default) | Linked phone (WhatsApp app + hub) | Guests, staff |
| Seema +91 93533 15601 | `hiring` | Linked phone | Earlier chef batches (3, 4, 5) — follow-ups only. Logged out at present: re-link to resume |
| Hiring +91 99455 29003 | `2nd-hiring-number` | Linked phone | Batch 6 — follow-ups and replies only |
| Zenith Suites (Meta API) +91 98801 39926 | `zenith-api` | **Meta WhatsApp Cloud API** | **All new bulk candidate outreach** (from 21 Oct 2026) |

**Linked phone** = the hub is a "linked device" of a normal WhatsApp/WhatsApp Business app (like WhatsApp Web).
Free, keeps the phone working, full history — but WhatsApp blocks numbers that message too many new people, so the
hub holds them to **≤ 42 new numbers a day (hard max 45), 35 automated messages a day, random 45–120 s gaps**.

**Meta API number** = Meta's official business API. No phone app; no ban risk from volume; Meta's own limit
(250 new people/day now, more after verification and display-name approval). Rules Meta enforces:
- A person who hasn't written in the last 24 h can only get an **approved template** (first messages, follow-ups).
- Free text only within 24 h of their last message ("reply window").
- Each delivered template is **charged** (Marketing ≈ ₹0.86, Utility ≈ ₹0.12 — editable in Settings). Replies
  inside the window are free (first 1,000 per number per month).
- The hub sends it **as fast as the system allows** (no gaps), any time, up to 250 a day.

---

## 2. How a hiring day flows

```
WorkIndia batch (regular Claude / you)
   │ import_list(account="zenith-api", salary column per person)
   ▼
List "Chef candidates – Batch N (Meta)"          ← de-duplicated against every earlier batch (known_candidates)
   │ send_to_list(wa_template = chef_hiring_v3, schedule_at = 09:00)
   ▼
Drafts (with price) ──you approve──► Queue ──► Meta ──► candidate's phone
                                                         │ taps "Haan, interested" / "Nahi" / "Mujhe call karein"
                                                         ▼
Incoming message ─► Inbox  +  Board card "Reply to X"  (+ rule: instant "which day?" reply & call task)
   │ you / AI reply (approved replies to people who wrote in 24 h go out at once)
   ▼
Funnel stage: interested → date_given (visit date ⇒ Board card "Visit: X" + reminder message before the visit)
            → visited / trial → selected → joined     (or no_show / not_interested / rejected)
   │ silent people: one follow-up template after 2 days (on days without new outreach)
   ▼
Board shows everything that needs you; Activity shows everything that happened.
```

People already messaged from Seema / Hiring numbers stay on those numbers: their replies, follow-ups and visit
reminders always go from the number that has their chat.

---

## 3. Dashboard pages

| Page | What it's for |
|---|---|
| **Board** | Everything that needs you, all numbers together (or one). Cards the hub makes by itself: **💬 Reply needed** (a candidate wrote, nobody answered — "Open chat to reply"), **📅 Visit** (from the moment a date is set), **⏰ Reminder** (chat reminders), bulk sends with progress, follow-ups, your to-dos. Cards close themselves when done (reply sent, visit marked, chat reopened). New to-do and Bulk send forms at the bottom. |
| **Numbers** | Each number's status. Linked phones: Link (QR or phone-number code), history, deep history. Meta number: name, quality, Meta limit, **Health check** (everything Meta-side in one click), Re-check with Meta. |
| **Inbox** | All chats per number; reply, quote, files, templates, "Remind me", Done. On the Meta number: the 24 h window and a **Meta template…** button when the window is closed. |
| **Drafts** | Messages waiting for approval, queued, sent, failed. Price on each card (Meta number), totals when approving, Move to another number, Approve all / selected, status box per number (what waits, why, until when). |
| **Lists** | Candidate batches by role, status per person (not messaged / sent / replied / failed), stage and visit date, follow-up and pipeline settings (Meta templates on the Meta number), send to list (with cost). |
| **Templates** | Your saved texts, plus **Meta templates** (status, sync, submit new ones). |
| **Rules** | Automatic actions on incoming messages (e.g. "Haan, interested" → reply asking the day + call task). |
| **Settings** | Per number: approval mode, pace, limits, hours, follow-up timing, media. Alerts, **Meta message prices**, Playbook (rules for every AI). |
| **Activity** | Every event: sends, failures, approvals, changes, Meta alerts. |

---

## 4. Sending rules (who waits for what)

| Who sends | Linked phone numbers | Meta API number |
|---|---|---|
| You (dashboard, REST, Apps Script) | at once, ≥ 5 s apart | at once (free text only inside the 24 h window) |
| AI and bulk / list sends | drafts for approval (or automatic), random gap, daily cap, new-number limit, hours | drafts for approval, no gaps, up to 250 new people/day, any time; templates only for first contact |
| Replies to people who wrote in the last 24 h | at once after approval, not counted in the cap | same |
| Follow-ups | after 18:00/21:00, only on days without new outreach, max per day | same, using the follow-up Meta template |
| Template still in Meta review | — | scheduled sends wait and retry every 15 min until approved |

---

## 5. Meta (Cloud API) specifics

- **Templates:** `chef_hiring_v3` (image poster + text incl. free stay & food + buttons; `{{1}}` first name,
  `{{2}}` salary range), `job_followup`, `visit_date_request`, `visit_reminder`, `chef_job_invite`. Submit new ones
  from Templates → "Submit a new template", or ask the AI (`create_meta_template`).
- **Poster:** `https://zenith-whatsapp-hub.onrender.com/hiring/chef-hiring-stay-food.jpg` (uploaded to Meta once,
  reused).
- **Health check** (card button / `meta_health_check`): token, registration, can-send status and why (e.g.
  payment, display name), webhook, templates, failures, billable messages.
- **Timeline** (`message_timeline`): every Meta event for a person or message, with billing category and errors.
- **Costs:** price per draft, total before approving, Settings → Meta message prices.
- **Secrets** live only in Render (names in Notion → Secrets): META_TOKEN, META_APP_SECRET, META_VERIFY_TOKEN,
  META_PIN, META_PHONE_NUMBER_ID, META_WABA_ID.

---

## 6. Using it with AI (Claude)

Connect once: `https://zenith-whatsapp-hub.onrender.com/mcp/<API_KEY>` (Claude Code: `claude mcp add --transport
http --scope user whatsapp-hub <url>`; claude.ai: Settings → Connectors). Every AI gets the **Playbook** first.

Useful asks: "who replied today?", "draft replies to the chefs who wrote", "move X to date_given Sunday 11 am",
"run a health check on the Meta number", "what happened to the message to 98xxxxxxx?", "schedule batch 8 for 9 am".

AI tools: `list_accounts, list_chats, get_messages, search_messages, get_contact, update_contact, find_person,
send_message (text, files, buttons, wa_template), bulk_send, list_outbox, approve_draft, reject_draft, move_messages,
approve_task, list_tasks (kind=reply|visit|reminder), create_task, update_task, list_lists, list_members, import_list,
send_to_list (wa_template, schedule_at), set_followup, update_list_member, pipeline, set_pipeline, known_candidates,
list_templates, save_template, list_meta_templates, create_meta_template, meta_health_check, message_timeline,
list_rules, save_rule, set_chat_state, get_playbook, save_playbook, recent_activity, save_media,
fetch_older_messages, backfill_history, list_shared_contacts, find_followups`.

---

## 7. REST API (header `x-api-key`)

Numbers `GET/POST /api/accounts`, `PATCH/DELETE /api/accounts/:id`, `POST …/link|unlink` · Chats
`GET /api/accounts/:id/chats`, `…/chats/:jid/messages`, `…/chats/:jid/window`, `PATCH …/chats/:jid/state` ·
Send `POST /api/send` (text, attachment, replyTo, buttons, waTemplate) · Bulk `POST /api/bulk` · Lists
`GET /api/lists`, `POST /api/lists/import`, `GET/PATCH /api/lists/:id/members[/:phone]`, `PATCH …/followup|pipeline`,
`POST /api/lists/:id/send` (waTemplate, scheduledAt) · Drafts `GET /api/outbox`, `/outbox/count`, `/outbox/status`,
`POST /outbox/estimate|approve-all|approve-selected|reject-selected|move`, `/outbox/:id/approve|reject` · Board
`GET/POST /api/tasks` (`?kind=reply`), `PATCH /api/tasks/:id`, `POST /api/board/sync` · Meta
`GET /api/meta/status`, `GET/POST /api/accounts/:id/wa-templates`, `GET …/meta-health`, `GET …/meta-timeline?q=`,
`GET/PUT /api/pricing` · Others: templates, rules, playbook, alerts, people, search, events, media, `/webhook`
(old form-bot format), `/health`.

---

## 8. Where things run and why it's sometimes slow

- **Render** (free plan, Singapore) runs the hub; **Supabase** (Singapore) holds the data. Each dashboard request
  takes ~0.1 s just to travel India ↔ Singapore.
- Pages now load their data in parallel, account numbers are cached for 15 s and message counts for 60 s, so a page
  needs ~0.2–0.4 s. Remaining slowness comes from the free Render instance: a small shared CPU that also runs three
  WhatsApp connections; during a history import or a big send it can lag for a few seconds. **Render "Starter"
  (~$7/month) gives a dedicated CPU and removes most of it.** A "Running on another server" status for ~1 minute
  after each update is normal (hand-over between old and new server).

---

## 9. Safety nets

- Nothing waits unseen: unanswered candidate replies, visits and reminders are Board cards; a re-check every 10
  minutes catches anything missed.
- A sent message is never sent twice (idempotency keys, atomic queue claims, one server per number).
- Failures are shown with a plain reason (WhatsApp/Meta error codes translated); Meta's actual delivery events are
  kept 14 days.
- Alerts by WhatsApp when a number is logged out or offline 15+ minutes.
- Tests: `npm test` (78 end-to-end tests, including a fake Meta server).

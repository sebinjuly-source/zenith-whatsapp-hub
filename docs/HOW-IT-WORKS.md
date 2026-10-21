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
Funnel stage: interested → date_given (visit date ⇒ priority Board card "Interview: X" for you + reminder message before)
             "free after 10 Nov" ⇒ available_from ⇒ Board card "Follow up: X" for the AI, due the day before at 10:00
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
| **Board** | The shared calendar of you and the AI, all numbers together (or one). **📅 Coming up** at the top lists every dated card by day (Overdue / Today / Tomorrow / …). Every card says who does it — **👤 You** or **🤖 AI** — and must-dos carry **⭐ Priority** (flag/unflag on the card; filter Everyone / Mine / AI). Cards the hub makes by itself: **💬 Reply needed** (AI), **🔁 Follow-up** (AI; the day before the date a candidate gave), **🎯 Interview** (you, priority), **🕒 Scheduled** (a message going out later), **⏰ Reminder** (you), "Did X come?" and call tasks (you, priority), bulk sends with progress. Cards close themselves when done (reply sent, follow-up sent, interview marked, message sent, chat reopened). New to-do (who + priority) and Bulk send forms at the bottom. |
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
send_message (text, files, buttons, wa_template, schedule_at), bulk_send, list_outbox, approve_draft, reject_draft, move_messages,
approve_task, list_tasks (kind=reply|followup|visit|scheduled|reminder, for=you|ai, due_now), create_task / update_task (for, priority), add_task_note, task_history, list_lists, list_members, import_list,
send_to_list (wa_template, schedule_at), set_followup, update_list_member (visit_at, available_from, follow_up_at), pipeline, set_pipeline, known_candidates,
list_templates, save_template, list_meta_templates, create_meta_template, meta_health_check, message_timeline,
list_rules, save_rule, set_chat_state, get_playbook, save_playbook, recent_activity, save_media,
fetch_older_messages, backfill_history, list_shared_contacts, find_followups`.

**Calls in chats.** Linked numbers record WhatsApp calls as lines like `📞 Voice call — answered, 2:14` or
`📞 Missed voice call`. Only calls WhatsApp shows to linked devices are captured; calls before 22 Oct 2026 and
calls on the Meta number are not. If a call was answered (longer than 0:00) after our last message, the AI must not
draft. It adds a "Call notes needed" task and asks the owner what was said.

**Location** always means the Google Maps link https://maps.app.goo.gl/22BZBzF5W46LWoKe8, not only the address.

**Images.** Draft cards show the picture that will go out: a file you attach, or the poster in an image template's
header. Image templates keep their picture in the inbox after sending.

**Follow-ups at the right time.** When a candidate says when they will be free ("after 10 Nov", "next week"), the AI
calls `update_list_member(available_from=…, follow_up_note=…)`. The hub sets the follow-up for the day before at
10:00 and puts "Follow up: X" on the Board for the AI. When it comes due the AI drafts a message asking for the exact
interview day and time; once a message goes out from 12 h before the due time, the card closes by itself. A visit
date replaces a pending follow-up. You can also set a follow-up date per person on the Lists page.

**Card history & notes.** Every card keeps a history: created, moved, re-dated, flagged, and closed by the hub with
the reason ("Done by the hub — a reply went out", "Cancelled by the hub — interview date set instead"). Open
**History & notes** on a card to read it or add a note. Call notes go here: write what was discussed on the "Call
notes needed" card and the AI drafts the reply from it. AI: `add_task_note`, `task_history`; REST:
`GET /api/tasks/:id/log`, `POST /api/tasks/:id/notes`.

**Safety net.** An "interested" candidate with no interview date, no follow-up date, no open card and no message
either way for 3 days gets a "Follow up" card due now (history: "Added by the safety net"), at most 20 per check.

**Messages for later.** `send_message(schedule_at="YYYY-MM-DD HH:MM")`, `POST /api/send` with `scheduleAt`, or ⏰ in
the inbox composer. Each shows on the Board as "Scheduled: …" until it is sent (drafts still need your approval).

**Scheduled AI run.** The routine "Zenith hub – replies & follow-ups" runs in the cloud (environment "Whatsapp") at
10:00, 14:00, 18:00 and 22:00 IST on Haiku, with only the hub tools. Each run answers the reply cards, records
interview dates and follow-up dates, drafts the follow-ups that are due, and asks you for call notes. It never sends;
everything waits for your approval. Manage it at https://claude.ai/code/routines.

---

## 7. REST API (header `x-api-key`)

Numbers `GET/POST /api/accounts`, `PATCH/DELETE /api/accounts/:id`, `POST …/link|unlink` · Chats
`GET /api/accounts/:id/chats`, `…/chats/:jid/messages`, `…/chats/:jid/window`, `PATCH …/chats/:jid/state` ·
Send `POST /api/send` (text, attachment, replyTo, buttons, waTemplate, scheduleAt) · Bulk `POST /api/bulk` · Lists
`GET /api/lists`, `POST /api/lists/import`, `GET/PATCH /api/lists/:id/members[/:phone]` (stage, visitAt, outcome, notes, followupAt, availableFrom, followupNote), `PATCH …/followup|pipeline`,
`POST /api/lists/:id/send` (waTemplate, scheduledAt) · Drafts `GET /api/outbox`, `/outbox/count`, `/outbox/status`,
`POST /outbox/estimate|approve-all|approve-selected|reject-selected|move`, `/outbox/:id/approve|reject` · Board
`GET /api/tasks/:id/log`, `POST /api/tasks/:id/notes` · `GET/POST /api/tasks` (`?kind=reply|followup|visit|scheduled|reminder|bulk|todo`, `?for=you|ai`, `?due_now=1`; POST/PATCH take `assignee` and `priority`), `PATCH /api/tasks/:id`, `POST /api/board/sync` · Meta
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

- Nothing waits unseen: unanswered replies, follow-ups, interviews, scheduled messages and reminders are Board
  cards; a re-check every 10 minutes catches anything missed, and interested candidates with nothing planned for 3
  days get a follow-up card. `/health` shows when that check last ran (`board.at`, `ok`, `error`, `late`) and
  whether the database answers (`dbOk`).
- Every card's history says who changed it and why — the first place to look when a card "disappeared".
- A sent message is never sent twice (idempotency keys, atomic queue claims, one server per number).
- Failures are shown with a plain reason (WhatsApp/Meta error codes translated); Meta's actual delivery events are
  kept 14 days.
- Alerts by WhatsApp when a number is logged out or offline 15+ minutes.
- Tests: `npm test` (81 end-to-end tests, including a fake Meta server).

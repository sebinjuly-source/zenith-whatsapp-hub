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
hub holds them to **≤ 42 new numbers a day (hard max 45), 35 automated messages a day to people who haven't written in
the last 30 days, 30 a day to people who wrote in the last 30 days, at most 10 automated messages an hour, random
45–120 s gaps**. (26 Oct: the hotel number was logged out after 76 messages in under 2 hours to mostly stale contacts
that then counted as "warm" — warm now means a conversation in the last 30 days.)

**Send order and "send by" times (25 Oct).** Each number sends, whatever the campaign, in this order: replies to people
who wrote in the last 24 h → your own sends → messages with a **⌛ send by** time (soonest first: festival wishes,
interview reminders) → people who have written to us before → first messages to new people → nudges to people who
never replied. Same rank: the one due (or approved) first. A message still unsent at its "send by" time is dropped,
never sent late. When the daily limit can't fit them in time, Drafts & outbox shows **⚠️ Not enough sending capacity**
with three choices — 📱 send them from another number, ✖ skip them, ⬆ raise the limit (to the smallest value that fits;
linked phones never above 45) — and the AI sees it in hub_overview. Each card also shows **≈ goes out about …**.

**Meta API number** = Meta's official business API. No phone app; no ban risk from volume; Meta's own limit
(250 new people/day now, more after verification and display-name approval). Meta's limit counts every person who
gets a template outside the 24 h reply window — people who replied days ago included — so on the Meta number the
hub's daily limit counts them all (by unique person). Rules Meta enforces:
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

**Campaigns — like separate users.** A campaign (Chef hiring, Reception = "Front office", Housekeeping, Corporate sales, Win-back, a Diwali offer…) is created from the picker at the top right (**➕ New campaign…**, with its own rules for the AI = its playbook) or by a list with that job role. The campaign you pick is saved on the server and decides what you **and the AI** see and may change: Board, Inbox, Drafts (and the badge), Lists, Contacts, Templates, Rules and Activity show only that campaign, and every action on anything of another campaign is refused (dashboard API and every MCP tool). **🌐 All campaigns** shows everything; **🏨 Hotel / no campaign** = people on no list. Numbers are shared by all campaigns. A person belongs to a campaign when they are on one of its lists. Templates, contacts and rules created inside a campaign belong to it; items with no campaign are *shared* — visible everywhere, changed only with All campaigns picked. For the AI the campaign is a **filter for the whole hub, not a wall**: every MCP tool takes `campaign="<name>"` (or `"all"`, `"none"`); without it the tool uses the campaign open in the dashboard, so the AI's context stays small and it never changes another campaign's items by accident (the error says how to do it on purpose). `list_campaigns`, `create_campaign` and `switch_campaign` (when the owner asks — the dashboard follows). Every campaign works under the main playbook plus its own; a campaign can also **follow** shared playbooks (ticked in the ➕ New campaign pop-up or in Settings → Playbook → "also follows" — e.g. "Hiring – all roles" for every hiring campaign; stored as `INCLUDE:` lines). **Not campaign things:** numbers and their settings (limits, delays, hours, approval mode, name, purpose, on/off) belong to the NUMBER, and playbooks are the hub's rules — Settings shows the main playbook and every campaign playbook whichever campaign is open, and saving without picking a campaign always saves the main one. Background routines pass `campaign="all"` (a URL can also pin one: `/mcp/<key>/<campaign>` or `/mcp/<key>/all`). Scripts using the API key are not tied to the picker.

The top bar has the three pages used all day: **🗂️ Board**, **💬 Inbox** and **✉️ Drafts** (with a count). Everything else
opens from **☰** at the top left in a side pane (✕ or a tap outside closes it), with icons: 📋 Lists, 📱 Numbers, 📝 Templates, ⚡ Rules, ⚙️ Settings, 🔌 Connect AI &
apps, 🕘 Activity, ↩️ Log out. Hover over an icon to see its name. The number you pick in the Inbox, the Board filters
and the open tabs are remembered on that device after a refresh. Less-used parts of each page are folded (▸).

| Page | What it's for |
|---|---|
| **Board** | The shared calendar of you and the AI. **🔥 Do now**: what is overdue, due today, or waiting on someone (must-dos first, in red; candidates waiting for a reply folded into one group the AI works through). **📅 Future**: everything later, one fold per day (the next two open). **⏳ Sending now** and **✅ Done** are folded. Filters: number, 👤 Mine / 🤖 AI, job role. Each card shows its title, who does it, when, and one action (Reply / Open chat / Approve / Messages) plus ✓ done; **More** holds the details, ⭐ priority, move, and **history & notes** (call notes go here). Cards the hub makes by itself: 💬 Reply needed, 🔁 Follow-up, 🎯 Interview, 🕒 Scheduled message, ⏰ Reminder, "Did X come?" / call tasks. New to-do and Bulk send are folded at the bottom. **Phone numbers** on a card (title, details, notes) are tap-to-call links, and cards for a person have a **📞 Call** button. After tapping it, **After the call:** ✅ Interested / 🗓 Interview date… / 📵 No answer / ⏰ Call back… / ❌ Not interested — one tap writes the note, sets the stage or interview date, closes the card and hands the next step to the AI (or a "Call again" card for you); called from another phone? More → 📞 Log a call result; card text can be selected and copied. **Several cards at once:** press **☑ Select** next to Do now (or long-press a card's empty space; pressing on text selects text), tap more cards or **☑ Select all** (Do now, or one Future day), then **📝 Note for the AI**; **Done** leaves selection — e.g. "didn't pick up my calls, follow up on WhatsApp". The note goes on each card, the AI gets a card "Owner: …" listing those people (due now), and the selected cards can be closed. |
| **Inbox** | Chats per number (each tagged 🎯 with its campaign). Photos show in the chat; **⬇ Download** saves any file to the phone or PC. **👤＋** saves a new contact (number + name, and on linked phones also in the phone's contacts) and opens a chat with them; **💾 Save** on a shared contact card does the same; the Contact panel has a **Name** field (a saved name is kept even when WhatsApp reports another). On a phone the chat fills the screen: ← back, the name, ✓ Done, and ⋯ for Contact, Remind me, Reopen and older messages. The typing box is always visible: 📎 file, ⏰ send later, 📝 saved template, ➤ send. On the Meta number: the 24 h window and a **Meta template…** button when the window is closed. |
| **Drafts** | **Long-press a card** (or ☑ Select) to start selecting, tap more cards, and act from the bar pinned to the bottom: ✅ Approve, ✖ Reject, 📝 Note for AI, 🕒 Reschedule, 📱 Send from (moves them at once), Done — tapping empty space ends selection. The number on a single card also changes as soon as you pick another. Every unsent card also has **🕒 Reschedule** (new day and time, quick picks, or as soon as possible; drafts stay drafts, the Board card follows). Your edits are **saved as you type** (✓ Saved) — approving another draft never loses them. Approve / Reject change only that card, so the list and your scroll place stay. Each card says when it goes out: **🕒 Goes out Fri 1 Jan 2027, 09:45** for a dated message (approving keeps that date — it never goes early) or **⚡ soon after you approve**. Tick drafts → **📝 Note for AI** gives the AI a card listing them; it changes them with edit_draft and they come back here for approval. On the Meta number a free-text draft shows **⏳ Free until …** (24 h after their last message) or **⛔ window closed** (only a paid template can go then). **Reject** asks why (optional). The reason is written on that person's Board card, so the AI follows it, and without a reason it won't draft the same again. Messages waiting for approval, queued, sent, failed (with **What to do** for Meta errors). Price on each card (Meta number), **Approve these N** (exactly the drafts shown), status box per number (what waits, why, until when). |
| **📇 Contacts** | The hub's contact book, kept by **why** a person matters, in separate groups — "Chef hiring – Referrers", "Chef hiring – Referred", "Catering", "Placement agents", "Vendors & services", "Travel agents", "Corporate clients", "Guests". Each entry has the reason, notes, and who referred whom. Search by need ("chef", "caterer", "travel agent"). A contact card shared in a chat is filed automatically (referred person + referrer, under the sender's job role) with a priority Call card for you. Save from a chat (Contact → 📇 Save to Contacts), a shared card (💾 Save) or 👤＋ Add. The AI searches here first (find_contacts) whenever a need comes up and saves helpful people (save_contact). |
| **Lists** | Candidate batches by role, status per person, stage, interview and follow-up dates. 🗑 removes a person who was never messaged (e.g. typed by mistake); **🗄 Archive** stops a list from ever sending (for lists imported only to check duplicates). Automation (pipeline and follow-ups) is folded. |
| **Templates** | Your saved texts (pick "All numbers" so they appear in every chat's 📝 list; starter set: Location, Ask interview day, Confirm interview, Didn't pick up my call, Reminder before visit, Not a fit, Polite close), plus **Meta templates** (status, sync, submit new ones). |
| **Rules** | Automatic actions on incoming messages, optionally only for one **job role** (the sender is on a list of that role): "Haan, interested" from a chef → cooking-test reply; from reception/housekeeping candidates → interview-day reply. (e.g. "Haan, interested" → reply asking the day + call task). |
| **Settings** | **⭐ All numbers (defaults)**: every number follows these, except a setting a number has changed itself (shown as "own" on that number). Per number: name, purpose, active, and "↺ Use all-numbers settings". Sending (approval, new-number limit, daily limit, any time; delay, hours, days and follow-ups folded), history & media, replies & integrations. Folded: connection alerts, Meta prices, Playbook, delete number. |
| **Numbers / Connect / Activity** | Link numbers and the Meta health check; how to connect AI and Apps Script; every event that happened. |


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

**Start with `hub_overview`.** It also lists **owner notes to act on**: cards where you wrote a note the AI has not handled yet (`list_tasks(owner_notes=true)`). It shows what is due now, each number's sending state and why it is held, lists on every number,
and failures with what to do. The playbook begins with "How to use the hub" (tool order and the rules that prevent mistakes:
never type candidate data by hand, never conclude something is missing after filtering by one number).

Useful asks: "who replied today?", "draft replies to the chefs who wrote", "move X to date_given Sunday 11 am",
"run a health check on the Meta number", "what happened to the message to 98xxxxxxx?", "schedule batch 8 for 9 am".

AI tools: `list_accounts, list_chats, get_messages, search_messages, get_contact, update_contact, find_person,
send_message (text, files, buttons, wa_template, schedule_at), bulk_send, list_outbox, approve_draft, reject_draft, edit_draft (new wording, keeps picture and date), reschedule_messages (ids, at), move_messages,
approve_task, list_tasks (kind=reply|followup|visit|scheduled|reminder, for=you|ai, due_now), create_task / update_task (for, priority), add_task_note, task_history, list_lists, list_members, import_list,
send_to_list (wa_template, schedule_at, attachment_url — one image for everyone, each person's message as its caption), set_followup, update_list_member (visit_at, available_from, follow_up_at), pipeline, set_pipeline, known_candidates,
list_templates, save_template, list_meta_templates, create_meta_template, meta_health_check, message_timeline,
hub_overview, owner_feedback, describe_data, inspect_data, edit_messages, find_contacts, save_contact, archive_list, remove_list_member, list_rules, save_rule, set_chat_state, get_playbook, save_playbook, recent_activity, save_media,
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
`GET/POST /api/directory` (`?q=&category=`), `/api/directory/groups`, `PATCH/DELETE /api/directory/:id` · `GET/PUT /api/settings/defaults`, `POST /api/accounts/:id/settings/reset` · `GET /api/tasks/:id/log`, `POST /api/tasks/:id/notes`.

**Safety net.** An "interested" candidate with no interview date, no follow-up date, no open card and no message
either way for 3 days gets a "Follow up" card due now (history: "Added by the safety net"), at most 20 per check.

**Send without approval to (trusted recipients).** Settings → "✅ Send without approval to": AI, routine and
campaign messages TO these phones skip Drafts on every number (e.g. the owner's own phone, so a routine can send a
report). Until saved it is the alert phones; only the owner changes it (`PUT /api/trusted-recipients`), never the AI.

**Next step missing.** Anyone on a list who replied in the last 30 days, whose chat has been quiet 2 hours, with no
stage beyond "interested", no interview date, no follow-up date, no open card and no draft waiting, gets an AI card
"Next step missing: X — read the chat and record it" (at most 10 per check). It catches the owner answering by hand
("No problem, come on the 10th"): that reply closes the "Reply to" card, but nothing recorded the date — on 27 Oct a
chef coming on 10 Nov had no card. The hub closes the card when a date, follow-up or other stage is set; if it is
closed without one it comes back only after a new message (`catchNoNextStep` in `board.js`).

**Messages for later.** `send_message(schedule_at="YYYY-MM-DD HH:MM")`, `POST /api/send` with `scheduleAt`, or ⏰ in
the inbox composer. Each shows on the Board as "Scheduled: …" until it is sent (drafts still need your approval).

**Scheduled AI run.** The routine "Zenith hub – replies & follow-ups" runs in the cloud (environment "Whatsapp") at
10:00, 14:00, 18:00 and 22:00 IST on Haiku, with only the hub tools. Each run answers the reply cards, records
interview dates and follow-up dates, drafts the follow-ups that are due, and asks you for call notes. It never sends;
everything waits for your approval. Manage it at https://claude.ai/code/routines.

---

## 7. REST API (header `x-api-key`)

`GET /api/help` lists every endpoint (with auth and date rules) — the quickest reference when writing a script.

Numbers `GET/POST /api/accounts`, `PATCH/DELETE /api/accounts/:id`, `POST …/link|unlink` · Chats
`GET /api/accounts/:id/chats`, `…/chats/:jid/messages`, `…/chats/:jid/window`, `PATCH …/chats/:jid/state` ·
Send `POST /api/send` (text, attachment, replyTo, buttons, waTemplate, scheduleAt) · Bulk `POST /api/bulk` · Lists
`GET /api/lists` (`?archived=1`), `POST /api/lists/import`, `POST /api/lists/:id/archive`, `DELETE /api/lists/:id/members/:phone`, `GET/PATCH /api/lists/:id/members[/:phone]` (stage, visitAt, outcome, notes, followupAt, availableFrom, followupNote), `PATCH …/followup|pipeline`,
`POST /api/lists/:id/send` (waTemplate, scheduledAt) · Drafts `GET /api/outbox`, `PATCH /api/outbox/:id` {text}, `POST /api/outbox/note-for-ai` {ids, text}, `/outbox/count`, `/outbox/status`,
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
- Approvals are never broader than what you see: "Approve these N" sends the ids of the drafts on screen; the server
  refuses an approval that names no drafts, number, task or campaign (on 24 Oct an unfiltered "approve all" approved every
  number and campaign — the incident that led to this rule).
- A campaign never leaks into another: the dashboard refuses actions outside the open campaign; the AI must name another
  campaign on purpose (`campaign="…"` / `"all"`).
- Tests: `npm test` (112 end-to-end tests, one of which calls every one of the 66 AI tools, including a fake Meta server;
  one checks that the dashboard script parses — a syntax error there blanks the whole dashboard).

---

## 10. Internals & debugging (step by step, for whoever fixes it next)

### 10.1 Start-up (`src/index.js`)
1. `initDb()` (`db.js`) runs the whole SCHEMA (every `CREATE … IF NOT EXISTS` / `ALTER … ADD COLUMN IF NOT EXISTS`
   and one-off back-fills) — safe to run on every start.
2. `buildApp()` (`api.js`) mounts `/health`, `/login`, `/meta/webhook`, `/mcp/<key>`, the dashboard files and `/api/*`.
3. `manager.init()` (`wa/manager.js`) loads every row of `accounts` and starts a session per number:
   linked numbers = `wa/session.js` (Baileys), Meta numbers = `wa/cloud.js`. Every 30 s it re-reads the table.
4. `startOutbox()` (`outbox.js`) sweeps sends stuck in "sending" and starts one sender loop per number.
5. After 1 min and then every 10 min: `runPipeline` → `runFollowups` (`lists.js`) → `syncBoard` (`board.js`).
   A run never overlaps the previous one; the result of `syncBoard` is `/health → board`.

### 10.1b Country and time zone
`TZ_NAME` (default Asia/Kolkata) decides sending hours, follow-up times and how any typed date without a zone is
read (`util.localDate` — the server itself runs in UTC). `COUNTRY_CODE` + `LOCAL_NUMBER_LENGTH` (default 91 + 10)
decide what a bare local number becomes (`store.toJid`). Meta senders who use a WhatsApp username and hide
their number arrive as `<user id>@bsuid` chats.

### 10.2 One server per linked number (leases)
A linked number may only be connected from one server. `session.js` claims `accounts.lease_owner` for 90 s and
renews it; a second server (e.g. the new one during a Render deploy) shows **elsewhere** until the old lease runs
out. So: "Running on another server" for about a minute after a deploy is normal. Only the lease holder sends,
runs follow-ups and pipeline steps for that number (`session.status === 'open'`). Meta numbers need no lease.

### 10.3 A message comes in
- Linked: Baileys `messages.upsert` → `wa/parse.js` turns it into a row → `store.insertMessages` (also updates the
  chat preview) → `session.afterIncoming`.
- Meta: Meta POSTs `/meta/webhook` → `meta.js dispatch` (checks the signature, finds the number by
  phone_number_id) → `cloud.js onWebhook` (skips ids already stored) → `insertMessages` → `afterIncoming`.
- `afterIncoming` in order: reopen a snoozed/done chat → `board.noteIncoming` ("Reply to X" card if they are on a
  list and not closed) → close their chat reminder → `noteSharedContacts` (contact cards → Contacts + "Call Y" card)
  → opt-out words → auto-save media → `rules.runRules` (tags, task, auto-reply template once a day) → webhook URL.

### 10.4 A message goes out (`outbox.js`)
1. Everything is a row in `outbox`. `enqueue` (one message) / `bulkSend` / `lists.sendToList` insert rows.
   `source`: dashboard/api = yours (sent at once, priority 10); mcp/campaign = AI and bulk (drafts in approve
   mode); rule = auto-replies (pre-approved). Each row stores its campaign in `outbox.role`.
2. Drafts wait for **approve** (`approve`, `approveAll`, `approveTask`). Approving a free-text draft on a Meta
   number after the 24 h window closed is refused with the reason.
3. The sender loop (`startWorker → tick`) claims ONE row atomically (`FOR UPDATE SKIP LOCKED`) in `SEND_ORDER`:
   rank (`SEND_RANK`: 1 reply in 24 h · 2 yours (priority ≥ 10) · 3 has `expires_at` · 4 warm (`IS_WARM`: they
   have ever written to this number) or pipeline (priority 5) · 5 cold · 6 `note = 'follow-up'` nudge), then
   `expires_at`, `scheduled_at`, id. Limits (`sent24h`, rolling 24 h): **cold** automated rows → `dailyCap`;
   **warm** rows on linked phones → `warmDailyCap` (150; the claim stores `is_warm`); Meta numbers count every
   non-reply row against `dailyCap`, by distinct person (Meta's own rule). It also holds rows outside sending hours,
   during the random gap, follow-ups on days with new outreach, new numbers over the new-number limit, and never
   claims a row past `expires_at`. `queueStatus` explains the current hold in words (hub_overview "sending: held — …").
   - **Send by**: `expires_at` (enqueue/bulkSend/sendToList `expiresAt`, MCP `expires_at`, REST `expiresAt`,
     reschedule can set/clear it). Visit reminders get the interview time automatically. `expireDue` (each worker,
     once a minute, even when the number is offline) turns overdue drafts/queued rows into `rejected` "Expired: …"
     and logs a warning. Approving an expired draft is refused; rescheduling past a deadline is refused.
   - **Capacity forecast** (`capacityForecast`, `GET /api/outbox/capacity`): replays the unsent automated rows in
     send order (drafts as if approved now) through the rolling windows (cold, warm, new numbers), sending hours,
     WhatsApp's new-chat block and the average gap → an ETA per row, `atRisk` (ETA ≥ `expires_at`), and `raiseTo`
     (smallest `dailyCap` that fits them; linked ≤ 45, Meta ≤ its tier). Every 10 min the worker logs a warning if
     anything is at risk; hub_overview prints "⚠ NOT ENOUGH CAPACITY …".
4. `session.send` sends; the row becomes `sent` (with `message_id`) or `failed` (with the reason).
   Meta: a delivery failure arrives later by webhook (`cloud.js onCloudStatus`) and turns `sent` into `failed`;
   codes marked retry in `graph.js META_HELP` (e.g. 131049) are queued again after 25 h (max 2), and dropped if the
   person wrote meanwhile. A template still in review keeps the row queued (checked every 15 min).
5. A row stuck in `sending` > 4 min (restart mid-send) is marked sent if the message is in the chat, else failed
   ("check the chat before resending") — never sent twice.

### 10.5 Lists, funnel and follow-ups (`lists.js`)
- A list member's **status** (new/queued/sent/replied/failed/opted_out) is always recomputed from real messages and
  the outbox (`refreshList`, one SQL statement; one run at a time per list). The **stage** (interested →
  date_given → visited/trial → selected → joined; no_show, not_interested, rejected) is set by you or the AI.
- `updateMember`: `visit_at` → stage date_given + Interview card; `available_from` → follow-up the day before at
  10:00 + Follow-up card; closed stage → closes their Reply cards and cancels automatic messages still waiting.
- `runPipeline`: interested with no date for N hours → "ask-date" message; visit within 18 h → reminder; visit
  3 h past and still date_given → "Did X come?" card.
- `runFollowups`: members sent-but-silent for `afterDays` get a follow-up (Meta: the list's follow-up template),
  only after `followupStart`, max `followupDailyMax` a day, and not on days the number reaches out to new people
  (`newOutreachToday` — replies to existing chats don't count).

### 10.6 The Board (`board.js`, `tasks.js`)
- Cards with a `ref` are kept in step by the hub: `reply:<acc>:<jid>`, `followup:<list>:<jid>`,
  `visit:<list>:<jid>`, `remind:<acc>:<jid>`, `sched:<outboxId>`. `upsertRefTask` updates the open one;
  `closeRefTasks` closes it with a reason (visible in History).
- Events update cards at once (incoming message, reply sent, stage/date changed, scheduled send). `syncBoard`
  re-derives all of them every 10 min, tags cards with their campaign, and runs the safety nets (`catchForgotten`, `catchNoNextStep`).
- `task_log` = each card's history and notes. "Owner note to act on" = the latest note/AI entry is the owner's.

### 10.7 Campaigns (`campaign.js`, `scope.js`)
- A campaign = a list's job role, or one created with **➕ New campaign** (table `campaigns`). `roleOf(acc, jid)` = role of
  the latest list the person is on (this number's lists first); `roleFilter` turns a campaign ("none" = on no list) into
  SQL. Stored on `outbox.role`, `tasks.role`, `events.role`, `templates.role`, `directory.role`; rules use
  `conditions.role`. NULL on a template/contact/rule = shared by all campaigns.
- The open campaign is **server-side**: config key `focus` (`scope.getFocus/setFocus`), set by the dashboard picker,
  by `switch_campaign`, or by `PUT /api/focus`. The dashboard re-reads it on every page (another device or the AI may
  have switched it) and the badge counts follow it.
- Dashboard (cookie requests): `req.focus` is applied to every read (`roleQ`) and every action is checked
  (`scope.assertDrafts / assertTask / assertList / assertPerson`, template/rule/contact owners). Scripts using the API key
  are not tied to the picker.
- AI (MCP): `callCampaign(tool, args, focus)` gives each call its campaign — the tool's own job role (import_list,
  known_candidates, list_tasks), else `campaign` ("all" = none), else the open one — and `enforceScope` checks targets
  against it. Handlers read it as `a._c`. So the campaign is a default filter: it keeps the AI's context small and
  stops accidental changes elsewhere, but the AI can work anywhere by naming the campaign. A URL can pin one:
  `/mcp/<key>/<campaign>` or `/mcp/<key>/all` (a claude.ai routine cannot change its connector's URL — its prompt says
  campaign="all" instead).
- A person is "in" a campaign when on one of its lists (`scope.personIn`, SQL `personInSql`); groups count as "none".

### 10.8 AI access (`mcp.js`) and REST (`api.js`)
- MCP: `POST /mcp/<API_KEY>`, stateless — every call builds a fresh server with the playbook (from `config` key
  `playbook`) as its instructions. Every tool returns short text; errors come back as `Error: …` text.
  Dates the AI gives without a timezone are India time (`localTime`). Every tool also takes `campaign` (see 10.7);
  the instructions carry the main playbook plus the open campaign's playbook (INCLUDEs expanded).
- REST: `/api/*` with `x-api-key` or the dashboard cookie; the dashboard (`public/app.js`) uses only these.
- Public sales images: `public/sales/*.jpg` are served without a key at `<server>/sales/<file>` (Premium Room poster, festival greetings) so messages can attach them by URL. They are built from the Deluxe poster layout (dark + gold, crown logo, photo, round inset, icon row, address bar).
  `/webhook` is the old dental-bot format for Apps Script.

### 10.9 Data model (main tables)
`accounts` (numbers, settings, lease) · `wa_auth` (linked-number keys) · `chats`, `contacts`, `messages`, `lid_map`
· `outbox` (every send) · `tasks` + `task_log` (Board) · `lists` + `list_members` (batches, status, stage, dates)
· `templates`, `rules`, `directory` (Contacts book) · `campaigns` · `config` (playbook, playbook:<campaign>, focus, defaults, alerts, prices, digest) · `events`
(activity log, pruned after 30/365 days) · `meta_events` (Meta webhooks, 14 days) · `wa_templates` · `jobs`.

### 10.9b Morning summary, call results, data growth
- `src/digest.js`: every minute the server holding the sending number checks the time; once after `time` (within 6 h)
  it claims today in `config.digest.lastDate` (atomic — never twice) and sends the summary to the alert phone(s).
  Settings → ☀️ Morning summary (time, number, "Send a test now").
- `src/calls.js`: `recordCallResult(card, result)` — the person comes from the card ref or a phone number in it.
- Every MCP answer is capped (~16,000 characters, cut at a line, says what was left out). Growth plan:
  `docs/DATA-GROWTH.md`.

### 10.9c AI context and data (24 Oct)
- `find_people` (`store.searchPeople`): one line per person across ALL history whose messages or saved name
  mention any word — for campaigns (old guests, corporate / company HRs, travel agents). Skips groups, job candidates,
  the hub's own numbers and the alert phones; 50–60 per page with offset. (Message search lists messages newest
  first and stops at 100: on the hotel number it showed 51 of 123 lead-like people.)
- `person_context`: everything about one person (chats on every number, list stage/dates, cards with notes, waiting
  drafts, contact book); messages newer than an open card are marked NEW. `list_tasks` shows each card's chat now.
- `get_settings` / `update_settings`: the AI may change hours, follow-up timing, auto-save, opt-out words, notify
  URL, purpose, morning summary, alert phones; approval mode, limits, gaps and prices stay owner-only.
- Interview reminders (`runPipeline`): the evening before at 18:00 and 3 h before; none if the date was agreed
  under 2 h earlier; the ask-for-a-date message never goes when anything to that person is already waiting.
- Media: an expired WhatsApp link asks the phone to upload the file again, keeps a copy; if the phone no longer has it,
  the link shows a readable "File not available" page.

### 10.9d Campaign playbooks (24 Oct)
- The main playbook (config `playbook`) is sent to every AI as the MCP instructions, followed by the NAMES of the campaign
  playbooks (config `playbook:<campaign>`). `get_playbook(campaign)` / `hub_overview(campaign)` return one campaign's rules;
  a line `INCLUDE: <campaign>` pulls in shared rules (Chef, Front office and Housekeeping include "Hiring – all roles").
  Settings → Playbook has a picker (main / each campaign / new). Campaigns now: Hiring – all roles, Chef, Front office,
  Housekeeping, Corporate sales, Win-back.
- Lists whose role is not a hiring role (Corporate sales, Win-back, …) start with the candidate pipeline OFF, so no
  Hinglish interview texts reach a corporate contact.

### 10.9f Settings, numbers and what the AI can do (25 Oct)
- **Settings save as you change them** (no Save button): each change PATCHes the number (or PUTs the all-numbers
  defaults) and the line under the form says "✓ Saved hh:mm:ss" or "⚠️ Not saved: <why>". Switching a number to
  "Send automatically" or pausing it asks first. Bug fixed: after a save the page re-read a 15-second cached copy of
  the numbers, so the old values came back; Settings now always loads fresh (`loadAccounts(true)`). The live log
  showed none of the owner's earlier edits had reached the server — the Save button sat at the very bottom.
- Settings and Numbers show "Shared by all campaigns" instead of the campaign menu (numbers and the hub's rules are not campaign things); every other page has the menu.
- **Playbook history**: table `playbook_versions` keeps every save (one version per editing sitting of 10 min per person; the text before the first recorded edit is kept as "before history began"). Settings → Playbook → 🕘 History: view / restore any version (a restore is itself a version). Activity logs one "Edited the … playbook" per sitting and every restore. Ctrl+Z works in the editor (the "also follows" ticks and restores go through the browser's undo too). `GET /api/playbook/history?campaign=`, `POST /api/playbook/restore {id}`.
- **The AI sees only the playbooks that apply**: MCP instructions and `get_playbook` inside a campaign = main + that campaign's (+ what it follows); with campaign="all" = main + the names of the others. Settings (the owner) shows them all.
- **Rejection reasons reach the Board**: a reject with a reason for someone with no open reply/follow-up card creates an AI card "Owner: rejected the draft for X — <reason>" listing the drafts (bulk rejects: one card). Before, win-back/corporate reasons ("just wish him on festivals") were stored only on the rejected message and the routine, which works the Board, never saw them. The routine prompt now covers guests/win-back/corporate too and starts with owner_feedback.
- **Funnel stages per campaign** (`stages.js`, `campaigns.stages`): presets hiring / sales (corporate) / win-back or the campaign's own (one per line, "(closed)" ends messages); set in ➕ New campaign, Lists → ✏️ Stages, `create_campaign(stages)` / `set_campaign_stages`; `list_campaigns` shows them. A list validates stages against its campaign. Built-in meaning by key: `interested`, `date_given` (dated visit/meeting → reminders + owner card), `not_interested` (always there, closed). Closed keys of every campaign stop messages (`isClosedStage`, refreshed each minute). Corporate sales: Replied → Booking contact shared → Interested → Meeting / visit fixed → Met → Rates shared → First booking → Regular client → Not now; closed: Not interested, Wrong contact. Win-back: Replied → Interested in a stay → Dates / quote shared → Visit fixed → Booked again → Regular guest → Not now — festival wishes only; closed: Not interested, Wrong number.
- **How the AI learns about messages**: people on a list get a "Reply to X" card the moment they write (and a re-check every 10 min). `inbox_summary` lists people on lists waiting for an answer, also those whose card was closed before they wrote again (NO CARD); hub_overview has an INBOX line. Chats of people on NO list are the staff's everyday chats (Seema, reception, guests booking through staff) — the AI leaves them alone unless the owner asks (`include_unlisted`). The hub's own numbers and the owner's alert phones are never listed. Opt-out words count only when the message is about the writer ("So he's not interested may be" from a referrer once tagged him opted-out).
- **New job roles from imports** (25 Oct): the first list of a new role (e.g. a WorkIndia "Driver" batch) starts a campaign that is set up like the other hiring campaigns — hiring stages and a playbook that follows "Hiring – all roles" — so the hiring rules apply from the first message; import_list tells the AI to ask you for the role's own rules (offer, salary, must-haves). Sales or guest roles are not touched.
- **Copies for other businesses** (e.g. the fish stall trial): built from the whatsapp-hub-builder skill — identical hub, own repo/database/service — with day-one onboarding (full history → customer book from the chats → 30-day plan as drafts → tracking with an evening "Who bought today?"), see the skill's `references/onboarding.md` and `fish-stall-hub-prompt.md`.
- **Board notes and buttons (25 Oct)**: a note was saved twice when "Save note" was pressed (the box saved on leaving it, and the button saved again). Now one save path, the button no longer takes focus from the box, and the server ignores the same note from the same person within 30 s (in a transaction that locks the card). Every button and form is locked while its action runs (`guard`), so double taps never run twice. After an action the Board keeps the scroll position and the open "More" sections; a press while typing a note no longer starts selection mode. On Drafts, Approve waits for the draft's autosave.
- **Queue status explains held follow-ups** (25 Oct): follow-ups to people who never replied wait until the follow-up time (21:00), for a day with no new outreach, or for tomorrow when the daily maximum is reached — Drafts & outbox and hub_overview now say which (before: "sending" with no reason).
- **Hosting a second copy** (another business): its own Supabase project and its own Render service and API key; Render's free 750 h/month are per workspace, so a second always-awake service needs Starter (~$7) or another Render account. Zenith's database was 88 MB after 18k messages (free limit 500 MB).
- **Playbooks can be deleted** in Settings (🗑 Delete this playbook); the text stays in History, deleted ones appear in the picker as "🗑 … (deleted)" and History restores them.
- **Numbers → ⚙️ Edit**: a pop-up for name, purpose, Active (pause) and 🗑 Delete, saved as you type; "Limits,
  delays & hours →" opens Settings for that number.
- **Playbooks**: `GET /api/playbook` = main unless `?campaign=`; `PUT` saves the main one unless `campaign` is given;
  `/api/playbooks` lists all (with `includes`); `POST /api/campaigns` takes `includes`. The playbook editor autosaves.
- **AI toolbox (64 tools)** — big picture first, then zoom in, then change what the owner asked:
  `hub_overview` → `owner_feedback` (owner card notes OPEN/DONE, Drafts-page "Owner:" requests, rejection reasons
  grouped) → `list_outbox(ids|full|search|to|offset)` whole messages with picture, send time, send-by, rejection reason
  → `get_messages(full_text)`, `task_history`, `describe_data` + `inspect_data` (one read-only SELECT in a READ ONLY
  transaction, 15 s, ≤300 rows; `wa_auth` and server functions refused). Changes: `edit_messages` (drafts AND
  approved-unsent: whole text for one, find/replace for many, add/swap/remove the picture; keeps status, number, time),
  `update_settings` (owner-only settings — approval mode, limits, gaps — only with `owner_asked` = the owner's words,
  quoted in Activity; also a number's name), `save_playbook(includes)`, `create_campaign(includes)`.
- Approve dialogs say "All 9 of these are dated for later (the first …) — none goes out now" instead of "9 have a
  later date", which read like 9 more messages.

### 10.9e Drafts page and sending controls (24 Oct)
- Edits save as you type (`PATCH /api/outbox/:id` → `outbox.editDraft`); approve/reject change one card in place, the
  scroll stays. Each card shows **🕒 Goes out …** (approving keeps a later date) or **⚡ soon after you approve**.
- Selection like the Board: long-press or ☑ Select; bar pinned at the bottom: ✅ Approve · ✖ Reject · 📝 Note for AI
  (`/outbox/note-for-ai` → an AI card listing the drafts; the AI uses `edit_draft`) · 🕒 Reschedule
  (`/outbox/reschedule`, `outbox.reschedule`; past/empty = as soon as possible; sched cards follow) · 📱 Send from
  (moves at once, `/outbox/move`) · Done. Tapping empty space (not a card or control) ends selection.
- **⌛ Send by** on cards (red when it won't fit), **≈ goes out about …** (forecast ETA when more than 30 min away), the
  Reschedule dialog has an optional "Send by". **⚠️ Not enough sending capacity** cards above the list: 👀 Show them
  (list filtered to those ids, already ticked), 📱 Send them from…, ✖ Skip them, ⬆ Raise limit to N (with the
  block-risk warning on linked phones). In a campaign view the card counts that campaign's messages and says how many
  more are in other campaigns.
- Pictures for everyone in a list send: `send_to_list(attachment_url)` — each person's message is the caption.

### 10.10 Debugging recipes
| Symptom | Look at |
|---|---|
| "Errors on the hub" | Activity → ⚠️ Only problems (`/api/events?problems=1`) or `recent_activity(who="system")`: failed follow-ups, Meta holds, disconnects, rule failures |
| Message not going out | hub_overview "sending: held — reason"; `list_outbox status=queued` (scheduled time shown) |
| Meta message failed | the draft card's "what to do"; `meta_health_check`; `message_timeline <phone>` |
| Card missing / closed | `task_history <id>` (who closed it and why); `/health → board` (last re-check) |
| A file won't download | "File not available" page says why: link expired + phone no longer has it → ask them to resend |
| Interview not on the Board | the member needs `visit_at` and a stage of interested/date_given (not closed) |
| Follow-ups never go | number setting "Follow-ups not before", daily max, new outreach today, list follow-up on? |
| "deadlock detected" | two servers overlapping in a deploy — statements are retried automatically now |
| Wrong number drafted | `send_message` refuses numbers whose chat is elsewhere unless `other_number_ok` |
| Dashboard says "out of scope" | the open campaign changed on another device or by the AI — any page change follows it; or pick All campaigns |
| A message waits although "only 10 sent today" | it is cold (never wrote to this number) and the cold limit counts the last 24 h, not the calendar day; or a higher-ranked message is ahead (send order) — Drafts shows ≈ when it goes |
| A festival wish was "rejected — Expired" | it had a "send by" time and the number's limit could not fit it in time (a warning showed beforehand) |
| Dashboard is blank | a script error in `public/app.js` — browser console; the "dashboard script parses" test catches syntax errors |
| A page asks for one campaign but shows another | `roleQ` refuses a `role` that differs from the open campaign — the page passed a stale role |
| AI tool says "belongs to campaign X … out of scope" | intended: it must pass `campaign="X"` (or "all") to act on purpose |
| `/mcp/<key>/<campaign>` returns HTML | the old server still answers during a deploy (~1–2 min) — retry |
| Anything else | Render logs (pino JSON), then reproduce in a test: `npm test` runs the whole hub on PGlite with a fake WhatsApp and a fake Meta server |

### 10.11 How to debug (method that worked here)
1. **Evidence first, not guesses.** Read-only queries on the live database (`BEGIN READ ONLY`): problems in `events`
   (grouped, last 3 days), failed outbox rows by error, rows stuck in `sending`, queued rows overdue, duplicate drafts,
   reply cards whose person already got an answer, duplicate open cards per ref, drafts/cards with no campaign though the
   person is on a list, pending jobs. Empty = healthy; anything else is a lead.
2. **One hypothesis per lead**, check it against the data (e.g. "deadlock" happened before the retry fix shipped → fixed).
3. **Static pass**: `node --check` every file, then ESLint core correctness rules (no-undef, unused vars, dupe keys,
   unreachable code …) from a throw-away folder (no project dependency).
4. **Smoke the live system**: every read-only MCP tool with real data (`campaign:"all"` and one campaign) and every
   GET `/api/*` — any `Error:` or non-200 is a bug (this found the role-vs-"all" bug).
5. **Reproduce in a test, fix, keep the test** (`test/server.test.js`), then `npm test`.
6. **UI in a real browser**: a local preview on a throw-away database with sample data, phone and desktop widths;
   click through the changed pages and read the console. A page reload is needed after code changes (changing only
   the `#hash` does not reload).
7. **Verify after deploy**: `/health` shows the new version; re-run the smoke checks.
Pitfalls met: Express 5 `req.query` is read-only (assignments are lost); scripted text edits with
`String.replace` turn `$$` into `$` (use a replacer function); shell heredocs break on quotes — write edit scripts
to a file; Baileys "Disconnected (428/408/503) — reconnecting" warnings are normal churn.

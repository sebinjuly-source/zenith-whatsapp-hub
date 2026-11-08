# Zenith WhatsApp Hub — rules for any AI coding session (read first)

## What it is
A general-purpose multi-number WhatsApp hub for one business: linked numbers (Baileys) + a Meta Cloud API number,
full chat history in Postgres, a dashboard (Board, Inbox, Drafts, Lists, Contacts, Templates, Rules, Settings),
a REST API (`x-api-key`) and an MCP server (`/mcp/<key>`) so AI routines do the daily work.
**The hub stays general.** Business specifics (prices, wording, who to message, staff) live in the playbooks
(`save_playbook`) and in the routine prompts — not in code (owner, 1 Nov 2026: a staff attendance feature was reverted
because "the hub was already good, now it feels too much"). Before adding code for a business need, try playbook +
routine; add code only when the generic tools truly can't do it, and say why.

## Stack (do not change without asking)
Node ≥ 20 ESM · Express 5 · Baileys 7 · Postgres (Supabase) / PGlite locally and in tests · `@modelcontextprotocol/sdk`
+ zod · pino · Render (auto-deploy on push to main; `/health` shows the version). Ask before adding a dependency.

## Commands
- Test everything: `npm test` (≈ 9 min, whole hub on PGlite with fake WhatsApp + fake Meta). One test:
  `node --test --test-force-exit --test-concurrency=1 --test-name-pattern="<part of name>" test/server.test.js`
- Call a live tool: `node scripts/mcp-call.mjs <tool> '<json args>'` (key from .env; never print it)
- Test an Apps Script before pasting it into a Sheet: `node scripts/gas-twin.mjs apps-script/<file>.gs <fn> …`
- Local UI: `run-local.mjs` pattern (throw-away PGlite, `API_KEY=localtest`, never the live DB), phone + desktop widths.
- Copy fixes into the reusable skill: `node ~/.claude/skills/whatsapp-hub-builder/scripts/sync-template.mjs <hub>`

## Rules
- Every bug: reproduce with a test first (or with live evidence), fix the code, keep the test. Never edit a test to
  make it pass unless the test itself was wrong — then say so.
- Every schema change is idempotent SQL in `src/db.js` (`CREATE … IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).
- Every MCP tool: zod input, the campaign filter (`campaign=`, "all" = every campaign), answers short (`budget()`,
  16 KB) with the most important lines first. New tool → add it to the "every tool answers" toolbox test.
- The AI is shown only `CORE_TOOLS` (src/mcp.js); every other tool sits in the menu (`more_tools` / `use_tool`). A new tool goes
  into `CORE_TOOLS` only if every session needs it; otherwise add its name to a group in `MENU_GROUPS`. Keep descriptions
  short — the tool list is paid for in every session (6 Nov: 76 tools were 93 KB).
- `campaign=` on every tool is only a FILTER (routines pass "all" everywhere). Never give a tool a parameter named
  `campaign` that changes data (1 Nov: `update_task` used it to move cards and re-tagged 23 cards to "all").
- Files people send must never render as a page on the hub's address: serve them through `sendStoredFile()`.
- The key: `keyOk()` (constant time) + `keyGuessBlocked()` (10 wrong / 15 min / IP) in `src/auth.js` — everywhere.
- Writes: update only rows that changed (`IS DISTINCT FROM`), never "rewrite everything each minute".
- Never message real people while testing; owner test messages go to the owner's alert phone only.
- The owner's ✓ Done is a hand-over to the AI (status `review`), never a silent close; cards the hub closes itself stay direct.
- Writing JS/regex from Python: use raw strings (r-strings) or write the script with the editor tool — backslash
  escapes (newline, \s, carriage return) get mangled otherwise (2 Nov: four broken edits). Run `node --check` after
  every scripted edit.
- After a fix to the hub, sync the skill template and update `docs/HOW-IT-WORKS.md` (§10.10 recipes, §10.11 method).
- `hub_overview`'s first line is the verdict a routine may stop on. Any change to "NOTHING DUE" must keep counting EVERY
  way the owner hands work to the AI: AI cards due (reply cards, undated to-dos, status `review` whatever the date),
  chats waiting on lists and on none, people who wrote again after our draft, owner notes on cards, rejections with a
  reason; a focused overview never claims nothing hub-wide (8 Nov 2026).
- AI cost = context × turns. Bundle what the AI always reads per person (`packFor()`: `list_tasks pack`,
  `inbox_summary with_messages`) rather than trimming coverage. The cloud routines run on Sonnet by the owner's choice;
  read them with the `schedule` skill (RemoteTrigger) before describing or changing them — never from the manual alone.

## Where to read more (don't copy it here)
`docs/HOW-IT-WORKS.md` is the full manual — for the owner and for debugging: §10 follows a message end to end through
the files, §10.10 is the symptom → where-to-look table, §10.11 the debugging method, §10.12 what was measured.
Read the section you need instead of the whole file. This file holds only the rules every session must follow.

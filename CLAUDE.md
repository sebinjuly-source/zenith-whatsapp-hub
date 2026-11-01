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
- `campaign=` on every tool is only a FILTER (routines pass "all" everywhere). Never give a tool a parameter named
  `campaign` that changes data (1 Nov: `update_task` used it to move cards and re-tagged 23 cards to "all").
- Files people send must never render as a page on the hub's address: serve them through `sendStoredFile()`.
- The key: `keyOk()` (constant time) + `keyGuessBlocked()` (10 wrong / 15 min / IP) in `src/auth.js` — everywhere.
- Writes: update only rows that changed (`IS DISTINCT FROM`), never "rewrite everything each minute".
- Never message real people while testing; owner test messages go to the owner's alert phone only.
- After a fix to the hub, sync the skill template and update `docs/HOW-IT-WORKS.md` (§10.10 recipes, §10.11 method).

## Architecture (where things are)
`src/index.js` start-up + minute loop · `wa/session.js` linked numbers (leases: one server per number) · `wa/cloud.js`
Meta · `outbox.js` sending (approval, limits, send order) · `lists.js` lists/funnel/follow-ups · `board.js` +
`tasks.js` the Board · `mcp.js` AI tools (+ `hub_api`, `runTool`) · `api.js` REST (+ `/api/tools`) · `scope.js`
campaign filter · `phonedrafts.js` drafts on the phone · `db.js` schema. Full guide: `docs/HOW-IT-WORKS.md`.

## Debugging method (worked again and again — §10.11)
Evidence first (read-only SQL on live: `events`, `outbox`, `tasks`, `pg_stat_statements`) → one hypothesis per lead →
`node --check` → smoke every tool on live data → reproduce in a test → fix → `npm test` → UI in a real browser at 375 px
→ verify after deploy (`/health` version). "elsewhere" right after a deploy = the other server still holds the
number for 1–3 min, not an unlinked number.

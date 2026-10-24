# Data growth plan — keeping the hub fast and the AI's answers small

Written 24 Oct 2026. Rule for every step: **a system that never breaks beats a more advanced one.** Each step is
small, can be switched back, and comes with a test. Do a step only when its trigger is reached.

## Where we are (24 Oct 2026)
- ~18,000 messages, ~17,000 contacts, several hundred people on Chef lists alone, 4 numbers. Postgres (Supabase free, 500 MB) handles
  this easily; `/health` now shows `dbMb`, and `list_accounts` shows messages per number.
- The real pressure is not the database — it is **how much text one AI tool answer puts into the model's
  context**. Before this plan, `known_candidates` returned ~77,000 characters and the finished Board ~37,000.
  Both grow with every batch.

## Ideas taken from pivot_hotel (and what was left out, on purpose)
pivot_hotel's retrieval design (`RETRIEVAL_ARCHITECTURE.md`, `universal_memory_system_implementation_plan.md`):
| Idea there | Taken here as | Why |
|---|---|---|
| Token budget per answer ("no silent truncation", GraphRAG) | **Response budget** on every MCP tool: ~16,000 characters, cut at a line, saying how many lines were left out and which filters narrow it | One rule protects every tool, today and as data grows |
| Exact-name / BM25 **fast path** before anything expensive | `known_candidates(query=…)`: exact phone match, then name/place substring; answers only the matches and "new" for the rest | The common question ("are these 30 people new?") never needs the whole history |
| Domain "recipes" with a small top-k per kind | **Summary first**: counts per list by default; details only for what is asked (query / filters / all=true) | Hierarchical answers keep the default small |
| Per-guest consolidation ("dream consolidation") | Already present as `contacts.summary` (`update_contact(summary=…)`): one line per person the AI reads instead of the whole chat | No new machinery — just use it consistently (playbook rule, step 2c) |
| Vector embeddings, LanceDB, graph expansion, weight calibration, autocut cross-encoder | **Not taken** | Built for thousands of documents/SOPs. Our data is structured rows with exact keys (phone, list, stage); SQL filters answer exactly. These add new services, models and failure modes for no gain here |

## Phase 1 — done (24 Oct 2026)
1. Response budget in `src/mcp.js` (`budget()`, `RESPONSE_BUDGET = 16000`); the playbook is exempt. Tested.
2. `known_candidates`: `query` (fast path), counts by default, `all=true` for the full list. Tested.
3. `list_tasks(past=true)` capped at the latest 60.
4. `/health → dbMb` to watch growth.

## Phase 2 — next simple steps (when an answer hits the budget regularly)
Check: Activity / Render logs, or ask the AI "which tools got cut?" (the cut line is visible in its transcript).
a. **list_members on big lists**: above 100 people and no status/stage filter → counts per status and stage,
   plus "pass status= or stage= for names". Same pattern as known_candidates. ~20 lines + a test.
b. **"More" hints**: list tools say `… 40 more — offset=50` (list_chats already has offset; add to list_outbox,
   list_tasks). ~10 lines each.
c. **One-line person memory**: playbook rule "after a real exchange, update_contact(summary=…) in one line";
   `list_tasks(kind=reply)` and `hub_overview` show that line on each card. Costs nothing, saves reading chats.
d. **get_messages(since_our_last=true)**: only what they wrote since our last message — what a reply needs.

## Phase 3 — when message search gets slow (trigger: `search_messages` > 1 s, or messages > ~200,000)
- Add `CREATE INDEX IF NOT EXISTS messages_fts ON messages USING gin (to_tsvector('simple', coalesce(body,'')))`
  (works on Supabase and PGlite).
- `searchMessages`: run the full-text query first (uses the index); fall back to `ILIKE` only for digit
  searches (phone numbers) or when full-text finds nothing, limited to the last 180 days.
- Test both paths; compare timings before/after on a copy of the data.

## Phase 4 — when the database nears the free plan (trigger: `dbMb` > 350 of 500)
In this order, each reversible:
1. `task_log` of cards closed > 6 months ago: keep notes, delete hub events ("Due …", "Moved to …").
2. `outbox.payload` of sent messages > 6 months: drop base64 attachments (keep text + file name).
3. Old non-candidate group messages (> 1 year) in numbers with `storeGroups` → export to a file, then delete.
4. Only then consider Supabase Pro (~$25/month) — the code does not change.
Never delete candidates' or guests' direct chats without the owner's yes.

## What not to do
- No second database, no vector store, no background "AI summariser" that rewrites data by itself.
- No silent caps: every limit says what it left out and how to see it.
- No limit without a test that proves the answer still contains what the owner needs.

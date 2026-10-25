/**
 * The playbook: your standing rules for whoever runs the hub (you, Claude Code, regular Claude, any AI).
 * Stored in the hub's database, editable in the dashboard, and handed to every AI client with the MCP
 * connection — so the rules apply wherever the hub is used, not only where a skill is installed.
 */
import { query } from './db.js';

export const DEFAULT_PLAYBOOK = `HOW TO USE THE HUB (read first)
1. hub_overview first: what is due now across ALL numbers, each number's sending state and why it is held, lists per number, failures with what to do.
2. Work the Board: list_tasks(kind="reply"), then list_tasks(for="ai", due_now=true). Finished tasks are hidden (past=true).
3. Never conclude something is missing after filtering by one number — lists and tasks live on different numbers.
4. Candidate data only from the source file — never type or invent names/numbers. Check known_candidates before importing; compare import_list's New/Updated/Skipped with the file. Mistaken rows: remove_list_member. Lists that must never send: archive_list.
5. Drafts wait for the owner; never approve unless told. If messages don't go out, report the "sending: held — reason" from hub_overview.

HIRING (hiring number)
- Never give money (fuel, travel, advance, "help") to a candidate before they join. Anyone asking for money before coming is treated as a likely job-app scammer: set stage "rejected", outcome "rejected – asked for money before joining".
- Funnel: interested → date_given (always record the date they will come with the visit date) → visited / trial → selected → joined. Also no_show, not_interested, rejected.
- If a candidate is interested, ask for the day and time they can come and record it as the visit date. The hub reminds them before the visit and adds a board task for the owner.
- Candidates who never replied are the lowest priority. The daily message capacity goes to new, never-messaged candidates first. Follow-ups to non-repliers only after 21:00 on days with no first messages to new people, at most 5 a day (the hub enforces this).
- Messages are in simple Hinglish, signed "- Zenith Suites HR". Hiring contact number: 9353315601 (Seema).
- Each candidate's own prepared message (from the WorkIndia sheet) has their salary range; never state a different salary in follow-ups.

GENERAL
- Read recent_activity before assuming how something was set up (history options, settings, approvals).
- Keep outputs short; filter lists instead of reading everything.`;

export async function getPlaybook() {
  const [r] = await query(`SELECT value, updated_at FROM config WHERE key = 'playbook'`);
  return r ? { text: r.value.text, updatedAt: r.updated_at } : { text: DEFAULT_PLAYBOOK, updatedAt: null };
}

/**
 * Campaign playbooks: the main playbook holds what applies everywhere (how to use the hub, general rules); each
 * campaign (job role or sales campaign: "Chef", "Front office", "Corporate sales", "Win-back"…) can have its own,
 * stored as config key "playbook:<campaign>". The AI reads the main one always and a campaign's when it works on it.
 */
const keyOf = (campaign) => (campaign ? `playbook:${String(campaign).trim()}` : 'playbook');

/**
 * Save a playbook and keep its history. Every save is a version; typing in one sitting (same person, within
 * EDIT_SESSION_MIN minutes) updates that sitting's version instead of adding one per keystroke. The text that was
 * there before the first recorded edit is kept as a version too, so every change can be undone.
 * Returns the playbook plus { changed, newVersion } — newVersion = a new sitting began (log it once).
 */
const EDIT_SESSION_MIN = 10;
export async function savePlaybook(text, campaign = null, { actor = 'you' } = {}) {
  if (!String(text || '').trim()) throw new Error('The playbook is empty');
  if (campaign !== null && campaign !== undefined && !String(campaign).trim()) throw new Error('Name the campaign');
  const key = keyOf(campaign);
  const [cur] = await query(`SELECT key, value FROM config WHERE lower(key) = lower($1)`, [key]);
  const before = cur ? String(cur.value?.text ?? '') : campaign ? null : DEFAULT_PLAYBOOK;
  const realKey = cur?.key || key;
  let newVersion = false;
  if (before !== String(text)) {
    const [last] = await query(`SELECT id, actor, at FROM playbook_versions WHERE lower(key) = lower($1) ORDER BY id DESC LIMIT 1`, [realKey]);
    if (!last && before !== null) await query(`INSERT INTO playbook_versions (key, text, actor) VALUES ($1, $2, 'before history')`, [realKey, before]);
    if (last && last.actor === actor && new Date(last.at) > new Date(Date.now() - EDIT_SESSION_MIN * 60e3)) {
      await query(`UPDATE playbook_versions SET text = $2, at = now() WHERE id = $1`, [last.id, String(text)]);
    } else {
      await query(`INSERT INTO playbook_versions (key, text, actor) VALUES ($1, $2, $3)`, [realKey, String(text), actor]);
      newVersion = true;
    }
    await query(
      `INSERT INTO config (key, value) VALUES ($2, $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ text: String(text) }), realKey],
    );
  }
  const p = campaign ? await getCampaignPlaybook(campaign) : await getPlaybook();
  return { ...p, changed: before !== String(text), newVersion };
}

/** A playbook's saved versions, newest first: [{ id, at, actor, chars, text }]. */
export async function playbookHistory(campaign = null, limit = 50) {
  const rows = await query(`SELECT id, at, actor, text FROM playbook_versions WHERE lower(key) = lower($1) ORDER BY id DESC LIMIT $2`, [keyOf(campaign), limit]);
  return rows.map((r) => ({ id: Number(r.id), at: r.at, actor: r.actor, chars: r.text.length, text: r.text }));
}

/** Put an earlier version back (saved as a new version, so the restore itself can be undone). */
export async function restorePlaybook(versionId, { actor = 'you' } = {}) {
  const [v] = await query(`SELECT key, text, at FROM playbook_versions WHERE id = $1`, [versionId]);
  if (!v) throw new Error('No such version');
  const campaign = v.key === 'playbook' ? null : v.key.slice('playbook:'.length);
  await query(`UPDATE playbook_versions SET at = at - interval '1 day' WHERE id = (SELECT max(id) FROM playbook_versions WHERE lower(key) = lower($1))`, [v.key]); // a restore is always its own version
  const p = await savePlaybook(v.text, campaign, { actor });
  return { ...p, campaign, restoredFrom: v.at };
}

/** One campaign's playbook ({ campaign, text, updatedAt }) or null. Name match ignores case. */
export async function getCampaignPlaybook(campaign) {
  const [r] = await query(`SELECT key, value, updated_at FROM config WHERE lower(key) = lower($1)`, [keyOf(campaign)]);
  return r ? { campaign: r.key.slice('playbook:'.length), text: r.value.text, updatedAt: r.updated_at } : null;
}

/**
 * A campaign's rules as the AI should read them: lines "INCLUDE: <campaign>" pull in another campaign playbook
 * (e.g. "Chef" includes "Hiring – all roles"), one level deep, so shared rules are written once.
 */
export async function campaignRules(campaign) {
  const p = await getCampaignPlaybook(campaign);
  if (!p) return null;
  const lines = [];
  for (const line of p.text.split('\n')) {
    const m = line.match(/^\s*INCLUDE:\s*(.+?)\s*$/i);
    if (!m) { lines.push(line); continue; }
    const inc = m[1].toLowerCase() === p.campaign.toLowerCase() ? null : await getCampaignPlaybook(m[1]);
    lines.push(inc ? `--- included: ${inc.campaign} ---\n${inc.text.split('\n').filter((l) => !/^\s*INCLUDE:/i.test(l)).join('\n')}\n--- end of ${inc.campaign} ---` : `(INCLUDE: no playbook "${m[1]}")`);
  }
  return { ...p, text: lines.join('\n') };
}

/** The other playbooks a campaign playbook follows ("INCLUDE: <name>" lines). */
export function includesOf(text) {
  return String(text || '').split('\n').map((l) => l.match(/^\s*INCLUDE:\s*(.+?)\s*$/i)?.[1]).filter(Boolean);
}

/** The text with exactly these INCLUDE lines at the top (others removed) — the "Also follows" choice in the UI. */
export function withIncludes(text, includes = []) {
  const body = String(text || '').split('\n').filter((l) => !/^\s*INCLUDE:/i.test(l)).join('\n').replace(/^\n+/, '');
  const head = [...new Set(includes.map((x) => String(x).trim()).filter(Boolean))].map((x) => `INCLUDE: ${x}`).join('\n');
  return [head, body].filter(Boolean).join('\n\n') || head;
}

/** Campaign playbooks that exist: [{ campaign, chars, updatedAt }]. */
export async function listCampaignPlaybooks() {
  const rows = await query(`SELECT key, value, updated_at FROM config WHERE key LIKE 'playbook:%' ORDER BY key`);
  return rows.map((r) => ({ campaign: r.key.slice('playbook:'.length), chars: String(r.value?.text || '').length, includes: includesOf(r.value?.text), updatedAt: r.updated_at }));
}

export async function deleteCampaignPlaybook(campaign) {
  await query(`DELETE FROM config WHERE lower(key) = lower($1)`, [keyOf(campaign)]);
}

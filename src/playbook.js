/**
 * The playbook: your standing rules for whoever runs the hub (you, Claude Code, regular Claude, any AI).
 * Stored in the hub's database, editable in the dashboard, and handed to every AI client with the MCP
 * connection — so the rules apply wherever the hub is used, not only where a skill is installed.
 */
import { query } from './db.js';

export const DEFAULT_PLAYBOOK = `HIRING (hiring number)
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

export async function savePlaybook(text) {
  if (!String(text || '').trim()) throw new Error('The playbook is empty');
  await query(
    `INSERT INTO config (key, value) VALUES ('playbook', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ text: String(text) })],
  );
  return getPlaybook();
}

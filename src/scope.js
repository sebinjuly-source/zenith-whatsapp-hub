/**
 * Campaign scope — a campaign works like a separate user. When the owner picks a campaign in the dashboard, that
 * becomes the hub's FOCUS: the dashboard and the AI (MCP) see only that campaign's chats, drafts, cards, lists,
 * contacts, templates and rules, and every action on something outside it is refused. Numbers are shared by all
 * campaigns. "" (no focus) = all campaigns; "none" = Hotel / no campaign (people on no list).
 *
 * A person belongs to a campaign when they are on one of its lists; nobody on a list → "none".
 */
import { query } from './db.js';
import { NONE, roleOf } from './campaign.js';

const KEY = 'focus';
const norm = (c) => String(c ?? '').trim();
export const same = (a, b) => norm(a || NONE).toLowerCase() === norm(b || NONE).toLowerCase();
export const label = (c) => (!c ? 'all campaigns' : same(c, NONE) ? 'Hotel / no campaign' : `campaign "${c}"`);

/** The dashboard's focus ('' = all campaigns). */
export async function getFocus() {
  const [r] = await query('SELECT value FROM config WHERE key = $1', [KEY]);
  return norm(r?.value?.campaign);
}
export async function setFocus(campaign) {
  const c = norm(campaign);
  if (c && !same(c, NONE) && !(await campaignExists(c))) throw new Error(`No campaign called "${c}" — create it first`);
  await query(`INSERT INTO config (key, value, updated_at) VALUES ($1, $2, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [KEY, JSON.stringify({ campaign: c })]);
  return c;
}

/** Every campaign: created ones plus the job roles of lists. */
export async function campaignNames() {
  const rows = await query(`SELECT name FROM campaigns WHERE archived IS NULL
    UNION SELECT DISTINCT role FROM lists WHERE role IS NOT NULL AND archived IS NULL ORDER BY 1`);
  return rows.map((r) => r.name);
}
export async function campaignExists(name) {
  return (await campaignNames()).some((n) => same(n, name));
}
export async function createCampaign(name, { description = null } = {}) {
  const n = norm(name).replace(/\s+/g, ' ');
  if (!n) throw new Error('Give the campaign a name, e.g. "Corporate sales" or "Diwali offer"');
  if (n.length > 60) throw new Error('Keep the name short (60 characters at most)');
  if (same(n, NONE) || /^all( campaigns)?$/i.test(n)) throw new Error(`"${n}" is reserved — choose another name`);
  const existing = (await campaignNames()).find((x) => same(x, n));
  if (existing) return { name: existing, created: false };
  await query(`INSERT INTO campaigns (name, description) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET archived = NULL`, [n, description]);
  return { name: n, created: true };
}

// ---- what belongs to which campaign ----

/** Is this person (chat) in the campaign? On a list of it — or, for "none", on no list at all. Groups belong to "none". */
export async function personIn(campaign, accountId, jid) {
  if (!campaign) return true;
  if (String(jid).endsWith('@g.us')) return same(campaign, NONE);
  if (same(campaign, NONE)) {
    const [r] = await query(`SELECT 1 FROM list_members WHERE jid = $1 LIMIT 1`, [jid]);
    return !r;
  }
  const [r] = await query(`SELECT 1 FROM list_members m JOIN lists l ON l.id = m.list_id WHERE m.jid = $1 AND lower(l.role) = lower($2) LIMIT 1`, [jid, campaign]);
  return !!r;
}
export async function draftCampaign(id) {
  const [r] = await query(`SELECT COALESCE(o.role, ${roleOf('o.account_id', 'o.to_jid')}) AS c, o.account_id, o.to_jid FROM outbox o WHERE o.id = $1`, [id]);
  return r || null;
}
export async function taskCampaign(id) {
  const [r] = await query(`SELECT t.role AS c, t.ref, t.account_id FROM tasks t WHERE t.id = $1`, [id]);
  if (!r) return null;
  // reply / reminder cards without a stored role follow the person
  if (!r.c && /^(reply|remind):/.test(r.ref || '')) {
    const [, acc, jid] = r.ref.split(':');
    const [p] = await query(`SELECT ${roleOf('$1', '$2')} AS c`, [acc, jid]);
    r.c = p?.c || null;
  }
  return r;
}
export async function listCampaign(idOrName) {
  const asId = /^\d+$/.test(String(idOrName)) ? Number(idOrName) : -1;
  const [r] = await query(`SELECT role AS c, name FROM lists WHERE id = $1 OR lower(name) = lower($2) ORDER BY id DESC LIMIT 1`, [asId, String(idOrName)]);
  return r || null;
}

/** Throws a clear message when <what> (in campaign <c>) is outside the focus. */
export function assertSame(focus, c, what) {
  if (!focus || same(focus, c)) return;
  throw new Error(`${what} belongs to ${label(c)}, but you are working in ${label(focus)} — it is out of scope here. To work on it on purpose: AI → pass campaign="${c || NONE}" (or "all") to this tool; dashboard → pick that campaign at the top.`);
}
export async function assertPerson(focus, accountId, jid, what = 'This person') {
  if (!focus || (await personIn(focus, accountId, jid))) return;
  const [r] = await query(`SELECT ${roleOf('$1', '$2')} AS c`, [accountId, jid]);
  if (!r?.c && !same(focus, NONE)) {
    throw new Error(`${what} (${String(jid).split('@')[0]}) is on no list of ${label(focus)}. Add them to one of its lists first (import_list), then message them.`);
  }
  assertSame(focus, r?.c, `${what} (${String(jid).split('@')[0]})`);
}
export async function assertDrafts(focus, ids) {
  if (!focus) return;
  for (const id of ids) {
    const d = await draftCampaign(id);
    if (!d) throw new Error(`Message #${id} not found`);
    assertSame(focus, d.c, `Message #${id}`);
  }
}
export async function assertTask(focus, id) {
  if (!focus) return;
  const t = await taskCampaign(id);
  if (!t) throw new Error(`Card #${id} not found`);
  assertSame(focus, t.c, `Card #${id}`);
}
export async function assertList(focus, idOrName) {
  if (!focus) return;
  const l = await listCampaign(idOrName);
  if (!l) throw new Error(`No list "${idOrName}"`);
  assertSame(focus, l.c, `List "${l.name}"`);
}

/** SQL condition: chat <jidSql> is in the campaign at placeholder $<n> (same rule as personIn). */
export const personInSql = (jidSql, n) => `(CASE WHEN lower($${n}) = '${NONE}'
    THEN NOT EXISTS (SELECT 1 FROM list_members sm WHERE sm.jid = ${jidSql})
    ELSE ${jidSql} NOT LIKE '%@g.us' AND EXISTS (SELECT 1 FROM list_members sm JOIN lists sl ON sl.id = sm.list_id WHERE sm.jid = ${jidSql} AND lower(sl.role) = lower($${n})) END)`;

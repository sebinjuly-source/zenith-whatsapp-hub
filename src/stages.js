/**
 * Funnel stages per campaign. A campaign's stages are [{ key, label, closed? }], stored on campaigns.stages and set
 * by the owner (New campaign pop-up, Lists page) or the AI (create_campaign / set_campaign_stages). Without its own,
 * a hiring campaign uses the hiring funnel and any other campaign the sales funnel.
 * Keys with a built-in meaning, whatever their label says:
 *   interested     — they want it (hiring lists: the hub asks for a day when the pipeline is on)
 *   date_given     — a dated visit / interview / meeting (visit_at): reminders before it and an owner card
 *   not_interested — closed; also what the one-tap "Not interested" call result sets (every campaign has it)
 * A stage marked closed ends every message to that person from the hub (like joined / rejected in hiring).
 */
import { query } from './db.js';

const st = (key, label, closed = false) => ({ key, label, ...(closed ? { closed: true } : {}) });
export const PRESETS = {
  hiring: [st('interested', 'Interested'), st('date_given', 'Interview date fixed'), st('visited', 'Visited'), st('trial', 'Trial'),
    st('selected', 'Selected'), st('joined', 'Joined', true), st('no_show', 'No-show'), st('not_interested', 'Not interested', true), st('rejected', 'Rejected', true)],
  sales: [st('replied', 'Replied'), st('contact_shared', 'Booking contact shared'), st('interested', 'Interested'), st('date_given', 'Meeting / visit fixed'),
    st('met', 'Met / visited'), st('rates_shared', 'Rates shared'), st('first_booking', 'First booking'), st('regular_client', 'Regular client'),
    st('not_now', 'Not now — keep warm'), st('not_interested', 'Not interested', true), st('wrong_contact', 'Wrong contact', true)],
  winback: [st('replied', 'Replied'), st('interested', 'Interested in a stay'), st('enquiry', 'Dates / quote shared'), st('date_given', 'Visit fixed'),
    st('booked', 'Booked again'), st('regular', 'Regular guest'), st('not_now', 'Not now — festival wishes only'),
    st('not_interested', 'Not interested', true), st('wrong_number', 'Wrong number', true)],
};
export const PRESET_LABELS = { hiring: 'Hiring (candidates)', sales: 'Sales / corporate', winback: 'Win-back (past guests)' };
const HIRING = /chef|cook|front office|reception|housekeep|service|driver|security|steward|waiter|hiring|staff|general|^test/i;
/** Does this campaign name look like a hiring campaign (a job role)? */
export const isHiringName = (name) => HIRING.test(String(name || ''));
const defaultFor = (campaign) => (!campaign || HIRING.test(campaign) ? PRESETS.hiring : PRESETS.sales);

const BUILTIN_CLOSED = ['joined', 'not_interested', 'rejected'];
let closed = new Set(BUILTIN_CLOSED);
let own = new Map(); // lower(campaign) -> stages
let loadedAt = 0;

/** Re-read every campaign's stages (cheap; at most once a minute unless forced). */
export async function refreshStages(force = false) {
  if (!force && Date.now() - loadedAt < 60e3) return;
  const rows = await query(`SELECT name, stages FROM campaigns WHERE stages IS NOT NULL`).catch(() => []);
  own = new Map(rows.map((r) => [r.name.toLowerCase(), r.stages]));
  closed = new Set([...BUILTIN_CLOSED, ...Object.values(PRESETS).flat().filter((s) => s.closed).map((s) => s.key),
    ...rows.flatMap((r) => (r.stages || []).filter((s) => s.closed).map((s) => s.key))]);
  loadedAt = Date.now();
}

/** Stage keys that close a person, in any campaign (sync; refreshed by refreshStages). */
export const closedKeys = () => [...closed];
export const isClosedStage = (stage) => !!stage && closed.has(stage);
/** SQL list of the closed keys, e.g. 'joined','not_interested' — for NOT IN (…). */
export const closedSqlList = () => [...closed].map((k) => `'${String(k).replace(/'/g, "''")}'`).join(',');

/** The stages of a campaign ([{ key, label, closed? }]) and whether they are its own or the default. */
export async function stagesFor(campaign) {
  await refreshStages();
  const mine = campaign ? own.get(String(campaign).toLowerCase()) : null;
  return mine || defaultFor(campaign);
}
export async function stagesInfo(campaign) {
  await refreshStages();
  const mine = campaign ? own.get(String(campaign).toLowerCase()) : null;
  return { stages: mine || defaultFor(campaign), own: !!mine };
}

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s-]+/g, '_').slice(0, 40);

/**
 * Accepts a preset name ("hiring" / "sales" / "winback"), an array of { key?, label, closed? } or of strings
 * ("Meeting fixed", "Lost (closed)"). Keys come from the labels unless given; "not_interested" is always there.
 */
export function normalizeStages(input) {
  if (typeof input === 'string' && PRESETS[input]) return PRESETS[input].map((s) => ({ ...s }));
  if (!Array.isArray(input) || !input.length) throw new Error('Give the stages (a list), or a preset: hiring, sales, winback');
  const out = [];
  for (const raw of input) {
    let s = typeof raw === 'string' ? { label: raw } : { ...raw };
    let label = String(s.label || s.key || '').trim();
    if (/\((closed|ends?|stop)\)\s*$/i.test(label)) { s.closed = true; label = label.replace(/\s*\((closed|ends?|stop)\)\s*$/i, ''); }
    if (!label) continue;
    const key = s.key ? slug(s.key) : slug(label);
    if (!key || out.some((x) => x.key === key)) continue;
    out.push({ key, label: label.slice(0, 50), ...(s.closed || BUILTIN_CLOSED.includes(key) ? { closed: true } : {}) });
  }
  if (!out.some((s) => s.key === 'not_interested')) out.push({ key: 'not_interested', label: 'Not interested', closed: true });
  if (out.length > 20) throw new Error('At most 20 stages');
  return out;
}

/** Set a campaign's stages (creates the campaign row when it only existed as a list role). */
export async function setStages(campaign, input) {
  const name = String(campaign || '').trim();
  if (!name) throw new Error('Which campaign?');
  const stages = normalizeStages(input);
  // the campaign's own spelling (a campaign may exist only as a list role, e.g. "Win-back")
  const [row] = await query(`SELECT name FROM campaigns WHERE lower(name) = lower($1)
    UNION ALL SELECT role FROM lists WHERE lower(role) = lower($1) LIMIT 1`, [name]);
  await query(`INSERT INTO campaigns (name, stages) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET stages = EXCLUDED.stages`, [row?.name || name, JSON.stringify(stages)]);
  await refreshStages(true);
  return stages;
}

/** "Interested → Meeting / visit fixed → … · closed: Not interested, Wrong contact" */
export const stagesText = (stages) => `${stages.filter((s) => !s.closed).map((s) => `${s.label} (${s.key})`).join(' → ')} · closed: ${stages.filter((s) => s.closed).map((s) => `${s.label} (${s.key})`).join(', ')}`;

// keep the closed set fresh on every server (another server or the AI may change a campaign's stages)
setInterval(() => refreshStages(true).catch(() => {}), 60e3).unref?.();

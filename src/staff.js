/**
 * Staff attendance and advances, from the WhatsApp messages staff already send (1 Nov 2026). Mallesh writes
 * "Gm mam present mam" every morning — spelt "perseant", "prseant", "presant" — and staff ask for money in chat
 * ("5000rs advance plz", "Plz send 2000/- madam"). The hub keeps one log per person per month so the owner can do
 * the salary without scrolling chats:
 *   - attendance: found by itself every minute from today's messages (the word or a "Gm" greeting, or — for staff
 *     who never write it, like the night desk — any message that day). A day the owner/AI marked leave or absent
 *     is never overwritten.
 *   - advances: the AI records what was asked (with the message id), the owner records what was paid, and what
 *     was taken back from the salary. Balance = paid − recovered.
 * Staff list in config key 'staff'; entries in table staff_log.
 */
import config from './config.js';
import { query } from './db.js';
import { localDate } from './util.js';
import { toJid } from './store.js';

export const DAY_KINDS = ['present', 'half_day', 'leave', 'absent'];
export const MONEY_KINDS = ['advance_asked', 'advance_paid', 'recovered'];
export const KINDS = [...DAY_KINDS, ...MONEY_KINDS];
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'staff';
const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

export function normalizeStaff(s = {}) {
  const phone = String(s.phone || '').replace(/\D/g, '');
  if (phone.length < 10) throw new Error(`Staff "${s.name || '?'}": give the phone number`);
  if (!String(s.name || '').trim()) throw new Error(`Staff +${phone}: give the name`);
  const attendance = s.attendance === 'any' ? 'any' : 'word';
  return {
    id: s.id || slug(s.name),
    name: String(s.name).trim().slice(0, 60),
    phone: toJid(phone).split('@')[0],
    role: String(s.role || '').trim().slice(0, 60),
    salary: Math.max(0, parseInt(s.salary, 10) || 0),
    attendance,
    active: s.active !== false,
  };
}

export async function getStaff() {
  const [r] = await query(`SELECT value FROM config WHERE key = 'staff'`).catch(() => []);
  return (r?.value?.items || []).map((s) => { try { return normalizeStaff(s); } catch { return null; } }).filter(Boolean);
}

export async function setStaff(items) {
  const list = (Array.isArray(items) ? items : []).map(normalizeStaff);
  const ids = new Set();
  for (const s of list) {
    while (ids.has(s.id)) s.id += '-2';
    ids.add(s.id);
  }
  await query(
    `INSERT INTO config (key, value) VALUES ('staff', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ items: list })],
  );
  return list;
}

export async function findStaff(who) {
  const w = String(who || '').toLowerCase().trim();
  const digits = w.replace(/\D/g, '');
  const all = await getStaff();
  return all.find((s) => s.id === w || s.name.toLowerCase() === w)
    || (digits.length >= 10 && all.find((s) => s.phone.endsWith(digits.slice(-10))))
    || all.find((s) => s.name.toLowerCase().startsWith(w))
    || null;
}

/** Edit distance (short words only). */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/**
 * "I'm here" as staff really write it: present / perseant / prseant / presant, or a morning greeting
 * ("Gm mam", "good morning"). Only ever checked on staff chats, so "at present" from strangers doesn't matter.
 */
export function saysPresent(text) {
  const t = String(text || '').toLowerCase();
  if (/(^|[^a-z])(gm|gud ?mrng|gd ?mrng|good ?morning|good ?mrng)([^a-z]|$)/.test(t)) return true;
  return t.split(/[^a-z]+/).some((w) => w.startsWith('p') && w.length >= 6 && w.length <= 9 && distance(w, 'present') <= 3 && /s/.test(w) && /n[td]$/.test(w));
}

/** Record one entry. Day kinds replace that day's attendance; money kinds need an amount. */
export async function record({ staff, day, kind, amount = null, note = '', msgRef = null, by = 'you' }) {
  const s = typeof staff === 'object' && staff?.id ? staff : await findStaff(staff);
  if (!s) throw new Error(`No staff member "${staff}" — add them first (Settings → Staff)`);
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of: ${KINDS.join(', ')}`);
  const d = String(day || today()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('day must be YYYY-MM-DD');
  const amt = amount === null || amount === undefined || amount === '' ? null : Math.round(Number(amount));
  if (MONEY_KINDS.includes(kind) && !(amt > 0)) throw new Error(`${kind} needs an amount in rupees`);
  if (DAY_KINDS.includes(kind)) {
    await query(`DELETE FROM staff_log WHERE staff_id = $1 AND day = $2 AND kind = ANY($3::text[])`, [s.id, d, DAY_KINDS]);
  } else if (msgRef) {
    const [dup] = await query(`SELECT id FROM staff_log WHERE staff_id = $1 AND kind = $2 AND msg_ref = $3`, [s.id, kind, msgRef]);
    if (dup) return { id: dup.id, duplicate: true, staff: s };
  }
  const [row] = await query(
    `INSERT INTO staff_log (staff_id, day, kind, amount, note, msg_ref, by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [s.id, d, kind, DAY_KINDS.includes(kind) ? null : amt, String(note || '').slice(0, 300), msgRef, by],
  );
  if (kind === 'advance_paid' || kind === 'advance_asked') await syncAdvanceCards();
  return { id: row.id, staff: s };
}

export async function removeEntry(id) {
  const rows = await query(`DELETE FROM staff_log WHERE id = $1 RETURNING id`, [id]);
  if (rows.length) await syncAdvanceCards();
  return rows.length;
}

/**
 * Every minute: mark today's attendance from messages (any hub number). Never replaces a day already recorded
 * (a "leave" the owner entered stays leave even if he writes "Gm").
 */
export async function scanAttendance(now = new Date()) {
  const staff = (await getStaff()).filter((s) => s.active);
  if (!staff.length) return 0;
  const day = today(now);
  const start = Math.floor(localDate(`${day} 00:00`).getTime() / 1000);
  const done = new Set((await query(`SELECT staff_id FROM staff_log WHERE day = $1 AND kind = ANY($2::text[])`, [day, DAY_KINDS])).map((r) => r.staff_id));
  let marked = 0;
  for (const s of staff) {
    if (done.has(s.id)) continue;
    const msgs = await query(
      `SELECT account_id, id, ts, body FROM messages WHERE chat_jid = $1 AND NOT from_me AND ts >= $2 AND ts <= $3 ORDER BY ts`,
      [`${s.phone}@s.whatsapp.net`, start, Math.floor(now.getTime() / 1000)],
    );
    const hit = s.attendance === 'any' ? msgs[0] : msgs.find((m) => saysPresent(m.body));
    if (!hit) continue;
    const at = new Date(Number(hit.ts) * 1000).toLocaleTimeString('en-IN', { timeZone: config.tz, hour: 'numeric', minute: '2-digit' });
    await query(
      `INSERT INTO staff_log (staff_id, day, kind, note, msg_ref, by) VALUES ($1, $2, 'present', $3, $4, 'auto')`,
      [s.id, day, s.attendance === 'any' ? `first message ${at}` : `"${String(hit.body).slice(0, 40)}" ${at}`, `${hit.account_id}:${hit.id}`],
    );
    marked++;
  }
  return marked;
}

/** Advance balance per person, all time: paid − recovered. */
async function balances() {
  const rows = await query(
    `SELECT staff_id, COALESCE(SUM(amount) FILTER (WHERE kind = 'advance_paid'), 0) AS paid,
            COALESCE(SUM(amount) FILTER (WHERE kind = 'recovered'), 0) AS recovered
     FROM staff_log GROUP BY staff_id`,
  );
  return new Map(rows.map((r) => [r.staff_id, { paid: Number(r.paid), recovered: Number(r.recovered), balance: Number(r.paid) - Number(r.recovered) }]));
}

/**
 * One owner card per advance request not yet answered ("Vijay asks ₹2,000 advance"): it closes by itself when a
 * payment is recorded for that person on or after the day asked.
 */
export async function syncAdvanceCards() {
  const { upsertRefTask, closeRefTasks } = await import('./tasks.js');
  const staff = new Map((await getStaff()).map((s) => [s.id, s]));
  const asks = await query(
    `SELECT a.id, a.staff_id, to_char(a.day, 'YYYY-MM-DD') AS day, a.amount, a.note,
            EXISTS (SELECT 1 FROM staff_log p WHERE p.staff_id = a.staff_id AND p.kind = 'advance_paid' AND p.day >= a.day) AS paid
     FROM staff_log a WHERE a.kind = 'advance_asked' AND a.day >= (now() AT TIME ZONE $1)::date - 30`,
    [config.tz],
  );
  const bal = await balances();
  for (const a of asks) {
    const ref = `advance:${a.id}`;
    if (a.paid) { await closeRefTasks([ref], 'done', 'payment recorded'); continue; }
    const s = staff.get(a.staff_id);
    if (!s) continue;
    const owed = bal.get(s.id)?.balance || 0;
    await upsertRefTask(ref, {
      account: await defaultAccount(), kind: 'todo', assignee: 'you',
      title: `${s.name} asks ${rupees(a.amount)} advance (${a.day})`,
      details: `${a.note || ''}\nAdvance already outstanding: ${rupees(owed)}${s.salary ? ` · salary ${rupees(s.salary)}/month` : ''}. When you pay, record it (Settings → Staff, or tell the AI) — this card then closes by itself.`.trim(),
    });
  }
}

async function defaultAccount() {
  const [a] = await query(`SELECT id FROM accounts ORDER BY is_default DESC, id LIMIT 1`).catch(() => []);
  return a?.id || 'default';
}

/** One month (YYYY-MM): per person days present/half/leave/absent, money in the month and the running balance. */
export async function monthSummary(month = today().slice(0, 7)) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('month must be YYYY-MM');
  const staff = await getStaff();
  const rows = await query(
    `SELECT id, staff_id, to_char(day, 'YYYY-MM-DD') AS day, kind, amount, note, msg_ref, by FROM staff_log
     WHERE to_char(day, 'YYYY-MM') = $1 ORDER BY day, id`,
    [month],
  );
  const bal = await balances();
  const people = staff.map((s) => {
    const mine = rows.filter((r) => r.staff_id === s.id);
    const count = (k) => mine.filter((r) => r.kind === k).length;
    const sum = (k) => mine.filter((r) => r.kind === k).reduce((n, r) => n + Number(r.amount || 0), 0);
    return {
      ...s, present: count('present'), half_day: count('half_day'), leave: count('leave'), absent: count('absent'),
      asked: sum('advance_asked'), paid: sum('advance_paid'), recovered: sum('recovered'),
      balance: bal.get(s.id)?.balance || 0,
      entries: mine,
    };
  });
  return { month, people };
}

export function summaryText(sum) {
  if (!sum.people.length) return 'No staff set up (Settings → Staff).';
  return [`Staff ${sum.month}:`, ...sum.people.map((p) =>
    `${p.name}${p.role ? ` (${p.role})` : ''}: present ${p.present}${p.half_day ? ` + ${p.half_day} half` : ''}${p.leave ? `, leave ${p.leave}` : ''}${p.absent ? `, absent ${p.absent}` : ''}`
    + ` · advances asked ${rupees(p.asked)}, paid ${rupees(p.paid)}, recovered ${rupees(p.recovered)} · outstanding ${rupees(p.balance)}${p.active ? '' : ' (inactive)'}`)].join('\n');
}

/** CSV of the month's entries (for a Google Sheet / payroll). */
export function toCsv(sum) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const names = new Map(sum.people.map((p) => [p.id, p.name]));
  const lines = [['date', 'staff', 'kind', 'amount', 'note', 'by'].join(',')];
  for (const p of sum.people) for (const e of p.entries) lines.push([e.day, names.get(e.staff_id), e.kind, e.amount ?? '', e.note, e.by].map(esc).join(','));
  return lines.join('\n') + '\n';
}

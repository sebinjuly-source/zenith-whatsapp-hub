/**
 * The hub's contact book: people worth keeping, filed by WHY they matter — "Chef hiring – Referrers",
 * "Chef hiring – Referred", "Catering", "Travel agents", "Guests"… — not one long phone list.
 * Hub-wide (not per WhatsApp number), so a referrer met on Seema's number is found from any number.
 * A person can sit in several groups (e.g. a catering cook who also referred a chef): one row per group.
 * The AI looks here first whenever a need comes up (find_contacts), and saves helpful people (save_contact).
 */
import { query } from './db.js';
import { toJid } from './store.js';
import config from './config.js';

export const SUGGESTED_GROUPS = [
  'Chef hiring – Referrers', 'Chef hiring – Referred', 'Front office hiring – Referrers', 'Front office hiring – Referred',
  'Housekeeping hiring – Referrers', 'Housekeeping hiring – Referred', 'Placement agents', 'Catering', 'Vendors & services',
  'Travel agents', 'Corporate clients', 'Guests',
];

const clean = (s, n = 300) => (s == null ? null : String(s).trim().slice(0, n) || null);

/** Save (or update) a person in a group. Merges tags; a new reason or note is added to the old one, not lost. */
export async function saveEntry({ phone, name, category, reason, notes, tags = [], account = null, referredBy = null, createdBy = 'you' }) {
  const jid = toJid(phone);
  if (!clean(category)) throw new Error('Choose a group, e.g. "Chef hiring – Referrers" or "Catering"');
  const refJid = referredBy ? toJid(referredBy) : null;
  const [row] = await query(
    `INSERT INTO directory (jid, phone, name, category, reason, notes, tags, account_id, referred_by, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (jid, category) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, directory.name),
       reason = CASE WHEN EXCLUDED.reason IS NULL OR directory.reason LIKE '%' || EXCLUDED.reason || '%' THEN directory.reason
                     WHEN directory.reason IS NULL THEN EXCLUDED.reason ELSE directory.reason || ' · ' || EXCLUDED.reason END,
       notes = CASE WHEN EXCLUDED.notes IS NULL OR directory.notes LIKE '%' || EXCLUDED.notes || '%' THEN directory.notes
                    WHEN directory.notes IS NULL THEN EXCLUDED.notes ELSE directory.notes || ' · ' || EXCLUDED.notes END,
       tags = (SELECT COALESCE(array_agg(DISTINCT t ORDER BY t), '{}') FROM unnest(directory.tags || EXCLUDED.tags) t),
       account_id = COALESCE(directory.account_id, EXCLUDED.account_id),
       referred_by = COALESCE(EXCLUDED.referred_by, directory.referred_by),
       updated_at = now()
     RETURNING *`,
    [jid, jid.split('@')[0], clean(name, 100), clean(category, 80), clean(reason), clean(notes, 1000),
      (tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean), account, refJid, createdBy],
  );
  return row;
}

/**
 * Find people for a need: every word must appear somewhere (name, phone, group, reason, notes, tags, or the
 * referrer's name). "chef" finds chef referrers and referred chefs; "caterer" finds the catering group.
 */
export async function search({ q = '', category = '', limit = 100 } = {}) {
  const p = [];
  const where = [];
  if (category) {
    p.push(`%${category}%`);
    where.push(`d.category ILIKE $${p.length}`);
  }
  for (const w of String(q).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)) {
    const stem = w.replace(/(ers|er|s)$/, '').length >= 4 ? w.replace(/(ers|er|s)$/, '') : w; // caterer → cater, chefs → chef
    p.push(`%${stem}%`);
    where.push(`(d.name ILIKE $${p.length} OR d.phone ILIKE $${p.length} OR d.category ILIKE $${p.length} OR d.reason ILIKE $${p.length}
      OR d.notes ILIKE $${p.length} OR array_to_string(d.tags, ' ') ILIKE $${p.length} OR r.name ILIKE $${p.length})`);
  }
  p.push(Math.min(limit, 500));
  return query(
    `SELECT d.*, r.name AS referred_by_name,
       (SELECT array_agg(DISTINCT c.account_id) FROM chats c WHERE c.jid = d.jid) AS chat_accounts
     FROM directory d
     LEFT JOIN LATERAL (SELECT name FROM directory x WHERE x.jid = d.referred_by AND x.name IS NOT NULL LIMIT 1) r ON TRUE
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY d.category, lower(d.name) NULLS LAST, d.id
     LIMIT $${p.length}`,
    p,
  );
}

export async function groups() {
  return query(`SELECT category, count(*)::int AS n, max(updated_at) AS last FROM directory GROUP BY category ORDER BY category`);
}

export async function remove(id) {
  const [r] = await query('DELETE FROM directory WHERE id = $1 RETURNING id', [id]);
  if (!r) throw new Error('Not found');
  return r;
}

export async function update(id, { name, category, reason, notes, tags }) {
  const [r] = await query(
    `UPDATE directory SET name = COALESCE($2, name), category = COALESCE($3, category), reason = COALESCE($4, reason),
       notes = COALESCE($5, notes), tags = COALESCE($6, tags), updated_at = now() WHERE id = $1 RETURNING *`,
    [id, clean(name, 100), clean(category, 80), clean(reason), clean(notes, 1000), Array.isArray(tags) ? tags : null],
  );
  if (!r) throw new Error('Not found');
  return r;
}

/**
 * Someone sent a contact card (a referral): save the referred person and the referrer in the right groups
 * (from the sender's job role) and put "Call <name> – referred by <sender>" on the owner's Board.
 */
export async function noteSharedContacts(accountId, r) {
  if (!r?.vcards?.length || r.fromMe || String(r.chatJid).endsWith('@g.us')) return 0;
  const [m] = await query(
    `SELECT m.name, l.role FROM list_members m JOIN lists l ON l.id = m.list_id WHERE m.jid = $2
     ORDER BY (l.account_id = $1) DESC, l.id DESC LIMIT 1`,
    [accountId, r.chatJid],
  );
  const [ct] = await query(`SELECT COALESCE(saved_name, name, notify) AS name FROM contacts WHERE account_id = $1 AND jid = $2`, [accountId, r.chatJid]);
  const senderName = m?.name || ct?.name || r.senderName || r.chatJid.split('@')[0];
  const role = m?.role || null;
  const prefix = role ? `${role} hiring` : 'Referrals';
  const day = new Date((Number(r.ts) || Date.now() / 1000) * 1000).toLocaleDateString('en-IN', { timeZone: config.tz, day: 'numeric', month: 'short', year: 'numeric' });
  const { createTask } = await import('./tasks.js');
  let saved = 0;
  for (const v of r.vcards) {
    const phone = v.phones?.[0];
    if (!phone || phone.length < 10) continue;
    const name = v.name || phone;
    await saveEntry({ phone, name, category: `${prefix} – Referred`, reason: `Referred by ${senderName} (+${r.chatJid.split('@')[0]}) on ${day}`, account: accountId, referredBy: r.chatJid, createdBy: 'hub' });
    await saveEntry({ phone: r.chatJid, name: senderName, category: `${prefix} – Referrers`, reason: `Referred ${name} (+${phone}) on ${day}`, account: accountId, createdBy: 'hub' });
    await createTask({
      account: accountId, assignee: 'you', priority: true, createdBy: 'rule', role,
      title: `Call ${name} – referred by ${senderName}`,
      details: `${senderName} (+${r.chatJid.split('@')[0]}) shared this contact on ${day}: ${name} +${phone}. Saved in Contacts → "${prefix} – Referred". Call them, or tell the AI to message them from the Meta number.`,
    });
    saved++;
  }
  return saved;
}

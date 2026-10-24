/**
 * Saved message templates ("canned responses"): reusable texts with {fields}, e.g.
 *   "Hi {first_name}, we have a {role} opening at Zenith Suites. Interested?"
 * A template can belong to one number or to all numbers (account_id NULL), and may carry a file.
 * Built-in fields filled from the contact: {name}, {first_name}, {phone}. Anything else comes from the caller.
 */
import { query } from './db.js';

/** role: a campaign → its own templates plus the shared ones (role NULL); omitted = all. */
export async function listTemplates(accountId, { role } = {}) {
  return query(
    `SELECT * FROM templates WHERE (account_id IS NULL OR account_id = $1 OR $1::text IS NULL)
       AND ($2::text IS NULL OR role IS NULL OR lower(role) = lower($2))
     ORDER BY lower(name)`,
    [accountId || null, role || null],
  );
}

/** Find by id or name; a number's own template wins over a shared one with the same name. */
export async function getTemplate(accountId, idOrName) {
  if (idOrName == null || idOrName === '') return null;
  const asId = /^\d+$/.test(String(idOrName)) ? Number(idOrName) : -1;
  const [t] = await query(
    `SELECT * FROM templates WHERE (id = $2 OR lower(name) = lower($3)) AND (account_id IS NULL OR account_id = $1)
     ORDER BY (account_id IS NULL) LIMIT 1`,
    [accountId || null, asId, String(idOrName)],
  );
  return t || null;
}

export async function saveTemplate({ id, account, name, body, attachment, role }) {
  if (!name?.trim()) throw new Error('A template needs a name');
  if (!body?.trim() && !attachment?.url) throw new Error('A template needs text or a file');
  if (id) {
    const [t] = await query(
      `UPDATE templates SET name = $2, body = $3, attachment = $4, account_id = $5, role = COALESCE($6, role), updated_at = now() WHERE id = $1 RETURNING *`,
      [id, name.trim(), body || '', attachment ? JSON.stringify(attachment) : null, account || null, role || null],
    );
    if (!t) throw new Error('Template not found');
    return t;
  }
  const [t] = await query(
    `INSERT INTO templates (account_id, name, body, attachment, role) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [account || null, name.trim(), body || '', attachment ? JSON.stringify(attachment) : null, role || null],
  );
  return t;
}

export async function deleteTemplate(id) {
  const [t] = await query('DELETE FROM templates WHERE id = $1 RETURNING *', [id]);
  if (!t) throw new Error('Template not found');
  return t;
}

/** Fields known about a contact on a number: {name}, {first_name}, {phone}. */
export async function contactFields(accountId, jid) {
  // the saved contact name first, then the name on their list or chat (new candidates often have only those)
  const [c] = await query(
    `SELECT COALESCE(NULLIF(ct.name, ''), NULLIF(ct.notify, ''), ct.verified_name,
              (SELECT NULLIF(m.name, '') FROM list_members m JOIN lists l ON l.id = m.list_id WHERE m.jid = $2 ORDER BY (l.account_id = $1) DESC, l.id DESC LIMIT 1),
              (SELECT NULLIF(ch.name, '') FROM chats ch WHERE ch.account_id = $1 AND ch.jid = $2)) AS name,
            COALESCE(ct.phone, split_part($2, '@', 1)) AS phone
     FROM (SELECT 1) x LEFT JOIN contacts ct ON ct.account_id = $1 AND ct.jid = $2`,
    [accountId, jid],
  );
  const name = (c?.name || '').trim();
  return { name, first_name: name.split(/\s+/)[0] || '', phone: c?.phone || jid.split('@')[0] };
}

/** Which {fields} a text uses (to tell the caller what's still missing). */
export function fieldsIn(text) {
  return [...new Set([...String(text || '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]))];
}

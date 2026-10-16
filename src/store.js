/**
 * All reads/writes of chats, contacts and messages.
 * Chats are keyed by phone-number JIDs (…@s.whatsapp.net) whenever the number is known;
 * WhatsApp's privacy IDs (…@lid) are mapped back to numbers via lid_map and merged later if needed.
 */
import { jidNormalizedUser, isLidUser, isJidGroup } from '@whiskeysockets/baileys';
import { query, insertMany } from './db.js';

export const phoneOf = (jid) => (jid && jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null);

export function toJid(phoneOrJid) {
  const s = String(phoneOrJid).trim();
  if (s.includes('@')) return jidNormalizedUser(s);
  let digits = s.replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits; // bare Indian mobile number
  if (digits.length === 11 && digits.startsWith('0')) digits = '91' + digits.slice(1);
  return `${digits}@s.whatsapp.net`;
}

// ---------------------------------------------------------------------------
// LID ↔ phone mapping
// ---------------------------------------------------------------------------
const lidCache = new Map(); // `${account}|${lid}` -> pn jid

export async function lookupLid(accountId, lid) {
  const k = `${accountId}|${lid}`;
  if (lidCache.has(k)) return lidCache.get(k);
  const rows = await query('SELECT pn FROM lid_map WHERE account_id = $1 AND lid = $2', [accountId, lid]);
  const pn = rows[0]?.pn || null;
  if (pn) lidCache.set(k, pn);
  return pn;
}

/** mappings: [{ lid, pn }] (any jid format). Saves them and merges anything stored under the lid. */
export async function saveLidMappings(accountId, mappings) {
  const clean = [];
  const seen = new Set();
  for (const m of mappings || []) {
    if (!m?.lid || !m?.pn) continue;
    const lid = jidNormalizedUser(m.lid.includes('@') ? m.lid : `${m.lid}@lid`);
    const pn = jidNormalizedUser(m.pn.includes('@') ? m.pn : `${m.pn}@s.whatsapp.net`);
    if (!isLidUser(lid) || seen.has(lid)) continue;
    seen.add(lid);
    const k = `${accountId}|${lid}`;
    if (lidCache.get(k) === pn) continue;
    lidCache.set(k, pn);
    clean.push([accountId, lid, pn]);
  }
  if (!clean.length) return;
  await insertMany('lid_map', ['account_id', 'lid', 'pn'], clean,
    'ON CONFLICT (account_id, lid) DO UPDATE SET pn = EXCLUDED.pn');
  // Merge chats/messages/contacts that were stored under a lid before we knew the number.
  const lids = clean.map((c) => c[1]);
  const stray = await query('SELECT jid FROM chats WHERE account_id = $1 AND jid = ANY($2)', [accountId, lids]);
  const strayContacts = await query('SELECT jid FROM contacts WHERE account_id = $1 AND jid = ANY($2)', [accountId, lids]);
  const toMerge = new Set([...stray.map((r) => r.jid), ...strayContacts.map((r) => r.jid)]);
  for (const lid of toMerge) {
    await mergeLidInto(accountId, lid, lidCache.get(`${accountId}|${lid}`));
  }
  await query(
    `UPDATE messages m SET sender_jid = l.pn FROM lid_map l
     WHERE m.account_id = $1 AND l.account_id = $1 AND m.sender_jid = l.lid AND l.lid = ANY($2)`,
    [accountId, lids],
  );
}

async function mergeLidInto(accountId, lid, pn) {
  if (!pn) return;
  await query(
    `INSERT INTO messages SELECT account_id, $3::text, id, from_me, sender_jid, sender_name, ts, type, body, quoted_id,
       quoted_body, forwarded, media, media_saved, vcards, reactions, status, edited, deleted, from_history
     FROM messages WHERE account_id = $1 AND chat_jid = $2 ON CONFLICT DO NOTHING`,
    [accountId, lid, pn],
  );
  await query('DELETE FROM messages WHERE account_id = $1 AND chat_jid = $2', [accountId, lid]);
  await query(
    `INSERT INTO chats (account_id, jid, name, is_group, unread, archived, last_ts, last_preview, last_from_me)
     SELECT account_id, $3::text, name, is_group, unread, archived, last_ts, last_preview, last_from_me
     FROM chats WHERE account_id = $1 AND jid = $2
     ON CONFLICT (account_id, jid) DO UPDATE SET
       name = COALESCE(chats.name, EXCLUDED.name),
       unread = GREATEST(chats.unread, EXCLUDED.unread),
       last_ts = GREATEST(chats.last_ts, EXCLUDED.last_ts)`,
    [accountId, lid, pn],
  );
  await query('DELETE FROM chats WHERE account_id = $1 AND jid = $2', [accountId, lid]);
  await query(
    `INSERT INTO contacts (account_id, jid, phone, lid, name, notify, verified_name, is_business, is_blocked, tags,
       lead_status, notes, summary, reviewed_at)
     SELECT account_id, $3::text, $4::text, $2::text, name, notify, verified_name, is_business, is_blocked, tags, lead_status, notes,
       summary, reviewed_at FROM contacts WHERE account_id = $1 AND jid = $2
     ON CONFLICT (account_id, jid) DO UPDATE SET
       lid = EXCLUDED.lid,
       name = COALESCE(contacts.name, EXCLUDED.name),
       notify = COALESCE(contacts.notify, EXCLUDED.notify),
       is_blocked = contacts.is_blocked OR EXCLUDED.is_blocked,
       tags = (SELECT ARRAY(SELECT DISTINCT unnest(contacts.tags || EXCLUDED.tags))),
       notes = COALESCE(contacts.notes, EXCLUDED.notes),
       summary = COALESCE(contacts.summary, EXCLUDED.summary)`,
    [accountId, lid, pn, phoneOf(pn)],
  );
  await query('DELETE FROM contacts WHERE account_id = $1 AND jid = $2', [accountId, lid]);
  await refreshChatLast(accountId, pn);
}

/** Pick the best JID for a person: phone JID if we can find it, else the lid. */
export async function canonicalJid(accountId, jid, alt) {
  if (!jid) return null;
  const j = jidNormalizedUser(jid);
  if (!isLidUser(j)) return j;
  const a = alt ? jidNormalizedUser(alt) : null;
  if (a && a.endsWith('@s.whatsapp.net')) {
    await saveLidMappings(accountId, [{ lid: j, pn: a }]);
    return a;
  }
  return (await lookupLid(accountId, j)) || j;
}

// ---------------------------------------------------------------------------
// Contacts & chats
// ---------------------------------------------------------------------------
/** contacts: [{ jid, lid, name, notify, verifiedName }] — jid already canonical. */
export async function upsertContacts(accountId, contacts) {
  const byJid = new Map();
  for (const c of contacts) {
    if (!c.jid || isJidGroup(c.jid) || c.jid.endsWith('@broadcast') || c.jid.endsWith('@newsletter')) continue;
    const prev = byJid.get(c.jid) || {};
    byJid.set(c.jid, {
      jid: c.jid,
      lid: c.lid || prev.lid || null,
      name: c.name || prev.name || null,
      notify: c.notify || prev.notify || null,
      verifiedName: c.verifiedName || prev.verifiedName || null,
    });
  }
  const rows = [...byJid.values()].map((c) => [
    accountId, c.jid, phoneOf(c.jid), c.lid, c.name, c.notify, c.verifiedName, !!c.verifiedName,
  ]);
  if (!rows.length) return;
  await insertMany(
    'contacts',
    ['account_id', 'jid', 'phone', 'lid', 'name', 'notify', 'verified_name', 'is_business'],
    rows,
    `ON CONFLICT (account_id, jid) DO UPDATE SET
       lid = COALESCE(EXCLUDED.lid, contacts.lid),
       name = COALESCE(EXCLUDED.name, contacts.name),
       notify = COALESCE(EXCLUDED.notify, contacts.notify),
       verified_name = COALESCE(EXCLUDED.verified_name, contacts.verified_name),
       is_business = contacts.is_business OR EXCLUDED.is_business,
       updated_at = now()`,
  );
}

/** chats: [{ jid, name, isGroup, unread, archived, lastTs, participants }] */
export async function upsertChats(accountId, chats) {
  const byJid = new Map();
  for (const c of chats) if (c.jid) byJid.set(c.jid, { ...byJid.get(c.jid), ...c });
  const rows = [...byJid.values()].map((c) => [
    accountId, c.jid, c.name || null, !!c.isGroup, c.unread ?? 0, !!c.archived, c.lastTs || null, c.participants ?? null,
  ]);
  if (!rows.length) return;
  await insertMany(
    'chats',
    ['account_id', 'jid', 'name', 'is_group', 'unread', 'archived', 'last_ts', 'participants'],
    rows,
    `ON CONFLICT (account_id, jid) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, chats.name),
       is_group = chats.is_group OR EXCLUDED.is_group,
       unread = EXCLUDED.unread,
       archived = EXCLUDED.archived,
       last_ts = GREATEST(chats.last_ts, EXCLUDED.last_ts),
       participants = COALESCE(EXCLUDED.participants, chats.participants),
       updated_at = now()`,
  );
}

export async function setBlocked(accountId, jids, blocked) {
  for (const raw of jids) {
    if (!raw) continue;
    const jid = await canonicalJid(accountId, raw);
    await query(
      `INSERT INTO contacts (account_id, jid, phone, is_blocked) VALUES ($1,$2,$3,$4)
       ON CONFLICT (account_id, jid) DO UPDATE SET is_blocked = EXCLUDED.is_blocked, updated_at = now()`,
      [accountId, jid, phoneOf(jid), blocked],
    );
  }
}

export async function resetBlocklist(accountId, jids) {
  await query('UPDATE contacts SET is_blocked = FALSE WHERE account_id = $1 AND is_blocked', [accountId]);
  await setBlocked(accountId, jids, true);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
/** rows: parsed message rows plus { chatJid, senderJid, senderName, fromHistory } */
export async function insertMessages(accountId, rows) {
  if (!rows.length) return;
  const dedup = new Map();
  for (const r of rows) dedup.set(`${r.chatJid}|${r.id}`, r);
  const list = [...dedup.values()];
  await insertMany(
    'messages',
    ['account_id', 'chat_jid', 'id', 'from_me', 'sender_jid', 'sender_name', 'ts', 'type', 'body', 'quoted_id',
      'quoted_body', 'forwarded', 'media', 'vcards', 'status', 'from_history'],
    list.map((r) => [
      accountId, r.chatJid, r.id, r.fromMe, r.senderJid || null, r.senderName || null, r.ts, r.type, r.body,
      r.quotedId, r.quotedBody, r.forwarded, r.media ? JSON.stringify(r.media) : null,
      r.vcards ? JSON.stringify(r.vcards) : null, r.status, !!r.fromHistory,
    ]),
    `ON CONFLICT (account_id, chat_jid, id) DO UPDATE SET
       body = COALESCE(EXCLUDED.body, messages.body),
       media = COALESCE(EXCLUDED.media, messages.media),
       status = GREATEST(messages.status, EXCLUDED.status)`,
  );
  // Update the chat list preview for each touched chat.
  const latest = new Map();
  for (const r of list) {
    const cur = latest.get(r.chatJid);
    if (!cur || r.ts >= cur.ts) latest.set(r.chatJid, r);
  }
  for (const r of latest.values()) {
    await query(
      `INSERT INTO chats (account_id, jid, is_group, last_ts, last_preview, last_from_me)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (account_id, jid) DO UPDATE SET
         last_preview = CASE WHEN chats.last_ts IS NULL OR EXCLUDED.last_ts >= chats.last_ts
                             THEN EXCLUDED.last_preview ELSE chats.last_preview END,
         last_from_me = CASE WHEN chats.last_ts IS NULL OR EXCLUDED.last_ts >= chats.last_ts
                             THEN EXCLUDED.last_from_me ELSE chats.last_from_me END,
         last_ts = GREATEST(chats.last_ts, EXCLUDED.last_ts),
         updated_at = now()`,
      [accountId, r.chatJid, isJidGroup(r.chatJid) || false, r.ts, preview(r), r.fromMe],
    );
  }
}

const preview = (r) => (r.body ? r.body.slice(0, 120) : `[${r.type}]`);

async function refreshChatLast(accountId, chatJid) {
  await query(
    `UPDATE chats c SET last_ts = m.ts, last_preview = COALESCE(left(m.body, 120), '[' || m.type || ']'),
       last_from_me = m.from_me
     FROM (SELECT ts, body, type, from_me FROM messages WHERE account_id = $1 AND chat_jid = $2
           ORDER BY ts DESC LIMIT 1) m
     WHERE c.account_id = $1 AND c.jid = $2`,
    [accountId, chatJid],
  );
}

export async function applyEdit(accountId, id, body) {
  await query('UPDATE messages SET body = $3, edited = TRUE WHERE account_id = $1 AND id = $2', [accountId, id, body]);
}

export async function applyRevoke(accountId, id) {
  await query('UPDATE messages SET deleted = TRUE WHERE account_id = $1 AND id = $2', [accountId, id]);
}

export async function applyReaction(accountId, id, from, emoji) {
  const rows = await query('SELECT chat_jid, reactions FROM messages WHERE account_id = $1 AND id = $2 LIMIT 1', [
    accountId, id,
  ]);
  if (!rows[0]) return;
  const reactions = rows[0].reactions || {};
  if (emoji) reactions[from] = emoji;
  else delete reactions[from];
  await query('UPDATE messages SET reactions = $3 WHERE account_id = $1 AND id = $2', [
    accountId, id, JSON.stringify(reactions),
  ]);
}

export async function updateStatus(accountId, id, status) {
  await query(
    'UPDATE messages SET status = GREATEST(COALESCE(status, 0), $3) WHERE account_id = $1 AND id = $2',
    [accountId, id, status],
  );
}

export async function hasChattedWith(accountId, jid) {
  const rows = await query(
    'SELECT 1 FROM messages WHERE account_id = $1 AND chat_jid = $2 AND from_me LIMIT 1',
    [accountId, jid],
  );
  if (rows.length) return true;
  const c = await query('SELECT name FROM contacts WHERE account_id = $1 AND jid = $2', [accountId, jid]);
  return !!c[0]?.name; // saved in your phone's address book
}

// ---------------------------------------------------------------------------
// Reads (dashboard, REST, MCP) — compact by design
// ---------------------------------------------------------------------------
const DISPLAY = `COALESCE(NULLIF(ch.name, ''), ct.name, ct.notify, ct.verified_name, ct.phone, ch.jid)`;

export async function listChats(accountId, { q, kind, tag, limit = 30, offset = 0, waitingOnMe, sinceTs, beforeTs } = {}) {
  const where = ['ch.account_id = $1'];
  const p = [accountId];
  if (q) {
    p.push(`%${q}%`);
    where.push(`(${DISPLAY} ILIKE $${p.length} OR ch.jid ILIKE $${p.length})`);
  }
  if (kind === 'group') where.push('ch.is_group');
  if (kind === 'direct') where.push('NOT ch.is_group');
  if (tag) {
    p.push(tag);
    where.push(`$${p.length} = ANY(ct.tags)`);
  }
  if (waitingOnMe) where.push('ch.last_from_me = FALSE');
  if (sinceTs) {
    p.push(sinceTs);
    where.push(`ch.last_ts >= $${p.length}`);
  }
  if (beforeTs) {
    p.push(beforeTs);
    where.push(`ch.last_ts < $${p.length}`);
  }
  p.push(Math.min(limit, 200), offset);
  return query(
    `SELECT ch.jid, ${DISPLAY} AS name, ch.is_group, ch.unread, ch.last_ts, ch.last_preview, ch.last_from_me,
            ch.participants, ct.phone, ct.tags, ct.lead_status, ct.summary, ct.is_blocked, ct.is_business
     FROM chats ch LEFT JOIN contacts ct ON ct.account_id = ch.account_id AND ct.jid = ch.jid
     WHERE ${where.join(' AND ')}
     ORDER BY ch.last_ts DESC NULLS LAST LIMIT $${p.length - 1} OFFSET $${p.length}`,
    p,
  );
}

export async function getMessages(accountId, chatJid, { limit = 30, beforeTs, afterTs } = {}) {
  const p = [accountId, chatJid];
  const where = ['account_id = $1', 'chat_jid = $2'];
  if (beforeTs) {
    p.push(beforeTs);
    where.push(`ts < $${p.length}`);
  }
  if (afterTs) {
    p.push(afterTs);
    where.push(`ts > $${p.length}`);
  }
  p.push(Math.min(limit, 500));
  const rows = await query(
    `SELECT id, from_me, sender_jid, sender_name, ts, type, body, quoted_body, forwarded, vcards, reactions, status,
            edited, deleted, media_saved, (media IS NOT NULL) AS has_media, media->>'fileName' AS file_name,
            media->>'mimetype' AS mimetype
     FROM messages WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT $${p.length}`,
    p,
  );
  return rows.reverse();
}

export async function searchMessages(accountId, text, { chatJid, fromMe, sinceTs, untilTs, type, limit = 30 } = {}) {
  const p = [];
  const where = [];
  if (accountId) {
    p.push(accountId);
    where.push(`m.account_id = $${p.length}`);
  }
  if (text) {
    p.push(text);
    // full-text match OR plain substring (catches numbers, partial words)
    where.push(`(to_tsvector('simple', coalesce(m.body, '')) @@ websearch_to_tsquery('simple', $${p.length})
                 OR m.body ILIKE '%' || $${p.length} || '%')`);
  }
  if (chatJid) {
    p.push(chatJid);
    where.push(`m.chat_jid = $${p.length}`);
  }
  if (typeof fromMe === 'boolean') {
    p.push(fromMe);
    where.push(`m.from_me = $${p.length}`);
  }
  if (sinceTs) {
    p.push(sinceTs);
    where.push(`m.ts >= $${p.length}`);
  }
  if (untilTs) {
    p.push(untilTs);
    where.push(`m.ts < $${p.length}`);
  }
  if (type) {
    p.push(type);
    where.push(`m.type = $${p.length}`);
  }
  p.push(Math.min(limit, 200));
  return query(
    `SELECT m.account_id, m.chat_jid, ${DISPLAY} AS chat_name, m.id, m.from_me, m.sender_name, m.ts, m.type,
            left(m.body, 400) AS body, m.vcards
     FROM messages m
     LEFT JOIN chats ch ON ch.account_id = m.account_id AND ch.jid = m.chat_jid
     LEFT JOIN contacts ct ON ct.account_id = m.account_id AND ct.jid = m.chat_jid
     WHERE ${where.length ? where.join(' AND ') : 'TRUE'}
     ORDER BY m.ts DESC LIMIT $${p.length}`,
    p,
  );
}

export async function getContact(accountId, jid) {
  const rows = await query(
    `SELECT ct.*, ch.name AS chat_name, ch.last_ts, ch.last_from_me,
       (SELECT count(*) FROM messages m WHERE m.account_id = $1 AND m.chat_jid = $2)::int AS message_count,
       (SELECT min(ts) FROM messages m WHERE m.account_id = $1 AND m.chat_jid = $2) AS first_ts
     FROM contacts ct LEFT JOIN chats ch ON ch.account_id = ct.account_id AND ch.jid = ct.jid
     WHERE ct.account_id = $1 AND ct.jid = $2`,
    [accountId, jid],
  );
  return rows[0] || null;
}

export async function updateContact(accountId, jid, { addTags, removeTags, leadStatus, notes, summary, markReviewed }) {
  await query(
    `INSERT INTO contacts (account_id, jid, phone) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [accountId, jid, phoneOf(jid)],
  );
  const sets = ['updated_at = now()'];
  const p = [accountId, jid];
  if (addTags?.length) {
    p.push(addTags);
    sets.push(`tags = (SELECT ARRAY(SELECT DISTINCT unnest(tags || $${p.length}::text[])))`);
  }
  if (removeTags?.length) {
    p.push(removeTags);
    sets.push(`tags = (SELECT ARRAY(SELECT t FROM unnest(tags) t WHERE t <> ALL($${p.length}::text[])))`);
  }
  if (leadStatus !== undefined) {
    p.push(leadStatus || null);
    sets.push(`lead_status = $${p.length}`);
  }
  if (notes !== undefined) {
    p.push(notes || null);
    sets.push(`notes = $${p.length}`);
  }
  if (summary !== undefined) {
    p.push(summary || null);
    sets.push(`summary = $${p.length}`);
  }
  if (markReviewed) sets.push('reviewed_at = now()');
  await query(`UPDATE contacts SET ${sets.join(', ')} WHERE account_id = $1 AND jid = $2`, p);
  return getContact(accountId, jid);
}

export async function accountStats(accountId) {
  const rows = await query(
    `SELECT
       (SELECT count(*) FROM chats WHERE account_id = $1)::int AS chats,
       (SELECT count(*) FROM chats WHERE account_id = $1 AND is_group)::int AS groups,
       (SELECT count(*) FROM contacts WHERE account_id = $1)::int AS contacts,
       (SELECT count(*) FROM messages WHERE account_id = $1)::int AS messages,
       (SELECT min(ts) FROM messages WHERE account_id = $1) AS oldest_ts`,
    [accountId],
  );
  return rows[0];
}

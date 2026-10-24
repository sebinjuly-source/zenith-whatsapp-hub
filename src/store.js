/**
 * All reads/writes of chats, contacts and messages.
 * Chats are keyed by phone-number JIDs (…@s.whatsapp.net) whenever the number is known;
 * WhatsApp's privacy IDs (…@lid) are mapped back to numbers via lid_map and merged later if needed.
 */
import { jidNormalizedUser, isLidUser, isJidGroup } from '@whiskeysockets/baileys';
import { personInSql } from './scope.js';
import { query, insertMany } from './db.js';
import { roleOf, roleFilter } from './campaign.js';
import config from './config.js';

export const phoneOf = (jid) => (jid && jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null);

export function toJid(phoneOrJid) {
  const s = String(phoneOrJid).trim();
  if (s.includes('@')) return jidNormalizedUser(s);
  let digits = s.replace(/\D/g, '');
  // a bare local number (or one with a leading 0) gets the owner's country code (COUNTRY_CODE, default 91)
  if (digits.length === config.localLen) digits = config.countryCode + digits;
  else if (digits.length === config.localLen + 1 && digits.startsWith('0')) digits = config.countryCode + digits.slice(1);
  return `${digits}@s.whatsapp.net`;
}

// ---------------------------------------------------------------------------
// LID ↔ phone mapping
// ---------------------------------------------------------------------------
const lidCache = new Map(); // `${account}|${lid}` -> pn jid
const warmAccounts = new Set(); // accounts whose whole lid_map is in lidCache

/** Load every known mapping once, so lookups during a big history sync never hit the network. */
export async function warmLidCache(accountId) {
  const rows = await query('SELECT lid, pn FROM lid_map WHERE account_id = $1', [accountId]);
  for (const r of rows) lidCache.set(`${accountId}|${r.lid}`, r.pn);
  warmAccounts.add(accountId);
}

export async function lookupLid(accountId, lid) {
  const k = `${accountId}|${lid}`;
  if (lidCache.has(k)) return lidCache.get(k);
  if (warmAccounts.has(accountId)) return null; // cache is complete: every write goes through saveLidMappings
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
       name = COALESCE(contacts.saved_name, EXCLUDED.name, contacts.name), -- a name you saved is kept
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
       name = COALESCE((SELECT c.saved_name FROM contacts c WHERE c.account_id = chats.account_id AND c.jid = chats.jid), EXCLUDED.name, chats.name),
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
  // Update the chat list preview for each touched chat (one statement per batch).
  const latest = new Map();
  for (const r of list) {
    const cur = latest.get(r.chatJid);
    if (!cur || r.ts >= cur.ts) latest.set(r.chatJid, r);
  }
  await insertMany(
    'chats',
    ['account_id', 'jid', 'is_group', 'last_ts', 'last_preview', 'last_from_me'],
    [...latest.values()].map((r) => [accountId, r.chatJid, !!isJidGroup(r.chatJid), r.ts, preview(r), r.fromMe]),
    `ON CONFLICT (account_id, jid) DO UPDATE SET
       last_preview = CASE WHEN chats.last_ts IS NULL OR EXCLUDED.last_ts >= chats.last_ts
                           THEN EXCLUDED.last_preview ELSE chats.last_preview END,
       last_from_me = CASE WHEN chats.last_ts IS NULL OR EXCLUDED.last_ts >= chats.last_ts
                           THEN EXCLUDED.last_from_me ELSE chats.last_from_me END,
       last_ts = GREATEST(chats.last_ts, EXCLUDED.last_ts),
       updated_at = now()`,
  );
  await afterInsert(accountId, list);
}

const preview = (r) => (r.body ? r.body.slice(0, 120) : `[${r.type}]`);

/** After storing messages: anything we sent (live, not history) answers that chat's "Reply to …" board card. */
async function afterInsert(accountId, list) {
  const answered = list.filter((r) => r.fromMe && !r.fromHistory).map((r) => r.chatJid);
  if (!answered.length) return;
  const { noteSent } = await import('./board.js');
  await noteSent(accountId, answered).catch(() => {});
}

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

/** Set a chat's state: 'open' | 'snoozed' (needs until) | 'done'. */
export async function setChatState(accountId, jid, state, { until, note } = {}) {
  if (!['open', 'snoozed', 'done'].includes(state)) throw new Error('State must be open, snoozed or done');
  if (state === 'snoozed' && !until) throw new Error('A reminder needs a date');
  const rows = await query(
    `UPDATE chats SET state = $3, snoozed_until = $4, snooze_note = $5, updated_at = now()
     WHERE account_id = $1 AND jid = $2 RETURNING jid, state, snoozed_until, snooze_note`,
    [accountId, jid, state, state === 'snoozed' ? until : null, state === 'snoozed' ? note || null : null],
  );
  if (!rows[0]) throw new Error('Chat not found');
  // A reminder date belongs on the board too (closes when the chat is reopened or done).
  const { syncReminder } = await import('./board.js');
  await syncReminder(accountId, jid, { state, until, note }).catch(() => {});
  return rows[0];
}

/** A new message from the other side brings a snoozed/done chat back to open (like Chatwoot). */
export async function reopenOnIncoming(accountId, jid) {
  await query(
    `UPDATE chats SET state = 'open', snoozed_until = NULL, snooze_note = NULL WHERE account_id = $1 AND jid = $2 AND state <> 'open'`,
    [accountId, jid],
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

export async function listChats(accountId, { q, kind, tag, limit = 30, offset = 0, waitingOnMe, sinceTs, beforeTs, state, role } = {}) {
  const where = ['ch.account_id = $1'];
  const p = [accountId];
  if (role) {
    p.push(role);
    where.push(roleFilter(roleOf('ch.account_id', 'ch.jid'), p.length));
  }
  // open = open, plus reminders whose date has come; snoozed = waiting for a date; due = reminder date reached
  if (state === 'open') where.push("(ch.state = 'open' OR (ch.state = 'snoozed' AND ch.snoozed_until <= now()))");
  if (state === 'snoozed') where.push("ch.state = 'snoozed' AND ch.snoozed_until > now()");
  if (state === 'due') where.push("ch.state = 'snoozed' AND ch.snoozed_until <= now()");
  if (state === 'done') where.push("ch.state = 'done'");
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
            ch.participants, ct.phone, ct.tags, ct.lead_status, ct.summary, ct.is_blocked, ct.is_business,
            ch.state, ch.snoozed_until, ch.snooze_note,
            (ch.state = 'snoozed' AND ch.snoozed_until <= now()) AS due,
            ${roleOf('ch.account_id', 'ch.jid')} AS campaign
     FROM chats ch LEFT JOIN contacts ct ON ct.account_id = ch.account_id AND ct.jid = ch.jid
     WHERE ${where.join(' AND ')}
     ORDER BY (ch.state = 'snoozed' AND ch.snoozed_until <= now()) DESC, ch.last_ts DESC NULLS LAST
     LIMIT $${p.length - 1} OFFSET $${p.length}`,
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
    `SELECT m.id, m.from_me, m.sender_jid,
            CASE WHEN m.from_me THEN 'me' ELSE COALESCE(ct.name, m.sender_name) END AS sender_name,
            m.ts, m.type, m.body, m.quoted_body, m.forwarded, m.vcards, m.reactions, m.status,
            m.edited, m.deleted, m.media_saved, (m.media IS NOT NULL) AS has_media, m.media->>'fileName' AS file_name,
            m.media->>'mimetype' AS mimetype
     FROM messages m LEFT JOIN contacts ct ON ct.account_id = m.account_id AND ct.jid = m.sender_jid
     WHERE ${where.map((w) => 'm.' + w).join(' AND ')} ORDER BY m.ts DESC LIMIT $${p.length}`,
    p,
  );
  return rows.reverse();
}

export async function searchMessages(accountId, text, { chatJid, fromMe, sinceTs, untilTs, type, limit = 30, campaign } = {}) {
  const p = [];
  const where = [];
  if (campaign) {
    p.push(campaign);
    where.push(personInSql('m.chat_jid', p.length));
  }
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

/**
 * People (one row per chat) whose messages — or whose name — mention any of the words. For campaigns and segments
 * ("old guests who mentioned company / GST / travels"): message search lists messages newest first and stops after
 * 100, so older people and people with many matching messages crowd out the rest. Words of 4+ letters also match
 * inside longer words (travel → travels, Youngtravels); shorter ones ("HR") must be whole words.
 * who: 'them' (they wrote it — what they want), 'me', or any. Returns { total, rows }.
 */
export async function searchPeople(accountId, text, { who, sinceTs, untilTs, peopleOnly = true, excludeCandidates = true, excludePhones = [], limit = 50, offset = 0, campaign } = {}) {
  const words = [...new Set(String(text || '').replace(/["()]/g, ' ').split(/[\s,]+/).filter((w) => w && !/^(or|and)$/i.test(w) && !w.startsWith('-')).map((w) => w.toLowerCase()))].slice(0, 20);
  if (!words.length) throw new Error('Give the words to look for, e.g. "company GST travels agency booking"');
  const p = [accountId];
  const add = (v) => { p.push(v); return `$${p.length}`; };
  const long = words.filter((w) => w.length >= 4);
  const short = words.filter((w) => w.length < 4);
  const bodyMatch = [
    long.length ? `m.body ILIKE ANY(${add(long.map((w) => `%${w}%`))}::text[])` : null,
    short.length ? `to_tsvector('simple', coalesce(m.body, '')) @@ to_tsquery('simple', ${add(short.map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).join(' | ') || 'zzzz')})` : null,
  ].filter(Boolean).join(' OR ');
  const where = ['m.account_id = $1', `(${bodyMatch})`];
  if (who === 'them') where.push('NOT m.from_me');
  if (who === 'me') where.push('m.from_me');
  if (sinceTs) where.push(`m.ts >= ${add(sinceTs)}`);
  if (untilTs) where.push(`m.ts < ${add(untilTs)}`);
  const chatScope = [
    peopleOnly ? `ch.jid NOT LIKE '%@g.us' AND ch.jid NOT LIKE '%broadcast%' AND ch.jid NOT LIKE '%@newsletter'` : 'TRUE',
    excludeCandidates ? 'NOT EXISTS (SELECT 1 FROM list_members lm WHERE lm.jid = ch.jid)' : 'TRUE',
    // never the owner's own hub numbers or alert phones (their chats mention everything)
    "split_part(ch.jid, '@', 1) NOT IN (SELECT phone FROM accounts WHERE phone IS NOT NULL)",
    "NOT ('own-number' = ANY(COALESCE(ct.tags, '{}')))",
    excludePhones.length ? `split_part(ch.jid, '@', 1) <> ALL(${add(excludePhones)}::text[])` : 'TRUE',
    campaign ? personInSql('ch.jid', (add(campaign), p.length)) : 'TRUE',
  ].join(' AND ');
  const namePattern = long.length ? add(long.map((w) => `%${w}%`)) : null;
  const sql = `
    WITH hits AS (
      SELECT m.chat_jid, count(*)::int AS n, max(m.ts) AS last_hit,
             (array_agg(left(regexp_replace(coalesce(m.body, ''), '\\s+', ' ', 'g'), 160) ORDER BY m.ts DESC))[1] AS sample,
             bool_or(NOT m.from_me) AS they_wrote
      FROM messages m WHERE ${where.join(' AND ')} GROUP BY m.chat_jid
    ), named AS (
      ${namePattern ? `SELECT ch.jid AS chat_jid FROM chats ch LEFT JOIN contacts ct ON ct.account_id = ch.account_id AND ct.jid = ch.jid
         WHERE ch.account_id = $1 AND (ch.name ILIKE ANY(${namePattern}::text[]) OR ct.name ILIKE ANY(${namePattern}::text[]) OR ct.notify ILIKE ANY(${namePattern}::text[]) OR ct.verified_name ILIKE ANY(${namePattern}::text[]))` : 'SELECT NULL::text AS chat_jid WHERE FALSE'}
    ), found AS (
      SELECT COALESCE(h.chat_jid, n.chat_jid) AS chat_jid, COALESCE(h.n, 0) AS n, h.last_hit, h.sample, h.they_wrote, (n.chat_jid IS NOT NULL) AS name_hit
      FROM hits h FULL JOIN named n ON n.chat_jid = h.chat_jid
    )
    SELECT f.*, ${DISPLAY} AS name, ch.last_ts, ch.last_from_me, ch.last_preview, ct.tags, ct.summary, ct.lead_status, count(*) OVER ()::int AS total
    FROM found f JOIN chats ch ON ch.account_id = $1 AND ch.jid = f.chat_jid
    LEFT JOIN contacts ct ON ct.account_id = ch.account_id AND ct.jid = ch.jid
    WHERE ${chatScope}
    ORDER BY COALESCE(f.last_hit, ch.last_ts) DESC NULLS LAST
    LIMIT ${add(Math.min(limit, 200))} OFFSET ${add(offset)}`;
  const rows = await query(sql, p);
  return { total: rows[0]?.total || 0, rows, words };
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

/**
 * Save a contact by number and name (e.g. a chef someone referred). Also makes an empty chat so it shows in the inbox
 * and can be messaged right away. Returns { jid, name }.
 */
export async function saveContact(accountId, phoneOrJid, name) {
  const jid = toJid(phoneOrJid);
  if (!String(name || '').trim()) throw new Error('Give the contact a name');
  await updateContact(accountId, jid, { name });
  await query(
    `INSERT INTO chats (account_id, jid, name, is_group, last_ts) VALUES ($1,$2,$3,false,$4) ON CONFLICT (account_id, jid) DO UPDATE SET name = EXCLUDED.name`,
    [accountId, jid, String(name).trim().slice(0, 100), Math.floor(Date.now() / 1000)],
  );
  return { jid, name: String(name).trim() };
}

export async function updateContact(accountId, jid, { addTags, removeTags, leadStatus, notes, summary, markReviewed, name }) {
  await query(
    `INSERT INTO contacts (account_id, jid, phone) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [accountId, jid, phoneOf(jid)],
  );
  const sets = ['updated_at = now()'];
  const p = [accountId, jid];
  if (addTags?.length || removeTags?.length) {
    p.push(addTags || [], removeTags || []);
    sets.push(`tags = (SELECT COALESCE(array_agg(DISTINCT t ORDER BY t), '{}') FROM unnest(tags || $${p.length - 1}::text[]) t
                       WHERE t <> ALL($${p.length}::text[]))`);
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
  if (name !== undefined && String(name).trim()) {
    // the name you saved wins over what WhatsApp reports; the chat list shows it too
    p.push(String(name).trim().slice(0, 100));
    sets.push(`name = $${p.length}, saved_name = $${p.length}`);
    await query('UPDATE chats SET name = $3 WHERE account_id = $1 AND jid = $2', [accountId, jid, String(name).trim().slice(0, 100)]).catch(() => {});
  }
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

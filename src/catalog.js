/**
 * File catalog (31 Oct): the AI names and files every saved photo / PDF so it can be found later, and says whether
 * to keep it — keep (IDs, payment proofs, invoices, agreements, checklists with issues), temporary (food photos,
 * routine updates: fine to delete when space runs short) or delete (junk, duplicates: removed now). When saved files
 * pass the storage limit (config 'storage' { limitMb }, default 900 MB of Supabase's free 1 GB), the hub deletes
 * "temporary" files oldest first down to 85 %, never "keep" or files not yet looked at; if that is not enough the
 * owner gets a card. Table media_catalog.
 */
import { query } from './db.js';

const KEEP = ['keep', 'temporary', 'delete'];
const DEFAULT_LIMIT_MB = 900;

export async function storageLimitMb() {
  const [r] = await query(`SELECT value FROM config WHERE key = 'storage'`).catch(() => []);
  return Number(r?.value?.limitMb) || DEFAULT_LIMIT_MB;
}

/** Remove the stored copy of one message's file (the message itself stays; it shows "not kept"). */
async function dropCopy(accountId, messageId) {
  const [m] = await query(`SELECT media_saved FROM messages WHERE account_id = $1 AND id = $2`, [accountId, messageId]);
  if (!m?.media_saved) return false;
  const { deleteMedia } = await import('./media.js');
  await deleteMedia(m.media_saved).catch(() => {});
  await query(`UPDATE messages SET media_saved = NULL WHERE account_id = $1 AND id = $2`, [accountId, messageId]);
  await query(`DELETE FROM hub_files WHERE ref = $1`, [m.media_saved]).catch(() => {});
  return true;
}

export async function catalogFile({ account, chat, messageId, title, folder, keep = 'keep', notes, by = 'ai' }) {
  if (!KEEP.includes(keep)) throw new Error(`keep must be one of ${KEEP.join(', ')}`);
  const [m] = await query(`SELECT chat_jid, (media->>'size')::int AS size FROM messages WHERE account_id = $1 AND chat_jid = $2 AND id = $3`, [account, chat, messageId]);
  if (!m) throw new Error('No such message in that chat');
  await query(
    `INSERT INTO media_catalog (account_id, message_id, chat_jid, title, folder, keep, notes, size, tagged_by, tagged_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (account_id, message_id) DO UPDATE SET title = EXCLUDED.title, folder = EXCLUDED.folder, keep = EXCLUDED.keep,
       notes = COALESCE(EXCLUDED.notes, media_catalog.notes), tagged_by = EXCLUDED.tagged_by, tagged_at = now()`,
    [account, messageId, chat, String(title || '').slice(0, 160) || null, String(folder || '').slice(0, 80) || null, keep, notes ? String(notes).slice(0, 500) : null, m.size || null, by],
  );
  const dropped = keep === 'delete' ? await dropCopy(account, messageId) : false;
  return { dropped };
}

/** Files: saved or catalogued, newest first; untagged = saved but not looked at yet. */
export async function findFiles({ q, folder, chat, keep, untagged = false, account, limit = 40 } = {}) {
  const p = [];
  const w = [`m.media IS NOT NULL`, `(m.media_saved IS NOT NULL OR c.message_id IS NOT NULL)`];
  if (account) { p.push(account); w.push(`m.account_id = $${p.length}`); }
  if (chat) { p.push(String(chat).includes('@') ? chat : `${String(chat).replace(/\D/g, '')}%`); w.push(`m.chat_jid LIKE $${p.length}`); }
  if (folder) { p.push(`%${folder}%`); w.push(`c.folder ILIKE $${p.length}`); }
  if (keep) { p.push(keep); w.push(`c.keep = $${p.length}`); }
  if (untagged) w.push(`c.message_id IS NULL AND m.media_saved IS NOT NULL`);
  if (q) { p.push(`%${q}%`); w.push(`(c.title ILIKE $${p.length} OR c.notes ILIKE $${p.length} OR c.folder ILIKE $${p.length} OR m.body ILIKE $${p.length} OR m.media->>'fileName' ILIKE $${p.length} OR COALESCE(ch.name, ct.name, ct.notify, '') ILIKE $${p.length})`); }
  p.push(Math.min(limit, 200));
  return query(
    `SELECT m.account_id, m.chat_jid, m.id, m.ts, m.type, m.body, m.media->>'fileName' AS file_name, (m.media->>'size')::int AS size,
       m.media_saved IS NOT NULL AS saved, c.title, c.folder, c.keep, c.notes, COALESCE(NULLIF(ch.name,''), ct.name, ct.notify) AS person
     FROM messages m
     LEFT JOIN media_catalog c ON c.account_id = m.account_id AND c.message_id = m.id
     LEFT JOIN chats ch ON ch.account_id = m.account_id AND ch.jid = m.chat_jid
     LEFT JOIN contacts ct ON ct.account_id = m.account_id AND ct.jid = m.chat_jid
     WHERE ${w.join(' AND ')} ORDER BY m.ts DESC LIMIT $${p.length}`,
    p,
  );
}

export async function storageStatus() {
  const [t] = await query(
    `SELECT count(*)::int AS files, COALESCE(sum((m.media->>'size')::bigint), 0)::bigint AS bytes,
       count(*) FILTER (WHERE c.message_id IS NULL)::int AS untagged,
       COALESCE(sum((m.media->>'size')::bigint) FILTER (WHERE c.keep = 'temporary'), 0)::bigint AS temp_bytes
     FROM messages m LEFT JOIN media_catalog c ON c.account_id = m.account_id AND c.message_id = m.id
     WHERE m.media_saved IS NOT NULL`,
  );
  const folders = await query(
    `SELECT COALESCE(c.folder, '(not filed)') AS folder, count(*)::int AS files, COALESCE(sum((m.media->>'size')::bigint), 0)::bigint AS bytes
     FROM messages m LEFT JOIN media_catalog c ON c.account_id = m.account_id AND c.message_id = m.id
     WHERE m.media_saved IS NOT NULL GROUP BY 1 ORDER BY 3 DESC LIMIT 20`,
  );
  const limitMb = await storageLimitMb();
  return { files: t.files, mb: Math.round(Number(t.bytes) / 1048576), limitMb, untagged: t.untagged, temporaryMb: Math.round(Number(t.temp_bytes) / 1048576), folders };
}

/** Over the limit → delete "temporary" files oldest first down to 85 %; still over → owner card. */
export async function cleanupStorage() {
  const st = await storageStatus();
  if (st.mb <= st.limitMb) return { deleted: 0, ...st };
  let over = (st.mb - st.limitMb * 0.85) * 1048576;
  const temp = await query(
    `SELECT m.account_id, m.id, (m.media->>'size')::bigint AS size FROM messages m
     JOIN media_catalog c ON c.account_id = m.account_id AND c.message_id = m.id
     WHERE m.media_saved IS NOT NULL AND c.keep = 'temporary' ORDER BY m.ts LIMIT 2000`,
  );
  let deleted = 0;
  for (const f of temp) {
    if (over <= 0) break;
    if (await dropCopy(f.account_id, f.id)) { deleted++; over -= Number(f.size) || 100000; }
  }
  if (over > 0) {
    const { upsertRefTask } = await import('./tasks.js');
    const [acc] = await query(`SELECT id FROM accounts ORDER BY is_default DESC, created_at LIMIT 1`);
    await upsertRefTask('storage:full', {
      account: acc?.id, kind: 'todo', assignee: 'you', priority: true, dueAt: new Date().toISOString(),
      title: `File storage nearly full (${st.mb} of ${st.limitMb} MB)`,
      details: `Deleted ${deleted} temporary file(s); what is left is marked "keep" or not looked at yet. Ask the AI to review files (find_files untagged) or raise the limit / move to a paid storage plan.`,
    });
  }
  return { deleted, ...st };
}

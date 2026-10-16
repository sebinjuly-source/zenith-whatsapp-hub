/**
 * Every outgoing message goes through the outbox table.
 *  - You (dashboard / REST / Apps Script): queued and sent right away, at least 5 s apart.
 *  - AI agents and campaigns: become drafts when the account is in "approve" mode, otherwise queued;
 *    they respect the random delay, the daily cap and the sending window.
 */
import { EventEmitter } from 'events';
import { query, logEvent } from './db.js';
import config from './config.js';
import { manager } from './wa/manager.js';
import { loadOutgoing } from './media.js';
import { toJid } from './store.js';
import { MIN_DELAY_SEC, randomDelayMs, insideSendingWindow } from './settings.js';

const AUTOMATED = ['mcp', 'campaign'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = new EventEmitter();
done.setMaxListeners(0);
const workers = new Map(); // accountId -> { wake }

/**
 * payload: { text?, attachment?: { url | base64, fileName?, mimetype?, caption?, as?: 'document'|'image'|'video'|'audio' } }
 */
export async function enqueue({ account, to, payload, source, note, scheduledAt, priority = 0, campaignId = null }) {
  const session = await manager.resolve(account);
  if (!payload?.text && !payload?.attachment) throw new Error('Nothing to send: give text and/or attachment');
  const jid = toJid(to);
  const automated = AUTOMATED.includes(source);
  const status = automated && session.settings.aiMode === 'approve' ? 'draft' : 'queued';
  const rows = await query(
    `INSERT INTO outbox (account_id, to_jid, payload, source, status, priority, note, scheduled_at, campaign_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()),$9) RETURNING *`,
    [session.id, jid, JSON.stringify(payload), source, status, priority, note || null, scheduledAt || null, campaignId],
  );
  if (status === 'queued') wake(session.id);
  return rows[0];
}

/** Resolve when the outbox row is sent or failed (or after timeoutMs). */
export function waitFor(id, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      done.removeListener(String(id), on);
      resolve(null);
    }, timeoutMs);
    const on = (row) => {
      clearTimeout(t);
      resolve(row);
    };
    done.once(String(id), on);
  });
}

export async function approve(id, { text } = {}) {
  const rows = await query(`SELECT * FROM outbox WHERE id = $1`, [id]);
  const row = rows[0];
  if (!row) throw new Error('Draft not found');
  if (row.status !== 'draft') throw new Error(`Item is ${row.status}, not a draft`);
  const payload = { ...row.payload };
  if (typeof text === 'string' && text.trim()) {
    if (payload.attachment && !payload.text) payload.attachment.caption = text;
    else payload.text = text;
  }
  const updated = await query(
    `UPDATE outbox SET status = 'queued', payload = $2, scheduled_at = now() WHERE id = $1 RETURNING *`,
    [id, JSON.stringify(payload)],
  );
  wake(row.account_id);
  return updated[0];
}

export async function reject(id) {
  const rows = await query(
    `UPDATE outbox SET status = 'rejected' WHERE id = $1 AND status IN ('draft','queued') RETURNING *`,
    [id],
  );
  if (!rows[0]) throw new Error('Nothing to reject (already sent?)');
  return rows[0];
}

export async function listOutbox({ account, status, limit = 50 } = {}) {
  const p = [];
  const where = [];
  if (account) {
    p.push(account);
    where.push(`o.account_id = $${p.length}`);
  }
  if (status) {
    p.push(status.split(','));
    where.push(`o.status = ANY($${p.length})`);
  }
  p.push(Math.min(limit, 200));
  return query(
    `SELECT o.*, COALESCE(ct.name, ct.notify, ch.name) AS to_name
     FROM outbox o
     LEFT JOIN contacts ct ON ct.account_id = o.account_id AND ct.jid = o.to_jid
     LEFT JOIN chats ch ON ch.account_id = o.account_id AND ch.jid = o.to_jid
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY o.id DESC LIMIT $${p.length}`,
    p,
  );
}

async function automatedSentToday(accountId) {
  const rows = await query(
    `SELECT count(*)::int AS n FROM outbox
     WHERE account_id = $1 AND source = ANY($2) AND status = 'sent'
       AND sent_at >= (date_trunc('day', now() AT TIME ZONE $3) AT TIME ZONE $3)`,
    [accountId, AUTOMATED, config.tz],
  );
  return rows[0].n;
}

async function buildContent(payload) {
  if (!payload.attachment) return { text: payload.text };
  const a = payload.attachment;
  const file = await loadOutgoing(a);
  const caption = a.caption ?? payload.text ?? undefined;
  const as = a.as || (file.mimetype.startsWith('image/') ? 'image' : file.mimetype.startsWith('video/') ? 'video' : file.mimetype.startsWith('audio/') ? 'audio' : 'document');
  if (as === 'image') return { image: file.buffer, mimetype: file.mimetype, caption };
  if (as === 'video') return { video: file.buffer, mimetype: file.mimetype, caption };
  if (as === 'audio') return { audio: file.buffer, mimetype: file.mimetype };
  return { document: file.buffer, mimetype: file.mimetype, fileName: file.fileName || 'file', caption };
}

function wake(accountId) {
  const w = workers.get(accountId);
  if (w) w.wake();
  else startWorker(accountId);
}

function startWorker(accountId) {
  let wakeUp = () => {};
  const w = { wake: () => wakeUp() };
  workers.set(accountId, w);
  const nap = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      wakeUp = () => {
        clearTimeout(t);
        resolve();
      };
    });

  (async () => {
    for (;;) {
      try {
        if ((await tick()) === 'stop') return;
      } catch (err) {
        await logEvent(accountId, 'error', `Outbox error: ${err.message}`);
        await nap(30000);
      }
    }
  })();

  async function tick() {
      let session;
      try {
        session = manager.get(accountId);
      } catch {
        workers.delete(accountId);
        return 'stop'; // account removed
      }
      if (session.status !== 'open') {
        await nap(15000);
        return;
      }
      const s = session.settings;
      const automatedAllowed = insideSendingWindow(s) && (await automatedSentToday(accountId)) < s.dailyCap;
      const rows = await query(
        `SELECT * FROM outbox WHERE account_id = $1 AND status = 'queued' AND scheduled_at <= now()
           AND ($2 OR source <> ALL($3))
         ORDER BY priority DESC, id LIMIT 1`,
        [accountId, automatedAllowed, AUTOMATED],
      );
      const row = rows[0];
      if (!row) {
        await nap(automatedAllowed ? 60000 : 5 * 60000);
        return;
      }
      const automated = AUTOMATED.includes(row.source);
      await query(`UPDATE outbox SET status = 'sending' WHERE id = $1`, [row.id]);
      let result;
      try {
        const content = await buildContent(row.payload);
        const textLen = (row.payload.text || '').length;
        const typingMs = s.typing ? Math.min(6000, Math.max(1500, textLen * 40)) : 0;
        const sent = await session.send(row.to_jid, content, { typingMs });
        result = (
          await query(`UPDATE outbox SET status = 'sent', sent_at = now(), message_id = $2, error = NULL WHERE id = $1 RETURNING *`, [
            row.id, sent?.key?.id || null,
          ])
        )[0];
      } catch (err) {
        result = (
          await query(`UPDATE outbox SET status = 'failed', error = $2 WHERE id = $1 RETURNING *`, [row.id, err.message])
        )[0];
        await logEvent(accountId, 'warn', `Send to ${row.to_jid.split('@')[0]} failed: ${err.message}`);
      }
      done.emit(String(row.id), result);
      await sleep(automated ? randomDelayMs(s) : MIN_DELAY_SEC * 1000);
  }
}

export async function startOutbox() {
  // A send that was in progress when the server stopped may or may not have gone out — don't resend blindly.
  await query(
    `UPDATE outbox SET status = 'failed', error = 'Interrupted by a restart — check the chat before resending'
     WHERE status = 'sending'`,
  );
  const rows = await query(`SELECT id FROM accounts`);
  for (const r of rows) startWorker(r.id);
  manager.on('change', (info) => {
    if (info?.status === 'open') wake(info.id);
  });
}

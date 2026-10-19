/**
 * Every outgoing message goes through the outbox table.
 *  - You (dashboard / REST / Apps Script): sent right away (jumping ahead of bulk sends), at least 5 s apart.
 *  - AI agents and bulk sends: become drafts when the number is in "approve" mode, otherwise queued;
 *    they respect the random delay, the daily cap and the sending window.
 */
import { EventEmitter } from 'events';
import { query, logEvent } from './db.js';
import config from './config.js';
import { manager } from './wa/manager.js';
import { loadOutgoing } from './media.js';
import { toJid } from './store.js';
import { MIN_DELAY_SEC, randomDelayMs, insideSendingWindow, afterTime } from './settings.js';
import { createTask, refreshTask, fillTemplate, planRecipients } from './tasks.js';
import { hasAuthState } from './wa/auth-state.js';
import { getTemplate, contactFields, fieldsIn } from './templates.js';

// Automated = random delay, daily cap, typing. Drafts (approval) only for AI and bulk; your rules are pre-approved.
const AUTOMATED = ['mcp', 'campaign', 'rule'];
const NEEDS_APPROVAL = ['mcp', 'campaign'];
const PRIORITY_YOU = 10; // your own / API sends go before queued bulk messages
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = new EventEmitter();
done.setMaxListeners(0);
const workers = new Map(); // accountId -> { wake }

/**
 * payload: { text?, attachment?: { url | base64, fileName?, mimetype?, caption?, as?: 'document'|'image'|'video'|'audio' } }
 */
/** Refuse right away (with a clear reason) when a number can't send, instead of queueing into a void. */
export async function assertCanSend(session) {
  if (!session.account.enabled) throw new Error(`Number "${session.account.label}" is paused — resume it in Settings`);
  if (session.status === 'logged_out') throw new Error(`Number "${session.account.label}" is logged out of WhatsApp — re-link it in the dashboard (Numbers → Link number)`);
  if (session.status === 'stopped' && !(await hasAuthState(session.id))) {
    throw new Error(`Number "${session.account.label}" is not linked yet — link it in the dashboard first`);
  }
}

export async function enqueue({ account, to, payload, source, note, scheduledAt, taskId = null, idemKey = null }) {
  const session = await manager.resolve(account);
  if (!payload?.text && !payload?.attachment) throw new Error('Nothing to send: give text and/or attachment');
  const jid = toJid(to);
  if (idemKey) {
    const [dup] = await query('SELECT * FROM outbox WHERE account_id = $1 AND idem_key = $2', [session.id, String(idemKey)]);
    if (dup) return { ...dup, duplicate: true }; // same request seen before: don't send again
  }
  await assertCanSend(session);
  const automated = AUTOMATED.includes(source);
  const status = NEEDS_APPROVAL.includes(source) && session.settings.aiMode === 'approve' ? 'draft' : 'queued';
  const [row] = await query(
    `INSERT INTO outbox (account_id, to_jid, payload, source, status, priority, note, scheduled_at, task_id, idem_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()),$9,$10)
     ON CONFLICT (account_id, idem_key) WHERE idem_key IS NOT NULL DO NOTHING RETURNING *`,
    [session.id, jid, JSON.stringify(payload), source, status, automated ? 0 : PRIORITY_YOU, note || null, scheduledAt || null, taskId, idemKey ? String(idemKey) : null],
  );
  if (!row) {
    // a concurrent identical request won the race
    const [dup] = await query('SELECT * FROM outbox WHERE account_id = $1 AND idem_key = $2', [session.id, String(idemKey)]);
    return { ...dup, duplicate: true };
  }
  if (taskId) await refreshTask(taskId);
  if (status === 'queued') wake(session.id);
  return row;
}

/**
 * Send one message (template with {name} etc.) to many people as one task on the board.
 * recipients: [{ to, name?, ...extra fields usable as {field} }] or plain numbers.
 */
export async function bulkSend({ account, title, details, recipients, text, attachment, template, scheduledAt, source = 'campaign',
  createdBy = 'you', skipIfContactedDays = 30, allowRepeat = false, taskId, idemKey = null }) {
  const session = await manager.resolve(account);
  if (template) {
    const t = await getTemplate(session.id, template);
    if (!t) throw new Error(`No template called "${template}"`);
    text = text || t.body || undefined;
    attachment = attachment || t.attachment || undefined;
  }
  if (!text && !attachment) throw new Error('Give the message text (can use {name}) and/or an attachment');
  if (idemKey) {
    const [t] = await query('SELECT * FROM tasks WHERE account_id = $1 AND idem_key = $2', [session.id, String(idemKey)]);
    if (t) return { task: t, queued: 0, skipped: [], mode: session.settings.aiMode, duplicate: true };
  }
  await assertCanSend(session);
  const { ok, skipped } = await planRecipients(session.id, recipients, { skipIfContactedDays, allowRepeat });
  if (!ok.length) return { task: null, queued: 0, skipped };
  const task = taskId
    ? { id: taskId }
    : await createTask({ account: session.id, title: title || `Message ${ok.length} people`, details, kind: 'bulk', createdBy, idemKey });
  let n = 0;
  for (const r of ok) {
    const name = r.vars.name || r.vars.Name;
    const vars = { ...r.vars, name, first_name: r.vars.first_name || (name ? String(name).trim().split(/\s+/)[0] : undefined), phone: r.jid.split('@')[0] };
    const body = text ? fillTemplate(r.vars.text || text, vars) : undefined;
    const att = attachment ? { ...attachment, caption: attachment.caption ? fillTemplate(attachment.caption, vars) : undefined } : undefined;
    await query(
      `INSERT INTO outbox (account_id, to_jid, payload, source, status, priority, note, scheduled_at, task_id)
       VALUES ($1,$2,$3,$4,$5,0,$6,COALESCE($7::timestamptz, now()),$8)`,
      [session.id, r.jid, JSON.stringify({ text: body, attachment: att }), source,
        NEEDS_APPROVAL.includes(source) && session.settings.aiMode === 'approve' ? 'draft' : 'queued',
        title || null, scheduledAt || null, task.id],
    );
    n++;
  }
  await refreshTask(task.id);
  wake(session.id);
  return { task, queued: n, skipped, mode: session.settings.aiMode };
}

/** Resolve when the outbox row is sent or failed (or null after timeoutMs). */
export function waitFor(id, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const on = (row) => {
      clearTimeout(t);
      resolve(row);
    };
    const t = setTimeout(() => {
      done.removeListener(String(id), on);
      resolve(null);
    }, timeoutMs);
    done.once(String(id), on);
  });
}

export async function approve(id, { text } = {}) {
  const [row] = await query(`SELECT * FROM outbox WHERE id = $1`, [id]);
  if (!row) throw new Error('Draft not found');
  if (row.status !== 'draft') throw new Error(`Item is ${row.status}, not a draft`);
  const payload = { ...row.payload };
  if (typeof text === 'string' && text.trim()) {
    if (payload.attachment && !payload.text) payload.attachment = { ...payload.attachment, caption: text };
    else payload.text = text;
  }
  const [updated] = await query(
    `UPDATE outbox SET status = 'queued', payload = $2, scheduled_at = GREATEST(scheduled_at, now())
     WHERE id = $1 AND status = 'draft' RETURNING *`,
    [id, JSON.stringify(payload)],
  );
  if (!updated) throw new Error('Draft was already handled');
  await refreshTask(row.task_id);
  wake(row.account_id);
  return updated;
}

/** Approve every draft of a task in one go. */
export async function approveTask(taskId) {
  const rows = await query(
    `UPDATE outbox SET status = 'queued', scheduled_at = GREATEST(scheduled_at, now())
     WHERE task_id = $1 AND status = 'draft' RETURNING account_id`,
    [taskId],
  );
  await refreshTask(taskId);
  for (const a of new Set(rows.map((r) => r.account_id))) wake(a);
  return { approved: rows.length };
}

/** Approve every draft at once — optionally only one number's or one task's. Saved text is sent as it is. */
export async function approveAll({ account, taskId } = {}) {
  const p = [];
  const where = [`status = 'draft'`];
  if (account) { p.push(account); where.push(`account_id = $${p.length}`); }
  if (taskId) { p.push(taskId); where.push(`task_id = $${p.length}`); }
  const rows = await query(
    `UPDATE outbox SET status = 'queued', scheduled_at = GREATEST(scheduled_at, now())
     WHERE ${where.join(' AND ')} RETURNING account_id, task_id`,
    p,
  );
  for (const t of new Set(rows.map((r) => r.task_id).filter(Boolean))) await refreshTask(t);
  const perAccount = {};
  for (const r of rows) perAccount[r.account_id] = (perAccount[r.account_id] || 0) + 1;
  for (const a of Object.keys(perAccount)) wake(a);
  return { approved: rows.length, perAccount };
}

export async function reject(id) {
  const [row] = await query(
    `UPDATE outbox SET status = 'rejected' WHERE id = $1 AND status IN ('draft','queued') RETURNING *`,
    [id],
  );
  if (!row) throw new Error('Nothing to reject (already sent?)');
  await refreshTask(row.task_id);
  return row;
}

export async function listOutbox({ account, status, taskId, limit = 50 } = {}) {
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
  if (taskId) {
    p.push(taskId);
    where.push(`o.task_id = $${p.length}`);
  }
  p.push(Math.min(limit, 500));
  return query(
    `SELECT o.*, COALESCE(ct.name, ct.notify, ch.name) AS to_name, t.title AS task_title
     FROM outbox o
     LEFT JOIN contacts ct ON ct.account_id = o.account_id AND ct.jid = o.to_jid
     LEFT JOIN chats ch ON ch.account_id = o.account_id AND ch.jid = o.to_jid
     LEFT JOIN tasks t ON t.id = o.task_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY o.id DESC LIMIT $${p.length}`,
    p,
  );
}

/**
 * Is this number reaching out to NEW people today? True if a first-contact message (bulk/AI, not a
 * follow-up) was sent today, or is still waiting as a draft/queued. Follow-ups wait for days when this is false.
 */
export async function newOutreachToday(accountId) {
  const [r] = await query(
    `SELECT 1 FROM outbox WHERE account_id = $1 AND source = ANY($2) AND note IS DISTINCT FROM 'follow-up'
       AND (status IN ('draft','queued','sending')
            OR (status = 'sent' AND sent_at >= (date_trunc('day', now() AT TIME ZONE $3) AT TIME ZONE $3)))
     LIMIT 1`,
    [accountId, ['campaign', 'mcp'], config.tz],
  );
  return !!r;
}

/** Follow-ups sent (or being sent) today by this number. */
export async function followupsToday(accountId) {
  const [r] = await query(
    `SELECT count(*)::int AS n FROM outbox WHERE account_id = $1 AND note = 'follow-up' AND status IN ('sent','sending')
       AND sent_at >= (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)`,
    [accountId, config.tz],
  );
  return r.n;
}

async function automatedSentToday(accountId) {
  const [r] = await query(
    `SELECT count(*)::int AS n FROM outbox
     WHERE account_id = $1 AND source = ANY($2) AND status = 'sent'
       AND sent_at >= (date_trunc('day', now() AT TIME ZONE $3) AT TIME ZONE $3)`,
    [accountId, AUTOMATED, config.tz],
  );
  return r.n;
}

/** Rebuild enough of a stored message for WhatsApp to show it as the quoted message of a reply. */
async function quotedMessage(accountId, chatJid, messageId) {
  const [m] = await query('SELECT id, from_me, sender_jid, body, type FROM messages WHERE account_id = $1 AND chat_jid = $2 AND id = $3', [accountId, chatJid, messageId]);
  if (!m) return undefined; // message unknown: send without the quote rather than fail
  const key = { remoteJid: chatJid, id: m.id, fromMe: m.from_me };
  if (chatJid.endsWith('@g.us') && !m.from_me && m.sender_jid) key.participant = m.sender_jid;
  return { key, message: { conversation: m.body || `[${m.type}]` } };
}

/**
 * Turn a saved template into a payload for one person: fills {name}, {first_name}, {phone} from the contact,
 * plus any `vars` given. Returns { payload, missing } (missing = fields left empty).
 */
export async function renderTemplate(accountId, jid, templateRef, vars = {}) {
  const t = await getTemplate(accountId, templateRef);
  if (!t) throw new Error(`No template called "${templateRef}"`);
  const known = { ...(await contactFields(accountId, jid)), ...Object.fromEntries(Object.entries(vars).filter(([, v]) => v != null && v !== '')) };
  const missing = fieldsIn(t.body).filter((f) => !known[f] && f !== 'name');
  const payload = { text: t.body ? fillTemplate(t.body, known) : undefined };
  if (t.attachment?.url) payload.attachment = { ...t.attachment, caption: t.attachment.caption ? fillTemplate(t.attachment.caption, known) : undefined };
  return { payload, missing, template: t };
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

/** Nudge a number's sender to look at the queue now. */
export const wakeAccount = (accountId) => wake(accountId);

function wake(accountId) {
  const w = workers.get(accountId);
  if (w) w.wake();
  else startWorker(accountId);
}

function startWorker(accountId) {
  let wakeUp = () => {};
  let nextAutomatedAt = 0; // random gap applies between automated messages only
  workers.set(accountId, { wake: () => wakeUp() });
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
    await runJobs(session);
    const s = session.settings;
    const gapOver = Date.now() >= nextAutomatedAt;
    const automatedAllowed = gapOver && insideSendingWindow(s) && (await automatedSentToday(accountId)) < s.dailyCap;
    // Follow-ups only go out on days with no new outreach (new candidates get the limited capacity first).
    const followupsAllowed = automatedAllowed && afterTime(s.followupStart) && !(await newOutreachToday(accountId))
      && (await followupsToday(accountId)) < s.followupDailyMax;
    // Claim one row atomically, so two servers can never pick the same message.
    const [row] = await query(
      `UPDATE outbox SET status = 'sending', sent_at = now() WHERE id = (
         SELECT id FROM outbox WHERE account_id = $1 AND status = 'queued' AND scheduled_at <= now()
           AND ($2 OR source <> ALL($3))
           AND (note IS DISTINCT FROM 'follow-up' OR $4)
         ORDER BY priority DESC, id LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [accountId, automatedAllowed, AUTOMATED, followupsAllowed],
    );
    if (!row) {
      // Wait for new work, or until the random gap ends, whichever is first.
      const wait = !gapOver ? Math.max(1000, nextAutomatedAt - Date.now()) : automatedAllowed ? 60000 : 5 * 60000;
      // Poll at least every 10 s: approvals/jobs may come from another server, which can't wake us.
      await nap(Math.min(wait, 10000));
      return;
    }
    const automated = AUTOMATED.includes(row.source);
    let result;
    try {
      const content = await buildContent(row.payload);
      const textLen = (row.payload.text || '').length;
      // "typing…" is for AI/bulk messages; your own and Apps Script sends go out straight away
      const typingMs = automated && s.typing ? Math.min(6000, Math.max(1500, textLen * 40)) : 0;
      const quoted = row.payload.replyTo ? await quotedMessage(session.id, row.to_jid, row.payload.replyTo) : undefined;
      const sent = await session.send(row.to_jid, content, { typingMs, quoted });
      [result] = await query(
        `UPDATE outbox SET status = 'sent', sent_at = now(), message_id = $2, error = NULL WHERE id = $1 RETURNING *`,
        [row.id, sent?.key?.id || null],
      );
    } catch (err) {
      [result] = await query(`UPDATE outbox SET status = 'failed', error = $2 WHERE id = $1 RETURNING *`, [row.id, err.message]);
      await logEvent(accountId, 'warn', `Send to ${row.to_jid.split('@')[0]} failed: ${err.message}`);
    }
    done.emit(String(row.id), result);
    if (row.task_id) await refreshTask(row.task_id).catch(() => {});
    if (row.list_id) import('./lists.js').then((l) => l.refreshList(row.list_id)).catch(() => {});
    if (automated) nextAutomatedAt = Date.now() + randomDelayMs(s) * config.timeScale;
    await sleep(MIN_DELAY_SEC * 1000 * config.timeScale); // never two messages from one number within 5 s
  }
}

/**
 * A send stuck in "sending" for minutes was interrupted (server restarted mid-send). It may or may not
 * have gone out, so mark it failed instead of resending blindly. Safe with two servers: a live send
 * never takes this long (sending times out after 2 min).
 */
/** Queue an action that needs the live connection; runs here if this server holds the number. */
export async function requestJob(session, kind, payload) {
  if (kind === 'backfill') {
    const [busy] = await query(
      `SELECT id FROM jobs WHERE account_id = $1 AND kind = 'backfill' AND status IN ('pending','running')`,
      [session.id],
    );
    if (busy) throw new Error(`A deep history backfill is already running for "${session.id}" (job #${busy.id})`);
    const [job] = await query('INSERT INTO jobs (account_id, kind, payload) VALUES ($1,$2,$3) RETURNING id', [
      session.id, kind, JSON.stringify(payload),
    ]);
    wake(session.id);
    return { ran: false, jobId: job.id };
  }
  if (session.status === 'open') return { ran: true, result: await JOBS[kind](session, payload) };
  await query('INSERT INTO jobs (account_id, kind, payload) VALUES ($1,$2,$3)', [session.id, kind, JSON.stringify(payload)]);
  return { ran: false };
}

const JOBS = {
  fetch_older: (session, { chat, count }) => session.fetchOlder(chat, count || 50),
};

/** Latest deep-history backfill job of an account (or null). */
export async function backfillStatus(accountId) {
  const [j] = await query(
    `SELECT id, status, result, created_at, updated_at, payload FROM jobs WHERE account_id = $1 AND kind = 'backfill' ORDER BY id DESC LIMIT 1`,
    [accountId],
  );
  return j || null;
}

const backfills = new Set(); // accounts with a backfill running in this process

async function runJobs(session) {
  // We hold this number's lease, so no other server can be running its backfill: one marked "running"
  // but not running here was cut off by a restart/deploy — resume it right away from its saved progress.
  if (!backfills.has(session.id)) {
    await query(
      `UPDATE jobs SET status = 'pending' WHERE account_id = $1 AND kind = 'backfill' AND status = 'running'`,
      [session.id],
    );
  }
  for (;;) {
    const [job] = await query(
      `UPDATE jobs SET status = 'running' WHERE id = (
         SELECT id FROM jobs WHERE account_id = $1 AND status = 'pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [session.id],
    );
    if (!job) return;
    if (job.kind === 'backfill') {
      // Long-running: runs in the background so sending isn't blocked.
      if (backfills.has(session.id)) {
        await query(`UPDATE jobs SET status = 'pending' WHERE id = $1`, [job.id]);
        return;
      }
      backfills.add(session.id);
      session
        .runBackfill(job)
        .catch((err) => query(`UPDATE jobs SET status = 'failed', result = $2, done_at = now() WHERE id = $1`, [job.id, err.message]))
        .finally(() => backfills.delete(session.id));
      continue;
    }
    try {
      const r = await JOBS[job.kind]?.(session, job.payload);
      await query(`UPDATE jobs SET status = 'done', result = $2, done_at = now() WHERE id = $1`, [job.id, String(r ?? '')]);
    } catch (err) {
      await query(`UPDATE jobs SET status = 'failed', result = $2, done_at = now() WHERE id = $1`, [job.id, err.message]);
    }
  }
}

export async function sweepStuck() {
  const rows = await query(
    `UPDATE outbox SET status = 'failed', error = 'Interrupted (server restart) — check the chat before resending'
     WHERE status = 'sending' AND sent_at < now() - interval '4 minutes' RETURNING task_id`,
  );
  for (const r of rows) if (r.task_id) await refreshTask(r.task_id).catch(() => {});
}

export async function startOutbox() {
  await sweepStuck();
  setInterval(() => sweepStuck().catch(() => {}), 5 * 60000).unref();
  // Tasks scheduled for later move to "in progress" when their time comes.
  setInterval(async () => {
    const due = await query(
      `SELECT DISTINCT task_id FROM outbox WHERE task_id IS NOT NULL AND status = 'queued'
         AND scheduled_at BETWEEN now() - interval '10 minutes' AND now() + interval '1 minute'`,
    ).catch(() => []);
    for (const d of due) await refreshTask(d.task_id).catch(() => {});
  }, 60000).unref();
  const rows = await query(`SELECT id FROM accounts`);
  for (const r of rows) startWorker(r.id);
  manager.on('change', (info) => {
    if (info?.status === 'open') wake(info.id);
  });
}

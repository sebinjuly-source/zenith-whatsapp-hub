/**
 * Every outgoing message goes through the outbox table.
 *  - You (dashboard / REST / Apps Script): sent right away (jumping ahead of bulk sends), at least 5 s apart.
 *  - AI agents and bulk sends: become drafts when the number is in "approve" mode, otherwise queued;
 *    they respect the random delay, the daily cap and the sending window.
 */
import { EventEmitter } from 'events';
import { query, logEvent } from './db.js';
import { roleOf, roleFilter } from './campaign.js';
import config from './config.js';
import logger from './logger.js';
import { manager } from './wa/manager.js';
import { loadOutgoing } from './media.js';
import { toJid } from './store.js';
import { MIN_DELAY_SEC, NEW_CHATS_HARD_MAX, CLOUD_NEW_CHATS_MAX, randomDelayMs, insideSendingWindow, afterTime } from './settings.js';
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
  if (session.status === 'not_configured') throw new Error(`Meta Cloud API number "${session.account.label}" is not set up: ${session.lastError}`);
  if (session.status === 'stopped' && !session.isCloud && !(await hasAuthState(session.id))) {
    throw new Error(`Number "${session.account.label}" is not linked yet — link it in the dashboard first`);
  }
}

/**
 * Meta Cloud API numbers may only send free text to someone who wrote in the last 24 hours; anything else needs an
 * approved Meta template. Your own sends are checked up front so you get the reason at once.
 */
async function assertCloudWindow(session, jid, payload) {
  if (!session.isCloud || payload.waTemplate) return;
  const w = await session.windowFor(jid);
  if (!w.open) {
    throw new Error(w.closesAt
      ? `The 24-hour reply window with ${jid.split('@')[0]} closed — send an approved Meta template instead`
      : `${jid.split('@')[0]} hasn't written to this number yet — the first message must be an approved Meta template`);
  }
}

export async function enqueue({ account, to, payload, source, note, scheduledAt, taskId = null, idemKey = null }) {
  const session = await manager.resolve(account);
  if (!payload?.text && !payload?.attachment && !payload?.waTemplate) throw new Error('Nothing to send: give text and/or attachment');
  const jid = toJid(to);
  // Scheduled/automated sends may use a template still in review (they wait); your own direct sends need it approved.
  if (payload.waTemplate) payload = await withTemplatePreview(session, payload, { allowPending: AUTOMATED.includes(source) });
  if (idemKey) {
    const [dup] = await query('SELECT * FROM outbox WHERE account_id = $1 AND idem_key = $2', [session.id, String(idemKey)]);
    if (dup) return { ...dup, duplicate: true }; // same request seen before: don't send again
  }
  await assertCanSend(session);
  const automated = AUTOMATED.includes(source);
  // Your own sends go out right away, so check the new-number limit now (automated ones simply wait in the queue).
  if (!NEEDS_APPROVAL.includes(source) && !automated) {
    await assertCloudWindow(session, jid, payload);
    await assertNewChatAllowed(session, jid);
  }
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
  // the campaign this message belongs to (from the person's list) — stored, so the data stays demarcated
  await query(`UPDATE outbox SET role = ${roleOf('$2', '$3')} WHERE id = $1 AND role IS NULL`, [row.id, session.id, jid]).catch(() => {});
  if (taskId) await refreshTask(taskId);
  if (status === 'queued') wake(session.id);
  // A single message for later shows on the Board until it goes out
  if (!taskId && scheduledAt && new Date(scheduledAt) > new Date(Date.now() + 15 * 60000)) {
    await import('./board.js').then((b) => b.syncScheduled()).catch(() => {});
  }
  return row;
}

/**
 * Send one message (template with {name} etc.) to many people as one task on the board.
 * recipients: [{ to, name?, ...extra fields usable as {field} }] or plain numbers.
 */
export async function bulkSend({ account, title, details, recipients, text, attachment, template, waTemplate, scheduledAt, source = 'campaign',
  createdBy = 'you', skipIfContactedDays = 30, allowRepeat = false, taskId, idemKey = null }) {
  const session = await manager.resolve(account);
  if (session.isCloud && !waTemplate) {
    throw new Error(`"${session.account.label}" is a Meta Cloud API number: messages to many people must use an approved Meta template (waTemplate) — free text only works within 24 h of their last message`);
  }
  if (waTemplate && !session.isCloud) waTemplate = null; // linked numbers send the text
  if (template) {
    const t = await getTemplate(session.id, template);
    if (!t) throw new Error(`No template called "${template}"`);
    text = text || t.body || undefined;
    attachment = attachment || t.attachment || undefined;
  }
  if (!text && !attachment && !waTemplate) throw new Error('Give the message text (can use {name}) and/or an attachment');
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
    let payload;
    if (waTemplate) {
      payload = await withTemplatePreview(session, { waTemplate: fillWaTemplate(waTemplate, vars) });
    } else {
      const body = text ? fillTemplate(r.vars.text || text, vars) : undefined;
      const att = attachment ? { ...attachment, caption: attachment.caption ? fillTemplate(attachment.caption, vars) : undefined } : undefined;
      payload = { text: body, attachment: att };
    }
    await query(
      `INSERT INTO outbox (account_id, to_jid, payload, source, status, priority, note, scheduled_at, task_id)
       VALUES ($1,$2,$3,$4,$5,0,$6,COALESCE($7::timestamptz, now()),$8)`,
      [session.id, r.jid, JSON.stringify(payload), source,
        NEEDS_APPROVAL.includes(source) && session.settings.aiMode === 'approve' ? 'draft' : 'queued',
        title || null, scheduledAt || null, task.id],
    );
    n++;
  }
  await refreshTask(task.id);
  wake(session.id);
  return { task, queued: n, skipped, mode: session.settings.aiMode };
}

/** Fill hub placeholders ({name}, {first_name}, list columns…) inside a Meta template's values for one person. */
export function fillWaTemplate(waTemplate, vars) {
  const f = (v) => (typeof v === 'string' ? fillTemplate(v, vars) : v);
  const params = Array.isArray(waTemplate.params)
    ? waTemplate.params.map(f)
    : Object.fromEntries(Object.entries(waTemplate.params || {}).map(([k, v]) => [k, f(v)]));
  const header = typeof waTemplate.header === 'string' ? f(waTemplate.header) : waTemplate.header;
  return { ...waTemplate, params, ...(header !== undefined ? { header } : {}), ...(waTemplate.buttons ? { buttons: waTemplate.buttons.map(f) } : {}) };
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
  if (typeof text === 'string' && text.trim() && payload.waTemplate && text.trim() !== (payload.text || '').trim()) {
    throw new Error('This is a Meta template message — its wording is fixed by Meta. Reject it and send another template, or reply freely once they write back');
  }
  if (typeof text === 'string' && text.trim() && !payload.waTemplate) {
    if (payload.attachment && !payload.text) payload.attachment = { ...payload.attachment, caption: text };
    else payload.text = text;
  }
  // Meta number, free text: say now if the 24 h window has closed, instead of a "failed" card later
  const session = manager.sessions.get(row.account_id);
  if (session?.isCloud && !payload.waTemplate) {
    const w = await session.windowFor(row.to_jid).catch(() => ({ open: true }));
    if (!w.open) {
      throw new Error(`Can't send: the 24-hour reply window with ${row.to_jid.split('@')[0]} has closed, so Meta only allows an approved template now. Reject this draft and send a template, or move it to a linked number.`);
    }
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

/** Approve every draft at once — optionally only one number's, one task's, or the chosen ids. Saved text is sent as it is. */
export async function approveAll({ account, taskId, ids } = {}) {
  const p = [];
  const where = [`status = 'draft'`];
  if (ids) { p.push(ids.map(Number)); where.push(`id = ANY($${p.length}::bigint[])`); }
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

/** Reject the chosen drafts / queued messages. */
/**
 * Note on the person's open Board cards (reply / follow-up) that a draft was rejected and why — the AI reads card
 * notes before drafting, so it neither re-drafts the same message nor loses the owner's reason.
 */
export async function noteRejection(rows, { reason = '', actor = 'you' } = {}) {
  const { logTask } = await import('./tasks.js');
  for (const r of rows) {
    const cards = await query(
      `SELECT id FROM tasks WHERE status NOT IN ('done','cancelled')
         AND (ref = $1 OR (ref LIKE 'followup:%' AND split_part(ref, ':', 3) = $2))`,
      [`reply:${r.account_id}:${r.to_jid}`, r.to_jid],
    ).catch(() => []);
    const text = `${actor === 'ai' ? 'AI' : 'Owner'} rejected draft #${r.id}${reason ? ` — reason: ${reason}` : ' (no reason given — do not draft the same again; ask the owner if unsure)'}: "${String(r.payload?.text || r.payload?.waTemplate?.name || '').replace(/\s+/g, ' ').slice(0, 160)}"`;
    for (const c of cards) await logTask(c.id, text, { actor, kind: 'note' });
    if (reason) await query('UPDATE outbox SET error = $2 WHERE id = $1', [r.id, `Rejected: ${reason}`]).catch(() => {});
  }
}

export async function rejectMany(ids, { reason = '', actor = 'you' } = {}) {
  const rows = await query(
    `UPDATE outbox SET status = 'rejected' WHERE id = ANY($1::bigint[]) AND status IN ('draft','queued') RETURNING id, account_id, task_id, list_id, to_jid, payload, source`,
    [ids.map(Number)],
  );
  await noteRejection(rows.filter((r) => r.source !== 'campaign'), { reason, actor });
  await afterBatchChange(rows);
  return { rejected: rows.length, perAccount: countBy(rows, 'account_id') };
}

/**
 * Move unsent messages (drafts and queued) to another number — e.g. when a number is blocked. Each keeps its state:
 * drafts stay drafts (still need approval), approved messages stay approved and go out from the new number within
 * its limits. A list or task whose remaining messages all moved moves with them (follow-ups then come from there).
 */
export async function moveToAccount(ids, account) {
  const target = await manager.resolve(account);
  // A Meta Cloud API number can't send free text to people outside the 24 h window: leave those where they are.
  let kept = 0;
  if (target.isCloud) {
    const rows = await query(`SELECT id, to_jid, payload FROM outbox WHERE id = ANY($1::bigint[]) AND status IN ('draft','queued')`, [ids.map(Number)]);
    const ok = [];
    for (const r of rows) {
      if (r.payload?.waTemplate || (await target.windowFor(r.to_jid)).open) ok.push(r.id);
      else kept++;
    }
    if (!ok.length && kept) {
      throw new Error(`None moved: "${target.account.label}" is a Meta API number and these people haven't written to it in the last 24 hours — it can only send them an approved Meta template`);
    }
    ids = ok;
  }
  const rows = await query(
    `UPDATE outbox o SET account_id = $2, idem_key = NULL, scheduled_at = now()
     FROM outbox old WHERE old.id = o.id AND o.id = ANY($1::bigint[]) AND o.status IN ('draft','queued') AND o.account_id <> $2
     RETURNING o.id, old.account_id AS from_account, o.status, o.task_id, o.list_id, o.to_jid`,
    [ids.map(Number), target.id],
  );
  for (const r of rows) if (r.list_id) await rememberName(target.id, r).catch(() => {});
  const stillThere = (col, id) => query(
    `SELECT 1 FROM outbox WHERE ${col} = $1 AND account_id <> $2 AND status IN ('draft','queued','sending') LIMIT 1`, [id, target.id]);
  for (const t of new Set(rows.map((r) => r.task_id).filter(Boolean))) {
    if (!(await stillThere('task_id', t)).length) await query('UPDATE tasks SET account_id = $2 WHERE id = $1', [t, target.id]);
  }
  for (const l of new Set(rows.map((r) => r.list_id).filter(Boolean))) {
    if (!(await stillThere('list_id', l)).length) await query('UPDATE lists SET account_id = $2 WHERE id = $1', [l, target.id]);
  }
  await afterBatchChange(rows);
  if (rows.some((r) => r.status === 'queued')) wake(target.id);
  return {
    moved: rows.length, kept, to: target.id, toLabel: target.account.label, from: countBy(rows, 'from_account'),
    drafts: rows.filter((r) => r.status === 'draft').length, approved: rows.filter((r) => r.status === 'queued').length,
  };
}

/**
 * Someone messaged from a list gets their list name in the sending number's contacts, so its inbox and drafts show
 * "Sagar" instead of bare digits (a new or moved-to number has no saved contacts yet). Never overwrites a name.
 */
async function rememberName(accountId, row) {
  await query(
    `INSERT INTO contacts (account_id, jid, phone, name)
     SELECT $1, m.jid, m.phone, m.name FROM list_members m
     WHERE m.list_id = $2 AND m.jid = $3 AND COALESCE(m.name, '') <> ''
     ON CONFLICT (account_id, jid) DO UPDATE SET name = COALESCE(NULLIF(contacts.name, ''), EXCLUDED.name)`,
    [accountId, row.list_id, row.to_jid],
  );
}

const countBy = (rows, key) => rows.reduce((m, r) => ({ ...m, [r[key]]: (m[r[key]] || 0) + 1 }), {});

async function afterBatchChange(rows) {
  for (const t of new Set(rows.map((r) => r.task_id).filter(Boolean))) await refreshTask(t).catch(() => {});
  const lists = [...new Set(rows.map((r) => r.list_id).filter(Boolean))];
  if (lists.length) {
    const l = await import('./lists.js');
    for (const id of lists) await l.refreshList(id).catch(() => {});
  }
}

/** Save new wording for a draft without approving it (the Drafts page saves as you type). */
export async function editDraft(id, text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('The message is empty');
  const [row] = await query(`SELECT * FROM outbox WHERE id = $1`, [id]);
  if (!row) throw new Error('Draft not found');
  if (row.status !== 'draft') throw new Error(`Item is ${row.status}, not a draft — it can't be edited any more`);
  if (row.payload.waTemplate) throw new Error('This is a Meta template message — its wording is fixed by Meta');
  const payload = { ...row.payload };
  if (payload.attachment && !payload.text) payload.attachment = { ...payload.attachment, caption: text };
  else payload.text = text;
  const [u] = await query(`UPDATE outbox SET payload = $2 WHERE id = $1 AND status = 'draft' RETURNING *`, [id, JSON.stringify(payload)]);
  if (!u) throw new Error('Draft was already handled');
  return u;
}

/** The owner's note on several drafts → one card for the AI listing them (it edits or redrafts them; the owner approves). */
export async function draftsNoteForAi(ids, text, { actor = 'you' } = {}) {
  const list = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!list.length) throw new Error('Select at least one draft');
  if (!String(text || '').trim()) throw new Error('Write the note first');
  const rows = await query(`SELECT o.*, c.name AS to_name FROM outbox o LEFT JOIN contacts c ON c.account_id = o.account_id AND c.jid = o.to_jid
    WHERE o.id = ANY($1::bigint[]) AND o.status = 'draft' ORDER BY o.id`, [list]);
  if (!rows.length) throw new Error('None of these are drafts any more');
  const counts = {};
  for (const r of rows) counts[r.account_id] = (counts[r.account_id] || 0) + 1;
  const account = Object.entries(counts).sort((x, y) => y[1] - x[1])[0][0];
  const note = String(text).trim();
  const lines = rows.map((r) => `- draft #${r.id} on ${r.account_id} to ${r.to_jid.split('@')[0]}${r.to_name ? ` (${r.to_name})` : ''}: "${String(r.payload.text || r.payload.attachment?.caption || '').replace(/\s+/g, ' ').slice(0, 90)}…"`);
  const task = await createTask({
    account, kind: 'todo', assignee: 'ai', dueAt: new Date().toISOString(), createdBy: actor,
    title: `Owner: ${note.replace(/\s+/g, ' ').slice(0, 70)} (${rows.length} drafts)`,
    details: `${note}\n\nDrafts:\n${lines.join('\n')}\n\nChange each draft as the note asks with edit_draft(id, text) (keeps its picture and send time), or reject_draft + a new draft if it must change more. Leave them as drafts for the owner to approve, then mark this card done.`,
  });
  return { drafts: rows.length, task };
}

export async function reject(id, { reason = '', actor = 'you' } = {}) {
  const [row] = await query(
    `UPDATE outbox SET status = 'rejected' WHERE id = $1 AND status IN ('draft','queued') RETURNING *`,
    [id],
  );
  if (!row) throw new Error('Nothing to reject (already sent?)');
  await noteRejection([row], { reason, actor });
  await afterBatchChange([row]); // its task and list show the change at once
  return row;
}

export async function listOutbox({ account, status, taskId, limit = 50, role } = {}) {
  const p = [];
  const where = [];
  if (role) {
    p.push(role);
    where.push(roleFilter(`COALESCE(o.role, ${roleOf('o.account_id', 'o.to_jid')})`, p.length));
  }
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
    `SELECT o.*, COALESCE(NULLIF(ct.name, ''), NULLIF(lm.name, ''), ct.notify, ch.name) AS to_name, t.title AS task_title,
       COALESCE(o.role, ${roleOf('o.account_id', 'o.to_jid')}) AS campaign
     FROM outbox o
     LEFT JOIN list_members lm ON lm.list_id = o.list_id AND lm.jid = o.to_jid
     LEFT JOIN contacts ct ON ct.account_id = o.account_id AND ct.jid = o.to_jid
     LEFT JOIN chats ch ON ch.account_id = o.account_id AND ch.jid = o.to_jid
     LEFT JOIN tasks t ON t.id = o.task_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY o.id DESC LIMIT $${p.length}`,
    p,
  );
}

/**
 * Is this number reaching out to NEW people today? True if a first-contact message (bulk/AI to someone this number
 * never chatted with, not a follow-up) was sent today, is queued, or was drafted in the last 24 h. Follow-ups wait
 * for days when this is true. Replies to people already in a chat don't count (a pending AI reply draft used to
 * hold every follow-up back), nor does a forgotten old draft.
 */
export async function newOutreachToday(accountId) {
  const [r] = await query(
    `SELECT 1 FROM outbox o WHERE o.account_id = $1 AND o.source = ANY($2) AND o.note IS DISTINCT FROM 'follow-up'
       AND o.to_jid NOT LIKE '%@g.us'
       AND (((o.status IN ('queued','sending') OR (o.status = 'draft' AND o.created_at > now() - interval '24 hours'))
             AND ${IS_NEW_CHAT('o.account_id', 'o.to_jid')})
            OR (o.status = 'sent' AND o.sent_at >= (date_trunc('day', now() AT TIME ZONE $3) AT TIME ZONE $3)
                AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.account_id = o.account_id AND x.chat_jid = o.to_jid
                                AND x.ts < extract(epoch FROM o.sent_at)::bigint - 60)))
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

/**
 * Automated messages sent in the last 24 hours (rolling — a midnight reset let 48 new numbers through in 24 h).
 * Replies to people who wrote in the last 24 h don't count: they aren't outreach and go out at once.
 */
async function automatedSentToday(accountId) {
  const [r] = await query(
    `SELECT count(*)::int AS n FROM outbox
     WHERE account_id = $1 AND source = ANY($2) AND status IN ('sent','sending') AND NOT is_reply AND sent_at > now() - interval '24 hours'`,
    [accountId, AUTOMATED],
  );
  return r.n;
}

// A chat with no message at all in it yet = a NEW number for this WhatsApp account.
const IS_NEW_CHAT = (acc, jid) => `NOT EXISTS (SELECT 1 FROM messages x WHERE x.account_id = ${acc} AND x.chat_jid = ${jid})`;
// They wrote to this number in the last 24 hours: our message is a reply (not outreach). Approved replies skip the
// automated daily cap and the random gap, and go before queued bulk messages. The new-number limit is unaffected.
const IS_REPLY = (acc, jid) => `EXISTS (SELECT 1 FROM messages y WHERE y.account_id = ${acc} AND y.chat_jid = ${jid} AND NOT y.from_me
  AND y.ts > extract(epoch FROM now())::bigint - 86400)`;

/**
 * New numbers this account started a chat with in the last 24 hours (rolling), from any source — the hub, the
 * phone itself, other linked devices: chats whose very first message is ours and was sent in the window.
 * Returns { count, limit, nextFreeAt } — nextFreeAt = when the oldest of them leaves the window.
 */
export async function newChatsStatus(accountId, settings) {
  const since = Math.floor(Date.now() / 1000) - 24 * 3600;
  const [r] = await query(
    `SELECT count(*)::int AS n, min(f)::bigint AS oldest FROM (
       SELECT chat_jid, min(ts) AS f FROM messages
       WHERE account_id = $1 AND from_me AND ts > $2 AND chat_jid NOT LIKE '%@g.us' AND chat_jid NOT LIKE '%broadcast%' AND chat_jid NOT LIKE '%@newsletter'
       GROUP BY chat_jid) m
     WHERE NOT EXISTS (SELECT 1 FROM messages x WHERE x.account_id = $1 AND x.chat_jid = m.chat_jid AND x.ts < m.f)`,
    [accountId, since],
  );
  const cloud = manager.sessions.get(accountId)?.isCloud;
  const limit = Math.min(cloud ? CLOUD_NEW_CHATS_MAX : NEW_CHATS_HARD_MAX, settings?.newChatsPer24h ?? NEW_CHATS_HARD_MAX);
  return { count: r.n, limit, nextFreeAt: r.n >= limit && r.oldest ? new Date((Number(r.oldest) + 24 * 3600) * 1000) : null };
}

/** WhatsApp itself has put a temporary block on messaging new people ("reach-out timelock")? */
function whatsappBlocksNewChats(session) {
  const l = session.reachout;
  return !!(l?.isActive && (!l.timeEnforcementEnds || new Date(l.timeEnforcementEnds) > new Date()));
}

/** Throws a clear error if a message to this person would cross the new-number limit right now. */
export async function assertNewChatAllowed(session, jid) {
  if (jid.endsWith('@g.us')) return;
  const [known] = await query('SELECT 1 FROM messages WHERE account_id = $1 AND chat_jid = $2 LIMIT 1', [session.id, jid]);
  if (known) return;
  if (whatsappBlocksNewChats(session)) {
    const until = session.reachout.timeEnforcementEnds ? new Date(session.reachout.timeEnforcementEnds).toLocaleString('en-IN', { timeZone: config.tz }) : 'WhatsApp lifts it';
    throw new Error(`WhatsApp has blocked "${session.account.label}" from messaging new numbers until ${until}`);
  }
  const st = await newChatsStatus(session.id, session.settings);
  if (st.count >= st.limit) {
    throw new Error(`New-number limit reached on "${session.account.label}": ${st.count} new numbers in the last 24 hours (limit ${st.limit}). Next free slot ${st.nextFreeAt ? st.nextFreeAt.toLocaleString('en-IN', { timeZone: config.tz }) : 'soon'}`);
  }
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

/**
 * A Meta template message: check it now (exists, approved, every {{n}} filled) and keep the text the person will
 * see as payload.text — drafts show it, and a linked number it is moved to sends that text instead.
 */
export async function withTemplatePreview(session, payload, { allowPending = true } = {}) {
  if (!payload.waTemplate?.name) throw new Error('waTemplate needs the Meta template name');
  if (!session.isCloud) {
    if (!payload.text) throw new Error(`"${session.account.label}" is a linked number — Meta templates are only for Meta Cloud API numbers; send text instead`);
    return payload;
  }
  const { buildTemplateMessage } = await import('./wa/cloud-templates.js');
  // A template still in Meta's review may be queued: it waits at send time until Meta approves it.
  const t = await buildTemplateMessage(session.wabaId, payload.waTemplate, { allowPending });
  return { ...payload, text: t.preview, waTemplate: { ...payload.waTemplate, language: t.template.language.code } };
}

async function buildContent(payload, session) {
  if (payload.waTemplate && session?.isCloud) return { waTemplate: payload.waTemplate };
  const buttons = (payload.buttons || []).filter(Boolean);
  if (!payload.attachment) {
    if (buttons.length && session?.isCloud) return { text: payload.text, buttons };
    // Linked numbers: WhatsApp doesn't show buttons from unofficial clients reliably → list the answers instead.
    return { text: buttons.length ? `${payload.text}\n\nReply: ${buttons.join(' / ')}` : payload.text };
  }
  const a = payload.attachment;
  const file = await loadOutgoing(a);
  const caption = a.caption ?? payload.text ?? undefined;
  const as = a.as || (file.mimetype.startsWith('image/') ? 'image' : file.mimetype.startsWith('video/') ? 'video' : file.mimetype.startsWith('audio/') ? 'audio' : 'document');
  // fileName rides along so a Meta number that must send an image/video as a document keeps the real name
  const name = session?.isCloud ? { fileName: file.fileName } : {};
  if (as === 'image') return { image: file.buffer, mimetype: file.mimetype, caption, ...name };
  if (as === 'video') return { video: file.buffer, mimetype: file.mimetype, caption, ...name };
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

/**
 * Plain answer to "why is this waiting, and when will it go?" for one number's queue: counts, the limit that
 * currently holds messages back (if any), when it frees up, and roughly how long the whole queue takes.
 */
export async function queueStatus(accountId) {
  const session = manager.get(accountId);
  const s = session.settings;
  const [q] = await query(
    `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
            count(*) FILTER (WHERE status = 'draft')::int AS drafts,
            count(*) FILTER (WHERE status = 'queued' AND source = ANY($2) AND NOT ${IS_REPLY('$1', 'o.to_jid')})::int AS queued_automated,
            count(*) FILTER (WHERE status = 'queued' AND to_jid NOT LIKE '%@g.us' AND ${IS_NEW_CHAT('$1', 'o.to_jid')})::int AS queued_new
     FROM outbox o WHERE account_id = $1 AND status IN ('queued','draft')`,
    [accountId, AUTOMATED],
  );
  const [a] = await query(
    `SELECT count(*)::int AS n, min(sent_at) AS oldest FROM outbox
     WHERE account_id = $1 AND source = ANY($2) AND status IN ('sent','sending') AND NOT is_reply AND sent_at > now() - interval '24 hours'`,
    [accountId, AUTOMATED],
  );
  const nc = await newChatsStatus(accountId, s);
  const blocked = whatsappBlocksNewChats(session);
  const capFreeAt = a.n >= s.dailyCap && a.oldest ? new Date(new Date(a.oldest).getTime() + 24 * 3600e3) : null;
  const nextAt = workers.get(accountId)?.nextAt?.() || 0;
  let state = 'sending';
  let reason = '';
  let until = null;
  if (!q.queued) state = 'idle';
  else if (!session.account.enabled) { state = 'held'; reason = 'Number is paused (Settings)'; }
  else if (session.status !== 'open') { state = 'held'; reason = `Number is not connected (${session.status}) — messages go out once it is`; }
  else if (q.queued_automated && !insideSendingWindow(s)) { state = 'held'; reason = `Outside sending hours (${s.sendStart}–${s.sendEnd})`; }
  else if (q.queued_automated && a.n >= s.dailyCap) { state = 'held'; reason = `Automated limit reached: ${a.n} of ${s.dailyCap} in the last 24 hours`; until = capFreeAt; }
  else if (q.queued_new && blocked) { state = 'held'; reason = 'WhatsApp blocks messages to new numbers for now'; until = session.reachout.timeEnforcementEnds ? new Date(session.reachout.timeEnforcementEnds) : null; }
  else if (q.queued_new && q.queued_new === q.queued && nc.count >= nc.limit) { state = 'held'; reason = `New-number limit reached: ${nc.count} of ${nc.limit} in the last 24 hours`; until = nc.nextFreeAt; }
  else if (nextAt > Date.now()) { reason = 'Waiting the random gap between messages'; until = new Date(nextAt); }
  // Rough finish time: what each rolling 24 h allows, from here on.
  const perDay = Math.max(1, Math.min(s.dailyCap, q.queued_new ? nc.limit : Infinity));
  const days = q.queued ? Math.ceil(q.queued / perDay) : 0;
  return {
    account: accountId, label: session.account.label, connection: session.status, state, reason, until,
    queued: q.queued, drafts: q.drafts, queuedNew: q.queued_new,
    automated24h: a.n, dailyCap: s.dailyCap, newChats: nc, perDay, days,
    gapSec: [s.delayMinSec, s.delayMaxSec],
  };
}

const holdNoted = new Map(); // accountId -> until (ms): log "limit reached" once per hold
const notedOnce = new Map();
/** Activity entry at most once an hour per key (e.g. "waiting for template approval"). */
async function noteOnce(accountId, key, text) {
  const k = `${accountId}|${key}`;
  if (Date.now() - (notedOnce.get(k) || 0) < 3600e3) return;
  notedOnce.set(k, Date.now());
  await logEvent(accountId, 'info', text);
}

/** Activity entry (once per hold) explaining why messages to new numbers are waiting. */
async function noteNewChatHold(accountId, reachout, nc) {
  const until = reachout?.timeEnforcementEnds ? new Date(reachout.timeEnforcementEnds) : nc.nextFreeAt;
  const key = until ? until.getTime() : 1;
  if (holdNoted.get(accountId) === key) return;
  holdNoted.set(accountId, key);
  const when = until ? until.toLocaleString('en-IN', { timeZone: config.tz }) : 'later';
  const [w] = await query(`SELECT count(*)::int n FROM outbox o WHERE account_id = $1 AND status = 'queued' AND ${IS_NEW_CHAT('$1', 'o.to_jid')}`, [accountId]);
  await logEvent(accountId, 'warn', reachout
    ? `WhatsApp has blocked messages to new numbers until ${when}. ${w.n} messages to new numbers wait; chats with people you already talk to continue.`
    : `New-number limit reached: ${nc.count} new numbers in the last 24 hours (limit ${nc.limit}). ${w.n} messages to new numbers wait until about ${when}.`);
}

function startWorker(accountId) {
  let wakeUp = () => {};
  let nextAutomatedAt = 0; // random gap applies between automated messages only
  workers.set(accountId, { wake: () => wakeUp(), nextAt: () => nextAutomatedAt });
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
    // New numbers: never more than the limit in any 24 hours, and nothing while WhatsApp blocks new chats.
    const nc = await newChatsStatus(accountId, s);
    const blocked = whatsappBlocksNewChats(session);
    const newChatsAllowed = !blocked && nc.count < nc.limit;
    if (!newChatsAllowed) await noteNewChatHold(accountId, blocked ? session.reachout : null, nc);
    // Claim one row atomically, so two servers can never pick the same message.
    const [row] = await query(
      `UPDATE outbox SET status = 'sending', sent_at = now(), is_reply = ${IS_REPLY('outbox.account_id', 'outbox.to_jid')} WHERE id = (
         SELECT id FROM outbox WHERE account_id = $1 AND status = 'queued' AND scheduled_at <= now()
           AND ($2 OR source <> ALL($3) OR ${IS_REPLY('$1', 'outbox.to_jid')})
           AND (note IS DISTINCT FROM 'follow-up' OR $4)
           AND ($5 OR to_jid LIKE '%@g.us' OR NOT ${IS_NEW_CHAT('$1', 'outbox.to_jid')})
         ORDER BY ${IS_REPLY('$1', 'outbox.to_jid')} DESC, priority DESC, id LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [accountId, automatedAllowed, AUTOMATED, followupsAllowed, newChatsAllowed],
    );
    if (!row) {
      // Wait for new work, or until the random gap ends, whichever is first.
      const wait = !gapOver ? Math.max(1000, nextAutomatedAt - Date.now()) : automatedAllowed ? 60000 : 5 * 60000;
      // Poll at least every 10 s: approvals/jobs may come from another server, which can't wake us.
      await nap(Math.min(wait, 10000));
      return;
    }
    // An automatic retry (Meta said "try later") is dropped if the person has written to us since:
    // the conversation moved on, so the old message would be out of place.
    if (row.retries > 0) {
      const [wrote] = await query(
        `SELECT 1 FROM messages WHERE account_id = $1 AND chat_jid = $2 AND NOT from_me AND ts >= extract(epoch FROM $3::timestamptz) LIMIT 1`,
        [accountId, row.to_jid, row.created_at],
      );
      if (wrote) {
        await query(`UPDATE outbox SET status = 'rejected', error = 'Not retried: they wrote to us in the meantime' WHERE id = $1`, [row.id]);
        if (row.task_id) await refreshTask(row.task_id).catch(() => {});
        return;
      }
    }
    const automated = AUTOMATED.includes(row.source);
    let result;
    let sent;
    let sendError;
    try {
      const content = await buildContent(row.payload, session);
      const textLen = (row.payload.text || '').length;
      // "typing…" is for AI/bulk messages; your own and Apps Script sends go out straight away
      const typingMs = automated && s.typing ? Math.min(6000, Math.max(1500, textLen * 40)) : 0;
      const quoted = row.payload.replyTo ? await quotedMessage(session.id, row.to_jid, row.payload.replyTo) : undefined;
      sent = await session.send(row.to_jid, content, { typingMs, quoted });
    } catch (err) {
      sendError = err;
    }
    // Recording the result is separate from sending: if the database hiccups here, the row stays "sending" and
    // the sweep marks it sent (it finds the message in the chat) — a delivered message is never called "failed".
    if (sendError?.code === 'TEMPLATE_PENDING') {
      // Meta hasn't approved the template yet: keep it queued and look again in 15 minutes (nothing is lost).
      await query(`UPDATE outbox SET status = 'queued', sent_at = NULL, scheduled_at = now() + interval '15 minutes', error = $2 WHERE id = $1`,
        [row.id, 'Waiting for Meta to approve the template — retried every 15 minutes']);
      await noteOnce(accountId, `pending:${row.payload.waTemplate?.name}`, `Messages using Meta template "${row.payload.waTemplate?.name}" wait until Meta approves it (checked every 15 min)`);
      // In case Meta's approval webhook was missed, ask Meta directly (at most every 10 minutes).
      const k = `${accountId}|tplsync`;
      if (Date.now() - (notedOnce.get(k) || 0) > 600e3) {
        notedOnce.set(k, Date.now());
        import('./wa/cloud-templates.js').then((t) => t.syncTemplates(session.wabaId)).catch(() => {});
      }
      return;
    }
    if (sendError) {
      [result] = await query(`UPDATE outbox SET status = 'failed', error = $2 WHERE id = $1 RETURNING *`, [row.id, sendError.message]);
      await logEvent(accountId, 'warn', `Send to ${row.to_jid.split('@')[0]} failed: ${sendError.message}`);
    } else {
      [result] = await query(
        `UPDATE outbox SET status = 'sent', sent_at = now(), message_id = $2, error = NULL WHERE id = $1 RETURNING *`,
        [row.id, sent?.key?.id || null],
      );
      if (row.list_id) await rememberName(accountId, row).catch(() => {});
    }
    done.emit(String(row.id), result);
    if (row.task_id) await refreshTask(row.task_id).catch(() => {});
    if (row.list_id) import('./lists.js').then((l) => l.refreshList(row.list_id)).catch(() => {});
    if (session.isCloud) {
      // Meta's API has no human-pace rule (throughput is ~80 messages/s per number): no random gap, just a short
      // breather so the database and Render keep up.
      await sleep(250 * config.timeScale);
      return;
    }
    if (automated && !row.is_reply) nextAutomatedAt = Date.now() + randomDelayMs(s) * config.timeScale;
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
  // If WhatsApp has our message in that chat since the send started, it did go out (only the "sent" note was
  // lost, e.g. a database hiccup) — mark it sent, so it is never re-sent as "failed".
  const went = await query(
    `WITH found AS (
       SELECT o.id, (SELECT x.id FROM messages x WHERE x.account_id = o.account_id AND x.chat_jid = o.to_jid AND x.from_me
                     AND x.ts >= extract(epoch FROM o.sent_at)::bigint - 5 ORDER BY x.ts LIMIT 1) AS msg
       FROM outbox o WHERE o.status = 'sending' AND o.sent_at < now() - interval '4 minutes')
     UPDATE outbox SET status = 'sent', message_id = found.msg, error = NULL
     FROM found WHERE outbox.id = found.id AND found.msg IS NOT NULL RETURNING outbox.task_id, outbox.list_id`,
  );
  const rows = await query(
    `UPDATE outbox SET status = 'failed', error = 'Interrupted (server restart) — check the chat before resending'
     WHERE status = 'sending' AND sent_at < now() - interval '4 minutes' RETURNING task_id, list_id`,
  );
  await afterBatchChange([...went, ...rows]);
}

export async function startOutbox() {
  await sweepStuck();
  // Names for people messaged from lists (also those moved between numbers before this existed).
  await query(
    `INSERT INTO contacts (account_id, jid, phone, name)
     SELECT DISTINCT ON (o.account_id, o.to_jid) o.account_id, o.to_jid, m.phone, m.name
     FROM outbox o JOIN list_members m ON m.list_id = o.list_id AND m.jid = o.to_jid
     WHERE COALESCE(m.name, '') <> ''
     ON CONFLICT (account_id, jid) DO UPDATE SET name = COALESCE(NULLIF(contacts.name, ''), EXCLUDED.name)`,
  ).catch((err) => logger.warn({ err: err.message }, 'name backfill failed'));
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

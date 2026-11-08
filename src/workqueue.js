// The AI's work queue (8 Nov 2026).
//
// Why: one long AI run that sweeps the whole hub stops when it feels done (8 Nov: two runs quit after ~40 turns with 100+
// chats waiting), and anything it did not reach waits for the next sweep. Instead, every event that may need the AI
// becomes ONE small job for ONE person: they wrote to us; the owner answered them from the phone while a card was still
// open (so the agreement must be recorded); the owner left a note on a card, marked it Done for review, or rejected a
// draft with a reason. An AI session takes the next job with everything it needs in one packet (next_job), acts, and
// closes it (finish_job). Nothing is lost: an unfinished job waits for the next session; one open job per person per
// number, refreshed (and delayed a few minutes) while the conversation is still moving.
import { query, logEvent } from './db.js';
import { manager } from './wa/manager.js';
import { roleOf } from './campaign.js';
import { personPacket, openCardLines } from './packet.js';

const KIND_WORDS = {
  message: 'they wrote to us',
  owner_replied: 'the owner answered from the phone — record what was agreed, keep the cards true',
  card: 'the owner left an instruction on a card (note, Done for review, or a rejection reason)',
};

async function ownPhones() {
  const { alertPhones } = await import('./notify.js');
  return [...manager.list().map((a) => a.phone), ...(await alertPhones().catch(() => []))].filter(Boolean)
    .map((x) => String(x).replace(/\D/g, '')).flatMap((x) => (x.length === 10 ? [x, '91' + x] : [x]));
}

/** Add (or refresh) the job for one person. Returns the job id, or null when nothing was queued. */
export async function enqueueJob({ account, jid = null, kind = 'message', reason = '', taskId = null, priority = 0, delayMinutes = 3 }) {
  if (!account || (!jid && !taskId)) return null;
  if (jid && (!/@s\.whatsapp\.net$|@bsuid$/.test(jid))) return null; // groups, broadcasts, newsletters: never
  if (jid && (await ownPhones()).includes(jid.split('@')[0])) return null; // the hub's own numbers and the owner's phones
  const due = new Date(Date.now() + Math.max(0, delayMinutes) * 60000).toISOString();
  const why = String(reason || '').replace(/\s+/g, ' ').slice(0, 300);
  // one open, unclaimed job per person (or per card): a new trigger refreshes it and gives the conversation time to settle
  const [open] = await query(
    `SELECT id FROM ai_jobs WHERE account_id = $1 AND done_at IS NULL AND claimed_at IS NULL
       AND ((chat_jid IS NOT NULL AND chat_jid = $2) OR (chat_jid IS NULL AND task_id = $3)) ORDER BY id DESC LIMIT 1`, [account, jid, taskId]);
  if (open) {
    await query(
      `UPDATE ai_jobs SET due_at = GREATEST(due_at, $2::timestamptz), priority = GREATEST(priority, $3),
         kind = CASE WHEN kind = 'message' THEN $4 ELSE kind END, task_id = COALESCE($5, task_id),
         reason = left(CASE WHEN reason LIKE '%' || $6 || '%' THEN reason ELSE reason || ' | ' || $6 END, 600)
       WHERE id = $1`, [open.id, due, priority, kind, taskId, why]);
    return open.id;
  }
  const [row] = await query(
    `INSERT INTO ai_jobs (account_id, chat_jid, kind, task_id, reason, priority, due_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [account, jid, kind, taskId, why, priority, due]);
  return row.id;
}

/** Is this person someone the hub is working with (on a list, or with an open card)? Owner replies to others need no job. */
export async function isTracked(accountId, jid) {
  const phone = jid.split('@')[0];
  const [r] = await query(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM list_members lm JOIN lists l ON l.id = lm.list_id WHERE lm.jid = $1 AND l.archived IS NULL)
        OR EXISTS (SELECT 1 FROM tasks t WHERE t.status NOT IN ('done','cancelled') AND (t.ref LIKE '%:' || $1 OR t.title LIKE '%' || $2 || '%'))`,
    [jid, phone.slice(-10)]);
  return !!r;
}

/** Jobs ready now (for hub_overview's verdict). */
export async function readyCount() {
  const [r] = await query(`SELECT count(*)::int n FROM ai_jobs WHERE done_at IS NULL AND due_at <= now() AND (claimed_at IS NULL OR claimed_at < now() - interval '30 minutes')`);
  return r.n;
}

/** Jobs nobody took for 3 days are dropped with a note (the chat is still in the inbox; the 4-hourly run sees it). */
export async function expireOld() {
  const rows = await query(`UPDATE ai_jobs SET done_at = now(), result = 'expired: not taken for 3 days' WHERE done_at IS NULL AND created_at < now() - interval '3 days' RETURNING id`);
  if (rows.length) await logEvent(null, 'warn', `${rows.length} AI job(s) expired untaken (3 days) — is the hourly routine running?`, 'system');
  return rows.length;
}

/** Claim the most important job that is due and return its packet (text), or null. */
export async function nextJob() {
  await expireOld().catch(() => {});
  const [job] = await query(
    `UPDATE ai_jobs SET claimed_at = now() WHERE id = (
       SELECT id FROM ai_jobs WHERE done_at IS NULL AND due_at <= now() AND (claimed_at IS NULL OR claimed_at < now() - interval '30 minutes')
       ORDER BY priority DESC, due_at, id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`);
  if (!job) return null;
  const [left] = await query(`SELECT count(*)::int n FROM ai_jobs WHERE done_at IS NULL AND due_at <= now() AND id <> $1`, [job.id]);
  const lines = [];
  let name = '';
  let campaign = null;
  if (job.chat_jid) {
    const [nm] = await query(
      `SELECT COALESCE(NULLIF(ct.saved_name, ''), NULLIF(ct.name, ''), NULLIF(ch.name, ''), (SELECT NULLIF(m.name, '') FROM list_members m WHERE m.jid = $2 AND COALESCE(m.name, '') <> '' LIMIT 1), ct.notify) AS name
       FROM (SELECT 1) x LEFT JOIN contacts ct ON ct.account_id = $1 AND ct.jid = $2 LEFT JOIN chats ch ON ch.account_id = $1 AND ch.jid = $2`, [job.account_id, job.chat_jid]).catch(() => []);
    name = nm?.name || '';
    const [c] = await query(`SELECT ${roleOf(`'${job.account_id}'`, `'${job.chat_jid}'`)} AS campaign`).catch(() => []);
    campaign = c?.campaign || null;
  }
  const who = job.chat_jid ? `${name ? `${name} ` : ''}(+${job.chat_jid.split('@')[0]})` : `card #${job.task_id}`;
  lines.push(`JOB #${job.id} — ${KIND_WORDS[job.kind] || job.kind} · number ${job.account_id} · ${who}${campaign ? ` · campaign ${campaign}` : ' · no campaign'}${left.n ? ` · ${left.n} more job(s) waiting after this one` : ' · last job for now'}`);
  lines.push(`WHY: ${job.reason || '-'}`);
  lines.push(`RULES: the main playbook once per session; ${campaign ? `get_playbook(campaign="${campaign}", campaign_only=true) once per campaign per session` : 'main playbook rule 20 (a chat on no list: reply, owner card, put on a list, or nothing)'}.`);
  if (job.chat_jid) {
    const cards = await openCardLines(job.account_id, job.chat_jid, { indent: '  ' });
    lines.push(cards.length ? 'OPEN CARDS about this person:' : 'OPEN CARDS about this person: none', ...cards);
    lines.push(...await personPacket(job.account_id, job.chat_jid, { messages: 12, indent: '  ' }));
  } else if (job.task_id) {
    const [t] = await query(`SELECT id, title, details, status, assignee, account_id FROM tasks WHERE id = $1`, [job.task_id]);
    if (t) lines.push(`CARD #${t.id} [${t.status}] for ${t.assignee === 'ai' ? 'AI' : 'owner'}: ${t.title}`, `  DETAILS: ${String(t.details || '').replace(/\s+/g, ' ').slice(0, 600)}`, '  task_history(id) shows every note.');
  }
  lines.push('DO, then finish_job(id, summary):',
    '  - they are waiting for an answer → ONE draft with send_message on this number (name or gender unclear → see_person first; never "Sir / Madam"); nothing to answer → no message',
    '  - the owner already answered from the phone, or a decision is in a note → RECORD it: update_list_member (visit_at / follow_up_at / stage + outcome), add_task_note + update_task done on the cards above',
    '  - the owner must act (price, discount, decision, call, bill) → create_task(for="you") with the number in the title (unless a card above already says so)',
    '  - a job seeker, guest, patient, corporate or agent not on a list yet → import_list onto their campaign\'s list with follow_up_at',
    '  - staff, family, vendor, bank, delivery, platform, or already handled → nothing',
    `  - finish_job(${job.id}, "<what you did in one line, with draft/card numbers>") — a job left open comes back to the next session.`);
  return { id: job.id, text: lines.join('\n') };
}

export async function finishJob(id, summary = '') {
  const [row] = await query(`UPDATE ai_jobs SET done_at = now(), result = left($2, 500) WHERE id = $1 AND done_at IS NULL RETURNING id, account_id, chat_jid, kind`, [id, String(summary || 'done')]);
  if (!row) throw new Error(`Job #${id} is not open (finished already, or no such job)`);
  await logEvent(row.account_id, 'info', `AI job #${row.id} (${row.kind}${row.chat_jid ? `, ${row.chat_jid.split('@')[0]}` : ''}) done: ${String(summary || '').slice(0, 160)}`, 'ai').catch(() => {});
  return row;
}

/** For the dashboard / overview: how the queue looks. */
export async function queueStats() {
  const [r] = await query(`SELECT count(*) FILTER (WHERE done_at IS NULL AND due_at <= now())::int ready,
      count(*) FILTER (WHERE done_at IS NULL AND due_at > now())::int settling,
      count(*) FILTER (WHERE done_at IS NULL AND claimed_at > now() - interval '30 minutes')::int in_hand,
      count(*) FILTER (WHERE done_at > now() - interval '24 hours')::int done_24h FROM ai_jobs`);
  return r;
}

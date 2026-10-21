/**
 * Contact lists (e.g. "Chef candidates – Batch 5") with per-person status and automatic follow-ups.
 *
 * The status of each person is worked out from the real WhatsApp messages of the list's number,
 * not from bookkeeping — so it is right even for messages sent from the phone, an Excel macro, etc.:
 *   new        not messaged since the list's start date
 *   queued     a message is waiting (draft or queued) in the outbox
 *   sent       messaged, no reply yet
 *   replied    wrote back after our first message
 *   failed     our last send attempt failed (error kept)
 *   opted_out  tagged opted-out (said "stop", etc.)
 * "outcome" is separate and set by you or the AI: interested, not interested, trial booked, hired…
 */
import { query, insertMany, logEvent } from './db.js';
import { toJid } from './store.js';
import { manager } from './wa/manager.js';
import * as outbox from './outbox.js';
import { createTask, refreshTask, fillTemplate } from './tasks.js';
import { getTemplate } from './templates.js';
import { afterTime } from './settings.js';

export const STATUSES = ['new', 'queued', 'sent', 'replied', 'failed', 'opted_out'];

/** Undo URL-encoding left in spreadsheet messages (e.g. "%0A" for line breaks from wa.me links). */
export function decodeMessage(text) {
  if (!text) return text;
  return String(text).replace(/(%[0-9A-Fa-f]{2})+/g, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });
}

const DEFAULT_FOLLOWUP = { enabled: false, afterDays: 2, max: 1, text: '', template: '', quietDaysOnly: true };

/**
 * What to send one person from this number. A Meta Cloud API number may send free text only within 24 h of the
 * person's last message; otherwise the Meta template given for this step is used (filled per person), and without
 * one the person is skipped with the reason. Linked numbers always send the text.
 */
async function payloadFor(session, jid, text, waTemplate, vars, extra = {}) {
  if (session?.isCloud && (!text || !(await session.windowFor(jid)).open)) {
    if (!waTemplate?.name) return { skip: 'Meta number: more than 24 h since they wrote, and no Meta template is set for this step' };
    try {
      return { payload: await outbox.withTemplatePreview(session, { waTemplate: outbox.fillWaTemplate(waTemplate, vars) }) };
    } catch (err) {
      return { skip: err.message };
    }
  }
  return { payload: { text, ...extra } };
}

/** Funnel stages (set by you or the AI). Closed ones are never messaged again from the list. */
export const STAGES = ['interested', 'date_given', 'visited', 'trial', 'selected', 'joined', 'no_show', 'not_interested', 'rejected'];
export const CLOSED_STAGES = ['joined', 'not_interested', 'rejected'];
const DEFAULT_PIPELINE = {
  enabled: true,
  autoSend: false, // false = reminders/questions wait for approval like other AI messages
  remindHoursBefore: 18,
  askDateAfterHours: 4,
  askDateText: 'Namaste {first_name} ji, aap kis din aa sakte hain? Date aur time bata dijiye. - Zenith Suites HR',
  reminderText: 'Namaste {first_name} ji, yaad dila rahe hain: aap {visit_date} ko Zenith Suites (Amrutha Halli) aa rahe hain. Koi problem ho to call karein: 9353315601. - Zenith Suites HR',
};

/** Outcomes that close a person: never messaged again from the list (no sends, no follow-ups). */
export const CLOSED_OUTCOME = /^\s*(rejected|not[\s-]?interested|hired|joined|do[\s-]?not[\s-]?contact)/i;
const CLOSED_SQL = `COALESCE(m.stage, '') NOT IN ('joined','not_interested','rejected') AND COALESCE(m.outcome, '') !~* '^\\s*(rejected|not[\\s-]?interested|hired|joined|do[\\s-]?not[\\s-]?contact)'`;

export async function getList(ref, account) {
  const isId = /^\d+$/.test(String(ref));
  const [l] = await query(
    `SELECT * FROM lists WHERE ${isId ? 'id = $1' : 'lower(name) = lower($1)'} AND ($2::text IS NULL OR account_id = $2)
     ORDER BY id DESC LIMIT 1`,
    [isId ? Number(ref) : String(ref), account || null],
  );
  if (!l) throw new Error(`No list "${ref}"`);
  return l;
}

/**
 * Create or extend a list. members: [{ phone, name, message?, ...anything else → fields }].
 * Existing members (same phone) are updated, not duplicated. `since` = messages before this date don't count.
 */
/** Guess the job role from a list name when none is given: "Chef candidates – Batch 6" → "Chef". */
export function roleFromName(name) {
  const n = String(name || '').toLowerCase();
  if (/chef|cook|kitchen/.test(n)) return 'Chef';
  if (/front\s*office|reception|front desk/.test(n)) return 'Front office';
  if (/housekeep|room\s*attendant|cleaner/.test(n)) return 'Housekeeping';
  if (/waiter|steward|server|f\s*&\s*b|service staff/.test(n)) return 'Service';
  if (/driver/.test(n)) return 'Driver';
  if (/security|guard/.test(n)) return 'Security';
  return null;
}

/**
 * Everyone already on a list of this role (any batch): for de-duplicating a new WorkIndia batch BEFORE
 * unlocking/messaging. Compact rows: name, phone, location, list, status, stage.
 */
export async function knownPeople(role, account) {
  return query(
    `SELECT m.name, m.phone, m.fields->>'Location' AS location, m.fields->>'Age' AS age, l.name AS list, m.status, m.stage
     FROM list_members m JOIN lists l ON l.id = m.list_id
     WHERE lower(l.role) = lower($1) AND ($2::text IS NULL OR l.account_id = $2)
     ORDER BY l.id, m.added_at`,
    [role, account || null],
  );
}

export async function importList({ account, name, role, since, source, members, followup, skipKnown = true }) {
  const s = await manager.resolve(account);
  if (!name?.trim()) throw new Error('A list needs a name');
  role = (role || roleFromName(name) || 'General').trim();
  const [list] = await query(
    `INSERT INTO lists (account_id, name, source, since, followup, role) VALUES ($1,$2,$3,COALESCE($4::timestamptz, now()),$5,$6)
     ON CONFLICT (account_id, name) DO UPDATE SET source = COALESCE(EXCLUDED.source, lists.source),
       since = COALESCE($4::timestamptz, lists.since), role = COALESCE(lists.role, EXCLUDED.role), updated_at = now()
     RETURNING *`,
    [s.id, name.trim(), source || null, since || null, JSON.stringify({ ...DEFAULT_FOLLOWUP, ...(followup || {}) }), role],
  );
  // People already on ANOTHER list of the same role are not added again (never re-message a past batch).
  const known = new Map();
  if (skipKnown) {
    const rows = await query(
      `SELECT m.jid, l.name AS list, m.status, m.stage FROM list_members m JOIN lists l ON l.id = m.list_id
       WHERE lower(l.role) = lower($1) AND l.account_id = $2 AND l.id <> $3`,
      [list.role, s.id, list.id],
    );
    for (const r of rows) known.set(r.jid, r);
  }
  const rows = [];
  const bad = [];
  const seen = new Set();
  for (const m of members || []) {
    const raw = m.phone ?? m.to ?? m.Phone ?? m['Phone Number'];
    const digits = String(raw ?? '').replace(/\D/g, '');
    if (digits.length < 10) {
      bad.push({ row: m.name || raw, reason: 'invalid phone' });
      continue;
    }
    const jid = toJid(raw);
    if (seen.has(jid)) continue;
    seen.add(jid);
    const k = known.get(jid);
    if (k) {
      bad.push({ row: m.name || raw, reason: `already in "${k.list}" (${k.stage || k.status})` });
      continue;
    }
    const { phone, to, name: nm, message, row, ...fields } = m;
    rows.push([list.id, jid, jid.split('@')[0], nm || fields.Name || null, JSON.stringify(fields), decodeMessage(message) || null, row != null ? String(row) : null]);
  }
  if (rows.length) {
    await insertMany('list_members', ['list_id', 'jid', 'phone', 'name', 'fields', 'message', 'row_ref'], rows,
      `ON CONFLICT (list_id, jid) DO UPDATE SET name = COALESCE(EXCLUDED.name, list_members.name),
         fields = list_members.fields || EXCLUDED.fields, message = COALESCE(EXCLUDED.message, list_members.message),
         row_ref = COALESCE(EXCLUDED.row_ref, list_members.row_ref), updated_at = now()`);
  }
  await refreshList(list.id);
  return { list, imported: rows.length, skipped: bad };
}

/** Recompute every member's status from the WhatsApp messages and the outbox (one query). */
// Messages from the list's number AND from any number its messages were moved to (e.g. when a number is blocked).
export async function refreshList(listId) {
  await query(
    `WITH l AS (SELECT id, account_id, extract(epoch FROM since)::bigint AS since,
       ARRAY(SELECT DISTINCT o.account_id FROM outbox o WHERE o.list_id = $1) || account_id AS accs FROM lists WHERE id = $1),
     m AS (
       SELECT lm.jid,
         (SELECT min(ts) FROM messages x, l WHERE x.account_id = ANY(l.accs) AND x.chat_jid = lm.jid AND x.from_me AND x.ts >= l.since) AS first_sent,
         (SELECT max(ts) FROM messages x, l WHERE x.account_id = ANY(l.accs) AND x.chat_jid = lm.jid AND x.from_me AND x.ts >= l.since) AS last_sent,
         (SELECT count(*) FROM messages x, l WHERE x.account_id = ANY(l.accs) AND x.chat_jid = lm.jid AND x.from_me AND x.ts >= l.since) AS sent_count
       FROM list_members lm WHERE lm.list_id = $1
     ),
     r AS (
       SELECT m.jid, m.first_sent, m.last_sent, m.sent_count,
         (SELECT max(ts) FROM messages x, l WHERE x.account_id = ANY(l.accs) AND x.chat_jid = m.jid AND NOT x.from_me AND x.ts >= m.first_sent) AS last_reply,
         (SELECT count(*) FROM messages x, l WHERE x.account_id = ANY(l.accs) AND x.chat_jid = m.jid AND NOT x.from_me AND x.ts >= m.first_sent) AS replies,
         (SELECT count(*) FROM outbox o WHERE o.list_id = $1 AND o.to_jid = m.jid AND o.status IN ('draft','queued','sending')) AS pending,
         (SELECT o.error FROM outbox o WHERE o.list_id = $1 AND o.to_jid = m.jid AND o.status = 'failed' ORDER BY o.id DESC LIMIT 1) AS last_error,
         (SELECT o.created_at FROM outbox o WHERE o.list_id = $1 AND o.to_jid = m.jid AND o.status = 'failed' ORDER BY o.id DESC LIMIT 1) AS failed_at,
         (SELECT count(*) FROM outbox o WHERE o.list_id = $1 AND o.to_jid = m.jid AND o.note = 'follow-up' AND o.status = 'sent') AS followups,
         EXISTS (SELECT 1 FROM contacts c, l WHERE c.account_id = ANY(l.accs) AND c.jid = m.jid AND 'opted-out' = ANY(c.tags)) AS opted_out
       FROM m
     )
     UPDATE list_members lm SET
       first_sent_at = to_timestamp(r.first_sent), last_sent_at = to_timestamp(r.last_sent),
       last_reply_at = to_timestamp(r.last_reply), replies = r.replies, followups_sent = r.followups,
       status = CASE
         WHEN r.opted_out THEN 'opted_out'
         WHEN r.replies > 0 THEN 'replied'
         WHEN r.pending > 0 THEN 'queued'
         WHEN r.first_sent IS NOT NULL AND (r.failed_at IS NULL OR to_timestamp(r.last_sent) > r.failed_at) THEN 'sent'
         WHEN r.last_error IS NOT NULL THEN 'failed'
         ELSE 'new' END,
       error = CASE WHEN r.first_sent IS NULL OR to_timestamp(r.last_sent) < r.failed_at THEN r.last_error END,
       updated_at = now()
     FROM r WHERE lm.list_id = $1 AND lm.jid = r.jid`,
    [listId],
  );
}

export async function listLists(account, role) {
  return query(
    `SELECT l.*, a.label AS account_label,
       count(m.*)::int AS total,
       count(*) FILTER (WHERE m.status = 'new')::int AS new,
       count(*) FILTER (WHERE m.status = 'queued')::int AS queued,
       count(*) FILTER (WHERE m.status = 'sent')::int AS sent,
       count(*) FILTER (WHERE m.status = 'replied')::int AS replied,
       count(*) FILTER (WHERE m.status = 'failed')::int AS failed,
       count(*) FILTER (WHERE m.status = 'opted_out')::int AS opted_out,
       count(*) FILTER (WHERE m.outcome IS NOT NULL)::int AS with_outcome
     FROM lists l JOIN accounts a ON a.id = l.account_id LEFT JOIN list_members m ON m.list_id = l.id
     WHERE ($1::text IS NULL OR l.account_id = $1) AND ($2::text IS NULL OR lower(l.role) = lower($2))
     GROUP BY l.id, a.label ORDER BY l.role NULLS LAST, l.id DESC`,
    [account || null, role || null],
  );
}

export async function listMembers(listId, { status, outcome, limit = 500 } = {}) {
  const p = [listId];
  const where = ['m.list_id = $1'];
  if (status) {
    p.push(String(status).split(','));
    where.push(`m.status = ANY($${p.length})`);
  }
  if (outcome) {
    p.push(outcome);
    where.push(`m.outcome = $${p.length}`);
  }
  p.push(Math.min(limit, 2000));
  return query(
    `SELECT m.*, (SELECT left(body, 200) FROM messages x, lists l WHERE l.id = m.list_id AND x.account_id = l.account_id
        AND x.chat_jid = m.jid AND NOT x.from_me ORDER BY ts DESC LIMIT 1) AS last_reply_text
     FROM list_members m WHERE ${where.join(' AND ')}
     ORDER BY CASE WHEN m.row_ref ~ '^[0-9]+$' THEN m.row_ref::int END NULLS LAST, m.added_at
     LIMIT $${p.length}`,
    p,
  );
}

export async function updateMember(listId, phoneOrJid, { outcome, notes, stage, visitAt }) {
  const jid = toJid(phoneOrJid);
  if (stage !== undefined && stage !== null && stage !== '' && !STAGES.includes(stage)) {
    throw new Error(`Stage must be one of: ${STAGES.join(', ')}`);
  }
  let visit = visitAt === undefined ? undefined : visitAt ? new Date(visitAt) : null;
  if (visit && isNaN(visit)) throw new Error('Could not read the visit date');
  if (visit && stage === undefined) stage = 'date_given'; // giving a date moves them to "date given"
  const [m] = await query(
    `UPDATE list_members SET
       outcome = CASE WHEN $3::text IS NULL THEN outcome WHEN $3 = '' THEN NULL ELSE $3 END,
       notes = COALESCE($4, notes),
       stage = CASE WHEN $5::text IS NULL THEN stage WHEN $5 = '' THEN NULL ELSE $5 END,
       stage_at = CASE WHEN $5::text IS NULL THEN stage_at ELSE now() END,
       visit_at = CASE WHEN $6::text = 'keep' THEN visit_at WHEN $6 = 'clear' THEN NULL ELSE $7::timestamptz END,
       reminded_at = CASE WHEN $6::text = 'keep' THEN reminded_at ELSE NULL END,
       checked_at = CASE WHEN $6::text = 'keep' THEN checked_at ELSE NULL END,
       updated_at = now()
     WHERE list_id = $1 AND jid = $2 RETURNING *`,
    [listId, jid, outcome === undefined ? null : outcome, notes ?? null, stage === undefined ? null : stage,
      visit === undefined ? 'keep' : visit === null ? 'clear' : 'set', visit ? visit.toISOString() : null],
  );
  if (!m) throw new Error('Not on this list');
  return m;
}

export async function setPipeline(listId, settings) {
  const [l] = await query('SELECT pipeline FROM lists WHERE id = $1', [listId]);
  if (!l) throw new Error('List not found');
  const p = { ...DEFAULT_PIPELINE, ...(l.pipeline || {}), ...Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined)) };
  p.remindHoursBefore = Math.max(1, Number(p.remindHoursBefore) || 18);
  p.askDateAfterHours = Math.max(1, Number(p.askDateAfterHours) || 4);
  p.enabled = p.enabled !== false;
  p.autoSend = !!p.autoSend;
  const [u] = await query('UPDATE lists SET pipeline = $2, updated_at = now() WHERE id = $1 RETURNING *', [listId, JSON.stringify(p)]);
  return u;
}

/** The numbers a list sends from: its own, plus any its messages were moved to. */
async function listNumbers(list) {
  const rows = await query(`SELECT DISTINCT account_id FROM outbox WHERE list_id = $1`, [list.id]);
  return [...new Set([list.account_id, ...rows.map((r) => r.account_id)])];
}

/**
 * Which of the list's numbers has the conversation with this person: the one that exchanged a message with them
 * most recently (like Chatwoot, a reply goes out through the inbox the conversation lives in). So a follow-up
 * never arrives from a number the person has never heard from. Falls back to the list's number.
 */
async function chatAccountFor(list, jid) {
  const nums = await listNumbers(list);
  const [r] = await query(
    `SELECT account_id FROM messages WHERE chat_jid = $1 AND account_id = ANY($2) ORDER BY ts DESC LIMIT 1`,
    [jid, nums],
  );
  return r?.account_id || list.account_id;
}

const fmtVisit = (t) => new Date(t).toLocaleString('en-IN', { timeZone: process.env.TZ_NAME || 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/**
 * Warm-lead automation (runs with follow-ups every 10 min, on the server holding the number):
 *  - stage "interested", no date, quiet for askDateAfterHours → ask for a date (once)
 *  - stage "date_given" → reminder message remindHoursBefore the visit (once) + a board task for you
 *  - visit time passed by 3 h and stage still "date_given" → board task "Did X come?" (once)
 * These come before bulk sends and follow-ups (priority 5).
 */
export async function runPipeline() {
  const lists = await query(`SELECT * FROM lists`);
  for (const list of lists) {
    const p = { ...DEFAULT_PIPELINE, ...(list.pipeline || {}) };
    if (!p.enabled) continue;
    // Each person is messaged from the number that has their chat (a batch may span two numbers after a move).
    // Only the server holding that number acts, and a number that is offline/blocked just waits (nothing is marked done).
    if (!(await listNumbers(list)).some((id) => manager.sessions.get(id)?.status === 'open')) continue;
    try {
      const woke = new Set();
      // true = queued, false = number offline (try again later), 'manual' = can't message now (Meta 24 h rule) → task for you
      const send = async (m, text, note, waTemplate) => {
        const acc = await chatAccountFor(list, m.jid);
        const session = manager.sessions.get(acc);
        if (session?.status !== 'open') return false;
        const approve = !p.autoSend && session.settings.aiMode === 'approve';
        const first = (m.name || '').trim().split(/\s+/)[0];
        const vars = { ...m.fields, name: m.name, first_name: first, phone: m.phone, visit_date: m.visit_at ? fmtVisit(m.visit_at) : '' };
        const r = await payloadFor(session, m.jid, fillTemplate(text, vars), waTemplate, vars);
        if (r.skip) {
          await createTask({ account: acc, title: `Message ${m.name || m.phone} yourself (${note})`, details: `${list.name}: ${r.skip}. Call or message +${m.phone}.`, createdBy: 'rule', role: list.role });
          return 'manual';
        }
        await query(
          `INSERT INTO outbox (account_id, to_jid, payload, source, status, priority, note, list_id) VALUES ($1,$2,$3,'campaign',$4,5,$5,$6)`,
          [acc, m.jid, JSON.stringify(r.payload), approve ? 'draft' : 'queued', note, list.id],
        );
        woke.add(acc);
        return true;
      };
      const pending = (note) => `NOT EXISTS (SELECT 1 FROM outbox o WHERE o.list_id = m.list_id AND o.to_jid = m.jid AND o.note = '${note}' AND o.status IN ('draft','queued','sending'))`;
      // 1. interested but no date yet → ask for one
      const ask = await query(
        `SELECT m.* FROM list_members m WHERE m.list_id = $1 AND m.stage = 'interested' AND m.visit_at IS NULL AND m.asked_date_at IS NULL
           AND COALESCE(m.last_reply_at, m.stage_at, m.updated_at) <= now() - ($2 || ' hours')::interval AND ${pending('ask-date')}`,
        [list.id, String(p.askDateAfterHours)],
      );
      let asked = 0;
      for (const m of ask) {
        if (!(await send(m, p.askDateText, 'ask-date', p.askDateWaTemplate))) continue;
        await query('UPDATE list_members SET asked_date_at = now() WHERE list_id = $1 AND jid = $2', [list.id, m.jid]);
        asked++;
      }
      // 2. date given → reminder before the visit + task for you
      const remind = await query(
        `SELECT m.* FROM list_members m WHERE m.list_id = $1 AND m.stage = 'date_given' AND m.visit_at IS NOT NULL AND m.reminded_at IS NULL
           AND m.visit_at > now() AND m.visit_at <= now() + ($2 || ' hours')::interval`,
        [list.id, String(p.remindHoursBefore)],
      );
      let reminded = 0;
      for (const m of remind) {
        if (!(await send(m, p.reminderText, 'visit-reminder', p.reminderWaTemplate))) continue;
        reminded++;
        await createTask({ account: list.account_id, title: `Visit: ${m.name || m.phone} — ${fmtVisit(m.visit_at)}`, details: `${list.name}. Reminder sent to +${m.phone}. Update the stage after the visit.`, dueAt: m.visit_at, createdBy: 'rule', role: list.role });
        await query('UPDATE list_members SET reminded_at = now() WHERE list_id = $1 AND jid = $2', [list.id, m.jid]);
      }
      // 3. visit time passed, stage not updated → ask you
      const check = await query(
        `SELECT m.* FROM list_members m WHERE m.list_id = $1 AND m.stage = 'date_given' AND m.visit_at <= now() - interval '3 hours' AND m.checked_at IS NULL`,
        [list.id],
      );
      for (const m of check) {
        await createTask({ account: list.account_id, title: `Did ${m.name || m.phone} come? (${fmtVisit(m.visit_at)})`, details: `${list.name}: set the stage to visited / trial / no_show.`, createdBy: 'rule', role: list.role });
        await query('UPDATE list_members SET checked_at = now() WHERE list_id = $1 AND jid = $2', [list.id, m.jid]);
      }
      for (const acc of woke) outbox.wakeAccount(acc);
      if (asked + reminded + check.length) {
        await logEvent(list.account_id, 'info', `Pipeline "${list.name}": ${asked} asked for a date, ${reminded} visit reminders, ${check.length} visit checks`, 'system', list.role);
      }
    } catch (err) {
      await logEvent(list.account_id, 'warn', `Pipeline "${list.name}" failed: ${err.message}`, 'system', list.role);
    }
  }
}

/** Funnel overview: people per stage and upcoming visits. */
export async function pipelineSummary(account, role) {
  const counts = await query(
    `SELECT l.id, l.role || ' · ' || l.name AS name, COALESCE(m.stage, CASE WHEN m.status = 'replied' THEN 'replied (no stage)' WHEN m.status IN ('sent','queued') THEN 'contacted' ELSE 'not contacted' END) AS stage, count(*)::int AS n
     FROM lists l JOIN list_members m ON m.list_id = l.id WHERE ($1::text IS NULL OR l.account_id = $1) AND ($2::text IS NULL OR lower(l.role) = lower($2))
     GROUP BY 1,2,3 ORDER BY 1 DESC, 4 DESC`,
    [account || null, role || null],
  );
  const visits = await query(
    `SELECT l.name AS list, m.* FROM lists l JOIN list_members m ON m.list_id = l.id
     WHERE ($1::text IS NULL OR l.account_id = $1) AND ($2::text IS NULL OR lower(l.role) = lower($2)) AND m.stage = 'date_given' AND m.visit_at IS NOT NULL
     ORDER BY m.visit_at LIMIT 50`,
    [account || null, role || null],
  );
  return { counts, visits };
}

export async function setFollowup(listId, settings) {
  const [l] = await query('SELECT followup FROM lists WHERE id = $1', [listId]);
  if (!l) throw new Error('List not found');
  // Only the settings actually given change; the rest (e.g. the message) stay as saved.
  const given = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined));
  const f = { ...DEFAULT_FOLLOWUP, ...(l.followup || {}), ...given };
  f.afterDays = Math.max(0.01, Number(f.afterDays) || 2);
  f.max = Math.max(0, Math.min(5, parseInt(f.max, 10) || 0));
  f.enabled = !!f.enabled;
  f.quietDaysOnly = f.quietDaysOnly !== false;
  f.autoSend = !!f.autoSend;
  if (f.enabled && !String(f.text || '').trim() && !f.template && !f.waTemplate?.name) throw new Error('Follow-ups need a message or a template');
  if (f.waTemplate && !f.waTemplate.name) f.waTemplate = null;
  const [u] = await query('UPDATE lists SET followup = $2, updated_at = now() WHERE id = $1 RETURNING *', [listId, JSON.stringify(f)]);
  return u;
}

/**
 * Message the members with the given statuses (default: new + failed). Each gets their own prepared message
 * from the list (column "message") unless a text/template is given. One board task per call.
 */
export async function sendToList(listId, { statuses = ['new', 'failed'], text, template, waTemplate, onlyPhones, createdBy = 'you', source = 'campaign', scheduledAt } = {}) {
  const at = scheduledAt ? new Date(scheduledAt) : null;
  if (at && isNaN(at)) throw new Error('scheduledAt is not a valid date/time');
  const list = await getList(listId);
  await refreshList(list.id);
  const session = await manager.resolve(list.account_id);
  await outbox.assertCanSend(session);
  let members = await listMembers(list.id, { status: statuses.join(',') });
  if (onlyPhones?.length) {
    const want = new Set(onlyPhones.map((p) => toJid(p)));
    members = members.filter((m) => want.has(m.jid));
  }
  const tpl = template ? await getTemplate(list.account_id, template) : null;
  if (template && !tpl) throw new Error(`No template called "${template}"`);
  const plan = [];
  const skipped = [];
  for (const m of members) {
    if (CLOSED_STAGES.includes(m.stage) || CLOSED_OUTCOME.test(m.outcome || '')) {
      skipped.push({ to: m.phone, reason: `closed: ${m.stage || m.outcome}` });
      continue;
    }
    const first = (m.name || '').trim().split(/\s+/)[0];
    const vars = { ...m.fields, name: m.name, first_name: first, phone: m.phone };
    const body = text ? fillTemplate(text, vars) : tpl ? fillTemplate(tpl.body, vars) : m.message;
    if (!body?.trim() && !(session.isCloud && waTemplate)) {
      skipped.push({ to: m.phone, reason: 'no message prepared for this person' });
      continue;
    }
    const r = await payloadFor(session, m.jid, body, waTemplate, vars, { attachment: tpl?.attachment || undefined });
    if (r.skip) {
      skipped.push({ to: m.phone, reason: r.skip });
      continue;
    }
    plan.push({ m, payload: r.payload });
  }
  if (!plan.length) {
    if (session.isCloud && !waTemplate && skipped.length) {
      throw new Error(`"${session.account.label}" is a Meta Cloud API number: first messages must use an approved Meta template — choose one (waTemplate)`);
    }
    return { task: null, queued: 0, skipped };
  }
  const task = await createTask({ account: list.account_id, title: `${list.name}: message ${plan.length}`, details: `Statuses: ${statuses.join(', ')}`, kind: 'bulk', createdBy, role: list.role });
  const approve = ['mcp', 'campaign'].includes(source) && session.settings.aiMode === 'approve';
  await insertMany('outbox', ['account_id', 'to_jid', 'payload', 'source', 'status', 'priority', 'note', 'task_id', 'list_id', 'scheduled_at'],
    plan.map((x) => [list.account_id, x.m.jid, JSON.stringify(x.payload), source, approve ? 'draft' : 'queued', 0, list.name, task.id, list.id, (at || new Date()).toISOString()]));
  if (at) await query(`UPDATE tasks SET due_at = $2 WHERE id = $1`, [task.id, at.toISOString()]);
  await refreshTask(task.id);
  await refreshList(list.id);
  outbox.wakeAccount(list.account_id);
  return { task, queued: plan.length, skipped, mode: approve ? 'approve' : 'auto' };
}

/**
 * Follow-ups: for every list with follow-ups on, members who were messaged, haven't replied, were last
 * messaged at least afterDays ago and have had fewer than `max` follow-ups get one (quoting our last message).
 * Uses the number's approval mode, delay, daily cap and sending hours like any automated message.
 */
export async function runFollowups() {
  const lists = await query(`SELECT * FROM lists WHERE (followup->>'enabled')::boolean`);
  const tz = process.env.TZ_NAME || 'Asia/Kolkata';
  // Per number (shared by all lists): may it send follow-ups now, and how many more today?
  const numbers = new Map();
  const numberState = async (id) => {
    if (numbers.has(id)) return numbers.get(id);
    const session = manager.sessions.get(id);
    let st = { open: false };
    // Only the server that currently holds this number schedules its follow-ups (never twice).
    if (session?.status === 'open') {
      const already = (await query(
        `SELECT count(*)::int AS n FROM outbox WHERE account_id = $1 AND note = 'follow-up' AND status IN ('draft','queued','sending','sent')
           AND created_at >= (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)`,
        [id, tz],
      ))[0].n;
      st = {
        open: true,
        session,
        // New candidates first: no follow-ups on a day this number messages (or is about to message) new people,
        // not before the number's follow-up time (default 21:00), and at most followupDailyMax a day.
        timeOk: afterTime(session.settings.followupStart),
        newOutreach: await outbox.newOutreachToday(id),
        room: session.settings.followupDailyMax - already,
      };
    }
    numbers.set(id, st);
    return st;
  };
  for (const list of lists) {
    if (!(await Promise.all((await listNumbers(list)).map(numberState))).some((s) => s.open)) continue;
    try {
      await refreshList(list.id);
      const f = list.followup;
      const due = await query(
        `SELECT m.* FROM list_members m WHERE m.list_id = $1 AND m.status = 'sent' AND m.followups_sent < $2
           AND m.last_sent_at <= now() - ($3 || ' days')::interval
           AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.list_id = m.list_id AND o.to_jid = m.jid AND o.status IN ('draft','queued','sending'))
           AND ${CLOSED_SQL}
         ORDER BY CASE WHEN m.row_ref ~ '^[0-9]+$' THEN m.row_ref::int END NULLS LAST, m.last_sent_at
         LIMIT 500`,
        [list.id, f.max, String(f.afterDays)],
      );
      // Each follow-up goes from the number that has the person's chat, within that number's own limits.
      const byNumber = new Map();
      for (const m of due) {
        const acc = await chatAccountFor(list, m.jid);
        const st = await numberState(acc);
        if (!st.open || !st.timeOk || st.room <= 0) continue;
        if (f.quietDaysOnly !== false && st.newOutreach) continue;
        st.room--;
        if (!byNumber.has(acc)) byNumber.set(acc, []);
        byNumber.get(acc).push(m);
      }
      for (const [acc, members] of byNumber) {
        const st = numbers.get(acc);
        const tpl = f.template ? await getTemplate(acc, f.template) : null;
        const approve = !f.autoSend && st.session.settings.aiMode === 'approve';
        const task = await createTask({ account: acc, title: `${list.name}: follow up ${members.length}`, details: `No reply after ${f.afterDays} day(s)`, kind: 'bulk', createdBy: 'rule', role: list.role });
        const rows = [];
        const skippedWhy = new Set();
        for (const m of members) {
          const first = (m.name || '').trim().split(/\s+/)[0];
          const vars = { ...m.fields, name: m.name, first_name: first, phone: m.phone };
          const body = fillTemplate(tpl?.body || f.text, vars);
          const [last] = await query(
            `SELECT id FROM messages WHERE account_id = $1 AND chat_jid = $2 AND from_me ORDER BY ts DESC LIMIT 1`,
            [acc, m.jid],
          );
          // Meta numbers: they never replied, so the 24 h window is closed — the follow-up's Meta template goes instead.
          const r = await payloadFor(st.session, m.jid, body, f.waTemplate, vars, { attachment: tpl?.attachment || undefined, replyTo: last?.id });
          if (r.skip) {
            skippedWhy.add(r.skip);
            continue;
          }
          rows.push([acc, m.jid, JSON.stringify(r.payload), 'campaign', approve ? 'draft' : 'queued', -1, 'follow-up', task.id, list.id]);
        }
        if (skippedWhy.size) await logEvent(acc, 'warn', `Follow-ups for "${list.name}": ${members.length - rows.length} not sent — ${[...skippedWhy].join('; ')}`, 'system', list.role);
        if (!rows.length) {
          await query('DELETE FROM tasks WHERE id = $1', [task.id]); // nothing to follow up after all
          continue;
        }
        await insertMany('outbox', ['account_id', 'to_jid', 'payload', 'source', 'status', 'priority', 'note', 'task_id', 'list_id'], rows);
        await refreshTask(task.id);
        outbox.wakeAccount(acc);
        await logEvent(acc, 'info', `Follow-ups for "${list.name}": ${rows.length} ${approve ? 'drafted for approval' : 'queued'}`, 'system', list.role);
      }
      if (byNumber.size) await refreshList(list.id);
    } catch (err) {
      await logEvent(list.account_id, 'warn', `Follow-ups for "${list.name}" failed: ${err.message}`, 'system', list.role);
    }
  }
}

/** Plain rows for a spreadsheet: one per member, with the hub's status columns. */
export async function exportRows(listId) {
  await refreshList(listId);
  const rows = await listMembers(listId);
  const d = (t) => (t ? new Date(t).toLocaleString('en-GB', { timeZone: process.env.TZ_NAME || 'Asia/Kolkata' }).slice(0, 17) : '');
  return rows.map((m) => ({
    phone: m.phone, name: m.name, row: m.row_ref, status: m.status, outcome: m.outcome || '', notes: m.notes || '',
    first_sent: d(m.first_sent_at), last_sent: d(m.last_sent_at), last_reply: d(m.last_reply_at), replies: m.replies,
    followups: m.followups_sent, last_reply_text: m.last_reply_text || '', error: m.error || '',
  }));
}

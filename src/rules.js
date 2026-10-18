/**
 * Simple automatic rules for incoming messages (idea from Chatwoot's automation rules), e.g.
 *   "PDF arrives on the hiring number from someone new → tag 'candidate', save the file, add a board task"
 *   "message mentions 'room' or 'booking' → tag 'lead'"
 *
 * conditions: {
 *   chat: 'direct' | 'group' | 'any'            (default 'direct')
 *   types: ['document','image','text',…]        (empty = any type)
 *   words: ['booking','room']                   (any of these, case-insensitive; empty = no word check)
 *   sender: 'any' | 'new' | 'known'             (new = never messaged by you before)
 * }
 * actions: {
 *   addTags: ['candidate'], leadStatus: 'new', saveMedia: true,
 *   createTask: 'Review resume from {name}',     (task on this number's board)
 *   replyTemplate: 'Resume received'             (template name/id; sent once per person per day)
 *   snoozeDays: 0                                 (optional: hide the chat until N days later)
 * }
 */
import { query, logEvent } from './db.js';

export async function listRules(accountId) {
  return query(`SELECT * FROM rules WHERE ($1::text IS NULL OR account_id = $1) ORDER BY id`, [accountId || null]);
}

export async function saveRule({ id, account, name, enabled = true, conditions = {}, actions = {} }) {
  if (!account) throw new Error('A rule belongs to one number (account)');
  if (!name?.trim()) throw new Error('A rule needs a name');
  const c = normalizeConditions(conditions);
  const a = normalizeActions(actions);
  if (!Object.keys(a).length) throw new Error('A rule needs at least one action');
  if (id) {
    const [r] = await query(
      `UPDATE rules SET account_id = $2, name = $3, enabled = $4, conditions = $5, actions = $6 WHERE id = $1 RETURNING *`,
      [id, account, name.trim(), !!enabled, JSON.stringify(c), JSON.stringify(a)],
    );
    if (!r) throw new Error('Rule not found');
    return r;
  }
  const [r] = await query(
    `INSERT INTO rules (account_id, name, enabled, conditions, actions) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [account, name.trim(), !!enabled, JSON.stringify(c), JSON.stringify(a)],
  );
  return r;
}

export async function deleteRule(id) {
  const [r] = await query('DELETE FROM rules WHERE id = $1 RETURNING *', [id]);
  if (!r) throw new Error('Rule not found');
  return r;
}

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim().toLowerCase()).filter(Boolean);

function normalizeConditions(c) {
  return {
    chat: ['direct', 'group', 'any'].includes(c.chat) ? c.chat : 'direct',
    types: list(c.types),
    words: list(c.words),
    sender: ['any', 'new', 'known'].includes(c.sender) ? c.sender : 'any',
  };
}

function normalizeActions(a) {
  const out = {};
  if (list(a.addTags).length) out.addTags = list(a.addTags);
  if (a.leadStatus) out.leadStatus = String(a.leadStatus).trim();
  if (a.saveMedia) out.saveMedia = true;
  if (a.createTask) out.createTask = String(a.createTask).trim();
  if (a.replyTemplate) out.replyTemplate = String(a.replyTemplate).trim();
  if (Number(a.snoozeDays) > 0) out.snoozeDays = Math.min(365, Number(a.snoozeDays));
  return out;
}

/** Does this incoming message match the rule's conditions? (pure; `isNew` = never messaged by you) */
export function matches(rule, msg, { isGroup, isNew }) {
  const c = rule.conditions || {};
  if (c.chat === 'direct' && isGroup) return false;
  if (c.chat === 'group' && !isGroup) return false;
  if (c.types?.length && !c.types.includes(msg.type)) return false;
  if (c.sender === 'new' && !isNew) return false;
  if (c.sender === 'known' && isNew) return false;
  if (c.words?.length) {
    const text = `${msg.body || ''} ${msg.media?.fileName || ''}`.toLowerCase();
    if (!c.words.some((w) => text.includes(w))) return false;
  }
  return true;
}

/**
 * Run all enabled rules of a number on one incoming message.
 * `ctx` provides the side effects (so this stays testable): updateContact, saveMedia, createTask, sendTemplate, snooze.
 */
export async function runRules(accountId, msg, { isGroup, isNew }, ctx) {
  const rules = (await query(`SELECT * FROM rules WHERE account_id = $1 AND enabled ORDER BY id`, [accountId]));
  for (const rule of rules) {
    if (!matches(rule, msg, { isGroup, isNew })) continue;
    const a = rule.actions || {};
    const done = [];
    try {
      if (a.addTags || a.leadStatus) {
        await ctx.updateContact({ addTags: a.addTags, leadStatus: a.leadStatus });
        done.push(a.addTags ? `tagged ${a.addTags.join(',')}` : null, a.leadStatus ? `status ${a.leadStatus}` : null);
      }
      if (a.saveMedia && msg.media) {
        await ctx.saveMedia();
        done.push('saved file');
      }
      if (a.createTask) {
        await ctx.createTask(a.createTask);
        done.push('added task');
      }
      if (a.replyTemplate && !isGroup) {
        const sentToday = await query(
          `SELECT 1 FROM outbox WHERE account_id = $1 AND to_jid = $2 AND note = $3 AND created_at > now() - interval '1 day' LIMIT 1`,
          [accountId, msg.chatJid, `rule:${rule.id}`],
        );
        if (!sentToday.length) {
          await ctx.sendTemplate(a.replyTemplate, `rule:${rule.id}`);
          done.push(`auto-reply "${a.replyTemplate}"`);
        }
      }
      if (a.snoozeDays) {
        await ctx.snooze(a.snoozeDays);
        done.push(`reminder in ${a.snoozeDays} days`);
      }
      await query('UPDATE rules SET runs = runs + 1, last_run_at = now() WHERE id = $1', [rule.id]);
      const what = done.filter(Boolean).join(', ');
      if (what) await logEvent(accountId, 'info', `Rule "${rule.name}" on ${msg.chatJid.split('@')[0]}: ${what}`);
    } catch (err) {
      await logEvent(accountId, 'warn', `Rule "${rule.name}" failed: ${err.message}`);
    }
  }
}

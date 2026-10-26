/**
 * MCP server for AI agents (Claude Code / Desktop / claude.ai custom connector).
 * URL: <server>/mcp/<API_KEY>   (Streamable HTTP, stateless)
 *
 * Token-efficiency rules: every tool returns compact one-line-per-item text, small default limits,
 * long messages trimmed, and filtering done in SQL — the agent pulls more only when it asks for more.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import config from './config.js';
import { query, tx } from './db.js';
import { manager } from './wa/manager.js';
import * as store from './store.js';
import * as outbox from './outbox.js';
import { toTs, localDate } from './util.js';
import * as tasks from './tasks.js';
import * as templates from './templates.js';
import * as rules from './rules.js';
import { findPerson } from './people.js';
import * as lists from './lists.js';
import { getPlaybook, savePlaybook, campaignRules as getCampaignPlaybook, listCampaignPlaybooks } from './playbook.js';
import { logEvent } from './db.js';
import { HISTORY_MODES } from './describe.js';
import { normalizeSettings } from './settings.js';
import { priceRows, money, getPricing } from './pricing.js';
import * as scope from './scope.js';
import { roleOf, roleFilter } from './campaign.js';

const ai = (accountId, text, role = null) => logEvent(accountId, 'info', text, 'ai', role);

const fmtTime = (ts) =>
  ts
    ? new Date(ts * 1000).toLocaleString('en-GB', {
        timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).replace(',', '')
    : '-';
// One line per item in lists: collapse newlines/whitespace, then cut.
const trim = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};
const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (err) => ({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
/**
 * Response budget: no answer may flood the AI's context as the data grows. Above the budget the answer is cut at a
 * line break and says how much was left out and how to narrow it — never a silent truncation. (~16k characters ≈
 * 4k tokens; the playbook and a full chat still fit.)
 */
export const RESPONSE_BUDGET = 16000;
export function budget(out, max = RESPONSE_BUDGET) {
  const s = String(out ?? '');
  if (s.length <= max) return s;
  const cut = s.lastIndexOf('\n', max) > max * 0.5 ? s.lastIndexOf('\n', max) : max;
  const restLines = s.slice(cut).split('\n').filter(Boolean).length;
  return `${s.slice(0, cut)}\n… ${restLines} more line(s) not shown (${s.length - cut} characters). Narrow it down: use this tool's filters (account, campaign/role, status/stage, query, kind, limit) or ask about one person.`;
}
const safe = (fn, max = RESPONSE_BUDGET) => async (args) => {
  try {
    return text(budget(await fn(args), max));
  } catch (err) {
    return fail(err);
  }
};

/** "YYYY-MM-DD" → 10:00; no timezone given → the owner's time zone (TZ_NAME). '' stays '' (clear), undefined stays undefined. */
const localTime = (v) => {
  if (v === undefined || v === null) return undefined;
  const t = String(v).trim();
  if (!t) return '';
  const d = localDate(t);
  if (!d || isNaN(d)) throw new Error(`Could not read the date "${v}" — use YYYY-MM-DD HH:MM`);
  return d.toISOString();
};
/** "What to do" for an error that carries a Meta code, e.g. "(Meta 131049)". */
let metaHelpFn = null;
import('./wa/graph.js').then((g) => { metaHelpFn = g.metaHelp; }).catch(() => {});
const helpFor = (err) => {
  const code = String(err || '').match(/\(Meta (\d+)/)?.[1];
  const todo = code && metaHelpFn ? metaHelpFn(code).todo : null;
  return todo ? ` | what to do: ${todo}` : '';
};
/**
 * The inbox at a glance, across numbers: chats with messages since `since` (unix s), newest first — who wrote last,
 * how many of their messages are unanswered, the campaign / list / stage, and whether a Board card or a draft already
 * covers it. People who are on no list get no "Reply to" card, so this is how the AI sees them.
 */
async function inboxRows({ since, account, campaign, waitingOnly = true, limit = 40, unlisted = false }) {
  const p = [since];
  const where = [];
  // never our own numbers (the hub's numbers, the owner's alert phones: staff talking to each other)
  const { alertPhones } = await import('./notify.js');
  const own = [...manager.list().map((a) => a.phone), ...(await alertPhones().catch(() => []))].filter(Boolean).map((x) => String(x).replace(/\D/g, ''))
    .flatMap((x) => (x.length === 10 ? [x, '91' + x] : [x]));
  p.push(own);
  where.push(`split_part(ib.chat_jid, '@', 1) <> ALL($${p.length}::text[])`);
  // people on a list (a campaign) only, unless asked: the numbers are also used by staff for everyday chats
  if (!unlisted) where.push('EXISTS (SELECT 1 FROM list_members lmx WHERE lmx.jid = ib.chat_jid)');
  if (account) { p.push(account); where.push(`ib.account_id = $${p.length}`); }
  if (campaign) { p.push(campaign); where.push(roleFilter(roleOf('ib.account_id', 'ib.chat_jid'), p.length)); }
  if (waitingOnly) where.push('NOT ib.from_me');
  p.push(limit);
  return query(
    `WITH ib AS (
       SELECT DISTINCT ON (account_id, chat_jid) account_id, chat_jid, from_me, ts, body, type FROM messages
       WHERE ts > $1 AND chat_jid NOT LIKE '%@g.us' AND chat_jid NOT LIKE '%broadcast%' AND chat_jid NOT LIKE '%@newsletter'
       ORDER BY account_id, chat_jid, ts DESC)
     SELECT ib.*, ${roleOf('ib.account_id', 'ib.chat_jid')} AS campaign,
       COALESCE(NULLIF(ct.name, ''), NULLIF(ch.name, ''), (SELECT NULLIF(m.name, '') FROM list_members m WHERE m.jid = ib.chat_jid AND COALESCE(m.name, '') <> '' LIMIT 1), ct.notify) AS name,
       (SELECT count(*)::int FROM messages y WHERE y.account_id = ib.account_id AND y.chat_jid = ib.chat_jid AND NOT y.from_me
          AND y.ts > COALESCE((SELECT max(z.ts) FROM messages z WHERE z.account_id = ib.account_id AND z.chat_jid = ib.chat_jid AND z.from_me), 0)) AS unanswered,
       (SELECT m.stage FROM list_members m JOIN lists li ON li.id = m.list_id WHERE m.jid = ib.chat_jid ORDER BY (li.account_id = ib.account_id) DESC, li.id DESC LIMIT 1) AS stage,
       (SELECT li.name FROM list_members m JOIN lists li ON li.id = m.list_id WHERE m.jid = ib.chat_jid ORDER BY (li.account_id = ib.account_id) DESC, li.id DESC LIMIT 1) AS list_name,
       (SELECT t.id FROM tasks t WHERE t.status NOT IN ('done','cancelled') AND t.ref = 'reply:' || ib.account_id || ':' || ib.chat_jid LIMIT 1) AS card,
       (SELECT o.id FROM outbox o WHERE o.account_id = ib.account_id AND o.to_jid = ib.chat_jid AND o.status IN ('draft','queued') ORDER BY o.id DESC LIMIT 1) AS waiting_msg
     FROM ib LEFT JOIN contacts ct ON ct.account_id = ib.account_id AND ct.jid = ib.chat_jid
     LEFT JOIN chats ch ON ch.account_id = ib.account_id AND ch.jid = ib.chat_jid
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ib.ts DESC LIMIT $${p.length}`,
    p,
  );
}

/** " | sending: … | today: … | Meta budget …" for one number (why messages wait, what's left, what it cost). */
async function sendingLine(a) {
  try {
    const q = await outbox.queueStatus(a.id);
    const parts = [` | sending: ${q.state}${q.reason ? ' — ' + q.reason : ''}${q.until ? ' until ' + fmtTime(Math.floor(new Date(q.until).getTime() / 1000)) : ''}`,
      `${q.queued} queued, ${q.drafts} drafts, to people not talking to us ${q.automated24h}/${q.dailyCap} in 24 h${q.warmDailyCap != null ? `, to people who wrote in 30 days ${q.warm24h}/${q.warmDailyCap}, last hour ${q.lastHour}/${q.hourlyCap}` : ''}`];
    const f = await outbox.capacityForecast(a.id).catch(() => null);
    if (f?.atRisk.length) {
      parts.push(`⚠ NOT ENOUGH CAPACITY: ${f.atRisk.length} message(s) with a "send by" time would miss it (#${f.atRisk.slice(0, 10).map((m) => m.id).join(', #')}) — tell the owner; options: move_messages to another number, reject them, or raise this number's daily limit${f.raiseTo ? ` to ${f.raiseTo}` : ''} (owner decides)`);
    }
    if (a.provider === 'cloud') {
      const nc = q.newChats;
      const pr = await getPricing();
      const [c] = await query(
        `SELECT count(*) FILTER (WHERE payload->'pricing'->>'category' = 'marketing')::int AS mk,
                count(*) FILTER (WHERE payload->'pricing'->>'category' IN ('utility','authentication'))::int AS ut
         FROM meta_events WHERE account_id = $1 AND kind = 'status' AND status = 'sent' AND (payload->'pricing'->>'billable')::boolean
           AND created_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2`,
        [a.id, config.tz],
      );
      parts.push(`Meta budget today: ${Math.max(0, nc.limit - nc.count)} of ${nc.limit} new people left; spent today ≈ ${money(c.mk * pr.marketing + c.ut * pr.utility, pr.currency)} (${c.mk} marketing, ${c.ut} utility); health ${a.cloud?.canSend || '?'}, quality ${a.cloud?.quality || '?'}`);
    }
    return parts.join(' | ');
  } catch {
    return '';
  }
}
const accountArg = z.string().optional().describe('Account id (e.g. "hiring") or its phone number. Omit for the default account.');
// Meta Cloud API numbers: messages to someone who hasn't written in 24 h must be an approved Meta template.
const waTemplateArg = z.object({
  name: z.string().describe('Meta template name (see list_meta_templates)'),
  language: z.string().optional().describe('e.g. en, en_US, hi — default: the approved one'),
  params: z.union([z.array(z.string()), z.record(z.string(), z.string())]).optional()
    .describe('Values for {{1}}, {{2}}… in order (or {name: value} for named ones). May use {name}, {first_name} and list fields — filled per person'),
  header: z.string().optional().describe('Header text value, or a public file link for image/document headers'),
}).optional();
/** " Estimated Meta cost: ₹86.31 (100 × ₹0.86)." — empty for free (linked phone) sends. */
async function taskCostText(taskId) {
  const rows = await query(`SELECT account_id, payload FROM outbox WHERE task_id = $1 AND status IN ('draft','queued')`, [taskId]);
  const p = await priceRows(rows, manager);
  return p.total > 0 ? ` Estimated Meta cost: ${money(p.total, p.currency)} (${rows.length} × ${money(p.items[0].price, p.currency)}) — tell the owner before they approve.` : '';
}
const chatArg = z.string().describe('Chat: phone number (e.g. 919876543210 or 9876543210), chat id (…@s.whatsapp.net / …@g.us), or a chat/contact name');

async function resolveChat(accountId, chat) {
  const c = String(chat).trim();
  if (c.includes('@')) return c;
  if (/^[+\d\s()-]{8,}$/.test(c)) return store.toJid(c);
  const rows = await store.listChats(accountId, { q: c, limit: 8 });
  if (rows.length === 1) return rows[0].jid;
  const exact = rows.filter((r) => (r.name || '').toLowerCase() === c.toLowerCase());
  if (exact.length === 1) return exact[0].jid;
  if (!rows.length) throw new Error(`No chat matches "${c}"`);
  throw new Error(`"${c}" matches several chats — pass the chat id:\n${rows.map((r) => `${r.jid} | ${r.name}`).join('\n')}`);
}

const chatLine = (r) =>
  [
    r.jid,
    trim(r.name, 40),
    r.is_group ? `group(${r.participants ?? '?'})` : null,
    fmtTime(r.last_ts),
    `${r.last_from_me ? 'me' : 'them'}: ${trim(r.last_preview, 80)}`,
    r.tags?.length ? `tags:${r.tags.join(',')}` : null,
    r.lead_status ? `status:${r.lead_status}` : null,
    r.is_blocked ? 'BLOCKED' : null,
    r.summary ? `summary:${trim(r.summary, 120)}` : null,
    r.state === 'snoozed' ? (r.due ? `REMINDER DUE${r.snooze_note ? ': ' + trim(r.snooze_note, 60) : ''}` : `remind ${fmtTime(Math.floor(new Date(r.snoozed_until).getTime() / 1000))}`) : null,
    r.state === 'done' ? 'done' : null,
  ]
    .filter(Boolean)
    .join(' | ');

const msgLine = (m, maxLen) => {
  const who = m.from_me ? 'me' : m.sender_name || (m.sender_jid || '').split('@')[0] || 'them';
  let body = m.deleted ? '[deleted]' : trim(m.body, maxLen) || `[${m.type}]`;
  if (m.type !== 'text' && m.type !== 'contact' && m.body) body = `[${m.type}] ${body}`;
  if (m.has_media) body += ` (media id:${m.id}${m.media_saved ? ', saved' : ''})`;
  const q = m.quoted_body ? ` ↪"${trim(m.quoted_body, 50)}"` : '';
  return `[${fmtTime(m.ts)}] ${who}: ${body}${q}`;
};

/**
 * Campaign scope for one MCP session (see scope.js): the arguments of every tool are checked before it runs —
 * campaign filters are filled in, and anything that belongs to another campaign is refused.
 */
const CAMPAIGN_ARG = { hub_overview: 'campaign', list_chats: 'campaign', list_outbox: 'campaign', recent_activity: 'role', list_lists: 'role',
  pipeline: 'role', known_candidates: 'role', import_list: 'role', list_tasks: 'role', create_task: 'campaign', get_playbook: 'campaign' };
const LIST_TOOLS = ['archive_list', 'remove_list_member', 'list_members', 'send_to_list', 'set_followup', 'update_list_member', 'set_pipeline'];
const TASK_TOOLS = ['update_task', 'add_task_note', 'log_call_result', 'task_history', 'approve_task'];
const DRAFT_TOOLS = ['approve_draft', 'reject_draft', 'edit_draft'];
const CHAT_TOOLS = { get_messages: 'chat', get_contact: 'chat', update_contact: 'chat', set_chat_state: 'chat', fetch_older_messages: 'chat', save_media: 'chat', send_message: 'to', search_messages: 'chat', list_shared_contacts: 'chat' };
const isPhone = (q) => /^[+\d\s()-]{8,}$/.test(q) || q.includes('@');
/** The campaign a call works in: its own campaign argument ("all" = every campaign), else the hub's current one. */
function callCampaign(name, a, focus) {
  // a tool's own job-role argument (import_list, known_candidates, list_tasks …) is more specific than campaign
  const ownRole = CAMPAIGN_ARG[name] === 'role' && a.role && !/^all$/i.test(a.role) ? a.role : undefined;
  const explicit = name === 'update_task' ? a.in_campaign : ownRole ?? a.campaign;
  if (explicit !== undefined && String(explicit).trim() !== '') return /^all$/i.test(String(explicit).trim()) ? '' : String(explicit).trim();
  return focus;
}
export async function enforceScope(focus, name, a) {
  const arg = CAMPAIGN_ARG[name];
  // the tool's own campaign / role filter is the call's campaign ('' = all campaigns)
  if (arg) a[arg] = focus || undefined;
  if (!focus) return;
  if (LIST_TOOLS.includes(name)) await scope.assertList(focus, a.list);
  if (TASK_TOOLS.includes(name)) await scope.assertTask(focus, a.id);
  if (DRAFT_TOOLS.includes(name)) await scope.assertDrafts(focus, [a.id]);
  if (name === 'move_messages') await scope.assertDrafts(focus, a.ids);
  const chatKey = CHAT_TOOLS[name];
  if (chatKey && a[chatKey]) {
    const acc = (await manager.resolve(a.account)).id;
    await scope.assertPerson(focus, acc, await resolveChat(acc, a[chatKey]));
  }
  if (name === 'person_context' || name === 'find_person') {
    const key = name === 'person_context' ? 'person' : 'query';
    const q = String(a[key] ?? '').trim();
    const jids = isPhone(q) ? [store.toJid(q)] : [...new Set((await findPerson(q)).map((h) => h.jid))];
    const inside = [];
    for (const j of jids) if (await scope.personIn(focus, null, j)) inside.push(j);
    if (jids.length && !inside.length) await scope.assertPerson(focus, null, jids[0]);
    if (!isPhone(q) && inside.length === 1) a[key] = inside[0].split('@')[0]; // a name that also matches people elsewhere → the one in this campaign
    if (!isPhone(q) && inside.length > 1 && inside.length < jids.length) throw new Error(`"${q}" matches several people in ${scope.label(focus)} — pass the number: ${inside.map((j) => j.split('@')[0]).join(', ')}`);
  }
  if (name === 'message_timeline' && isPhone(String(a.q || '').trim())) await scope.assertPerson(focus, (await manager.resolve(a.account)).id, store.toJid(a.q));
  if (name === 'bulk_send') {
    const acc = (await manager.resolve(a.account)).id;
    for (const r of a.recipients || []) await scope.assertPerson(focus, acc, store.toJid(r.to), 'Recipient');
  }
  if (name === 'save_rule') {
    a.role = focus;
    if (a.id) {
      const [r] = await query('SELECT conditions FROM rules WHERE id = $1', [a.id]);
      if (r) scope.assertSame(focus, r.conditions?.role || '(all campaigns)', `Rule #${a.id}`);
    }
  }
  if (name === 'save_template' && a.id) {
    const [t] = await query('SELECT role FROM templates WHERE id = $1', [a.id]);
    if (t) scope.assertSame(focus, t.role || '(all campaigns)', `Template #${a.id}`);
  }
  if (['send_message', 'bulk_send', 'send_to_list', 'set_followup'].includes(name) && a.template) {
    const t = await templates.getTemplate(a.account ? (await manager.resolve(a.account)).id : null, a.template).catch(() => null);
    if (t?.role) scope.assertSame(focus, t.role, `Template "${t.name}"`);
  }
}

function buildServer(playbook = '', focus = '') {

  const server = new McpServer(
    { name: 'zenith-whatsapp-hub', version: '0.1.0' },
    { instructions: `${focus ? `CAMPAIGN FILTER: the owner has ${scope.label(focus)} open, so every tool shows only its chats, drafts, Board cards, lists, contacts, templates and rules (numbers are shared), and refuses to change items of another campaign by accident. This keeps your context small — it is a filter, not a wall: to look at or work on another campaign pass campaign="<name>" (or "all") to the tool; list_campaigns shows them; create_campaign / switch_campaign when the owner asks.\n\n` : 'CAMPAIGNS: every tool takes campaign="<name>" to filter to one campaign (list_campaigns shows them). create_campaign / switch_campaign when the owner asks.\n\n'}Zenith WhatsApp Hub: several WhatsApp numbers, chats, candidate lists with a funnel, a Board (shared calendar of owner + AI), templates and rules. START every session with hub_overview — it shows what needs doing now, in priority order, across ALL numbers — then owner_feedback (the owner's card notes, rejection reasons and Drafts-page requests: act on the open ones). Work only with people on campaign lists: they get "Reply to" cards, and inbox_summary shows every one of them waiting for an answer (also those whose card was closed before a new message) — look at it before deciding and read the chat (get_messages) before drafting. Chats of people on no list are the staff's everyday chats: leave them alone unless the owner asks; never answer the hub's own numbers or the owner's phones. Funnel stages differ per campaign (list_campaigns; set_campaign_stages / create_campaign stages). ZOOM IN as far as you need: list_outbox(ids=[…] or full=true) shows whole messages, get_messages(full_text=true) whole chats, task_history a card's story, describe_data + inspect_data (read-only SQL) anything else. CHANGE what the owner asks: edit_messages (text, find/replace, picture) on drafts and approved-unsent messages, update_settings (owner-only settings with owner_asked), save_playbook (includes), reschedule_messages, move_messages. Lists and tasks live on different numbers: never conclude something is missing after filtering by one number. SEND ORDER (the hub does it, whatever the campaign): replies to people who wrote in 24 h → owner's own → messages with a "send by" time → people who wrote to us in the last 30 days (interested candidates, interview follow-ups) → everyone else → nudges to non-repliers. On a linked number only people who wrote in the last 30 days skip the daily limit, and at most hourlyCap (10) automated messages go out per hour — a burst to old contacts got the hotel number logged out (26 Oct). Never plan big batches to old contacts from a linked number. Give expires_at ("send by") to anything tied to a day (festival wishes, offers, reminders); hub_overview shows "NOT ENOUGH CAPACITY" when they won't fit — tell the owner. Follow the owner's playbook below (also via get_playbook).\n\n${playbook}` },
  );
  const CAMPAIGN_FILTER = z.string().optional().describe(`Campaign filter for this call: a campaign name, "none" (hotel / no campaign) or "all". Default: ${focus ? `"${focus}" (the campaign the owner has open)` : 'all campaigns'}.`);
  const tool = (name, description, inputSchema, fn) => {
    const shape = { ...inputSchema };
    if (name === 'update_task') shape.in_campaign = CAMPAIGN_FILTER;
    else if (!shape.campaign) shape.campaign = CAMPAIGN_FILTER;
    server.registerTool(name, { description, inputSchema: shape }, safe(async (a = {}) => {
      const c = callCampaign(name, a, focus);
      await enforceScope(c, name, a);
      a._c = c; // handlers filter by it
      return fn(a);
    }, name === 'get_playbook' ? Infinity : RESPONSE_BUDGET)); // the owner's rules are never cut
  };

  tool('list_accounts', 'List the WhatsApp numbers in the hub: id, purpose, phone, connection status, AI mode (approve/auto), and how much history is stored. Start here.', {}, async () => {
    const lines = [];
    await manager.refresh();
    for (const a of manager.list()) {
      const st = await store.accountStats(a.id);
      const bf = await outbox.backfillStatus(a.id);
      const mode = normalizeSettings(a.settings).historyMode;
      const phases = a.sync?.phases || {};
      const imported = mode === 'full' ? phases.FULL : mode === 'recent' ? phases.RECENT : phases.INITIAL_BOOTSTRAP;
      const nc = await outbox.newChatsStatus(a.id, normalizeSettings(a.settings));
      lines.push(
        `${a.id}${a.isDefault ? ' (default)' : ''} | ${a.label} | ${a.provider === 'cloud' ? `META CLOUD API (${a.cloud?.canSend && a.cloud.canSend !== 'AVAILABLE' ? `CAN SEND: ${a.cloud.canSend} — ${(a.cloud.issues || []).join('; ')}; ` : ''}quality ${a.cloud?.quality || '?'}, name ${a.cloud?.nameStatus || '?'}, tier ${a.cloud?.tier || '?'}; first messages & follow-ups need a Meta template — list_meta_templates) | ` : 'linked phone | '}purpose: ${a.purpose || '-'} | +${a.phone || '?'} | ${a.status} | ai:${a.settings.aiMode} | ` +
          `${st.chats} chats (${st.groups} groups), ${st.contacts} contacts, ${st.messages} msgs since ${fmtTime(st.oldest_ts)} | history chosen at link: ${HISTORY_MODES[mode]} (${imported === 'complete' ? 'imported' : 'importing'})` +
          (bf ? ` | deep history #${bf.id}: ${bf.status}${bf.result ? ' — ' + bf.result : ''}` : '') +
          ` | new numbers last 24h: ${nc.count}/${nc.limit}${nc.nextFreeAt ? ' (limit reached)' : ''}` +
          (a.reachout?.isActive ? ` | WHATSAPP BLOCKS NEW CHATS until ${a.reachout.timeEnforcementEnds || '?'}` : '') +
          (await sendingLine(a)),
      );
    }
    return lines.join('\n') || 'No accounts yet.';
  });

  tool('hub_overview', 'START HERE. One screen, in priority order, across ALL numbers: what is due now on the Board (replies, follow-ups, call notes, interviews), drafts waiting, each number\'s sending state (and why it is held), Meta budget and spend today, lists per number, recent failures. Give campaign (job role, e.g. "Front office") to focus on one campaign when you were asked to work on it — other campaigns are then left out. Then use the specific tools.', {
    campaign: z.string().optional().describe('Campaign = job role, e.g. Chef, Front office, Housekeeping; "none" = chats on no list (hotel guests)'),
  }, async (a) => {
    await manager.refresh();
    const out = [];
    const now = new Date();
    const open = await tasks.listTasks({ limit: 500, role: a.campaign });
    if (a.campaign) {
      out.push(`FOCUS: campaign "${a.campaign}" only — other campaigns are left out of this overview. Every tool filters to ${focus ? `the campaign open in the dashboard (${scope.label(focus)})` : "all campaigns"} unless you pass campaign="<name>" or "all".`);
      const cp = await getCampaignPlaybook(a.campaign);
      out.push(cp ? `CAMPAIGN PLAYBOOK — ${cp.campaign} (follow it together with the main playbook):\n${cp.text}\n---` : `(No campaign playbook for "${a.campaign}" — follow the main playbook.)`);
    }
    const campaigns = await query(`SELECT DISTINCT role FROM lists WHERE role IS NOT NULL AND archived IS NULL ORDER BY role`);
    if (!a.campaign && campaigns.length > 1) out.push(`Campaigns running: ${campaigns.map((c) => c.role).join(', ')} — pass campaign=<role> to focus on one.`);
    const dueNow = open.filter((t) => !t.due_at || new Date(t.due_at) <= new Date(now.getTime() + 3600e3));
    const later = open.filter((t) => t.due_at && new Date(t.due_at) > new Date(now.getTime() + 3600e3));
    const byKind = (rows, k) => rows.filter((t) => t.kind === k).length;
    out.push(`1. DUE NOW (${dueNow.length}): ${byKind(dueNow, 'reply')} replies to answer, ${byKind(dueNow, 'followup')} follow-ups, ${dueNow.filter((t) => /^Call notes needed/.test(t.title)).length} call notes needed, ${dueNow.filter((t) => t.priority && (t.assignee || 'you') === 'you').length} owner must-dos. → list_tasks(for="ai", due_now=true), list_tasks(kind="reply")`);
    for (const t of dueNow.filter((x) => x.priority || x.kind === 'reply' || x.kind === 'followup').slice(0, 12)) out.push(`   - #${t.id} ${(t.assignee || 'you') === 'ai' ? 'AI' : 'owner'}${t.priority ? ' PRIORITY' : ''}: ${trim(t.title, 90)}`);
    const recentlyClosed = (await tasks.listTasks({ past: true, limit: 300, role: a.campaign })).filter((t) => t.completed_at && new Date(t.completed_at) > new Date(Date.now() - 7 * 86400e3));
    const pendingNotes = [...open, ...recentlyClosed].filter((t) => t.owner_note_pending);
    if (pendingNotes.length) {
      out.push(`   OWNER NOTES TO ACT ON (${pendingNotes.length}) → list_tasks(owner_notes=true), do what each says, then add_task_note:`);
      for (const t of pendingNotes.slice(0, 8)) out.push(`   - #${t.id} ${trim(t.title, 60)} — "${trim(t.last_note, 120)}"`);
    }
    // the inbox: who is waiting for an answer — including people on no list, who get no "Reply to" card
    const waiting = await inboxRows({ since: Math.floor(Date.now() / 1000) - 3 * 86400, campaign: a.campaign, limit: 200 }).catch(() => []);
    const unanswered = waiting.filter((w) => !w.waiting_msg);
    const noCard = unanswered.filter((w) => !w.card);
    out.push(`   INBOX (people on lists): ${unanswered.length} chat(s) waiting for an answer (last 3 days, no draft yet)${noCard.length ? `; ${noCard.length} with no open card (closed earlier, new message since) → inbox_summary` : ''}`);
    for (const w of noCard.slice(0, 6)) out.push(`   - ${w.account_id}: ${w.name || '+' + w.chat_jid.split('@')[0]}${w.campaign ? ` · ${w.campaign}` : ''}${w.stage ? ` [${w.stage}]` : ''} — "${trim(w.body || '[' + w.type + ']', 80)}"`);
    const [fb] = await query(`SELECT count(*)::int n FROM outbox WHERE status = 'rejected' AND error LIKE 'Rejected:%' AND created_at > now() - interval '3 days'`);
    if (fb.n) out.push(`   OWNER FEEDBACK: ${fb.n} draft(s) rejected with a reason in the last 3 days → owner_feedback (some reasons are instructions, e.g. "wish him on festivals")`);
    const upcomingVisits = later.filter((t) => t.kind === 'visit').slice(0, 5);
    out.push(`2. COMING UP: ${later.length} dated cards${upcomingVisits.length ? '; interviews: ' + upcomingVisits.map((t) => trim(t.title.replace(/^Interview: /, ''), 50)).join('; ') : ''}`);
    const [dr] = a.campaign
      ? await query(`SELECT count(*)::int n FROM outbox o WHERE o.status = 'draft' AND ${roleFilter(`COALESCE(o.role, ${roleOf('o.account_id', 'o.to_jid')})`, 1)}`, [a.campaign])
      : await query(`SELECT count(*)::int n, count(DISTINCT account_id)::int a FROM outbox WHERE status = 'draft'`);
    out.push(`3. DRAFTS WAITING FOR OWNER APPROVAL: ${dr.n}${dr.n ? ' (list_outbox status=draft) — the owner approves; never approve unless told to' : ''}`);
    const rej = await query(`SELECT o.id, o.account_id, o.to_jid, o.error FROM outbox o WHERE o.status = 'rejected' AND o.source <> 'campaign' AND o.created_at > now() - interval '48 hours'
      AND ($1::text IS NULL OR ${roleFilter(`COALESCE(o.role, ${roleOf('o.account_id', 'o.to_jid')})`, 1)}) ORDER BY o.id DESC LIMIT 8`, [a.campaign || null]);
    if (rej.length) out.push(`   Owner REJECTED recently (don't draft the same again; the reason is a note on their card): ${rej.map((r) => `#${r.id} ${r.to_jid.split('@')[0]} on ${r.account_id}${r.error?.startsWith('Rejected:') ? ' — ' + r.error.slice(10, 90) : ''}`).join('; ')}`);
    out.push('4. NUMBERS:');
    for (const a of manager.list()) out.push(`   - ${a.id} (${a.label}, ${a.provider === 'cloud' ? 'Meta API' : 'linked phone'}): ${a.status}${await sendingLine(a)}`);
    const ls = await lists.listLists(null, a.campaign && a.campaign !== 'none' ? a.campaign : null);
    const arch = (await query(`SELECT count(*)::int n FROM lists WHERE archived IS NOT NULL`))[0].n;
    out.push(`5. LISTS (all numbers${arch ? `; ${arch} archived hidden — list_lists(include_archived=true)` : ''}):`);
    for (const l of ls.slice(0, 15)) out.push(`   - #${l.id} ${l.name} on ${l.account_id}: ${l.total} people, ${l.new} new, ${l.queued} queued, ${l.replied} replied, ${l.failed} failed`);
    const fails = await query(`SELECT o.account_id, o.error, count(*)::int n FROM outbox o WHERE o.status = 'failed' AND o.created_at > now() - interval '24 hours'
      AND ($1::text IS NULL OR ${roleFilter(`COALESCE(o.role, ${roleOf('o.account_id', 'o.to_jid')})`, 1)}) GROUP BY 1,2 ORDER BY 3 DESC LIMIT 5`, [a.campaign || null]);
    out.push(`6. FAILED LAST 24 H: ${fails.length ? fails.map((f) => `${f.n}× on ${f.account_id}: ${trim(f.error, 90)}${helpFor(f.error)}`).join('\n   ') : 'none'}`);
    out.push('Done/finished tasks are hidden by default: list_tasks(past=true). Tool guide: get_playbook (section HOW TO USE THE HUB).');
    return out.join('\n');
  });

  tool(
    'list_chats',
    'List chats newest first, one line each (id | name | last message time | who spoke last: preview | tags/status/summary). Use filters instead of paging through everything.',
    {
      account: accountArg,
      query: z.string().optional().describe('Filter by name/number'),
      kind: z.enum(['direct', 'group', 'all']).optional(),
      tag: z.string().optional(),
      waiting_on_me: z.boolean().optional().describe('Only chats where the other side spoke last'),
      campaign: z.string().optional().describe('Campaign = job role, e.g. Chef, Front office, Housekeeping; "none" = chats on no list (hotel guests)'),
      state: z.enum(['open', 'snoozed', 'due', 'done']).optional().describe('open (incl. due reminders), snoozed (reminder pending), due (reminder date reached), done'),
      active_since: z.string().optional().describe('Last message on/after this date (YYYY-MM-DD)'),
      inactive_since: z.string().optional().describe('Last message before this date (YYYY-MM-DD) — good for finding stale leads'),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async (a) => {
      const s = await manager.resolve(a.account);
      const rows = await store.listChats(s.id, {
        q: a.query, kind: a.kind === 'all' ? undefined : a.kind, tag: a.tag, waitingOnMe: a.waiting_on_me, state: a.state, role: a.campaign,
        sinceTs: toTs(a.active_since), beforeTs: toTs(a.inactive_since), limit: a.limit || 20, offset: a.offset || 0,
      });
      return rows.length ? rows.map(chatLine).join('\n') : 'No chats match.';
    },
  );

  tool(
    'get_messages',
    'Read messages of one chat, oldest→newest. Defaults to the latest 20; use before/after (YYYY-MM-DD or unix) to page. Long texts are trimmed unless full_text is true.',
    {
      account: accountArg,
      chat: chatArg,
      limit: z.number().int().min(1).max(200).optional(),
      before: z.string().optional(),
      after: z.string().optional(),
      full_text: z.boolean().optional(),
    },
    async (a) => {
      const s = await manager.resolve(a.account);
      const jid = await resolveChat(s.id, a.chat);
      const rows = await store.getMessages(s.id, jid, { limit: a.limit || 20, beforeTs: toTs(a.before), afterTs: toTs(a.after) });
      if (!rows.length) return `No messages stored for ${jid}.`;
      return `${jid}\n` + rows.map((m) => msgLine(m, a.full_text ? 100000 : 300)).join('\n');
    },
  );

  tool(
    'search_messages',
    'Search message text across chats (all accounts if account is omitted). Returns matching lines with chat id/name. Combine with since/until/from_me to stay focused.',
    {
      query: z.string().describe('Words to find (supports "exact phrase", OR, -exclude)'),
      account: z.string().optional().describe('Account id; omit to search every account'),
      chat: z.string().optional(),
      from_me: z.boolean().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      type: z.enum(['text', 'image', 'video', 'document', 'audio', 'voice', 'contact', 'location', 'sticker', 'poll']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async (a) => {
      const accountId = a.account ? (await manager.resolve(a.account)).id : null;
      const chatJid = a.chat && accountId ? await resolveChat(accountId, a.chat) : a.chat;
      const rows = await store.searchMessages(accountId, a.query, {
        chatJid, fromMe: a.from_me, sinceTs: toTs(a.since), untilTs: toTs(a.until), type: a.type, limit: a.limit || 20, campaign: a._c || undefined,
      });
      return rows.length
        ? rows.map((m) => `${m.account_id} | ${m.chat_jid} | ${trim(m.chat_name, 30)} | ${msgLine(m, 200)}`).join('\n')
        : 'No matches.';
    },
  );

  tool('find_people', 'Find PEOPLE (one line per chat) whose messages or saved name mention any of the words — for campaigns and segments: old guests to win back, company HRs / corporate bookers, travel agents, people who asked about rooms or rates. Unlike search_messages (newest 100 messages), this covers ALL history and lists each person once with how many messages matched, when, a sample and their last message. Skips groups and job candidates by default. Page with offset; then read promising chats with person_context or get_messages before drafting.', {
    account: accountArg,
    words: z.string().describe('Words to look for, any of them, e.g. "corporate company GST invoice travels agency booking rooms rate". 4+ letters also match inside words (travel → Youngtravels); shorter ones (HR) only as whole words'),
    who: z.enum(['them', 'me', 'any']).optional().describe('"them" (default) = they wrote it — what they asked for; "me" = we wrote it; "any"'),
    since: z.string().optional(), until: z.string().optional().describe('Only matches before this date (YYYY-MM-DD) — e.g. old leads'),
    include_groups: z.boolean().optional(), include_candidates: z.boolean().optional().describe('Also people on job candidate lists (default false)'),
    limit: z.number().int().min(1).max(500).optional().describe('People per page (default 50, at most 60 — page on with offset)'), offset: z.number().int().min(0).optional(),
  }, async (a) => {
    const s = await manager.resolve(a.account);
    const r = await store.searchPeople(s.id, a.words, { who: a.who || 'them', sinceTs: toTs(a.since), untilTs: toTs(a.until),
      peopleOnly: !a.include_groups, excludeCandidates: !a.include_candidates && (!a._c || scope.same(a._c, 'none')), campaign: a._c || undefined, excludePhones: await (await import('./notify.js')).alertPhones(), limit: Math.min(a.limit || 50, 60), offset: a.offset || 0 });
    if (!r.total) return `Nobody on ${s.id} matches ${r.words.join(', ')}${a.who === 'me' ? '' : ' (in their own messages — try who="any")'}.`;
    const from = (a.offset || 0) + 1;
    const lines = r.rows.map((x) => [x.chat_jid.split('@')[0], trim(x.name, 34), x.n ? `${x.n}× last ${fmtTime(x.last_hit).slice(0, 10)}: "${trim(x.sample, 80)}"` : 'name matches',
      `last chat ${fmtTime(x.last_ts).slice(0, 10)} ${x.last_from_me ? 'me' : 'them'}: ${trim(x.last_preview, 45)}`, x.tags?.length ? `tags:${x.tags.join(',')}` : null, x.summary ? `summary:${trim(x.summary, 80)}` : null].filter(Boolean).join(' | '));
    const next = r.total > from - 1 + r.rows.length ? `\nMore: offset=${from - 1 + r.rows.length} (${r.total - (from - 1 + r.rows.length)} left).` : '';
    return `${r.total} people on ${s.id} match ${r.words.join(', ')} — showing ${from}–${from - 1 + r.rows.length}, most recent match first (number | name | matches | their chat):\n${lines.join('\n')}${next}`;
  });

  tool(
    'list_shared_contacts',
    'List contact cards (vCards) shared in chats/groups — e.g. leads posted in a group. Returns name, organisation, phone numbers, where and when it was shared.',
    { account: accountArg, chat: z.string().optional(), since: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
    async (a) => {
      const s = await manager.resolve(a.account);
      const chatJid = a.chat ? await resolveChat(s.id, a.chat) : null;
      const p = [s.id];
      let where = "m.account_id = $1 AND m.type = 'contact'";
      if (a._c) {
        p.push(a._c);
        where += ` AND ${scope.personInSql('m.chat_jid', p.length)}`;
      }
      if (chatJid) {
        p.push(chatJid);
        where += ` AND m.chat_jid = $${p.length}`;
      }
      if (a.since) {
        p.push(toTs(a.since));
        where += ` AND m.ts >= $${p.length}`;
      }
      p.push(a.limit || 50);
      const rows = await query(
        `SELECT m.chat_jid, ch.name AS chat_name, m.ts, m.from_me, m.vcards,
           -- older group messages have no stored sender name: use the sender's contact name, else their number
           COALESCE(m.sender_name, (SELECT COALESCE(c.saved_name, c.name, c.notify) FROM contacts c WHERE c.account_id = m.account_id AND c.jid = m.sender_jid), split_part(m.sender_jid, '@', 1)) AS sender_name
         FROM messages m
         LEFT JOIN chats ch ON ch.account_id = m.account_id AND ch.jid = m.chat_jid
         WHERE ${where} ORDER BY m.ts DESC LIMIT $${p.length}`,
        p,
      );
      const lines = [];
      for (const r of rows) {
        for (const v of r.vcards || []) {
          lines.push(`${v.name || '?'}${v.org ? ` (${v.org})` : ''} | ${v.phones.join(', ') || 'no number'} | shared ${fmtTime(r.ts)} by ${r.from_me ? 'me' : r.sender_name || '?'} in ${trim(r.chat_name || r.chat_jid, 40)}`);
        }
      }
      return lines.join('\n') || 'No shared contacts found.';
    },
  );

  tool(
    'find_followups',
    'Find chats that went quiet: last message older than N days. Use to spot old leads/candidates to follow up. Returns compact chat lines; read individual chats with get_messages only for promising ones.',
    {
      account: accountArg,
      inactive_days: z.number().int().min(1).optional().describe('Quiet for at least this many days (default 14)'),
      max_age_days: z.number().int().min(1).optional().describe('Ignore chats quiet for longer than this'),
      last_from: z.enum(['them', 'me', 'any']).optional().describe('"them" = they wrote last and got no reply; "me" = I wrote last, no answer'),
      kind: z.enum(['direct', 'group', 'all']).optional(),
      tag: z.string().optional(),
      skip_reviewed: z.boolean().optional().describe('Skip contacts already marked reviewed (default true)'),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async (a) => {
      const s = await manager.resolve(a.account);
      const now = Math.floor(Date.now() / 1000);
      const p = [s.id, now - (a.inactive_days || 14) * 86400];
      const where = ['ch.account_id = $1', 'ch.last_ts < $2'];
      if (a.max_age_days) {
        p.push(now - a.max_age_days * 86400);
        where.push(`ch.last_ts >= $${p.length}`);
      }
      if (a.last_from === 'them') where.push('ch.last_from_me = FALSE');
      if (a.last_from === 'me') where.push('ch.last_from_me = TRUE');
      const kind = a.kind || 'direct';
      if (kind === 'direct') where.push('NOT ch.is_group');
      if (kind === 'group') where.push('ch.is_group');
      if (a.tag) {
        p.push(a.tag);
        where.push(`$${p.length} = ANY(ct.tags)`);
      }
      if (a.skip_reviewed !== false) where.push('ct.reviewed_at IS NULL');
      if (a._c) {
        p.push(a._c);
        where.push(scope.personInSql('ch.jid', p.length));
      }
      where.push("NOT ('opted-out' = ANY(COALESCE(ct.tags, '{}')))");
      p.push(a.limit || 30, a.offset || 0);
      const rows = await query(
        `SELECT ch.jid, COALESCE(NULLIF(ch.name,''), ct.name, ct.notify, ct.phone, ch.jid) AS name, ch.is_group, ch.participants,
                ch.last_ts, ch.last_preview, ch.last_from_me, ct.tags, ct.lead_status, ct.summary, ct.is_blocked
         FROM chats ch LEFT JOIN contacts ct ON ct.account_id = ch.account_id AND ct.jid = ch.jid
         WHERE ${where.join(' AND ')} ORDER BY ch.last_ts DESC LIMIT $${p.length - 1} OFFSET $${p.length}`,
        p,
      );
      return rows.length ? rows.map(chatLine).join('\n') : 'Nothing matches.';
    },
  );

  tool('get_contact', 'Profile of one contact: names, number, tags, lead status, notes, AI summary, message count, first/last contact, blocked.', { account: accountArg, chat: chatArg }, async (a) => {
    const s = await manager.resolve(a.account);
    const jid = await resolveChat(s.id, a.chat);
    const c = await store.getContact(s.id, jid);
    if (!c) return `No contact record for ${jid}.`;
    return [
      `${jid} | saved name: ${c.name || '-'} | WhatsApp name: ${c.notify || '-'}${c.verified_name ? ` | business: ${c.verified_name}` : ''}`,
      `messages: ${c.message_count} | first: ${fmtTime(c.first_ts)} | last: ${fmtTime(c.last_ts)} (${c.last_from_me ? 'me' : 'them'})${c.is_blocked ? ' | BLOCKED' : ''}`,
      `tags: ${c.tags?.join(', ') || '-'} | status: ${c.lead_status || '-'} | reviewed: ${c.reviewed_at ? new Date(c.reviewed_at).toISOString().slice(0, 10) : 'no'}`,
      c.summary ? `summary: ${c.summary}` : null,
      c.notes ? `notes: ${c.notes}` : null,
    ].filter(Boolean).join('\n');
  });

  tool(
    'update_contact',
    'Save what you learned about a contact so future sessions read this instead of the whole chat: tags (e.g. candidate, guest, lead-hot, follow-up), lead status, notes, a one-line summary, and mark_reviewed.',
    {
      account: accountArg,
      chat: chatArg,
      add_tags: z.array(z.string()).optional(),
      remove_tags: z.array(z.string()).optional(),
      lead_status: z.string().optional().describe('e.g. new, contacted, interested, not-interested, hired, booked, lost'),
      notes: z.string().optional(),
      summary: z.string().optional().describe('One or two lines'),
      mark_reviewed: z.boolean().optional(),
      name: z.string().optional().describe('Save the contact under this name (kept even when WhatsApp reports another)'),
    },
    async (a) => {
      const s = await manager.resolve(a.account);
      const jid = await resolveChat(s.id, a.chat);
      await ai(s.id, `Updated contact ${jid.split('@')[0]}${a.add_tags?.length ? ' +' + a.add_tags.join(',') : ''}${a.remove_tags?.length ? ' -' + a.remove_tags.join(',') : ''}${a.lead_status ? ' status ' + a.lead_status : ''}`);
      const c = await store.updateContact(s.id, jid, {
        addTags: a.add_tags, removeTags: a.remove_tags, leadStatus: a.lead_status, notes: a.notes, summary: a.summary, markReviewed: a.mark_reviewed, name: a.name,
      });
      return `Saved ${jid}: tags=${c.tags.join(',') || '-'} status=${c.lead_status || '-'}`;
    },
  );

  tool(
    'send_message',
    'Send a WhatsApp message (optionally with a file from a URL: PDF, image, voucher). Respects the account\'s AI mode: in "approve" mode it becomes a draft the owner approves in the dashboard; in "auto" mode it is queued with the account\'s random delay, daily cap and sending hours. Tell the user which happened.',
    {
      account: accountArg,
      to: chatArg,
      text: z.string().optional(),
      attachment_url: z.string().optional().describe('Public URL or Google Drive link of the file to send'),
      file_name: z.string().optional(),
      send_as: z.enum(['document', 'image', 'video', 'audio']).optional(),
      note: z.string().optional().describe('Why this message is being sent (shown to the owner on the draft)'),
      task_id: z.number().int().optional().describe('Attach to a task on the board (e.g. a follow-up task)'),
      template: z.string().optional().describe('Use a saved template (name or id) instead of text; {name}/{first_name}/{phone} are filled from the contact'),
      vars: z.record(z.string(), z.string()).optional().describe('Values for other {fields} in the template, e.g. {"role":"Chef"}'),
      reply_to_message_id: z.string().optional().describe('Quote this message (id from get_messages) in the reply'),
      idempotency_key: z.string().optional().describe('Optional unique key; retrying with the same key never sends twice'),
      wa_template: waTemplateArg.describe('Meta Cloud API numbers only: send this approved Meta template (required when the person has not written in the last 24 h)'),
      buttons: z.array(z.string()).max(3).optional().describe('Up to 3 tap-to-reply answers, e.g. ["Haan, aaunga","Nahi"] (≤20 chars). Meta numbers show buttons; linked numbers list them as "Reply: …"'),
      schedule_at: z.string().optional().describe('Send later: "YYYY-MM-DD HH:MM" (India time) or ISO. It shows on the Board as "Scheduled: …" until it goes out. In approve mode the owner still approves it first.'),
      other_number_ok: z.boolean().optional().describe('Only if the owner asked: start a chat on this number although the person already chats with another number'),
      expires_at: z.string().optional().describe('"Send by": if it has not gone out by this time ("YYYY-MM-DD HH:MM" owner time or ISO) it is dropped — set it for anything tied to a day (festival / birthday wishes, offers ending, reminders before an interview). Such messages go out before other outreach; the hub warns the owner if the number\'s daily limit can\'t fit them in time.'),
    },
    async (a) => {
      const s = await manager.resolve(a.account);
      const jid = await resolveChat(s.id, a.to);
      // Wrong-number guard: a person who chats with another number is answered from that number
      if (!a.other_number_ok && !jid.endsWith('@g.us')) {
        const [here] = await query('SELECT 1 FROM messages WHERE account_id = $1 AND chat_jid = $2 LIMIT 1', [s.id, jid]);
        if (!here) {
          const other = await query('SELECT account_id, max(ts) AS ts FROM messages WHERE chat_jid = $1 AND account_id <> $2 GROUP BY 1 ORDER BY 2 DESC', [jid, s.id]);
          if (other.length) return `Not drafted: ${jid.split('@')[0]} has never chatted with "${s.id}" — their chat is on ${other.map((o) => `"${o.account_id}"`).join(', ')}. Draft on that number (account="${other[0].account_id}"). Use other_number_ok=true only if the owner asked.`;
        }
      }
      const scheduledAt = localTime(a.schedule_at) || undefined;
      const expiresAt = localTime(a.expires_at) || null;
      if (s.isCloud && !a.wa_template) {
        const w = await s.windowFor(jid);
        if (w.open && scheduledAt && w.closesAt && new Date(scheduledAt) > new Date(w.closesAt)) {
          return `The 24-hour window with ${jid.split('@')[0]} closes before ${scheduledAt}: free text won't be allowed then. Schedule it with wa_template instead.`;
        }
        if (!w.open) return `"${s.id}" is a Meta Cloud API number and ${jid.split('@')[0]} ${w.closesAt ? 'last wrote over 24 h ago' : 'has never written'} — free text is not allowed. Use wa_template (see list_meta_templates).`;
      }
      if (a.wa_template) {
        const vars = await import('./templates.js').then((t) => t.contactFields(s.id, jid));
        const row = await outbox.enqueue({ account: s.id, to: jid, payload: { waTemplate: outbox.fillWaTemplate(a.wa_template, vars) }, source: 'mcp', note: a.note, taskId: a.task_id, idemKey: a.idempotency_key, scheduledAt, expiresAt, role: a._c && !scope.same(a._c, 'none') ? a._c : null });
        if (row.duplicate) return `Already handled earlier as #${row.id} (${row.status}) — not sent again.`;
        await ai(s.id, `${row.status === 'draft' ? 'Drafted' : 'Queued'} Meta template "${a.wa_template.name}" #${row.id} to ${jid.split('@')[0]}${a.note ? ` — ${a.note}` : ''}`);
        return `${row.status === 'draft' ? 'Draft' : 'Queued'} #${row.id} (Meta template "${a.wa_template.name}"): "${trim(row.payload.text, 200)}"`;
      }
      let attachment = a.attachment_url ? { url: a.attachment_url, fileName: a.file_name, as: a.send_as } : undefined;
      let text = a.text;
      if (a.template) {
        const r = await outbox.renderTemplate(s.id, jid, a.template, a.vars || {});
        if (r.missing.length) return `Template "${r.template.name}" needs values for: ${r.missing.join(', ')} — pass them in vars.`;
        text = text || r.payload.text;
        attachment = attachment || r.payload.attachment;
      }
      const payload = { text, attachment, ...(a.reply_to_message_id ? { replyTo: a.reply_to_message_id } : {}), ...(a.buttons?.length && !attachment ? { buttons: a.buttons } : {}) };
      const row = await outbox.enqueue({ account: s.id, to: jid, payload, source: 'mcp', note: a.note, taskId: a.task_id, idemKey: a.idempotency_key, scheduledAt, expiresAt, role: a._c && !scope.same(a._c, 'none') ? a._c : null });
      if (row.duplicate) return `Already handled earlier as #${row.id} (${row.status}) — not sent again.`;
      const later = scheduledAt ? ` for ${d(scheduledAt)}` : '';
      await ai(s.id, `${row.status === 'draft' ? 'Drafted' : 'Queued'} message #${row.id} to ${jid.split('@')[0]}${later}${a.note ? ` — ${a.note}` : ''}`);
      return row.status === 'draft'
        ? `Draft #${row.id} created for ${jid}${later} — waiting for approval in the dashboard (account "${s.id}" is in approve mode).`
        : `Queued #${row.id} for ${jid}${later ? `; it goes out${later}` : '; it goes out after the random delay, within sending hours and the daily cap'}.`;
    },
  );

  tool('save_contact', 'Save a person in the hub\'s Contacts, filed in a GROUP by why they matter — e.g. "Chef hiring – Referrers" (gave a reference), "Chef hiring – Referred" (a referred candidate), "Catering", "Placement agents", "Vendors & services", "Travel agents", "Corporate clients", "Guests". Always give the reason (what they did / why keep them). Save anyone who helped (referrals, suppliers, agents) so they are found when the need comes up again. With account, the name also shows in that number\'s inbox.', {
    phone: z.string(), name: z.string(), group: z.string().describe('e.g. "Chef hiring – Referrers", "Catering", "Travel agents"'),
    reason: z.string().describe('Why they are worth keeping, e.g. "Referred chef Jay Raam on 23 Oct"'),
    notes: z.string().optional(), tags: z.array(z.string()).optional(), referred_by: z.string().optional().describe('Phone of the person who referred them'),
    account: z.string().optional().describe('Number whose inbox should also show this name (makes a chat to message them)'),
  }, async (a) => {
    const d = await import('./directory.js');
    const row = await d.saveEntry({ phone: a.phone, name: a.name, category: a.group, reason: a.reason, notes: a.notes, tags: a.tags, referredBy: a.referred_by, account: a.account ? (await manager.resolve(a.account)).id : null, createdBy: 'ai', role: a._c || null });
    if (a.account) await store.saveContact((await manager.resolve(a.account)).id, a.phone, a.name);
    await ai(a.account ? (await manager.resolve(a.account)).id : null, `Saved ${row.name} in Contacts → ${row.category}`);
    return `Saved ${row.name} (+${row.phone}) in "${row.category}" — ${row.reason || ''}`;
  });

  tool('find_contacts', 'Search the hub\'s Contacts (people kept for a reason) — use it FIRST whenever a need comes up: hiring a role ("chef"), a supplier ("caterer"), agents, a guest campaign, or "who referred…". Every word must match name, group, reason, notes or tags. No query → the list of groups with counts.', {
    query: z.string().optional(), group: z.string().optional(),
  }, async (a) => {
    const d = await import('./directory.js');
    if (!a.query && !a.group) {
      const g = await d.groups({ role: a._c || null });
      return g.length ? 'Contact groups:\n' + g.map((x) => `${x.category}: ${x.n}`).join('\n') : 'No contacts saved yet.';
    }
    const rows = await d.search({ q: a.query || '', category: a.group || '', role: a._c || null });
    return rows.length
      ? rows.map((r) => [`${r.name || '-'} | +${r.phone} | ${r.category}`, r.reason, r.notes ? `notes: ${trim(r.notes, 120)}` : null, r.referred_by_name ? `referred by ${r.referred_by_name}` : null,
          r.tags?.length ? `tags: ${r.tags.join(',')}` : null, r.chat_accounts?.length ? `chat on ${r.chat_accounts.join(', ')}` : 'no chat yet'].filter(Boolean).join(' | ')).join('\n')
      : 'Nobody matches. Try fewer or different words, or find_contacts() for the groups.';
  });

  tool('list_outbox', 'List drafts / queued / sent / failed / rejected messages (AI, campaigns, API), newest first. Zoom in: ids=[…] or full=true shows each message COMPLETE (whole text, picture/file, send time, "send by", list, task, note, rejection reason). search finds words in the text, note or reason; to = one person; offset pages through. Owner rejection reasons show as "error: Rejected: …" — read and follow them.', {
    account: z.string().optional(),
    status: z.string().optional().describe('Comma list: draft,queued,sent,failed,rejected (default draft,queued,failed; with ids: any)'),
    limit: z.number().int().min(1).max(500).optional().describe('Default 20 (full=true: 10)'),
    offset: z.number().int().min(0).optional(),
    ids: z.array(z.number().int()).optional().describe('Exactly these messages (any status), shown in full'),
    full: z.boolean().optional().describe('Whole text and every detail, not a 100-character preview'),
    search: z.string().optional().describe('Words in the message text, picture caption, note or rejection reason, e.g. "Sir / Madam"'),
    to: z.string().optional().describe('Only messages to this phone number'),
    campaign: z.string().optional().describe('Campaign = job role, e.g. Chef, Front office, Housekeeping; "none" = chats on no list (hotel guests)'),
  }, async (a) => {
    const full = a.full || !!a.ids?.length;
    const rows = await outbox.listOutbox({ account: a.account, status: a.ids?.length && !a.status ? undefined : a.status || 'draft,queued,failed', limit: a.limit || (full ? 10 : 20),
      role: a.ids?.length ? undefined : a.campaign, ids: a.ids, search: a.search, to: a.to, offset: a.offset });
    const p = await priceRows(rows, manager);
    if (full) {
      return rows.length ? rows.map((r, i) => [
        `=== #${r.id} | ${r.account_id} | ${r.status} | ${r.campaign || 'no campaign'} | to ${r.to_jid}${r.to_name ? ` (${r.to_name})` : ''} | ${money(p.items[i].price, p.currency)}`,
        `created ${d(r.created_at)} by ${r.source} · goes out ${d(r.scheduled_at)}${r.expires_at ? ` · send by ${d(r.expires_at)}` : ''}${r.sent_at ? ` · sent ${d(r.sent_at)}` : ''}${r.task_id ? ` · task #${r.task_id}${r.task_title ? ` "${r.task_title}"` : ''}` : ''}${r.list_id ? ` · list #${r.list_id}` : ''}${r.note ? ` · note: ${r.note}` : ''}`,
        r.payload.waTemplate ? `Meta template "${r.payload.waTemplate.name}" (wording fixed by Meta)` : null,
        r.payload.attachment ? `Picture/file: ${r.payload.attachment.url || '(uploaded file)'}${r.payload.attachment.fileName ? ` (${r.payload.attachment.fileName})` : ''}` : null,
        `Text:\n${r.payload.text ?? r.payload.attachment?.caption ?? '(none)'}`,
        r.error ? `${/^Rejected:/.test(r.error) ? 'OWNER/AI REJECTION REASON' : 'error'}: ${r.error}${helpFor(r.error)}` : null,
      ].filter(Boolean).join('\n')).join('\n\n') + (rows.length === (a.limit || 10) ? `\n\n(more: offset=${(a.offset || 0) + rows.length})` : '') : 'Nothing.';
    }
    return rows.length
      ? rows.map((r, i) => `#${r.id} | ${r.account_id} | ${r.status}${['draft', 'queued'].includes(r.status) && new Date(r.scheduled_at) > new Date(Date.now() + 60000) ? ` (for ${d(r.scheduled_at)})` : ''}${r.expires_at && ['draft', 'queued'].includes(r.status) ? ` (send by ${d(r.expires_at)})` : ''}${r.campaign ? ` | ${r.campaign}` : ''} | ${money(p.items[i].price, p.currency)} | ${r.to_jid}${r.to_name ? ` (${r.to_name})` : ''} | ${trim(r.payload.text || r.payload.attachment?.caption || '[file]', 100)}${r.error ? ` | error: ${r.error}${helpFor(r.error)}` : ''}`).join('\n')
        + `\nTotal of these: ${money(p.total, p.currency)}${rows.length === (a.limit || 20) ? ` · more: offset=${(a.offset || 0) + rows.length}` : ''} · whole messages: ids=[…] or full=true`
      : 'Nothing.';
  });

  tool('move_messages', 'Move unsent messages (drafts or queued, by id from list_outbox) to another number — e.g. when a number is blocked or logged out. Drafts stay drafts, approved ones stay approved. Moving plain text to a Meta API number only moves people who wrote in the last 24 h.', {
    ids: z.array(z.number().int()).min(1), account: z.string().describe('Number that should send them'),
  }, async (a) => {
    const r = await outbox.moveToAccount(a.ids, a.account);
    for (const [from, n] of Object.entries(r.from)) await ai(from, `Moved ${n} unsent messages to "${r.toLabel}"`);
    return `Moved ${r.moved} to ${r.toLabel} (${r.approved} already approved, ${r.drafts} drafts)${r.kept ? `; ${r.kept} stayed (Meta number can only send them a template)` : ''}.`;
  });

  tool('approve_draft','Approve (and optionally edit) a draft so it gets sent. Only use when the user has explicitly approved it in this conversation.', {
    id: z.number().int(), text: z.string().optional(),
  }, async (a) => {
    const r = await outbox.approve(a.id, { text: a.text });
    await ai(r.account_id, `Approved draft #${r.id} (owner approved in chat)`);
    return `Draft #${r.id} approved and queued.`;
  });

  tool('reject_draft', 'Discard a draft or a queued message (e.g. your own mistake). The reason is noted on the person\'s Board card.', { id: z.number().int(), reason: z.string().optional() }, async (a) => {
    await outbox.reject(a.id, { reason: a.reason || '', actor: 'ai' });
    return `#${a.id} rejected.`;
  });

  tool('reschedule_messages', 'Give unsent messages (drafts or approved, ids from list_outbox) a new send time when the owner asks — e.g. "send these on Monday 10:00". Drafts stay drafts; approved ones wait until then. Sending hours, gaps and daily limits still apply. Can also set or clear the "send by" time (expires_at).', {
    ids: z.array(z.number().int()).min(1), at: z.string().describe('"YYYY-MM-DD HH:MM" (owner time zone) or ISO; "now" = as soon as possible'),
    expires_at: z.string().optional().describe('New "send by" time (dropped if not sent by then); "none" removes it; leave out to keep each message\'s own'),
  }, async (a) => {
    await scope.assertDrafts(a._c, a.ids);
    const opt = a.expires_at === undefined ? {} : { expiresAt: /^none$/i.test(a.expires_at.trim()) ? null : localTime(a.expires_at) };
    const r = await outbox.reschedule(a.ids, /^now$/i.test(a.at.trim()) ? null : localTime(a.at), opt);
    for (const [acc, n] of Object.entries(r.perAccount)) await ai(acc, `Rescheduled ${n} message(s) to ${d(r.at)}`);
    return `${r.rescheduled} message(s) now go out ${d(r.at)}${r.skipped ? ` (${r.skipped} could not be moved — already sent, failed or rejected)` : ''}.`;
  });

  tool('edit_draft','Change the wording of a draft that is still waiting for the owner\'s approval (e.g. after an owner note on the Drafts page). Keeps its picture, number and send time; it stays a draft. For Meta template drafts the wording is fixed — reject and redraft instead.', {
    id: z.number().int(), text: z.string().min(1).describe('The full new message (or picture caption)'),
  }, async (a) => {
    const r = await outbox.editDraft(a.id, a.text);
    await ai(r.account_id, `Edited draft #${r.id} to ${r.to_jid.split('@')[0]}`);
    return `Draft #${r.id} updated — still waiting for the owner's approval${new Date(r.scheduled_at) > new Date(Date.now() + 60000) ? ` (goes out ${d(r.scheduled_at)} once approved)` : ''}.`;
  });

  tool('edit_messages', 'Change unsent messages — drafts AND approved ones still waiting — when the owner asks (a note on the Drafts page, a card note, a rejection reason, a chat): find → replace across many (e.g. find "Dear Sir / Madam," replace "Hello"), a whole new text for one, add or swap the picture/file (attachment_url, e.g. the Premium Room poster), or remove it. Each keeps its number, send time, "send by" and approval state. Read them first with list_outbox(ids=[…]). Meta template messages can\'t be changed (wording fixed by Meta) — reject and redraft those.', {
    ids: z.array(z.number().int()).min(1).max(500),
    text: z.string().optional().describe('Whole new text — one message only'),
    find: z.string().optional().describe('Exact words to replace in every message given'),
    replace: z.string().optional().describe('Replacement for find ("" deletes it)'),
    attachment_url: z.string().optional().describe('Add or swap the picture / file (public link or Drive link)'),
    file_name: z.string().optional(),
    remove_attachment: z.boolean().optional(),
  }, async (a) => {
    await scope.assertDrafts(a._c, a.ids);
    const r = await outbox.editMessages(a.ids, { text: a.text, find: a.find, replace: a.replace ?? '', removeAttachment: !!a.remove_attachment,
      attachment: a.attachment_url ? { url: a.attachment_url, fileName: a.file_name } : undefined });
    const what = [a.text !== undefined ? 'new text' : null, a.find !== undefined ? `"${trim(a.find, 40)}" → "${trim(a.replace ?? '', 40)}"` : null,
      a.attachment_url ? 'picture/file set' : null, a.remove_attachment ? 'picture/file removed' : null].filter(Boolean).join(', ');
    if (r.changed.length) await ai(null, `Edited ${r.changed.length} unsent message(s) (${what}): #${r.changed.slice(0, 30).join(', #')}${r.changed.length > 30 ? '…' : ''}`);
    return `Changed ${r.changed.length} (${what}).${r.skipped.length ? ` Skipped ${r.skipped.length}: ${r.skipped.slice(0, 20).map((x) => `#${x.id} ${x.why}`).join('; ')}` : ''}`;
  });

  tool('inbox_summary', 'The INBOX at a glance across all numbers (big picture before drafting): chats of people on campaign lists with new messages, newest first — who wrote, how many of their messages are still unanswered, their campaign / list / stage, the last message, and whether a Board card or a waiting draft covers it (a card closed earlier + a new message = NO CARD: look at it). The hub\'s own numbers and the owner\'s phones are never listed. Chats of people on no list are staff\'s everyday chats — leave them alone; include_unlisted=true only when the owner asks about them. Read a chat with get_messages(full_text) before answering.', {
    since: z.string().optional().describe('From when: "YYYY-MM-DD HH:MM" (owner time) or ISO; default the last 24 hours'),
    account: z.string().optional().describe('One number; default all'),
    waiting_only: z.boolean().optional().describe('Only chats where they spoke last (default true); false = every chat with activity'),
    limit: z.number().int().min(1).max(200).optional(),
    include_unlisted: z.boolean().optional().describe('Also chats of people on no list (staff\'s everyday chats) — only when the owner asks'),
  }, async (a) => {
    const since = a.since ? Math.floor(new Date(localTime(a.since)).getTime() / 1000) : Math.floor(Date.now() / 1000) - 86400;
    if (!since) throw new Error('Could not read since');
    const rows = await inboxRows({ since, account: a.account ? (await manager.resolve(a.account)).id : null, campaign: a._c, waitingOnly: a.waiting_only !== false, limit: a.limit || 60, unlisted: !!a.include_unlisted });
    if (!rows.length) return `Nothing ${a.waiting_only === false ? 'new' : 'waiting'} since ${d(new Date(since * 1000))}.`;
    const byAcc = {};
    for (const r of rows) (byAcc[r.account_id] ||= []).push(r);
    const out = [`INBOX since ${d(new Date(since * 1000))} — ${rows.length} chat(s)${a.waiting_only === false ? '' : ' waiting for us'}:`];
    for (const [acc, list] of Object.entries(byAcc)) {
      out.push(`\n${acc} (${list.length}):`);
      for (const r of list) {
        out.push(`- ${r.name || '+' + r.chat_jid.split('@')[0]} (${r.chat_jid.split('@')[0]})${r.campaign ? ` · ${r.campaign}` : ' · no campaign'}${r.list_name ? ` · ${r.list_name}${r.stage ? ` [${r.stage}]` : ''}` : ' · not on a list'}`
          + ` · ${r.from_me ? 'we wrote last' : `${r.unanswered} unanswered`} · ${d(new Date(Number(r.ts) * 1000))}: "${trim(r.body || '[' + r.type + ']', 120)}"`
          + `${r.card ? ` · card #${r.card}` : r.from_me ? '' : ' · NO CARD'}${r.waiting_msg ? ` · our #${r.waiting_msg} waiting` : ''}`);
      }
    }
    return out.join('\n');
  });

  tool('owner_feedback', 'Everything the owner told the AI lately, in one place: notes on Board cards (call notes, instructions — newest first, marked DONE when the AI wrote a note after), reasons given when rejecting drafts, and Drafts-page notes ("Owner: …" cards). Read it at the start of a session and act on what is still open.', {
    days: z.number().int().min(1).max(60).optional().describe('How far back (default 7)'),
  }, async (a) => {
    const days = a.days || 7;
    const notes = await query(
      `SELECT l.task_id, l.at, l.text, t.title, t.status, t.account_id, t.role,
         EXISTS (SELECT 1 FROM task_log x WHERE x.task_id = l.task_id AND x.actor = 'ai' AND x.id > l.id) AS answered
       FROM task_log l JOIN tasks t ON t.id = l.task_id
       WHERE l.actor = 'you' AND l.kind = 'note' AND l.at > now() - ($1 || ' days')::interval ORDER BY l.at DESC LIMIT 100`, [String(days)]);
    const owner = await query(`SELECT id, title, status, details, created_at FROM tasks WHERE title LIKE 'Owner:%' AND created_at > now() - ($1 || ' days')::interval ORDER BY id DESC LIMIT 40`, [String(days)]);
    const rej = await query(
      `SELECT o.id, o.account_id, o.to_jid, o.error, COALESCE(o.role, ${roleOf('o.account_id', 'o.to_jid')}) AS campaign, ct.name
       FROM outbox o LEFT JOIN contacts ct ON ct.account_id = o.account_id AND ct.jid = o.to_jid
       WHERE o.status = 'rejected' AND o.error LIKE 'Rejected:%' AND o.created_at > now() - ($1 || ' days')::interval ORDER BY o.id DESC LIMIT 100`, [String(days)]);
    const out = [`OWNER NOTES ON CARDS (${notes.length}, last ${days} days):`];
    for (const n of notes) out.push(`- ${n.answered ? 'DONE' : 'OPEN'} #${n.task_id} [${n.status}] ${trim(n.title, 60)} — ${d(n.at)}: "${n.text.replace(/\s+/g, ' ')}"`);
    out.push(`\nOWNER REQUESTS FROM THE DRAFTS PAGE (${owner.length}):`);
    for (const t of owner) out.push(`- #${t.id} [${t.status}] ${t.title}`);
    // group identical reasons (bulk replacements) so a real instruction stands out
    const byReason = new Map();
    for (const r of rej) { const k = r.error.replace(/^Rejected:\s*/, ''); (byReason.get(k) || byReason.set(k, []).get(k)).push(r); }
    out.push(`\nREJECTION REASONS (${rej.length} drafts):`);
    for (const [reason, rs] of byReason) out.push(`- "${reason}" — ${rs.length > 1 ? `${rs.length} drafts (#${rs.slice(0, 8).map((x) => x.id).join(', #')})` : `#${rs[0].id} to ${rs[0].to_jid.split('@')[0]}${rs[0].name ? ` (${rs[0].name})` : ''} on ${rs[0].account_id}${rs[0].campaign ? ` · ${rs[0].campaign}` : ''}`}`);
    out.push('\nA reason that asks for something ("wish him on festivals", "follow up near the date") is an instruction: do it (drafts for approval), then note it on the person\'s card.');
    return out.join('\n');
  });

  // Read-only look at any data in the hub (not the WhatsApp login keys): the AI can zoom in wherever it needs.
  const SQL_DENY = /\bwa_auth\b|pg_read|pg_ls|pg_stat_file|lo_(import|export|get)|dblink|\bcopy\b|current_setting|set_config|pg_sleep|pg_terminate|pg_cancel/i;
  tool('describe_data', 'The hub\'s database tables and their columns (for inspect_data). Main ones: messages (every WhatsApp message: account_id, chat_jid, from_me, ts = unix seconds, body, type), chats, contacts, outbox (everything sent or to send: status, payload JSON with text/attachment, scheduled_at, expires_at, role = campaign, error = failure or rejection reason), tasks + task_log (Board cards and their history/notes), lists + list_members (batches, stage, visit_at, follow-ups), directory (contact book), templates, rules, campaigns, events (activity log), meta_events, wa_templates, config.', {
    table: z.string().optional().describe('One table for its columns; omit for all'),
  }, async (a) => {
    const rows = await query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name <> 'wa_auth'
      ${a.table ? 'AND table_name = $1' : ''} ORDER BY table_name, ordinal_position`, a.table ? [a.table] : []);
    const by = {};
    for (const r of rows) (by[r.table_name] ||= []).push(`${r.column_name} ${r.data_type.replace('timestamp with time zone', 'timestamptz').replace('character varying', 'text')}`);
    return Object.entries(by).map(([t, c]) => `${t}: ${c.join(', ')}`).join('\n') || 'No such table.';
  });
  tool('inspect_data', 'Run ONE read-only SQL SELECT on the hub\'s database to zoom in on anything the other tools don\'t show (counts, patterns, a person\'s whole history, why something happened). Read-only: it can never change data. Up to 300 rows, 15 s. Times: messages.ts is unix seconds (to_timestamp(ts)); others are timestamptz (owner time zone: AT TIME ZONE \'Asia/Kolkata\'). Use describe_data for columns. Prefer the normal tools for actions.', {
    sql: z.string().describe('One SELECT (or WITH … SELECT) statement'),
    limit: z.number().int().min(1).max(300).optional(),
  }, async (a) => {
    const sql = a.sql.trim().replace(/;\s*$/, '');
    if (!/^(select|with|explain)\b/i.test(sql)) throw new Error('Only a SELECT (or WITH … SELECT) is allowed');
    if (sql.includes(';')) throw new Error('One statement only');
    if (SQL_DENY.test(sql)) throw new Error('That table or function is not available (WhatsApp login keys and server functions are off-limits)');
    const limit = a.limit || 100;
    const rows = await tx(async (q) => {
      await q('SET TRANSACTION READ ONLY');
      await q(`SET LOCAL statement_timeout = '15s'`).catch(() => {});
      return q(`SELECT * FROM (${sql}) AS q LIMIT ${limit + 1}`);
    });
    if (!rows.length) return 'No rows.';
    const cols = Object.keys(rows[0]);
    const cell = (v) => (v == null ? '' : v instanceof Date ? d(v) : typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/\s+/g, ' ').slice(0, 600);
    return [cols.join(' | '), ...rows.slice(0, limit).map((r) => cols.map((c) => cell(r[c])).join(' | ')), rows.length > limit ? `(more than ${limit} rows — narrow it or raise limit)` : `(${rows.length} rows)`].join('\n');
  });

  tool(
    'backfill_history',
    'Deep history: pull older messages from the phone chat by chat (50 at a time, paced like scrolling up) for numbers whose initial import was short. Runs in the background for a while (hours for ~1000 chats); progress shows in list_accounts. The phone must stay online.',
    {
      account: accountArg,
      since: z.string().optional().describe('Stop at this date (YYYY-MM-DD). Omit to go back as far as the phone has.'),
      include_groups: z.boolean().optional().describe('Also backfill group chats (default false)'),
    },
    async (a) => {
      const s = await manager.resolve(a.account);
      const r = await outbox.requestJob(s, 'backfill', { sinceTs: toTs(a.since) || 0, includeGroups: !!a.include_groups });
      await ai(s.id, `Started deep history import (back to ${a.since || 'the beginning'})`);
      return `Deep history backfill queued as job #${r.jobId} for ${s.id}. It starts within ~10 s on the server connected to this number; check progress with list_accounts.`;
    },
  );

  tool(
    'recent_activity',
    'What the owner (dashboard), the AI, scripts (API key, e.g. Apps Script) and the system did recently: numbers linked and which history option was chosen, settings changes, approvals, tasks, bulk sends, opt-outs, failures. Check this before assuming how something was set up.',
    {
      account: z.string().optional(),
      role: z.string().optional().describe('Only entries for this job role (Chef, Front office, …)'),
      who: z.enum(['you', 'ai', 'script', 'system', 'people']).optional().describe('"people" = the owner, the AI and scripts (default); "you" = the owner in the dashboard; "script" = API-key callers such as Apps Script'),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async (a) => {
      const p = [a.limit || 30];
      const conds = [];
      if (a.account) {
        p.push((await manager.resolve(a.account)).id);
        conds.push(`account_id = $${p.length}`);
      }
      const who = a.who || 'people';
      p.push(who === 'people' ? ['you', 'ai', 'script'] : [who]);
      conds.push(`actor = ANY($${p.length})`);
      if (a.role) {
        p.push(a.role);
        conds.push(`lower(role) = lower($${p.length})`);
      }
      const rows = await query(`SELECT * FROM events WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT $1`, p);
      return rows.length
        ? rows.map((e) => `[${fmtTime(Math.floor(new Date(e.created_at).getTime() / 1000))}] ${e.actor === 'you' ? 'owner' : e.actor} | ${e.account_id || '-'}${e.role ? ' | ' + e.role : ''} | ${trim(e.text, 200)}`).join('\n')
        : 'No recorded actions yet.';
    },
  );

  tool('list_templates', 'Saved message templates (name, which number, text with {fields}, attached file). Use them via send_message/bulk_send template=.', {
    account: z.string().optional(),
  }, async (a) => {
    const rows = await templates.listTemplates(a.account ? (await manager.resolve(a.account)).id : undefined, { role: a._c || null });
    return rows.length
      ? rows.map((t) => `#${t.id} | ${t.name} | ${t.account_id || 'all numbers'} | ${t.role ? `campaign ${t.role}` : 'all campaigns'} | fields: ${templates.fieldsIn(t.body).join(',') || '-'}${t.attachment?.url ? ' | file' : ''} | ${trim(t.body, 160)}`).join('\n')
      : 'No templates yet.';
  });

  tool('list_meta_templates', 'Meta-approved message templates of a Meta Cloud API number: name | language | status | category | fill-ins | text. Only APPROVED ones can be sent (wa_template=). New ones: create_meta_template (owner\'s request only).', {
    account: accountArg, sync: z.boolean().optional().describe('Fetch fresh from Meta first'),
  }, async (a) => {
    const s = await manager.resolve(a.account);
    if (!s.isCloud) return `"${s.id}" is a linked phone number — it sends normal text; Meta templates are only for Meta Cloud API numbers.`;
    const t = await import('./wa/cloud-templates.js');
    if (a.sync) await t.syncTemplates(s.wabaId);
    const rows = await t.listWaTemplates(s.wabaId);
    return rows.length
      ? rows.map((r) => `${r.name} | ${r.language} | ${r.status} | ${r.category} | ${r.vars.length ? r.vars.map((v) => `{{${v}}}`).join(' ') : 'no fill-ins'}${r.headerFormat && r.headerFormat !== 'TEXT' ? ` | header: ${r.headerFormat}` : ''} | ${trim(r.body, 160)}`).join('\n')
      : 'No Meta templates yet — the owner creates them in WhatsApp Manager → Message templates.';
  });

  tool('meta_health_check', 'Health check of a Meta Cloud API number: token/number access, registration, can-send status from Meta (AVAILABLE / LIMITED / BLOCKED and why — e.g. payment problem), display name, quality, webhook subscriptions, last event received, templates, failures in 24 h, billable messages. Start here when Meta sends fail or nothing arrives.', {
    account: accountArg,
  }, async (a) => {
    const s = await manager.resolve(a.account);
    if (!s.isCloud) return `"${s.id}" is a linked phone number — use list_accounts / recent_activity for it.`;
    const r = await s.healthCheck();
    return [`${s.id}: ${r.status.toUpperCase()} (checked ${fmtTime(Math.floor(Date.parse(r.checkedAt) / 1000))})`,
      ...r.checks.map((c) => `${c.level === 'ok' ? 'OK ' : c.level === 'warn' ? 'WARN' : 'FAIL'} ${c.name}: ${c.detail}`)].join('\n');
  });

  tool('message_timeline', 'What happened to one message or one person on a Meta Cloud API number (last 14 days): our sends (outbox, errors) and every Meta event — accepted, sent, delivered, read, failed with reason, billing category, their incoming messages. Give a wamid or a phone number.', {
    account: accountArg, q: z.string().describe('wamid.… or phone number'),
  }, async (a) => {
    const s = await manager.resolve(a.account);
    if (!s.isCloud) return `"${s.id}" is a linked phone number — use get_messages for it.`;
    const t = await s.timeline(a.q);
    const ts = (d) => fmtTime(Math.floor(new Date(d).getTime() / 1000));
    const lines = [
      ...t.outbox.map((o) => `outbox #${o.id} ${o.status}${o.tpl ? ` (template ${o.tpl})` : ''} ${o.text ? `"${o.text}"` : ''}${o.error ? ` — ${o.error}` : ''} [created ${ts(o.created_at)}]`),
      ...t.events.map((e) => {
        const p = e.payload || {};
        const extra = e.kind === 'status' ? `${p.pricing?.category ? ` · ${p.pricing.category}${p.pricing.billable ? ' (billable)' : ''}` : ''}${p.errors?.length ? ` · ${p.errors[0].code} ${p.errors[0].title || ''} ${p.errors[0].error_data?.details || ''}` : ''}`
          : e.kind === 'in' ? ` · "${trim(p.text?.body || p.button?.text || p.interactive?.button_reply?.title || '[' + p.type + ']', 60)}"`
          : e.kind === 'send_error' ? ` · ${p.error}` : '';
        return `[${ts(e.created_at)}] ${e.kind} ${e.status || ''}${e.wamid ? ` ${e.wamid.slice(0, 18)}…` : ''}${extra}`;
      }),
    ];
    return lines.length ? lines.join('\n') : 'Nothing recorded for that in the last 14 days.';
  });

  tool('create_meta_template', 'Submit a new message template to Meta for approval (Meta Cloud API numbers). Only when the owner asked for it. Use {{1}}, {{2}} for fill-ins (not at the very start or end) and give one example value each. UTILITY = about something they asked for/applied to (cheaper); MARKETING = promotional. Approval usually takes minutes; check with list_meta_templates.', {
    account: accountArg, name: z.string().describe('lowercase_with_underscores'), body: z.string(), examples: z.array(z.string()).optional(),
    category: z.enum(['UTILITY', 'MARKETING']).optional(), language: z.string().optional().describe('Default en'),
    footer: z.string().optional(), buttons: z.array(z.string()).max(3).optional().describe('Quick-reply buttons, e.g. ["Haan, interested","Nahi"]'),
    header_image_url: z.string().optional().describe('Public JPEG/PNG link for an image header (e.g. <hub>/hiring/chef-hiring.jpg); also used for every send'),
  }, async (a) => {
    const s = await manager.resolve(a.account);
    if (!s.isCloud) return `"${s.id}" is a linked phone number — templates are only for Meta Cloud API numbers.`;
    const t = await import('./wa/cloud-templates.js');
    const r = await t.createTemplate(s.wabaId, { name: a.name, body: a.body, examples: a.examples || [], category: a.category, language: a.language, footer: a.footer, buttons: a.buttons, headerImage: a.header_image_url ? { url: a.header_image_url } : undefined });
    await ai(s.id, `Submitted Meta template "${r.name}" for review (${r.status || 'pending'})`);
    return `Submitted "${r.name}" (${r.category || a.category || 'UTILITY'}) — status ${r.status || 'PENDING'}. Meta usually decides within minutes; it then appears in list_meta_templates.`;
  });

  tool('save_template', 'Create or update a saved message template. Use {name}, {first_name}, {phone} (filled from the contact) and any other {field}.', {
    id: z.number().int().optional().describe('Give to update an existing template'),
    account: z.string().optional().describe('Number it belongs to; omit for all numbers'),
    name: z.string(), body: z.string(),
    attachment_url: z.string().optional(), file_name: z.string().optional(),
  }, async (a) => {
    const t = await templates.saveTemplate({
      id: a.id, account: a.account ? (await manager.resolve(a.account)).id : null, name: a.name, body: a.body,
      attachment: a.attachment_url ? { url: a.attachment_url, fileName: a.file_name } : null, role: a._c || null,
    });
    await ai(t.account_id, `Saved template "${t.name}"`);
    return `Template #${t.id} "${t.name}" saved.`;
  });

  tool('set_chat_state', 'Organise a chat: snoozed = "remind me" (it leaves the open list and comes back as REMINDER DUE on the date), done = finished, open = back to normal. A new message from them reopens it automatically.', {
    account: accountArg, chat: chatArg,
    state: z.enum(['open', 'snoozed', 'done']),
    until: z.string().optional().describe('For snoozed: date/time (YYYY-MM-DD or ISO)'),
    in_days: z.number().optional().describe('For snoozed: alternatively, number of days from now'),
    note: z.string().optional().describe('For snoozed: what to do when it comes back'),
  }, async (a) => {
    const s = await manager.resolve(a.account);
    const jid = await resolveChat(s.id, a.chat);
    let until;
    if (a.state === 'snoozed') {
      until = a.until ? new Date(localTime(a.until)).toISOString() : a.in_days ? new Date(Date.now() + a.in_days * 86400000).toISOString() : null;
      if (!until) return 'For a reminder give until or in_days.';
    }
    await store.setChatState(s.id, jid, a.state, { until, note: a.note });
    await ai(s.id, `Chat ${jid.split('@')[0]} → ${a.state === 'snoozed' ? `remind on ${fmtTime(Math.floor(new Date(until).getTime() / 1000))}${a.note ? ' (' + a.note + ')' : ''}` : a.state}`);
    return a.state === 'snoozed' ? `Reminder set for ${fmtTime(Math.floor(new Date(until).getTime() / 1000))}.` : `Chat marked ${a.state}.`;
  });

  tool('person_context', 'EVERYTHING about one person in one call, before you act on them: their chats on every number (latest messages, oldest→newest; messages that came AFTER their Board card was last updated are marked NEW — the card may be out of date), list stage / interview date / follow-up / outcome, open and recent Board cards with notes and call results, drafts and queued messages to them, contact-book entries, tags and summary. Use it before drafting to a candidate or guest.', {
    person: z.string().describe('Phone number (any format) or name'), messages: z.number().int().min(1).max(60).optional().describe('Messages per chat (default 12)'),
  }, async (a) => {
    let jid;
    if (/^[+\d\s()-]{8,}$/.test(a.person.trim()) || a.person.includes('@')) jid = store.toJid(a.person);
    else {
      const hits = await findPerson(a.person);
      const jids = [...new Set(hits.map((h) => h.jid))];
      if (!jids.length) return `Nobody called "${a.person}" on any number.`;
      if (jids.length > 1) return `"${a.person}" matches ${jids.length} people — pass the number:\n${hits.slice(0, 15).map((h) => `${h.jid.split('@')[0]} | ${trim(h.name, 30)} | ${h.account_id}`).join('\n')}`;
      jid = jids[0];
    }
    const phone = jid.split('@')[0];
    const out = [];
    const contacts = await query(`SELECT ct.account_id, COALESCE(ct.saved_name, ct.name, ct.notify) AS name, ct.tags, ct.lead_status, ct.summary, ct.notes, ct.is_blocked FROM contacts ct WHERE ct.jid = $1`, [jid]);
    const otherNames = await query(`SELECT name FROM list_members WHERE jid = $1 AND COALESCE(name, '') <> '' UNION SELECT name FROM chats WHERE jid = $1 AND COALESCE(name, '') <> ''`, [jid]);
    const names = [...new Set([...contacts.map((c) => c.name), ...otherNames.map((r) => r.name)].filter(Boolean))];
    out.push(`PERSON +${phone}${names.length ? ` — ${names.join(' / ')}` : ''}`);
    for (const c of contacts) {
      const bits = [c.tags?.length ? `tags:${c.tags.join(',')}` : null, c.lead_status ? `status:${c.lead_status}` : null, c.summary ? `summary:${trim(c.summary, 200)}` : null, c.notes ? `notes:${trim(c.notes, 200)}` : null, c.is_blocked ? 'BLOCKED' : null].filter(Boolean);
      if (bits.length) out.push(`  on ${c.account_id}: ${bits.join(' | ')}`);
    }
    const dir = await query(`SELECT category, reason, notes FROM directory WHERE jid = $1`, [jid]);
    if (dir.length) out.push(`CONTACT BOOK: ${dir.map((d) => `${d.category}${d.reason ? ` (${trim(d.reason, 80)})` : ''}`).join('; ')}`);
    const mem = await query(
      `SELECT l.id, l.name, l.role, l.account_id, l.archived, m.status, m.stage, m.visit_at, m.followup_at, m.followup_note, m.outcome, m.notes, m.last_sent_at, m.last_reply_at, m.reminded_at, m.reminded2_at
       FROM list_members m JOIN lists l ON l.id = m.list_id WHERE m.jid = $1 ORDER BY l.id DESC`, [jid]);
    out.push(mem.length ? 'LISTS:' : 'LISTS: none (not a candidate on any list)');
    for (const m of mem) {
      out.push(`  #${m.id} ${m.name} (${m.role || '-'}, number ${m.account_id})${m.archived ? ' ARCHIVED' : ''}: ${m.status}${m.stage ? `, stage ${m.stage}` : ''}${m.visit_at ? `, interview ${d(m.visit_at)}${m.reminded_at || m.reminded2_at ? ` (reminded${m.reminded2_at ? ' on the day' : ' the evening before'})` : ''}` : ''}${m.followup_at ? `, follow up ${d(m.followup_at)}${m.followup_note ? ` — ${trim(m.followup_note, 80)}` : ''}` : ''}${m.outcome ? `, outcome: ${trim(m.outcome, 80)}` : ''}${m.notes ? `, notes: ${trim(m.notes, 80)}` : ''}`);
    }
    const cards = await query(
      `SELECT t.id, t.title, t.status, t.kind, t.due_at, t.assignee, t.priority, t.updated_at, t.completed_at,
         (SELECT l.text FROM task_log l WHERE l.task_id = t.id AND l.kind = 'note' ORDER BY l.id DESC LIMIT 1) AS last_note,
         (SELECT l.actor FROM task_log l WHERE l.task_id = t.id AND l.kind = 'note' ORDER BY l.id DESC LIMIT 1) AS note_by
       FROM tasks t WHERE (t.ref LIKE '%:' || $1 OR t.title LIKE '%' || $2 || '%' OR t.details LIKE '%' || $2 || '%')
         AND (t.status NOT IN ('done','cancelled') OR t.completed_at > now() - interval '14 days')
       ORDER BY (t.status IN ('done','cancelled')), t.due_at NULLS LAST LIMIT 15`, [jid, phone.slice(-10)]);
    out.push(cards.length ? 'BOARD CARDS (open first, then closed in the last 14 days):' : 'BOARD CARDS: none');
    for (const c of cards) {
      out.push(`  #${c.id} ${c.status}${c.priority ? ' PRIORITY' : ''} for ${c.assignee === 'ai' ? 'AI' : 'owner'} | ${trim(c.title, 90)}${c.due_at ? ` | due ${d(c.due_at)}` : ''} | card updated ${d(c.updated_at)}${c.last_note ? ` | latest note (${c.note_by === 'you' ? 'owner' : c.note_by}): "${trim(c.last_note, 200)}"` : ''}`);
    }
    // a message is NEW when at least one open card was last updated before it (that card may be out of date)
    const openCards = cards.filter((c) => !['done', 'cancelled'].includes(c.status));
    const oldest = openCards.length ? openCards.reduce((x, c) => (new Date(c.updated_at) < new Date(x.updated_at) ? c : x)) : null;
    const cardTs = oldest ? new Date(oldest.updated_at).getTime() / 1000 : null;
    const pending = await query(`SELECT id, account_id, status, scheduled_at, left(COALESCE(payload->>'text', payload->'waTemplate'->>'name', '[file]'), 120) AS text, error FROM outbox
      WHERE to_jid = $1 AND (status IN ('draft','queued','sending') OR (status IN ('failed','rejected') AND created_at > now() - interval '14 days')) ORDER BY id DESC LIMIT 10`, [jid]);
    if (pending.length) {
      out.push('MESSAGES WAITING / RECENTLY NOT SENT:');
      for (const o of pending) out.push(`  #${o.id} ${o.status} on ${o.account_id}${o.status === 'queued' && new Date(o.scheduled_at) > new Date() ? ` for ${d(o.scheduled_at)}` : ''}: "${trim(o.text, 110)}"${o.error ? ` — ${trim(o.error, 100)}` : ''}`);
    }
    const chats = await query(`SELECT account_id, max(ts) AS last FROM messages WHERE chat_jid = $1 GROUP BY account_id ORDER BY max(ts) DESC`, [jid]);
    if (!chats.length) out.push('CHATS: no messages with this person on any number');
    for (const ch of chats) {
      const rows = await store.getMessages(ch.account_id, jid, { limit: a.messages || 12 });
      out.push(`CHAT on ${ch.account_id} (latest ${rows.length}, oldest→newest${cardTs ? `; NEW = after card #${oldest.id} was last updated` : ''}):`);
      for (const m of rows) out.push(`  ${cardTs && !m.from_me && Number(m.ts) > cardTs ? 'NEW ' : ''}${msgLine(m, 300)}`);
    }
    return out.join('\n');
  });

  tool('find_person', 'Look up one person across ALL numbers (e.g. a guest who also messaged the hiring number): name, tags, status, notes and last contact per number.', {
    query: z.string().describe('Phone number or name'),
  }, async (a) => {
    const rows = await findPerson(a.query);
    return rows.length
      ? rows.map((r) => `${r.account_id} (${r.account_label}) | ${r.jid} | ${trim(r.name, 40)} | ${r.messages} msgs, first ${fmtTime(r.first_ts)}, last ${fmtTime(r.last_ts)} (${r.last_from_me ? 'me' : 'them'}) | tags:${(r.tags || []).join(',') || '-'} | status:${r.lead_status || '-'}${r.is_blocked ? ' | BLOCKED' : ''}${r.summary ? ' | ' + trim(r.summary, 100) : ''}`).join('\n')
      : 'Not found on any number.';
  });

  tool('list_rules', 'Automatic rules for incoming messages on each number (conditions → actions) and how often they ran.', { account: z.string().optional() }, async (a) => {
    const rows = await rules.listRules(a.account ? (await manager.resolve(a.account)).id : undefined, { role: a._c || null });
    return rows.length
      ? rows.map((r) => `#${r.id} | ${r.account_id} | ${r.enabled ? 'on' : 'off'} | ${r.name} | if ${JSON.stringify(r.conditions)} then ${JSON.stringify(r.actions)} | ran ${r.runs}x`).join('\n')
      : 'No rules yet.';
  });

  tool('save_rule', 'Create or update an automatic rule for incoming messages on one number. Only create rules the owner asked for.', {
    id: z.number().int().optional(), account: accountArg, name: z.string(), enabled: z.boolean().optional(),
    chat: z.enum(['direct', 'group', 'any']).optional(),
    types: z.array(z.string()).optional().describe('Message types, e.g. ["document","image"]; empty = any'),
    words: z.array(z.string()).optional().describe('Match if the text or file name contains any of these'),
    sender: z.enum(['any', 'new', 'known']).optional().describe('new = never messaged by this number before'),
    role: z.string().optional().describe('Only people on a list of this job role (e.g. Chef, Front office, Housekeeping); empty = anyone'),
    add_tags: z.array(z.string()).optional(), lead_status: z.string().optional(), save_media: z.boolean().optional(),
    create_task: z.string().optional().describe('Task title, may use {name}'),
    reply_template: z.string().optional().describe('Template to auto-reply with (once per person per day)'),
    snooze_days: z.number().int().optional(),
  }, async (a) => {
    const s = await manager.resolve(a.account);
    const r = await rules.saveRule({
      id: a.id, account: s.id, name: a.name, enabled: a.enabled ?? true,
      conditions: { chat: a.chat, types: a.types, words: a.words, sender: a.sender, role: a.role },
      actions: { addTags: a.add_tags, leadStatus: a.lead_status, saveMedia: a.save_media, createTask: a.create_task, replyTemplate: a.reply_template, snoozeDays: a.snooze_days },
    });
    await ai(s.id, `Saved rule "${r.name}"`);
    return `Rule #${r.id} "${r.name}" saved (${r.enabled ? 'on' : 'off'}).`;
  });

  const listArg = z.string().describe('List id or name, e.g. "Chef candidates – Batch 5"');
  const d = (t) => (t ? fmtTime(Math.floor(new Date(t).getTime() / 1000)) : '-');

  tool('list_lists', 'Contact lists (candidate batches) on ALL numbers by default (each line says its number), with counts per status: new (not messaged), queued, sent (no reply), replied, failed, opted_out — plus follow-up settings. Archived lists are hidden unless include_archived=true.', {
    account: z.string().optional().describe('Only this number (other numbers\' lists are then counted, not shown)'), role: z.string().optional().describe('Job role, e.g. Chef, Front office, Housekeeping'),
    include_archived: z.boolean().optional(),
  }, async (a) => {
    const acc = a.account ? (await manager.resolve(a.account)).id : null;
    for (const l of await query('SELECT id FROM lists WHERE ($1::text IS NULL OR account_id = $1) AND archived IS NULL', [acc])) await lists.refreshList(l.id);
    const rows = await lists.listLists(acc, a.role, { includeArchived: a.include_archived });
    const others = acc ? (await query('SELECT count(*)::int n FROM lists WHERE account_id <> $1 AND archived IS NULL', [acc]))[0].n : 0;
    const note = others ? `\n(${others} more list(s) on other numbers — call list_lists without account to see them)` : '';
    return (rows.length
      ? rows.map((l) => `#${l.id} | ${l.role || '-'} | ${l.name} | number ${l.account_id}${l.archived ? ` | ARCHIVED: ${l.archived} — never send` : ''} | ${l.total} people: ${l.new} new, ${l.queued} queued, ${l.sent} sent/no reply, ${l.replied} replied, ${l.failed} failed, ${l.opted_out} opted out | follow-up: ${l.followup?.enabled ? `after ${l.followup.afterDays}d, max ${l.followup.max}` : 'off'}`).join('\n')
      : 'No lists match.') + note;
  });

  tool('archive_list', 'Archive a list that must never send (e.g. imported only to check duplicates, or already handled long ago): it stops all sending from it (bulk, follow-ups, pipeline), cancels its unsent drafts/queued messages, and hides it from list_lists. archived=false brings it back.', {
    list: listArg, archived: z.boolean().optional().describe('Default true'), reason: z.string().optional().describe('e.g. "historical import for duplicate checks — already messaged in Sept"'),
  }, async (a) => {
    const r = await lists.archiveList((await lists.getList(a.list)).id, a.archived !== false, a.reason);
    await ai(r.list.account_id, `${r.list.archived ? 'Archived' : 'Unarchived'} list "${r.list.name}"${a.reason ? ' — ' + a.reason : ''}`, r.list.role);
    return r.list.archived ? `List #${r.list.id} "${r.list.name}" archived: ${r.list.archived}. ${r.cancelled} unsent message(s) cancelled.` : `List #${r.list.id} "${r.list.name}" is active again.`;
  });

  tool('remove_list_member', 'Delete people from a list for good — only rows this list never messaged (e.g. entered by mistake). Anyone already messaged is kept (set their stage instead). Also cancels their unsent drafts from this list.', {
    list: listArg, phones: z.array(z.string()).min(1),
  }, async (a) => {
    const l = await lists.getList(a.list);
    const r = await lists.removeMembers(l.id, a.phones);
    if (r.removed.length) await ai(l.account_id, `Removed ${r.removed.length} from list "${l.name}": ${r.removed.join(', ')}`, l.role);
    return `Removed ${r.removed.length}${r.removed.length ? ': ' + r.removed.join(', ') : ''}.${r.kept.length ? ` Kept ${r.kept.length}: ${r.kept.map((k) => `${k.name || k.phone} (${k.reason})`).join('; ')}` : ''}`;
  });

  tool('list_members', 'People on a list, one line each: phone | name | status | outcome | last sent | last reply (+ their last message) | follow-ups | error. Filter by status to stay short.', {
    list: listArg,
    status: z.string().optional().describe('Comma list of: new, queued, sent, replied, failed, opted_out'),
    stage: z.string().optional().describe('Comma list of funnel stages, e.g. interested,date_given'),
    outcome: z.string().optional(),
  }, async (a) => {
    const l = await lists.getList(a.list);
    await lists.refreshList(l.id);
    let rows = await lists.listMembers(l.id, { status: a.status, outcome: a.outcome });
    if (a.stage) {
      const want = a.stage.split(',').map((x) => x.trim());
      rows = rows.filter((m) => want.includes(m.stage || ''));
    }
    return rows.length
      ? rows.map((m) => [m.phone, trim(m.name, 25), m.status, m.stage ? `stage:${m.stage}` : null, m.visit_at ? `visit:${d(m.visit_at)}` : null, m.outcome ? `outcome:${trim(m.outcome, 50)}` : null, `sent ${d(m.last_sent_at)}`,
          m.last_reply_at ? `reply ${d(m.last_reply_at)}: "${trim(m.last_reply_text, 80)}"` : null, m.followups_sent ? `follow-ups:${m.followups_sent}` : null,
          m.error ? `error:${trim(m.error, 60)}` : null, m.notes ? `notes:${trim(m.notes, 60)}` : null].filter(Boolean).join(' | ')).join('\n')
      : 'Nobody matches.';
  });

  tool('import_list', 'Create or extend a contact list (e.g. candidates from WorkIndia). Existing phones are updated, not duplicated. "since" = ignore messages before this date when working out who was already messaged.', {
    account: accountArg, name: z.string().describe('e.g. "Chef candidates – Batch 6"'),
    role: z.string().optional().describe('Job role: Chef, Front office, Housekeeping, … (guessed from the name if omitted). Keeps each role\'s lists, tasks and log separate.'),
    since: z.string().optional(), source: z.string().optional(),
    skip_known: z.boolean().optional().describe('Default true: people already on an earlier list of the same role are not added again'),
    members: z.array(z.object({ phone: z.string(), name: z.string().optional(), message: z.string().optional().describe('Personal first message for this person') }).passthrough()).min(1),
  }, async (a) => {
    const r = await lists.importList({ account: a.account, name: a.name, role: a.role, since: a.since, source: a.source, members: a.members, skipKnown: a.skip_known !== false });
    await ai(r.list.account_id, `Imported ${r.imported} people into list "${r.list.name}"${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`, r.list.role);
    const names = (xs) => (xs.length > 40 ? xs.slice(0, 40).join(', ') + ` … +${xs.length - 40}` : xs.join(', '));
    return [
      `List #${r.list.id} "${r.list.name}" on ${r.list.account_id} (role ${r.list.role}): ${r.added.length} new, ${r.updated.length} already on this list (updated), ${r.skipped.length} skipped. Check the counts match your source file.`,
      r.added.length ? `New: ${names(r.added)}` : null,
      r.updated.length ? `Updated: ${names(r.updated)}` : null,
      r.skipped.length ? `Skipped (not added): ${r.skipped.map((x) => `${x.row}${x.phone ? ' +' + x.phone : ''} — ${x.reason}`).join('; ')}` : null,
      r.campaignSetup ? `NEW CAMPAIGN "${r.campaignSetup.campaign}" set up by the hub: ${r.campaignSetup.set.join(', ')}. Ask the owner for this role's own rules (offer, salary range, must-haves) and add them with save_playbook(campaign="${r.campaignSetup.campaign}", includes kept).` : null,
    ].filter(Boolean).join('\n');
  });

  tool('send_to_list', 'Message the people on a list with the given statuses (default new + failed). Each gets their own prepared message from the list, unless text/template is given. Follows the number\'s approval mode, delay, daily cap and hours. Use only_phones to pick specific people.', {
    list: listArg, statuses: z.array(z.enum(['new', 'failed', 'sent', 'replied'])).optional(),
    text: z.string().optional(), template: z.string().optional(), only_phones: z.array(z.string()).optional(),
    wa_template: waTemplateArg.describe('Meta Cloud API numbers: the approved Meta template for people who have not written in 24 h (all first messages)'),
    schedule_at: z.string().optional().describe('Start sending at this time ("YYYY-MM-DD HH:MM", owner time zone, or ISO); default now'),
    expires_at: z.string().optional().describe('"Send by": if it has not gone out by this time ("YYYY-MM-DD HH:MM" owner time or ISO) it is dropped — set it for anything tied to a day (festival / birthday wishes, offers ending, reminders before an interview). Such messages go out before other outreach; the hub warns the owner if the number\'s daily limit can\'t fit them in time.'),
    attachment_url: z.string().optional().describe('Image/file sent with every message (each person’s message becomes its caption), e.g. a poster URL'),
    file_name: z.string().optional(),
  }, async (a) => {
    const l = await lists.getList(a.list);
    const r = await lists.sendToList(l.id, { statuses: a.statuses, text: a.text, template: a.template, waTemplate: a.wa_template, onlyPhones: a.only_phones, attachment: a.attachment_url ? { url: a.attachment_url, fileName: a.file_name } : undefined, createdBy: 'ai', source: 'mcp', scheduledAt: localTime(a.schedule_at) || undefined, expiresAt: localTime(a.expires_at) || undefined });
    await ai(l.account_id, `List "${l.name}": ${r.queued} messages ${r.mode === 'approve' ? 'drafted' : 'queued'}`, l.role);
    const skipped = r.skipped.length ? ` Skipped: ${r.skipped.map((x) => x.to + ' (' + x.reason + ')').join('; ')}` : '';
    const cost = r.task ? await taskCostText(r.task.id) : '';
    return r.task ? `Task #${r.task.id}: ${r.queued} messages ${r.mode === 'approve' ? 'saved as drafts — waiting for approval on the board' : 'queued'}.${cost}${skipped}` : `Nothing to send.${skipped}`;
  });

  tool('set_followup', 'Automatic follow-ups for a list: people who were messaged but have not replied after N days get the follow-up message (quoting our last message), up to max times. By default only on days the number sends no first messages to new people (new candidates have priority). Checked every 10 minutes.', {
    list: listArg, enabled: z.boolean(), after_days: z.number().optional(), max: z.number().int().optional(),
    text: z.string().optional().describe('Follow-up message; may use {first_name}, {name}'), template: z.string().optional(),
    quiet_days_only: z.boolean().optional().describe('Default true: follow-ups only on days this number sends no first messages to new people'),
    auto_send: z.boolean().optional().describe('Send follow-ups without approval (owner allowed). Timing/daily max come from the number settings (default after 21:00, max 5/day).'),
    wa_template: waTemplateArg.describe('Meta Cloud API numbers: follow-ups go to people who never replied, so they need an approved Meta template'),
  }, async (a) => {
    const l = await lists.getList(a.list);
    const u = await lists.setFollowup(l.id, { enabled: a.enabled, afterDays: a.after_days, max: a.max, text: a.text, template: a.template, waTemplate: a.wa_template, quietDaysOnly: a.quiet_days_only, autoSend: a.auto_send });
    await ai(l.account_id, `Follow-ups for "${l.name}": ${u.followup.enabled ? 'on' : 'off'}`, l.role);
    return `Follow-ups for "${l.name}": ${u.followup.enabled ? `on — after ${u.followup.afterDays} day(s) without reply, up to ${u.followup.max}` : 'off'}.`;
  });

  tool('update_list_member', 'Move a person through their campaign\'s funnel: stage (a key of that campaign\'s stages — list_campaigns shows each campaign\'s; hiring: interested, date_given, visited, trial, selected, joined, no_show, not_interested, rejected), the date/time they will come (visit_at → automatic reminder before it and a board task), outcome (short reason) and notes. Stages joined / not_interested / rejected close the person (no more sends or follow-ups). Owner rule: anyone asking for money before joining → stage rejected.', {
    list: listArg, phone: z.string(),
    stage: z.string().optional().describe('Funnel stage KEY of the list\'s campaign ("" clears it). Each campaign has its own stages (list_campaigns shows them): hiring = interested, date_given, visited, trial, selected, joined, no_show, not_interested, rejected; sales/corporate and win-back have their own (e.g. contact_shared, rates_shared, first_booking, booked, not_now)'),
    visit_at: z.string().optional().describe('When they will come (ISO or "YYYY-MM-DD HH:MM", your timezone if no offset); sets stage date_given; "" clears'),
    outcome: z.string().optional().describe('Short reason/summary, e.g. "rejected – asked for money before joining"'),
    notes: z.string().optional(),
    available_from: z.string().optional().describe('When they said they will be free / can come ("after 10 Nov" → 2026-11-10, "next week" → next Monday). The hub sets a follow-up for the day before at 10:00 and puts "Follow up: X" on the Board.'),
    follow_up_at: z.string().optional().describe('Exact time to follow up instead ("YYYY-MM-DD HH:MM", India time); "" clears the follow-up'),
    follow_up_note: z.string().optional().describe('What to follow up about, e.g. "said he can join after his notice ends on 10 Nov"'),
  }, async (a) => {
    const l = await lists.getList(a.list);
    const v = localTime(a.visit_at);
    const f = localTime(a.follow_up_at);
    const m = await lists.updateMember(l.id, a.phone, {
      outcome: a.outcome, notes: a.notes, stage: a.stage, visitAt: v === undefined ? undefined : v || null,
      followupAt: f === undefined ? undefined : f || null, availableFrom: localTime(a.available_from) || undefined, followupNote: a.follow_up_note,
    });
    await ai(l.account_id, `${m.name || m.phone} → ${m.stage || '-'}${m.visit_at ? ' (visit ' + d(m.visit_at) + ')' : ''}${m.followup_at ? ' (follow up ' + d(m.followup_at) + ')' : ''}${a.outcome ? ' – ' + a.outcome : ''} — ${l.name}`, l.role);
    const parts = [m.stage && `stage ${m.stage}`, m.visit_at && `visit ${d(m.visit_at)}${['interested', 'date_given'].includes(m.stage) ? ' (interview on the Board for the owner; reminders the evening before and 3 h before)' : ' (no interview card: stage ' + m.stage + ')'}`, m.followup_at && `follow-up ${d(m.followup_at)} (on the Board)`, m.outcome && `outcome ${m.outcome}`, m.notes && 'notes saved'].filter(Boolean);
    return `${m.name || m.phone}: ${parts.join(', ') || 'updated'}.`;
  });

  tool('pipeline', 'Funnel overview per job role and list: people per stage (plus not contacted / contacted / replied without a stage) and upcoming visits with dates. Start here for "where do candidates stand?".', {
    account: z.string().optional(), role: z.string().optional(),
  }, async (a) => {
    const acc = a.account ? (await manager.resolve(a.account)).id : null;
    for (const l of await query('SELECT id FROM lists WHERE ($1::text IS NULL OR account_id = $1) AND archived IS NULL', [acc])) await lists.refreshList(l.id);
    const { counts, visits } = await lists.pipelineSummary(acc, a.role);
    const byList = {};
    for (const c of counts) (byList[c.name] ||= []).push(`${c.stage}: ${c.n}`);
    const out = Object.entries(byList).map(([n, s]) => `${n} — ${s.join(', ')}`);
    out.push(visits.length ? 'Upcoming/overdue visits:\n' + visits.map((v) => `  ${d(v.visit_at)} | ${v.name || v.phone} (+${v.phone}) | ${v.list}`).join('\n') : 'No visits scheduled.');
    return out.join('\n');
  });

  tool('set_pipeline', 'Pipeline automation for a list: ask interested people for a date, remind people before their visit date, and add owner tasks. Texts may use {first_name}, {visit_date}.', {
    list: listArg, enabled: z.boolean().optional(), auto_send: z.boolean().optional().describe('Send these without approval'),
    evening_reminder_at: z.string().optional().describe('Interview reminder the evening before at HH:MM (default 18:00)'),
    same_day_hours_before: z.number().optional().describe('Second reminder this many hours before, on the day (default 3)'),
    remind_hours_before: z.number().optional().describe('Old single-reminder setting — not used any more'), ask_date_after_hours: z.number().optional(),
    reminder_text: z.string().optional(), ask_date_text: z.string().optional(),
    reminder_wa_template: waTemplateArg.describe('Meta numbers: template for the visit reminder when the person has not written in 24 h (may use {visit_date})'),
    ask_date_wa_template: waTemplateArg.describe('Meta numbers: template for asking a date when the 24 h window has closed'),
  }, async (a) => {
    const l = await lists.getList(a.list);
    const u = await lists.setPipeline(l.id, { enabled: a.enabled, autoSend: a.auto_send, remindHoursBefore: a.remind_hours_before, eveningReminderAt: a.evening_reminder_at, sameDayHoursBefore: a.same_day_hours_before, askDateAfterHours: a.ask_date_after_hours, reminderText: a.reminder_text, askDateText: a.ask_date_text, reminderWaTemplate: a.reminder_wa_template, askDateWaTemplate: a.ask_date_wa_template });
    await ai(l.account_id, `Pipeline settings for "${l.name}" updated`, l.role);
    const p = u.pipeline;
    if (!p.enabled) return `Pipeline for "${l.name}": off — no automatic ask-for-a-date, interview reminders or "did they come?" cards for this list.`;
    return `Pipeline for "${l.name}": on, ${p.autoSend ? 'sends automatically' : 'drafts for approval'}, reminders the evening before at ${p.eveningReminderAt} and ${p.sameDayHoursBefore} h before each interview, ask for a date after ${p.askDateAfterHours}h.`;
  });

  tool('known_candidates', 'People already on any list for a job role (all earlier batches). Use it to de-duplicate a new WorkIndia batch BEFORE unlocking or messaging: pass names, phones or places in query (several, comma-separated) and get only the matches — import_list also skips known people by itself and says why. Without query: counts per list, plus everyone only if all=true (long).', {
    role: z.string().describe('Job role, e.g. Chef'), account: z.string().optional(),
    query: z.string().optional().describe('Names, phone numbers or locations to look for, comma-separated, e.g. "Ravi Kumar, 9876543210, Hebbal"'),
    all: z.boolean().optional().describe('List every person (can be thousands of lines — prefer query)'),
  }, async (a) => {
    let rows = await lists.knownPeople(a.role, a.account ? (await manager.resolve(a.account)).id : null);
    if (!a.role) return "Give the job role (role=\"Chef\", \"Front office\" …).";
    if (!rows.length) return `Nobody on ${a.role} lists yet.`;
    const line = (r) => [trim(r.name, 30), r.phone, trim(r.location, 30), r.list + (r.archived ? ' (archived)' : ''), r.account_id, d(r.added_at), r.first_sent_at ? d(r.first_sent_at) : 'never', r.stage || r.status].join(' | ');
    const head = '(name | phone | location | list | number | added | first messaged | stage/status)';
    if (a.query) {
      const terms = a.query.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
      const hit = (r, t) => (/^\+?[\d\s]{6,}$/.test(t) ? String(r.phone || '').endsWith(t.replace(/\D/g, '').slice(-10)) : `${r.name || ''} ${r.location || ''}`.toLowerCase().includes(t));
      const out = terms.map((t) => { const m = rows.filter((r) => hit(r, t)); return m.length ? m.map(line).join('\n') : `${t}: not on any ${a.role} list (new)`; });
      return `${a.role} lists checked for ${terms.length} name(s)/number(s) ${head}:\n${out.join('\n')}`;
    }
    if (a.all) return `${rows.length} people already on ${a.role} lists ${head}:\n${rows.map(line).join('\n')}`;
    const per = {};
    for (const r of rows) per[`${r.list}${r.archived ? ' (archived)' : ''} on ${r.account_id}`] = (per[`${r.list}${r.archived ? ' (archived)' : ''} on ${r.account_id}`] || 0) + 1;
    return `${rows.length} people already on ${a.role} lists:\n${Object.entries(per).map(([k, n]) => `- ${k}: ${n}`).join('\n')}\nPass query="names, numbers or places" to check specific people (or all=true for everyone).`;
  });

  tool('get_playbook', "The owner's standing rules. Inside a campaign (the open one by default): the main playbook plus that campaign's, with the shared playbooks it follows — only the ones that apply. campaign=\"all\": the main playbook plus the names of the campaign playbooks. With campaign (e.g. \"Chef\", \"Corporate sales\", \"Win-back\"): that campaign's own rules — offer, wording, who to target. Read the campaign's before working on it; the main rules still apply.", {
    campaign: z.string().optional().describe('Campaign name; omit for the main playbook'),
  }, async (a) => {
    const list = await listCampaignPlaybooks();
    const main = (await getPlaybook()).text;
    // inside a campaign (the open one, or one named on purpose) only the playbooks that apply to it are shown: the
    // main one + that campaign's (with what it follows). campaign="all" = the main one + the names of the others.
    const camp = a._c && !scope.same(a._c, 'none') ? a._c : null;
    if (camp) {
      // every campaign works under the main rules too; hiring campaigns include the shared hiring playbook (INCLUDE)
      const p = await getCampaignPlaybook(camp);
      if (!p) return `MAIN PLAYBOOK:\n${main}\n\n(No playbook for campaign "${camp}" yet — follow the main rules; the owner can add one: save_playbook with campaign.)`;
      return `MAIN PLAYBOOK (applies to every campaign):\n${main}\n\n=== CAMPAIGN PLAYBOOK — ${p.campaign}${p.text.includes('--- included:') ? ' (with the playbooks it follows, included below)' : ''} ===\n${p.text}`;
    }
    return list.length ? `${main}\n\nCAMPAIGN PLAYBOOKS: ${list.map((c) => `${c.campaign}${c.includes?.length ? ` (also follows ${c.includes.join(', ')})` : ''}`).join('; ')} — get_playbook(campaign=…) for one.` : main;
  });

  // Settings the AI may change (asked by the owner). Owner-only: approval mode, daily / new-number limits and the gap
  // between messages (they protect the numbers from WhatsApp bans and keep AI messages behind approval), Meta prices.
  const AI_SETTINGS = ['sendStart', 'sendEnd', 'sendDays', 'anytime', 'typing', 'followupStart', 'followupDailyMax', 'storeGroups',
    'autosaveImages', 'autosaveDocuments', 'autosaveKnownOnly', 'autosaveMaxMb', 'optOutWords', 'webhookUrl'];
  const OWNER_ONLY = { aiMode: 'approval mode', dailyCap: 'daily limit', warmDailyCap: 'limit for people who wrote in 30 days', hourlyCap: 'hourly limit', newChatsPer24h: 'new-number limit', delayMinSec: 'gap between messages', delayMaxSec: 'gap between messages' };

  tool('get_settings', 'Settings of one number (or the shared defaults for all numbers): sending hours/days, follow-up time and daily max, typing, auto-save, opt-out words, notify URL, approval mode and limits (read-only for the AI); plus the morning summary and alert phones. Which settings a number has changed itself is marked "own".', {
    account: z.string().optional().describe('Number id; "all" = the shared defaults; omit = every number, short'),
  }, async (a) => {
    const defs = await import('./defaults.js');
    const dflt = await defs.getDefaults();
    const line = (s) => Object.entries(normalizeSettings(s)).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}${OWNER_ONLY[k] ? ' (owner only)' : ''}`).join(' | ');
    const out = [];
    if (a.account === 'all') out.push(`ALL NUMBERS (defaults): ${line(dflt)}`);
    else {
      const accs = a.account ? [(await manager.resolve(a.account)).account] : manager.list();
      for (const acc of accs) out.push(`${acc.id} (${acc.label}) purpose: ${acc.purpose || '-'}${acc.enabled === false ? ' PAUSED' : ''} | own: ${defs.ownKeys(acc.settings, dflt).join(',') || 'none'}\n  ${line(acc.settings)}`);
    }
    const dg = await import('./digest.js').then((m) => m.getDigest());
    const { alertPhones } = await import('./notify.js');
    out.push(`MORNING SUMMARY: ${dg.enabled ? `on at ${dg.time} from ${dg.account}` : 'off'} | ALERT PHONES: ${(await alertPhones()).map((p) => '+' + p).join(', ') || 'none'}`);
    out.push(`You may change (update_settings, when the owner asks): ${AI_SETTINGS.join(', ')}, purpose, name, the morning summary and alert phones; with owner_asked (their words): ${[...new Set(Object.values(OWNER_ONLY))].join(', ')}. Meta prices: dashboard only. Settings belong to a NUMBER, whatever campaign is open.`);
    return out.join('\n');
  });

  tool('update_settings', 'Change settings when the owner asks: sending hours and days (sendStart, sendEnd, sendDays 0=Sun…6, anytime), typing, follow-up time and daily max (followupStart, followupDailyMax), auto-save of media, opt-out words, notify URL (webhookUrl, integrations), storeGroups; a number\'s purpose; the morning summary (time, number, on/off) and alert phones. account="all" changes the shared defaults (numbers with their own value keep it). Approval mode, daily / new-number limits, message gaps and Meta prices are owner-only (dashboard).', {
    account: z.string().optional().describe('Number id, or "all" for every number (defaults). Needed for settings/purpose'),
    settings: z.record(z.string(), z.any()).optional().describe('e.g. {"sendStart":"09:00","sendEnd":"20:00","followupStart":"19:00","optOutWords":["stop","band karo"]}'),
    purpose: z.string().optional(),
    morning_summary: z.object({ enabled: z.boolean().optional(), time: z.string().optional(), account: z.string().optional() }).optional(),
    alert_phones: z.array(z.string()).optional().describe('Replaces the list of phones that get alerts and the morning summary'),
    label: z.string().optional().describe("A number's display name (owner asked)"),
    owner_asked: z.string().optional().describe('The owner\'s own words asking for it — required for the owner-only settings (approval mode aiMode, dailyCap, warmDailyCap, newChatsPer24h, delays); quoted in the activity log'),
  }, async (a) => {
    const done = [];
    const s = a.settings || {};
    const refused = Object.keys(s).filter((k) => OWNER_ONLY[k]);
    if (refused.length && !a.owner_asked?.trim()) throw new Error(`${refused.map((k) => OWNER_ONLY[k]).join(', ')}: only when the owner asked — pass owner_asked with their words. Nothing was changed.`);
    const unknown = Object.keys(s).filter((k) => !AI_SETTINGS.includes(k) && !OWNER_ONLY[k]);
    if (unknown.length) throw new Error(`Unknown setting(s): ${unknown.join(', ')}. Allowed: ${AI_SETTINGS.join(', ')}`);
    if (Object.keys(s).length || a.purpose !== undefined || a.label !== undefined) {
      if (!a.account) throw new Error('Say which number (account), or "all"');
      const { describeSettingsChange } = await import('./describe.js');
      if (a.account === 'all') {
        if (a.purpose !== undefined) throw new Error('purpose belongs to one number');
        const defs = await import('./defaults.js');
        const r = await defs.saveDefaults(s, manager);
        done.push(`defaults for all numbers (applied to ${r.numbers.filter((n) => n.changed.length).map((n) => n.id).join(', ') || 'none'}; own values kept on ${r.numbers.filter((n) => n.own.length).map((n) => n.id).join(', ') || 'none'})`);
        await ai(null, `Changed settings for all numbers: ${Object.keys(s).join(', ')} (owner asked)`);
      } else {
        const sess = await manager.resolve(a.account);
        const before = normalizeSettings(sess.account.settings);
        const acc = await manager.update(sess.id, { ...(Object.keys(s).length ? { settings: s } : {}), ...(a.purpose !== undefined ? { purpose: a.purpose } : {}), ...(a.label ? { label: a.label } : {}) });
        const what = [describeSettingsChange(before, normalizeSettings(acc.settings)), a.purpose !== undefined ? `Purpose: ${a.purpose}` : null, a.label ? `Name: ${a.label}` : null].filter(Boolean).join('; ');
        await ai(sess.id, `Changed settings — ${what || 'no change'} (${a.owner_asked ? `owner asked: "${trim(a.owner_asked, 160)}"` : 'owner asked'})`);
        done.push(`${sess.id}: ${what || 'no change'}`);
      }
    }
    if (a.morning_summary) {
      const dg = await (await import('./digest.js')).saveDigest({ ...a.morning_summary, ...(a.morning_summary.account ? { account: (await manager.resolve(a.morning_summary.account)).id } : {}) });
      await ai(null, `Morning summary: ${dg.enabled ? `on at ${dg.time} from ${dg.account}` : 'off'} (owner asked)`);
      done.push(`morning summary ${dg.enabled ? `on at ${dg.time} from ${dg.account}` : 'off'}`);
    }
    if (a.alert_phones) {
      const phones = await (await import('./notify.js')).setAlertPhones(a.alert_phones);
      await ai(null, `Alert phones set: ${phones.map((p) => '+' + p).join(', ') || 'none'} (owner asked)`);
      done.push(`alert phones ${phones.map((p) => '+' + p).join(', ') || 'none'}`);
    }
    return done.length ? `Saved: ${done.join(' · ')}.` : 'Nothing to change — give settings, purpose, morning_summary or alert_phones.';
  });

  tool('save_playbook', "Replace the main playbook, or one campaign's playbook (campaign=…, created if new — e.g. \"Corporate sales\", \"Win-back\", \"Chef\"). Only when the owner asks to change their rules, or to write down the rules of a campaign the owner set up. Keep campaign-specific rules (offer, wording, who to target) in the campaign's playbook and general rules in the main one.", {
    text: z.string(), campaign: z.string().optional().describe('Campaign name; omit (or "all") for the MAIN playbook — never the open campaign by default'),
    includes: z.array(z.string()).optional().describe('Campaign playbook only: other playbooks it also follows (e.g. ["Hiring – all roles"]); replaces its INCLUDE lines'),
  }, async (a) => {
    const camp = a.campaign && !/^all$/i.test(a.campaign) ? a.campaign : null;
    const { withIncludes } = await import('./playbook.js');
    await savePlaybook(camp && a.includes ? withIncludes(a.text, a.includes) : a.text, camp, { actor: 'ai' });
    await ai(null, camp ? `Updated the "${camp}" campaign playbook` : 'Updated the playbook');
    return camp ? `Campaign playbook "${camp}" saved.` : 'Main playbook saved.';
  });

  tool('list_campaigns', 'The campaigns (like separate users: Chef, Front office, Corporate sales, Win-back …) with their lists, open Board cards and drafts, and which one the owner has open. Pass campaign="<name>" to any tool to work in one.', {}, async () => {
    const names = await scope.campaignNames();
    const rows = await query(
      `SELECT r.role, (SELECT count(*)::int FROM lists l WHERE l.role = r.role AND l.archived IS NULL) AS lists,
         (SELECT count(*)::int FROM outbox o WHERE o.status = 'draft' AND COALESCE(o.role, ${roleOf('o.account_id', 'o.to_jid')}) = r.role) AS drafts,
         (SELECT count(*)::int FROM tasks t WHERE t.status NOT IN ('done','cancelled') AND t.role = r.role) AS cards
       FROM unnest($1::text[]) AS r(role) ORDER BY lower(r.role)`, [names]);
    const open = await scope.getFocus();
    const pbs = new Set((await listCampaignPlaybooks()).map((p) => p.campaign.toLowerCase()));
    const { stagesInfo, stagesText } = await import('./stages.js');
    const lines = [];
    for (const r of rows) {
      const si = await stagesInfo(r.role);
      lines.push(`${r.role}${scope.same(r.role, open) ? ' (open)' : ''} | ${r.lists} lists | ${r.cards} open cards | ${r.drafts} drafts | playbook: ${pbs.has(r.role.toLowerCase()) ? 'yes' : 'no'}\n   stages${si.own ? '' : ' (default)'}: ${stagesText(si.stages)}`);
    }
    return [`Open in the dashboard: ${open ? scope.label(open) : 'all campaigns'}`,
      ...lines,
      'none = Hotel / no campaign (people on no list)'].join('\n');
  });
  tool('create_campaign', 'Create a campaign when the owner asks (e.g. "Diwali offer", "Driver hiring"), optionally with its playbook (rules: who to contact, what to say and never say). Then add people with import_list(role=<campaign>). It does not switch the owner\'s dashboard unless open=true.', {
    name: z.string(), playbook: z.string().optional().describe('The campaign\'s own rules'),
    includes: z.array(z.string()).optional().describe('Other playbooks it also follows, e.g. ["Hiring – all roles"] for a hiring campaign'),
    stages: z.union([z.enum(['hiring', 'sales', 'winback']), z.array(z.union([z.string(), z.object({ key: z.string().optional(), label: z.string(), closed: z.boolean().optional() })]))]).optional()
      .describe('Funnel stages: a preset ("hiring", "sales" = corporate/B2B, "winback" = past guests) or your own list in order, e.g. ["Replied","Meeting fixed","Proposal sent","Won","Lost (closed)"]. "(closed)" = no more messages to that person. Default: hiring for hiring campaigns, else sales'),
    open: z.boolean().optional().describe('Also open it in the dashboard (switch_campaign)'),
  }, async (a) => {
    const r = await scope.createCampaign(a.name);
    if (a.playbook?.trim() || a.includes?.length) {
      const { withIncludes } = await import('./playbook.js');
      await savePlaybook(withIncludes(a.playbook || '', a.includes || []), r.name, { actor: 'ai' });
    }
    if (a.stages) await (await import('./stages.js')).setStages(r.name, a.stages);
    if (a.open) await scope.setFocus(r.name);
    await ai(null, `${r.created ? 'Created' : 'Found'} campaign "${r.name}"${a.playbook ? ' with its playbook' : ''}${a.open ? ' and opened it' : ''}`, r.name);
    return `Campaign "${r.name}" ${r.created ? 'created' : 'already existed'}${a.playbook ? ', playbook saved' : ''}${a.open ? ' — now open in the dashboard' : ''}.`;
  });
  tool('set_campaign_stages', 'Set a campaign\'s funnel stages when the owner asks (or when you set up a campaign): a preset ("hiring", "sales" = corporate/B2B, "winback" = past guests) or your own list in order. Keys with built-in meaning: interested; date_given = a dated visit/meeting (reminders + an owner card); not_interested (always added, closed). Mark stages that end all messages with "(closed)". People already at a stage that no longer exists keep it until moved.', {
    name: z.string().describe('Campaign name'),
    stages: z.union([z.enum(['hiring', 'sales', 'winback']), z.array(z.union([z.string(), z.object({ key: z.string().optional(), label: z.string(), closed: z.boolean().optional() })]))]),
  }, async (a) => {
    const { setStages, stagesText } = await import('./stages.js');
    const stages = await setStages(a.name, a.stages);
    await ai(null, `Set the stages of "${a.name}": ${stagesText(stages)}`, a.name);
    return `Stages of "${a.name}": ${stagesText(stages)}`;
  });
  tool('switch_campaign', 'Open another campaign for the owner\'s dashboard and the default of every tool ("all" = all campaigns, "none" = hotel / no campaign). Only when the owner asks — they see the dashboard change. To just look at another campaign, pass campaign="<name>" to a tool instead.', {
    campaign: z.string().describe('Campaign name, "all" or "none"'),
  }, async (a) => {
    const c = await scope.setFocus(/^all$/i.test(a.campaign) ? '' : a.campaign);
    await ai(null, `Opened ${scope.label(c)} (owner asked)`, c && !scope.same(c, 'none') ? c : null);
    return `Now open: ${scope.label(c)}. The dashboard and every tool (by default) show only it from the next call.`;
  });

  tool('save_media', 'Download and keep a file from a message (e.g. a candidate\'s resume). Use the media id shown by get_messages.', {
    account: accountArg, chat: chatArg, message_id: z.string(),
  }, async (a) => {
    const s = await manager.resolve(a.account);
    const jid = await resolveChat(s.id, a.chat);
    await s.saveMedia(jid, a.message_id);
    return `Saved. Open in the dashboard: ${config.publicUrl || ''}/api/media/${s.id}/${encodeURIComponent(jid)}/${a.message_id}`;
  });

  tool('fetch_older_messages', 'Ask the phone for older messages of a chat than what is stored (arrives in the background in ~1 min; phone must be online). Use when a chat\'s history looks cut off.', {
    account: accountArg, chat: chatArg, count: z.number().int().min(1).max(50).optional(),
  }, async (a) => {
    const s = await manager.resolve(a.account);
    const jid = await resolveChat(s.id, a.chat);
    const r = await outbox.requestJob(s, 'fetch_older', { chat: jid, count: a.count || 50 });
    return r.ran
      ? 'Requested from the phone. Call get_messages again in about a minute.'
      : 'Queued for the server connected to this number (runs within ~10 s). Call get_messages again in a minute or two.';
  });

  const taskLine = (t) =>
    [
      `#${t.id}`,
      t.account_id,
      t.status,
      t.owner_note_pending ? 'OWNER NOTE TO ACT ON' : null,
      t.priority ? 'PRIORITY' : null,
      (t.assignee || 'you') === 'ai' ? 'for AI' : 'for owner',
      trim(t.title, 80),
      t.total ? `sent ${t.sent}/${t.total}${t.drafts ? `, ${t.drafts} awaiting approval` : ''}${t.failed ? `, ${t.failed} failed` : ''}${t.replied ? `, ${t.replied} replied` : ''}` : null,
      t.due_at ? `due ${fmtTime(Math.floor(new Date(t.due_at).getTime() / 1000))}` : null,
      t.details ? `— ${trim(t.details, 160)}` : null,
      t.notes ? `${t.notes} note(s), latest: "${trim(t.last_note, 300)}"` : null,
    ].filter(Boolean).join(' | ');

  tool('list_tasks', 'Show the Board — the shared calendar of the owner and the AI. Each card is "for owner" (interviews, calls, approvals; PRIORITY = must do) or "for AI" (replies, follow-ups, scheduled sends). The hub adds cards by itself: "Reply to X" (a candidate wrote, nobody answered — work these first), "Follow up: X" (they said when they will be free; message them when due), "Interview: X" (visit dates, owner), "Scheduled: …" (messages going out later), "Reminder". kind filters one type; for=ai with due_now=true is the AI to-do list right now. Past tasks only if past=true.', {
    account: z.string().optional(), past: z.boolean().optional(), role: z.string().optional(),
    kind: z.enum(['reply', 'followup', 'visit', 'scheduled', 'reminder', 'bulk', 'todo']).optional(),
    for: z.enum(['you', 'ai']).optional().describe('"you" = the owner cards, "ai" = the AI cards'),
    due_now: z.boolean().optional().describe('Only cards due by now (plus 1 hour)'),
    owner_notes: z.boolean().optional().describe('Only cards where the owner wrote a note the AI has not acted on yet — act on each (follow-up date, scheduled message, draft, …), then add_task_note saying what you did'),
  }, async (a) => {
    let rows = await tasks.listTasks({ account: a.account ? (await manager.resolve(a.account)).id : undefined, past: a.past, role: a.role, assignee: a.for, limit: a.past ? 60 : 500, // finished cards: the latest 60 are plenty
      dueBefore: a.due_now ? new Date(Date.now() + 3600000) : undefined });
    if (a.kind) rows = rows.filter((t) => t.kind === a.kind);
    if (a.owner_notes) {
      // also cards the owner closed while writing the note (last 7 days) — the note still asks for action
      const closed = a.past ? [] : await tasks.listTasks({ account: a.account ? (await manager.resolve(a.account)).id : undefined, past: true, role: a.role, limit: 300 });
      rows = [...rows, ...closed.filter((t) => t.completed_at && new Date(t.completed_at) > new Date(Date.now() - 7 * 86400e3))].filter((t) => t.owner_note_pending);
    }
    const chatOf = (t) => {
      const [k, x, j] = String(t.ref || '').split(':');
      return ['reply', 'remind'].includes(k) ? ` | chat ${j} on ${x}` : ['followup', 'visit'].includes(k) ? ` | chat ${j} on ${t.account_id} | list #${x}` : '';
    };
    // the chat as it is NOW next to each person's card (the card may be older than their latest message)
    const jidOf = (t) => String(t.ref || '').split(':')[2] || null;
    const jids = [...new Set(rows.map(jidOf).filter((j) => j && j.includes('@')))];
    const latest = new Map();
    if (jids.length && !a.past) {
      for (const r of await query(
        `SELECT DISTINCT ON (chat_jid) chat_jid, from_me, ts, left(regexp_replace(coalesce(body, '[' || type || ']'), '\\s+', ' ', 'g'), 90) AS body
         FROM messages WHERE chat_jid = ANY($1) ORDER BY chat_jid, ts DESC`, [jids])) latest.set(r.chat_jid, r);
    }
    const nowLine = (t) => {
      const m = latest.get(jidOf(t));
      if (!m) return '';
      const newer = !m.from_me && Number(m.ts) > new Date(t.updated_at).getTime() / 1000;
      return ` | chat now: ${m.from_me ? 'me' : 'them'} ${fmtTime(m.ts)} "${m.body}"${newer ? ' (NEWER than this card — read person_context)' : ''}`;
    };
    if (rows.length) return rows.map((t) => `${taskLine(t)}${chatOf(t)}${nowLine(t)}`).join('\n');
    if (a.past) return 'No finished tasks match.';
    const [p] = await query(`SELECT count(*)::int n FROM tasks WHERE status IN ('done','cancelled') AND completed_at > now() - interval '7 days'`);
    return `No open tasks match${a.account || a.for || a.kind || a.role ? ' these filters' : ''}. (${p.n} finished in the last 7 days — they are hidden; use past=true. A finished bulk send means everything went out.)`;
  });

  tool('create_task', 'Add a card to the Board. for="you" (default) = something the owner must do (call notes needed, take an interview, call someone) — set priority=true for must-dos. for="ai" = something an AI session must do at that time (e.g. "Send Ravi the menu on Friday"). Put who/what/which chat in details so a later session can act on it. For a candidate follow-up prefer update_list_member(available_from / follow_up_at), which keeps the card in step by itself.', {
    account: accountArg, title: z.string(), details: z.string().optional(), due: z.string().optional().describe('"YYYY-MM-DD HH:MM" (India time) or ISO'),
    for: z.enum(['you', 'ai']).optional(), priority: z.boolean().optional(),
    campaign: z.string().optional().describe('Campaign (job role) the card belongs to, e.g. Chef, Front office. Found automatically when the card names a phone number on a list.'),
  }, async (a) => {
    const s = await manager.resolve(a.account);
    const t = await tasks.createTask({ account: s.id, title: a.title, details: a.details, dueAt: localTime(a.due) || null, createdBy: 'ai', assignee: a.for, priority: a.priority, role: a.campaign || null });
    await ai(s.id, `Created task #${t.id} "${t.title}"`);
    return `Task #${t.id} created on ${s.id} (for ${t.assignee === 'ai' ? 'AI' : 'owner'}${t.priority ? ', priority' : ''}${t.due_at ? `, due ${d(t.due_at)}` : ''}).`;
  });

  tool('update_task', 'Move or edit a task card (status: upcoming, in_progress, waiting, done, cancelled). Cancelling also stops its unsent messages.', {
    id: z.number().int(), status: z.enum(['upcoming', 'in_progress', 'waiting', 'done', 'cancelled']).optional(),
    title: z.string().optional(), details: z.string().optional(), due: z.string().optional(),
    for: z.enum(['you', 'ai']).optional(), priority: z.boolean().optional(),
    campaign: z.string().optional().describe('Set the card\'s campaign (job role); "" clears it'),
  }, async (a) => {
    if (a.campaign !== undefined) await tasks.updateTask(a.id, { role: a.campaign, actor: 'ai' });
    const t = a.status === 'cancelled' ? await tasks.cancelTask(a.id, 'ai') : await tasks.updateTask(a.id, { status: a.status, title: a.title, details: a.details, dueAt: localTime(a.due), assignee: a.for, priority: a.priority, actor: 'ai' });
    return `Task #${t.id}: ${t.status} — ${t.title}`;
  });

  tool('add_task_note', 'Write a note on a Board card (what was agreed, what you did, what is still open). The owner writes call notes on "Call notes needed" cards the same way — read them with task_history before drafting.', {
    id: z.number().int(), text: z.string(),
  }, async (a) => {
    const t = await tasks.addNote(a.id, a.text, 'ai');
    return `Note added to task #${t.id} (${t.title}).`;
  });

  tool('log_call_result', 'Record what happened on a phone call the OWNER made about a Board card (only when the owner tells you; they usually tap it on the card): interested → stage interested + an AI card to send the details; date → interview date (at); no_answer → an AI card to message them; call_back → an owner card to call again (at); not_interested → stage closed, nothing more is sent. Closes the card.', {
    id: z.number().int().describe('Board card id'), result: z.enum(['interested', 'date', 'no_answer', 'call_back', 'not_interested']),
    at: z.string().optional().describe('For date / call_back: "YYYY-MM-DD HH:MM" (owner time zone)'), note: z.string().optional().describe('What the owner said about the call'),
  }, async (a) => {
    const { recordCallResult } = await import('./calls.js');
    const r = await recordCallResult(a.id, { result: a.result, at: a.at, note: a.note });
    await ai(null, `Call result on card #${a.id} (owner told the AI): ${r.note.replace(/^📞 Call: /, '')}`);
    return `${r.note}${r.card ? ` — next step: card #${r.card.id} "${r.card.title}"` : ''}.`;
  });

  tool('task_history', 'A Board card\'s full history and notes: when it was created, moved, re-dated or closed by the hub and why (e.g. "Done by the hub — a reply went out"), plus every note from the owner or the AI. Use it to read call notes, and to debug "where did this card go?".', {
    id: z.number().int(),
  }, async (a) => {
    const rows = await tasks.taskLog(a.id);
    if (!rows.length) return 'No history for this task (it may be older than the history feature).';
    return rows.map((r) => `${d(r.at)} | ${r.actor === 'you' ? 'owner' : r.actor} | ${r.kind === 'note' ? 'NOTE: ' : ''}${r.text}`).join('\n');
  });

  tool(
    'bulk_send',
    'Send one message to many people as a single task on the board, e.g. job invites to candidates from a sheet. Use {name} (and any other recipient field like {role}) in the text. Skips invalid numbers, duplicates, opted-out contacts, and people this number messaged in the last N days. Respects the number\'s approval mode, random delay, daily cap and sending hours. Returns what was queued and what was skipped and why.',
    {
      account: accountArg,
      title: z.string().describe('Short card title, e.g. "Chef candidates – WorkIndia 16 Oct"'),
      text: z.string().optional().describe('Message, may contain {name}, {first_name} and any recipient field. Or use template.'),
      template: z.string().optional().describe('Saved template name/id to use instead of text'),
      recipients: z.array(z.object({ to: z.string(), name: z.string().optional() }).passthrough()).min(1),
      details: z.string().optional(),
      attachment_url: z.string().optional(),
      file_name: z.string().optional(),
      schedule_at: z.string().optional().describe('ISO datetime to start (default now)'),
      skip_if_contacted_days: z.number().int().min(0).optional().describe('Default 30; 0 = do not skip'),
      idempotency_key: z.string().optional().describe('Optional unique key, e.g. sheet name + date; repeating it never creates a second bulk send'),
      wa_template: waTemplateArg.describe('Required on Meta Cloud API numbers: the approved Meta template (params may use {name} etc.)'),
      expires_at: z.string().optional().describe('"Send by": if it has not gone out by this time ("YYYY-MM-DD HH:MM" owner time or ISO) it is dropped — set it for anything tied to a day (festival / birthday wishes, offers ending, reminders before an interview). Such messages go out before other outreach; the hub warns the owner if the number\'s daily limit can\'t fit them in time.'),
    },
    async (a) => {
      const r = await outbox.bulkSend({ expiresAt: localTime(a.expires_at) || null,
        account: a.account, title: a.title, details: a.details, text: a.text, template: a.template, waTemplate: a.wa_template, recipients: a.recipients,
        attachment: a.attachment_url ? { url: a.attachment_url, fileName: a.file_name } : undefined,
        scheduledAt: localTime(a.schedule_at) || undefined, source: 'mcp', createdBy: 'ai',
        skipIfContactedDays: a.skip_if_contacted_days ?? 30, allowRepeat: a.skip_if_contacted_days === 0, idemKey: a.idempotency_key,
      });
      if (r.duplicate) return `Already created earlier as task #${r.task.id} — nothing new queued.`;
      const skipped = r.skipped.length ? `\nSkipped ${r.skipped.length}: ${r.skipped.slice(0, 30).map((x) => `${x.to} (${x.reason})`).join('; ')}` : '';
      if (!r.task) return `Nothing queued.${skipped}`;
      await ai(r.task.account_id, `Created bulk send "${a.title}": ${r.queued} recipients, ${r.skipped.length} skipped`);
      return `Task #${r.task.id}: ${r.queued} messages ${r.mode === 'approve' ? 'saved as drafts — waiting for the owner to approve on the board' : 'queued'}.${await taskCostText(r.task.id)}${skipped}`;
    },
  );

  tool('approve_task', 'Approve all drafts of a task so they start sending. Only when the user has explicitly approved in this conversation.', { id: z.number().int() }, async (a) => {
    const r = await outbox.approveTask(a.id);
    const [t] = await query('SELECT account_id FROM tasks WHERE id = $1', [a.id]);
    await ai(t?.account_id, `Approved ${r.approved} messages of task #${a.id} (owner approved in chat)`);
    return `Approved ${r.approved} messages of task #${a.id}.`;
  });

  return server;
}

export function mountMcp(app) {
  const handler = async (req, res) => {
    const key = req.params.key || req.get('x-api-key') || req.query.key;
    if (key !== config.apiKey) return res.status(401).json({ error: 'Unauthorized' });
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').json({ error: 'Method not allowed' });
    // Campaign scope: the URL can pin one (/mcp/<key>/<campaign>, ?campaign=…; "all" = every campaign) — e.g. for a
    // background routine that always works on Chef hiring. Otherwise the campaign chosen in the dashboard applies.
    const pinned = req.params.campaign ?? req.query.campaign;
    const focus = pinned !== undefined ? (/^all$/i.test(pinned) ? '' : String(pinned)) : await scope.getFocus().catch(() => '');
    const main = (await getPlaybook().catch(() => ({ text: '' }))).text;
    let instructions;
    if (focus) {
      // inside a campaign: the main rules plus that campaign's own playbook, in full; other campaigns are not mentioned
      const cp = await getCampaignPlaybook(focus).catch(() => null);
      instructions = `${main}\n\n${cp ? `CAMPAIGN PLAYBOOK — ${cp.campaign} (follow it together with the main rules):\n${cp.text}` : `(No playbook for ${scope.label(focus)} yet — follow the main rules.)`}`;
    } else {
      const camps = await listCampaignPlaybooks().catch(() => []);
      // the main playbook in full; campaign playbooks by name only (the AI reads the one it works on)
      instructions = camps.length ? `${main}\n\nCAMPAIGN PLAYBOOKS (own rules per campaign — read the one you work on with get_playbook(campaign=…) or hub_overview(campaign=…)): ${camps.map((c) => c.campaign).join(', ')}` : main;
    }
    const server = buildServer(instructions, focus);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
  app.all('/mcp/:key', handler);
  app.all('/mcp/:key/:campaign', handler);
  app.all('/mcp', handler);
}

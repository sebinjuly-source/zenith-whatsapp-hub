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
import { query } from './db.js';
import { manager } from './wa/manager.js';
import * as store from './store.js';
import * as outbox from './outbox.js';
import { toTs } from './util.js';
import * as tasks from './tasks.js';
import * as templates from './templates.js';
import * as rules from './rules.js';
import { findPerson } from './people.js';
import * as lists from './lists.js';
import { getPlaybook, savePlaybook } from './playbook.js';
import { logEvent } from './db.js';
import { HISTORY_MODES } from './describe.js';
import { normalizeSettings } from './settings.js';

const ai = (accountId, text) => logEvent(accountId, 'info', text, 'ai');

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
const safe = (fn) => async (args) => {
  try {
    return text(await fn(args));
  } catch (err) {
    return fail(err);
  }
};

const accountArg = z.string().optional().describe('Account id (e.g. "hiring") or its phone number. Omit for the default account.');
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

function buildServer(playbook = '') {
  const server = new McpServer(
    { name: 'zenith-whatsapp-hub', version: '0.1.0' },
    { instructions: `Zenith WhatsApp Hub: several WhatsApp numbers (list_accounts), chats, candidate lists with a funnel, tasks, templates and rules. Follow the owner's playbook below (also via get_playbook).\n\n${playbook}` },
  );
  const tool = (name, description, inputSchema, fn) => server.registerTool(name, { description, inputSchema }, safe(fn));

  tool('list_accounts', 'List the WhatsApp numbers in the hub: id, purpose, phone, connection status, AI mode (approve/auto), and how much history is stored. Start here.', {}, async () => {
    const lines = [];
    await manager.refresh();
    for (const a of manager.list()) {
      const st = await store.accountStats(a.id);
      const bf = await outbox.backfillStatus(a.id);
      const mode = normalizeSettings(a.settings).historyMode;
      const phases = a.sync?.phases || {};
      const imported = mode === 'full' ? phases.FULL : mode === 'recent' ? phases.RECENT : phases.INITIAL_BOOTSTRAP;
      lines.push(
        `${a.id}${a.isDefault ? ' (default)' : ''} | ${a.label} | purpose: ${a.purpose || '-'} | +${a.phone || '?'} | ${a.status} | ai:${a.settings.aiMode} | ` +
          `${st.chats} chats (${st.groups} groups), ${st.contacts} contacts, ${st.messages} msgs since ${fmtTime(st.oldest_ts)} | history chosen at link: ${HISTORY_MODES[mode]} (${imported === 'complete' ? 'imported' : 'importing'})` +
          (bf ? ` | deep history #${bf.id}: ${bf.status}${bf.result ? ' — ' + bf.result : ''}` : ''),
      );
    }
    return lines.join('\n') || 'No accounts yet.';
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
      state: z.enum(['open', 'snoozed', 'due', 'done']).optional().describe('open (incl. due reminders), snoozed (reminder pending), due (reminder date reached), done'),
      active_since: z.string().optional().describe('Last message on/after this date (YYYY-MM-DD)'),
      inactive_since: z.string().optional().describe('Last message before this date (YYYY-MM-DD) — good for finding stale leads'),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async (a) => {
      const s = await manager.resolve(a.account);
      const rows = await store.listChats(s.id, {
        q: a.query, kind: a.kind === 'all' ? undefined : a.kind, tag: a.tag, waitingOnMe: a.waiting_on_me, state: a.state,
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
        chatJid, fromMe: a.from_me, sinceTs: toTs(a.since), untilTs: toTs(a.until), type: a.type, limit: a.limit || 20,
      });
      return rows.length
        ? rows.map((m) => `${m.account_id} | ${m.chat_jid} | ${trim(m.chat_name, 30)} | ${msgLine(m, 200)}`).join('\n')
        : 'No matches.';
    },
  );

  tool(
    'list_shared_contacts',
    'List contact cards (vCards) shared in chats/groups — e.g. leads posted in a group. Returns name, organisation, phone numbers, where and when it was shared.',
    { account: accountArg, chat: z.string().optional(), since: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
    async (a) => {
      const s = await manager.resolve(a.account);
      const chatJid = a.chat ? await resolveChat(s.id, a.chat) : null;
      const p = [s.id];
      let where = "m.account_id = $1 AND m.type = 'contact'";
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
        `SELECT m.chat_jid, ch.name AS chat_name, m.ts, m.sender_name, m.from_me, m.vcards FROM messages m
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
    },
    async (a) => {
      const s = await manager.resolve(a.account);
      const jid = await resolveChat(s.id, a.chat);
      await ai(s.id, `Updated contact ${jid.split('@')[0]}${a.add_tags?.length ? ' +' + a.add_tags.join(',') : ''}${a.remove_tags?.length ? ' -' + a.remove_tags.join(',') : ''}${a.lead_status ? ' status ' + a.lead_status : ''}`);
      const c = await store.updateContact(s.id, jid, {
        addTags: a.add_tags, removeTags: a.remove_tags, leadStatus: a.lead_status, notes: a.notes, summary: a.summary, markReviewed: a.mark_reviewed,
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
    },
    async (a) => {
      const s = await manager.resolve(a.account);
      const jid = await resolveChat(s.id, a.to);
      let attachment = a.attachment_url ? { url: a.attachment_url, fileName: a.file_name, as: a.send_as } : undefined;
      let text = a.text;
      if (a.template) {
        const r = await outbox.renderTemplate(s.id, jid, a.template, a.vars || {});
        if (r.missing.length) return `Template "${r.template.name}" needs values for: ${r.missing.join(', ')} — pass them in vars.`;
        text = text || r.payload.text;
        attachment = attachment || r.payload.attachment;
      }
      const payload = { text, attachment, ...(a.reply_to_message_id ? { replyTo: a.reply_to_message_id } : {}) };
      const row = await outbox.enqueue({ account: s.id, to: jid, payload, source: 'mcp', note: a.note, taskId: a.task_id, idemKey: a.idempotency_key });
      if (row.duplicate) return `Already handled earlier as #${row.id} (${row.status}) — not sent again.`;
      await ai(s.id, `${row.status === 'draft' ? 'Drafted' : 'Queued'} message #${row.id} to ${jid.split('@')[0]}${a.note ? ` — ${a.note}` : ''}`);
      return row.status === 'draft'
        ? `Draft #${row.id} created for ${jid} — waiting for approval in the dashboard (account "${s.id}" is in approve mode).`
        : `Queued #${row.id} for ${jid}; it goes out after the random delay, within sending hours and the daily cap.`;
    },
  );

  tool('list_outbox', 'List drafts / queued / sent / failed messages created by agents, campaigns or the API.', {
    account: z.string().optional(),
    status: z.string().optional().describe('Comma list: draft,queued,sent,failed,rejected (default draft,queued,failed)'),
    limit: z.number().int().min(1).max(100).optional(),
  }, async (a) => {
    const rows = await outbox.listOutbox({ account: a.account, status: a.status || 'draft,queued,failed', limit: a.limit || 20 });
    return rows.length
      ? rows.map((r) => `#${r.id} | ${r.account_id} | ${r.status} | ${r.to_jid}${r.to_name ? ` (${r.to_name})` : ''} | ${trim(r.payload.text || r.payload.attachment?.caption || '[file]', 100)}${r.error ? ` | error: ${r.error}` : ''}`).join('\n')
      : 'Nothing.';
  });

  tool('approve_draft', 'Approve (and optionally edit) a draft so it gets sent. Only use when the user has explicitly approved it in this conversation.', {
    id: z.number().int(), text: z.string().optional(),
  }, async (a) => {
    const r = await outbox.approve(a.id, { text: a.text });
    await ai(r.account_id, `Approved draft #${r.id} (owner approved in chat)`);
    return `Draft #${r.id} approved and queued.`;
  });

  tool('reject_draft', 'Discard a draft or a queued message.', { id: z.number().int() }, async (a) => {
    await outbox.reject(a.id);
    return `#${a.id} rejected.`;
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
      const rows = await query(`SELECT * FROM events WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT $1`, p);
      return rows.length
        ? rows.map((e) => `[${fmtTime(Math.floor(new Date(e.created_at).getTime() / 1000))}] ${e.actor === 'you' ? 'owner' : e.actor} | ${e.account_id || '-'} | ${trim(e.text, 200)}`).join('\n')
        : 'No recorded actions yet.';
    },
  );

  tool('list_templates', 'Saved message templates (name, which number, text with {fields}, attached file). Use them via send_message/bulk_send template=.', {
    account: z.string().optional(),
  }, async (a) => {
    const rows = await templates.listTemplates(a.account ? (await manager.resolve(a.account)).id : undefined);
    return rows.length
      ? rows.map((t) => `#${t.id} | ${t.name} | ${t.account_id || 'all numbers'} | fields: ${templates.fieldsIn(t.body).join(',') || '-'}${t.attachment?.url ? ' | file' : ''} | ${trim(t.body, 160)}`).join('\n')
      : 'No templates yet.';
  });

  tool('save_template', 'Create or update a saved message template. Use {name}, {first_name}, {phone} (filled from the contact) and any other {field}.', {
    id: z.number().int().optional().describe('Give to update an existing template'),
    account: z.string().optional().describe('Number it belongs to; omit for all numbers'),
    name: z.string(), body: z.string(),
    attachment_url: z.string().optional(), file_name: z.string().optional(),
  }, async (a) => {
    const t = await templates.saveTemplate({
      id: a.id, account: a.account ? (await manager.resolve(a.account)).id : null, name: a.name, body: a.body,
      attachment: a.attachment_url ? { url: a.attachment_url, fileName: a.file_name } : null,
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
      until = a.until ? new Date(a.until).toISOString() : a.in_days ? new Date(Date.now() + a.in_days * 86400000).toISOString() : null;
      if (!until) return 'For a reminder give until or in_days.';
    }
    await store.setChatState(s.id, jid, a.state, { until, note: a.note });
    await ai(s.id, `Chat ${jid.split('@')[0]} → ${a.state === 'snoozed' ? `remind on ${fmtTime(Math.floor(new Date(until).getTime() / 1000))}${a.note ? ' (' + a.note + ')' : ''}` : a.state}`);
    return a.state === 'snoozed' ? `Reminder set for ${fmtTime(Math.floor(new Date(until).getTime() / 1000))}.` : `Chat marked ${a.state}.`;
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
    const rows = await rules.listRules(a.account ? (await manager.resolve(a.account)).id : undefined);
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
    add_tags: z.array(z.string()).optional(), lead_status: z.string().optional(), save_media: z.boolean().optional(),
    create_task: z.string().optional().describe('Task title, may use {name}'),
    reply_template: z.string().optional().describe('Template to auto-reply with (once per person per day)'),
    snooze_days: z.number().int().optional(),
  }, async (a) => {
    const s = await manager.resolve(a.account);
    const r = await rules.saveRule({
      id: a.id, account: s.id, name: a.name, enabled: a.enabled ?? true,
      conditions: { chat: a.chat, types: a.types, words: a.words, sender: a.sender },
      actions: { addTags: a.add_tags, leadStatus: a.lead_status, saveMedia: a.save_media, createTask: a.create_task, replyTemplate: a.reply_template, snoozeDays: a.snooze_days },
    });
    await ai(s.id, `Saved rule "${r.name}"`);
    return `Rule #${r.id} "${r.name}" saved (${r.enabled ? 'on' : 'off'}).`;
  });

  const listArg = z.string().describe('List id or name, e.g. "Chef candidates – Batch 5"');
  const d = (t) => (t ? fmtTime(Math.floor(new Date(t).getTime() / 1000)) : '-');

  tool('list_lists', 'Contact lists (e.g. candidate batches) with counts per status: new (not messaged), queued, sent (no reply), replied, failed, opted_out — plus follow-up settings.', {
    account: z.string().optional(),
  }, async (a) => {
    const acc = a.account ? (await manager.resolve(a.account)).id : null;
    for (const l of await query('SELECT id FROM lists WHERE ($1::text IS NULL OR account_id = $1)', [acc])) await lists.refreshList(l.id);
    const rows = await lists.listLists(acc);
    return rows.length
      ? rows.map((l) => `#${l.id} | ${l.name} | ${l.account_id} | ${l.total} people: ${l.new} new, ${l.queued} queued, ${l.sent} sent/no reply, ${l.replied} replied, ${l.failed} failed, ${l.opted_out} opted out | follow-up: ${l.followup?.enabled ? `after ${l.followup.afterDays}d, max ${l.followup.max}` : 'off'}`).join('\n')
      : 'No lists yet.';
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
    account: accountArg, name: z.string(), since: z.string().optional(), source: z.string().optional(),
    members: z.array(z.object({ phone: z.string(), name: z.string().optional(), message: z.string().optional().describe('Personal first message for this person') }).passthrough()).min(1),
  }, async (a) => {
    const r = await lists.importList({ account: a.account, name: a.name, since: a.since, source: a.source, members: a.members });
    await ai(r.list.account_id, `Imported ${r.imported} people into list "${r.list.name}"`);
    return `List #${r.list.id} "${r.list.name}": ${r.imported} people imported/updated${r.skipped.length ? `, skipped ${r.skipped.length}: ${r.skipped.map((x) => x.row + ' (' + x.reason + ')').join('; ')}` : ''}.`;
  });

  tool('send_to_list', 'Message the people on a list with the given statuses (default new + failed). Each gets their own prepared message from the list, unless text/template is given. Follows the number\'s approval mode, delay, daily cap and hours. Use only_phones to pick specific people.', {
    list: listArg, statuses: z.array(z.enum(['new', 'failed', 'sent', 'replied'])).optional(),
    text: z.string().optional(), template: z.string().optional(), only_phones: z.array(z.string()).optional(),
  }, async (a) => {
    const l = await lists.getList(a.list);
    const r = await lists.sendToList(l.id, { statuses: a.statuses, text: a.text, template: a.template, onlyPhones: a.only_phones, createdBy: 'ai', source: 'mcp' });
    await ai(l.account_id, `List "${l.name}": ${r.queued} messages ${r.mode === 'approve' ? 'drafted' : 'queued'}`);
    const skipped = r.skipped.length ? ` Skipped: ${r.skipped.map((x) => x.to + ' (' + x.reason + ')').join('; ')}` : '';
    return r.task ? `Task #${r.task.id}: ${r.queued} messages ${r.mode === 'approve' ? 'saved as drafts — waiting for approval on the board' : 'queued'}.${skipped}` : `Nothing to send.${skipped}`;
  });

  tool('set_followup', 'Automatic follow-ups for a list: people who were messaged but have not replied after N days get the follow-up message (quoting our last message), up to max times. By default only on days the number sends no first messages to new people (new candidates have priority). Checked every 10 minutes.', {
    list: listArg, enabled: z.boolean(), after_days: z.number().optional(), max: z.number().int().optional(),
    text: z.string().optional().describe('Follow-up message; may use {first_name}, {name}'), template: z.string().optional(),
    quiet_days_only: z.boolean().optional().describe('Default true: follow-ups only on days this number sends no first messages to new people'),
    auto_send: z.boolean().optional().describe('Send follow-ups without approval (owner allowed). Timing/daily max come from the number settings (default after 21:00, max 5/day).'),
  }, async (a) => {
    const l = await lists.getList(a.list);
    const u = await lists.setFollowup(l.id, { enabled: a.enabled, afterDays: a.after_days, max: a.max, text: a.text, template: a.template, quietDaysOnly: a.quiet_days_only, autoSend: a.auto_send });
    await ai(l.account_id, `Follow-ups for "${l.name}": ${u.followup.enabled ? 'on' : 'off'}`);
    return `Follow-ups for "${l.name}": ${u.followup.enabled ? `on — after ${u.followup.afterDays} day(s) without reply, up to ${u.followup.max}` : 'off'}.`;
  });

  tool('update_list_member', 'Move a person through the funnel: stage (interested, date_given, visited, trial, selected, joined, no_show, not_interested, rejected), the date/time they will come (visit_at → automatic reminder before it and a board task), outcome (short reason) and notes. Stages joined / not_interested / rejected close the person (no more sends or follow-ups). Owner rule: anyone asking for money before joining → stage rejected.', {
    list: listArg, phone: z.string(),
    stage: z.enum(['interested', 'date_given', 'visited', 'trial', 'selected', 'joined', 'no_show', 'not_interested', 'rejected', '']).optional().describe('Funnel stage ("" clears it)'),
    visit_at: z.string().optional().describe('When they will come (ISO or "YYYY-MM-DD HH:MM", your timezone if no offset); sets stage date_given; "" clears'),
    outcome: z.string().optional().describe('Short reason/summary, e.g. "rejected – asked for money before joining"'),
    notes: z.string().optional(),
  }, async (a) => {
    const l = await lists.getList(a.list);
    // "YYYY-MM-DD" alone → 10:00; no timezone given → India time
    let visitAt = a.visit_at === undefined ? undefined : a.visit_at === '' ? null : a.visit_at.trim();
    if (visitAt && /^\d{4}-\d{2}-\d{2}$/.test(visitAt)) visitAt += ' 10:00';
    if (visitAt && !/[zZ]|[+-]\d\d:?\d\d$/.test(visitAt)) visitAt = visitAt.replace(' ', 'T') + '+05:30';
    const m = await lists.updateMember(l.id, a.phone, { outcome: a.outcome, notes: a.notes, stage: a.stage, visitAt });
    await ai(l.account_id, `List "${l.name}": ${m.name || m.phone} → ${m.stage || '-'}${m.visit_at ? ' (visit ' + d(m.visit_at) + ')' : ''}${a.outcome ? ' – ' + a.outcome : ''}`);
    const parts = [m.stage && `stage ${m.stage}`, m.visit_at && `visit ${d(m.visit_at)}`, m.outcome && `outcome ${m.outcome}`, m.notes && 'notes saved'].filter(Boolean);
    return `${m.name || m.phone}: ${parts.join(', ') || 'updated'}.`;
  });

  tool('pipeline', 'Funnel overview across lists: people per stage (plus not contacted / contacted / replied without a stage) and upcoming visits with dates. Start here for "where do candidates stand?".', {
    account: z.string().optional(),
  }, async (a) => {
    const acc = a.account ? (await manager.resolve(a.account)).id : null;
    for (const l of await query('SELECT id FROM lists WHERE ($1::text IS NULL OR account_id = $1)', [acc])) await lists.refreshList(l.id);
    const { counts, visits } = await lists.pipelineSummary(acc);
    const byList = {};
    for (const c of counts) (byList[c.name] ||= []).push(`${c.stage}: ${c.n}`);
    const out = Object.entries(byList).map(([n, s]) => `${n} — ${s.join(', ')}`);
    out.push(visits.length ? 'Upcoming/overdue visits:\n' + visits.map((v) => `  ${d(v.visit_at)} | ${v.name || v.phone} (+${v.phone}) | ${v.list}`).join('\n') : 'No visits scheduled.');
    return out.join('\n');
  });

  tool('set_pipeline', 'Pipeline automation for a list: ask interested people for a date, remind people before their visit date, and add owner tasks. Texts may use {first_name}, {visit_date}.', {
    list: listArg, enabled: z.boolean().optional(), auto_send: z.boolean().optional().describe('Send these without approval'),
    remind_hours_before: z.number().optional(), ask_date_after_hours: z.number().optional(),
    reminder_text: z.string().optional(), ask_date_text: z.string().optional(),
  }, async (a) => {
    const l = await lists.getList(a.list);
    const u = await lists.setPipeline(l.id, { enabled: a.enabled, autoSend: a.auto_send, remindHoursBefore: a.remind_hours_before, askDateAfterHours: a.ask_date_after_hours, reminderText: a.reminder_text, askDateText: a.ask_date_text });
    await ai(l.account_id, `Pipeline settings for "${l.name}" updated`);
    const p = u.pipeline;
    return `Pipeline for "${l.name}": ${p.enabled ? 'on' : 'off'}, ${p.autoSend ? 'sends automatically' : 'drafts for approval'}, reminder ${p.remindHoursBefore}h before visits, ask for a date after ${p.askDateAfterHours}h.`;
  });

  tool('get_playbook', "The owner's standing rules (hiring policy, priorities, tone). Read before acting on candidates or guests.", {}, async () => (await getPlaybook()).text);

  tool('save_playbook', "Replace the owner's playbook text. Only when the owner asks to change their rules.", { text: z.string() }, async (a) => {
    await savePlaybook(a.text);
    await ai(null, 'Updated the playbook');
    return 'Playbook saved.';
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
      trim(t.title, 80),
      t.total ? `sent ${t.sent}/${t.total}${t.drafts ? `, ${t.drafts} awaiting approval` : ''}${t.failed ? `, ${t.failed} failed` : ''}${t.replied ? `, ${t.replied} replied` : ''}` : null,
      t.due_at ? `due ${fmtTime(Math.floor(new Date(t.due_at).getTime() / 1000))}` : null,
      t.details ? `— ${trim(t.details, 160)}` : null,
    ].filter(Boolean).join(' | ');

  tool('list_tasks', 'Show the task board: what each number is doing or will do (bulk sends with progress, follow-ups, to-dos). Past tasks only if past=true.', {
    account: z.string().optional(), past: z.boolean().optional(),
  }, async (a) => {
    const rows = await tasks.listTasks({ account: a.account ? (await manager.resolve(a.account)).id : undefined, past: a.past });
    return rows.length ? rows.map(taskLine).join('\n') : 'No tasks.';
  });

  tool('create_task', 'Add a card to the task board, e.g. "Follow up tomorrow with the 10 candidates who showed interest". Put the who/what in details so a later session can act on it.', {
    account: accountArg, title: z.string(), details: z.string().optional(), due: z.string().optional().describe('YYYY-MM-DD or ISO datetime'),
  }, async (a) => {
    const s = await manager.resolve(a.account);
    const t = await tasks.createTask({ account: s.id, title: a.title, details: a.details, dueAt: a.due, createdBy: 'ai' });
    await ai(s.id, `Created task #${t.id} "${t.title}"`);
    return `Task #${t.id} created on ${s.id}.`;
  });

  tool('update_task', 'Move or edit a task card (status: upcoming, in_progress, waiting, done, cancelled). Cancelling also stops its unsent messages.', {
    id: z.number().int(), status: z.enum(['upcoming', 'in_progress', 'waiting', 'done', 'cancelled']).optional(),
    title: z.string().optional(), details: z.string().optional(), due: z.string().optional(),
  }, async (a) => {
    const t = a.status === 'cancelled' ? await tasks.cancelTask(a.id) : await tasks.updateTask(a.id, { status: a.status, title: a.title, details: a.details, dueAt: a.due });
    return `Task #${t.id}: ${t.status} — ${t.title}`;
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
    },
    async (a) => {
      const r = await outbox.bulkSend({
        account: a.account, title: a.title, details: a.details, text: a.text, template: a.template, recipients: a.recipients,
        attachment: a.attachment_url ? { url: a.attachment_url, fileName: a.file_name } : undefined,
        scheduledAt: a.schedule_at, source: 'mcp', createdBy: 'ai',
        skipIfContactedDays: a.skip_if_contacted_days ?? 30, allowRepeat: a.skip_if_contacted_days === 0, idemKey: a.idempotency_key,
      });
      if (r.duplicate) return `Already created earlier as task #${r.task.id} — nothing new queued.`;
      const skipped = r.skipped.length ? `\nSkipped ${r.skipped.length}: ${r.skipped.slice(0, 30).map((x) => `${x.to} (${x.reason})`).join('; ')}` : '';
      if (!r.task) return `Nothing queued.${skipped}`;
      await ai(r.task.account_id, `Created bulk send "${a.title}": ${r.queued} recipients, ${r.skipped.length} skipped`);
      return `Task #${r.task.id}: ${r.queued} messages ${r.mode === 'approve' ? 'saved as drafts — waiting for the owner to approve on the board' : 'queued'}.${skipped}`;
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
    const server = buildServer((await getPlaybook().catch(() => ({ text: '' }))).text);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
  app.all('/mcp/:key', handler);
  app.all('/mcp', handler);
}

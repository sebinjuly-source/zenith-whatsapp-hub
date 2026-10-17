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

const fmtTime = (ts) =>
  ts
    ? new Date(ts * 1000).toLocaleString('en-GB', {
        timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).replace(',', '')
    : '-';
const trim = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
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

function buildServer() {
  const server = new McpServer({ name: 'zenith-whatsapp-hub', version: '0.1.0' });
  const tool = (name, description, inputSchema, fn) => server.registerTool(name, { description, inputSchema }, safe(fn));

  tool('list_accounts', 'List the WhatsApp numbers in the hub: id, purpose, phone, connection status, AI mode (approve/auto), and how much history is stored. Start here.', {}, async () => {
    const lines = [];
    await manager.refresh();
    for (const a of manager.list()) {
      const st = await store.accountStats(a.id);
      lines.push(
        `${a.id}${a.isDefault ? ' (default)' : ''} | ${a.label} | purpose: ${a.purpose || '-'} | +${a.phone || '?'} | ${a.status} | ai:${a.settings.aiMode} | ` +
          `${st.chats} chats (${st.groups} groups), ${st.contacts} contacts, ${st.messages} msgs since ${fmtTime(st.oldest_ts)} | sync:${a.sync?.state || '-'}`,
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
      active_since: z.string().optional().describe('Last message on/after this date (YYYY-MM-DD)'),
      inactive_since: z.string().optional().describe('Last message before this date (YYYY-MM-DD) — good for finding stale leads'),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async (a) => {
      const s = await manager.resolve(a.account);
      const rows = await store.listChats(s.id, {
        q: a.query, kind: a.kind === 'all' ? undefined : a.kind, tag: a.tag, waitingOnMe: a.waiting_on_me,
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
    },
    async (a) => {
      const s = await manager.resolve(a.account);
      const jid = await resolveChat(s.id, a.to);
      const attachment = a.attachment_url ? { url: a.attachment_url, fileName: a.file_name, as: a.send_as } : undefined;
      const row = await outbox.enqueue({ account: s.id, to: jid, payload: { text: a.text, attachment }, source: 'mcp', note: a.note, taskId: a.task_id });
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
    return `Draft #${r.id} approved and queued.`;
  });

  tool('reject_draft', 'Discard a draft or a queued message.', { id: z.number().int() }, async (a) => {
    await outbox.reject(a.id);
    return `#${a.id} rejected.`;
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
    await s.fetchOlder(jid, a.count || 50);
    return 'Requested. Call get_messages again in about a minute.';
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
      text: z.string().describe('Message, may contain {name} etc.'),
      recipients: z.array(z.object({ to: z.string(), name: z.string().optional() }).passthrough()).min(1),
      details: z.string().optional(),
      attachment_url: z.string().optional(),
      file_name: z.string().optional(),
      schedule_at: z.string().optional().describe('ISO datetime to start (default now)'),
      skip_if_contacted_days: z.number().int().min(0).optional().describe('Default 30; 0 = do not skip'),
    },
    async (a) => {
      const r = await outbox.bulkSend({
        account: a.account, title: a.title, details: a.details, text: a.text, recipients: a.recipients,
        attachment: a.attachment_url ? { url: a.attachment_url, fileName: a.file_name } : undefined,
        scheduledAt: a.schedule_at, source: 'mcp', createdBy: 'ai',
        skipIfContactedDays: a.skip_if_contacted_days ?? 30, allowRepeat: a.skip_if_contacted_days === 0,
      });
      const skipped = r.skipped.length ? `\nSkipped ${r.skipped.length}: ${r.skipped.slice(0, 30).map((x) => `${x.to} (${x.reason})`).join('; ')}` : '';
      if (!r.task) return `Nothing queued.${skipped}`;
      return `Task #${r.task.id}: ${r.queued} messages ${r.mode === 'approve' ? 'saved as drafts — waiting for the owner to approve on the board' : 'queued'}.${skipped}`;
    },
  );

  tool('approve_task', 'Approve all drafts of a task so they start sending. Only when the user has explicitly approved in this conversation.', { id: z.number().int() }, async (a) => {
    const r = await outbox.approveTask(a.id);
    return `Approved ${r.approved} messages of task #${a.id}.`;
  });

  return server;
}

export function mountMcp(app) {
  const handler = async (req, res) => {
    const key = req.params.key || req.get('x-api-key') || req.query.key;
    if (key !== config.apiKey) return res.status(401).json({ error: 'Unauthorized' });
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').json({ error: 'Method not allowed' });
    const server = buildServer();
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

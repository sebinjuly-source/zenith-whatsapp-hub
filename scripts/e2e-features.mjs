/**
 * Live test of templates, reply-to, reminders, find_person and rules between two linked numbers.
 * Cleans up its test template, rule, task and tags afterwards.
 * Usage: node scripts/e2e-features.mjs <senderAccount> <receiverAccount>
 */
import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import pg from 'pg';

const [A, B] = process.argv.slice(2);
const BASE = process.env.HUB_URL || 'https://zenith-whatsapp-hub.onrender.com';
const KEY = process.env.API_KEY;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = async (sql, p) => (await db.query(sql, p)).rows;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ test: name, result: ok ? 'PASS' : 'FAIL' });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};
const api = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180000) });
  const t = await r.text();
  try { return { status: r.status, data: JSON.parse(t) }; } catch { return { status: r.status, data: t }; }
};
const mcp = async (name, args) => {
  const r = await fetch(`${BASE}/mcp/${KEY}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return (await r.json()).result.content[0].text;
};
async function until(fn, ms = 120000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(2000);
  }
}
const [pa] = await q('SELECT phone FROM accounts WHERE id = $1', [A]);
const [pb] = await q('SELECT phone FROM accounts WHERE id = $1', [B]);
const jidA = `${pa.phone}@s.whatsapp.net`, jidB = `${pb.phone}@s.whatsapp.net`;
const stamp = new Date().toISOString().slice(11, 19);
console.log(`Features test ${A} → ${B} at ${stamp}\n`);

// 1. Template with fields, sent by A to B
const tpl = (await api('POST', '/api/templates', { account: A, name: `E2E template ${stamp}`, body: `[feature test ${stamp}] Hi {first_name}, this is a template for the {role} role.` })).data;
const r1 = await api('POST', '/api/send', { account: A, to: jidB, template: tpl.name, vars: { role: 'Front Office' } });
check('1. template sent with fields filled', r1.data.status === 'sent', r1.data.payload?.text);
const recv1 = await until(async () => (await q('SELECT id, body FROM messages WHERE account_id = $1 AND chat_jid = $2 AND id = $3', [B, jidA, r1.data.message_id]))[0]);
check('1b. received on the other number with the filled text', !!recv1 && /Hi \S+, this is a template for the Front Office role/.test(recv1.body), recv1?.body);

// 2. Reply-to: B replies quoting A's message
const r2 = await api('POST', '/api/send', { account: B, to: jidA, text: `[feature test ${stamp}] This reply quotes your template message ↪`, replyTo: recv1?.id });
check('2. reply sent', r2.data.status === 'sent');
const quoted = await until(async () => (await q('SELECT quoted_id, quoted_body FROM messages WHERE account_id = $1 AND chat_jid = $2 AND id = $3 AND quoted_id IS NOT NULL', [A, jidB, r2.data.message_id]))[0]);
check('2b. the receiver sees it as a reply to the right message', quoted?.quoted_id === r1.data.message_id, quoted ? `quotes: "${quoted.quoted_body?.slice(0, 50)}"` : 'no quote');

// 3. Reminder: B snoozes its chat with A; it leaves "open"; a message from A reopens it
const until1 = new Date(Date.now() + 2 * 86400000).toISOString();
await api('PATCH', `/api/accounts/${B}/chats/${jidA}/state`, { state: 'snoozed', until: until1, note: 'feature test reminder' });
const openList = (await api('GET', `/api/accounts/${B}/chats?state=open&limit=200`)).data;
check('3. reminder hides the chat from Open', !openList.some((c) => c.jid === jidA));
check('3b. it is listed under Reminders', (await api('GET', `/api/accounts/${B}/chats?state=snoozed`)).data.some((c) => c.jid === jidA));
await api('POST', '/api/send', { account: A, to: jidB, text: `[feature test ${stamp}] New message — should reopen the chat` });
const reopened = await until(async () => (await q(`SELECT state FROM chats WHERE account_id = $1 AND jid = $2 AND state = 'open'`, [B, jidA]))[0], 90000);
check('3c. a new message from them reopens the chat', !!reopened);

// 4. One person across numbers
const fp = await mcp('find_person', { query: pa.phone });
check('4. find_person finds the number across all numbers', fp.includes(`${B} (`), fp.split('\n')[0]);

// 5. Rule on B: a PDF whose name contains the stamp → tag, task, auto-reply (template)
const replyTpl = (await api('POST', '/api/templates', { account: B, name: `E2E auto-reply ${stamp}`, body: `[feature test ${stamp}] Auto-reply: thanks {first_name}, file received.` })).data;
const word = `e2e${stamp.replace(/:/g, '')}`;
const rule = (await api('POST', '/api/rules', { account: B, name: `E2E rule ${stamp}`, conditions: { chat: 'direct', types: ['document'], words: word }, actions: { addTags: 'rule-test', createTask: 'E2E rule task for {name}', replyTemplate: replyTpl.name } })).data;
check('5. rule saved', !!rule.id);
const pdf = fs.readFileSync(path.join(os.homedir(), 'Downloads', 'Zenith Suites Automation Map.pdf'));
const before = new Date().toISOString();
await api('POST', '/api/send', { account: A, to: jidB, attachment: { base64: pdf.toString('base64'), fileName: `${word}.pdf`, mimetype: 'application/pdf', caption: `[feature test ${stamp}] PDF that should trigger the rule` } });
const tagged = await until(async () => (await q(`SELECT tags FROM contacts WHERE account_id = $1 AND jid = $2 AND 'rule-test' = ANY(tags)`, [B, jidA]))[0]);
check('5b. rule tagged the sender', !!tagged);
const task = await until(async () => (await q(`SELECT id, title FROM tasks WHERE account_id = $1 AND created_by = 'rule' AND created_at > $2`, [B, before]))[0]);
check('5c. rule added a task to the board', !!task, task?.title);
const auto = await until(async () => (await q(`SELECT id, status FROM outbox WHERE account_id = $1 AND to_jid = $2 AND note = $3 AND status = 'sent'`, [B, jidA, `rule:${rule.id}`]))[0], 240000);
check('5d. rule auto-replied (after the random delay)', !!auto);
const gotAuto = auto
  ? await until(async () => (await q(`SELECT body FROM messages WHERE account_id = $1 AND chat_jid = $2 AND NOT from_me AND body LIKE $3`, [A, jidB, `%${stamp}] Auto-reply%`]))[0], 90000)
  : null;
check('5e. sender received the auto-reply', !!gotAuto, gotAuto?.body);

// cleanup
await api('DELETE', `/api/rules/${rule.id}`);
await api('DELETE', `/api/templates/${tpl.id}`);
await api('DELETE', `/api/templates/${replyTpl.id}`);
if (task) await api('POST', `/api/tasks/${task.id}/cancel`);
await api('PATCH', `/api/accounts/${B}/contacts/${jidA}`, { removeTags: ['rule-test'] });
console.log(`\n${results.filter((r) => r.result === 'PASS').length}/${results.length} passed (test template, rule, task and tag removed)`);
await db.end();

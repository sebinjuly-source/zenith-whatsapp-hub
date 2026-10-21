/**
 * Meta WhatsApp Cloud API numbers, end to end against a fake Graph API (no real Meta calls):
 * setup (register, subscribe, webhook), templates, the 24-hour rule, sending text/files/templates, incoming
 * webhooks (signature, duplicates, media), delivery statuses and failures, bulk sends, lists, follow-ups and MCP.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cloud-'));

// ---- Fake Meta Graph API -----------------------------------------------------------
const graphCalls = [];
let registered = false;
let appSubscribed = null;
let nextId = 0;
const templates = [
  { id: 't1', name: 'hello_world', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'HEADER', format: 'TEXT', text: 'Hello World' }, { type: 'BODY', text: 'Welcome and congratulations!!' }] },
  { id: 't2', name: 'candidate_invite', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Namaste {{1}}, Zenith Suites is hiring a {{2}}. Reply YES if interested.' }, { type: 'FOOTER', text: 'Zenith Suites HR' }] },
  { id: 't3', name: 'pending_one', language: 'en', status: 'PENDING', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hi' }] },
];
const fakeGraph = express();
fakeGraph.use(express.json());
fakeGraph.use((req, res, next) => {
  graphCalls.push({ method: req.method, path: req.path, query: req.query, body: req.body, auth: req.get('authorization') });
  next();
});
fakeGraph.get('/v24.0/111', (req, res) => res.json({
  display_phone_number: '+91 98801 39926', verified_name: 'Zenith Suites', quality_rating: 'GREEN', name_status: 'APPROVED',
  status: registered ? 'CONNECTED' : 'PENDING', platform_type: registered ? 'CLOUD_API' : 'NOT_APPLICABLE', messaging_limit_tier: 'TIER_250', id: '111',
  ...(String(req.query.fields).includes('health_status') ? { health_status: healthStatus } : {}),
}));
let healthStatus = { can_send_message: 'AVAILABLE', entities: [{ entity_type: 'PHONE_NUMBER', id: '111', can_send_message: 'AVAILABLE' }] };
fakeGraph.post('/v24.0/111/register', (req, res) => {
  if (req.body.pin !== '123456') return res.status(400).json({ error: { code: 133005, message: 'PIN mismatch' } });
  registered = true;
  res.json({ success: true });
});
fakeGraph.post('/v24.0/222/subscribed_apps', (req, res) => res.json({ success: true }));
fakeGraph.get('/v24.0/222/subscribed_apps', (req, res) => res.json({ data: [{ whatsapp_business_api_data: { id: '999', name: 'ZenithWAHub' } }] }));
fakeGraph.get('/v24.0/222/message_templates', (req, res) => res.json({ data: templates, paging: { cursors: {} } }));
fakeGraph.post('/v24.0/222/message_templates', (req, res) => {
  templates.push({ id: 'tnew', ...req.body, status: 'PENDING' });
  res.json({ id: 'tnew', status: 'PENDING', category: req.body.category });
});
fakeGraph.get('/v24.0/app', (req, res) => res.json({ id: '999' }));
fakeGraph.get('/v24.0/999/subscriptions', (req, res) => res.json({ data: appSubscribed ? [appSubscribed] : [] }));
fakeGraph.post('/v24.0/999/subscriptions', (req, res) => {
  appSubscribed = { object: req.query.object, callback_url: req.query.callback_url, active: true, fields: String(req.query.fields).split(',').map((name) => ({ name })) };
  res.json({ success: true });
});
fakeGraph.post('/v24.0/111/media', (req, res) => res.json({ id: 'UPLOADED1' }));
fakeGraph.post('/v24.0/111/messages', (req, res) => {
  const b = req.body;
  if (b.status === 'read') return res.json({ success: true });
  if (b.to === '910000000000') return res.status(400).json({ error: { code: 131026, message: 'Message undeliverable' } });
  res.json({ messaging_product: 'whatsapp', contacts: [{ input: b.to, wa_id: b.to }], messages: [{ id: `wamid.OUT${++nextId}` }] });
});
fakeGraph.get('/v24.0/MEDIA9', (req, res) => res.json({ url: `${graphUrl}/file/MEDIA9`, mime_type: 'image/jpeg' }));
fakeGraph.get('/file/MEDIA9', (req, res) => res.type('image/jpeg').send(Buffer.from('JPEGDATA')));
let graphServer;
let graphUrl;
await new Promise((r) => (graphServer = fakeGraph.listen(0, r)));
graphUrl = `http://127.0.0.1:${graphServer.address().port}`;

Object.assign(process.env, {
  LOCAL_DB_DIR: dir, DATABASE_URL: '', API_KEY: 'k', LOG_LEVEL: 'error', TIME_SCALE: '0.002', SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '',
  META_TOKEN: 'test-token', META_GRAPH_URL: graphUrl, META_PHONE_NUMBER_ID: '111', META_WABA_ID: '222', META_PIN: '123456',
  META_APP_SECRET: 'app-secret', META_VERIFY_TOKEN: 'verify-word', PUBLIC_URL: 'https://hub.example',
});

const { initDb, query, closeDb } = await import('../src/db.js');
const { manager } = await import('../src/wa/manager.js');
const { buildApp } = await import('../src/api.js');
const outbox = await import('../src/outbox.js');
const lists = await import('../src/lists.js');

let base;
let server;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(25);
  }
}
const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
};
const mcp = async (name, args = {}) => {
  const res = await fetch(`${base}/mcp/k`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await res.json()).result.content[0].text;
};
/** Deliver a webhook body like Meta does (signed with the app secret). */
const hook = async (value, field = 'messages') => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '222', changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '919880139926', phone_number_id: '111' }, ...value } }] }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(body).digest('hex');
  return fetch(`${base}/meta/webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
};
const now = () => Math.floor(Date.now() / 1000);
const sentMessages = () => graphCalls.filter((c) => c.method === 'POST' && c.path === '/v24.0/111/messages' && !c.body.status);

before(async () => {
  await initDb();
  await manager.init();
  await outbox.startOutbox();
  const app = buildApp();
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const s of manager.sessions.values()) await s.stop().catch(() => {});
  server?.close();
  graphServer?.close();
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('adding a Meta number registers it, subscribes the account and the webhook, and syncs templates', async () => {
  const r = await call('POST', '/api/accounts', { id: 'api', label: 'Zenith API', purpose: 'guests', provider: 'cloud' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const s = manager.get('api');
  await until(() => s.status === 'open');
  assert.ok(registered, 'registered with the PIN');
  assert.ok(graphCalls.some((c) => c.path === '/v24.0/222/subscribed_apps'), 'WhatsApp account subscribed to the app');
  assert.equal(appSubscribed?.callback_url, 'https://hub.example/meta/webhook');
  assert.ok(graphCalls.find((c) => c.path === '/v24.0/999/subscriptions' && c.method === 'POST').query.verify_token === 'verify-word');
  assert.equal(s.account.phone, '919880139926');
  assert.equal(graphCalls[0].auth, 'Bearer test-token');
  const t = await call('GET', '/api/accounts/api/wa-templates');
  assert.deepEqual(t.data.map((x) => x.name).sort(), ['candidate_invite', 'hello_world', 'pending_one']);
  assert.deepEqual(t.data.find((x) => x.name === 'candidate_invite').vars, ['1', '2']);
  // any outbox sends from here on: all day, no approval
  await call('PATCH', '/api/accounts/api', { settings: { sendStart: '00:00', sendEnd: '23:59', sendDays: [0, 1, 2, 3, 4, 5, 6], aiMode: 'auto' } });
  const st = await call('GET', '/api/meta/status');
  assert.equal(st.data.env.META_TOKEN, true);
  assert.ok(!JSON.stringify(st.data).includes('test-token'), 'status never shows secrets');
});

test('restarting the number does not register or subscribe again', async () => {
  const before = graphCalls.length;
  await call('POST', '/api/accounts/api/link');
  await until(() => manager.get('api').status === 'open');
  const again = graphCalls.slice(before);
  assert.ok(!again.some((c) => c.path.endsWith('/register')), 'no second registration');
  assert.ok(!again.some((c) => c.path === '/v24.0/999/subscriptions' && c.method === 'POST'), 'webhook already pointed at us');
});

test('free text to someone who never wrote is refused with the reason; a Meta template goes out', async () => {
  const r = await call('POST', '/api/send', { account: 'api', to: '9876500001', text: 'hello' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /first message must be an approved Meta template/);
  const t = await call('POST', '/api/send', { account: 'api', to: '9876500001', waTemplate: { name: 'candidate_invite', params: ['Ravi', 'Chef'] } });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  const m = sentMessages().at(-1).body;
  assert.equal(m.type, 'template');
  assert.equal(m.to, '919876500001');
  assert.deepEqual(m.template, { name: 'candidate_invite', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ravi' }, { type: 'text', text: 'Chef' }] }] });
  const [row] = await query(`SELECT body, from_me, status FROM messages WHERE account_id = 'api' AND chat_jid = '919876500001@s.whatsapp.net'`);
  assert.equal(row.body, 'Namaste Ravi, Zenith Suites is hiring a Chef. Reply YES if interested.\n\nZenith Suites HR', 'the chat shows what they received');
  assert.equal(row.from_me, true);
});

test('template mistakes are caught before sending: unknown, not approved, missing fill-in', async () => {
  const n = sentMessages().length;
  let r = await call('POST', '/api/send', { account: 'api', to: '9876500001', waTemplate: { name: 'nope' } });
  assert.match(r.data.error, /No Meta template called "nope"/);
  r = await call('POST', '/api/send', { account: 'api', to: '9876500001', waTemplate: { name: 'pending_one' } });
  assert.match(r.data.error, /pending, not approved/);
  r = await call('POST', '/api/send', { account: 'api', to: '9876500001', waTemplate: { name: 'candidate_invite', params: ['Ravi'] } });
  assert.match(r.data.error, /needs a value for \{\{2\}\}/);
  assert.equal(sentMessages().length, n, 'nothing reached Meta');
});

test('incoming webhook: signed message stored once (Meta re-deliveries ignored), name saved, reply window opens', async () => {
  const msg = { contacts: [{ profile: { name: 'Ravi Kumar' }, wa_id: '919876500001' }], messages: [{ from: '919876500001', id: 'wamid.IN1', timestamp: String(now()), type: 'text', text: { body: 'YES interested' } }] };
  let incoming = 0;
  const on = () => incoming++;
  manager.on('incoming', on);
  assert.equal((await hook(msg)).status, 200);
  assert.equal((await hook(msg)).status, 200); // Meta delivers the same webhook again
  manager.off('incoming', on);
  const rows = await query(`SELECT id, body, from_me FROM messages WHERE account_id = 'api' AND id = 'wamid.IN1'`);
  assert.equal(rows.length, 1);
  assert.equal(incoming, 1, 'rules/alerts ran once');
  const [c] = await query(`SELECT notify FROM contacts WHERE account_id = 'api' AND jid = '919876500001@s.whatsapp.net'`);
  assert.equal(c.notify, 'Ravi Kumar');
  const w = await call('GET', '/api/accounts/api/chats/919876500001@s.whatsapp.net/window');
  assert.equal(w.data.open, true);
  // bad signature → refused
  const res = await fetch(`${base}/meta/webhook`, { method: 'POST', body: JSON.stringify({ object: 'whatsapp_business_account', entry: [] }), headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' } });
  assert.equal(res.status, 401);
});

test('inside the window: free text and quoted replies go out; files are uploaded to Meta first', async () => {
  let r = await call('POST', '/api/send', { account: 'api', to: '9876500001', text: 'Great! When can you come? https://zenithsuites.in', replyTo: 'wamid.IN1' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let m = sentMessages().at(-1).body;
  assert.equal(m.type, 'text');
  assert.equal(m.text.preview_url, true);
  assert.deepEqual(m.context, { message_id: 'wamid.IN1' });
  r = await call('POST', '/api/send', { account: 'api', to: '9876500001', attachment: { base64: Buffer.from('%PDF-1.4 test').toString('base64'), fileName: 'job.pdf', mimetype: 'application/pdf', caption: 'Job details' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  m = sentMessages().at(-1).body;
  assert.equal(m.type, 'document');
  assert.deepEqual(m.document, { id: 'UPLOADED1', caption: 'Job details', filename: 'job.pdf' });
  assert.ok(graphCalls.some((c) => c.path === '/v24.0/111/media'));
});

test('delivery statuses: delivered/read update ticks; a failure marks the message failed with Meta\'s reason', async () => {
  const [last] = await query(`SELECT id FROM messages WHERE account_id = 'api' AND from_me ORDER BY ts DESC, id DESC LIMIT 1`);
  await hook({ statuses: [{ id: last.id, status: 'delivered', timestamp: String(now()), recipient_id: '919876500001' }] });
  await hook({ statuses: [{ id: last.id, status: 'read', timestamp: String(now()), recipient_id: '919876500001' }] });
  const [m] = await query(`SELECT status FROM messages WHERE account_id = 'api' AND id = $1`, [last.id]);
  assert.equal(m.status, 4);
  // failure reported later by Meta (e.g. not on WhatsApp)
  const t = await call('POST', '/api/send', { account: 'api', to: '9876500002', waTemplate: { name: 'hello_world' } });
  assert.equal(t.status, 200);
  await hook({ statuses: [{ id: t.data.message_id, status: 'failed', timestamp: String(now()), recipient_id: '919876500002', errors: [{ code: 131026, title: 'Message undeliverable' }] }] });
  const [o] = await query(`SELECT status, error FROM outbox WHERE id = $1`, [t.data.id]);
  assert.equal(o.status, 'failed');
  assert.match(o.error, /not on WhatsApp/);
});

test('a status that arrives before the send is recorded is applied a moment later', async () => {
  const s = manager.get('api');
  await s.onCloudStatus({ id: 'wamid.EARLY', status: 'delivered' });
  await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body, status) VALUES ('api', '919876500001@s.whatsapp.net', 'wamid.EARLY', true, $1, 'text', 'x', 1)`, [now()]);
  await until(async () => (await query(`SELECT status FROM messages WHERE account_id = 'api' AND id = 'wamid.EARLY'`))[0].status === 3);
});

test('Meta refusing a send (e.g. 131026) fails the message with a plain reason, never a crash', async () => {
  await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body) VALUES ('api', '910000000000@s.whatsapp.net', 'wamid.Z', false, $1, 'text', 'hi')`, [now()]);
  const r = await call('POST', '/api/send', { account: 'api', to: '910000000000', text: 'hello' });
  assert.equal(r.status, 502);
  assert.match(r.data.error, /not on WhatsApp/);
});

test('incoming files: stored with Meta\'s file id, downloadable from the dashboard', async () => {
  await hook({ contacts: [{ profile: { name: 'Ravi Kumar' }, wa_id: '919876500001' }], messages: [{ from: '919876500001', id: 'wamid.IMG', timestamp: String(now()), type: 'image', image: { id: 'MEDIA9', mime_type: 'image/jpeg', caption: 'my certificate' } }] });
  const [m] = await query(`SELECT type, body, media FROM messages WHERE account_id = 'api' AND id = 'wamid.IMG'`);
  assert.equal(m.type, 'image');
  assert.equal(m.body, 'my certificate');
  assert.equal(m.media.cloudId, 'MEDIA9');
  const res = await fetch(`${base}/api/media/api/919876500001@s.whatsapp.net/wamid.IMG`, { headers: { 'x-api-key': 'k' } });
  assert.equal(res.status, 200);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'JPEGDATA');
});

test('other incoming kinds: reaction, button, location, contacts, voice, unsupported', async () => {
  const ts = String(now());
  await hook({ messages: [
    { from: '919876500001', id: 'wamid.R', timestamp: ts, type: 'reaction', reaction: { message_id: 'wamid.IN1', emoji: '👍' } },
    { from: '919876500001', id: 'wamid.B', timestamp: ts, type: 'button', button: { text: 'Yes', payload: 'YES' } },
    { from: '919876500001', id: 'wamid.L', timestamp: ts, type: 'location', location: { latitude: 13.05, longitude: 77.59, name: 'Hebbal' } },
    { from: '919876500001', id: 'wamid.C', timestamp: ts, type: 'contacts', contacts: [{ name: { formatted_name: 'Sunil' }, phones: [{ phone: '+91 99000 11122', wa_id: '919900011122' }] }] },
    { from: '919876500001', id: 'wamid.V', timestamp: ts, type: 'audio', audio: { id: 'MEDIA9', mime_type: 'audio/ogg', voice: true } },
    { from: '919876500001', id: 'wamid.U', timestamp: ts, type: 'unsupported', errors: [{ code: 131051, title: 'Unsupported message type' }] },
  ] });
  const rows = Object.fromEntries((await query(`SELECT id, type, body, vcards FROM messages WHERE account_id = 'api' AND id IN ('wamid.R','wamid.B','wamid.L','wamid.C','wamid.V','wamid.U')`)).map((r) => [r.id, r]));
  assert.ok(!rows['wamid.R'], 'reactions are applied, not stored as messages');
  const [rx] = await query(`SELECT reactions FROM messages WHERE account_id = 'api' AND id = 'wamid.IN1'`);
  assert.ok(JSON.stringify(rx.reactions).includes('👍'));
  assert.equal(rows['wamid.B'].body, 'Yes');
  assert.match(rows['wamid.L'].body, /Hebbal \(13.05, 77.59\)/);
  assert.deepEqual(rows['wamid.C'].vcards[0].phones, ['919900011122']);
  assert.equal(rows['wamid.V'].type, 'voice');
  assert.match(rows['wamid.U'].body, /not supported/);
});

test('24 hours after their last message, free text is refused again', async () => {
  await query(`UPDATE messages SET ts = ts - 25 * 3600 WHERE account_id = 'api' AND chat_jid = '919876500003@s.whatsapp.net'`);
  await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body) VALUES ('api', '919876500003@s.whatsapp.net', 'wamid.OLD', false, $1, 'text', 'old')`, [now() - 25 * 3600]);
  const r = await call('POST', '/api/send', { account: 'api', to: '9876500003', text: 'hello again' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /24-hour reply window .* closed/);
});

test('bulk send on a Meta number needs a template; each person gets their own filled template; wording can\'t be edited', async () => {
  await call('PATCH', '/api/accounts/api', { settings: { aiMode: 'approve' } });
  let r = await call('POST', '/api/bulk', { account: 'api', title: 'Chefs', text: 'Hi {name}', recipients: [{ to: '9876500010', name: 'Anil' }] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /must use an approved Meta template/);
  r = await call('POST', '/api/bulk', { account: 'api', title: 'Chefs', waTemplate: { name: 'candidate_invite', params: ['{first_name}', '{role}'] }, recipients: [{ to: '9876500010', name: 'Anil Kumar', role: 'Chef' }, { to: '9876500011', name: 'Bala', role: 'Cook' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const drafts = await query(`SELECT id, payload FROM outbox WHERE account_id = 'api' AND task_id = $1 ORDER BY id`, [r.data.task.id]);
  assert.deepEqual(drafts.map((d) => d.payload.waTemplate.params), [['Anil', 'Chef'], ['Bala', 'Cook']]);
  assert.match(drafts[0].payload.text, /^Namaste Anil, Zenith Suites is hiring a Chef/);
  const e = await call('POST', `/api/outbox/${drafts[0].id}/approve`, { text: 'Changed wording' });
  assert.match(e.data.error, /wording is fixed by Meta/);
  const ok = await call('POST', `/api/outbox/${drafts[0].id}/approve`, {});
  assert.equal(ok.status, 200);
  await until(async () => (await query(`SELECT status FROM outbox WHERE id = $1`, [drafts[0].id]))[0].status === 'sent');
  assert.equal(sentMessages().at(-1).body.template.components[0].parameters[0].text, 'Anil');
  await call('POST', '/api/outbox/reject-selected', { ids: [drafts[1].id] });
  await call('PATCH', '/api/accounts/api', { settings: { aiMode: 'auto' } });
});

test('lists on a Meta number: first messages use the template; follow-ups use their template or are skipped with the reason', async () => {
  const imp = await call('POST', '/api/lists/import', { account: 'api', name: 'Chef batch API', role: 'Chef', members: [{ phone: '9876500020', name: 'Chandan', message: 'Hi Chandan' }] });
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  const id = imp.data.list.id;
  let r = await call('POST', `/api/lists/${id}/send`, {});
  assert.equal(r.status, 400);
  assert.match(r.data.error, /first messages must use an approved Meta template/);
  r = await call('POST', `/api/lists/${id}/send`, { waTemplate: { name: 'candidate_invite', params: ['{first_name}', 'Chef'] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.queued, 1);
  await until(async () => (await query(`SELECT status FROM outbox WHERE list_id = $1`, [id]))[0]?.status === 'sent');
  // two days, no reply → follow-up due; without a Meta template it can't go
  await query(`UPDATE messages SET ts = ts - 3 * 86400 WHERE account_id = 'api' AND chat_jid = '919876500020@s.whatsapp.net'`);
  await query(`UPDATE outbox SET sent_at = sent_at - interval '3 days' WHERE list_id = $1`, [id]);
  await call('PATCH', '/api/accounts/api', { settings: { followupStart: '00:00', followupDailyMax: 5 } });
  await call('PATCH', `/api/lists/${id}/followup`, { enabled: true, afterDays: 2, max: 1, text: 'Hi {first_name}, still interested?', quietDaysOnly: false, autoSend: true });
  await query(`UPDATE lists SET since = since - interval '4 days' WHERE id = $1`, [id]);
  await lists.runFollowups();
  assert.equal((await query(`SELECT count(*)::int n FROM outbox WHERE list_id = $1 AND note = 'follow-up'`, [id]))[0].n, 0);
  const [ev] = await query(`SELECT text FROM events WHERE account_id = 'api' AND text LIKE 'Follow-ups for "Chef batch API"%' ORDER BY id DESC LIMIT 1`);
  assert.match(ev.text, /no Meta template is set/);
  await call('PATCH', `/api/lists/${id}/followup`, { waTemplate: { name: 'candidate_invite', params: ['{first_name}', 'Chef'] } });
  await lists.runFollowups();
  const [f] = await query(`SELECT payload FROM outbox WHERE list_id = $1 AND note = 'follow-up'`, [id]);
  assert.equal(f.payload.waTemplate.params[0], 'Chandan');
});

test('AI tools: list_accounts says it is a Meta number; templates listed; free text outside the window is explained', async () => {
  const acc = await mcp('list_accounts');
  assert.match(acc, /META CLOUD API \(quality GREEN/);
  const t = await mcp('list_meta_templates', { account: 'api' });
  assert.match(t, /candidate_invite \| en \| APPROVED \| UTILITY \| \{\{1\}\} \{\{2\}\}/);
  const s = await mcp('send_message', { account: 'api', to: '9876500099', text: 'hi' });
  assert.match(s, /free text is not allowed. Use wa_template/);
  const ok = await mcp('send_message', { account: 'api', to: '9876500099', wa_template: { name: 'candidate_invite', params: ['{name}', 'Chef'] }, note: 'test' });
  assert.match(ok, /Meta template "candidate_invite"/);
});

test('linked-number behaviour is unchanged: a Meta template sent to a linked number needs its text', async () => {
  await call('POST', '/api/accounts', { id: 'phone', label: 'Phone' });
  const r = await call('POST', '/api/send', { account: 'phone', to: '9876500001', waTemplate: { name: 'candidate_invite' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /linked number/);
});

test('moving plain-text drafts to a Meta number: only people inside the 24 h window move', async () => {
  const [a] = await query(`INSERT INTO outbox (account_id, to_jid, payload, source, status) VALUES ('phone', '919876500077@s.whatsapp.net', '{"text":"hi"}', 'mcp', 'draft') RETURNING id`);
  const [b] = await query(`INSERT INTO outbox (account_id, to_jid, payload, source, status) VALUES ('phone', '919876500001@s.whatsapp.net', '{"text":"hi Ravi"}', 'mcp', 'draft') RETURNING id`);
  let r = await call('POST', '/api/outbox/move', { ids: [a.id], account: 'api' });
  assert.match(r.data.error, /None moved/);
  r = await call('POST', '/api/outbox/move', { ids: [a.id, b.id], account: 'api' });
  assert.equal(r.data.moved, 1, 'Ravi wrote recently, so his draft moves');
  assert.equal(r.data.kept, 1);
});

test('submitting a new Meta template: checked first, sent with examples and buttons, then listed as pending', async () => {
  let r = await call('POST', '/api/accounts/api/wa-templates', { name: 'Bad', body: '{{1}} come to Zenith', examples: ['Ravi'] });
  assert.match(r.data.error, /start or end with a fill-in/);
  r = await call('POST', '/api/accounts/api/wa-templates', { name: 'job_followup', body: 'Namaste {{1}} ji, the {{2}} job is open. – Zenith Suites HR', examples: ['Ravi'] });
  assert.match(r.data.error, /example value for each fill-in/);
  r = await call('POST', '/api/accounts/api/wa-templates', { name: 'Job Followup', category: 'marketing', body: 'Namaste {{1}} ji, the {{2}} job is open. – Zenith Suites HR', examples: ['Ravi', 'Chef'], buttons: ['Haan, interested', 'Nahi'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const sentT = graphCalls.filter((c) => c.method === 'POST' && c.path === '/v24.0/222/message_templates').at(-1).body;
  assert.equal(sentT.name, 'job_followup');
  assert.equal(sentT.category, 'MARKETING');
  assert.deepEqual(sentT.components[0].example, { body_text: [['Ravi', 'Chef']] });
  assert.deepEqual(sentT.components[1].buttons.map((b) => b.text), ['Haan, interested', 'Nahi']);
  const list = await call('GET', '/api/accounts/api/wa-templates');
  assert.equal(list.data.find((t) => t.name === 'job_followup').status, 'PENDING');
});

test('health check: Meta says LIMITED because of payment → shown plainly, with the reason and what still works', async () => {
  healthStatus = { can_send_message: 'LIMITED', entities: [
    { entity_type: 'PHONE_NUMBER', id: '111', can_send_message: 'AVAILABLE' },
    { entity_type: 'WABA', id: '222', can_send_message: 'LIMITED', errors: [{ error_code: 141006, error_description: 'There is an error with the payment method.', possible_solution: 'Add a valid payment method in WhatsApp Manager.' }] },
  ] };
  const r = await call('GET', '/api/accounts/api/meta-health');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'degraded');
  const can = r.data.checks.find((c) => c.name === 'Can send messages (Meta)');
  assert.match(can.detail, /WhatsApp account: limited — There is an error with the payment method.*replies within 24 h still work/);
  assert.ok(r.data.checks.find((c) => c.name === 'App webhook points to the hub').ok);
  assert.ok(r.data.checks.find((c) => c.name === 'Last event from Meta').ok);
  const acc = await mcp('list_accounts');
  assert.match(acc, /CAN SEND: LIMITED/);
  const ev = await query(`SELECT text FROM events WHERE account_id = 'api' AND text LIKE 'Meta says this number can send%' ORDER BY id DESC LIMIT 1`);
  assert.match(ev[0].text, /LIMITED/);
  healthStatus = { can_send_message: 'AVAILABLE', entities: [] };
  assert.match(await mcp('meta_health_check', { account: 'api' }), /^api: (HEALTHY|DEGRADED)/);
});

test('timeline: one message and one person, with Meta\'s billing category and failure reasons', async () => {
  await hook({ statuses: [{ id: 'wamid.T1', status: 'sent', timestamp: String(now()), recipient_id: '919876500055', pricing: { billable: true, category: 'marketing', pricing_model: 'PMP' } }] });
  await hook({ statuses: [{ id: 'wamid.T1', status: 'failed', timestamp: String(now()), recipient_id: '919876500055', errors: [{ code: 131049, title: 'held back' }] }] });
  const t = await mcp('message_timeline', { account: 'api', q: '9876500055' });
  assert.match(t, /status sent .*marketing \(billable\)/);
  assert.match(t, /status failed .*131049/);
  const byId = await call('GET', '/api/accounts/api/meta-timeline?q=wamid.T1');
  assert.equal(byId.data.events.length, 2);
  const health = await call('GET', '/api/accounts/api/meta-health');
  assert.match(health.data.checks.find((c) => c.name === 'Billable messages (14 days)').detail, /1 marketing/);
});

test('tap-to-reply buttons inside the window; WEBP image goes as a document; linked numbers list the answers', async () => {
  let r = await call('POST', '/api/send', { account: 'api', to: '9876500001', text: 'Kya aap Thursday aa sakte hain?', buttons: ['Haan, aaunga', 'Nahi'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let m = sentMessages().at(-1).body;
  assert.equal(m.type, 'interactive');
  assert.deepEqual(m.interactive.action.buttons.map((b) => b.reply.title), ['Haan, aaunga', 'Nahi']);
  // their tap comes back as a button reply
  await hook({ messages: [{ from: '919876500001', id: 'wamid.TAP', timestamp: String(now()), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Haan, aaunga' } } }] });
  const [tap] = await query(`SELECT body FROM messages WHERE account_id = 'api' AND id = 'wamid.TAP'`);
  assert.equal(tap.body, 'Haan, aaunga');
  r = await call('POST', '/api/send', { account: 'api', to: '9876500001', attachment: { base64: Buffer.from('RIFFxxxxWEBP').toString('base64'), fileName: 'dish.webp', mimetype: 'image/webp', as: 'image' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  m = sentMessages().at(-1).body;
  assert.equal(m.type, 'document');
  assert.equal(m.document.filename, 'dish.webp');
});

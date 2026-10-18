/**
 * End-to-end tests of the server (REST API, legacy /webhook, MCP, outbox rules, task board) against a
 * throwaway embedded database. WhatsApp itself is replaced by a fake session that records what it "sends".
 * Run: npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-srv-'));
Object.assign(process.env, { LOCAL_DB_DIR: dir, DATABASE_URL: '', API_KEY: 'k', LOG_LEVEL: 'error', TIME_SCALE: '0.002', SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '' });

const { initDb, query, closeDb } = await import('../src/db.js');
const { manager } = await import('../src/wa/manager.js');
const { buildApp } = await import('../src/api.js');
const outbox = await import('../src/outbox.js');
const { useDbAuthState } = await import('../src/wa/auth-state.js');

let base;
let server;
const sent = []; // what the fake WhatsApp "sent"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Turn a session into a fake connected one. */
function fake(id) {
  const s = manager.get(id);
  s.status = 'open';
  s.send = async (jid, content) => {
    sent.push({ account: id, jid, content });
    return { key: { id: `FAKE${sent.length}` }, message: {} };
  };
  return s;
}

const call = async (method, p, body, { key = 'k', raw = false } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
};

let mcpId = 0;
const mcp = async (name, args = {}) => {
  const res = await fetch(`${base}/mcp/k`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++mcpId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await res.json();
  return j.result.content[0].text;
};

/** Wait until fn() is truthy (polls). */
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(25);
  }
}

before(async () => {
  await initDb();
  await manager.init();
  await manager.create({ id: 'hotel', label: 'Hotel', purpose: 'guests' });
  await manager.create({ id: 'hiring', label: 'Hiring', purpose: 'candidates' });
  // Always inside the sending window for these tests.
  const allDay = { sendStart: '00:00', sendEnd: '23:59', sendDays: [0, 1, 2, 3, 4, 5, 6] };
  await manager.update('hotel', { settings: allDay });
  await manager.update('hiring', { settings: { ...allDay, aiMode: 'approve' } });
  fake('hotel');
  fake('hiring');
  await outbox.startOutbox();
  const app = buildApp();
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('auth: key required everywhere except /health', async () => {
  assert.equal((await call('GET', '/health', null, { key: null })).status, 200);
  assert.equal((await call('GET', '/api/accounts', null, { key: null })).status, 401);
  assert.equal((await call('GET', '/api/accounts', null, { key: 'wrong' })).status, 401);
  assert.equal((await call('GET', '/api/accounts?key=k', null, { key: null })).status, 200);
  assert.equal((await call('POST', '/webhook', { phone: '9876543210', message: 'x' }, { key: null, raw: true })).status, 401);
  const m = await fetch(`${base}/mcp/wrong`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(m.status, 401);
});

test('legacy /webhook (old form-bot body) sends from the default number and returns 200 Success', async () => {
  const before = sent.length;
  const r = await call('POST', '/webhook?key=k', { phone: '98765 43210', message: 'Hi Asha! 🦷 Thank you for enrolling' }, { key: null });
  assert.equal(r.status, 200);
  assert.equal(r.data, 'Success');
  const s = sent[before];
  assert.equal(s.account, 'hotel'); // first account = default
  assert.equal(s.jid, '919876543210@s.whatsapp.net'); // 10-digit number got 91
  assert.equal(s.content.text, 'Hi Asha! 🦷 Thank you for enrolling'); // emoji intact
});

test('legacy /webhook with imageUrl sends an image with caption; account can be chosen', async () => {
  const before = sent.length;
  const r = await call('POST', '/webhook?key=k', { phone: '919812345678', message: 'Your plan', imageUrl: `${base}/index.html`, account: 'hiring' }, { key: null });
  assert.equal(r.status, 200);
  const s = sent[before];
  assert.equal(s.account, 'hiring');
  assert.ok(Buffer.isBuffer(s.content.image));
  assert.equal(s.content.caption, 'Your plan');
});

test('/api/send with a base64 PDF sends a document with its file name', async () => {
  const before = sent.length;
  const pdf = Buffer.from('%PDF-1.4 test').toString('base64');
  const r = await call('POST', '/api/send', { account: 'hotel', to: '+91 99000 11122', text: 'Your voucher', attachment: { base64: pdf, fileName: 'Voucher_ZS101.pdf', mimetype: 'application/pdf' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'sent');
  const s = sent[before];
  assert.equal(s.content.fileName, 'Voucher_ZS101.pdf');
  assert.equal(s.content.mimetype, 'application/pdf');
  assert.equal(s.content.caption, 'Your voucher');
});

test('/api/send rejects empty messages and bad accounts', async () => {
  assert.equal((await call('POST', '/api/send', { to: '9876543210' })).status, 400);
  assert.equal((await call('POST', '/api/send', { account: 'nope', to: '9876543210', text: 'x' })).status, 400);
});

test('AI send in approve mode becomes a draft; approving sends it', async () => {
  const before = sent.length;
  const t = await mcp('send_message', { account: 'hiring', to: '919811111111', text: 'Hi, interested in the chef role?', note: 'test' });
  assert.match(t, /Draft #\d+/);
  await sleep(100);
  assert.equal(sent.length, before, 'draft must not be sent');
  const id = Number(t.match(/#(\d+)/)[1]);
  const r = await call('POST', `/api/outbox/${id}/approve`, { text: 'Hi Ravi, interested in the chef role?' });
  assert.equal(r.status, 200);
  await until(() => sent.length > before);
  assert.equal(sent[before].content.text, 'Hi Ravi, interested in the chef role?');
  // approving twice is refused
  assert.equal((await call('POST', `/api/outbox/${id}/approve`, {})).status, 400);
});

test('bulk_send: personalises, skips invalid/duplicate/opted-out/recently-contacted, waits for approval, then sends', async () => {
  await query(`INSERT INTO contacts (account_id, jid, phone, tags) VALUES ('hiring','919822222222@s.whatsapp.net','919822222222','{opted-out}')`);
  await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body) VALUES ('hiring','919833333333@s.whatsapp.net','OLD1',true, extract(epoch from now())::bigint - 3*86400, 'text','earlier msg')`);
  const before = sent.length;
  const txt = await mcp('bulk_send', {
    account: 'hiring',
    title: 'Chef candidates – test',
    text: 'Hi {name}, we have a {role} opening. Interested?',
    recipients: [
      { to: '9844444444', name: 'Ravi', role: 'Chef' },
      { to: '919844444444', name: 'Ravi again' }, // duplicate of the first
      { to: '12345', name: 'Bad' }, // invalid
      { to: '9822222222', name: 'Opted out' },
      { to: '9833333333', name: 'Messaged 3 days ago' },
      { to: '9855555555', role: 'Chef' }, // no name → "there"
    ],
  });
  assert.match(txt, /Task #\d+: 2 messages saved as drafts/);
  assert.match(txt, /Skipped 4/);
  assert.match(txt, /duplicate in list/);
  assert.match(txt, /invalid number/);
  assert.match(txt, /opted out/);
  assert.match(txt, /already messaged in the last 30 days/);
  const taskId = Number(txt.match(/Task #(\d+)/)[1]);
  const board = (await call('GET', '/api/tasks?account=hiring')).data;
  const card = board.find((t) => t.id === taskId);
  assert.equal(card.status, 'waiting');
  assert.equal(card.total, 2);
  assert.equal(card.drafts, 2);
  await sleep(100);
  assert.equal(sent.length, before);
  assert.equal((await call('POST', `/api/tasks/${taskId}/approve`)).data.approved, 2);
  await until(() => sent.length >= before + 2);
  const texts = sent.slice(before).map((s) => s.content.text).sort();
  assert.deepEqual(texts, ['Hi Ravi, we have a Chef opening. Interested?', 'Hi there, we have a Chef opening. Interested?']);
  await until(async () => (await call('GET', '/api/tasks?account=hiring&past=1')).data.some((t) => t.id === taskId && t.status === 'done'));
});

test('daily cap and sending window hold automated messages, but your own sends still go out', async () => {
  await manager.update('hotel', { settings: { aiMode: 'auto', dailyCap: 0 } });
  const before = sent.length;
  const txt = await mcp('bulk_send', { account: 'hotel', title: 'Capped', text: 'Hello {name}', recipients: [{ to: '9866666661', name: 'A' }], skip_if_contacted_days: 0 });
  assert.match(txt, /1 messages queued/);
  await sleep(200);
  assert.equal(sent.length, before, 'cap 0: automated message held');
  const r = await call('POST', '/api/send', { account: 'hotel', to: '9866666662', text: 'Your booking is confirmed' });
  assert.equal(r.data.status, 'sent', 'manual/API send is not capped');
  // Outside the sending window: still held even after raising the cap
  const now = new Date();
  const closedDay = (now.getDay() + 3) % 7;
  await manager.update('hotel', { settings: { dailyCap: 50, sendDays: [closedDay] } });
  await sleep(200);
  assert.equal(sent.filter((s) => s.jid === '919866666661@s.whatsapp.net').length, 0);
  // Open the window → it goes
  await manager.update('hotel', { settings: { sendDays: [0, 1, 2, 3, 4, 5, 6] } });
  outbox.enqueue({ account: 'hotel', to: '9866666663', payload: { text: 'nudge' }, source: 'api' }); // wakes the worker
  await until(() => sent.some((s) => s.jid === '919866666661@s.whatsapp.net'));
});

test('task board: create, move, cancel stops unsent messages', async () => {
  const t = (await call('POST', '/api/tasks', { account: 'hotel', title: 'Follow up interested guests', details: '10 people', dueAt: new Date(Date.now() + 86400000).toISOString() })).data;
  assert.equal(t.status, 'upcoming');
  const moved = (await call('PATCH', `/api/tasks/${t.id}`, { status: 'in_progress' })).data;
  assert.equal(moved.status, 'in_progress');
  assert.equal((await call('PATCH', `/api/tasks/${t.id}`, { status: 'bogus' })).status, 400);
  // a scheduled bulk send in the future sits in "upcoming"; cancelling rejects its messages
  const later = new Date(Date.now() + 3600000).toISOString();
  const r = (await call('POST', '/api/bulk', { account: 'hotel', title: 'Later', text: 'Hi {name}', recipients: [{ to: '9877777771', name: 'X' }, { to: '9877777772' }], scheduledAt: later, skipIfContactedDays: 0 })).data;
  assert.equal(r.queued, 2);
  let card = (await call('GET', '/api/tasks?account=hotel')).data.find((x) => x.id === r.task.id);
  assert.equal(card.status, 'upcoming');
  await call('POST', `/api/tasks/${r.task.id}/cancel`);
  const statuses = (await query('SELECT status FROM outbox WHERE task_id = $1', [r.task.id])).map((x) => x.status);
  assert.deepEqual(statuses, ['rejected', 'rejected']);
  card = (await call('GET', '/api/tasks?account=hotel&past=1')).data.find((x) => x.id === r.task.id);
  assert.equal(card.status, 'cancelled');
  assert.match(await mcp('list_tasks', { account: 'hotel' }), /Follow up interested guests/);
});

test('a send interrupted by a restart is marked failed, never re-sent blindly', async () => {
  const [row] = await query(
    `INSERT INTO outbox (account_id, to_jid, payload, source, status, sent_at) VALUES ('hotel','919888888888@s.whatsapp.net','{"text":"x"}','api','sending', now() - interval '10 minutes') RETURNING id`,
  );
  await outbox.sweepStuck();
  const [r] = await query('SELECT status, error FROM outbox WHERE id = $1', [row.id]);
  assert.equal(r.status, 'failed');
  assert.match(r.error, /check the chat/);
});

test('WhatsApp keys: kept in memory, saved in the background, discard drops pending writes', async () => {
  const a = await useDbAuthState('keys-test');
  a.state.keys.set({ session: { 'x.0': Buffer.from('abc') }, 'pre-key': { 1: { public: Buffer.from('p'), private: Buffer.from('q') } } });
  assert.equal(a.state.keys.get('session', ['x.0'])['x.0'].toString(), 'abc', 'readable immediately');
  await a.flush();
  const b = await useDbAuthState('keys-test');
  assert.equal(b.state.keys.get('session', ['x.0'])['x.0'].toString(), 'abc', 'persisted');
  b.state.keys.set({ session: { 'x.0': null } });
  await b.flush();
  const c = await useDbAuthState('keys-test');
  assert.equal(c.state.keys.get('session', ['x.0'])['x.0'], undefined, 'deleted');
  c.state.keys.set({ session: { 'y.0': Buffer.from('zzz') } });
  c.discard();
  await c.flush();
  const d = await useDbAuthState('keys-test');
  assert.equal(d.state.keys.get('session', ['y.0'])['y.0'], undefined, 'discarded write never reached the DB');
});

test('MCP: tool list and reading tools respond compactly', async () => {
  const res = await fetch(`${base}/mcp/k`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const names = (await res.json()).result.tools.map((t) => t.name);
  for (const n of ['list_accounts', 'list_chats', 'get_messages', 'search_messages', 'bulk_send', 'list_tasks', 'create_task', 'approve_task', 'find_followups']) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }
  assert.match(await mcp('list_accounts'), /hotel \(default\)/);
  assert.match(await mcp('get_messages', { account: 'hotel', chat: 'nobody here' }), /Error: No chat matches/);
});

test('live-connection jobs: queued when another server holds the number, run by the holder', async () => {
  const s = manager.get('hotel');
  const calls = [];
  s.fetchOlder = async (chat, count) => {
    calls.push([chat, count]);
    return 'REQ1';
  };
  s.status = 'elsewhere'; // pretend another server runs this number
  const txt = await mcp('fetch_older_messages', { account: 'hotel', chat: '919812345678', count: 30 });
  assert.match(txt, /Queued for the server connected/);
  assert.equal(calls.length, 0);
  s.status = 'open'; // now we hold it: the worker picks the job up
  await outbox.enqueue({ account: 'hotel', to: '9866666664', payload: { text: 'wake' }, source: 'api' });
  await until(() => calls.length === 1);
  assert.deepEqual(calls[0], ['919812345678@s.whatsapp.net', 30]);
  const [job] = await query(`SELECT status, result FROM jobs ORDER BY id DESC LIMIT 1`);
  assert.equal(job.status, 'done');
  assert.equal(job.result, 'REQ1');
  // when we hold the number it runs immediately
  assert.match(await mcp('fetch_older_messages', { account: 'hotel', chat: '919812345678' }), /Requested from the phone/);
});

test('MCP lists stay one line per item even for multi-line messages', async () => {
  await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body) VALUES ('hotel','919899999999@s.whatsapp.net','ML1',false, extract(epoch from now())::bigint, 'text', 'line one\nline two\n\nline three')`);
  await query(`INSERT INTO chats (account_id, jid, last_ts, last_preview, last_from_me) VALUES ('hotel','919899999999@s.whatsapp.net', extract(epoch from now())::bigint, 'line one\nline two\n\nline three', false) ON CONFLICT DO NOTHING`);
  const out = await mcp('list_chats', { account: 'hotel', query: '919899999999' });
  assert.equal(out.split('\n').length, 1);
  assert.match(out, /line one line two line three/);
});

test('deep history backfill: walks chats, pulls older messages until none are left, saves progress', async () => {
  await manager.create({ id: 'bf', label: 'Backfill test' });
  const bf = fake('bf');
  const now = Math.floor(Date.now() / 1000);
  for (const [jid, n] of [['919700000001@s.whatsapp.net', 2], ['919700000002@s.whatsapp.net', 0]]) {
    await query(`INSERT INTO chats (account_id, jid, last_ts) VALUES ('bf', $1, $2)`, [jid, now]);
    await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body) VALUES ('bf', $1, $2, false, $3, 'text', 'latest')`, [jid, `L-${jid}`, now]);
    bf[`older-${jid}`] = n; // how many older pages the "phone" has for this chat
  }
  const asked = [];
  bf.fetchOlderAndWait = async (jid) => {
    asked.push(jid);
    if (!bf[`older-${jid}`]) return 0;
    bf[`older-${jid}`]--;
    const [o] = await query(`SELECT min(ts) AS ts FROM messages WHERE account_id = 'bf' AND chat_jid = $1`, [jid]);
    await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body) VALUES ('bf', $1, $2, false, $3, 'text', 'older')`, [jid, `O${asked.length}`, o.ts - 1000]);
    return 1;
  };
  const r = await call('POST', '/api/accounts/bf/backfill', {});
  assert.equal(r.status, 200);
  assert.equal((await call('POST', '/api/accounts/bf/backfill', {})).status, 400, 'only one backfill at a time');
  await outbox.enqueue({ account: 'bf', to: '9866666665', payload: { text: 'wake' }, source: 'api' });
  const job = await until(async () => {
    const [j] = await query(`SELECT * FROM jobs WHERE id = $1 AND status = 'done'`, [r.data.jobId]);
    return j;
  }, 8000);
  assert.equal(job.payload.progress.added, 2);
  assert.equal(job.payload.progress.done, 2);
  assert.match(job.result, /2\/2 chats, \+2 older messages/);
  // chat 1 asked until empty (2 pages + 1 empty), chat 2 asked once
  assert.equal(asked.filter((j) => j.startsWith('919700000001')).length, 3);
  assert.equal(asked.filter((j) => j.startsWith('919700000002')).length, 1);
  assert.match(await mcp('list_accounts'), /deep history #\d+: done/);
});

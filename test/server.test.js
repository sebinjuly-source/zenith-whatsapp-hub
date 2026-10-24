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

test('approve all drafts at once: one number only, or every number', async () => {
  for (const to of ['919811110001', '919811110002']) await mcp('send_message', { account: 'hiring', to, text: 'Batch draft' });
  await mcp('send_message', { account: 'hotel', to: '919811110003', text: 'Hotel draft' });
  const drafts = async (acc) => (await query(`SELECT count(*)::int n FROM outbox WHERE status = 'draft' AND account_id = $1`, [acc]))[0].n;
  assert.ok((await drafts('hiring')) >= 2);
  const r = await call('POST', '/api/outbox/approve-all', { account: 'hiring' });
  assert.equal(r.status, 200);
  assert.ok(r.data.approved >= 2);
  assert.equal(await drafts('hiring'), 0);
  assert.equal(await drafts('hotel'), 1, 'other numbers keep their drafts');
  assert.match(await mcp('recent_activity', { account: 'hiring', who: 'script' }), /Approved all \d+ drafts/);
  assert.equal((await call('POST', '/api/outbox/approve-all', {})).data.approved, 1);
  assert.equal(await drafts('hotel'), 0);
  await until(async () => (await query(`SELECT count(*)::int n FROM outbox WHERE to_jid LIKE '91981111000%' AND status = 'sent'`))[0].n === 3, 15000);
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
  await manager.update('hotel', { settings: { dailyCap: 50, anytime: false, sendDays: [closedDay] } });
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

test('contacts: add and remove tags in one update', async () => {
  await query(`INSERT INTO contacts (account_id, jid, phone, tags) VALUES ('hotel','919711111111@s.whatsapp.net','919711111111','{opted-out,guest}')`);
  const r = await call('PATCH', '/api/accounts/hotel/contacts/919711111111@s.whatsapp.net', { addTags: ['staff'], removeTags: ['opted-out'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.tags, ['guest', 'staff']);
  assert.match(await mcp('update_contact', { account: 'hotel', chat: '919711111111', add_tags: ['vip'], remove_tags: ['guest'] }), /tags=staff,vip/);
});

test('your actions are recorded with who did them, and the AI can read them', async () => {
  await call('PATCH', '/api/accounts/hotel', { settings: { dailyCap: 25 } });
  await manager.update('hotel', { settings: { historyMode: 'recent' } }); // as if chosen in the link dialog
  await call('PATCH', '/api/accounts/hotel', { settings: { aiMode: 'approve' } });
  const out = await mcp('recent_activity', { account: 'hotel' });
  assert.match(out, /script \| hotel \| Changed settings — Daily limit: 50 → 25/);
  assert.match(out, /script \| hotel \| Changed settings — AI sending: auto → approve/);
  assert.match(out, /ai \| hotel \| /, 'AI actions from earlier tests are listed too');
  assert.doesNotMatch(out, /\| system \|/, 'system noise hidden by default');
  assert.match(await mcp('list_accounts'), /hotel \(default\).*history chosen at link: Recent history only/);
  const ev = (await call('GET', '/api/events?actor=script&account=hotel')).data;
  assert.ok(ev.length >= 2 && ev.every((e) => e.actor === 'script'), 'API-key changes are logged as script');
  // the dashboard (login cookie, no key) is logged as you
  const login = await fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'k' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  await fetch(base + '/api/accounts/hotel', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ settings: { dailyCap: 26 } }) });
  assert.match(await mcp('recent_activity', { account: 'hotel', who: 'you' }), /owner \| hotel \| Changed settings — Daily limit: 25 → 26/);
});

test('incoming messages show the saved contact name, not just the WhatsApp profile name', async () => {
  await query(`INSERT INTO contacts (account_id, jid, phone, name, notify) VALUES ('hotel','919722222222@s.whatsapp.net','919722222222','Seema Madam','Zenith Suites')`);
  await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, sender_jid, sender_name, ts, type, body) VALUES ('hotel','919722222222@s.whatsapp.net','SN1',false,'919722222222@s.whatsapp.net','Zenith Suites', extract(epoch from now())::bigint, 'text','hello')`);
  assert.match(await mcp('get_messages', { account: 'hotel', chat: '919722222222' }), /Seema Madam: hello/);
});

test('typing indicator only for AI/bulk messages, not your own sends', async () => {
  const s = manager.get('hotel');
  const opts = [];
  const orig = s.send;
  s.send = async (jid, content, o) => {
    opts.push(o.typingMs);
    return orig(jid, content, o);
  };
  await manager.update('hotel', { settings: { typing: true } });
  const r = await call('POST', '/api/send', { account: 'hotel', to: '9733333333', text: 'reminder' });
  assert.equal(r.data.status, 'sent');
  assert.equal(opts.at(-1), 0);
  s.send = orig;
});

test('dashboard page carries a version so open tabs reload after a deploy', async () => {
  const html = await (await fetch(base + '/')).text();
  const health = await (await fetch(base + '/health')).json();
  assert.ok(health.version);
  assert.ok(html.includes('app.js?v=' + health.version), 'script URL carries the version');
  assert.ok(html.includes("window.HUB_VERSION = '" + health.version + "'"), 'page knows its version');
  assert.equal((await fetch(base + '/app.js')).status, 200);
});

test('a delivery WhatsApp reports as failed shows as failed (not stuck on "sent")', async () => {
  const r = await call('POST', '/api/send', { account: 'hotel', to: '9744444444', text: 'will fail' });
  assert.equal(r.data.status, 'sent');
  const s = manager.get('hotel');
  await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body, status) VALUES ('hotel','919744444444@s.whatsapp.net',$1,true,extract(epoch from now())::bigint,'text','will fail',2)`, [r.data.message_id]);
  await s.onMessagesUpdate([{ key: { id: r.data.message_id, remoteJid: '919744444444@s.whatsapp.net' }, update: { status: 0 } }]);
  const [o] = await query('SELECT status, error FROM outbox WHERE id = $1', [r.data.id]);
  assert.equal(o.status, 'failed');
  assert.match(o.error, /not delivered/);
  const [m] = await query('SELECT status FROM messages WHERE account_id = $1 AND id = $2', ['hotel', r.data.message_id]);
  assert.equal(m.status, 0);
});

test('sending from a number that cannot send fails at once with a clear reason', async () => {
  await manager.create({ id: 'ghost', label: 'Ghost' }); // never linked
  let r = await call('POST', '/api/send', { account: 'ghost', to: '9755555555', text: 'x' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /not linked yet/);
  const g = fake('ghost');
  g.status = 'logged_out';
  r = await call('POST', '/api/send', { account: 'ghost', to: '9755555555', text: 'x' });
  assert.match(r.data.error, /logged out of WhatsApp/);
  await manager.update('ghost', { enabled: false });
  g.status = 'open'; // keep the fake "open" to prove the paused check on its own
  r = await call('POST', '/api/send', { account: 'ghost', to: '9755555555', text: 'x' });
  assert.match(r.data.error, /paused/);
  const w = await call('POST', '/webhook?key=k', { phone: '9755555555', message: 'x', account: 'ghost' }, { key: null });
  assert.equal(w.status, 400, 'old /webhook format gets a fast error too');
});

test('idempotency: the same key never sends twice (send, old /webhook, bulk)', async () => {
  const before = sent.length;
  const a = await call('POST', '/api/send', { account: 'hotel', to: '9766666666', text: 'once', idempotencyKey: 'row-17-2026-10-19' });
  const b = await call('POST', '/api/send', { account: 'hotel', to: '9766666666', text: 'once', idempotencyKey: 'row-17-2026-10-19' });
  assert.equal(a.data.status, 'sent');
  assert.equal(b.status, 200);
  assert.equal(b.data.id, a.data.id);
  assert.equal(sent.length, before + 1, 'sent exactly once');
  const hdr = { 'content-type': 'application/json', 'idempotency-key': 'adhp-42' };
  const w1 = await fetch(`${base}/webhook?key=k`, { method: 'POST', headers: hdr, body: JSON.stringify({ phone: '9766666667', message: 'reminder' }) });
  const w2 = await fetch(`${base}/webhook?key=k`, { method: 'POST', headers: hdr, body: JSON.stringify({ phone: '9766666667', message: 'reminder' }) });
  assert.equal(await w1.text(), 'Success');
  assert.equal(await w2.text(), 'Success');
  assert.equal(sent.filter((x) => x.jid === '919766666667@s.whatsapp.net').length, 1);
  const args = { account: 'hotel', title: 'Idem bulk', text: 'Hi {name}', recipients: [{ to: '9766666668', name: 'A' }], skip_if_contacted_days: 0, idempotency_key: 'sheet-chefs-19oct' };
  assert.match(await mcp('bulk_send', args), /Task #\d+/);
  assert.match(await mcp('bulk_send', args), /Already created earlier as task #/);
});

test('outgoing notifications are signed, retried, and skipped for blocked contacts', async () => {
  const http = await import('http');
  const crypto = await import('crypto');
  const got = [];
  let failFirst = true;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (failFirst) {
        failFirst = false;
        res.writeHead(500).end();
        return;
      }
      got.push({ body, ts: req.headers['x-hub-timestamp'], sig: req.headers['x-hub-signature'] });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((r) => srv.listen(0, r));
  const { postWebhook } = await import('../src/notify.js');
  const status = await postWebhook(`http://127.0.0.1:${srv.address().port}/hook`, { event: 'message', text: 'hi' }, { attempts: 2 });
  assert.equal(status, 200, 'succeeded on the retry');
  const expect = 'sha256=' + crypto.createHmac('sha256', 'k').update(`${got[0].ts}.${got[0].body}`).digest('hex');
  assert.equal(got[0].sig, expect, 'signature verifies with the API key');
  await query(`INSERT INTO contacts (account_id, jid, phone, is_blocked) VALUES ('hotel','919777777777@s.whatsapp.net','919777777777',true)`);
  await manager.get('hotel').afterIncoming({ chatJid: '919777777777@s.whatsapp.net', body: 'STOP', type: 'text' });
  const [c] = await query(`SELECT tags FROM contacts WHERE account_id = 'hotel' AND jid = '919777777777@s.whatsapp.net'`);
  assert.ok(!c.tags.includes('opted-out'), 'blocked contacts trigger nothing');
  srv.close();
});

test('alerts: owner gets a WhatsApp from another number when one is logged out', async () => {
  const { startAlerts } = await import('../src/notify.js');
  const { EventEmitter } = await import('events');
  const fakeMgr = new EventEmitter();
  const list = [
    { id: 'n1', label: 'Hiring', phone: '919300000001', status: 'open', enabled: true },
    { id: 'n2', label: 'Hotel', phone: '919300000002', status: 'open', enabled: true },
  ];
  fakeMgr.list = () => list;
  const alerts = [];
  process.env.ALERT_PHONE = '919999999999';
  startAlerts(fakeMgr, async (from, to, text) => alerts.push({ from, to, text }));
  list[0].status = 'logged_out';
  fakeMgr.emit('change', { id: 'n1', status: 'logged_out' });
  await sleep(50);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].from, 'n2', 'sent from the other connected number');
  assert.equal(alerts[0].to, '919999999999');
  assert.match(alerts[0].text, /Hiring.*logged out/);
  fakeMgr.emit('change', { id: 'n1', status: 'logged_out' });
  await sleep(50);
  assert.equal(alerts.length, 1, 'not repeated within 6 hours');
  delete process.env.ALERT_PHONE;
});

test('templates: save, fill {first_name}/{role}, warn about missing fields, use in bulk send', async () => {
  const t = (await call('POST', '/api/templates', { name: 'Chef invite', body: 'Hi {first_name}, we have a {role} opening. Interested?' })).data;
  assert.ok(t.id);
  await query(`INSERT INTO contacts (account_id, jid, phone, name) VALUES ('hotel','919788888881@s.whatsapp.net','919788888881','Ravi Kumar') ON CONFLICT DO NOTHING`);
  const missing = await mcp('send_message', { account: 'hotel', to: '919788888881', template: 'Chef invite' });
  assert.match(missing, /needs values for: role/);
  await manager.update('hotel', { settings: { aiMode: 'auto' } });
  const before = sent.length;
  const ok = await mcp('send_message', { account: 'hotel', to: '919788888881', template: 'chef invite', vars: { role: 'Chef' } });
  assert.match(ok, /Queued/);
  await until(() => sent.length > before);
  assert.equal(sent.at(-1).content.text, 'Hi Ravi, we have a Chef opening. Interested?');
  const r = (await call('POST', '/api/bulk', { account: 'hotel', title: 'Tpl bulk', template: 'Chef invite', recipients: [{ to: '9788888882', name: 'Anita Rao', role: 'Sous chef' }], skipIfContactedDays: 0 })).data;
  assert.equal(r.queued, 1);
  await until(() => sent.some((s) => s.content.text === 'Hi Anita, we have a Sous chef opening. Interested?'));
  assert.match(await mcp('list_templates', {}), /Chef invite .*fields: first_name,role/);
  await manager.update('hotel', { settings: { aiMode: 'approve' } });
});

test('reply-to: the quoted message is passed to WhatsApp', async () => {
  const s = manager.get('hotel');
  const seen = [];
  const orig = s.send;
  s.send = async (jid, content, o) => {
    seen.push(o);
    return orig(jid, content, o);
  };
  await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body) VALUES ('hotel','919788888883@s.whatsapp.net','Q1',false,extract(epoch from now())::bigint,'text','Is the room available on Friday?')`);
  const r = await call('POST', '/api/send', { account: 'hotel', to: '919788888883', text: 'Yes, it is!', replyTo: 'Q1' });
  assert.equal(r.data.status, 'sent');
  const q = seen.at(-1).quoted;
  assert.equal(q.key.id, 'Q1');
  assert.equal(q.key.fromMe, false);
  assert.equal(q.message.conversation, 'Is the room available on Friday?');
  s.send = orig;
});

test('chat states: remind me (snooze) hides a chat until its date, done, and an incoming message reopens it', async () => {
  const jid = '919788888884@s.whatsapp.net';
  await query(`INSERT INTO chats (account_id, jid, last_ts, last_preview, last_from_me) VALUES ('hotel',$1,extract(epoch from now())::bigint,'hi',false)`, [jid]);
  const later = new Date(Date.now() + 3 * 86400000).toISOString();
  await call('PATCH', `/api/accounts/hotel/chats/${jid}/state`, { state: 'snoozed', until: later, note: 'ask about trial day' });
  const open = (await call('GET', '/api/accounts/hotel/chats?state=open&limit=200')).data;
  assert.ok(!open.some((c) => c.jid === jid), 'snoozed chat is not in the open list');
  assert.ok((await call('GET', '/api/accounts/hotel/chats?state=snoozed')).data.some((c) => c.jid === jid));
  // date reached → back in open, flagged due, on top
  await query(`UPDATE chats SET snoozed_until = now() - interval '1 minute' WHERE account_id = 'hotel' AND jid = $1`, [jid]);
  const open2 = (await call('GET', '/api/accounts/hotel/chats?state=open&limit=200')).data;
  assert.equal(open2[0].jid, jid, 'due reminder is listed first');
  assert.equal(open2[0].due, true);
  assert.match(await mcp('list_chats', { account: 'hotel', state: 'due' }), /REMINDER DUE: ask about trial day/);
  // done, then they write again → open
  assert.match(await mcp('set_chat_state', { account: 'hotel', chat: '919788888884', state: 'done' }), /marked done/);
  await manager.get('hotel').afterIncoming({ chatJid: jid, body: 'hello again', type: 'text', id: 'X9' });
  const [c] = await query(`SELECT state FROM chats WHERE account_id = 'hotel' AND jid = $1`, [jid]);
  assert.equal(c.state, 'open');
  assert.match(await mcp('set_chat_state', { account: 'hotel', chat: '919788888884', state: 'snoozed', in_days: 2, note: 'follow up' }), /Reminder set/);
});

test('one person across numbers: find_person shows each number separately', async () => {
  const jid = '919788888885@s.whatsapp.net';
  await query(`INSERT INTO contacts (account_id, jid, phone, name, tags) VALUES ('hotel',$1,'919788888885','Meena','{guest}'), ('hiring',$1,'919788888885','Meena R','{candidate}')`, [jid]);
  await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body) VALUES ('hotel',$1,'P1',false,1760000000,'text','room?'), ('hiring',$1,'P2',false,1760001000,'text','job?')`, [jid]);
  const out = await mcp('find_person', { query: '9788888885' });
  assert.match(out, /hotel \(Hotel\).*Meena.*tags:guest/);
  assert.match(out, /hiring \(Hiring\).*Meena R.*tags:candidate/);
  assert.equal((await call('GET', '/api/people?q=Meena')).data.length, 2);
});

test('rules: a PDF from someone new on the hiring number gets tagged, saved, a task and one auto-reply', async () => {
  await call('POST', '/api/templates', { account: 'hiring', name: 'Resume received', body: 'Thanks {first_name}, we got your resume and will get back to you.' });
  const rule = (await call('POST', '/api/rules', {
    account: 'hiring', name: 'Resumes',
    conditions: { chat: 'direct', types: ['document'], sender: 'new' },
    actions: { addTags: 'candidate', leadStatus: 'new', saveMedia: true, createTask: 'Review resume from {name}', replyTemplate: 'Resume received' },
  })).data;
  assert.ok(rule.id);
  const h = manager.get('hiring');
  const saved = [];
  h.saveMedia = async (chat, id) => saved.push(id);
  const jid = '919788888886@s.whatsapp.net';
  await query(`INSERT INTO contacts (account_id, jid, phone, notify) VALUES ('hiring',$1,'919788888886','Suresh Babu')`, [jid]);
  const before = sent.length;
  const msg = { chatJid: jid, senderJid: jid, id: 'DOC1', type: 'document', body: 'resume.pdf', media: { fileName: 'resume.pdf' } };
  await h.afterIncoming(msg);
  const [c] = await query(`SELECT tags, lead_status FROM contacts WHERE account_id = 'hiring' AND jid = $1`, [jid]);
  assert.deepEqual(c.tags, ['candidate']);
  assert.equal(c.lead_status, 'new');
  assert.deepEqual(saved, ['DOC1']);
  const tasksNow = (await call('GET', '/api/tasks?account=hiring')).data;
  assert.ok(tasksNow.some((t) => t.title === 'Review resume from Suresh Babu' && t.created_by === 'rule'));
  await until(() => sent.length > before);
  assert.equal(sent.at(-1).content.text, 'Thanks Suresh, we got your resume and will get back to you.');
  // second PDF the same day: no second auto-reply (and a text message doesn't match at all)
  await h.afterIncoming({ ...msg, id: 'DOC2' });
  await h.afterIncoming({ chatJid: jid, senderJid: jid, id: 'TXT1', type: 'text', body: 'hello' });
  await sleep(200);
  assert.equal(sent.filter((s) => s.jid === jid).length, 1, 'auto-reply once per person per day');
  assert.match(await mcp('list_rules', { account: 'hiring' }), /Resumes .*ran 2x/);
  assert.match(await mcp('recent_activity', { account: 'hiring', who: 'system' }), /Rule "Resumes" on 919788888886: tagged candidate/);
});

test('lists: import, status from real messages, send to new+failed only, follow-ups, outcomes, export', async () => {
  const listsMod = await import('../src/lists.js');
  const now = Math.floor(Date.now() / 1000);
  const P = (n) => `91970000000${n}@s.whatsapp.net`;
  // history in WhatsApp: #1 messaged 3 days ago, no reply; #2 messaged + replied; #3 messaged long BEFORE the list started (doesn't count)
  await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body) VALUES
    ('hiring',$1,'L1',true,$4,'text','job offer'),
    ('hiring',$2,'L2',true,$4,'text','job offer'), ('hiring',$2,'L2r',false,$4 + 600,'text','Yes interested, location?'),
    ('hiring',$3,'L3',true,$5,'text','old batch message')`,
  [P(1), P(2), P(3), now - 3 * 86400, now - 90 * 86400]);
  const since = new Date((now - 10 * 86400) * 1000).toISOString();
  const imp = await mcp('import_list', {
    account: 'hiring', name: 'Chef Batch T', since,
    members: [
      { phone: '9700000001', name: 'Suresh Kumar', message: 'Namaste Suresh ji,%0AChef chahiye.%0AInterested?' },
      { phone: '9700000002', name: 'Vinay', message: 'Namaste Vinay ji' },
      { phone: '9700000003', name: 'Old Contact', message: 'Namaste Old ji' },
      { phone: '9700000004', name: 'Never Sent', message: 'Namaste Never ji,%0Aline two' },
      { phone: '123', name: 'Bad phone' },
    ],
  });
  assert.match(imp, /4 new, 0 already on this list/);
  assert.match(imp, /Bad phone — invalid phone/);
  const l = await listsMod.getList('Chef Batch T');
  let rows = await listsMod.listMembers(l.id);
  const st = Object.fromEntries(rows.map((r) => [r.phone, r.status]));
  assert.deepEqual(st, { '919700000001': 'sent', '919700000002': 'replied', '919700000003': 'new', '919700000004': 'new' });
  assert.equal(rows.find((r) => r.phone === '919700000004').message, 'Namaste Never ji,\nline two', '%0A decoded to a line break');
  assert.match(await mcp('list_lists', { account: 'hiring' }), /Chef Batch T .*4 people: 2 new, 0 queued, 1 sent\/no reply, 1 replied/);
  assert.match(await mcp('list_members', { list: 'Chef Batch T', status: 'replied' }), /919700000002 \| Vinay \| replied .*"Yes interested, location\?"/);

  // send to new + failed → only #3 and #4, each with their own message; hiring is in approve mode → drafts
  const s = await mcp('send_to_list', { list: 'Chef Batch T' });
  assert.match(s, /2 messages saved as drafts/);
  const drafts = await query(`SELECT to_jid, payload FROM outbox WHERE list_id = $1 ORDER BY to_jid`, [l.id]);
  assert.deepEqual(drafts.map((d) => d.to_jid), [P(3), P(4)]);
  assert.equal(drafts[1].payload.text, 'Namaste Never ji,\nline two');
  await listsMod.refreshList(l.id);
  assert.equal((await listsMod.listMembers(l.id, { status: 'queued' })).length, 2);
  // approve → sent → statuses become "sent" (message recorded like a real send)
  const before = sent.length;
  const taskId = (await query(`SELECT task_id FROM outbox WHERE list_id = $1 LIMIT 1`, [l.id]))[0].task_id;
  await call('POST', `/api/tasks/${taskId}/approve`);
  await until(() => sent.length >= before + 2, 8000);
  for (const x of sent.slice(before)) {
    await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body) VALUES ('hiring',$1,$2,true,extract(epoch from now())::bigint,'text','sent')`, [x.jid, 'S' + Math.random()]);
  }
  await listsMod.refreshList(l.id);
  assert.equal((await listsMod.listMembers(l.id, { status: 'sent' })).length, 3);

  // a failed send shows as failed with the reason
  await query(`INSERT INTO list_members (list_id, jid, phone, name, message) VALUES ($1,$2,'919700000005','Fail Case','hi')`, [l.id, P(5)]);
  await query(`INSERT INTO outbox (account_id, to_jid, payload, source, status, error, list_id) VALUES ('hiring',$1,'{"text":"hi"}','campaign','failed','919700000005 is not on WhatsApp',$2)`, [P(5), l.id]);
  await listsMod.refreshList(l.id);
  const f5 = (await listsMod.listMembers(l.id, { status: 'failed' }))[0];
  assert.equal(f5.phone, '919700000005');
  assert.match(f5.error, /not on WhatsApp/);

  // follow-ups: only #1 qualifies (messaged 3 days ago, no reply); #2 replied; #3/#4 just messaged
  assert.match(await mcp('set_followup', { list: 'Chef Batch T', enabled: true, after_days: 2, max: 1, text: 'Namaste {first_name} ji, kya aap interested hain?', quiet_days_only: false }), /on — after 2 day/);
  await manager.update('hiring', { settings: { followupStart: '00:00' } }); // test runs at any time of day
  await listsMod.runFollowups();
  const fu = await query(`SELECT to_jid, payload, status FROM outbox WHERE list_id = $1 AND note = 'follow-up'`, [l.id]);
  assert.deepEqual(fu.map((x) => x.to_jid), [P(1)]);
  assert.equal(fu[0].payload.text, 'Namaste Suresh ji, kya aap interested hain?');
  assert.equal(fu[0].payload.replyTo, 'L1', 'quotes our original message');
  assert.equal(fu[0].status, 'draft', 'approve mode: follow-ups wait for approval');
  await listsMod.runFollowups();
  assert.equal((await query(`SELECT count(*)::int n FROM outbox WHERE list_id = $1 AND note = 'follow-up'`, [l.id]))[0].n, 1, 'not drafted twice while pending');
  // once sent, max=1 stops further follow-ups even after more silent days
  await query(`UPDATE outbox SET status = 'sent' WHERE list_id = $1 AND note = 'follow-up'`, [l.id]);
  await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body) VALUES ('hiring',$1,'FU1',true,$2,'text','follow-up')`, [P(1), now - 3 * 86400 + 60]);
  await listsMod.runFollowups();
  assert.equal((await query(`SELECT count(*)::int n FROM outbox WHERE list_id = $1 AND note = 'follow-up'`, [l.id]))[0].n, 1);

  // outcome + export for the sheet
  assert.match(await mcp('update_list_member', { list: 'Chef Batch T', phone: '9700000002', outcome: 'wants-travel-allowance', notes: 'Lives far; asked for fuel help' }), /Vinay: outcome wants-travel-allowance/);
  const exp = (await call('GET', `/api/lists/${l.id}/export`)).data;
  const v = exp.find((r) => r.phone === '919700000002');
  assert.equal(v.status, 'replied');
  assert.equal(v.outcome, 'wants-travel-allowance');
  assert.equal(v.last_reply_text, 'Yes interested, location?');
});

test('priorities: rejected people are never messaged; follow-ups wait for days without new outreach', async () => {
  const listsMod = await import('../src/lists.js');
  const outboxMod = await import('../src/outbox.js');
  await manager.create({ id: 'hire2', label: 'Hire2' });
  fake('hire2');
  const now = Math.floor(Date.now() / 1000);
  const J = (n) => `91960000000${n}@s.whatsapp.net`;
  // #1 and #2 messaged 4 days ago, silent; #3 never messaged
  await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body) VALUES ('hire2',$1,'H1',true,$3,'text','offer'), ('hire2',$2,'H2',true,$3,'text','offer')`, [J(1), J(2), now - 4 * 86400]);
  await mcp('import_list', { account: 'hire2', name: 'Prio', since: new Date((now - 10 * 86400) * 1000).toISOString(),
    members: [{ phone: '9600000001', name: 'Silent One', message: 'hi' }, { phone: '9600000002', name: 'Asked Money', message: 'hi' }, { phone: '9600000003', name: 'New Guy', message: 'Namaste New ji' }] });
  // owner rule: asked for money before joining → rejected → never messaged again
  await mcp('update_list_member', { list: 'Prio', phone: '9600000002', outcome: 'rejected – asked for money before joining' });
  await mcp('set_followup', { list: 'Prio', enabled: true, after_days: 2, max: 1, text: 'follow up {first_name}' });
  await manager.update('hire2', { settings: { followupStart: '00:00' } }); // test runs at any time of day
  const l = await listsMod.getList('Prio');

  // a first message to a new person is waiting → no follow-ups today
  const s = await mcp('send_to_list', { list: 'Prio' });
  assert.match(s, /1 messages saved as drafts/, 'only New Guy is new');
  assert.equal(await outboxMod.newOutreachToday('hire2'), true);
  await listsMod.runFollowups();
  assert.equal((await query(`SELECT count(*)::int n FROM outbox WHERE list_id = $1 AND note = 'follow-up'`, [l.id]))[0].n, 0, 'busy day: no follow-ups drafted');

  // the new-person draft is rejected (nothing new going out today) → follow-ups allowed, but never to the rejected person
  await query(`UPDATE outbox SET status = 'rejected' WHERE list_id = $1 AND note IS DISTINCT FROM 'follow-up'`, [l.id]);
  assert.equal(await outboxMod.newOutreachToday('hire2'), false);
  await listsMod.runFollowups();
  const fu = await query(`SELECT to_jid, priority FROM outbox WHERE list_id = $1 AND note = 'follow-up'`, [l.id]);
  assert.deepEqual(fu.map((x) => x.to_jid), [J(1)], 'Silent One only — the rejected person gets nothing');
  assert.equal(fu[0].priority, -1, 'follow-ups sit behind first messages in the queue');

  // a follow-up already queued is held back at send time if new outreach starts that day
  await query(`UPDATE outbox SET status = 'queued' WHERE list_id = $1 AND note = 'follow-up'`, [l.id]);
  await outboxMod.enqueue({ account: 'hire2', to: '9600000009', payload: { text: 'first message to a new person' }, source: 'campaign' });
  await query(`UPDATE outbox SET status = 'queued' WHERE account_id = 'hire2' AND to_jid = '919600000009@s.whatsapp.net'`); // approved
  const before = sent.length;
  outboxMod.wakeAccount('hire2');
  await until(() => sent.slice(before).some((x) => x.jid === '919600000009@s.whatsapp.net'), 6000);
  await sleep(300);
  assert.ok(!sent.slice(before).some((x) => x.jid === J(1)), 'follow-up not sent on a day with new outreach');
  const [held] = await query(`SELECT status FROM outbox WHERE list_id = $1 AND note = 'follow-up'`, [l.id]);
  assert.equal(held.status, 'queued', 'held, goes out on a quiet day');
});

test('pipeline: stages, visit dates, ask-for-date, visit reminder + owner tasks, "did they come?"', async () => {
  const listsMod = await import('../src/lists.js');
  await manager.create({ id: 'hire3', label: 'Hire3' });
  fake('hire3');
  await manager.update('hire3', { settings: { aiMode: 'auto' } });
  await mcp('import_list', { account: 'hire3', name: 'Funnel', members: [
    { phone: '9500000001', name: 'Ajay Kumar', message: 'hi' }, { phone: '9500000002', name: 'Bala', message: 'hi' }, { phone: '9500000003', name: 'Chetan', message: 'hi' }] });
  const l = await listsMod.getList('Funnel');
  // Ajay is interested (no date yet) — 5 hours ago
  await mcp('update_list_member', { list: 'Funnel', phone: '9500000001', stage: 'interested' });
  await query(`UPDATE list_members SET stage_at = now() - interval '5 hours', updated_at = now() - interval '5 hours' WHERE list_id = $1 AND phone = '919500000001'`, [l.id]);
  // Bala gave a date 10 hours from now (date-only/IST parsing checked separately)
  const soon = new Date(Date.now() + 10 * 3600 * 1000).toISOString();
  assert.match(await mcp('update_list_member', { list: 'Funnel', phone: '9500000002', visit_at: soon }), /stage date_given, visit/);
  // Chetan's visit was yesterday and nobody updated the stage
  await mcp('update_list_member', { list: 'Funnel', phone: '9500000003', visit_at: new Date(Date.now() - 20 * 3600 * 1000).toISOString() });
  await query(`UPDATE list_members SET reminded_at = now() WHERE list_id = $1 AND phone = '919500000003'`, [l.id]);
  await listsMod.runPipeline();
  const rows = await query(`SELECT to_jid, note, priority, status, payload FROM outbox WHERE list_id = $1 ORDER BY to_jid`, [l.id]);
  assert.deepEqual(rows.map((r) => [r.to_jid.slice(0, 12), r.note]), [['919500000001', 'ask-date'], ['919500000002', 'visit-reminder']]);
  // the owner's own wording is set at setup: check it is filled in for each person, not the exact words
  assert.match(rows[0].payload.text, /Ajay/);
  assert.match(rows[1].payload.text, /Bala/);
  assert.doesNotMatch(rows[0].payload.text + rows[1].payload.text, /\{\w+\}/, 'every {field} filled');
  assert.ok(rows.every((r) => r.priority === 5), 'warm leads before bulk (0) and follow-ups (-1)');
  const t = (await call('GET', '/api/tasks?account=hire3')).data.map((x) => x.title);
  assert.ok(t.some((x) => /^Interview: Bala/.test(x)), 'interview task for the owner');
  const iv = (await call('GET', '/api/tasks?account=hire3&for=you')).data.find((x) => /^Interview: Bala/.test(x.title));
  assert.ok(iv && iv.priority && iv.assignee === 'you', 'interviews are a priority for the owner');
  assert.ok(t.some((x) => /^Did Chetan come\?/.test(x)), '"did they come" task');
  // nothing repeats on the next run
  await listsMod.runPipeline();
  assert.equal((await query(`SELECT count(*)::int n FROM outbox WHERE list_id = $1`, [l.id]))[0].n, 2);
  // pipeline overview for the AI
  const pv = await mcp('pipeline', { account: 'hire3' });
  assert.match(pv, /Funnel — .*interested: 1/);
  assert.match(pv, /Upcoming\/overdue visits:[\s\S]*Bala/);
  // closing stages stop everything
  await mcp('update_list_member', { list: 'Funnel', phone: '9500000001', stage: 'rejected', outcome: 'rejected – asked for money before joining' });
  const r = await mcp('send_to_list', { list: 'Funnel', statuses: ['new', 'failed', 'sent', 'replied'] });
  assert.ok(!/919500000001/.test(r) || /closed: rejected/.test(r));
  // date only → 10:00 India time
  const m = await mcp('update_list_member', { list: 'Funnel', phone: '9500000003', visit_at: '2031-01-15' });
  assert.match(m, /visit 15\/01\/2031 10:00/);
});

test('follow-ups: only after the follow-up time, at most N a day, can skip approval', async () => {
  const listsMod = await import('../src/lists.js');
  const settingsMod = await import('../src/settings.js');
  await manager.create({ id: 'hire4', label: 'Hire4' });
  fake('hire4');
  const now = Math.floor(Date.now() / 1000);
  const members = [];
  for (let i = 1; i <= 8; i++) {
    const jid = `91940000000${i}@s.whatsapp.net`;
    await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body) VALUES ('hire4',$1,$2,true,$3,'text','offer')`, [jid, 'F' + i, now - 4 * 86400]);
    members.push({ phone: `940000000${i}`, name: `Cand ${i}`, message: 'hi' });
  }
  await mcp('import_list', { account: 'hire4', name: 'FU', since: new Date((now - 10 * 86400) * 1000).toISOString(), members });
  await mcp('set_followup', { list: 'FU', enabled: true, after_days: 2, max: 1, text: 'follow up {first_name}', auto_send: true });
  const l = await listsMod.getList('FU');
  const nowLocal = settingsMod.localNow().minutes;
  // follow-up time still ahead → nothing
  const later = `${String(Math.min(23, Math.floor(nowLocal / 60) + 1)).padStart(2, '0')}:59`;
  await manager.update('hire4', { settings: { followupStart: later, followupDailyMax: 5 } });
  if (nowLocal < 23 * 60) {
    await listsMod.runFollowups();
    assert.equal((await query(`SELECT count(*)::int n FROM outbox WHERE list_id = $1`, [l.id]))[0].n, 0, 'before the follow-up time: none');
  }
  // time reached → at most 5, queued directly (auto_send), best-ranked first
  await manager.update('hire4', { settings: { followupStart: '00:00' } });
  await listsMod.runFollowups();
  const fu = await query(`SELECT to_jid, status FROM outbox WHERE list_id = $1 ORDER BY id`, [l.id]);
  assert.equal(fu.length, 5, 'max 5 a day');
  assert.ok(fu.every((x) => x.status === 'queued' || x.status === 'sending' || x.status === 'sent'), 'auto-send: no approval needed');
  await listsMod.runFollowups();
  assert.equal((await query(`SELECT count(*)::int n FROM outbox WHERE list_id = $1`, [l.id]))[0].n, 5, 'the other 3 wait for another day');
});

test('playbook: stored in the hub, editable, and given to every AI client', async () => {
  const r = await fetch(`${base}/mcp/k`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });
  const init = await r.json();
  const { DEFAULT_PLAYBOOK } = await import('../src/playbook.js');
  assert.ok(init.result.instructions.includes(DEFAULT_PLAYBOOK.split('\n')[0]), 'the playbook is in the MCP instructions');
  assert.equal(await mcp('get_playbook'), DEFAULT_PLAYBOOK);
  await call('PUT', '/api/playbook', { text: 'RULE: always be polite.' });
  assert.equal(await mcp('get_playbook'), 'RULE: always be polite.');
  assert.match(await mcp('recent_activity', { who: 'script' }), /Updated the playbook/);
});

test('changing one follow-up setting keeps the saved message', async () => {
  await mcp('import_list', { account: 'hiring', name: 'Keep text', members: [{ phone: '9300000001', name: 'X' }] });
  await mcp('set_followup', { list: 'Keep text', enabled: true, text: 'saved text' });
  assert.match(await mcp('set_followup', { list: 'Keep text', enabled: true, auto_send: true }), /on — after/);
  const [l] = await query(`SELECT followup FROM lists WHERE name = 'Keep text'`);
  assert.equal(l.followup.text, 'saved text');
  assert.equal(l.followup.autoSend, true);
});

test('job roles: lists, tasks and log kept separate per role; earlier batches never re-added', async () => {
  await manager.create({ id: 'hire5', label: 'Hire5' });
  fake('hire5');
  const b1 = await mcp('import_list', { account: 'hire5', name: 'Chef candidates – Batch A', members: [{ phone: '9200000001', name: 'Old Chef', Location: 'Hebbal' }, { phone: '9200000002', name: 'Other Chef' }] });
  assert.match(b1, /\(role Chef\): 2 new/);
  // next batch overlaps with one earlier chef → skipped with the reason, the number and the date
  const b2 = await mcp('import_list', { account: 'hire5', name: 'Chef candidates – Batch B', members: [{ phone: '9200000001', name: 'Old Chef again' }, { phone: '9200000003', name: 'New Chef' }] });
  assert.match(b2, /1 new/);
  assert.match(b2, /New: New Chef/);
  assert.match(b2, /Skipped \(not added\): Old Chef again \+919200000001 — already in "Chef candidates – Batch A" on hire5, added .+, never messaged/);
  // a different role does not clash with chefs
  const fo = await mcp('import_list', { account: 'hire5', name: 'Front office – Batch 1', members: [{ phone: '9200000001', name: 'Same person, other job' }] });
  assert.match(fo, /\(role Front office\): 1 new/);
  // known candidates for de-duplication before unlocking
  const known = await mcp('known_candidates', { role: 'Chef', account: 'hire5', all: true });
  // targeted check: only the matches, and who is new
  const q = await mcp('known_candidates', { role: 'Chef', account: 'hire5', query: 'Old Chef, 9999999999' });
  assert.match(q, /Old Chef \| 919200000001/);
  assert.match(q, /9999999999: not on any Chef list \(new\)/);
  assert.match(await mcp('known_candidates', { role: 'Chef', account: 'hire5' }), /^3 people already on Chef lists:\n- /);
  assert.match(known, /^3 people already on Chef lists/);
  assert.match(known, /Old Chef \| 919200000001 \| Hebbal \| Chef candidates – Batch A/);
  assert.ok(!/Same person, other job/.test(known));
  // filters
  assert.ok(!/Front office/.test(await mcp('list_lists', { account: 'hire5', role: 'Chef' })));
  await mcp('send_to_list', { list: 'Front office – Batch 1', text: 'Hi {first_name}' });
  const foTasks = await mcp('list_tasks', { account: 'hire5', role: 'Front office' });
  assert.match(foTasks, /Front office – Batch 1: message 1/);
  assert.ok(!/Chef/.test(foTasks));
  const act = await mcp('recent_activity', { account: 'hire5', role: 'Chef' });
  assert.match(act, /\| Chef \| Imported/);
  assert.ok(!/Front office – Batch 1/.test(act), 'chef log does not show front office entries');
  assert.deepEqual((await call('GET', '/api/roles')).data.filter((r) => ['Chef', 'Front office'].includes(r)), ['Chef', 'Front office']);
});

test('new-number limit: hard maximum 45 per rolling 24 h, held in the queue, existing chats continue', async () => {
  const { normalizeSettings, NEW_CHATS_HARD_MAX } = await import('../src/settings.js');
  assert.equal(NEW_CHATS_HARD_MAX, 45);
  assert.equal(normalizeSettings({}).newChatsPer24h, 42, 'default 48 − 6');
  const prevLimit = manager.get('hiring').account.settings.newChatsPer24h;
  const saved = await manager.update('hiring', { settings: { newChatsPer24h: 99 } });
  assert.equal(saved.settings.newChatsPer24h, 45, 'a linked phone can never be set above 45');
  await manager.update('hiring', { settings: { newChatsPer24h: prevLimit ?? 42 } });
  assert.equal(normalizeSettings({ newChatsPer24h: 5000 }).newChatsPer24h, 1000, 'Meta numbers: up to Meta tiers, never unlimited');
  await manager.create({ id: 'lim', label: 'Limited' });
  fake('lim');
  await manager.update('lim', { settings: { aiMode: 'auto', newChatsPer24h: 2, delayMinSec: 5, delayMaxSec: 5, anytime: true } });
  const now = Math.floor(Date.now() / 1000);
  // two new chats started by us in the last 24 h (one typed on the phone), one old chat, one chat they started
  await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body) VALUES
    ('lim','917000000001@s.whatsapp.net','L1',true,${now - 3600},'text','hi'),
    ('lim','917000000002@s.whatsapp.net','L2',true,${now - 600},'text','hi'),
    ('lim','917000000003@s.whatsapp.net','L3',false,${now - 90000},'text','hello'),
    ('lim','917000000003@s.whatsapp.net','L4',true,${now - 300},'text','reply'),
    ('lim','917000000004@s.whatsapp.net','L5',false,${now - 200},'text','they wrote first'),
    ('lim','917000000004@s.whatsapp.net','L6',true,${now - 100},'text','answer')`);
  const st = await outbox.newChatsStatus('lim', normalizeSettings({ newChatsPer24h: 2 }));
  assert.equal(st.count, 2, 'only chats we started in the last 24 h count');
  assert.ok(st.nextFreeAt instanceof Date);
  const before = sent.length;
  await mcp('bulk_send', { account: 'lim', title: 'Over limit', text: 'Hi {name}', recipients: [{ to: '7000000009', name: 'New' }, { to: '7000000003', name: 'Known' }], skip_if_contacted_days: 0 });
  await until(() => sent.slice(before).some((s) => s.jid === '917000000003@s.whatsapp.net'), 8000);
  await sleep(300);
  assert.ok(!sent.slice(before).some((s) => s.jid === '917000000009@s.whatsapp.net'), 'new number held at the limit');
  assert.match(await mcp('recent_activity', { account: 'lim', who: 'system' }), /New-number limit reached: 2 new numbers/);
  // your own send to a new number is refused with the reason, not silently queued
  const r = await call('POST', '/api/send', { account: 'lim', to: '7000000010', text: 'hello' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /New-number limit reached/);
  // WhatsApp's own block also holds new chats
  await manager.update('lim', { settings: { newChatsPer24h: 45 } });
  manager.get('lim').reachout = { isActive: true, timeEnforcementEnds: new Date(Date.now() + 3600e3).toISOString() };
  await assert.rejects(outbox.assertNewChatAllowed(manager.get('lim'), '917000000011@s.whatsapp.net'), /WhatsApp has blocked/);
  manager.get('lim').reachout = null;
  await until(() => sent.slice(before).some((s) => s.jid === '917000000009@s.whatsapp.net'), 8000);
  assert.match(await mcp('list_accounts'), /lim .*new numbers last 24h: 2\/45/); // the fake WhatsApp doesn't store sent messages
  await query(`UPDATE outbox SET status = 'rejected' WHERE account_id = 'lim' AND status IN ('draft','queued')`);
  await manager.remove('lim');
});

test('move selected messages to another number: each keeps its approval, the list follows', async () => {
  await manager.create({ id: 'spare', label: 'Spare' });
  fake('spare');
  await mcp('import_list', { account: 'hiring', name: 'Movers', role: 'Movers', members: [{ phone: '9400000001', name: 'A', message: 'Hi A' }, { phone: '9400000002', name: 'B', message: 'Hi B' }, { phone: '9400000003', name: 'C', message: 'Hi C' }] });
  await mcp('send_to_list', { list: 'Movers' });
  const rows = await query(`SELECT o.id FROM outbox o JOIN lists l ON l.id = o.list_id WHERE l.name = 'Movers' ORDER BY o.id`);
  assert.equal(rows.length, 3);
  await call('POST', '/api/outbox/approve-selected', { ids: [rows[0].id] }); // one already approved (queued)
  // move all three (a queued one included) → drafts on the spare number
  const m = await call('POST', '/api/outbox/move', { ids: rows.map((r) => r.id), account: 'spare' });
  assert.equal(m.status, 200, JSON.stringify(m.data));
  assert.equal(m.data.moved, 3 - (await query(`SELECT count(*)::int n FROM outbox WHERE id = $1 AND status = 'sent'`, [rows[0].id]))[0].n, JSON.stringify(m.data));
  const after = await query(`SELECT account_id, status FROM outbox WHERE id = ANY($1::bigint[]) AND status <> 'sent'`, [rows.map((r) => r.id)]);
  assert.ok(after.every((r) => r.account_id === 'spare'), 'all moved');
  assert.ok(after.every((r) => ['draft', 'queued', 'sending', 'sent'].includes(r.status)) && after.filter((r) => r.status === 'draft').length === 2, 'drafts stay drafts; an approved one stays approved');
  const [l] = await query(`SELECT account_id FROM lists WHERE name = 'Movers'`);
  assert.equal(l.account_id, 'spare', 'list moved with its messages (follow-ups from the new number)');
  assert.match(await mcp('recent_activity', { account: 'spare' }), /Received \d+ messages from "hiring"/);
  // reject one, approve the rest
  const left = await query(`SELECT id FROM outbox WHERE account_id = 'spare' AND status = 'draft' ORDER BY id`);
  assert.equal((await call('POST', '/api/outbox/reject-selected', { ids: [left[0].id] })).data.rejected, 1);
  assert.equal((await call('POST', '/api/outbox/approve-selected', { ids: left.slice(1).map((r) => r.id) })).data.approved, left.length - 1);
  assert.equal((await call('POST', '/api/outbox/move', { ids: [], account: 'spare' })).status, 400);
  await query(`UPDATE outbox SET status = 'rejected' WHERE account_id = 'spare' AND status IN ('draft','queued')`);
  await manager.remove('spare');
});

test('alert phones: any format is cleaned to digits with country code', async () => {
  const r = await call('PUT', '/api/alerts', { phones: '+91 63613 21377, 98450-12345' });
  assert.deepEqual(r.data.phones, ['916361321377', '919845012345']);
  await call('PUT', '/api/alerts', { phones: '' });
});

test('a batch split over two numbers: each follow-up goes from the number that has that chat', async () => {
  const listsMod = await import('../src/lists.js');
  await manager.create({ id: 'oldno', label: 'Old number' });
  await manager.create({ id: 'newno', label: 'New number' });
  fake('oldno');
  fake('newno');
  for (const id of ['oldno', 'newno']) await manager.update(id, { settings: { followupStart: '00:00', followupDailyMax: 5, aiMode: 'auto' } });
  const now = Math.floor(Date.now() / 1000);
  // A was messaged from the old number, B from the new one (after the batch was moved)
  await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body) VALUES
    ('oldno','919600000001@s.whatsapp.net','S1',true,${now - 4 * 86400},'text','offer A'),
    ('newno','919600000002@s.whatsapp.net','S2',true,${now - 4 * 86400},'text','offer B')`);
  await mcp('import_list', { account: 'oldno', name: 'Split', role: 'Split', since: new Date((now - 10 * 86400) * 1000).toISOString(),
    members: [{ phone: '9600000001', name: 'A', message: 'hi' }, { phone: '9600000002', name: 'B', message: 'hi' }] });
  const l = await listsMod.getList('Split');
  // sent through the hub from the old number, then the rest of the batch was moved to the new number
  await query(`INSERT INTO outbox (account_id, to_jid, payload, source, status, list_id) VALUES ('oldno','919600000001@s.whatsapp.net','{"text":"offer A"}','campaign','sent',$1), ('newno','919600000002@s.whatsapp.net','{"text":"offer B"}','campaign','sent',$1)`, [l.id]);
  await query(`UPDATE lists SET account_id = 'newno' WHERE id = $1`, [l.id]);
  await mcp('set_followup', { list: 'Split', enabled: true, after_days: 2, max: 1, text: 'still interested {first_name}?', auto_send: true });
  await listsMod.runFollowups();
  const fu = await query(`SELECT account_id, to_jid, payload FROM outbox WHERE list_id = $1 AND note = 'follow-up' ORDER BY to_jid`, [l.id]);
  assert.deepEqual(fu.map((r) => [r.account_id, r.to_jid.slice(0, 12)]), [['oldno', '919600000001'], ['newno', '919600000002']]);
  assert.equal(fu[0].payload.replyTo, 'S1', 'quotes the message in that chat');
  // a number that is offline just waits: no follow-up from the other number instead
  await query(`DELETE FROM outbox WHERE list_id = $1 AND note = 'follow-up'`, [l.id]);
  manager.get('oldno').status = 'stopped';
  await listsMod.runFollowups();
  const fu2 = await query(`SELECT account_id, to_jid FROM outbox WHERE list_id = $1 AND note = 'follow-up'`, [l.id]);
  assert.deepEqual(fu2.map((r) => r.account_id), ['newno']);
  await query(`UPDATE outbox SET status = 'rejected' WHERE account_id IN ('oldno','newno') AND status IN ('draft','queued')`);
  await manager.remove('oldno');
  await manager.remove('newno');
});

test('a send whose "sent" note was lost is recognised as sent (never shown as failed)', async () => {
  const now = Math.floor(Date.now() / 1000);
  const [row] = await query(`INSERT INTO outbox (account_id, to_jid, payload, source, status, sent_at) VALUES
    ('hotel','919700000077@s.whatsapp.net','{"text":"x"}','api','sending', now() - interval '6 minutes'),
    ('hotel','919700000078@s.whatsapp.net','{"text":"y"}','api','sending', now() - interval '6 minutes') RETURNING id`);
  await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body) VALUES ('hotel','919700000077@s.whatsapp.net','WENT1',true,${now - 330},'text','x')`);
  await outbox.sweepStuck();
  const r = await query(`SELECT to_jid, status, message_id FROM outbox WHERE to_jid IN ('919700000077@s.whatsapp.net','919700000078@s.whatsapp.net') ORDER BY to_jid`);
  assert.deepEqual(r.map((x) => [x.status, x.message_id]), [['sent', 'WENT1'], ['failed', null]]);
  assert.ok(row);
});

test('queue status explains what waits, why and until when; drafts show the list name', async () => {
  await manager.create({ id: 'qs', label: 'Queue test' });
  fake('qs');
  await manager.update('qs', { settings: { aiMode: 'approve', dailyCap: 0 } });
  await mcp('import_list', { account: 'qs', name: 'QS list', role: 'QS', members: [{ phone: '9500000071', name: 'Sagar Kumar', message: 'Hi Sagar' }, { phone: '9500000072', name: 'Ravi', message: 'Hi Ravi' }] });
  await mcp('send_to_list', { list: 'QS list' });
  let [st] = (await call('GET', '/api/outbox/status?account=qs')).data;
  assert.equal(st.drafts, 2);
  assert.equal(st.state, 'idle');
  const drafts = (await call('GET', '/api/outbox?account=qs&status=draft')).data;
  assert.deepEqual(drafts.map((d) => d.to_name).sort(), ['Ravi', 'Sagar Kumar'], 'names from the list, not bare numbers');
  await call('POST', '/api/outbox/approve-all', { account: 'qs' });
  [st] = (await call('GET', '/api/outbox/status?account=qs')).data;
  assert.equal(st.queued, 2);
  assert.equal(st.state, 'held');
  assert.match(st.reason, /Automated limit reached: 0 of 0/);
  await manager.update('qs', { settings: { dailyCap: 35 } });
  manager.get('qs').status = 'stopped';
  [st] = (await call('GET', '/api/outbox/status?account=qs')).data;
  assert.match(st.reason, /not connected/);
  manager.get('qs').status = 'open';
  outbox.wakeAccount('qs');
  await until(async () => (await query(`SELECT count(*)::int n FROM outbox WHERE account_id = 'qs' AND status = 'sent'`))[0].n === 2, 15000);
  const [c] = await query(`SELECT name FROM contacts WHERE account_id = 'qs' AND jid = '919500000071@s.whatsapp.net'`);
  assert.equal(c?.name, 'Sagar Kumar', 'the sending number now knows the name (inbox shows it)');
  await manager.remove('qs');
});

test('Meta webhook: answers the verify check only with the right token, checks the signature', async () => {
  const crypto = await import('crypto');
  process.env.META_VERIFY_TOKEN = 'verify-test-word';
  process.env.META_APP_SECRET = 'app-secret-test';
  try {
    const ok = await fetch(`${base}/meta/webhook?hub.mode=subscribe&hub.verify_token=verify-test-word&hub.challenge=12345`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '12345');
    assert.equal((await fetch(`${base}/meta/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status, 403);
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111' }, messages: [{ id: 'x' }] } }] }] });
    const sig = 'sha256=' + crypto.createHmac('sha256', 'app-secret-test').update(body).digest('hex');
    const post = (s) => fetch(`${base}/meta/webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': s } });
    assert.equal((await post(sig)).status, 200);
    assert.equal((await post('sha256=bad')).status, 401);
  } finally {
    delete process.env.META_VERIFY_TOKEN;
    delete process.env.META_APP_SECRET;
  }
});

test('approved replies to people who wrote in the last 24 h go out at once, even with the daily cap full; cold messages wait', async () => {
  await manager.create({ id: 'rp', label: 'Replies' });
  await manager.update('rp', { settings: { sendStart: '00:00', sendEnd: '23:59', sendDays: [0, 1, 2, 3, 4, 5, 6], aiMode: 'approve', dailyCap: 1, delayMinSec: 600, delayMaxSec: 900 } });
  fake('rp');
  const now = Math.floor(Date.now() / 1000);
  // cap already used up by one automated send
  await query(`INSERT INTO outbox (account_id, to_jid, payload, source, status, sent_at) VALUES ('rp', '919800000900@s.whatsapp.net', '{"text":"x"}', 'campaign', 'sent', now())`);
  // a candidate wrote back an hour ago
  await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body) VALUES ('rp', '919800000901@s.whatsapp.net', 'R1', true, $1, 'text', 'invite'), ('rp', '919800000901@s.whatsapp.net', 'R2', false, $2, 'text', 'Im interested')`, [now - 7200, now - 3600]);
  const cold = await outbox.enqueue({ account: 'rp', to: '919800000902', payload: { text: 'cold invite' }, source: 'campaign' });
  await outbox.approve(cold.id);
  const reply = await outbox.enqueue({ account: 'rp', to: '919800000901', payload: { text: 'When can you come?' }, source: 'mcp' });
  assert.equal(reply.status, 'draft');
  await outbox.approve(reply.id);
  await until(async () => (await query(`SELECT status FROM outbox WHERE id = $1`, [reply.id]))[0].status === 'sent', 8000);
  const [r] = await query(`SELECT is_reply FROM outbox WHERE id = $1`, [reply.id]);
  assert.equal(r.is_reply, true);
  await sleep(300);
  assert.equal((await query(`SELECT status FROM outbox WHERE id = $1`, [cold.id]))[0].status, 'queued', 'cold outreach still waits for the cap');
  const st = await outbox.queueStatus('rp');
  assert.equal(st.automated24h, 1, 'the reply is not counted in the cap');
  await manager.remove('rp');
});

test('board: candidate replies, visit dates and chat reminders all appear as cards by themselves, and close by themselves', async () => {
  const store = await import('../src/store.js');
  const board = await import('../src/board.js');
  const imp = await call('POST', '/api/lists/import', { account: 'hiring', name: 'Board batch', role: 'Chef', members: [{ phone: '9800001001', name: 'Kasi Reddy' }, { phone: '9800001002', name: 'Sagar R' }] });
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  const listId = imp.data.list.id;
  const now = Math.floor(Date.now() / 1000);
  // our invite, then his reply (the reply arrives while nobody is looking)
  await store.insertMessages('hiring', [
    { id: 'BI1', fromMe: true, ts: now - 600, chatJid: '919800001001@s.whatsapp.net', type: 'text', body: 'invite', status: 2, forwarded: false },
    { id: 'BI2', fromMe: false, ts: now - 100, chatJid: '919800001001@s.whatsapp.net', senderJid: '919800001001@s.whatsapp.net', type: 'text', body: 'Okay location', forwarded: false },
  ]);
  await board.syncBoard();
  let cards = (await call('GET', '/api/tasks?kind=reply')).data;
  const kasi = cards.find((t) => t.ref === 'reply:hiring:919800001001@s.whatsapp.net');
  assert.ok(kasi, 'unanswered reply is on the board');
  assert.match(kasi.title, /Reply to Kasi Reddy: "Okay location"/);
  // live path: a new message from a list member makes / updates the card at once
  await manager.get('hiring').afterIncoming({ chatJid: '919800001001@s.whatsapp.net', senderJid: '919800001001@s.whatsapp.net', id: 'BI3', ts: now - 80, type: 'text', body: 'Kahan hai hotel?' });
  cards = (await call('GET', '/api/tasks?kind=reply')).data;
  assert.match(cards.find((t) => t.ref === kasi.ref).title, /Kahan hai hotel/);
  assert.equal(cards.filter((t) => t.ref === kasi.ref).length, 1, 'one card per person');
  // we answer → the card is done
  await store.insertMessages('hiring', [{ id: 'BI4', fromMe: true, ts: now - 60, chatJid: '919800001001@s.whatsapp.net', type: 'text', body: 'Amruthahalli', forwarded: false }]);
  assert.ok(!(await call('GET', '/api/tasks?kind=reply')).data.find((t) => t.ref === kasi.ref), 'answered → off the board');
  // a card the owner closes by hand stays closed until they write again
  await sleep(1100);
  await store.insertMessages('hiring', [{ id: 'BI5', fromMe: false, ts: Math.floor(Date.now() / 1000), chatJid: '919800001001@s.whatsapp.net', type: 'text', body: 'ok', forwarded: false }]);
  await board.syncBoard();
  const again = (await call('GET', '/api/tasks?kind=reply')).data.find((t) => t.ref === kasi.ref);
  assert.ok(again);
  await call('PATCH', `/api/tasks/${again.id}`, { status: 'done' });
  await board.syncBoard();
  assert.ok(!(await call('GET', '/api/tasks?kind=reply')).data.find((t) => t.ref === kasi.ref), 'closed by hand stays closed');
  // visit date → card right away (not only the day before), done once visited
  await call('PATCH', `/api/lists/${listId}/members/9800001002`, { visitAt: new Date(Date.now() + 4 * 86400000).toISOString() });
  let visits = (await call('GET', '/api/tasks?kind=visit')).data;
  assert.ok(visits.find((t) => t.ref === `visit:${listId}:919800001002@s.whatsapp.net` && t.due_at), 'visit is on the board with its date');
  await call('PATCH', `/api/lists/${listId}/members/9800001002`, { stage: 'visited' });
  visits = (await call('GET', '/api/tasks?kind=visit')).data;
  assert.ok(!visits.find((t) => t.ref === `visit:${listId}:919800001002@s.whatsapp.net`));
  // chat reminder → card due on that date; reopening the chat closes it
  await store.upsertChats('hiring', [{ jid: '919800001002@s.whatsapp.net', name: 'Sagar R' }]);
  await call('PATCH', '/api/accounts/hiring/chats/919800001002@s.whatsapp.net/state', { state: 'snoozed', until: new Date(Date.now() + 2 * 86400000).toISOString(), note: 'call about joining' });
  assert.match((await call('GET', '/api/tasks?kind=reminder')).data.find((t) => t.ref === 'remind:hiring:919800001002@s.whatsapp.net').title, /Reminder: Sagar R — call about joining/);
  await call('PATCH', '/api/accounts/hiring/chats/919800001002@s.whatsapp.net/state', { state: 'open' });
  assert.ok(!(await call('GET', '/api/tasks?kind=reminder')).data.find((t) => t.ref === 'remind:hiring:919800001002@s.whatsapp.net'));
});

test('board as a shared calendar: follow-ups before the date they gave, owner vs AI cards, priority, scheduled messages', async () => {
  const store = await import('../src/store.js');
  const board = await import('../src/board.js');
  const imp = await call('POST', '/api/lists/import', { account: 'hiring', name: 'Calendar batch', role: 'Chef', members: [{ phone: '9800003001', name: 'Manish K' }, { phone: '9800003002', name: 'Ravi T' }] });
  const listId = imp.data.list.id;
  // "I can come after 10 Nov" → follow-up the day before at 10:00 India time, a card for the AI
  const lists = await import('../src/lists.js');
  const from = new Date(Date.now() + 20 * 86400000);
  const fromDay = from.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const r = await call('PATCH', `/api/lists/${listId}/members/9800003001`, { stage: 'interested', availableFrom: `${fromDay}T10:00:00+05:30`, followupNote: 'free after his notice period' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const expect = lists.followupBefore(`${fromDay}T10:00:00+05:30`);
  assert.equal(new Date(r.data.followup_at).toISOString(), expect.toISOString());
  assert.equal(expect.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }), '10:00');
  let fu = (await call('GET', '/api/tasks?kind=followup&for=ai')).data.find((t) => t.ref === `followup:${listId}:919800003001@s.whatsapp.net`);
  assert.ok(fu, 'follow-up card for the AI');
  assert.match(fu.title, /^Follow up: Manish K/);
  assert.match(fu.details, /free after his notice period/);
  assert.ok(!(await call('GET', '/api/tasks?for=ai&due_now=1')).data.find((t) => t.id === fu.id), 'not due yet');
  // a chat message now (before the date) does not close it
  await store.insertMessages('hiring', [{ id: 'CF1', fromMe: true, ts: Math.floor(Date.now() / 1000), chatJid: '919800003001@s.whatsapp.net', type: 'text', body: 'theek hai', forwarded: false }]);
  assert.ok((await call('GET', '/api/tasks?kind=followup')).data.find((t) => t.id === fu.id), 'early chat keeps the follow-up');
  // when it comes due and we message them, it is done
  await call('PATCH', `/api/lists/${listId}/members/9800003001`, { followupAt: new Date(Date.now() - 60000).toISOString() });
  assert.ok((await call('GET', '/api/tasks?for=ai&due_now=1')).data.find((t) => t.id === fu.id), 'due now → on the AI to-do list');
  await store.insertMessages('hiring', [{ id: 'CF2', fromMe: true, ts: Math.floor(Date.now() / 1000) + 1, chatJid: '919800003001@s.whatsapp.net', type: 'text', body: 'kab aa sakte hain?', forwarded: false }]);
  assert.ok(!(await call('GET', '/api/tasks?kind=followup')).data.find((t) => t.id === fu.id), 'followed up → off the board');
  assert.equal((await query(`SELECT followup_at FROM list_members WHERE list_id = $1 AND jid = '919800003001@s.whatsapp.net'`, [listId]))[0].followup_at, null);
  // a visit date replaces a pending follow-up; rejection cancels one
  await call('PATCH', `/api/lists/${listId}/members/9800003002`, { followupAt: new Date(Date.now() + 3 * 86400000).toISOString() });
  assert.ok((await call('GET', '/api/tasks?kind=followup')).data.find((t) => t.ref === `followup:${listId}:919800003002@s.whatsapp.net`));
  await call('PATCH', `/api/lists/${listId}/members/9800003002`, { visitAt: new Date(Date.now() + 5 * 86400000).toISOString() });
  assert.ok(!(await call('GET', '/api/tasks?kind=followup')).data.find((t) => t.ref === `followup:${listId}:919800003002@s.whatsapp.net`), 'visit replaces follow-up');
  const iv = (await call('GET', '/api/tasks?kind=visit')).data.find((t) => t.ref === `visit:${listId}:919800003002@s.whatsapp.net`);
  assert.ok(iv.priority && iv.assignee === 'you' && /^Interview: Ravi T/.test(iv.title));
  // owner to-dos: priority and who; flag/unflag
  const todo = (await call('POST', '/api/tasks', { account: 'hiring', title: 'Take interview of Ravi', priority: true })).data;
  assert.equal(todo.assignee, 'you');
  assert.equal(todo.priority, true);
  const aiTodo = (await call('POST', '/api/tasks', { account: 'hiring', title: 'Send menu to Ravi', assignee: 'ai' })).data;
  assert.equal(aiTodo.assignee, 'ai');
  assert.equal((await call('PATCH', `/api/tasks/${todo.id}`, { priority: false })).data.priority, false);
  assert.equal((await call('POST', '/api/tasks', { account: 'hiring', title: 'x', assignee: 'boss' })).status >= 400, true);
  // a single message for later is on the board until it goes out
  const sched = await call('POST', '/api/send', { account: 'hiring', to: '919800003002', text: 'Kal 11 baje yaad rakhiye', scheduleAt: new Date(Date.now() + 2 * 86400000).toISOString() });
  assert.ok(sched.status < 300, JSON.stringify(sched.data));
  const sc = (await call('GET', '/api/tasks?kind=scheduled')).data.find((t) => t.ref === `sched:${sched.data.id}`);
  assert.ok(sc && /Scheduled: message to/.test(sc.title) && sc.assignee === 'ai', 'scheduled send on the board');
  await query(`UPDATE outbox SET status = 'rejected' WHERE id = $1`, [sched.data.id]);
  await board.syncBoard();
  assert.ok(!(await call('GET', '/api/tasks?kind=scheduled')).data.find((t) => t.ref === `sched:${sched.data.id}`), 'cancelled → off the board');
});

test('card history + notes explain every change; forgotten interested candidates get a follow-up; health shows the board check', async () => {
  const store = await import('../src/store.js');
  const board = await import('../src/board.js');
  const imp = await call('POST', '/api/lists/import', { account: 'hiring', name: 'History batch', role: 'Chef', members: [{ phone: '9800004001', name: 'Arun P' }, { phone: '9800004002', name: 'Dinesh Q' }] });
  const listId = imp.data.list.id;
  const now = Math.floor(Date.now() / 1000);
  // a reply card: created by the hub, closed by the hub with the reason
  await store.insertMessages('hiring', [{ id: 'HL1', fromMe: false, ts: now - 50, chatJid: '919800004001@s.whatsapp.net', type: 'text', body: 'Interested', forwarded: false }]);
  await board.syncBoard();
  const card = (await call('GET', '/api/tasks?kind=reply')).data.find((t) => t.ref === 'reply:hiring:919800004001@s.whatsapp.net');
  assert.ok(card);
  // the owner writes call notes on it; the AI sees the latest note in the list
  assert.equal((await call('POST', `/api/tasks/${card.id}/notes`, { text: 'Spoke on phone: can come Sunday 11 am' })).status, 200);
  assert.equal((await call('POST', `/api/tasks/${card.id}/notes`, { text: '  ' })).status >= 400, true, 'empty note refused');
  const listed = (await call('GET', '/api/tasks?kind=reply')).data.find((t) => t.id === card.id);
  assert.equal(listed.notes, 1);
  assert.match(listed.last_note, /Sunday 11 am/);
  await call('PATCH', `/api/tasks/${card.id}`, { priority: true });
  await store.insertMessages('hiring', [{ id: 'HL2', fromMe: true, ts: now - 10, chatJid: '919800004001@s.whatsapp.net', type: 'text', body: 'Sunday 11 confirmed', forwarded: false }]);
  const log = (await call('GET', `/api/tasks/${card.id}/log`)).data;
  const texts = log.map((r) => r.text);
  assert.equal(texts[0], 'Created by the hub');
  assert.ok(log.find((r) => r.kind === 'note' && /Sunday 11 am/.test(r.text)));
  assert.ok(texts.includes('Marked priority'));
  assert.ok(texts.some((x) => /Done by the hub — a reply went out/.test(x)), 'closure says why: ' + texts.join(' | '));
  // safety net: interested, nothing planned, silent for 3+ days → follow-up card due now (only once)
  await call('PATCH', `/api/lists/${listId}/members/9800004002`, { stage: 'interested' });
  await query(`UPDATE list_members SET stage_at = now() - interval '5 days' WHERE list_id = $1 AND jid = '919800004002@s.whatsapp.net'`, [listId]);
  await store.insertMessages('hiring', [{ id: 'HL3', fromMe: true, ts: now - 5 * 86400, chatJid: '919800004002@s.whatsapp.net', type: 'text', body: 'kab aa sakte hain?', forwarded: false }]);
  await query(`UPDATE tasks SET status = 'done', completed_at = now() WHERE ref = 'reply:hiring:919800004002@s.whatsapp.net'`);
  const r1 = await board.syncBoard();
  assert.ok(r1.forgotten >= 1);
  const fu = (await call('GET', '/api/tasks?for=ai&due_now=1')).data.find((t) => t.ref === `followup:${listId}:919800004002@s.whatsapp.net`);
  assert.ok(fu, 'forgotten candidate is back on the board');
  assert.match(fu.details, /no interview date/);
  assert.ok((await call('GET', `/api/tasks/${fu.id}/log`)).data.some((r) => /safety net/.test(r.text)));
  await board.syncBoard();
  assert.equal((await query(`SELECT count(*)::int n FROM tasks WHERE ref = $1`, [`followup:${listId}:919800004002@s.whatsapp.net`]))[0].n, 1, 'not added twice');
  // a recently interested candidate is left alone
  await call('PATCH', `/api/lists/${listId}/members/9800004001`, { stage: 'interested' });
  await board.syncBoard();
  assert.ok(!(await call('GET', '/api/tasks?kind=followup')).data.find((t) => t.ref === `followup:${listId}:919800004001@s.whatsapp.net`));
  // health: the board check and the database are reported
  const hl = (await call('GET', '/health')).data;
  assert.equal(hl.dbOk, true);
  assert.equal(hl.board.ok, true);
  assert.equal(hl.board.late, false);
});

test('AI onboarding: hub_overview first; lists on all numbers; duplicates checked across numbers; archive stops sends; mistaken rows can be removed', async () => {
  await manager.create({ id: 'hire8', label: 'Hire8' });
  await manager.create({ id: 'hire9', label: 'Hire9' });
  fake('hire8');
  fake('hire9');
  const ov = await mcp('hub_overview');
  assert.match(ov, /1\. DUE NOW/);
  assert.match(ov, /4\. NUMBERS:\n   - /);
  assert.match(ov, /hire8 \(Hire8, linked phone\): open \| sending: /);
  // a batch on one number; a new batch on ANOTHER number skips the person, saying where and when
  await mcp('import_list', { account: 'hire8', name: 'Chef – Batch X', role: 'Chef', members: [{ phone: '9300000001', name: 'Asha' }, { phone: '9300000002', name: 'Bala' }] });
  const b = await mcp('import_list', { account: 'hire9', name: 'Chef – Batch Y', role: 'Chef', members: [{ phone: '9300000001', name: 'Asha' }, { phone: '9300000003', name: 'Chitra' }] });
  assert.match(b, /Asha \+919300000001 — already in "Chef – Batch X" on hire8/);
  // filtering by one number says other numbers have lists too
  assert.match(await mcp('list_lists', { account: 'hire9' }), /more list\(s\) on other numbers/);
  const known = await mcp('known_candidates', { role: 'Chef', query: 'Asha' });
  assert.match(known, /Asha \| 919300000001 \|  \| Chef – Batch X \| hire8 \| .+ \| never \|/);
  // archive: hidden, never sends, unsent messages cancelled
  const [lx] = await query(`SELECT id FROM lists WHERE name = 'Chef – Batch X'`);
  const arch = await mcp('archive_list', { list: String(lx.id), reason: 'duplicate check only' });
  assert.match(arch, /archived: duplicate check only/);
  assert.doesNotMatch(await mcp('list_lists', {}), /Chef – Batch X/);
  assert.match(await mcp('list_lists', { include_archived: true }), /ARCHIVED: duplicate check only/);
  const send = await call('POST', `/api/lists/${lx.id}/send`, {});
  assert.equal(send.status, 400);
  assert.match(send.data.error, /archived/);
  // remove rows typed by mistake (never messaged) — not someone already messaged
  const [ly] = await query(`SELECT id FROM lists WHERE name = 'Chef – Batch Y'`);
  await call('POST', `/api/lists/${ly.id}/send`, { onlyPhones: ['9300000003'], text: 'Hi' });
  await query(`UPDATE outbox SET status = 'sent' WHERE list_id = $1`, [ly.id]);
  await mcp('import_list', { account: 'hire9', name: 'Chef – Batch Y', role: 'Chef', members: [{ phone: '9399999999', name: 'Fake Person' }] });
  const rm = await mcp('remove_list_member', { list: String(ly.id), phones: ['9399999999', '9300000003'] });
  assert.match(rm, /Removed 1: Fake Person/);
  assert.match(rm, /Chitra \(already messaged from this list/);
  assert.equal((await query(`SELECT count(*)::int n FROM list_members WHERE list_id = $1 AND phone = '919399999999'`, [ly.id]))[0].n, 0);
  // no open tasks → says finished ones exist and how to see them
  assert.match(await mcp('list_tasks', { account: 'hire9', kind: 'todo' }), /No open tasks match these filters\. \(\d+ finished in the last 7 days/);
});

test('settings for all numbers: numbers follow the defaults except settings they changed themselves; reset brings them back', async () => {
  await manager.create({ id: 'set1', label: 'Set1' });
  await manager.create({ id: 'set2', label: 'Set2' });
  await call('PATCH', '/api/accounts/set2', { settings: { dailyCap: 20 } }); // its own value
  const r = await call('PUT', '/api/settings/defaults', { dailyCap: 30, delayMinSec: 60, delayMaxSec: 90 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const s1 = manager.get('set1').account.settings;
  const s2 = manager.get('set2').account.settings;
  assert.equal(s1.dailyCap, 30, 'follows the default');
  assert.equal(s1.delayMinSec, 60);
  assert.equal(s2.dailyCap, 20, 'keeps its own');
  assert.equal(s2.delayMinSec, 60, 'other settings still follow');
  const g = (await call('GET', '/api/settings/defaults')).data;
  assert.deepEqual(g.numbers.find((n) => n.id === 'set2').own, ['dailyCap']);
  // a new number starts from the defaults
  await manager.create({ id: 'set3', label: 'Set3' });
  assert.equal(manager.get('set3').account.settings.dailyCap, 30);
  // reset: back on every default
  await call('POST', '/api/accounts/set2/settings/reset');
  assert.equal(manager.get('set2').account.settings.dailyCap, 30);
  assert.deepEqual((await call('GET', '/api/settings/defaults')).data.numbers.find((n) => n.id === 'set2').own, []);
  // put the defaults back for other tests
  await call('PUT', '/api/settings/defaults', { dailyCap: 35, delayMinSec: 45, delayMaxSec: 120 });
});

test('owner feedback reaches the AI: rejections (with reason) land on the person\'s card; one note on several cards makes an AI task; wrong-number drafts are stopped', async () => {
  const store = await import('../src/store.js');
  const board = await import('../src/board.js');
  await manager.create({ id: 'fb1', label: 'Fb1' });
  await manager.create({ id: 'fb2', label: 'Fb2' });
  fake('fb1');
  fake('fb2');
  await call('PATCH', '/api/accounts/fb1', { settings: { aiMode: 'approve' } });
  await mcp('import_list', { account: 'fb1', name: 'Feedback batch', role: 'Chef', members: [{ phone: '9400000001', name: 'Gopal' }, { phone: '9400000002', name: 'Hari' }] });
  const now = Math.floor(Date.now() / 1000);
  await store.insertMessages('fb1', [
    { id: 'FB1', fromMe: true, ts: now - 600, chatJid: '919400000001@s.whatsapp.net', type: 'text', body: 'invite', forwarded: false },
    { id: 'FB2', fromMe: false, ts: now - 60, chatJid: '919400000001@s.whatsapp.net', type: 'text', body: 'Salary kitna?', forwarded: false },
  ]);
  await board.syncBoard();
  const card = (await call('GET', '/api/tasks?kind=reply')).data.find((t) => t.ref === 'reply:fb1:919400000001@s.whatsapp.net');
  assert.ok(card);
  // the AI drafts; the owner rejects with a reason → a note on the card, shown to the AI
  const d = await mcp('send_message', { account: 'fb1', to: '919400000001', text: 'Salary 15000' });
  const id = Number(d.match(/#(\d+)/)[1]);
  assert.equal((await call('POST', `/api/outbox/${id}/reject`, { reason: 'wrong salary, say 21-23k' })).status, 200);
  const log = (await call('GET', `/api/tasks/${card.id}/log`)).data;
  assert.ok(log.some((r) => r.kind === 'note' && /Owner rejected draft #\d+ — reason: wrong salary, say 21-23k/.test(r.text)), JSON.stringify(log));
  assert.match(await mcp('list_tasks', { kind: 'reply', account: 'fb1' }), /latest: "Owner rejected draft/);
  assert.match(await mcp('hub_overview'), /Owner REJECTED recently .* — wrong salary/);
  // wrong number: Gopal chats with fb1, so fb2 may not start a chat with him
  assert.match(await mcp('send_message', { account: 'fb2', to: '919400000001', text: 'Hi' }), /Not drafted: .* chat is on "fb1"/);
  assert.match(await mcp('send_message', { account: 'fb2', to: '919400000001', text: 'Hi', other_number_ok: true }), /Draft #\d+|Queued #\d+/);
  // several cards → one note, an AI task listing them, originals closed
  const t1 = (await call('POST', '/api/tasks', { account: 'fb1', title: 'Call Gopal – tapped "Haan, interested"', details: 'From Gopal +919400000001', priority: true })).data;
  const t2 = (await call('POST', '/api/tasks', { account: 'fb1', title: 'Call Hari – tapped "Haan, interested"', details: 'From Hari +919400000002', priority: true })).data;
  const r = await call('POST', '/api/tasks/bulk-note', { ids: [t1.id, t2.id], text: 'Did not pick up my calls — follow up on WhatsApp', aiTask: true, close: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.noted, 2);
  assert.equal(r.data.task.assignee, 'ai');
  assert.match(r.data.task.title, /^Owner: Did not pick up my calls — follow up on WhatsApp \(2 people\)/);
  assert.match(r.data.task.details, /#\d+ Call Gopal .*\+919400000001/);
  const ai = await mcp('list_tasks', { for: 'ai', due_now: true });
  assert.match(ai, /Owner: Did not pick up my calls/);
  assert.equal((await query('SELECT status FROM tasks WHERE id = $1', [t1.id]))[0].status, 'done');
  assert.ok((await call('GET', `/api/tasks/${t2.id}/log`)).data.some((x) => x.kind === 'note' && /follow up on WhatsApp/.test(x.text)));
  assert.equal((await call('POST', '/api/tasks/bulk-note', { ids: [], text: 'x' })).status >= 400, true);
  // an owner note the AI hasn't acted on is flagged until the AI notes what it did
  const t3 = (await call('POST', '/api/tasks', { account: 'fb1', title: 'Interview: Gopal' })).data;
  await call('POST', `/api/tasks/${t3.id}/notes`, { text: 'Postponed — follow up on Monday' });
  assert.match(await mcp('list_tasks', { owner_notes: true }), new RegExp(`#${t3.id} .*OWNER NOTE TO ACT ON`));
  assert.match(await mcp('hub_overview'), /OWNER NOTES TO ACT ON/);
  await mcp('add_task_note', { id: t3.id, text: 'Set follow-up for Monday 10:00' });
  assert.doesNotMatch(await mcp('list_tasks', { owner_notes: true }), new RegExp(`#${t3.id} `));
  // a note written while closing the card still counts
  const t4 = (await call('POST', '/api/tasks', { account: 'fb1', title: 'Call Hari again' })).data;
  await call('POST', `/api/tasks/${t4.id}/notes`, { text: 'Follow up after 12 days' });
  await call('PATCH', `/api/tasks/${t4.id}`, { status: 'done' });
  assert.match(await mcp('list_tasks', { owner_notes: true }), new RegExp(`#${t4.id} .*OWNER NOTE TO ACT ON`));
});

test('rules can be limited to a job role; contacts can be saved by name and keep that name through WhatsApp sync', async () => {
  const store = await import('../src/store.js');
  const rules = await import('../src/rules.js');
  await manager.create({ id: 'rl1', label: 'Rl1' });
  fake('rl1');
  await mcp('import_list', { account: 'rl1', name: 'Reception – Batch 1', role: 'Front office', members: [{ phone: '9500000001', name: 'Rekha' }] });
  await mcp('import_list', { account: 'rl1', name: 'Chef – Batch R', role: 'Chef', members: [{ phone: '9500000002', name: 'Ramu' }] });
  await mcp('save_rule', { account: 'rl1', name: 'Chef Haan', words: ['haan, interested'], role: 'Chef', add_tags: ['chef-yes'] });
  await mcp('save_rule', { account: 'rl1', name: 'Reception Haan', words: ['haan, interested'], role: 'Front office', add_tags: ['fo-yes'] });
  const tagsFor = async (jid) => (await query(`SELECT tags FROM contacts WHERE account_id = 'rl1' AND jid = $1`, [jid]))[0]?.tags || [];
  const ctx = (jid) => ({ updateContact: (a) => store.updateContact('rl1', jid, a), saveMedia: async () => {}, createTask: async () => {}, sendTemplate: async () => {}, snooze: async () => {} });
  for (const [jid, id] of [['919500000001@s.whatsapp.net', 'RL1'], ['919500000002@s.whatsapp.net', 'RL2']]) {
    await rules.runRules('rl1', { id, chatJid: jid, type: 'text', body: 'Haan, interested' }, { isGroup: false, isNew: false }, ctx(jid));
  }
  assert.deepEqual(await tagsFor('919500000001@s.whatsapp.net'), ['fo-yes']);
  assert.deepEqual(await tagsFor('919500000002@s.whatsapp.net'), ['chef-yes']);
  // save a contact by number + name: appears in the inbox, keeps the name when WhatsApp syncs another one
  const r = await call('POST', '/api/accounts/rl1/contacts', { phone: '9508289325', name: 'Jay Raam (chef, ref Roshan)', savePhone: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.jid, '919508289325@s.whatsapp.net');
  assert.equal(r.data.phone_saved.ok, false); // the fake test phone can't save; the hub save still worked
  const chats = (await call('GET', '/api/accounts/rl1/chats?q=9508289325')).data;
  assert.equal(chats[0]?.name, 'Jay Raam (chef, ref Roshan)');
  await store.upsertContacts('rl1', [{ jid: '919508289325@s.whatsapp.net', name: 'JR', notify: 'Jay' }]);
  await store.upsertChats('rl1', [{ jid: '919508289325@s.whatsapp.net', name: 'JR' }]);
  assert.equal((await call('GET', '/api/accounts/rl1/contacts/919508289325@s.whatsapp.net')).data.name, 'Jay Raam (chef, ref Roshan)');
  assert.equal((await call('GET', '/api/accounts/rl1/chats?q=9508289325')).data[0].name, 'Jay Raam (chef, ref Roshan)');
  // rename from the contact panel / AI
  await mcp('update_contact', { account: 'rl1', chat: '919508289325', name: 'Jay Raam' });
  assert.equal((await call('GET', '/api/accounts/rl1/contacts/919508289325@s.whatsapp.net')).data.name, 'Jay Raam');
  assert.match(await mcp('save_contact', { account: 'rl1', phone: '9500000009', name: 'Sita', group: 'Housekeeping hiring – Referred', reason: 'Test' }), /Saved Sita \(\+919500000009\) in "Housekeeping hiring – Referred"/);
});

test('contact book: people filed by group and found when the need comes up; a shared contact card files the referral and adds a call card', async () => {
  await manager.create({ id: 'dir1', label: 'Dir1' });
  fake('dir1');
  // saved by purpose, kept apart
  await mcp('save_contact', { phone: '9137014662', name: 'Manojkumar Yadav', group: 'Catering', reason: 'Pakati / catering cook, ₹2,500 per day' });
  await mcp('save_contact', { phone: '9137014662', name: 'Manojkumar Yadav', group: 'Chef hiring – Referrers', reason: 'Said he will refer a chef' });
  await mcp('save_contact', { phone: '9811100001', name: 'Sky Travels', group: 'Travel agents', reason: 'Sends corporate groups' });
  const groupsText = await mcp('find_contacts', {});
  for (const g of ['Catering: 1', 'Chef hiring – Referrers: 1', 'Travel agents: 1']) assert.ok(groupsText.includes(g), groupsText);
  assert.match(await mcp('find_contacts', { query: 'caterer' }), /Manojkumar Yadav \| \+919137014662 \| Catering/);
  const chef = await mcp('find_contacts', { query: 'chef' });
  assert.match(chef, /Chef hiring – Referrers/);
  assert.doesNotMatch(chef, /Sky Travels/);
  assert.match(await mcp('find_contacts', { group: 'Travel' }), /Sky Travels/);
  // saving again adds to the reason instead of losing it
  await call('POST', '/api/directory', { phone: '9811100001', name: 'Sky Travels', category: 'Travel agents', reason: 'Booked 3 rooms in Oct' });
  assert.match(await mcp('find_contacts', { query: 'sky' }), /Sends corporate groups · Booked 3 rooms in Oct/);
  // a chef candidate shares a contact card → referred chef + referrer filed, owner card to call
  await mcp('import_list', { account: 'dir1', name: 'Chef – Batch D', role: 'Chef', members: [{ phone: '9739452867', name: 'Roshan' }] });
  const s = manager.get('dir1');
  await s.afterIncoming({ id: 'VC1', chatJid: '919739452867@s.whatsapp.net', senderJid: '919739452867@s.whatsapp.net', fromMe: false, ts: Math.floor(Date.now() / 1000), type: 'contact', body: 'Shared contact', vcards: [{ name: 'Jay Raam', phones: ['919508289325'] }] });
  const referred = await mcp('find_contacts', { query: 'jay' });
  assert.match(referred, /Jay Raam \| \+919508289325 \| Chef hiring – Referred \| Referred by Roshan/);
  assert.match(await mcp('find_contacts', { group: 'Chef hiring – Referrers' }), /Roshan \| \+919739452867 \| Chef hiring – Referrers \| Referred Jay Raam/);
  assert.ok((await call('GET', '/api/tasks?account=dir1')).data.find((t) => /^Call Jay Raam – referred by Roshan/.test(t.title) && t.priority));
  // the dashboard search works the same way
  assert.equal((await call('GET', '/api/directory?q=referred%20roshan')).data.length >= 1, true);
});

test('campaigns stay apart: every message stores its campaign; chats, drafts, cards and the overview filter by it; media can be downloaded', async () => {
  const store = await import('../src/store.js');
  await manager.create({ id: 'cmp1', label: 'Cmp1' });
  fake('cmp1');
  await call('PATCH', '/api/accounts/cmp1', { settings: { aiMode: 'approve' } });
  await mcp('import_list', { account: 'cmp1', name: 'Reception – Batch 1', role: 'Front office', members: [{ phone: '9600000001', name: 'Priya' }] });
  await mcp('import_list', { account: 'cmp1', name: 'Chef – Batch C', role: 'Chef', members: [{ phone: '9600000002', name: 'Ramesh' }] });
  const now = Math.floor(Date.now() / 1000);
  await store.insertMessages('cmp1', [
    { id: 'CM1', fromMe: false, ts: now - 30, chatJid: '919600000001@s.whatsapp.net', type: 'image', body: null, forwarded: false, media: { kind: 'imageMessage', mimetype: 'image/jpeg' } },
    { id: 'CM2', fromMe: false, ts: now - 20, chatJid: '919600000002@s.whatsapp.net', type: 'text', body: 'Haan', forwarded: false },
    { id: 'CM3', fromMe: false, ts: now - 10, chatJid: '919677700003@s.whatsapp.net', type: 'text', body: 'Room available?', forwarded: false },
  ]);
  await store.upsertChats('cmp1', [{ jid: '919600000001@s.whatsapp.net' }, { jid: '919600000002@s.whatsapp.net' }, { jid: '919677700003@s.whatsapp.net' }]);
  // drafts carry their campaign in the database
  const d1 = await mcp('send_message', { account: 'cmp1', to: '919600000001', text: 'Kab aa sakte hain?' });
  const d2 = await mcp('send_message', { account: 'cmp1', to: '919600000002', text: 'Cooking test kab?' });
  const id1 = Number(d1.match(/#(\d+)/)[1]);
  const id2 = Number(d2.match(/#(\d+)/)[1]);
  assert.equal((await query('SELECT role FROM outbox WHERE id = $1', [id1]))[0].role, 'Front office');
  assert.equal((await query('SELECT role FROM outbox WHERE id = $1', [id2]))[0].role, 'Chef');
  // each view filters by campaign
  const fo = (await call('GET', '/api/outbox?account=cmp1&status=draft&role=Front%20office')).data;
  assert.deepEqual(fo.map((r) => r.id), [id1]);
  const chats = (await call('GET', '/api/accounts/cmp1/chats?role=Chef')).data;
  assert.deepEqual(chats.map((c) => c.jid), ['919600000002@s.whatsapp.net']);
  const guests = (await call('GET', '/api/accounts/cmp1/chats?role=none')).data;
  assert.deepEqual(guests.map((c) => c.jid), ['919677700003@s.whatsapp.net']);
  assert.match(await mcp('list_chats', { account: 'cmp1', campaign: 'Front office' }), /919600000001/);
  assert.doesNotMatch(await mcp('list_outbox', { account: 'cmp1', status: 'draft', campaign: 'Chef' }), /Kab aa sakte/);
  assert.match(await mcp('hub_overview', { campaign: 'Front office' }), /FOCUS: campaign "Front office" only/);
  const camps = (await call('GET', '/api/campaigns')).data;
  assert.ok(camps.find((c) => c.role === 'Front office' && c.drafts >= 1));
  // media download names the file and asks the browser to save it
  manager.get('cmp1').downloadMedia = async () => Buffer.from('JPEG');
  const res = await fetch(`${base}/api/media/cmp1/919600000001@s.whatsapp.net/CM1?download=1`, { headers: { 'x-api-key': 'k' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="919600000001-\d{4}-\d{2}-\d{2}-CM1\.jpg"/);
  // a card that names a person on a list joins that campaign by itself
  const card = await mcp('create_task', { account: 'cmp1', title: 'Interview: Ramesh 9600000002 tomorrow', for: 'you' });
  const cid = Number(card.match(/#(\d+)/)[1]);
  assert.equal((await query('SELECT role FROM tasks WHERE id = $1', [cid]))[0].role, 'Chef');
  assert.ok((await call('GET', '/api/tasks?role=Chef')).data.some((t) => t.id === cid));
});

test('calls: answered calls show "answered, m:ss" in the chat (so replies wait for the owner\'s notes); missed calls show as missed', async () => {
  const s = manager.get('hiring');
  const t0 = Date.now() - 600000;
  await s.onCalls([
    { id: 'C1', from: '919800002001@s.whatsapp.net', chatId: '919800002001@s.whatsapp.net', status: 'offer', date: new Date(t0) },
    { id: 'C1', from: '919800002001@s.whatsapp.net', chatId: '919800002001@s.whatsapp.net', status: 'accept', date: new Date(t0 + 5000) },
    { id: 'C1', from: '919800002001@s.whatsapp.net', chatId: '919800002001@s.whatsapp.net', status: 'terminate', date: new Date(t0 + 5000 + 192000) },
    { id: 'C2', from: '919800002002@s.whatsapp.net', chatId: '919800002002@s.whatsapp.net', status: 'offer', date: new Date(t0) },
    { id: 'C2', from: '919800002002@s.whatsapp.net', chatId: '919800002002@s.whatsapp.net', status: 'timeout', date: new Date(t0 + 30000) },
  ]);
  const rows = Object.fromEntries((await query(`SELECT chat_jid, type, body FROM messages WHERE account_id = 'hiring' AND id IN ('call-C1','call-C2')`)).map((r) => [r.chat_jid, r]));
  assert.equal(rows['919800002001@s.whatsapp.net'].body, '📞 Voice call — answered, 3:12');
  assert.equal(rows['919800002001@s.whatsapp.net'].type, 'call');
  assert.equal(rows['919800002002@s.whatsapp.net'].body, '📞 Missed voice call');
  const { parseMessage } = await import('../src/wa/parse.js');
  const p = parseMessage({ key: { id: 'L1', remoteJid: '919800002003@s.whatsapp.net' }, messageTimestamp: 1, message: { callLogMesssage: { isVideo: false, callOutcome: 0, durationSecs: 75 } } });
  assert.equal(p.row.body, '📞 Voice call — answered, 1:15');
});

test('debug run 23 Oct: reply drafts don\'t hold follow-ups; a visit date always makes an Interview card; closing cancels automatic messages; scheduled cards keep their text; undated AI to-dos are due', async () => {
  const listsMod = await import('../src/lists.js');
  const outboxMod = await import('../src/outbox.js');
  const board = await import('../src/board.js');
  await manager.create({ id: 'dbg1', label: 'Dbg1' });
  fake('dbg1');
  const now = Math.floor(Date.now() / 1000);
  const J = (n) => `91973300000${n}@s.whatsapp.net`;
  await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body) VALUES ('dbg1',$1,'D1',false,$2,'text','kab aana hai?')`, [J(1), now - 600]);
  await mcp('import_list', { account: 'dbg1', name: 'Chef – Dbg', members: [{ phone: '9733000001', name: 'Ravi Kumar' }, { phone: '9733000002', name: 'Sunil' }] });
  // a reply drafted for someone already chatting is not "new outreach" — follow-ups may still go today
  await mcp('send_message', { account: 'dbg1', to: '9733000001', text: 'Kal 11 baje aaiye' });
  assert.equal(await outboxMod.newOutreachToday('dbg1'), false, 'a pending reply draft must not block follow-ups');
  // "interested" sent together with a visit date → date_given + Interview card for the owner
  await mcp('update_list_member', { list: 'Chef – Dbg', phone: '9733000001', stage: 'interested', visit_at: '2026-12-01 11:00' });
  const l = await listsMod.getList('Chef – Dbg');
  const [m] = await query('SELECT stage FROM list_members WHERE list_id = $1 AND jid = $2', [l.id, J(1)]);
  assert.equal(m.stage, 'date_given');
  const [card] = await query(`SELECT assignee, priority FROM tasks WHERE ref = $1 AND status NOT IN ('done','cancelled')`, [`visit:${l.id}:${J(1)}`]);
  assert.ok(card && card.assignee === 'you' && card.priority, 'interview card for the owner, priority');
  // closing a person cancels the automatic messages still waiting for them
  await query(`INSERT INTO outbox (account_id, to_jid, payload, source, status, note, list_id) VALUES ('dbg1',$1,'{"text":"follow up"}','campaign','draft','follow-up',$2)`, [J(2), l.id]);
  await mcp('update_list_member', { list: 'Chef – Dbg', phone: '9733000002', stage: 'not_interested' });
  const [fu] = await query(`SELECT status FROM outbox WHERE to_jid = $1 AND note = 'follow-up'`, [J(2)]);
  assert.equal(fu.status, 'rejected', 'no follow-up to a not-interested person');
  // a scheduled message card keeps every letter
  await outboxMod.enqueue({ account: 'dbg1', to: '9733000001', payload: { text: 'Namaste sir, kal milte hain' }, source: 'dashboard', scheduledAt: new Date(Date.now() + 3 * 3600e3).toISOString() });
  await board.syncScheduled();
  const [sc] = await query(`SELECT details FROM tasks WHERE ref LIKE 'sched:%' AND account_id = 'dbg1' ORDER BY id DESC LIMIT 1`);
  assert.match(sc.details, /Namaste sir, kal milte hain/);
  // an AI to-do without a date shows in due_now
  await mcp('create_task', { account: 'dbg1', title: 'Send Ravi the menu', for: 'ai' });
  assert.match(await mcp('list_tasks', { for: 'ai', due_now: true, account: 'dbg1' }), /Send Ravi the menu/);
});

test('debug run 2: files with Hindi names download; Activity can show only problems', async () => {
  const store = await import('../src/store.js');
  await manager.create({ id: 'dbg2', label: 'Dbg2' });
  fake('dbg2');
  await store.insertMessages('dbg2', [{ id: 'HN1', fromMe: false, ts: Math.floor(Date.now() / 1000), chatJid: '919733100001@s.whatsapp.net', type: 'document', body: null, forwarded: false,
    media: { kind: 'documentMessage', mimetype: 'application/pdf', fileName: 'रिज्यूम Ravi.pdf' } }]);
  manager.get('dbg2').downloadMedia = async () => Buffer.from('%PDF');
  const res = await fetch(`${base}/api/media/dbg2/919733100001@s.whatsapp.net/HN1?download=1`, { headers: { 'x-api-key': 'k' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /filename\*=UTF-8''%E0%A4/);
  await query(`INSERT INTO events (account_id, level, text) VALUES ('dbg2','warn','Follow-ups for "X" failed: test'), ('dbg2','info','all good')`);
  const probs = (await call('GET', '/api/events?account=dbg2&problems=1')).data;
  assert.ok(probs.length >= 1 && probs.every((e) => ['warn', 'error'].includes(e.level)));
  // Meta username senders (no phone) each get their own chat
  const { jidOf } = await import('../src/wa/cloud.js');
  assert.equal(jidOf('91 98765 43210'), '919876543210@s.whatsapp.net');
  assert.equal(jidOf(undefined, 'IN.AbC123'), 'IN.AbC123@bsuid');
  assert.equal(jidOf('', ''), null);
});

test('other countries: bare numbers get COUNTRY_CODE, typed times use TZ_NAME (template owners outside India)', async () => {
  const config = (await import('../src/config.js')).default;
  const { toJid } = await import('../src/store.js');
  const { localDate } = await import('../src/util.js');
  assert.equal(toJid('98765 43210'), '919876543210@s.whatsapp.net');
  const saved = { cc: config.countryCode, len: config.localLen };
  Object.assign(config, { countryCode: '971', localLen: 9 });
  try {
    assert.equal(toJid('501234567'), '971501234567@s.whatsapp.net');
    assert.equal(toJid('0501234567'), '971501234567@s.whatsapp.net');
  } finally {
    Object.assign(config, { countryCode: saved.cc, localLen: saved.len });
  }
  assert.equal(localDate('2026-10-25 10:00', 'Asia/Kolkata').toISOString(), '2026-10-25T04:30:00.000Z');
  assert.equal(localDate('2026-10-25', 'Asia/Dubai').toISOString(), '2026-10-25T06:00:00.000Z');
});

test('pipeline: no generic "which day?" when we already wrote to them after they said interested (Jagdish, 24 Oct)', async () => {
  const listsMod = await import('../src/lists.js');
  await manager.create({ id: 'dbg3', label: 'Dbg3' });
  fake('dbg3');
  await manager.update('dbg3', { settings: { aiMode: 'approve' } });
  await mcp('import_list', { account: 'dbg3', name: 'Chef – Dbg3', members: [{ phone: '9733200001', name: 'Jagdish' }, { phone: '9733200002', name: 'Mohan' }] });
  const l = await listsMod.getList('Chef – Dbg3');
  for (const p of ['9733200001', '9733200002']) await mcp('update_list_member', { list: 'Chef – Dbg3', phone: p, stage: 'interested' });
  await query(`UPDATE list_members SET stage_at = now() - interval '6 hours', updated_at = now() - interval '6 hours' WHERE list_id = $1`, [l.id]);
  // we asked Jagdish for his time 2 hours ago; Mohan heard nothing since saying interested
  await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body) VALUES ('dbg3','919733200001@s.whatsapp.net','J1',true,$1,'text','Kal kitne baje aayenge?')`, [Math.floor(Date.now() / 1000) - 7200]);
  await listsMod.runPipeline();
  const asks = await query(`SELECT to_jid FROM outbox WHERE list_id = $1 AND note = 'ask-date'`, [l.id]);
  assert.deepEqual(asks.map((r) => r.to_jid), ['919733200002@s.whatsapp.net'], 'only Mohan gets the automatic ask');
});

test('MCP: every tool answers without an error (whole AI toolbox, in the order a session would use it)', async () => {
  const post = (body) => fetch(`${base}/mcp/k`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
  const raw = async (name, args = {}) => {
    const j = await (await post({ jsonrpc: '2.0', id: ++mcpId, method: 'tools/call', params: { name, arguments: args } })).json();
    const text = j.result?.content?.[0]?.text ?? JSON.stringify(j.error);
    return { text, bad: !!j.error || !!j.result?.isError || /^Error:/.test(text) };
  };
  const list = await (await post({ jsonrpc: '2.0', id: ++mcpId, method: 'tools/list', params: {} })).json();
  const names = list.result.tools.map((t) => t.name);
  await manager.create({ id: 'mcpall', label: 'McpAll' });
  fake('mcpall');
  await manager.update('mcpall', { settings: { aiMode: 'approve' } });
  const now = Math.floor(Date.now() / 1000);
  const P = '919733300001';
  const J = `${P}@s.whatsapp.net`;
  await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body) VALUES ('mcpall',$1,'M1',false,$2,'text','Haan interested, kab aana hai?')`, [J, now - 600]);
  await query(`INSERT INTO messages (account_id, chat_jid, id, from_me, ts, type, body, media) VALUES ('mcpall',$1,'M2',false,$2,'document','cv.pdf','{"kind":"documentMessage","mimetype":"application/pdf","fileName":"cv.pdf"}')`, [J, now - 500]);
  await (await import('../src/store.js')).upsertChats('mcpall', [{ jid: J, name: 'Toolbox Ravi' }]);
  manager.get('mcpall').saveMedia = async () => 'db:test';
  manager.get('mcpall').fetchOlder = async () => 'requested'; // the fake has no phone behind it
  const done = {};
  const run = async (name, args) => {
    const r = await raw(name, args);
    done[name] = true;
    assert.ok(!r.bad, `${name} failed: ${r.text.slice(0, 300)}`);
    return r.text;
  };
  const idOf = (text) => Number(text.match(/#(\d+)/)[1]);
  await run('hub_overview', {});
  await run('list_accounts', {});
  await run('get_playbook', {});
  await run('import_list', { account: 'mcpall', name: 'Chef – Toolbox', members: [{ phone: P, name: 'Toolbox Ravi' }, { phone: '9733300002', name: 'Second' }] });
  await run('list_lists', { account: 'mcpall' });
  await run('list_members', { list: 'Chef – Toolbox' });
  await run('known_candidates', { role: 'Chef' });
  await run('pipeline', { role: 'Chef' });
  await run('set_pipeline', { list: 'Chef – Toolbox', ask_date_after_hours: 6 });
  await run('set_followup', { list: 'Chef – Toolbox', enabled: true, after_days: 2, max: 1, text: 'follow up {first_name}' });
  await run('update_list_member', { list: 'Chef – Toolbox', phone: P, stage: 'interested', available_from: '2026-12-10', follow_up_note: 'free after 10 Dec' });
  await run('list_chats', { account: 'mcpall', campaign: 'Chef' });
  await run('get_messages', { account: 'mcpall', chat: P });
  await run('search_messages', { query: 'interested', account: 'mcpall' });
  await run('list_shared_contacts', { account: 'mcpall' });
  await run('find_followups', { account: 'mcpall', inactive_days: 1 });
  await run('get_contact', { account: 'mcpall', chat: P });
  await run('update_contact', { account: 'mcpall', chat: P, add_tags: ['candidate'], summary: 'Chef, free after 10 Dec' });
  await run('find_person', { query: P });
  await run('save_contact', { phone: '9733300009', name: 'Naresh', group: 'Chef hiring – Referrers', reason: 'Referred Ravi', account: 'mcpall' });
  await run('find_contacts', { query: 'chef' });
  await run('list_templates', {});
  await run('save_template', { name: 'Toolbox ask', body: 'Namaste {first_name}, kab aa sakte hain?' });
  const d1 = await run('send_message', { account: 'mcpall', to: P, template: 'Toolbox ask', note: 'ask the day' });
  const d2 = await run('send_message', { account: 'mcpall', to: P, text: 'Kal 11 baje aaiye', schedule_at: '2026-12-09 10:00' });
  await run('list_outbox', { account: 'mcpall', status: 'draft' });
  await run('approve_draft', { id: idOf(d1) });
  await run('reject_draft', { id: idOf(d2), reason: 'too early' });
  await manager.create({ id: 'mcpall2', label: 'McpAll2' });
  fake('mcpall2');
  const d3 = await run('send_message', { account: 'mcpall', to: P, text: 'move me' });
  await run('move_messages', { ids: [idOf(d3)], account: 'mcpall2' });
  const b = await run('bulk_send', { account: 'mcpall', title: 'Toolbox bulk', text: 'Hi {name}', recipients: [{ to: '9733300003', name: 'Three' }] });
  await run('approve_task', { id: idOf(b) });
  await run('send_to_list', { list: 'Chef – Toolbox', statuses: ['new'], text: 'Namaste {first_name}' });
  const t = await run('create_task', { account: 'mcpall', title: 'Call Ravi 9733300001', for: 'you', priority: true, due: '2026-12-09 11:00' });
  await run('update_task', { id: idOf(t), due: '2026-12-09 12:00', campaign: 'Chef' });
  await run('add_task_note', { id: idOf(t), text: 'Drafted the ask' });
  await run('task_history', { id: idOf(t) });
  await run('log_call_result', { id: idOf(t), result: 'call_back', at: '2026-12-10 18:00', note: 'busy at work' });
  await run('list_tasks', { for: 'you' });
  await run('list_rules', {});
  await run('save_rule', { account: 'mcpall', name: 'Toolbox rule', words: ['resume'], add_tags: ['cv'] });
  await run('set_chat_state', { account: 'mcpall', chat: P, state: 'snoozed', until: '2026-12-09 09:00', note: 'check' });
  await run('save_media', { account: 'mcpall', chat: P, message_id: 'M2' });
  await run('fetch_older_messages', { account: 'mcpall', chat: P, count: 10 });
  await run('backfill_history', { account: 'mcpall', since: '2026-01-01' });
  await run('recent_activity', { who: 'ai' });
  await run('remove_list_member', { list: 'Chef – Toolbox', phones: ['9733300002'] });
  await run('archive_list', { list: 'Chef – Toolbox', reason: 'toolbox test' });
  await run('save_playbook', { text: (await raw('get_playbook')).text });
  // Meta-only tools on a linked number answer with a clear explanation, not an error
  await run('list_meta_templates', { account: 'mcpall' });
  await run('meta_health_check', { account: 'mcpall' });
  await run('message_timeline', { account: 'mcpall', q: P });
  await run('create_meta_template', { account: 'mcpall', name: 'x_test', body: 'Hi {{1}} there', examples: ['A'] });
  assert.deepEqual(names.filter((n) => !done[n]), [], 'every MCP tool is exercised here');
});

test('REST: /api/help lists every endpoint for script writers', async () => {
  const r = (await call('GET', '/api/help')).data;
  assert.ok(r.routes.includes('POST /api/send') && r.routes.includes('GET /api/tasks') && r.routes.length > 50, JSON.stringify(r.routes.slice(0, 5)));
  assert.match(r.auth, /x-api-key/);
});

test('one-tap call results: each result does the bookkeeping and hands on the next step', async () => {
  const tasksMod = await import('../src/tasks.js');
  await manager.create({ id: 'calls1', label: 'Calls1' });
  fake('calls1');
  await mcp('import_list', { account: 'calls1', name: 'Chef – Calls', members: [1, 2, 3, 4, 5].map((i) => ({ phone: `973340000${i}`, name: `Cand${i} Kumar` })) });
  const card = async (i) => (await call('POST', '/api/tasks', { account: 'calls1', title: `Call Cand${i} 973340000${i}`, assignee: 'you' })).data.id;
  const res = async (id, body) => call('POST', `/api/tasks/${id}/call-result`, body);
  // interested → stage + AI card, original card closed with the note
  const c1 = await card(1);
  const r1 = (await res(c1, { result: 'interested' })).data;
  assert.equal((await query('SELECT stage FROM list_members WHERE jid = $1', ['919733400001@s.whatsapp.net']))[0].stage, 'interested');
  assert.equal(r1.card.assignee, 'ai');
  assert.match(r1.card.details, /\+919733400001/);
  const [t1] = await query('SELECT status FROM tasks WHERE id = $1', [c1]);
  assert.equal(t1.status, 'done');
  assert.ok((await tasksMod.taskLog(c1)).some((l) => /📞 Call: answered — interested/.test(l.text)));
  // the owner's call note is not left as an "owner note to act on" (the new card carries it)
  const [p1] = (await tasksMod.listTasks({ past: true, limit: 500 })).filter((t) => t.id === c1);
  assert.equal(p1.owner_note_pending, false);
  // date → interview card for the owner at that time
  const c2 = await card(2);
  assert.equal((await res(c2, { result: 'date' })).status, 400, 'a date is needed');
  await res(c2, { result: 'date', at: '2026-12-05T11:00' });
  const [v] = await query(`SELECT due_at, assignee, priority FROM tasks WHERE ref LIKE 'visit:%:919733400002@s.whatsapp.net' AND status NOT IN ('done','cancelled')`);
  assert.equal(new Date(v.due_at).toISOString(), '2026-12-05T05:30:00.000Z');
  assert.ok(v.assignee === 'you' && v.priority);
  // no answer → AI card to message them
  const c3 = await card(3);
  const r3 = (await res(c3, { result: 'no_answer' })).data;
  assert.match(r3.card.title, /no answer/);
  // call back → owner card at that time
  const c4 = await card(4);
  const r4 = (await res(c4, { result: 'call_back', at: '2026-12-06 18:30' })).data;
  assert.equal(new Date(r4.card.due_at).toISOString(), '2026-12-06T13:00:00.000Z');
  assert.ok(r4.card.priority && r4.card.assignee === 'you');
  // not interested → closed stage, no new card; automatic messages to them cancelled
  const c5 = await card(5);
  const [l] = await query(`SELECT id FROM lists WHERE name = 'Chef – Calls'`);
  await query(`INSERT INTO outbox (account_id, to_jid, payload, source, status, note, list_id) VALUES ('calls1','919733400005@s.whatsapp.net','{"text":"fu"}','campaign','draft','follow-up',$1)`, [l.id]);
  const r5 = (await res(c5, { result: 'not_interested', note: 'has a job' })).data;
  assert.equal(r5.card, null);
  assert.equal((await query('SELECT stage, outcome FROM list_members WHERE jid = $1', ['919733400005@s.whatsapp.net']))[0].stage, 'not_interested');
  assert.equal((await query(`SELECT status FROM outbox WHERE to_jid = '919733400005@s.whatsapp.net'`))[0].status, 'rejected');
  // the AI can log one too (when the owner tells it), and a card with no number says so
  const c6 = await card(1);
  assert.match(await mcp('log_call_result', { id: c6, result: 'no_answer' }), /no answer/);
  const plain = (await call('POST', '/api/tasks', { account: 'calls1', title: 'Buy flowers' })).data.id;
  assert.match((await res(plain, { result: 'interested' })).data.error, /No phone number/);
});

test('morning summary: right content, once a day, only from the number that is connected here, within 6 h of the time', async () => {
  const digest = await import('../src/digest.js');
  await manager.create({ id: 'dig1', label: 'Dig1' });
  fake('dig1');
  await call('PUT', '/api/alerts', { phones: '6361321377' });
  await digest.saveDigest({ enabled: true, time: '06:00', account: 'dig1' });
  const today = new Date();
  await query(`INSERT INTO tasks (account_id, title, kind, status, due_at, assignee, priority, ref) VALUES
    ('dig1','Interview: Morning Test — Sat', 'visit', 'upcoming', now() + interval '2 hours', 'you', true, 'visit:999:919733500001@s.whatsapp.net'),
    ('dig1','Call Digest Person 9733500002', 'todo', 'upcoming', now() - interval '1 hour', 'you', true, NULL)`);
  const { text } = await digest.buildDigest(today);
  assert.match(text, /Good morning/);
  assert.match(text, /Interviews today \(\d+\)/);
  assert.match(text, /Morning Test/);
  assert.match(text, /⭐ Call Digest Person/);
  // an interview card written by hand ("Interview: …", kind todo) is an interview, not a to-do
  await query(`INSERT INTO tasks (account_id, title, kind, status, due_at, assignee, priority) VALUES ('dig1','Interview: Hand Made Cook — 11:00', 'todo', 'upcoming', now() + interval '3 hours', 'you', true)`);
  const t2 = (await digest.buildDigest(today)).text;
  const [interviews, rest] = t2.split('✅');
  assert.match(interviews, /Hand Made Cook/);
  assert.doesNotMatch(rest || '', /Hand Made Cook/);
  const sentTo = [];
  const send = async (from, to, t) => sentTo.push({ from, to, t });
  // at 06:30 India time it goes once; a second run the same day does nothing
  const at = (h, m) => new Date(`${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`);
  await query(`UPDATE config SET value = value - 'lastDate' WHERE key = 'digest'`);
  assert.equal(await digest.runDigest(manager, send, { now: at(5, 59) }), null, 'not before 06:00');
  assert.ok(await digest.runDigest(manager, send, { now: at(6, 30) }));
  assert.equal(await digest.runDigest(manager, send, { now: at(7, 0) }), null, 'only once a day');
  assert.deepEqual(sentTo.map((x) => [x.from, x.to]), [['dig1', '916361321377']]);
  // after a long outage: no "good morning" in the afternoon
  await query(`UPDATE config SET value = value - 'lastDate' WHERE key = 'digest'`);
  assert.equal(await digest.runDigest(manager, send, { now: at(13, 0) }), null);
  // a number not connected on this server never sends (the server that holds it will)
  manager.get('dig1').status = 'elsewhere';
  assert.equal(await digest.runDigest(manager, send, { now: at(6, 30) }), null);
  manager.get('dig1').status = 'open';
  // settings + a test send through the API
  assert.equal((await call('GET', '/api/digest')).data.time, '06:00');
  assert.equal((await call('POST', '/api/digest/test')).status, 200);
  await digest.saveDigest({ account: 'guests' });
});

test('MCP response budget: long answers are cut at a line and say what was left out', async () => {
  const { budget } = await import('../src/mcp.js');
  const long = Array.from({ length: 3000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
  const out = budget(long);
  assert.ok(out.length < 16400);
  assert.match(out, /more line\(s\) not shown/);
  assert.equal(budget('short'), 'short');
});

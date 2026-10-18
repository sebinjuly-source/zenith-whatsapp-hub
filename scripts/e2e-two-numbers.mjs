/**
 * Live end-to-end test between two linked numbers (they message each other through the cloud server).
 * Checks every step in the database: each side stores its own copy, directions mirror, no mixing.
 * Usage: node scripts/e2e-two-numbers.mjs <accountA> <accountB>
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
  results.push({ test: name, result: ok ? 'PASS' : 'FAIL', detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};
const api = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180000) });
  const t = await r.text();
  try {
    return { status: r.status, data: JSON.parse(t) };
  } catch {
    return { status: r.status, data: t };
  }
};
const mcp = async (name, args) => {
  const r = await fetch(`${BASE}/mcp/${KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await r.json()).result.content[0].text;
};
async function until(fn, ms = 90000) {
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
const jidA = `${pa.phone}@s.whatsapp.net`;
const jidB = `${pb.phone}@s.whatsapp.net`;
const stamp = new Date().toISOString().slice(11, 19);

/** Send from `from` to `to`; then verify both sides stored it with mirrored direction. */
async function sendAndVerify(label, from, toJid, fromJid, to, payload, via = 'api') {
  let r;
  if (via === 'webhook') {
    const res = await fetch(`${BASE}/webhook?key=${KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, account: from, phone: toJid.split('@')[0] }), signal: AbortSignal.timeout(180000) });
    const t = await res.text();
    check(`${label}: /webhook returns 200 Success`, res.status === 200 && t === 'Success', `${res.status} ${t}`);
    const [o] = await q(`SELECT message_id FROM outbox WHERE account_id = $1 AND status = 'sent' ORDER BY id DESC LIMIT 1`, [from]);
    r = { message_id: o?.message_id };
  } else {
    const res = await api('POST', '/api/send', { account: from, to: toJid, ...payload });
    check(`${label}: sent`, res.status === 200 && res.data.status === 'sent', `${res.data.status || res.data.error}`);
    r = res.data;
  }
  const id = r.message_id;
  const mine = await until(async () => (await q('SELECT * FROM messages WHERE account_id = $1 AND chat_jid = $2 AND id = $3', [from, toJid, id]))[0]);
  check(`${label}: stored in ${from} as outgoing`, mine && mine.from_me === true, mine ? `type ${mine.type}` : 'not found');
  const theirs = await until(async () => (await q('SELECT * FROM messages WHERE account_id = $1 AND chat_jid = $2 AND id = $3', [to, fromJid, id]))[0]);
  check(`${label}: received by ${to} as incoming, in the right chat`, theirs && theirs.from_me === false, theirs ? `type ${theirs.type}${theirs.media ? ', ' + (theirs.media.fileName || theirs.media.mimetype) : ''}` : 'not received');
  return { id, mine, theirs };
}

console.log(`Testing ${A} (+${pa.phone}) ⇄ ${B} (+${pb.phone}) at ${stamp}\n`);

// 1. text both ways
await sendAndVerify('1. Text A→B', A, jidB, jidA, B, { text: `[2-number test ${stamp}] Text from ${A} to ${B} ✅` });
await sendAndVerify('2. Text B→A', B, jidA, jidB, A, { text: `[2-number test ${stamp}] Text from ${B} to ${A} ✅` });

// 2. legacy dental-bot format from the non-default number
await sendAndVerify('3. Old /webhook format from B (account chosen)', B, jidA, jidB, A, { message: `[2-number test ${stamp}] Old /webhook format, sent from ${B}` }, 'webhook');

// 3. files from B
const dl = path.join(os.homedir(), 'Downloads');
const img = fs.readFileSync(path.join(dl, 'View from room.jpeg'));
const pdf = fs.readFileSync(path.join(dl, 'Zenith Suites Automation Map.pdf'));
const im = await sendAndVerify('4. Image B→A', B, jidA, jidB, A, { attachment: { base64: img.toString('base64'), fileName: 'View from room.jpeg', caption: `[2-number test ${stamp}] Image from ${B}` } });
await sendAndVerify('5. PDF B→A', B, jidA, jidB, A, { attachment: { base64: pdf.toString('base64'), fileName: 'Automation Map.pdf', mimetype: 'application/pdf', caption: `[2-number test ${stamp}] PDF from ${B}` } });

// 4. the receiving number can download/save the media it received
if (im.theirs) {
  const s = await mcp('save_media', { account: A, chat: jidB.split('@')[0], message_id: im.id });
  const f = await fetch(`${BASE}/api/media/${A}/${encodeURIComponent(jidB)}/${im.id}?key=${KEY}`);
  const buf = Buffer.from(await f.arrayBuffer());
  check(`6. ${A} saves the image it received`, /Saved/.test(s) && f.status === 200 && buf.length > 1000, `${f.status}, ${buf.length} bytes`);
  const [row] = await q('SELECT media_saved FROM messages WHERE account_id = $1 AND id = $2', [A, im.id]);
  check('6b. saved copy is filed under the receiving number', row?.media_saved?.includes(`${A}/`), row?.media_saved);
}

// 5. opt-out is per number: A sends "STOP" to B → only B's contact for A gets tagged
await api('POST', '/api/send', { account: A, to: jidB, text: 'STOP' });
const tagged = await until(async () => (await q(`SELECT tags FROM contacts WHERE account_id = $1 AND jid = $2 AND 'opted-out' = ANY(tags)`, [B, jidA]))[0], 60000);
check(`7. "STOP" from ${A} tags it opted-out in ${B}`, !!tagged);
const [other] = await q(`SELECT tags FROM contacts WHERE account_id = $1 AND jid = $2`, [A, jidB]);
check(`7b. ...and does not touch ${A}'s own contacts`, !other?.tags?.includes('opted-out'), JSON.stringify(other?.tags || []));
const blocked = await mcp('bulk_send', { account: B, title: `Opt-out check ${stamp}`, text: 'should be skipped', recipients: [{ to: jidA.split('@')[0] }], skip_if_contacted_days: 0 });
check(`7c. bulk send from ${B} skips the opted-out number`, /opted out/.test(blocked), blocked.split('\n').pop());
await api('PATCH', `/api/accounts/${B}/contacts/${jidA}`, { removeTags: ['opted-out'], addTags: ['own-number'] });
await api('PATCH', `/api/accounts/${A}/contacts/${jidB}`, { addTags: ['own-number'] });

// 6. AI flow on B: draft → approve → sent; task board per number
const d = await mcp('send_message', { account: B, to: jidA.split('@')[0], text: `[2-number test ${stamp}] AI draft from ${B}, approved via MCP`, note: 'two-number test' });
const draftId = Number(d.match(/#(\d+)/)?.[1]);
check(`8. AI message on ${B} becomes a draft (approve mode)`, /Draft #/.test(d), d);
await mcp('approve_draft', { id: draftId });
const sentDraft = await until(async () => (await q(`SELECT status FROM outbox WHERE id = $1 AND status = 'sent'`, [draftId]))[0], 120000);
check('8b. approved draft is sent by the right number', !!sentDraft && (await q('SELECT account_id FROM outbox WHERE id = $1', [draftId]))[0].account_id === B);

const bs = await mcp('bulk_send', { account: B, title: `Two-number bulk test ${stamp}`, text: `[2-number test ${stamp}] Bulk from ${B} to {name}`, recipients: [{ to: jidA.split('@')[0], name: 'Hotel desk' }, { to: '123' }], skip_if_contacted_days: 0 });
const taskId = Number(bs.match(/Task #(\d+)/)?.[1]);
check(`9. bulk send on ${B} creates a task on ${B}'s board`, !!taskId, bs.replace(/\n/g, ' | '));
await mcp('approve_task', { id: taskId });
const done = await until(async () => (await q(`SELECT status FROM tasks WHERE id = $1 AND status = 'done'`, [taskId]))[0], 120000);
check('9b. task sends and moves to Done', !!done);
const boardA = await mcp('list_tasks', { account: A, past: true });
check(`9c. ${B}'s task does not appear on ${A}'s board`, !boardA.includes(`#${taskId} `));

// 7. reads stay per number
const chatsB = await mcp('list_chats', { account: B, query: pa.phone });
const chatsA = await mcp('list_chats', { account: A, query: pb.phone });
check(`10. ${B}'s chat list shows its chat with ${A}`, chatsB.includes(jidA));
check(`10b. ${A}'s chat list shows its chat with ${B}`, chatsA.includes(jidB));
const sAll = await mcp('search_messages', { query: `2-number test ${stamp}`, limit: 50 });
const accs = new Set(sAll.split('\n').map((l) => l.split(' | ')[0]));
check('11. search across numbers labels each hit with its number', accs.has(A) && accs.has(B), [...accs].join(', '));
const sB = await mcp('search_messages', { query: `2-number test ${stamp}`, account: B, limit: 50 });
check('11b. search limited to one number returns only that number', sB.split('\n').every((l) => l.startsWith(B + ' ')));

// 8. delivery/read receipts recorded on the sending side
const st = await q(`SELECT status FROM messages WHERE account_id = $1 AND chat_jid = $2 AND from_me AND body LIKE $3`, [B, jidA, `%${stamp}%`]);
check(`12. delivery receipts recorded for ${B}'s messages`, st.length > 0 && st.every((r) => r.status >= 2), st.map((r) => r.status).join(','));

console.table(results);
console.log(`${results.filter((r) => r.result === 'PASS').length}/${results.length} passed`);
await db.end();

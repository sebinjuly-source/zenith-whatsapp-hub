/**
 * Feeds fake Baileys events through a Session (no WhatsApp connection) into a throwaway embedded
 * database, then checks what ended up stored. Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
process.env.LOCAL_DB_DIR = dir;
process.env.DATABASE_URL = '';
process.env.API_KEY = 'test';
process.env.LOG_LEVEL = 'error';

const { initDb, query, closeDb } = await import('../src/db.js');
const { Session } = await import('../src/wa/session.js');
const store = await import('../src/store.js');
const { normalizeSettings, randomDelayMs, insideSendingWindow } = await import('../src/settings.js');

await initDb();
await query(`INSERT INTO accounts (id, label, settings) VALUES ('t', 'Test', $1)`, [JSON.stringify(normalizeSettings({}))]);
const account = (await query(`SELECT * FROM accounts WHERE id = 't'`))[0];
const s = new Session(account);

const LID = '111111111111111@lid';
const PN = '919900000003@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const ts = 1760000000;
const vcard = 'BEGIN:VCARD\nVERSION:3.0\nFN:Anita Rao\nORG:Sea View Resorts;\nTEL;type=CELL;waid=919812345678:+91 98123 45678\nEND:VCARD';

test('history sync stores chats, contacts, messages', async () => {
  await s.onHistory({
    syncType: 2,
    progress: 40,
    contacts: [{ id: '919900000001@s.whatsapp.net', name: 'Priya (saved)', notify: 'Priya' }],
    chats: [
      { id: '919900000001@s.whatsapp.net', unreadCount: 1, conversationTimestamp: ts + 50 },
      { id: GROUP, name: 'Hotel Leads Bangalore', conversationTimestamp: ts + 60 },
      { id: LID, conversationTimestamp: ts + 20 },
    ],
    messages: [
      { key: { remoteJid: '919900000001@s.whatsapp.net', id: 'P1', fromMe: false }, messageTimestamp: ts + 10, pushName: 'Priya', message: { conversation: 'Hello, I saw your job post for receptionist' } },
      { key: { remoteJid: '919900000001@s.whatsapp.net', id: 'P2', fromMe: true }, messageTimestamp: ts + 50, message: { extendedTextMessage: { text: 'Please send your resume', contextInfo: { stanzaId: 'P1', quotedMessage: { conversation: 'Hello, I saw your job post for receptionist' } } } } },
      { key: { remoteJid: '919900000001@s.whatsapp.net', id: 'P3', fromMe: false }, messageTimestamp: ts + 55, message: { documentMessage: { fileName: 'Priya_Resume.pdf', mimetype: 'application/pdf', fileLength: 120000, mediaKey: Buffer.from('k'), directPath: '/v/t62/abc', url: 'https://mmg.whatsapp.net/x' } } },
      { key: { remoteJid: GROUP, id: 'G1', fromMe: false, participant: '222222222222222@lid', participantAlt: '919900000002@s.whatsapp.net' }, messageTimestamp: ts + 60, pushName: 'Agent Suresh', message: { contactMessage: { displayName: 'Anita Rao', vcard } } },
      { key: { remoteJid: LID, id: 'L1', fromMe: false }, messageTimestamp: ts + 15, pushName: 'Ravi', message: { conversation: 'Is the job still open?' } },
      { key: { remoteJid: LID, id: 'L2', fromMe: true }, messageTimestamp: ts + 20, message: { conversation: 'Yes, come tomorrow' } },
      { key: { remoteJid: 'status@broadcast', id: 'S1', fromMe: false }, messageTimestamp: ts, message: { conversation: 'status update' } },
    ],
  });
  await s.work;
  const msgs = await query(`SELECT id, chat_jid, type FROM messages WHERE account_id = 't' ORDER BY ts`);
  assert.deepEqual(msgs.map((m) => m.id), ['P1', 'L1', 'L2', 'P2', 'P3', 'G1']);
  assert.equal(s.sync.messages, 6);
  const doc = await query(`SELECT media FROM messages WHERE id = 'P3'`);
  assert.equal(doc[0].media.fileName, 'Priya_Resume.pdf');
  assert.ok(doc[0].media.mediaKey, 'media key kept for later download');
});

test('group sender lid is resolved to phone; vCard parsed', async () => {
  const g = (await query(`SELECT sender_jid, sender_name, vcards, body FROM messages WHERE id = 'G1'`))[0];
  assert.equal(g.sender_jid, '919900000002@s.whatsapp.net');
  assert.equal(g.sender_name, 'Agent Suresh');
  assert.deepEqual(g.vcards[0].phones, ['919812345678']);
  assert.equal(g.vcards[0].org, 'Sea View Resorts');
  const chat = (await query(`SELECT name, is_group FROM chats WHERE jid = $1`, [GROUP]))[0];
  assert.equal(chat.name, 'Hotel Leads Bangalore');
  assert.equal(chat.is_group, true);
});

test('lid chat merges into phone chat when the mapping arrives', async () => {
  assert.equal((await query(`SELECT count(*)::int n FROM messages WHERE chat_jid = $1`, [LID]))[0].n, 2);
  await store.saveLidMappings('t', [{ lid: LID, pn: PN }]);
  assert.equal((await query(`SELECT count(*)::int n FROM messages WHERE chat_jid = $1`, [LID]))[0].n, 0);
  assert.equal((await query(`SELECT count(*)::int n FROM messages WHERE chat_jid = $1`, [PN]))[0].n, 2);
  assert.equal((await query(`SELECT count(*)::int n FROM chats WHERE jid = $1`, [LID]))[0].n, 0);
  const c = (await query(`SELECT last_preview, last_from_me FROM chats WHERE jid = $1`, [PN]))[0];
  assert.equal(c.last_preview, 'Yes, come tomorrow');
  // a new live message on the lid now lands in the phone chat
  await s.ingest([{ key: { remoteJid: LID, id: 'L3', fromMe: false }, messageTimestamp: ts + 100, message: { conversation: 'Thanks!' } }], { live: false });
  assert.equal((await query(`SELECT chat_jid FROM messages WHERE id = 'L3'`))[0].chat_jid, PN);
});

test('edits, deletes and reactions update the original message', async () => {
  await s.ingest([
    { key: { remoteJid: PN, id: 'E1', fromMe: true }, messageTimestamp: ts + 110, message: { protocolMessage: { type: 14, key: { id: 'L2' }, editedMessage: { conversation: 'Yes, come tomorrow at 11' } } } },
    { key: { remoteJid: '919900000001@s.whatsapp.net', id: 'R1', fromMe: false }, messageTimestamp: ts + 111, message: { protocolMessage: { type: 0, key: { id: 'P1' } } } },
    { key: { remoteJid: PN, id: 'X1', fromMe: false }, messageTimestamp: ts + 112, message: { reactionMessage: { key: { id: 'L2' }, text: '👍' } } },
  ]);
  const l2 = (await query(`SELECT body, edited, reactions FROM messages WHERE id = 'L2'`))[0];
  assert.equal(l2.body, 'Yes, come tomorrow at 11');
  assert.equal(l2.edited, true);
  assert.equal(Object.values(l2.reactions)[0], '👍');
  assert.equal((await query(`SELECT deleted FROM messages WHERE id = 'P1'`))[0].deleted, true);
  assert.equal((await query(`SELECT count(*)::int n FROM messages WHERE id IN ('E1','R1','X1')`))[0].n, 0);
});

test('reads: chat list, search, contact tagging', async () => {
  const chats = await store.listChats('t', {});
  assert.equal(chats[0].jid, PN); // most recent first
  const priya = chats.find((c) => c.jid === '919900000001@s.whatsapp.net');
  assert.equal(priya.name, 'Priya (saved)');
  const hits = await store.searchMessages('t', 'resume', {});
  assert.ok(hits.some((h) => h.id === 'P2'));
  const phoneHit = await store.searchMessages('t', '9812345678', {});
  assert.ok(phoneHit.some((h) => h.id === 'G1'), 'search finds numbers inside shared contacts');
  const c = await store.updateContact('t', PN, { addTags: ['candidate', 'lead-hot'], summary: 'Ravi, wants receptionist job', markReviewed: true });
  assert.deepEqual([...c.tags].sort(), ['candidate', 'lead-hot']);
  const c2 = await store.updateContact('t', PN, { removeTags: ['lead-hot'] });
  assert.deepEqual(c2.tags, ['candidate']);
  assert.ok(c2.reviewed_at);
});

test('settings: 5 s minimum delay and sending window', () => {
  const st = normalizeSettings({ delayMinSec: 1, delayMaxSec: 2 });
  assert.equal(st.delayMinSec, 5);
  assert.equal(st.delayMaxSec, 5);
  for (let i = 0; i < 50; i++) assert.ok(randomDelayMs(normalizeSettings({ delayMinSec: 5, delayMaxSec: 9 })) >= 5000);
  const w = normalizeSettings({ anytime: false, sendStart: '10:00', sendEnd: '19:00', sendDays: [1] });
  assert.equal(insideSendingWindow(w, new Date('2026-10-19T06:00:00Z')), true); // Mon 11:30 IST
  assert.equal(insideSendingWindow(w, new Date('2026-10-19T14:00:00Z')), false); // Mon 19:30 IST
  assert.equal(insideSendingWindow(w, new Date('2026-10-20T06:00:00Z')), false); // Tuesday
  const d = normalizeSettings({});
  assert.equal(d.anytime, true, 'default: send any time');
  assert.equal(d.dailyCap, 35, 'default daily limit');
  assert.equal(insideSendingWindow(d, new Date('2026-10-18T22:30:00Z')), true, 'Sunday 4 am IST is fine by default');
});

test('lease: only one server runs a number at a time', async () => {
  const { default: config } = await import('../src/config.js');
  const me = config.instanceId;
  assert.equal(await s.acquireLease(), true);
  assert.equal(await s.acquireLease(), true, 'renewing own lease works');
  config.instanceId = 'other-server';
  assert.equal(await s.acquireLease(), false, 'second server is refused while lease is fresh');
  config.instanceId = me;
  await s.releaseLease();
  config.instanceId = 'other-server';
  assert.equal(await s.acquireLease(), true, 'second server takes over after release');
  await query(`UPDATE accounts SET lease_until = now() - interval '1 second' WHERE id = 't'`);
  config.instanceId = me;
  assert.equal(await s.acquireLease(), true, 'expired lease (crashed server) can be taken');
  await s.releaseLease();
});

test.after(async () => {
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Checks that each number's data is stored separately. Run: node scripts/isolation-check.cjs
require('dotenv').config({ quiet: true });
const pg = require('pg');
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const q = async (sql, p) => (await c.query(sql, p)).rows;
c.connect().then(async () => {
  console.log('Per number:');
  console.table(await q(`SELECT a.id, a.phone,
      (SELECT count(*) FROM chats WHERE account_id = a.id)::int chats,
      (SELECT count(*) FROM contacts WHERE account_id = a.id)::int contacts,
      (SELECT count(*) FROM messages WHERE account_id = a.id)::int messages,
      (SELECT count(*) FROM lid_map WHERE account_id = a.id)::int lid_maps,
      (SELECT count(*) FROM wa_auth WHERE account_id = a.id)::int key_rows
    FROM accounts a ORDER BY a.id`));
  // rows pointing at an account that doesn't exist
  for (const t of ['chats', 'contacts', 'messages', 'lid_map', 'wa_auth', 'outbox', 'tasks', 'jobs']) {
    const [r] = await q(`SELECT count(*)::int n FROM ${t} WHERE account_id NOT IN (SELECT id FROM accounts)`);
    if (r.n) console.log(`!! ${t}: ${r.n} rows for unknown accounts`);
  }
  // a number must never appear as a chat inside its own account (would mean the wrong account stored it)
  console.log('Own number stored as a chat in its own account:', await q(`SELECT a.id FROM accounts a JOIN chats ch ON ch.account_id = a.id AND ch.jid = a.phone || '@s.whatsapp.net'`));
  // The two numbers' chat with each other: each side should have it, with mirrored from_me
  const [g, h] = [await q(`SELECT phone FROM accounts WHERE id='guests'`), await q(`SELECT phone FROM accounts WHERE id='hiring'`)];
  const gp = g[0].phone, hp = h[0].phone;
  console.log('Hotel→Seema chat in Hotel account:', (await q(`SELECT count(*)::int n, sum(from_me::int)::int mine FROM messages WHERE account_id='guests' AND chat_jid=$1`, [hp + '@s.whatsapp.net']))[0]);
  console.log('Seema→Hotel chat in Seema account:', (await q(`SELECT count(*)::int n, sum(from_me::int)::int mine FROM messages WHERE account_id='hiring' AND chat_jid=$1`, [gp + '@s.whatsapp.net']))[0]);
  // same WhatsApp message id stored in both accounts (normal for messages between the two numbers) — must have opposite from_me
  console.log('Shared message ids with the SAME direction in both accounts (should be 0):',
    (await q(`SELECT count(*)::int n FROM messages a JOIN messages b ON a.id = b.id AND a.account_id='guests' AND b.account_id='hiring' AND a.from_me = b.from_me`))[0].n);
  console.log('Leases:', await q(`SELECT id, lease_owner IS NOT NULL AS held, lease_until > now() AS fresh FROM accounts`));
  await c.end();
});

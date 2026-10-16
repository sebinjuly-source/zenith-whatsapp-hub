require('dotenv').config({ quiet: true });
const pg = require('pg');
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
c.connect().then(async () => {
  const a = await c.query("select pid,state,wait_event,now()-query_start age,left(query,120) q from pg_stat_activity where datname='postgres' and pid<>pg_backend_pid() and usename not like 'supabase%' order by query_start");
  console.table(a.rows);
  const n = await c.query("select (select count(*) from messages where account_id='guests')::int msgs,(select count(*) from chats where account_id='guests')::int chats,(select count(*) from wa_auth where account_id='guests')::int auth_rows");
  console.log(n.rows[0]); await c.end();
});

require('dotenv').config({ quiet: true });
const pg = require('pg');
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
c.connect().then(async () => {
  const q = async () => (await c.query("select split_part(key, ':', 1) t, count(*)::int n from wa_auth where account_id='guests' group by 1 order by 2 desc")).rows;
  const a = await q(); await new Promise((r) => setTimeout(r, 20000)); const b = await q();
  console.log('now  ', JSON.stringify(b)); console.log('20s ago', JSON.stringify(a)); await c.end();
});

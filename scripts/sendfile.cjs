// node sendfile.cjs <file> <caption> → POST /api/send with the file as base64
require('dotenv').config({ quiet: true });
const fs = require('fs'), path = require('path');
const [file, caption] = process.argv.slice(2);
const buf = fs.readFileSync(file);
const t = Date.now();
fetch('http://localhost:3210/api/send', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': process.env.API_KEY },
  body: JSON.stringify({ account: 'guests', to: '9353315601', attachment: { base64: buf.toString('base64'), fileName: path.basename(file), caption } }),
  signal: AbortSignal.timeout(240000),
}).then(async (r) => { const j = await r.json(); console.log(path.basename(file), (buf.length / 1e6).toFixed(2) + 'MB', '→', r.status, j.status, j.message_id || '', j.error || '', ((Date.now() - t) / 1000).toFixed(1) + 's'); })
  .catch((e) => console.log(path.basename(file), 'ERROR', e.message));

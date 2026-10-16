// Round-trips a small file through the configured media storage. Run: node scripts/storage-check.mjs
process.env.LOG_LEVEL = 'error';
const { initDb, closeDb } = await import('../src/db.js');
const { putMedia, getMedia } = await import('../src/media.js');
await initDb();
const ref = await putMedia('_check/hello.txt', Buffer.from('storage works ' + new Date().toISOString()), 'text/plain');
const back = await getMedia(ref);
console.log('stored as', ref, '→ read back:', back.buffer.toString(), back.mimetype);
await closeDb();

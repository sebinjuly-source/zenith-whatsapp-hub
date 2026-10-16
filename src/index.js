import config from './config.js';
import logger from './logger.js';
import { initDb, closeDb } from './db.js';
import { manager } from './wa/manager.js';
import { startOutbox } from './outbox.js';
import { buildApp } from './api.js';

async function main() {
  await initDb();
  const app = buildApp();
  const server = app.listen(config.port, () => {
    logger.info(`Dashboard: http://localhost:${config.port}`);
    if (config.publicUrl) logger.info(`MCP URL: ${config.publicUrl}/mcp/<API_KEY>`);
  });
  await manager.init();
  await startOutbox();

  const shutdown = async (sig) => {
    logger.info({ sig }, 'Shutting down');
    server.close();
    for (const s of manager.sessions.values()) await s.stop().catch(() => {});
    // let queued DB writes finish
    await Promise.all([...manager.sessions.values()].map((s) => s.work));
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (err) => logger.error({ err: err?.stack || err }, 'Unhandled rejection'));
}

main().catch((err) => {
  logger.fatal({ err: err.stack }, 'Startup failed');
  process.exit(1);
});

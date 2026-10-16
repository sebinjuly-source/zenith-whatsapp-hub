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

  // Render's free plan sleeps after 15 min without incoming requests, which would drop WhatsApp.
  // Ping our own public URL every 10 min (counts as incoming traffic). Off when not on Render.
  if (config.publicUrl && process.env.RENDER && process.env.KEEP_AWAKE !== '0') {
    setInterval(() => {
      fetch(`${config.publicUrl}/health`, { signal: AbortSignal.timeout(30000) }).catch(() => {});
    }, 10 * 60 * 1000).unref();
    logger.info('Keep-awake ping enabled');
  }

  const shutdown = async (sig) => {
    logger.info({ sig }, 'Shutting down');
    server.close();
    // stop() finishes pending writes (bounded) and saves the WhatsApp keys
    for (const s of manager.sessions.values()) await s.stop().catch(() => {});
    await closeDb();
    process.exit(0);
  };
  app.locals.shutdown = shutdown;
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (err) => logger.error({ err: err?.stack || err }, 'Unhandled rejection'));
}

main().catch((err) => {
  logger.fatal({ err: err.stack }, 'Startup failed');
  process.exit(1);
});

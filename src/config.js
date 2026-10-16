import 'dotenv/config';
import os from 'os';
import crypto from 'crypto';

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  apiKey: process.env.API_KEY || '',
  databaseUrl: process.env.DATABASE_URL || '',
  localDbDir: process.env.LOCAL_DB_DIR || './data/pglite',
  supabase: {
    url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    serviceKey: process.env.SUPABASE_SERVICE_KEY || '',
    bucket: process.env.SUPABASE_BUCKET || 'whatsapp-media',
  },
  tz: process.env.TZ_NAME || 'Asia/Kolkata',
  logLevel: process.env.LOG_LEVEL || 'info',
  // Identifies this running server in account leases.
  instanceId: `${process.env.RENDER_INSTANCE_ID || os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`,
  publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, ''),
};

if (!config.apiKey) {
  // Never fall back to a guessable key: without API_KEY the dashboard, API and MCP stay locked.
  config.apiKey = crypto.randomBytes(32).toString('hex');
  console.warn('WARNING: API_KEY is not set — dashboard, API and MCP are locked until you set it.');
}

export default config;

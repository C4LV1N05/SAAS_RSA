/**
 * Notification worker: a long-running process (an Azure Container App with one
 * replica) that delivers queued messages from the notification_outbox table.
 *
 *   DATABASE_URL  postgres://saas_worker:...@host/saas_rsa?sslmode=require
 *   TWILIO_*      see .env.example
 */
import pg from 'pg';
import { processBatch } from './outbox';
import { providersFromEnv } from './providers';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required (connect as the saas_worker role)');
  process.exit(1);
}

const pollMs = Number(process.env.POLL_INTERVAL_MS ?? 2000);
const providers = providersFromEnv(process.env);
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

let running = true;
const shutdown = async () => {
  running = false;
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log(`notification worker started (channels: ${providers.map((p) => p.channel).join(', ')})`);
while (running) {
  try {
    const result = await processBatch(pool, providers);
    // Drain quickly while there is work; otherwise wait for the next poll.
    if (result.claimed > 0) continue;
  } catch (err) {
    console.error(`outbox poll failed: ${(err as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, pollMs));
}
await pool.end();
console.log('notification worker stopped');

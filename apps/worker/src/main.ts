/**
 * Background worker: a long-running process (an Azure Container App with one
 * replica) that drains two database outboxes:
 *   - notification_outbox: staff WhatsApp/SMS messages via Twilio
 *   - till_events: Serve events pushed to the restaurant's till as signed webhooks
 *
 *   DATABASE_URL  postgres://saas_worker:...@host/saas_rsa?sslmode=require
 *   TWILIO_*      see .env.example
 */
import pg from 'pg';
import { processBatch } from './outbox';
import { providersFromEnv } from './providers';
import { processTillBatch } from './till';

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

console.log(`worker started (message channels: ${providers.map((p) => p.channel).join(', ')}; till sync on)`);
while (running) {
  let busy = false;
  try {
    busy = (await processBatch(pool, providers)).claimed > 0 || busy;
  } catch (err) {
    console.error(`notification poll failed: ${(err as Error).message}`);
  }
  try {
    busy = (await processTillBatch(pool)).claimed > 0 || busy;
  } catch (err) {
    console.error(`till poll failed: ${(err as Error).message}`);
  }
  // Drain quickly while there is work; otherwise wait for the next poll.
  if (!busy) await new Promise((r) => setTimeout(r, pollMs));
}
await pool.end();
console.log('worker stopped');

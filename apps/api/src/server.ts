import { createDb } from '@saas-rsa/db';
import { buildApp } from './app';
import { createVerifier } from './auth';
import { noopNotifier } from './context';
import { loadEnv } from './env';
import { createBullNotifier } from './notifier';

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
const notifier = env.REDIS_URL ? createBullNotifier(env.REDIS_URL) : noopNotifier;
const app = buildApp({ db, notifier, verify: createVerifier(env), logLevel: env.LOG_LEVEL });

if (!env.REDIS_URL) app.log.warn('REDIS_URL not set: staff notifications are disabled');

const shutdown = async () => {
  await app.close();
  if ('close' in notifier) await (notifier as { close(): Promise<void> }).close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

import { createDb } from '@saas-rsa/db';
import { buildApp } from './app';
import { createVerifier } from './auth';
import { loadEnv } from './env';
import { listenForServiceEvents, ServiceEventBus } from './events';
import { createMediaStore } from './media';
import { createFieldCipher } from './crypto';

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
const events = new ServiceEventBus();
const app = buildApp({
  db,
  verify: createVerifier(env),
  ...(env.AUTH_ACTION_SECRET ? { authActionSecret: env.AUTH_ACTION_SECRET } : {}),
  events,
  media: createMediaStore(env),
  cipher: createFieldCipher(env),
  guestAppUrl: env.GUEST_APP_URL,
  corsOrigins: env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  logLevel: env.LOG_LEVEL,
});
const listener = listenForServiceEvents(env.DATABASE_URL, events, app.log);

if (!env.AUTH_ACTION_SECRET) app.log.warn('AUTH_ACTION_SECRET not set: the Auth0 claims endpoint is disabled');

const shutdown = async () => {
  await listener.close();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

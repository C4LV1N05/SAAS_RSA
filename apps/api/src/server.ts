import { createDb } from '@saas-rsa/db';
import { buildApp } from './app';
import { createVerifier } from './auth';
import { loadEnv } from './env';

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
const app = buildApp({
  db,
  verify: createVerifier(env),
  ...(env.AUTH_ACTION_SECRET ? { authActionSecret: env.AUTH_ACTION_SECRET } : {}),
  logLevel: env.LOG_LEVEL,
});

if (!env.AUTH_ACTION_SECRET) app.log.warn('AUTH_ACTION_SECRET not set: the Auth0 claims endpoint is disabled');

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

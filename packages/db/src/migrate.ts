/**
 * Applies db/migrations/*.sql in filename order, once each, inside a transaction
 * per file. Runs as the OWNER connection (DATABASE_OWNER_URL), never as saas_app.
 *
 *   pnpm db:migrate
 *
 * Optional: APP_DB_PASSWORD gives the saas_app role a login password (local/dev).
 * In production, manage that role's credentials in your secrets manager.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

export async function migrate(connectionString: string, log: (msg: string) => void = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      create table if not exists schema_migrations (
        name       text primary key,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )`);
    const done = new Map(
      (await client.query<{ name: string; checksum: string }>('select name, checksum from schema_migrations')).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const body = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex');
      const previous = done.get(file);
      if (previous) {
        if (previous !== checksum) {
          throw new Error(`Migration ${file} was edited after it was applied. Add a new migration instead.`);
        }
        continue;
      }
      log(`applying ${file}`);
      await client.query('begin');
      try {
        await client.query(body);
        await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [file, checksum]);
        await client.query('commit');
        applied.push(file);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    const appPassword = process.env.APP_DB_PASSWORD;
    if (appPassword) {
      await client.query(`alter role saas_app login password ${pg.escapeLiteral(appPassword)}`);
      log('saas_app login enabled');
    }
  } finally {
    await client.end();
  }
  return applied;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) {
    console.error('DATABASE_OWNER_URL is required');
    process.exit(1);
  }
  migrate(url)
    .then((applied) => console.log(applied.length ? `applied ${applied.length} migration(s)` : 'database is up to date'))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

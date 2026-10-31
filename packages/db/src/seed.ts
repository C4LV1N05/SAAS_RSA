/**
 * Seeds national reference data (rule versions, public holidays) from the domain
 * package, so the database and the engine's tests share one source of values.
 * Idempotent: re-running updates values and sources in place.
 *
 *   pnpm --filter @saas-rsa/db seed
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SA_PUBLIC_HOLIDAYS, SA_RULE_VERSIONS } from '@saas-rsa/domain';

export async function seed(connectionString: string): Promise<{ rules: number; holidays: number }> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('begin');
    for (const v of SA_RULE_VERSIONS) {
      await client.query(
        `insert into rule_versions (org_id, key, value, effective_from, effective_to, source)
         values (null, $1, $2, $3, $4, $5)
         on conflict (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), key, effective_from)
         do update set value = excluded.value, effective_to = excluded.effective_to, source = excluded.source`,
        [v.key, JSON.stringify(v.value), v.effectiveFrom, v.effectiveTo ?? null, v.source],
      );
    }
    for (const h of SA_PUBLIC_HOLIDAYS) {
      await client.query(
        `insert into public_holidays (org_id, holiday_date, name) values (null, $1, $2)
         on conflict (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), holiday_date)
         do update set name = excluded.name`,
        [h.date, h.name],
      );
    }
    await client.query('commit');
    return { rules: SA_RULE_VERSIONS.length, holidays: SA_PUBLIC_HOLIDAYS.length };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) {
    console.error('DATABASE_OWNER_URL is required');
    process.exit(1);
  }
  seed(url)
    .then((r) => console.log(`seeded ${r.rules} rule versions and ${r.holidays} public holidays`))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

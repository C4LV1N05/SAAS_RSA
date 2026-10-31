import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

export function createDb(connectionString: string, max = 10): { db: Database; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString, max });
  return { db: drizzle(pool, { schema }), pool };
}

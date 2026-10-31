/**
 * Outbox processing against PostgreSQL, connecting as saas_worker.
 * Needs DATABASE_OWNER_URL and DATABASE_WORKER_URL; skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChannelProvider } from '../src/deliver';
import { processBatch } from '../src/outbox';

const OWNER_URL = process.env.DATABASE_OWNER_URL;
const WORKER_URL = process.env.DATABASE_WORKER_URL;

describe.skipIf(!OWNER_URL || !WORKER_URL)('outbox worker (as saas_worker)', () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  const org = randomUUID();
  const okKey = `test-ok-${org}`;
  const failKey = `test-fail-${org}`;

  const asOrg = async <T>(fn: (c: pg.PoolClient) => Promise<T>) => {
    const c = await owner.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.org_id', $1, true), set_config('app.role', 'owner', true)`, [org]);
      const r = await fn(c);
      await c.query('commit');
      return r;
    } finally {
      c.release();
    }
  };
  const statusOf = (key: string) =>
    asOrg((c) => c.query('select status, attempts, delivered_via, provider_ref, last_error, next_attempt_at from notification_outbox where dedupe_key = $1', [key]).then((r) => r.rows[0]));

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    worker = new pg.Pool({ connectionString: WORKER_URL });
    await asOrg(async (c) => {
      await c.query('insert into organisations (id, legal_name) values ($1, $2)', [org, 'Outbox Test']);
      for (const [key, phone] of [[okKey, '+27820000001'], [failKey, '+27820000002']]) {
        await c.query(
          `insert into notification_outbox (org_id, recipient, template, params, channels, dedupe_key)
           values ($1, $2, 'schedule_published', '{"shifts": 3}', array['whatsapp','sms'], $3)`,
          [org, { phoneE164: phone, displayName: 'Test' }, key],
        );
      }
    });
  });

  afterAll(async () => {
    await owner?.end();
    await worker?.end();
  });

  it('has no direct table access', async () => {
    await expect(worker.query('select * from notification_outbox')).rejects.toThrow(/permission denied/);
    await expect(worker.query('select * from employees')).rejects.toThrow(/permission denied/);
  });

  it('delivers due messages and backs off failures', async () => {
    const provider: ChannelProvider = {
      channel: 'sms',
      canReach: () => true,
      send: async (job) => {
        if (job.recipient.phoneE164 === '+27820000002') throw new Error('Twilio 400 (code 21211)');
        return 'SM-test';
      },
    };
    // Other tests may have queued rows too; process until ours are handled.
    for (let i = 0; i < 10; i++) {
      const r = await processBatch(worker, [provider], { log: () => {} });
      if (r.claimed === 0) break;
    }
    expect(await statusOf(okKey)).toMatchObject({ status: 'sent', attempts: 1, delivered_via: 'sms', provider_ref: 'SM-test', last_error: null });
    const failed = await statusOf(failKey);
    expect(failed).toMatchObject({ status: 'queued', attempts: 1, last_error: expect.stringContaining('21211') });
    expect(new Date(failed.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 30_000);
  });
});

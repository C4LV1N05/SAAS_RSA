import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processTillBatch, signTillPayload, verifyTillSignature } from '../src/till';

describe('till webhook signatures', () => {
  const secret = 'x'.repeat(40);
  it('verifies a fresh, untampered payload', () => {
    const body = '{"type":"order.placed"}';
    const header = signTillPayload(secret, body, 1_800_000_000);
    expect(verifyTillSignature(secret, body, header, 300, 1_800_000_100)).toBe(true);
    expect(verifyTillSignature(secret, body.replace('placed', 'voided'), header, 300, 1_800_000_100)).toBe(false);
    expect(verifyTillSignature('y'.repeat(40), body, header, 300, 1_800_000_100)).toBe(false);
    expect(verifyTillSignature(secret, body, header, 300, 1_800_001_000)).toBe(false); // too old
  });
});

const OWNER_URL = process.env.DATABASE_OWNER_URL;
const WORKER_URL = process.env.DATABASE_WORKER_URL;

describe.skipIf(!OWNER_URL || !WORKER_URL)('till sync (as saas_worker)', () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  const org = randomUUID();
  const loc = randomUUID();
  const secret = 'z'.repeat(40);

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

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    worker = new pg.Pool({ connectionString: WORKER_URL });
    await asOrg(async (c) => {
      await c.query('insert into organisations (id, legal_name) values ($1, $2)', [org, 'Till Test']);
      await c.query('insert into locations (id, org_id, name) values ($1, $2, $3)', [loc, org, 'Main']);
      await c.query(`insert into till_integrations (org_id, mode, webhook_url, signing_secret) values ($1, 'webhook', 'https://till.example/hook', $2)`, [org, secret]);
      await c.query(`select set_config('app.location_ids', $1, true)`, [loc]);
      await c.query(`select app.emit_till_event('order.placed', $1, '{"orderId":"o1"}'::jsonb, $2)`, [loc, `test-ok-${org}`]);
      await c.query(`select app.emit_till_event('tab.closed', $1, '{"tabId":"t1"}'::jsonb, $2)`, [loc, `test-fail-${org}`]);
    });
  });

  afterAll(async () => {
    await owner?.end();
    await worker?.end();
  });

  it('delivers signed events and retries failures with backoff', async () => {
    const received: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      received.push({ url, headers, body: String(init.body) });
      return new Response(null, { status: headers['x-saasrsa-event'] === 'tab.closed' ? 503 : 204 });
    }) as unknown as typeof fetch;

    for (let i = 0; i < 10; i++) {
      if ((await processTillBatch(worker, { fetchImpl, log: () => {} })).claimed === 0) break;
    }
    const ours = received.filter((r) => JSON.parse(r.body).orgId === org);
    const placed = ours.find((r) => r.headers['x-saasrsa-event'] === 'order.placed')!;
    expect(placed.url).toBe('https://till.example/hook');
    expect(JSON.parse(placed.body)).toMatchObject({ type: 'order.placed', orgId: org, data: { orderId: 'o1' } });
    expect(verifyTillSignature(secret, placed.body, placed.headers['x-saasrsa-signature']!)).toBe(true);

    const rows = await asOrg((c) => c.query('select dedupe_key, status, attempts, last_error from till_events where org_id = $1 order by dedupe_key', [org]));
    expect(rows.rows).toEqual([
      { dedupe_key: `test-fail-${org}`, status: 'queued', attempts: 1, last_error: 'Till webhook responded 503' },
      { dedupe_key: `test-ok-${org}`, status: 'delivered', attempts: 1, last_error: null },
    ]);
  });

  it('gives the worker no direct access to till settings or events', async () => {
    await expect(worker.query('select * from till_integrations')).rejects.toThrow(/permission denied/);
    await expect(worker.query('select * from till_events')).rejects.toThrow(/permission denied/);
  });
});

/**
 * Till sync: delivers Serve events (tab opened, order placed, item voided,
 * payment recorded, tab closed) to the restaurant's till or its integration
 * middleware as signed webhooks.
 *
 * Request:
 *   POST <webhook_url>
 *   X-SaasRsa-Event:     order.placed
 *   X-SaasRsa-Delivery:  <event id>       (same id on retries: dedupe on it)
 *   X-SaasRsa-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
 *   { "id", "type", "createdAt", "orgId", "data": { ... } }
 *
 * The receiver should verify the signature with the shared secret, reject
 * timestamps older than 5 minutes, and return any 2xx. Failures retry with
 * exponential backoff, up to 8 attempts.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import pg from 'pg';

type Fetch = typeof fetch;

export function signTillPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

/** Reference implementation for receivers (also used in tests). */
export function verifyTillSignature(secret: string, body: string, header: string, toleranceSeconds = 300, now = Date.now() / 1000): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(t) || Math.abs(now - t) > toleranceSeconds) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'));
  const given = Buffer.from(parts.v1);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

interface TillEventRow {
  id: string;
  org_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  created_at: Date;
  webhook_url: string | null;
  signing_secret: string | null;
}

export async function processTillBatch(
  pool: pg.Pool,
  options: { fetchImpl?: Fetch; limit?: number; leaseSeconds?: number; log?: (msg: string) => void } = {},
): Promise<{ claimed: number; delivered: number; failed: number }> {
  const { fetchImpl = fetch, limit = 20, leaseSeconds = 120, log = console.log } = options;
  const { rows } = await pool.query<TillEventRow>('select * from app.claim_till_events($1, $2)', [limit, leaseSeconds]);
  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (!row.webhook_url || !row.signing_secret) throw new Error('Till integration has no webhook URL or secret');
      const body = JSON.stringify({
        id: row.id,
        type: row.event_type,
        createdAt: new Date(row.created_at).toISOString(),
        orgId: row.org_id,
        data: row.payload,
      });
      const res = await fetchImpl(row.webhook_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'saas-rsa-till-sync/1',
          'x-saasrsa-event': row.event_type,
          'x-saasrsa-delivery': row.id,
          'x-saasrsa-signature': signTillPayload(row.signing_secret, body),
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Till webhook responded ${res.status}`);
      await pool.query('select app.complete_till_event($1, true, null)', [row.id]);
      delivered += 1;
    } catch (err) {
      const message = (err as Error).message;
      await pool.query('select app.complete_till_event($1, false, $2)', [row.id, message]);
      failed += 1;
      log(`till event ${row.id} (${row.event_type}) attempt ${row.attempts} failed: ${message}`);
    }
  }
  return { claimed: rows.length, delivered, failed };
}

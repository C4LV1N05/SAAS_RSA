/**
 * Outbox processing. The worker connects as saas_worker, which can only call
 * app.claim_notifications and app.complete_notification: it cannot read any
 * table directly. Claims use FOR UPDATE SKIP LOCKED with a lease, so several
 * worker replicas never send the same message, and a crashed worker's claims
 * are picked up again when the lease expires.
 */
import pg from 'pg';
import type { NotificationJob, NotificationTemplate, NotificationChannel } from '@saas-rsa/domain';
import { deliver, type ChannelProvider } from './deliver';

interface OutboxRow {
  id: string;
  org_id: string;
  recipient: NotificationJob['recipient'];
  template: NotificationTemplate;
  params: Record<string, string | number>;
  channels: NotificationChannel[];
  dedupe_key: string;
  attempts: number;
}

export interface BatchResult {
  claimed: number;
  sent: number;
  failed: number;
}

export async function processBatch(
  pool: pg.Pool,
  providers: readonly ChannelProvider[],
  options: { limit?: number; leaseSeconds?: number; log?: (msg: string) => void } = {},
): Promise<BatchResult> {
  const { limit = 20, leaseSeconds = 120, log = console.log } = options;
  const { rows } = await pool.query<OutboxRow>('select * from app.claim_notifications($1, $2)', [limit, leaseSeconds]);
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const job: NotificationJob = {
      orgId: row.org_id,
      recipient: row.recipient,
      template: row.template,
      params: row.params,
      channels: row.channels,
      dedupeKey: row.dedupe_key,
    };
    try {
      const result = await deliver(job, providers);
      await pool.query('select app.complete_notification($1, true, $2, $3, null)', [row.id, result.channel, result.providerRef ?? null]);
      sent += 1;
      log(`sent ${row.id} via ${result.channel}`);
    } catch (err) {
      const message = (err as Error).message;
      await pool.query('select app.complete_notification($1, false, null, null, $2)', [row.id, message]);
      failed += 1;
      log(`attempt ${row.attempts} failed for ${row.id}: ${message}`);
    }
  }
  return { claimed: rows.length, sent, failed };
}

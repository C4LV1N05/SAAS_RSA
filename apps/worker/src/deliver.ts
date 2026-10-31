/**
 * Delivery with channel fallback: WhatsApp first (most SA staff use it on prepaid
 * data), then SMS, then push/email. If every channel fails, the job throws and
 * BullMQ retries it with exponential backoff.
 */
import type { NotificationChannel, NotificationJob, NotificationTemplate } from '@saas-rsa/domain';

export interface ChannelProvider {
  channel: NotificationChannel;
  /** False when the recipient cannot be reached on this channel (e.g. no phone). */
  canReach(job: NotificationJob): boolean;
  send(job: NotificationJob, text: string): Promise<void>;
}

const TEMPLATES: Record<NotificationTemplate, (p: Record<string, string | number>, name: string) => string> = {
  schedule_published: (p, name) => `Hi ${name}, your schedule has been published: ${p.shifts} shift(s). Open the app to view and confirm.`,
  shift_changed: (p, name) => `Hi ${name}, a shift on ${p.date} has changed. Open the app for details.`,
  payslip_ready: (p, name) => `Hi ${name}, your payslip for ${p.period} is ready in the app.`,
  logbook_ack_required: (p) => `New log book note at ${p.location} needs your acknowledgement before your shift.`,
};

export function render(job: NotificationJob): string {
  return TEMPLATES[job.template](job.params, job.recipient.displayName ?? 'there');
}

export interface DeliveryResult {
  channel: NotificationChannel;
  attempts: Array<{ channel: NotificationChannel; error: string }>;
}

export async function deliver(job: NotificationJob, providers: readonly ChannelProvider[]): Promise<DeliveryResult> {
  const text = render(job);
  const attempts: DeliveryResult['attempts'] = [];
  for (const channel of job.channels) {
    const provider = providers.find((p) => p.channel === channel);
    if (!provider || !provider.canReach(job)) continue;
    try {
      await provider.send(job, text);
      return { channel, attempts };
    } catch (err) {
      attempts.push({ channel, error: (err as Error).message });
    }
  }
  throw new Error(
    attempts.length
      ? `All channels failed: ${attempts.map((a) => `${a.channel}: ${a.error}`).join('; ')}`
      : `No channel can reach recipient for job ${job.dedupeKey}`,
  );
}

/**
 * Delivery with channel fallback: WhatsApp first (most SA staff use it on prepaid
 * data), then SMS. If every channel fails, the error is recorded and the outbox
 * row is retried later with exponential backoff.
 */
import type { NotificationChannel, NotificationJob, NotificationTemplate } from '@saas-rsa/domain';

export interface ChannelProvider {
  channel: NotificationChannel;
  /** False when the recipient cannot be reached on this channel (no phone, no approved template). */
  canReach(job: NotificationJob): boolean;
  /** Sends the message; resolves with the provider's message id when it has one. */
  send(job: NotificationJob, text: string): Promise<string | undefined>;
}

const TEMPLATES: Record<NotificationTemplate, (p: Record<string, string | number>, name: string) => string> = {
  schedule_published: (p, name) => `Hi ${name}, your schedule has been published: ${p.shifts} shift(s). Open the app to view and confirm.`,
  shift_changed: (p, name) => `Hi ${name}, a shift on ${p.date} has changed. Open the app for details.`,
  payslip_ready: (p, name) => `Hi ${name}, your payslip for ${p.period} is ready in the app.`,
  logbook_ack_required: (p) => `New log book note at ${p.location} needs your acknowledgement before your shift.`,
};

/**
 * Variables for approved WhatsApp templates, in the order the template uses them
 * ({{1}}, {{2}}, ...). Register templates in Twilio with these placeholders.
 */
export const TEMPLATE_VARIABLES: Record<NotificationTemplate, (job: NotificationJob) => string[]> = {
  schedule_published: (j) => [j.recipient.displayName ?? 'there', String(j.params.shifts ?? '')],
  shift_changed: (j) => [j.recipient.displayName ?? 'there', String(j.params.date ?? '')],
  payslip_ready: (j) => [j.recipient.displayName ?? 'there', String(j.params.period ?? '')],
  logbook_ack_required: (j) => [String(j.params.location ?? '')],
};

export function render(job: NotificationJob): string {
  return TEMPLATES[job.template](job.params, job.recipient.displayName ?? 'there');
}

export interface DeliveryResult {
  channel: NotificationChannel;
  providerRef?: string;
  attempts: Array<{ channel: NotificationChannel; error: string }>;
}

export async function deliver(job: NotificationJob, providers: readonly ChannelProvider[]): Promise<DeliveryResult> {
  const text = render(job);
  const attempts: DeliveryResult['attempts'] = [];
  for (const channel of job.channels) {
    const provider = providers.find((p) => p.channel === channel);
    if (!provider || !provider.canReach(job)) continue;
    try {
      const providerRef = await provider.send(job, text);
      return { channel, attempts, ...(providerRef ? { providerRef } : {}) };
    } catch (err) {
      attempts.push({ channel, error: (err as Error).message });
    }
  }
  throw new Error(
    attempts.length
      ? `All channels failed: ${attempts.map((a) => `${a.channel}: ${a.error}`).join('; ')}`
      : `No configured channel can reach this recipient (${job.channels.join(', ')})`,
  );
}

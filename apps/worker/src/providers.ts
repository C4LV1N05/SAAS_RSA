/**
 * Channel adapters. The HTTP adapters POST a simple JSON body to a provider URL;
 * wire them to your chosen gateway (e.g. Clickatell or Twilio for WhatsApp/SMS).
 * WhatsApp business-initiated messages need Meta-approved templates: register the
 * templates in deliver.ts with your provider before going live.
 */
import type { NotificationJob } from '@saas-rsa/domain';
import type { ChannelProvider } from './deliver';

const hasPhone = (job: NotificationJob) => !!job.recipient.phoneE164;

async function postJson(url: string, apiKey: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`provider responded ${res.status}`);
}

export function httpWhatsAppProvider(url: string, apiKey: string): ChannelProvider {
  return {
    channel: 'whatsapp',
    canReach: hasPhone,
    send: (job, text) => postJson(url, apiKey, { to: job.recipient.phoneE164, template: job.template, params: job.params, text }),
  };
}

export function httpSmsProvider(url: string, apiKey: string): ChannelProvider {
  return {
    channel: 'sms',
    canReach: hasPhone,
    send: (job, text) => postJson(url, apiKey, { to: job.recipient.phoneE164, text: text.slice(0, 459) }),
  };
}

/** Development fallback: logs instead of sending. Never sends real messages. */
export function consoleProvider(channel: ChannelProvider['channel']): ChannelProvider {
  return {
    channel,
    canReach: () => true,
    send: async (job, text) => {
      // Phone numbers are personal information (POPIA): log a masked form only.
      const to = job.recipient.phoneE164?.replace(/\d(?=\d{3})/g, '*') ?? job.recipient.employeeId ?? 'unknown';
      console.log(`[${channel}] to ${to}: ${text}`);
    },
  };
}

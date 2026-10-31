/**
 * Twilio adapters (Programmable Messaging REST API, no SDK).
 *
 * SMS: plain text from a South African sender number or a Messaging Service.
 * WhatsApp: business-initiated messages must use a Meta-approved template, sent
 * as a Twilio Content template (ContentSid + ContentVariables). A template with no
 * ContentSid configured is unreachable on WhatsApp, so delivery falls back to SMS.
 */
import type { NotificationJob, NotificationTemplate } from '@saas-rsa/domain';
import { TEMPLATE_VARIABLES, type ChannelProvider } from './deliver';

type Fetch = typeof fetch;

export interface TwilioCredentials {
  accountSid: string;
  /** Account auth token, or the secret of an API key when apiKeySid is set. */
  secret: string;
  /** Optional API key SID (SK...), recommended over the account auth token. */
  apiKeySid?: string;
}

const hasPhone = (job: NotificationJob) => !!job.recipient.phoneE164;

async function sendTwilioMessage(creds: TwilioCredentials, form: Record<string, string>, fetchImpl: Fetch): Promise<string> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`;
  const auth = Buffer.from(`${creds.apiKeySid ?? creds.accountSid}:${creds.secret}`).toString('base64');
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
  if (!res.ok) throw new Error(`Twilio ${res.status}${body.code ? ` (code ${body.code})` : ''}: ${body.message ?? 'request failed'}`);
  return body.sid ?? '';
}

export function twilioSmsProvider(
  creds: TwilioCredentials,
  sender: { from?: string; messagingServiceSid?: string },
  fetchImpl: Fetch = fetch,
): ChannelProvider {
  if (!sender.from && !sender.messagingServiceSid) throw new Error('Twilio SMS needs a from number or messaging service SID');
  return {
    channel: 'sms',
    canReach: hasPhone,
    send: (job, text) =>
      sendTwilioMessage(
        creds,
        {
          To: job.recipient.phoneE164!,
          ...(sender.messagingServiceSid ? { MessagingServiceSid: sender.messagingServiceSid } : { From: sender.from! }),
          Body: text,
        },
        fetchImpl,
      ),
  };
}

export function twilioWhatsAppProvider(
  creds: TwilioCredentials,
  from: string,
  contentSids: Partial<Record<NotificationTemplate, string>>,
  fetchImpl: Fetch = fetch,
): ChannelProvider {
  const sender = from.startsWith('whatsapp:') ? from : `whatsapp:${from}`;
  return {
    channel: 'whatsapp',
    canReach: (job) => hasPhone(job) && !!contentSids[job.template],
    send: (job) => {
      const variables = Object.fromEntries(TEMPLATE_VARIABLES[job.template](job).map((v, i) => [String(i + 1), v]));
      return sendTwilioMessage(
        creds,
        {
          To: `whatsapp:${job.recipient.phoneE164}`,
          From: sender,
          ContentSid: contentSids[job.template]!,
          ContentVariables: JSON.stringify(variables),
        },
        fetchImpl,
      );
    },
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
      return undefined;
    },
  };
}

/** Build providers from environment variables; falls back to logging when Twilio is not configured. */
export function providersFromEnv(env: NodeJS.ProcessEnv, log: (msg: string) => void = console.warn): ChannelProvider[] {
  const providers: ChannelProvider[] = [];
  const secret = env.TWILIO_API_KEY_SECRET || env.TWILIO_AUTH_TOKEN;
  if (env.TWILIO_ACCOUNT_SID && secret) {
    const creds: TwilioCredentials = {
      accountSid: env.TWILIO_ACCOUNT_SID,
      secret,
      ...(env.TWILIO_API_KEY_SID ? { apiKeySid: env.TWILIO_API_KEY_SID } : {}),
    };
    if (env.TWILIO_WHATSAPP_FROM) {
      const contentSids = env.TWILIO_WHATSAPP_CONTENT_SIDS ? JSON.parse(env.TWILIO_WHATSAPP_CONTENT_SIDS) : {};
      providers.push(twilioWhatsAppProvider(creds, env.TWILIO_WHATSAPP_FROM, contentSids));
    }
    if (env.TWILIO_SMS_FROM || env.TWILIO_MESSAGING_SERVICE_SID) {
      providers.push(
        twilioSmsProvider(creds, {
          ...(env.TWILIO_SMS_FROM ? { from: env.TWILIO_SMS_FROM } : {}),
          ...(env.TWILIO_MESSAGING_SERVICE_SID ? { messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID } : {}),
        }),
      );
    }
  }
  if (providers.length === 0) {
    log('Twilio is not configured: messages will be logged, not sent');
    providers.push(consoleProvider('whatsapp'), consoleProvider('sms'));
  }
  return providers;
}

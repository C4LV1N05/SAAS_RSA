import { describe, expect, it } from 'vitest';
import type { NotificationJob } from '@saas-rsa/domain';
import { deliver, render, type ChannelProvider } from '../src/deliver';
import { twilioSmsProvider, twilioWhatsAppProvider } from '../src/providers';

const job: NotificationJob = {
  orgId: 'org',
  recipient: { phoneE164: '+27821234567', displayName: 'Lerato' },
  template: 'schedule_published',
  params: { shifts: 5 },
  channels: ['whatsapp', 'sms'],
  dedupeKey: 'k1',
};

const fake = (channel: ChannelProvider['channel'], behaviour: 'ok' | 'fail', sent: string[]): ChannelProvider => ({
  channel,
  canReach: () => true,
  send: async () => {
    if (behaviour === 'fail') throw new Error(`${channel} down`);
    sent.push(channel);
    return `${channel}-ref`;
  },
});

describe('notification delivery', () => {
  it('renders the template with the recipient name', () => {
    expect(render(job)).toContain('Hi Lerato, your schedule has been published: 5 shift(s)');
  });

  it('uses WhatsApp when it works', async () => {
    const sent: string[] = [];
    expect(await deliver(job, [fake('whatsapp', 'ok', sent), fake('sms', 'ok', sent)])).toEqual({ channel: 'whatsapp', providerRef: 'whatsapp-ref', attempts: [] });
    expect(sent).toEqual(['whatsapp']);
  });

  it('falls back to SMS when WhatsApp fails', async () => {
    const result = await deliver(job, [fake('whatsapp', 'fail', []), fake('sms', 'ok', [])]);
    expect(result).toMatchObject({ channel: 'sms', attempts: [{ channel: 'whatsapp', error: 'whatsapp down' }] });
  });

  it('throws so the outbox retries when every channel fails', async () => {
    await expect(deliver(job, [fake('whatsapp', 'fail', []), fake('sms', 'fail', [])])).rejects.toThrow(/All channels failed/);
  });
});

describe('Twilio providers', () => {
  const creds = { accountSid: 'AC123', secret: 'token' };
  const capture = (status = 201, response: object = { sid: 'SM999' }) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(response), { status });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };
  const form = (init: RequestInit) => Object.fromEntries(new URLSearchParams(String(init.body)));

  it('sends SMS through the Messages API with basic auth', async () => {
    const { calls, fetchImpl } = capture();
    const sms = twilioSmsProvider(creds, { from: '+27870000000' }, fetchImpl);
    expect(await sms.send(job, 'Hello')).toBe('SM999');
    expect(calls[0]!.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('AC123:token').toString('base64')}`);
    expect(form(calls[0]!.init)).toEqual({ To: '+27821234567', From: '+27870000000', Body: 'Hello' });
  });

  it('prefers a messaging service and an API key when given', async () => {
    const { calls, fetchImpl } = capture();
    await twilioSmsProvider({ ...creds, apiKeySid: 'SK1' }, { messagingServiceSid: 'MG1' }, fetchImpl).send(job, 'Hi');
    expect(form(calls[0]!.init)).toEqual({ To: '+27821234567', MessagingServiceSid: 'MG1', Body: 'Hi' });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('SK1:token').toString('base64')}`);
  });

  it('sends WhatsApp as an approved content template with ordered variables', async () => {
    const { calls, fetchImpl } = capture();
    const wa = twilioWhatsAppProvider(creds, '+14155238886', { schedule_published: 'HX111' }, fetchImpl);
    expect(wa.canReach(job)).toBe(true);
    await wa.send(job, 'ignored');
    expect(form(calls[0]!.init)).toEqual({
      To: 'whatsapp:+27821234567',
      From: 'whatsapp:+14155238886',
      ContentSid: 'HX111',
      ContentVariables: JSON.stringify({ 1: 'Lerato', 2: '5' }),
    });
  });

  it('cannot reach WhatsApp without an approved template, so SMS takes over', () => {
    const wa = twilioWhatsAppProvider(creds, '+14155238886', {}, capture().fetchImpl);
    expect(wa.canReach(job)).toBe(false);
  });

  it('surfaces Twilio error codes', async () => {
    const { fetchImpl } = capture(400, { code: 21211, message: "The 'To' number is not a valid phone number." });
    await expect(twilioSmsProvider(creds, { from: '+27870000000' }, fetchImpl).send(job, 'x')).rejects.toThrow(/code 21211/);
  });
});

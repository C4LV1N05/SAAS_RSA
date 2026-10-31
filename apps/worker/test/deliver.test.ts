import { describe, expect, it } from 'vitest';
import type { NotificationJob } from '@saas-rsa/domain';
import { deliver, render, type ChannelProvider } from '../src/deliver';

const job: NotificationJob = {
  orgId: 'org',
  recipient: { phoneE164: '+27821234567', displayName: 'Lerato' },
  template: 'schedule_published',
  params: { shifts: 5 },
  channels: ['whatsapp', 'sms', 'push'],
  dedupeKey: 'k1',
};

const provider = (channel: ChannelProvider['channel'], behaviour: 'ok' | 'fail', sent: string[]): ChannelProvider => ({
  channel,
  canReach: () => true,
  send: async () => {
    if (behaviour === 'fail') throw new Error(`${channel} down`);
    sent.push(channel);
  },
});

describe('notification delivery', () => {
  it('renders the template with the recipient name', () => {
    expect(render(job)).toContain('Hi Lerato, your schedule has been published: 5 shift(s)');
  });

  it('uses WhatsApp when it works', async () => {
    const sent: string[] = [];
    expect((await deliver(job, [provider('whatsapp', 'ok', sent), provider('sms', 'ok', sent)])).channel).toBe('whatsapp');
    expect(sent).toEqual(['whatsapp']);
  });

  it('falls back to SMS when WhatsApp fails', async () => {
    const sent: string[] = [];
    const result = await deliver(job, [provider('whatsapp', 'fail', sent), provider('sms', 'ok', sent)]);
    expect(result).toEqual({ channel: 'sms', attempts: [{ channel: 'whatsapp', error: 'whatsapp down' }] });
  });

  it('throws so the queue retries when every channel fails', async () => {
    await expect(deliver(job, [provider('whatsapp', 'fail', []), provider('sms', 'fail', [])])).rejects.toThrow(/All channels failed/);
  });
});

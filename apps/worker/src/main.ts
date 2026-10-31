/**
 * Notification worker: a long-running process (container host, not serverless)
 * that consumes the BullMQ "notifications" queue the API writes to.
 */
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { NOTIFICATION_QUEUE, type NotificationJob } from '@saas-rsa/domain';
import { deliver, type ChannelProvider } from './deliver';
import { consoleProvider, httpSmsProvider, httpWhatsAppProvider } from './providers';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error('REDIS_URL is required');
  process.exit(1);
}

const providers: ChannelProvider[] = [];
const { WHATSAPP_PROVIDER_URL, WHATSAPP_API_KEY, SMS_PROVIDER_URL, SMS_API_KEY } = process.env;
if (WHATSAPP_PROVIDER_URL && WHATSAPP_API_KEY) providers.push(httpWhatsAppProvider(WHATSAPP_PROVIDER_URL, WHATSAPP_API_KEY));
if (SMS_PROVIDER_URL && SMS_API_KEY) providers.push(httpSmsProvider(SMS_PROVIDER_URL, SMS_API_KEY));
if (providers.length === 0) {
  console.warn('No WhatsApp/SMS provider configured: messages will be logged, not sent');
  providers.push(consoleProvider('whatsapp'));
}

const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const worker = new Worker<NotificationJob>(
  NOTIFICATION_QUEUE,
  async (job) => {
    const result = await deliver(job.data, providers);
    return { deliveredVia: result.channel, failedAttempts: result.attempts };
  },
  { connection, concurrency: 10 },
);

worker.on('completed', (job, result) => console.log(`delivered ${job.id} via ${result.deliveredVia}`));
worker.on('failed', (job, err) => console.error(`failed ${job?.id} (attempt ${job?.attemptsMade}): ${err.message}`));

const shutdown = async () => {
  await worker.close();
  await connection.quit();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
console.log('notification worker started');

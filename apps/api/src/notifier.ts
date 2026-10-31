import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { NOTIFICATION_QUEUE, type NotificationJob } from '@saas-rsa/domain';
import type { Notifier } from './context';

/** Enqueues staff messages on BullMQ; the worker app delivers them. */
export function createBullNotifier(redisUrl: string): Notifier & { close(): Promise<void> } {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<NotificationJob>(NOTIFICATION_QUEUE, { connection });
  return {
    async enqueue(jobs) {
      await queue.addBulk(
        jobs.map((job) => ({
          name: job.template,
          data: job,
          opts: {
            jobId: job.dedupeKey, // same key => enqueued once, even if publish is retried
            attempts: 5,
            backoff: { type: 'exponential', delay: 10_000 },
            removeOnComplete: 1000,
            removeOnFail: 5000,
          },
        })),
      );
    },
    async close() {
      await queue.close();
      await connection.quit();
    },
  };
}

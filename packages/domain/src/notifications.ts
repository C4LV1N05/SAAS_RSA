/** Contract between the API (producer) and the worker (consumer) for staff messages. */
export const NOTIFICATION_QUEUE = 'notifications';

/** Order of preference: WhatsApp first, SMS fallback, then push and email. */
export type NotificationChannel = 'whatsapp' | 'sms' | 'push' | 'email';

export type NotificationTemplate = 'schedule_published' | 'shift_changed' | 'payslip_ready' | 'logbook_ack_required';

export interface NotificationJob {
  orgId: string;
  recipient: { userId?: string; employeeId?: string; phoneE164?: string; email?: string; displayName?: string };
  template: NotificationTemplate;
  params: Record<string, string | number>;
  channels: NotificationChannel[];
  /** Stable key so a retried publish never sends the same message twice. */
  dedupeKey: string;
}

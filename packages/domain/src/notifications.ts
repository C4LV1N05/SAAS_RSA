/**
 * Contract between the API (writes rows to notification_outbox) and the worker
 * (claims and delivers them) for staff messages.
 */

/** Order of preference: WhatsApp first, then SMS. Push and email are reserved for later. */
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

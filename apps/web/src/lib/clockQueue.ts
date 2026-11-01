/**
 * Clock actions taken without signal (load-shedding takes towers down too) are
 * kept on the phone and sent when the connection is back. Each keeps the time it
 * happened (deviceTime, offline: true) and its idempotency key, so a resend
 * never creates a second entry. The API accepts offline times up to 72 hours old.
 */
export type ClockAction =
  | { kind: 'in'; key: string; at: string; body: { employeeId: string; locationId: string; shiftId?: string; method: 'mobile'; gps?: { lat: number; lng: number } } }
  | { kind: 'out'; key: string; at: string; timeEntryId?: string };

const STORE = 'saas-rsa.clock-queue';

export function readQueue(): ClockAction[] {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as ClockAction[]) : [];
  } catch {
    return [];
  }
}

export function writeQueue(q: ClockAction[]): void {
  try {
    if (q.length) localStorage.setItem(STORE, JSON.stringify(q));
    else localStorage.removeItem(STORE);
  } catch {
    // Private mode or storage blocked: the action stays in memory for this visit.
  }
}

/** The request each queued action becomes. A clock-out queued before its clock-in synced uses that entry's id. */
export function toRequest(a: ClockAction, lastInId: string | null): { path: string; body: object; key?: string } | null {
  if (a.kind === 'in') return { path: '/v1/time/clock-in', body: { ...a.body, deviceTime: a.at, offline: true }, key: a.key };
  const id = a.timeEntryId ?? lastInId;
  return id ? { path: '/v1/time/clock-out', body: { timeEntryId: id, deviceTime: a.at, offline: true } } : null;
}

/** Is the person clocked in, counting actions still waiting on the phone? */
export function effectiveState(serverOpen: boolean, queue: ClockAction[]): 'in' | 'out' {
  const last = queue[queue.length - 1];
  if (!last) return serverOpen ? 'in' : 'out';
  return last.kind === 'in' ? 'in' : 'out';
}

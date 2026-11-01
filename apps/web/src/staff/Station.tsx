import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, API_URL, ApiError } from '../lib/api';
import { openStream } from '../lib/sse';
import { useStaff } from './StaffShell';

interface QueueItem {
  id: string;
  table: string;
  name: string;
  quantity: number;
  notes: string | null;
  status: 'queued' | 'preparing' | 'ready';
  orderId: string;
  waitingMinutes: number;
}

export interface Ticket {
  orderId: string;
  table: string;
  minutes: number;
  items: QueueItem[];
}

/** One docket per order, oldest first. */
export function toTickets(items: QueueItem[], extraMinutes = 0): Ticket[] {
  const byOrder = new Map<string, Ticket>();
  for (const item of items) {
    const t = byOrder.get(item.orderId) ?? { orderId: item.orderId, table: item.table, minutes: 0, items: [] };
    t.items.push(item);
    t.minutes = Math.max(t.minutes, item.waitingMinutes + extraMinutes);
    byOrder.set(item.orderId, t);
  }
  return [...byOrder.values()].sort((a, b) => b.minutes - a.minutes);
}

export const ageOf = (minutes: number) => (minutes >= 20 ? 'overdue' : minutes >= 10 ? 'late' : 'fresh');

const NEXT: Record<QueueItem['status'], Array<{ status: string; label: string }>> = {
  queued: [
    { status: 'preparing', label: 'Start' },
    { status: 'ready', label: 'Ready' },
  ],
  preparing: [{ status: 'ready', label: 'Ready' }],
  ready: [{ status: 'served', label: 'Collected' }],
};

export function Station() {
  const { station = 'kitchen' } = useParams();
  const { token, locationId, setLive } = useStaff();
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ items: QueueItem[] }>(`/v1/stations/${station}/queue?locationId=${locationId}`, { token });
      setItems(res.items);
      setFetchedAt(Date.now());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [station, token, locationId]);

  useEffect(() => {
    setItems(null);
    void load();
    // Live updates; a slow poll covers anything missed while reconnecting.
    const stop = openStream(
      `${API_URL}/v1/stations/${station}/stream?locationId=${locationId}`,
      token,
      (e) => {
        if (e.event !== 'item') return;
        if (refetchTimer.current) clearTimeout(refetchTimer.current);
        refetchTimer.current = setTimeout(() => void load(), 250);
      },
      setLive,
    );
    const poll = setInterval(() => void load(), 30_000);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      stop();
      clearInterval(poll);
      clearInterval(tick);
      setLive(false);
    };
  }, [station, locationId, token, load, setLive]);

  const bump = async (item: QueueItem, status: string) => {
    // Optimistic: move the item now; the stream confirms it.
    setItems((current) =>
      (current ?? []).flatMap((i) => (i.id !== item.id ? [i] : status === 'served' ? [] : [{ ...i, status: status as QueueItem['status'] }])),
    );
    try {
      await api(`/v1/order-items/${item.id}/status`, { token, body: { status } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not save. Try again.');
      void load();
    }
  };

  const extra = Math.floor((now - fetchedAt) / 60_000);
  const tickets = items ? toTickets(items, extra) : [];
  const title = station === 'bar' ? 'Bar' : 'Kitchen';

  return (
    <main className="staff-main">
      <h1>
        {title} <span className="quiet" style={{ color: '#c6ccd5', fontSize: 'var(--s1)' }}>{tickets.length} {tickets.length === 1 ? 'order' : 'orders'}</span>
      </h1>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {items === null ? (
        <p className="empty-rail">Loading orders…</p>
      ) : tickets.length === 0 ? (
        <p className="empty-rail">All caught up. New orders appear here as they come in.</p>
      ) : (
        <div className="rail" role="list" aria-label={`${title} orders`}>
          {tickets.map((t) => (
            <article key={t.orderId} className="ticket" data-age={ageOf(t.minutes)} role="listitem" aria-label={`Table ${t.table}, ${t.minutes} minutes`}>
              <header>
                <span className="t-table">{t.table}</span>
                <span className="t-age num">{t.minutes} min</span>
              </header>
              <ul>
                {t.items.map((i) => (
                  <li key={i.id} data-status={i.status}>
                    <div className="t-item">
                      <span className="t-qty num">{i.quantity}×</span>
                      <span>
                        {i.name}
                        {i.status !== 'queued' && <span className="quiet" style={{ fontWeight: 400, fontSize: 'var(--s-1)' }}> {i.status === 'preparing' ? 'started' : 'ready'}</span>}
                      </span>
                    </div>
                    {i.notes && <p className="t-note">{i.notes}</p>}
                    <div className="t-actions">
                      {NEXT[i.status].map((n) => (
                        <button key={n.status} className={`btn btn-small${n.status === 'ready' ? ' btn-go' : ''}`} onClick={() => void bump(i, n.status)}>
                          {n.label}
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}

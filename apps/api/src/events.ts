/**
 * Live updates for kitchen, bar and floor screens.
 *
 * A trigger on order_items calls pg_notify('service_events', {orgId, locationId,
 * station, itemId, status}). Each API replica holds one LISTEN connection and fans
 * events out to its connected screens over Server-Sent Events. Events carry ids
 * only; screens re-fetch their queue through the normal, RLS-protected endpoint.
 */
import pg from 'pg';

export interface ServiceEvent {
  orgId: string;
  locationId: string;
  station: 'kitchen' | 'bar';
  itemId: string;
  status: string;
}

export interface Subscription {
  orgId: string;
  locationId: string;
  station?: 'kitchen' | 'bar';
  send(event: ServiceEvent): void;
}

export class ServiceEventBus {
  private readonly subscribers = new Set<Subscription>();

  subscribe(sub: Subscription): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  publish(event: ServiceEvent): number {
    let delivered = 0;
    for (const s of this.subscribers) {
      if (s.orgId !== event.orgId || s.locationId !== event.locationId) continue;
      if (s.station && s.station !== event.station) continue;
      s.send(event);
      delivered += 1;
    }
    return delivered;
  }

  get size(): number {
    return this.subscribers.size;
  }
}

function parseEvent(payload: string | undefined): ServiceEvent | null {
  if (!payload) return null;
  try {
    const e = JSON.parse(payload) as Partial<ServiceEvent>;
    if (typeof e.orgId === 'string' && typeof e.locationId === 'string' && (e.station === 'kitchen' || e.station === 'bar')) {
      return e as ServiceEvent;
    }
  } catch {
    // ignore malformed payloads
  }
  return null;
}

/** LISTEN on a dedicated connection; reconnects with backoff if the connection drops. */
export function listenForServiceEvents(
  connectionString: string,
  bus: ServiceEventBus,
  log: { warn(msg: string): void; info(msg: string): void },
): { close(): Promise<void> } {
  let client: pg.Client | null = null;
  let closed = false;
  let delay = 1000;

  const connect = async () => {
    if (closed) return;
    const c = new pg.Client({ connectionString });
    c.on('notification', (msg) => {
      const event = parseEvent(msg.payload);
      if (event) bus.publish(event);
    });
    c.on('error', (err) => log.warn(`service event listener error: ${err.message}`));
    c.on('end', () => {
      client = null;
      if (!closed) setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    });
    try {
      await c.connect();
      await c.query('listen service_events');
      client = c;
      delay = 1000;
      log.info('listening for service events');
    } catch (err) {
      log.warn(`service event listener could not connect: ${(err as Error).message}`);
      await c.end().catch(() => {});
    }
  };
  void connect();

  return {
    async close() {
      closed = true;
      await client?.end().catch(() => {});
    },
  };
}

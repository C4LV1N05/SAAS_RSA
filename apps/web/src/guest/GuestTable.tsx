import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, newKey } from '../lib/api';
import { clearTipCode, forgetSession, loadSession, loadTipCode, saveSession, type StoredSession } from '../lib/guestSession';
import { rand } from '../lib/money';
import { Menu, type Cart } from './Menu';
import { BillView } from './BillView';
import { PaySheet } from './PaySheet';
import type { MenuCategory, MenuItem, PaymentSummary, TabView } from './types';

type View = 'menu' | 'bill' | 'pay';
type Phase = { kind: 'starting' } | { kind: 'ready' } | { kind: 'ended'; paid: boolean } | { kind: 'invalid' };

interface SessionResponse {
  sessionToken: string;
  expiresAt: string;
  tab: { id: string; table: string; status: string };
}

export function GuestTable() {
  const { tagToken = '' } = useParams();
  const [params] = useSearchParams();
  const [session, setSession] = useState<StoredSession | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [menu, setMenu] = useState<{ categories: MenuCategory[]; items: MenuItem[] } | null>(null);
  const [tab, setTab] = useState<TabView | null>(null);
  const [cart, setCart] = useState<Cart>({});
  const [view, setView] = useState<View>(params.get('pay') ? 'pay' : 'menu');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [myPayments, setMyPayments] = useState<PaymentSummary[]>([]);
  const orderKey = useRef<string | null>(null);
  const paidOnce = useRef(false);

  const start = useCallback(async () => {
    setPhase({ kind: 'starting' });
    setError(null);
    const existing = loadSession(tagToken);
    if (existing) {
      setSession(existing);
      setPhase({ kind: 'ready' });
      return;
    }
    try {
      const res = await api<SessionResponse>('/v1/guest/sessions', { body: { tagToken } });
      const s: StoredSession = { tagToken, sessionToken: res.sessionToken, tabId: res.tab.id, table: res.tab.table, expiresAt: res.expiresAt };
      saveSession(s);
      setSession(s);
      setPhase({ kind: 'ready' });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 400)) setPhase({ kind: 'invalid' });
      else {
        setError((err as Error).message);
        setPhase({ kind: 'invalid' });
      }
    }
  }, [tagToken]);

  useEffect(() => {
    void start();
  }, [start]);

  const guest = session?.sessionToken;

  const handleSessionError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        forgetSession(tagToken);
        setPhase({ kind: 'ended', paid: paidOnce.current });
        return true;
      }
      return false;
    },
    [tagToken],
  );

  const refreshTab = useCallback(async () => {
    if (!guest) return;
    try {
      setTab(await api<TabView>('/v1/guest/tab', { guestSession: guest }));
      const p = await api<{ payments: PaymentSummary[] }>('/v1/guest/payments', { guestSession: guest });
      setMyPayments(p.payments);
      if (p.payments.some((x) => x.mine && x.status === 'succeeded')) paidOnce.current = true;
    } catch (err) {
      if (!handleSessionError(err)) setError((err as Error).message);
    }
  }, [guest, handleSessionError]);

  useEffect(() => {
    if (!guest) return;
    api<{ categories: MenuCategory[]; items: MenuItem[] }>('/v1/guest/menu', { guestSession: guest })
      .then(setMenu)
      .catch((err) => {
        if (!handleSessionError(err)) setError((err as Error).message);
      });
    void refreshTab();
  }, [guest, refreshTab, handleSessionError]);

  // Keep the bill and item statuses fresh while the page is open.
  useEffect(() => {
    if (!guest || phase.kind !== 'ready') return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshTab();
    }, 15_000);
    return () => clearInterval(timer);
  }, [guest, phase.kind, refreshTab]);

  const cartLines = useMemo(() => {
    if (!menu) return [];
    return Object.entries(cart)
      .filter(([, v]) => v.quantity > 0)
      .map(([id, v]) => ({ item: menu.items.find((m) => m.id === id)!, ...v }))
      .filter((l) => l.item);
  }, [cart, menu]);
  const cartCount = cartLines.reduce((s, l) => s + l.quantity, 0);
  const cartCents = cartLines.reduce((s, l) => s + l.quantity * l.item.priceCents, 0);

  const sendOrder = async () => {
    if (!guest || cartLines.length === 0) return;
    setSending(true);
    setError(null);
    orderKey.current ??= newKey(); // the same key on a retry, so nothing is ordered twice
    try {
      const res = await api<{ awaitingConfirmation: boolean }>('/v1/guest/orders', {
        guestSession: guest,
        idempotencyKey: orderKey.current,
        body: {
          items: cartLines.map((l) => ({ menuItemId: l.item.id, quantity: l.quantity, ...(l.notes.trim() ? { notes: l.notes.trim() } : {}) })),
        },
      });
      orderKey.current = null;
      setCart({});
      setNotice(
        res.awaitingConfirmation
          ? 'Order placed. Your waiter will confirm your table, then it goes to the kitchen and bar.'
          : 'Order sent to the kitchen and bar.',
      );
      setView('bill');
      void refreshTab();
    } catch (err) {
      if (handleSessionError(err)) return;
      if (err instanceof ApiError && err.code === 'out_of_stock') {
        orderKey.current = null;
        void api<{ categories: MenuCategory[]; items: MenuItem[] }>('/v1/guest/menu', { guestSession: guest }).then(setMenu);
      }
      setError(err instanceof ApiError && err.code === 'offline' ? `${err.message} Your order hasn't been sent yet.` : (err as Error).message);
    } finally {
      setSending(false);
    }
  };

  if (phase.kind === 'starting') {
    return (
      <main className="guest">
        <p className="quiet" style={{ paddingTop: '3rem' }}>Opening your table…</p>
      </main>
    );
  }

  if (phase.kind === 'invalid') {
    return (
      <main className="landing">
        <h1>This table code isn't working</h1>
        {error ? <p className="notice notice-error">{error}</p> : <p>The code may have been replaced. Ask your waiter for help, or scan the code on your table again.</p>}
        <button className="btn" onClick={() => void start()}>Try again</button>
      </main>
    );
  }

  if (phase.kind === 'ended') {
    return (
      <main className="landing">
        <h1>{phase.paid ? 'Paid. Thank you!' : 'This table has been closed'}</h1>
        <p>{phase.paid ? 'Enjoy the rest of your day.' : 'Your bill was settled at the till. Scan the code on your table to start a new order.'}</p>
        {!phase.paid && (
          <button className="btn btn-go" onClick={() => void start()}>Start a new order</button>
        )}
      </main>
    );
  }

  const table = tab?.tab.table ?? session?.table ?? '';
  const pending = tab?.tab.status === 'pending';
  const waitingPayment = myPayments.find((p) => p.mine && p.status === 'requested');

  return (
    <main className="guest">
      <header className="table-head">
        <h1 className="table-number" aria-label={`Table ${table}`}>
          {table}
          <small>{pending ? 'Your waiter will confirm your table shortly' : 'Order here and we bring it to you'}</small>
        </h1>
      </header>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={view === 'menu'} onClick={() => setView('menu')}>Menu</button>
        <button role="tab" aria-selected={view !== 'menu'} onClick={() => { setView('bill'); void refreshTab(); }}>
          Your bill{tab && tab.bill.outstandingCents > 0 && <span className="num" style={{ fontWeight: 400 }}> ({rand(tab.bill.outstandingCents)})</span>}
        </button>
      </div>

      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {notice && view !== 'menu' && <p className="notice notice-ok" role="status">{notice}</p>}

      {view === 'menu' && (menu ? <Menu menu={menu} cart={cart} onChange={setCart} /> : <p className="quiet">Loading the menu…</p>)}

      {view === 'bill' && tab && (
        <BillView
          view={tab}
          waitingPayment={waitingPayment}
          onPay={() => {
            setNotice(null);
            setView('pay');
          }}
          onOrderMore={() => setView('menu')}
        />
      )}

      {view === 'pay' && tab && guest && (
        <PaySheet
          bill={tab.bill}
          guestSession={guest}
          tipCode={loadTipCode()}
          onCancel={() => setView('bill')}
          onRequested={() => {
            clearTipCode();
            setNotice(null); // the bill shows the waiting amount itself
            setView('bill');
            void refreshTab();
          }}
          onSessionError={handleSessionError}
        />
      )}

      {view === 'menu' && cartCount > 0 && (
        <div className="order-bar">
          <div className="inner">
            <div className="summary">
              <span>{cartCount} {cartCount === 1 ? 'item' : 'items'}</span>
              <strong className="num">{rand(cartCents)}</strong>
            </div>
            <button className="btn btn-go" disabled={sending} onClick={() => void sendOrder()}>
              {sending ? 'Sending…' : 'Send order'}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

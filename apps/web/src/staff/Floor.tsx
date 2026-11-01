import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { rand } from '../lib/money';
import { useStaff } from './StaffShell';

interface FloorTab {
  id: string;
  table: string;
  status: 'pending' | 'open';
  totalCents: number;
  outstandingCents: number;
  awaitingConfirmation: number;
  paymentRequests: Array<{ id: string; mode: string; amountCents: number; tipCents: number; totalCents: number }>;
}

const MODE_LABEL: Record<string, string> = { items: 'their own items', remaining: 'the whole bill', share: 'an equal share' };

/** Tables needing something from the waiter come first. */
export function sortForAction(tabs: FloorTab[]): FloorTab[] {
  const urgency = (t: FloorTab) => (t.paymentRequests.length ? 0 : t.status === 'pending' ? 1 : 2);
  return [...tabs].sort((a, b) => urgency(a) - urgency(b) || a.table.localeCompare(b.table, undefined, { numeric: true }));
}

export function Floor() {
  const { token, locationId } = useStaff();
  const [tabs, setTabs] = useState<FloorTab[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slips, setSlips] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ tabs: FloorTab[] }>(`/v1/tabs?locationId=${locationId}`, { token });
      setTabs(sortForAction(res.tabs));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [token, locationId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 8000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (key: string, path: string, body?: object) => {
    setBusy(key);
    setError(null);
    try {
      await api(path, { token, body: body ?? {} });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work. Try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="staff-main">
      <h1>Floor</h1>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {tabs === null && <p className="quiet">Loading tables…</p>}
      {tabs?.length === 0 && <p>No open tables. New tables appear here when guests scan their table code.</p>}

      {tabs?.map((t) => (
        <section key={t.id} className="floor-table" aria-label={`Table ${t.table}`}>
          <div className="label">
            {t.table}
            <small className="num">{t.totalCents > 0 ? rand(t.totalCents) : 'Nothing yet'}</small>
          </div>
          <div className="actions">
            {t.status === 'pending' && (
              <div className="task">
                <span className="what">
                  New table{t.awaitingConfirmation > 0 ? `: ${t.awaitingConfirmation} ${t.awaitingConfirmation === 1 ? 'item' : 'items'} waiting to go to the kitchen and bar` : ''}
                </span>
                <button className="btn btn-small btn-go" disabled={busy === t.id} onClick={() => void act(t.id, `/v1/tabs/${t.id}/confirm`)}>
                  Confirm table
                </button>
              </div>
            )}

            {t.paymentRequests.map((p) => (
              <div key={p.id} className="task">
                <span className="what">
                  Bring the card machine: <strong className="num">{rand(p.totalCents)}</strong> for {MODE_LABEL[p.mode] ?? p.mode}
                  {p.tipCents > 0 && <span className="quiet"> (includes {rand(p.tipCents)} tip)</span>}
                </span>
                <label>
                  <span className="visually-hidden">Till slip number</span>
                  <input
                    placeholder="Till slip no."
                    value={slips[p.id] ?? ''}
                    onChange={(e) => setSlips({ ...slips, [p.id]: e.target.value })}
                  />
                </label>
                <button
                  className="btn btn-small btn-go"
                  disabled={busy === p.id || !(slips[p.id] ?? '').trim()}
                  onClick={() => void act(p.id, `/v1/payments/${p.id}/record`, { tillReference: slips[p.id]!.trim() })}
                >
                  Mark paid
                </button>
                <button className="link" disabled={busy === p.id} onClick={() => void act(p.id, `/v1/payments/${p.id}/cancel`)}>
                  Cancel request
                </button>
              </div>
            ))}

            {t.status === 'open' && t.paymentRequests.length === 0 && (
              <div className="task calm">
                <span className="what quiet num">{t.outstandingCents > 0 ? `${rand(t.outstandingCents)} still to pay` : 'Nothing to pay'}</span>
                {closing === t.id ? (
                  <>
                    <label>
                      <span className="visually-hidden">Till slip number</span>
                      <input placeholder="Till slip no." value={slips[t.id] ?? ''} onChange={(e) => setSlips({ ...slips, [t.id]: e.target.value })} autoFocus />
                    </label>
                    <button
                      className="btn btn-small"
                      disabled={busy === t.id || !(slips[t.id] ?? '').trim()}
                      onClick={() => void act(t.id, `/v1/tabs/${t.id}/close`, { tillReference: slips[t.id]!.trim() }).then(() => setClosing(null))}
                    >
                      Close table
                    </button>
                  </>
                ) : (
                  <button className="link" onClick={() => setClosing(t.id)}>Paid at the till? Close the table</button>
                )}
              </div>
            )}
          </div>
        </section>
      ))}
    </main>
  );
}

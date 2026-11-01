import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { parseRand, rand, tipOptions } from '../lib/money';
import { payChoices, type PayMode } from './pay';
import type { Bill } from './types';

interface Props {
  bill: Bill;
  guestSession: string;
  tipCode: string | null;
  onCancel: () => void;
  onRequested: () => void;
  onSessionError: (err: unknown) => boolean;
}

export function PaySheet({ bill, guestSession, tipCode, onCancel, onRequested, onSessionError }: Props) {
  const [parts, setParts] = useState(2);
  const choices = payChoices(bill, parts);
  const firstAvailable = (['items', 'remaining', 'share'] as PayMode[]).find((m) => choices[m].available) ?? 'remaining';
  const [mode, setMode] = useState<PayMode>(firstAvailable);
  const [tipIndex, setTipIndex] = useState<number | 'custom'>(0);
  const [customTip, setCustomTip] = useState('');
  const [waiter, setWaiter] = useState<string | null>(null);
  const [useTipCode, setUseTipCode] = useState(Boolean(tipCode));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tipCode) return;
    api<{ waiter: string }>(`/v1/guest/tip-codes/${encodeURIComponent(tipCode)}`, { guestSession })
      .then((r) => setWaiter(r.waiter))
      .catch(() => setUseTipCode(false));
  }, [tipCode, guestSession]);

  const choice = choices[mode];
  const options = tipOptions(choice.amountCents);
  const tipCents = tipIndex === 'custom' ? parseRand(customTip) ?? 0 : options[tipIndex]?.cents ?? 0;
  const customInvalid = tipIndex === 'custom' && customTip !== '' && parseRand(customTip) === null;

  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/v1/guest/payments', {
        guestSession,
        body: {
          mode,
          ...(mode === 'items' ? { itemIds: choice.itemIds } : {}),
          ...(mode === 'share' ? { parts } : {}),
          tipCents,
          ...(useTipCode && tipCode && waiter ? { tipCode } : {}),
        },
      });
      onRequested();
    } catch (err) {
      if (onSessionError(err)) return;
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sheet" aria-labelledby="pay-title">
      <h2 id="pay-title">How do you want to pay?</h2>

      <fieldset className="choice" style={{ border: 'none', padding: 0, margin: '0 0 1.25rem' }}>
        <legend className="visually-hidden">What to pay for</legend>
        <label>
          <input type="radio" name="mode" checked={mode === 'items'} disabled={!choices.items.available} onChange={() => setMode('items')} />
          <span>
            Just my items
            <span className="sub">{choices.items.available ? 'Everything marked yours' : choices.items.reason}</span>
          </span>
          <span className="num">{choices.items.available ? rand(choices.items.amountCents) : ''}</span>
        </label>
        <label>
          <input type="radio" name="mode" checked={mode === 'remaining'} disabled={!choices.remaining.available} onChange={() => setMode('remaining')} />
          <span>
            The whole bill
            <span className="sub">{choices.remaining.available ? 'Everything still to pay' : choices.remaining.reason}</span>
          </span>
          <span className="num">{rand(choices.remaining.amountCents)}</span>
        </label>
        <label>
          <input type="radio" name="mode" checked={mode === 'share'} disabled={!choices.share.available} onChange={() => setMode('share')} />
          <span>
            Split equally
            {choices.share.available ? (
              <span className="sub split">
                Between
                <span className="stepper stepper-sm">
                  <button type="button" onClick={() => setParts(Math.max(2, parts - 1))} aria-label="Fewer people">−</button>
                  <output aria-live="polite">{parts}</output>
                  <button type="button" onClick={() => setParts(Math.min(20, parts + 1))} aria-label="More people">+</button>
                </span>
                people
              </span>
            ) : (
              <span className="sub">{choices.share.reason}</span>
            )}
          </span>
          <span className="num">{choices.share.available ? rand(choices.share.amountCents) : ''}</span>
        </label>
      </fieldset>

      <h3 style={{ margin: '0 0 0.25rem' }}>
        Add a tip{useTipCode && waiter ? ` for ${waiter}` : ''}
      </h3>
      {useTipCode && waiter && (
        <p className="quiet" style={{ margin: 0 }}>
          From the code you scanned. <button className="link" onClick={() => setUseTipCode(false)}>Tip your table's waiter instead</button>
        </p>
      )}
      <div className="tip-row" role="group" aria-label="Tip amount">
        {options.map((o, i) => (
          <button key={o.label} type="button" aria-pressed={tipIndex === i} onClick={() => setTipIndex(i)}>
            {o.label}
            {o.cents > 0 && <small className="num">{rand(o.cents)}</small>}
          </button>
        ))}
        <button type="button" aria-pressed={tipIndex === 'custom'} onClick={() => setTipIndex('custom')}>Other</button>
      </div>
      {tipIndex === 'custom' && (
        <p>
          <label>
            Tip amount in rand{' '}
            <input
              className="note-input"
              inputMode="decimal"
              value={customTip}
              onChange={(e) => setCustomTip(e.target.value)}
              placeholder="e.g. 50"
              style={{ maxWidth: '8rem' }}
            />
          </label>
          {customInvalid && <span className="notice-error" style={{ display: 'block' }}>Enter an amount like 50 or 45.50</span>}
        </p>
      )}

      {error && <p className="notice notice-error" role="alert">{error}</p>}

      <button className="btn btn-go btn-block" disabled={busy || !choice.available || customInvalid} onClick={() => void request()}>
        {busy ? 'Calling your waiter…' : <>Call waiter to pay <span className="num">{rand(choice.amountCents + tipCents)}</span></>}
      </button>
      <p className="quiet" style={{ fontSize: 'var(--s-1)', textAlign: 'center' }}>
        Your waiter brings the card machine. You pay there, by card or cash.
      </p>
      <p style={{ textAlign: 'center' }}>
        <button className="link" onClick={onCancel}>Back to the bill</button>
      </p>
    </section>
  );
}

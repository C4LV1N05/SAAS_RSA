import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { addDays, hm, longDayLabel, sastDate } from '../lib/dates';
import { parseRand, rand } from '../lib/money';
import { useStaff } from './StaffShell';
import { loadTeam, nameLookup, type Team } from './team';

interface Pool {
  id: string;
  name: string;
  strategy: 'group_split_hours' | 'hours_weighted' | 'points' | 'individual';
  config: { groups?: { foh?: number; boh?: number } };
  effectiveFrom: string;
}
interface Declared {
  id: string;
  source: 'cash' | 'card' | 'service_charge_passed_on';
  amountCents: number;
  employeeId: string | null;
  posReference: string | null;
}
interface Share {
  employeeId: string;
  amountCents: number;
  basis: { minutes: number; group: string; weight: number };
}

const SOURCE: Record<Declared['source'], string> = { cash: 'Cash', card: 'Card', service_charge_passed_on: 'Service charge' };
export const STRATEGY: Record<Pool['strategy'], string> = {
  group_split_hours: 'Front and back of house split, then by hours',
  hours_weighted: 'By hours worked',
  points: 'By hours and role points',
  individual: 'Each person keeps their own',
};

export function Tips() {
  const { token, locationId } = useStaff();
  const [date, setDate] = useState(() => addDays(sastDate(), -1));
  const [pools, setPools] = useState<Pool[] | null>(null);
  const [poolId, setPoolId] = useState<string>('');
  const [declared, setDeclared] = useState<Declared[]>([]);
  const [distributed, setDistributed] = useState<Share[]>([]);
  const [preview, setPreview] = useState<{ poolCents: number; shares: Share[] } | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = nameLookup(team);

  const load = useCallback(async () => {
    try {
      const [p, day, t] = await Promise.all([
        api<{ pools: Pool[] }>(`/v1/tips/pools?locationId=${locationId}`, { token }),
        api<{ declared: Declared[]; distributed: Share[] }>(`/v1/tips?locationId=${locationId}&businessDate=${date}`, { token }),
        loadTeam(token, locationId),
      ]);
      setPools(p.pools);
      setPoolId((cur) => cur || p.pools[0]?.id || '');
      setDeclared(day.declared);
      setDistributed(day.distributed);
      setTeam(t);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [token, locationId, date]);

  useEffect(() => {
    setPreview(null);
    setDone(null);
    void load();
  }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const pooled = declared.filter((d) => !d.employeeId).reduce((s, d) => s + d.amountCents, 0);
  const distribute = (commit: boolean) =>
    run(async () => {
      const res = await api<{ poolCents: number; shares: Share[] }>('/v1/tips/distribute', { token, body: { tipPoolId: poolId, businessDate: date, commit } });
      if (commit) {
        setPreview(null);
        setDone(`Recorded. ${res.shares.length} ${res.shares.length === 1 ? 'person gets' : 'people get'} their share in the next payroll.`);
        await load();
      } else setPreview(res);
    });

  return (
    <main className="staff-main">
      <div className="page-head">
        <h1>Tips</h1>
        <label className="date-pick">
          <span className="visually-hidden">Business day</span>
          <input type="date" value={date} max={sastDate()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
      </div>
      <p className="quiet summary-line">{longDayLabel(date)}. Tips are shared from approved hours, and never count toward the minimum wage.</p>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {done && <p className="notice notice-ok" role="status">{done}</p>}

      <section aria-labelledby="declared-h" className="block">
        <h2 id="declared-h">Tips collected</h2>
        {declared.length === 0 && <p className="quiet">Nothing recorded for this day yet.</p>}
        {declared.length > 0 && (
          <ul className="plain-list">
            {declared.map((d) => (
              <li key={d.id}>
                <span>{SOURCE[d.source]}{d.employeeId ? `, kept by ${name(d.employeeId)}` : ', shared'}{d.posReference ? ` · slip ${d.posReference}` : ''}</span>
                <span className="num">{rand(d.amountCents)}</span>
              </li>
            ))}
            <li className="total">
              <span>To share</span>
              <span className="num">{rand(pooled)}</span>
            </li>
          </ul>
        )}
        <DeclareForm team={team} busy={busy} onDeclare={(body) => run(async () => {
          await api('/v1/tips/declare', { token, body: { ...body, locationId, businessDate: date } });
          await load();
        })} />
      </section>

      <section aria-labelledby="share-h" className="block">
        <h2 id="share-h">Share them out</h2>
        {pools?.length === 0 && <NewPool busy={busy} onCreate={(body) => run(async () => {
          await api('/v1/tips/pools', { token, body: { ...body, locationId } });
          await load();
        })} />}
        {pools && pools.length > 0 && (
          <>
            <label className="stack">
              How tips are shared
              <select value={poolId} onChange={(e) => { setPoolId(e.target.value); setPreview(null); }}>
                {pools.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}: {STRATEGY[p.strategy]}
                    {p.config.groups ? ` (${Math.round((p.config.groups.foh ?? 0) * 100)}% front, ${Math.round((p.config.groups.boh ?? 0) * 100)}% kitchen)` : ''}
                  </option>
                ))}
              </select>
            </label>

            {distributed.length > 0 ? (
              <>
                <p className="notice notice-ok">Already shared out for this day.</p>
                <ShareTable shares={distributed} name={name} />
              </>
            ) : (
              <>
                {!preview && (
                  <button className="btn btn-rim" disabled={busy || !poolId} onClick={() => void distribute(false)}>
                    Work out each share
                  </button>
                )}
                {preview && (
                  <>
                    {preview.shares.length === 0 ? (
                      <p className="notice">Nothing to share: no tips, or no approved hours on this day. Approve timesheets first.</p>
                    ) : (
                      <ShareTable shares={preview.shares} name={name} />
                    )}
                    <div className="row">
                      {preview.shares.length > 0 && (
                        <button className="btn btn-go" disabled={busy} onClick={() => void distribute(true)}>
                          Record for payroll
                        </button>
                      )}
                      <button className="link" onClick={() => setPreview(null)}>Start again</button>
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}
      </section>
    </main>
  );
}

function ShareTable({ shares, name }: { shares: Share[]; name: (id: string) => string }) {
  const total = shares.reduce((s, x) => s + x.amountCents, 0);
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th scope="col">Who</th>
          <th scope="col">Hours</th>
          <th scope="col" className="r">Share</th>
        </tr>
      </thead>
      <tbody>
        {shares.map((s) => (
          <tr key={s.employeeId}>
            <td>
              {name(s.employeeId)} <small className="quiet">{s.basis.group === 'boh' ? 'kitchen' : s.basis.group === 'foh' ? 'front' : ''}</small>
            </td>
            <td className="num">{hm(s.basis.minutes)}</td>
            <td className="num r">{rand(s.amountCents)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" colSpan={2}>Total</th>
          <td className="num r">{rand(total)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

function DeclareForm(props: { team: Team | null; busy: boolean; onDeclare: (b: { source: string; amountCents: number; employeeId?: string; posReference?: string }) => void }) {
  const [source, setSource] = useState('cash');
  const [amount, setAmount] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const cents = parseRand(amount);
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!cents) return;
        props.onDeclare({ source, amountCents: cents, ...(employeeId ? { employeeId } : {}) });
        setAmount('');
      }}
    >
      <label>
        Type
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="cash">Cash</option>
          <option value="card">Card</option>
          <option value="service_charge_passed_on">Service charge</option>
        </select>
      </label>
      <label>
        Amount (R)
        <input inputMode="decimal" value={amount} placeholder="0.00" onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label>
        For
        <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
          <option value="">Everyone (shared)</option>
          {props.team?.employees.map((m) => (
            <option key={m.id} value={m.id}>{m.firstName} {m.lastName} keeps it</option>
          ))}
        </select>
      </label>
      <button className="btn btn-small btn-rim" type="submit" disabled={props.busy || !cents}>Add tips</button>
    </form>
  );
}

function NewPool(props: { busy: boolean; onCreate: (b: { name: string; strategy: string; groups?: { foh: number; boh: number } }) => void }) {
  const [strategy, setStrategy] = useState<Pool['strategy']>('group_split_hours');
  const [foh, setFoh] = useState(70);
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        props.onCreate({ name: 'Tips', strategy, ...(strategy === 'group_split_hours' ? { groups: { foh: foh / 100, boh: (100 - foh) / 100 } } : {}) });
      }}
    >
      <p className="grow">Choose how this restaurant shares pooled tips. You only do this once.</p>
      <label className="grow">
        Rule
        <select value={strategy} onChange={(e) => setStrategy(e.target.value as Pool['strategy'])}>
          {Object.entries(STRATEGY).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </label>
      {strategy === 'group_split_hours' && (
        <label>
          Front of house share
          <select value={foh} onChange={(e) => setFoh(Number(e.target.value))}>
            {[50, 60, 70, 80].map((p) => (
              <option key={p} value={p}>{p}% front, {100 - p}% kitchen</option>
            ))}
          </select>
        </label>
      )}
      <button className="btn btn-small btn-rim" type="submit" disabled={props.busy}>Save rule</button>
    </form>
  );
}

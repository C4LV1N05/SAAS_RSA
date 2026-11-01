import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { addDays, dayLabel, hm, sastDate, weekStart } from '../lib/dates';
import { rand } from '../lib/money';
import { useStaff } from './StaffShell';
import { fullName, loadTeam, type Team, type TeamMember } from './team';

type Frequency = 'weekly' | 'fortnightly' | 'monthly';

interface Line {
  code: string;
  kind: 'earning' | 'deduction' | 'employer_contribution' | 'tip' | 'info';
  description: string;
  quantityMinutes?: number;
  amountCents: number;
  sarsCode?: string;
  needsReview?: boolean;
}
interface Payslip {
  employeeId: string;
  lines: Line[];
  grossCents: number;
  deductionsCents: number;
  netCents: number;
  employerCostCents: number;
  etiCents: number;
}
interface Preview {
  payslips: Payslip[];
  emp201: { payeCents: number; uifCents: number; sdlCents: number; etiCents: number; payableCents: number };
  warnings: Array<{ employeeId: string; code: string; message: string }>;
}

/** The most recent complete period before today, and a pay date a few days after it. */
export function lastPeriod(frequency: Frequency, today = sastDate()): { start: string; end: string; payDate: string } {
  if (frequency === 'monthly') {
    const [y, m] = today.split('-').map(Number) as [number, number];
    const start = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}-01`;
    const end = addDays(`${y}-${String(m).padStart(2, '0')}-01`, -1);
    return { start, end, payDate: addDays(end, 1) };
  }
  const end = addDays(weekStart(today), -1); // last Sunday
  const start = addDays(end, frequency === 'weekly' ? -6 : -13);
  return { start, end, payDate: addDays(end, 5) };
}

/** Why someone cannot be included yet, or null when they can. */
export function blocker(m: TeamMember): string | null {
  if (!m.rate) return 'No pay rate set';
  if (m.rate.type !== 'hourly') return 'Salaried pay comes later';
  if (!m.hasDateOfBirth) return 'Date of birth missing (needed for tax rebates)';
  return null;
}

export function Payroll() {
  const { token, locationId } = useStaff();
  const [frequency, setFrequency] = useState<Frequency>('weekly');
  const [period, setPeriod] = useState(() => lastPeriod('weekly'));
  const [team, setTeam] = useState<Team | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadTeam(token, locationId)
      .then((t) => {
        setTeam(t);
        setChosen(new Set(t.employees.filter((m) => !blocker(m)).map((m) => m.id)));
      })
      .catch((err: Error) => setError(err.message));
  }, [token, locationId]);

  const name = (id: string) => {
    const m = team?.employees.find((e) => e.id === id);
    return m ? fullName(m) : id;
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(
        await api<Preview>('/v1/payroll/preview', {
          token,
          body: { employeeIds: [...chosen], periodStart: period.start, periodEnd: period.end, payDate: period.payDate, frequency },
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The preview did not run. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const totals = preview?.payslips.reduce(
    (t, p) => ({ gross: t.gross + p.grossCents, net: t.net + p.netCents, cost: t.cost + p.employerCostCents }),
    { gross: 0, net: 0, cost: 0 },
  );

  return (
    <main className="staff-main">
      <h1>Payroll</h1>
      <p className="quiet summary-line">
        A preview from approved hours and recorded tips, with PAYE, UIF, SDL and ETI worked out for you. Nothing is saved or paid from this screen.
      </p>
      {error && <p className="notice notice-error" role="alert">{error}</p>}

      <section className="block" aria-labelledby="period-h">
        <h2 id="period-h">Pay period</h2>
        <div className="inline-form">
          <label>
            Paid
            <select
              value={frequency}
              onChange={(e) => {
                const f = e.target.value as Frequency;
                setFrequency(f);
                setPeriod(lastPeriod(f));
                setPreview(null);
              }}
            >
              <option value="weekly">Weekly</option>
              <option value="fortnightly">Fortnightly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          <label>
            From
            <input type="date" value={period.start} onChange={(e) => { setPeriod({ ...period, start: e.target.value }); setPreview(null); }} />
          </label>
          <label>
            To
            <input type="date" value={period.end} min={period.start} onChange={(e) => { setPeriod({ ...period, end: e.target.value }); setPreview(null); }} />
          </label>
          <label>
            Pay day
            <input type="date" value={period.payDate} onChange={(e) => { setPeriod({ ...period, payDate: e.target.value }); setPreview(null); }} />
          </label>
        </div>
      </section>

      <section className="block" aria-labelledby="people-h">
        <h2 id="people-h">Who to pay</h2>
        {team === null && !error && <p className="quiet">Loading the team…</p>}
        <ul className="check-list">
          {team?.employees.map((m) => {
            const why = blocker(m);
            return (
              <li key={m.id}>
                <label className="switch">
                  <input
                    type="checkbox"
                    disabled={!!why}
                    checked={chosen.has(m.id)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(m.id);
                      else next.delete(m.id);
                      setChosen(next);
                      setPreview(null);
                    }}
                  />
                  {fullName(m)}
                </label>
                <span className="quiet small">{why ?? (m.rate ? `${rand(m.rate.cents)} an hour` : '')}</span>
              </li>
            );
          })}
        </ul>
        <button className="btn btn-rim" disabled={busy || chosen.size === 0} onClick={() => void run()}>
          {busy ? 'Working it out…' : `Preview ${chosen.size} ${chosen.size === 1 ? 'payslip' : 'payslips'}`}
        </button>
      </section>

      {preview && totals && (
        <>
          <section className="emp201" aria-labelledby="emp201-h">
            <h2 id="emp201-h">For SARS (EMP201)</h2>
            <p className="quiet small">
              {dayLabel(period.start)} to {dayLabel(period.end)}. Add these to the month's EMP201 on eFiling.
            </p>
            <dl>
              <div><dt>PAYE</dt><dd className="num">{rand(preview.emp201.payeCents)}</dd></div>
              <div><dt>UIF (employee and employer)</dt><dd className="num">{rand(preview.emp201.uifCents)}</dd></div>
              <div><dt>SDL</dt><dd className="num">{rand(preview.emp201.sdlCents)}</dd></div>
              <div><dt>ETI claimed</dt><dd className="num">−{rand(preview.emp201.etiCents)}</dd></div>
              <div className="grand"><dt>Payable</dt><dd className="num">{rand(preview.emp201.payableCents)}</dd></div>
            </dl>
          </section>

          {preview.warnings.length > 0 && (
            <div className="notice" role="note">
              {preview.warnings.map((w) => (
                <p key={`${w.employeeId}${w.code}`}>{name(w.employeeId)}: {w.message}. Approve them on Timesheets to include them.</p>
              ))}
            </div>
          )}

          <section className="block" aria-labelledby="slips-h">
            <h2 id="slips-h">Payslips</h2>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Who</th>
                  <th scope="col" className="r">Gross</th>
                  <th scope="col" className="r">Deductions</th>
                  <th scope="col" className="r">Take-home</th>
                </tr>
              </thead>
              <tbody>
                {preview.payslips.map((p) => (
                  <tr key={p.employeeId}>
                    <td>
                      <details>
                        <summary>{name(p.employeeId)}</summary>
                        <ul className="slip-lines">
                          {p.lines.filter((l) => l.kind !== 'info').map((l) => (
                            <li key={l.code} data-kind={l.kind}>
                              <span>
                                {l.description}
                                {l.quantityMinutes ? <span className="quiet"> · {hm(l.quantityMinutes)}</span> : null}
                                {l.sarsCode ? <span className="quiet"> · IRP5 {l.sarsCode}</span> : null}
                                {l.needsReview ? <span className="review"> · check with your tax practitioner</span> : null}
                              </span>
                              <span className="num">{l.kind === 'deduction' ? '−' : ''}{rand(l.amountCents)}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </td>
                    <td className="num r">{rand(p.grossCents)}</td>
                    <td className="num r">{rand(p.deductionsCents)}</td>
                    <td className="num r"><strong>{rand(p.netCents)}</strong></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  <td className="num r">{rand(totals.gross)}</td>
                  <td className="num r">{rand(totals.gross - totals.net)}</td>
                  <td className="num r">{rand(totals.net)}</td>
                </tr>
              </tfoot>
            </table>
            <p className="quiet small">
              Cost to the business, including employer UIF and SDL: <span className="num">{rand(totals.cost)}</span>. Tap a name to see the payslip lines.
            </p>
          </section>
        </>
      )}
    </main>
  );
}

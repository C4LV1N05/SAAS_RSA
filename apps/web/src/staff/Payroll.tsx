import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, openFile } from '../lib/api';
import { addDays, dayLabel, hm, sastDate, weekStart } from '../lib/dates';
import { rand } from '../lib/money';
import { useStaff } from './StaffShell';
import { fullName, loadTeam, type Team, type TeamMember } from './team';

type Frequency = 'weekly' | 'fortnightly' | 'monthly';
type Status = 'draft' | 'approved' | 'finalised' | 'paid';

interface Line {
  code: string;
  kind: 'earning' | 'deduction' | 'employer_contribution' | 'tip' | 'info';
  description: string;
  quantityMinutes?: number;
  amountCents: number;
  sarsCode?: string;
  needsReview?: boolean;
}
interface Slip {
  id?: string;
  employeeId: string;
  employeeName?: string;
  lines: Line[];
  grossCents: number;
  deductionsCents: number;
  netCents: number;
  employerCostCents: number;
  hasBankDetails?: boolean;
}
interface Emp201 {
  payeCents: number;
  uifCents: number;
  sdlCents: number;
  etiCents: number;
  payableCents: number;
}
interface Warning {
  employeeId: string;
  code: string;
  message: string;
}
interface RunSummary {
  id: string;
  status: Status;
  start: string;
  end: string;
  payDate: string;
  frequency: Frequency;
  people: number;
  netCents: number;
}
interface RunDetail {
  run: { id: string; status: Status; period: { start: string; end: string; payDate: string; frequency: Frequency }; finalisedAt: string | null; paidAt: string | null };
  payslips: Slip[];
  emp201: Emp201;
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

export const STATUS_STEPS: Array<{ status: Status; label: string; help: string }> = [
  { status: 'draft', label: 'Draft', help: 'Check the payslips. Recalculate after approving more hours.' },
  { status: 'approved', label: 'Approved', help: 'Ready to lock. Finalising releases payslips to staff.' },
  { status: 'finalised', label: 'Finalised', help: 'Locked. Download the bank file and pay through your bank.' },
  { status: 'paid', label: 'Paid', help: 'Done. Corrections go into the next run.' },
];

export function Payroll() {
  const { token, locationId } = useStaff();
  const [tab, setTab] = useState<'runs' | 'details'>('runs');
  const [team, setTeam] = useState<Team | null>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, r] = await Promise.all([loadTeam(token, locationId), api<{ runs: RunSummary[] }>('/v1/payroll/runs', { token })]);
      setTeam(t);
      setRuns(r.runs);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [token, locationId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="staff-main">
      <h1>Payroll</h1>
      <div className="tabs staff-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'runs'} onClick={() => setTab('runs')}>Pay runs</button>
        <button role="tab" aria-selected={tab === 'details'} onClick={() => setTab('details')}>Tax and bank details</button>
      </div>
      {error && <p className="notice notice-error" role="alert">{error}</p>}

      {tab === 'runs' &&
        (openRun ? (
          <RunView id={openRun} onBack={() => { setOpenRun(null); void load(); }} />
        ) : (
          <>
            <NewRun team={team} onSaved={(id) => { setOpenRun(id); void load(); }} existing={runs ?? []} onOpen={setOpenRun} />
            <section className="block" aria-labelledby="runs-h">
              <h2 id="runs-h">Earlier runs</h2>
              {runs?.length === 0 && <p className="quiet">No pay runs yet. Your first one starts above.</p>}
              {runs && runs.length > 0 && (
                <ul className="plain-list run-list">
                  {runs.map((r) => (
                    <li key={r.id}>
                      <button className="run-link" onClick={() => setOpenRun(r.id)}>
                        <span>
                          <strong>{dayLabel(r.start)} to {dayLabel(r.end)}</strong>
                          <small className="quiet"> · {r.people} {r.people === 1 ? 'person' : 'people'} · paid {dayLabel(r.payDate)}</small>
                        </span>
                        <span className="row">
                          <span className="num">{rand(r.netCents)}</span>
                          <span className="status-chip" data-status={r.status}>{STATUS_STEPS.find((s) => s.status === r.status)?.label}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ))}

      {tab === 'details' && team && <Details team={team} onChanged={load} />}
    </main>
  );
}

function NewRun(props: { team: Team | null; existing: RunSummary[]; onSaved: (id: string) => void; onOpen: (id: string) => void }) {
  const { token } = useStaff();
  const [frequency, setFrequency] = useState<Frequency>('weekly');
  const [period, setPeriod] = useState(() => lastPeriod('weekly'));
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [preview, setPreview] = useState<{ payslips: Slip[]; emp201: Emp201; warnings: Warning[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const team = props.team;
  const picked = chosen ?? new Set(team?.employees.filter((m) => !blocker(m)).map((m) => m.id) ?? []);
  const clash = props.existing.find((r) => r.start === period.start && r.frequency === frequency);
  const body = () => ({ employeeIds: [...picked], periodStart: period.start, periodEnd: period.end, payDate: period.payDate, frequency });
  const change = (p: Partial<typeof period>) => {
    setPeriod({ ...period, ...p });
    setPreview(null);
  };

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

  return (
    <section className="block" aria-labelledby="new-h">
      <h2 id="new-h">New pay run</h2>
      <div className="inline-form">
        <label>
          Paid
          <select value={frequency} onChange={(e) => { const f = e.target.value as Frequency; setFrequency(f); setPeriod(lastPeriod(f)); setPreview(null); }}>
            <option value="weekly">Weekly</option>
            <option value="fortnightly">Fortnightly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
        <label>
          From
          <input type="date" value={period.start} onChange={(e) => change({ start: e.target.value })} />
        </label>
        <label>
          To
          <input type="date" value={period.end} min={period.start} onChange={(e) => change({ end: e.target.value })} />
        </label>
        <label>
          Pay day
          <input type="date" value={period.payDate} onChange={(e) => change({ payDate: e.target.value })} />
        </label>
      </div>

      {clash ? (
        <p className="notice">
          There is already a run for this period.{' '}
          <button className="link" onClick={() => props.onOpen(clash.id)}>Open it</button>
        </p>
      ) : (
        <>
          <ul className="check-list">
            {team?.employees.map((m) => {
              const why = blocker(m);
              return (
                <li key={m.id}>
                  <label className="switch">
                    <input
                      type="checkbox"
                      disabled={!!why}
                      checked={picked.has(m.id)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(m.id);
                        else next.delete(m.id);
                        setChosen(next);
                        setPreview(null);
                      }}
                    />
                    {fullName(m)}
                  </label>
                  <span className="quiet small">{why ?? (m.rate ? `${rand(m.rate.cents)} an hour${m.hasBankDetails ? '' : ' · no bank details yet'}` : '')}</span>
                </li>
              );
            })}
          </ul>
          {error && <p className="notice notice-error" role="alert">{error}</p>}
          <div className="row">
            <button
              className="btn btn-rim"
              disabled={busy || picked.size === 0}
              onClick={() => void run(async () => setPreview(await api('/v1/payroll/preview', { token, body: body() })))}
            >
              {preview ? 'Preview again' : `Preview ${picked.size} ${picked.size === 1 ? 'payslip' : 'payslips'}`}
            </button>
            {preview && (
              <button
                className="btn btn-go"
                disabled={busy}
                onClick={() => void run(async () => {
                  const res = await api<{ detail: RunDetail }>('/v1/payroll/runs', { token, body: body() });
                  props.onSaved(res.detail.run.id);
                })}
              >
                Save as a draft run
              </button>
            )}
          </div>
          {preview && (
            <>
              <Warnings warnings={preview.warnings} team={team} />
              <Emp201Box emp201={preview.emp201} start={period.start} end={period.end} />
              <PayslipTable slips={preview.payslips} name={(id) => { const m = team?.employees.find((e) => e.id === id); return m ? fullName(m) : id; }} />
            </>
          )}
        </>
      )}
    </section>
  );
}

function RunView({ id, onBack }: { id: string; onBack: () => void }) {
  const { token } = useStaff();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    api<RunDetail>(`/v1/payroll/runs/${id}`, { token }).then(setDetail).catch((err: Error) => setError(err.message));
  }, [id, token]);

  const act = async (fn: () => Promise<RunDetail | { detail: RunDetail; warnings: Warning[] } | void>, message?: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fn();
      if (res && 'detail' in res) {
        setDetail(res.detail);
        setWarnings(res.warnings);
      } else if (res) setDetail(res);
      if (message) setDone(message);
    } catch (err) {
      const e = err as ApiError;
      setError(e.code === 'missing_bank_details' ? `${e.message}. Add them under Tax and bank details, or download without them.` : e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!detail) return <p className="quiet">{error ?? 'Loading the run…'}</p>;
  const { run } = detail;
  const step = STATUS_STEPS.findIndex((s) => s.status === run.status);
  const missingBank = detail.payslips.filter((p) => !p.hasBankDetails).length;

  return (
    <section className="block" aria-labelledby="run-h">
      <button className="link" onClick={onBack}>‹ All pay runs</button>
      <h2 id="run-h" className="run-title">
        {dayLabel(run.period.start)} to {dayLabel(run.period.end)}
        <small className="quiet"> · paid {dayLabel(run.period.payDate)}</small>
      </h2>
      <ol className="run-steps" aria-label="Progress">
        {STATUS_STEPS.map((s, i) => (
          <li key={s.status} data-state={i < step ? 'done' : i === step ? 'current' : 'todo'} aria-current={i === step ? 'step' : undefined}>
            {s.label}
          </li>
        ))}
      </ol>
      <p className="quiet">{STATUS_STEPS[step]?.help}</p>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {done && <p className="notice notice-ok" role="status">{done}</p>}
      <Warnings warnings={warnings} team={null} names={detail.payslips} />

      <div className="row run-actions">
        {(run.status === 'draft' || run.status === 'approved') && (
          <button className="btn btn-small" disabled={busy} onClick={() => void act(() => api(`/v1/payroll/runs/${id}/recalculate`, { token, body: {} }), 'Worked out again from the latest hours, tips and leave.')}>
            Recalculate
          </button>
        )}
        {run.status === 'draft' && (
          <button className="btn btn-small btn-rim" disabled={busy} onClick={() => void act(() => api(`/v1/payroll/runs/${id}/approve`, { token, body: {} }), 'Approved.')}>
            Approve
          </button>
        )}
        {run.status === 'approved' && (
          <button className="btn btn-small btn-go" disabled={busy} onClick={() => setConfirming(true)}>Finalise and release payslips</button>
        )}
        {(run.status === 'finalised' || run.status === 'paid') && (
          <>
            <button className="btn btn-small btn-rim" disabled={busy} onClick={() => void act(() => openFile(`/v1/payroll/runs/${id}/bank-file`, token, 'download'))}>
              Download bank file
            </button>
            {missingBank > 0 && (
              <button className="link" disabled={busy} onClick={() => void act(() => openFile(`/v1/payroll/runs/${id}/bank-file?skipMissing=true`, token, 'download'))}>
                Download without the {missingBank} missing
              </button>
            )}
          </>
        )}
        {run.status === 'finalised' && (
          <button className="btn btn-small btn-go" disabled={busy} onClick={() => void act(() => api(`/v1/payroll/runs/${id}/paid`, { token, body: {} }), 'Marked as paid.')}>
            Mark as paid
          </button>
        )}
        {(run.status === 'draft' || run.status === 'approved') && (
          <button className="link danger" disabled={busy} onClick={() => void act(async () => { await api(`/v1/payroll/runs/${id}`, { token, method: 'DELETE' }); onBack(); })}>
            Delete this run
          </button>
        )}
      </div>

      <Emp201Box emp201={detail.emp201} start={run.period.start} end={run.period.end} />
      <PayslipTable slips={detail.payslips} name={(eid) => detail.payslips.find((p) => p.employeeId === eid)?.employeeName ?? eid} pdf={(slipId) => void act(() => openFile(`/v1/payslips/${slipId}/pdf`, token))} />

      {confirming && (
        <ConfirmDialog
          title="Finalise this run?"
          onClose={() => setConfirming(false)}
          confirmLabel="Finalise"
          onConfirm={() => act(() => api(`/v1/payroll/runs/${id}/finalise`, { token, body: {} }), 'Finalised. Staff can now see their payslips on My shifts.').then(() => setConfirming(false))}
        >
          <p>Finalising locks every payslip in this run for good: corrections go into the next run. Staff can then open their payslips, and the tips and leave paid here are marked as paid.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function Warnings({ warnings, team, names }: { warnings: Warning[]; team: Team | null; names?: Slip[] }) {
  if (!warnings.length) return null;
  const name = (id: string) => names?.find((p) => p.employeeId === id)?.employeeName ?? (team ? fullName(team.employees.find((e) => e.id === id) ?? { firstName: '', lastName: id }) : id);
  return (
    <div className="notice" role="note">
      {warnings.map((w) => (
        <p key={`${w.employeeId}${w.code}`}>{name(w.employeeId)}: {w.message}. Approve them on Timesheets, then recalculate.</p>
      ))}
    </div>
  );
}

function Emp201Box({ emp201, start, end }: { emp201: Emp201; start: string; end: string }) {
  return (
    <section className="emp201" aria-label="For SARS (EMP201)">
      <h2>For SARS (EMP201)</h2>
      <p className="quiet small">{dayLabel(start)} to {dayLabel(end)}. Add these to the month's EMP201 on eFiling.</p>
      <dl>
        <div><dt>PAYE</dt><dd className="num">{rand(emp201.payeCents)}</dd></div>
        <div><dt>UIF (employee and employer)</dt><dd className="num">{rand(emp201.uifCents)}</dd></div>
        <div><dt>SDL</dt><dd className="num">{rand(emp201.sdlCents)}</dd></div>
        <div><dt>ETI claimed</dt><dd className="num">-{rand(emp201.etiCents)}</dd></div>
        <div className="grand"><dt>Payable</dt><dd className="num">{rand(emp201.payableCents)}</dd></div>
      </dl>
    </section>
  );
}

function PayslipTable({ slips, name, pdf }: { slips: Slip[]; name: (id: string) => string; pdf?: (slipId: string) => void }) {
  const totals = slips.reduce((t, p) => ({ gross: t.gross + p.grossCents, net: t.net + p.netCents, cost: t.cost + p.employerCostCents }), { gross: 0, net: 0, cost: 0 });
  return (
    <section className="block" aria-label="Payslips">
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
          {slips.map((p) => (
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
                        <span className="num">{l.kind === 'deduction' ? '-' : ''}{rand(l.amountCents)}</span>
                      </li>
                    ))}
                  </ul>
                  {pdf && p.id && <button className="link small" onClick={() => pdf(p.id!)}>Open payslip (PDF)</button>}
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
      <p className="quiet small">Cost to the business, including employer UIF and SDL: <span className="num">{rand(totals.cost)}</span>. Tap a name to see the payslip lines.</p>
    </section>
  );
}

// ------------------------------------------------------------ tax and bank details

interface Personal {
  idNumber: string | null;
  taxNumber: string | null;
  dateOfBirth: string | null;
  bank: { holder: string; bankName: string; branchCode: string; accountType: string; accountNumber: string } | null;
  revealed: boolean;
}

/** Universal branch codes (mirrors packages/domain/src/identity.ts). */
const BANKS: Record<string, string> = {
  ABSA: '632005', 'African Bank': '430000', 'Bidvest Bank': '462005', Capitec: '470010', 'Discovery Bank': '679000',
  FNB: '250655', Investec: '580105', Nedbank: '198765', 'Standard Bank': '051001', TymeBank: '678910',
};

function Details({ team, onChanged }: { team: Team; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<TeamMember | null>(null);
  const chip = (ok: boolean | undefined, label: string) => <span className="detail-chip" data-ok={ok ? 'yes' : 'no'}>{ok ? label : `No ${label.toLowerCase()}`}</span>;
  return (
    <section className="block">
      <p className="quiet summary-line">
        ID, tax and bank numbers are encrypted before they are stored. Screens show only the last four digits; showing a full number is recorded.
      </p>
      <ul className="plain-list">
        {team.employees.map((m) => (
          <li key={m.id} className="detail-row">
            <span>
              <strong>{fullName(m)}</strong>
              <span className="detail-chips">
                {chip(m.hasDateOfBirth, 'Date of birth')}
                {chip(m.hasIdNumber, 'ID number')}
                {chip(m.hasTaxNumber, 'Tax number')}
                {chip(m.hasBankDetails, 'Bank details')}
              </span>
            </span>
            <button className="btn btn-small" onClick={() => setEditing(m)}>Edit</button>
          </li>
        ))}
      </ul>
      {editing && <DetailsDialog member={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await onChanged(); }} />}
    </section>
  );
}

function DetailsDialog({ member, onClose, onSaved }: { member: TeamMember; onClose: () => void; onSaved: () => Promise<void> }) {
  const { token } = useStaff();
  const ref = useRef<HTMLDialogElement>(null);
  const [current, setCurrent] = useState<Personal | null>(null);
  const [form, setForm] = useState({ idNumber: '', taxNumber: '', dateOfBirth: '', holder: '', bankName: '', branchCode: '', accountNumber: '', accountType: 'savings' });
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    d?.addEventListener('close', onClose);
    return () => d?.removeEventListener('close', onClose);
  }, [onClose]);

  const fetchPersonal = useCallback(
    async (reveal: boolean) => {
      const res = await api<{ personal: Personal }>(`/v1/employees/${member.id}/personal${reveal ? '?reveal=true' : ''}`, { token });
      setCurrent(res.personal);
      setForm((f) => ({
        ...f,
        dateOfBirth: res.personal.dateOfBirth ?? '',
        holder: res.personal.bank?.holder ?? `${member.firstName.charAt(0)} ${member.lastName}`,
        bankName: res.personal.bank?.bankName ?? '',
        branchCode: res.personal.bank?.branchCode ?? '',
        accountType: res.personal.bank?.accountType || 'savings',
        ...(reveal ? { idNumber: res.personal.idNumber ?? '', taxNumber: res.personal.taxNumber ?? '', accountNumber: res.personal.bank?.accountNumber ?? '' } : {}),
      }));
    },
    [member, token],
  );

  useEffect(() => {
    fetchPersonal(false).catch((err: Error) => setError(err.message));
  }, [fetchPersonal]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (form.idNumber.trim()) body.idNumber = form.idNumber;
      if (form.taxNumber.trim()) body.taxNumber = form.taxNumber;
      if (form.dateOfBirth && form.dateOfBirth !== current?.dateOfBirth) body.dateOfBirth = form.dateOfBirth;
      if (form.accountNumber.trim()) {
        body.bank = { holder: form.holder, bankName: form.bankName, branchCode: form.branchCode, accountNumber: form.accountNumber, accountType: form.accountType };
      }
      if (Object.keys(body).length === 0) {
        setError('Nothing to save: type a new number to replace one on file.');
        return;
      }
      const res = await api<{ warnings: string[] }>(`/v1/employees/${member.id}/personal`, { token, method: 'PUT', body });
      if (res.warnings.length) {
        setWarnings(res.warnings);
        await fetchPersonal(false);
        setForm((f) => ({ ...f, idNumber: '', taxNumber: '', accountNumber: '' }));
      } else await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <dialog ref={ref} className="sheet-dialog" aria-labelledby="details-title">
      <h2 id="details-title">{fullName(member)}</h2>
      <p className="quiet small">
        On file: ID {current?.idNumber ?? 'none'} · tax {current?.taxNumber ?? 'none'} · bank {current?.bank ? `${current.bank.bankName} ${current.bank.accountNumber}` : 'none'}
        {current && !current.revealed && (current.idNumber || current.taxNumber || current.bank) && (
          <> · <button className="link small" onClick={() => void fetchPersonal(true)}>Show full numbers</button></>
        )}
      </p>
      <div className="field-grid">
        <label>
          SA ID number
          <input inputMode="numeric" autoComplete="off" value={form.idNumber} placeholder={current?.idNumber ? 'Type to replace' : '13 digits'} onChange={set('idNumber')} />
        </label>
        <label>
          Tax number
          <input inputMode="numeric" autoComplete="off" value={form.taxNumber} placeholder={current?.taxNumber ? 'Type to replace' : '10 digits'} onChange={set('taxNumber')} />
        </label>
        <label>
          Date of birth
          <input type="date" value={form.dateOfBirth} onChange={set('dateOfBirth')} />
        </label>
        <label>
          Bank
          <select
            value={form.bankName}
            onChange={(e) => setForm({ ...form, bankName: e.target.value, branchCode: BANKS[e.target.value] ?? form.branchCode })}
          >
            <option value="">Choose a bank</option>
            {Object.keys(BANKS).map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <label>
          Account number
          <input inputMode="numeric" autoComplete="off" value={form.accountNumber} placeholder={current?.bank ? 'Type to replace' : ''} onChange={set('accountNumber')} />
        </label>
        <label>
          Branch code
          <input inputMode="numeric" value={form.branchCode} onChange={set('branchCode')} />
        </label>
        <label>
          Account holder
          <input value={form.holder} onChange={set('holder')} />
        </label>
        <label>
          Account type
          <select value={form.accountType} onChange={set('accountType')}>
            <option value="savings">Savings</option>
            <option value="cheque">Cheque / current</option>
            <option value="transmission">Transmission</option>
          </select>
        </label>
      </div>
      <p className="quiet small">An ID number fills in the date of birth when it is missing.</p>
      {warnings.length > 0 && <p className="notice" role="status">Saved. {warnings.join(' ')}</p>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <span className="spacer" />
        <button className="btn btn-small" onClick={() => ref.current?.close()}>Close</button>
        <button className="btn btn-small btn-rim" disabled={busy} onClick={() => void save()}>Save details</button>
      </div>
    </dialog>
  );
}

export function ConfirmDialog(props: { title: string; confirmLabel: string; onClose: () => void; onConfirm: () => Promise<void>; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    d?.addEventListener('close', props.onClose);
    return () => d?.removeEventListener('close', props.onClose);
  }, [props.onClose]);
  return (
    <dialog ref={ref} className="sheet-dialog" aria-labelledby="confirm-title">
      <h2 id="confirm-title">{props.title}</h2>
      {props.children}
      <div className="dialog-actions">
        <span className="spacer" />
        <button className="btn btn-small" onClick={() => ref.current?.close()}>Not yet</button>
        <button className="btn btn-small btn-go" disabled={busy} onClick={() => { setBusy(true); void props.onConfirm().finally(() => setBusy(false)); }}>
          {props.confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

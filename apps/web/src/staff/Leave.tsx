import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { dayLabel, daysText, sastDate } from '../lib/dates';
import { useStaff } from './StaffShell';

export type LeaveType = 'annual' | 'sick' | 'family_responsibility';
export interface LeaveRequest {
  id: string;
  employeeId: string;
  employeeName: string;
  leaveType: LeaveType;
  startsOn: string;
  endsOn: string;
  minutes: number;
  reason: string | null;
  status: 'requested' | 'approved' | 'declined' | 'cancelled';
  decisionNote: string | null;
  medicalCertificateRequired: boolean;
}
export interface Balance {
  type: LeaveType;
  label: string;
  availableMinutes: number;
  entitledMinutes: number;
  takenMinutes: number;
  dayMinutes: number;
  note?: string;
}

export const LEAVE_NAME: Record<LeaveType, string> = { annual: 'Annual', sick: 'Sick', family_responsibility: 'Family responsibility' };

/** "Tue 3 Nov" or "Tue 3 Nov to Thu 5 Nov" */
export const rangeText = (a: string, b: string) => (a === b ? dayLabel(a) : `${dayLabel(a)} to ${dayLabel(b)}`);

export function Leave() {
  const { token, locationId, claims } = useStaff();
  const [requests, setRequests] = useState<LeaveRequest[] | null>(null);
  const [balances, setBalances] = useState<Array<{ employeeId: string; name: string; balances: Balance[] }>>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const canAdjust = claims.role === 'owner' || claims.role === 'payroll_admin';

  const load = useCallback(async () => {
    try {
      const [r, b] = await Promise.all([
        api<{ requests: LeaveRequest[] }>(`/v1/leave/requests?locationId=${locationId}&from=${sastDate()}`, { token }),
        api<{ employees: Array<{ employeeId: string; name: string; balances: Balance[] }> }>(`/v1/leave/team-balances?locationId=${locationId}`, { token }),
      ]);
      setRequests(r.requests);
      setBalances(b.employees);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [token, locationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (key: string, path: string, body: object = {}) => {
    setBusy(key);
    setError(null);
    try {
      await api(path, { token, body });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const pending = requests?.filter((r) => r.status === 'requested').sort((a, b) => a.startsOn.localeCompare(b.startsOn)) ?? [];
  const upcoming = requests?.filter((r) => r.status === 'approved').sort((a, b) => a.startsOn.localeCompare(b.startsOn)) ?? [];
  const balanceOf = (employeeId: string, type: LeaveType) => balances.find((e) => e.employeeId === employeeId)?.balances.find((b) => b.type === type);

  return (
    <main className="staff-main">
      <h1>Leave</h1>
      <p className="quiet summary-line">
        Leave follows the BCEA: annual leave builds up at an hour for every 17 worked; sick leave is six weeks' worth per three-year cycle. Approved leave is paid in the next pay run.
      </p>
      {error && <p className="notice notice-error" role="alert">{error}</p>}

      <section className="block" aria-labelledby="pending-h">
        <h2 id="pending-h">To decide</h2>
        {requests === null && <p className="quiet">Loading…</p>}
        {requests && pending.length === 0 && <p className="quiet">No requests waiting.</p>}
        {pending.map((r) => {
          const bal = balanceOf(r.employeeId, r.leaveType);
          const short = bal && r.minutes > bal.availableMinutes;
          return (
            <article key={r.id} className="leave-card">
              <div>
                <strong>{r.employeeName}</strong> <span className="quiet">· {LEAVE_NAME[r.leaveType]} leave</span>
                <p className="leave-when">{rangeText(r.startsOn, r.endsOn)} <span className="quiet">· {daysText(r.minutes, bal?.dayMinutes ?? 540)}</span></p>
                {r.reason && <p className="quiet small">"{r.reason}"</p>}
                {bal && (
                  <p className={`small ${short ? 'warn-text' : 'quiet'}`}>
                    {daysText(Math.max(0, bal.availableMinutes), bal.dayMinutes)} available{short ? ': not enough, so part would be unpaid' : ''}
                  </p>
                )}
                {r.medicalCertificateRequired && <p className="small warn-text">Ask for a medical certificate (more than two days, or a third absence in eight weeks).</p>}
              </div>
              <div className="leave-actions">
                <label>
                  <span className="visually-hidden">Note to {r.employeeName}</span>
                  <input placeholder="Note (optional)" value={notes[r.id] ?? ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} />
                </label>
                <div className="row">
                  <button className="btn btn-small btn-go" disabled={busy === r.id} onClick={() => void act(r.id, `/v1/leave/requests/${r.id}/approve`, notes[r.id] ? { note: notes[r.id] } : {})}>Approve</button>
                  <button className="btn btn-small" disabled={busy === r.id} onClick={() => void act(r.id, `/v1/leave/requests/${r.id}/decline`, notes[r.id] ? { note: notes[r.id] } : {})}>Decline</button>
                </div>
              </div>
            </article>
          );
        })}
      </section>

      <section className="block" aria-labelledby="upcoming-h">
        <h2 id="upcoming-h">Coming up</h2>
        {requests && upcoming.length === 0 && <p className="quiet">No approved leave ahead.</p>}
        <ul className="plain-list">
          {upcoming.map((r) => (
            <li key={r.id}>
              <span>
                <strong>{r.employeeName}</strong> <span className="quiet">· {LEAVE_NAME[r.leaveType]} · {rangeText(r.startsOn, r.endsOn)}</span>
              </span>
              <button className="link small" disabled={busy === r.id} onClick={() => void act(r.id, `/v1/leave/requests/${r.id}/cancel`)}>Cancel</button>
            </li>
          ))}
        </ul>
      </section>

      <section className="block" aria-labelledby="bal-h">
        <h2 id="bal-h">Balances</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Who</th>
              <th scope="col" className="r">Annual</th>
              <th scope="col" className="r">Sick</th>
              <th scope="col" className="r">Family</th>
            </tr>
          </thead>
          <tbody>
            {balances.map((e) => (
              <tr key={e.employeeId}>
                <td>{e.name}</td>
                {(['annual', 'sick', 'family_responsibility'] as const).map((t) => {
                  const b = e.balances.find((x) => x.type === t)!;
                  return (
                    <td key={t} className="num r" data-negative={b.availableMinutes < 0 || undefined} title={b.note}>
                      {daysText(b.availableMinutes, b.dayMinutes)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {canAdjust && <Adjust employees={balances} onDone={load} />}
      </section>
    </main>
  );
}

function Adjust({ employees, onDone }: { employees: Array<{ employeeId: string; name: string; balances: Balance[] }>; onDone: () => Promise<void> }) {
  const { token } = useStaff();
  const [employeeId, setEmployeeId] = useState('');
  const [type, setType] = useState<LeaveType>('annual');
  const [days, setDays] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const dayMinutes = employees.find((e) => e.employeeId === employeeId)?.balances[0]?.dayMinutes ?? 540;
  const n = Number(days.replace(',', '.'));
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        api('/v1/leave/adjustments', { token, body: { employeeId, leaveType: type, minutes: Math.round(n * dayMinutes), reason: reason.trim() } })
          .then(async () => {
            setMsg('Balance adjusted.');
            setDays('');
            setReason('');
            await onDone();
          })
          .catch((err: Error) => setMsg(err.message));
      }}
    >
      <p className="grow quiet small">Opening balances and corrections (owners and payroll only). Use a minus sign to take days off a balance.</p>
      <label>
        Who
        <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required>
          <option value="">Choose</option>
          {employees.map((e) => <option key={e.employeeId} value={e.employeeId}>{e.name}</option>)}
        </select>
      </label>
      <label>
        Leave
        <select value={type} onChange={(e) => setType(e.target.value as LeaveType)}>
          {Object.entries(LEAVE_NAME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <label>
        Days
        <input inputMode="decimal" value={days} placeholder="e.g. 4.5" onChange={(e) => setDays(e.target.value)} />
      </label>
      <label className="grow">
        Reason
        <input value={reason} minLength={5} placeholder="Opening balance from the old system" onChange={(e) => setReason(e.target.value)} />
      </label>
      <button className="btn btn-small btn-rim" type="submit" disabled={!employeeId || !n || reason.trim().length < 5}>Adjust balance</button>
      {msg && <p className="grow small" role="status">{msg}</p>}
    </form>
  );
}

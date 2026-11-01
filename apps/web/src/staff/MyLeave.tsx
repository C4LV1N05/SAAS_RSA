/** "My shifts" sections for staff: leave balances and requests, and payslips. */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, openFile } from '../lib/api';
import { addDays, dayLabel, daysText, sastDate } from '../lib/dates';
import { rand } from '../lib/money';
import { LEAVE_NAME, rangeText, type Balance, type LeaveRequest, type LeaveType } from './Leave';
import { useStaff } from './StaffShell';

const STATUS: Record<LeaveRequest['status'], string> = { requested: 'Waiting for a manager', approved: 'Approved', declined: 'Declined', cancelled: 'Cancelled' };

export function MyLeave() {
  const { token } = useStaff();
  const [balances, setBalances] = useState<Balance[] | null>(null);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [asking, setAsking] = useState(false);
  const [form, setForm] = useState({ leaveType: 'annual' as LeaveType, startsOn: addDays(sastDate(), 7), endsOn: addDays(sastDate(), 7), days: '', reason: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [b, r] = await Promise.all([
        api<{ balances: Balance[] }>('/v1/leave/balances', { token }),
        api<{ requests: LeaveRequest[] }>(`/v1/leave/requests?from=${addDays(sastDate(), -30)}`, { token }),
      ]);
      setBalances(b.balances);
      setRequests(r.requests);
    } catch {
      // Offline or no employee record: the clock card above already says so.
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!balances) return null;
  const day = balances[0]?.dayMinutes ?? 540;

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const days = Number(form.days.replace(',', '.'));
      const res = await api<{ warnings: string[]; request: LeaveRequest }>('/v1/leave/requests', {
        token,
        body: { leaveType: form.leaveType, startsOn: form.startsOn, endsOn: form.endsOn, ...(days ? { days } : {}), ...(form.reason.trim() ? { reason: form.reason.trim() } : {}) },
      });
      setAsking(false);
      setMsg({
        ok: true,
        text: `Sent to your manager.${res.request.medicalCertificateRequired ? ' Bring a medical certificate when you are back.' : ''}${res.warnings.length ? ` ${res.warnings[0]}` : ''}`,
      });
      await load();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'That did not send. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="block" aria-labelledby="leave-h">
      <h2 id="leave-h">Leave</h2>
      <ul className="leave-balances">
        {balances.map((b) => (
          <li key={b.type}>
            <span className="num big">{daysText(Math.max(0, b.availableMinutes), b.dayMinutes)}</span>
            <span>{LEAVE_NAME[b.type]}</span>
          </li>
        ))}
      </ul>
      {msg && <p className={`notice ${msg.ok ? 'notice-ok' : 'notice-error'}`} role="status">{msg.text}</p>}
      {asking ? (
        <form className="leave-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <label>
            Type of leave
            <select value={form.leaveType} onChange={(e) => setForm({ ...form, leaveType: e.target.value as LeaveType })}>
              {Object.entries(LEAVE_NAME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <div className="field-pair">
            <label>
              From
              <input type="date" value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value, endsOn: e.target.value > form.endsOn ? e.target.value : form.endsOn })} />
            </label>
            <label>
              Until
              <input type="date" value={form.endsOn} min={form.startsOn} onChange={(e) => setForm({ ...form, endsOn: e.target.value })} />
            </label>
          </div>
          <label>
            Working days away <span className="quiet">(leave empty for every day in between)</span>
            <input inputMode="decimal" value={form.days} placeholder="e.g. 2 or 0.5" onChange={(e) => setForm({ ...form, days: e.target.value })} />
          </label>
          <label>
            Note for your manager <span className="quiet">(optional)</span>
            <input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </label>
          <div className="row">
            <button className="btn btn-go" type="submit" disabled={busy}>Send request</button>
            <button className="link" type="button" onClick={() => setAsking(false)}>Cancel</button>
          </div>
          <p className="quiet small">A day counts as {Math.round((day / 60) * 10) / 10} hours for you.</p>
        </form>
      ) : (
        <button className="btn btn-block" onClick={() => setAsking(true)}>Ask for leave</button>
      )}
      {requests.length > 0 && (
        <ul className="plain-list">
          {requests.map((r) => (
            <li key={r.id}>
              <span>
                {LEAVE_NAME[r.leaveType]} · {rangeText(r.startsOn, r.endsOn)}
                <small className="quiet"> · {STATUS[r.status]}{r.decisionNote ? `: "${r.decisionNote}"` : ''}</small>
              </span>
              {r.status === 'requested' && (
                <button className="link small" onClick={() => void api(`/v1/leave/requests/${r.id}/cancel`, { token, body: {} }).then(load)}>Withdraw</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface MyPayslip {
  id: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  netCents: number;
}

export function MyPayslips() {
  const { token } = useStaff();
  const [slips, setSlips] = useState<MyPayslip[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ payslips: MyPayslip[] }>('/v1/me/payslips', { token }).then((r) => setSlips(r.payslips)).catch(() => setSlips(null));
  }, [token]);
  if (!slips || slips.length === 0) return null;
  return (
    <section className="block" aria-labelledby="slips-h">
      <h2 id="slips-h">Payslips</h2>
      {error && <p className="notice notice-error">{error}</p>}
      <ul className="plain-list">
        {slips.map((s) => (
          <li key={s.id}>
            <button className="run-link" onClick={() => void openFile(`/v1/payslips/${s.id}/pdf`, token).catch((e: Error) => setError(e.message))}>
              <span>
                <strong>Paid {dayLabel(s.payDate)}</strong>
                <small className="quiet"> · {rangeText(s.periodStart, s.periodEnd)}</small>
              </span>
              <span className="num">{rand(s.netCents)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

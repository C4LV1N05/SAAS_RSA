import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { addDays, dayLabel, hm, longDayLabel, minutesBetween, sastDate, sastInstant, timeOf, weekDays, weekStart } from '../lib/dates';
import { useStaff } from './StaffShell';
import { loadTeam, nameLookup, type Team } from './team';

export interface Entry {
  id: string;
  employeeId: string;
  clockIn: string;
  clockOut: string | null;
  status: 'open' | 'submitted' | 'approved' | 'rejected';
  method: 'mobile' | 'kiosk' | 'manager';
  capturedOffline: boolean;
  editReason: string | null;
  workedMinutes: number;
  breaks: Array<{ id: string; startsAt: string; endsAt: string | null; paid: boolean }>;
  shift: { startsAt: string; endsAt: string } | null;
}

/** Things a manager should look at before approving. */
export function flags(e: Entry): string[] {
  const out: string[] = [];
  if (!e.shift) out.push('No shift planned');
  else {
    const late = minutesBetween(e.shift.startsAt, e.clockIn);
    if (late > 10) out.push(`${late} min late`);
    if (e.clockOut) {
      const over = minutesBetween(e.shift.endsAt, e.clockOut);
      if (over > 15) out.push(`${over} min past shift end`);
    }
  }
  if (e.capturedOffline) out.push('Clocked offline');
  if (e.editReason) out.push(`Edited: ${e.editReason}`);
  return out;
}

const STATUS: Record<Entry['status'], string> = { open: 'On shift', submitted: 'To approve', approved: 'Approved', rejected: 'Rejected' };

export function Timesheets() {
  const { token, locationId } = useStaff();
  // Opens on the week holding yesterday: on a Monday, that's last week's hours to approve.
  const [monday, setMonday] = useState(() => weekStart(addDays(sastDate(), -1)));
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [res, t] = await Promise.all([
        api<{ entries: Entry[] }>(`/v1/time?locationId=${locationId}&from=${monday}&to=${addDays(monday, 6)}`, { token }),
        loadTeam(token, locationId),
      ]);
      setEntries(res.entries);
      setTeam(t);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [token, locationId, monday]);

  useEffect(() => {
    setEntries(null);
    void load();
  }, [load]);

  const name = nameLookup(team);
  const toApprove = entries?.filter((e) => e.status === 'submitted') ?? [];
  const approvedMinutes = entries?.filter((e) => e.status === 'approved').reduce((m, e) => m + e.workedMinutes, 0) ?? 0;

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const approveAll = () =>
    act('all', async () => {
      for (const e of toApprove) await api(`/v1/time/${e.id}/approve`, { token, body: {} });
    });

  return (
    <main className="staff-main">
      <div className="page-head">
        <h1>Timesheets</h1>
        <div className="week-nav" role="group" aria-label="Week">
          <button className="btn btn-small" onClick={() => setMonday(addDays(monday, -7))} aria-label="Previous week">‹</button>
          <span className="week-label">Week of {dayLabel(monday)}</span>
          <button className="btn btn-small" onClick={() => setMonday(addDays(monday, 7))} aria-label="Next week">›</button>
        </div>
      </div>
      {entries && (
        <p className="quiet summary-line">
          <span className="num">{hm(approvedMinutes)}</span> approved for payroll
          {toApprove.length > 0 && <> · <strong className="draft-count">{toApprove.length} to approve</strong></>}
        </p>
      )}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {entries === null && !error && <p className="quiet">Loading timesheets…</p>}
      {entries?.length === 0 && <p>No one clocked in this week.</p>}

      {entries &&
        weekDays(monday).map((d) => {
          const list = entries.filter((e) => sastDate(new Date(e.clockIn)) === d);
          if (!list.length) return null;
          return (
            <section key={d} aria-labelledby={`day-${d}`}>
              <h2 id={`day-${d}`} className="day-head">{longDayLabel(d)}</h2>
              {list.map((e) => (
                <article key={e.id} className="time-row" data-status={e.status}>
                  <div className="time-who">
                    <strong>{name(e.employeeId)}</strong>
                    <span className="status-chip" data-status={e.status}>{STATUS[e.status]}</span>
                  </div>
                  <div className="time-times">
                    <span className="num big-times">
                      {timeOf(e.clockIn)}–{e.clockOut ? timeOf(e.clockOut) : 'now'}
                    </span>
                    <span className="quiet">
                      <span className="num">{hm(e.workedMinutes)}</span> worked
                      {e.breaks.length > 0 && <>, {e.breaks.length === 1 ? '1 break' : `${e.breaks.length} breaks`}</>}
                      {e.shift && <> · planned <span className="num">{timeOf(e.shift.startsAt)}–{timeOf(e.shift.endsAt)}</span></>}
                    </span>
                    {flags(e).length > 0 && (
                      <ul className="flags">
                        {flags(e).map((f) => <li key={f}>{f}</li>)}
                      </ul>
                    )}
                  </div>
                  <div className="time-actions">
                    {e.status === 'submitted' && (
                      <button className="btn btn-small btn-go" disabled={busy === e.id} onClick={() => void act(e.id, () => api(`/v1/time/${e.id}/approve`, { token, body: {} }))}>
                        Approve
                      </button>
                    )}
                    {e.clockOut && editing !== e.id && (
                      <button className="link" onClick={() => setEditing(e.id)}>Correct times</button>
                    )}
                  </div>
                  {editing === e.id && (
                    <EditTimes
                      entry={e}
                      busy={busy === e.id}
                      onCancel={() => setEditing(null)}
                      onSave={(body) => act(e.id, () => api(`/v1/time/${e.id}`, { token, method: 'PATCH', body })).then(() => setEditing(null))}
                    />
                  )}
                </article>
              ))}
            </section>
          );
        })}

      {toApprove.length > 1 && (
        <div className="publish-bar">
          <span>
            <strong className="num">{toApprove.length}</strong> entries are waiting. Only approved hours go to payroll and tips.
          </span>
          <button className="btn btn-go" disabled={busy === 'all'} onClick={() => void approveAll()}>
            Approve all {toApprove.length}
          </button>
        </div>
      )}
    </main>
  );
}

function EditTimes(props: { entry: Entry; busy: boolean; onCancel: () => void; onSave: (body: { clockIn: string; clockOut: string; reason: string }) => void }) {
  const date = sastDate(new Date(props.entry.clockIn));
  const [start, setStart] = useState(timeOf(props.entry.clockIn));
  const [end, setEnd] = useState(props.entry.clockOut ? timeOf(props.entry.clockOut) : '');
  const [reason, setReason] = useState('');
  return (
    <form
      className="edit-times"
      onSubmit={(ev) => {
        ev.preventDefault();
        const clockIn = sastInstant(date, start);
        props.onSave({ clockIn, clockOut: sastInstant(date, end, clockIn), reason: reason.trim() });
      }}
    >
      <label>
        In
        <input type="time" value={start} required onChange={(e) => setStart(e.target.value)} />
      </label>
      <label>
        Out
        <input type="time" value={end} required onChange={(e) => setEnd(e.target.value)} />
      </label>
      <label className="grow">
        Reason (kept on record)
        <input value={reason} minLength={5} required placeholder="e.g. Phone off during load-shedding" onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="row">
        <button type="submit" className="btn btn-small btn-rim" disabled={props.busy || reason.trim().length < 5}>Save correction</button>
        <button type="button" className="link" onClick={props.onCancel}>Cancel</button>
      </div>
      <p className="quiet small">A corrected entry needs approving again.</p>
    </form>
  );
}

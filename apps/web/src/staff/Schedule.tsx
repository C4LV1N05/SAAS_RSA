import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { addDays, dayLabel, hm, longDayLabel, minutesBetween, sastDate, sastInstant, timeOf, weekDays, weekStart } from '../lib/dates';
import { rand } from '../lib/money';
import { canOverride, canPublish } from './access';
import { useStaff } from './StaffShell';
import { fullName, loadTeam, nameLookup, type Team } from './team';

export interface Shift {
  id: string;
  employeeId: string | null;
  locationId: string;
  startsAt: string;
  endsAt: string;
  plannedBreakMinutes: number;
  status: 'draft' | 'published' | 'cancelled';
}

interface Finding {
  ruleKey: string;
  severity: 'block' | 'warn';
  subjectId: string;
  message: string;
  employeeId: string;
  week: string;
}

/** Paid minutes on a shift: its length less the planned unpaid break. */
export const shiftMinutes = (s: Pick<Shift, 'startsAt' | 'endsAt' | 'plannedBreakMinutes'>) =>
  Math.max(0, minutesBetween(s.startsAt, s.endsAt) - s.plannedBreakMinutes);

/** Labour cost of a set of shifts at each person's hourly rate (salaried staff are not costed per shift). */
export function labourCents(shifts: Shift[], team: Team | null): number {
  return shifts.reduce((sum, s) => {
    const rate = team?.employees.find((e) => e.id === s.employeeId)?.rate;
    return rate?.type === 'hourly' ? sum + Math.round((rate.cents * shiftMinutes(s)) / 60) : sum;
  }, 0);
}

interface Draft {
  id?: string;
  employeeId: string | null;
  date: string;
  start: string;
  end: string;
  breakMinutes: number;
}

export function Schedule() {
  const { token, locationId, claims } = useStaff();
  const [monday, setMonday] = useState(() => weekStart(sastDate()));
  const [team, setTeam] = useState<Team | null>(null);
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [review, setReview] = useState<Finding[] | null>(null);
  const [away, setAway] = useState<Array<{ employeeId: string; startsOn: string; endsOn: string; leaveType: string }>>([]);

  const days = weekDays(monday);
  const name = nameLookup(team);

  const load = useCallback(async () => {
    try {
      const from = encodeURIComponent(sastInstant(monday, '00:00'));
      const to = encodeURIComponent(sastInstant(addDays(monday, 7), '00:00'));
      const [t, s] = await Promise.all([
        loadTeam(token, locationId),
        api<{ shifts: Shift[] }>(`/v1/shifts?from=${from}&to=${to}&locationId=${locationId}`, { token }),
      ]);
      setTeam(t);
      setShifts(s.shifts.filter((x) => x.status !== 'cancelled'));
      setError(null);
      // Approved leave shows on the roster; a missing permission or signal just hides it.
      api<{ requests: Array<{ employeeId: string; startsOn: string; endsOn: string; leaveType: string }> }>(
        `/v1/leave/requests?locationId=${locationId}&status=approved&from=${monday}&to=${addDays(monday, 6)}`,
        { token },
      )
        .then((r) => setAway(r.requests))
        .catch(() => setAway([]));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [token, locationId, monday]);

  useEffect(() => {
    setShifts(null);
    void load();
  }, [load]);

  const drafts = useMemo(() => shifts?.filter((s) => s.status === 'draft') ?? [], [shifts]);
  const onDay = (list: Shift[], date: string) => list.filter((s) => sastDate(new Date(s.startsAt)) === date);
  const rows = [
    ...(team?.employees.map((e) => ({ id: e.id as string | null, label: fullName(e), sub: e.jobRole ?? '' })) ?? []),
    { id: null, label: 'Open shifts', sub: 'Anyone can pick these up' },
  ];
  const totalMinutes = shifts?.reduce((m, s) => m + shiftMinutes(s), 0) ?? 0;

  const save = async (d: Draft) => {
    const startsAt = sastInstant(d.date, d.start);
    const body = { employeeId: d.employeeId, startsAt, endsAt: sastInstant(d.date, d.end, startsAt), plannedBreakMinutes: d.breakMinutes };
    try {
      if (d.id) await api(`/v1/shifts/${d.id}`, { token, method: 'PATCH', body });
      else await api('/v1/shifts', { token, body: { ...body, locationId } });
      setEditing(null);
      setDone(null);
      await load();
    } catch (err) {
      throw err instanceof ApiError ? err : new Error('Could not save the shift. Try again.');
    }
  };

  const remove = async (id: string) => {
    await api(`/v1/shifts/${id}`, { token, method: 'DELETE' });
    setEditing(null);
    await load();
  };

  const check = async () => {
    setError(null);
    setDone(null);
    try {
      const res = await api<{ findings: Finding[] }>('/v1/shifts/publish', { token, body: { shiftIds: drafts.map((s) => s.id), dryRun: true } });
      setReview(res.findings);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const publish = async (overrides: Array<{ ruleKey: string; subjectId: string; reason: string }>) => {
    const res = await api<{ published: number; notified: number }>('/v1/shifts/publish', { token, body: { shiftIds: drafts.map((s) => s.id), overrides } });
    setReview(null);
    setDone(
      `Published ${res.published} ${res.published === 1 ? 'shift' : 'shifts'}.` +
        (res.notified ? ` ${res.notified} ${res.notified === 1 ? 'person' : 'people'} will get a WhatsApp or SMS.` : ''),
    );
    await load();
  };

  return (
    <main className="staff-main wide">
      <div className="page-head">
        <h1>Schedule</h1>
        <div className="week-nav" role="group" aria-label="Week">
          <button className="btn btn-small" onClick={() => setMonday(addDays(monday, -7))} aria-label="Previous week">‹</button>
          <span className="week-label">Week of {dayLabel(monday)}</span>
          <button className="btn btn-small" onClick={() => setMonday(addDays(monday, 7))} aria-label="Next week">›</button>
          {monday !== weekStart(sastDate()) && (
            <button className="link" onClick={() => setMonday(weekStart(sastDate()))}>This week</button>
          )}
        </div>
      </div>

      {shifts && (
        <p className="quiet summary-line">
          <span className="num">{hm(totalMinutes)}</span> scheduled · <span className="num">{rand(labourCents(shifts, team))}</span> in wages
          {drafts.length > 0 && <> · <strong className="draft-count">{drafts.length} not published</strong></>}
        </p>
      )}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {done && <p className="notice notice-ok" role="status">{done}</p>}
      {shifts === null && !error && <p className="quiet">Loading the week…</p>}

      {shifts && team && (
        <div className="roster-scroll" tabIndex={0} aria-label="Week schedule, scrolls sideways">
          <table className="roster">
            <thead>
              <tr>
                <th scope="col" className="who">Team</th>
                {days.map((d) => {
                  const mins = onDay(shifts, d).reduce((m, s) => m + shiftMinutes(s), 0);
                  return (
                    <th key={d} scope="col" data-today={d === sastDate() || undefined}>
                      {dayLabel(d).split(' ')[0]} <span className="num">{dayLabel(d).split(' ')[1]}</span>
                      <small className="num">{mins ? hm(mins) : '–'}</small>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const mine = shifts.filter((s) => s.employeeId === r.id);
                const week = mine.reduce((m, s) => m + shiftMinutes(s), 0);
                return (
                  <tr key={r.id ?? 'open'}>
                    <th scope="row" className="who">
                      {r.label}
                      <small>
                        {r.sub}
                        {r.id && week > 0 && <> · <span className="num" data-over={week > 45 * 60 || undefined}>{hm(week)}</span></>}
                      </small>
                    </th>
                    {days.map((d) => (
                      <td key={d}>
                        {r.id && away.some((a) => a.employeeId === r.id && a.startsOn <= d && a.endsOn >= d) && (
                          <span className="leave-pill">On leave</span>
                        )}
                        {onDay(mine, d).map((s) => (
                          <button
                            key={s.id}
                            className="shift-chip"
                            data-status={s.status}
                            onClick={() =>
                              setEditing({ id: s.id, employeeId: s.employeeId, date: d, start: timeOf(s.startsAt), end: timeOf(s.endsAt), breakMinutes: s.plannedBreakMinutes })
                            }
                            aria-label={`${r.label}, ${longDayLabel(d)}, ${timeOf(s.startsAt)} to ${timeOf(s.endsAt)}${s.status === 'draft' ? ', not published' : ''}. Edit`}
                          >
                            <span className="num">{timeOf(s.startsAt)}–{timeOf(s.endsAt)}</span>
                            {s.status === 'draft' && <small>Draft</small>}
                          </button>
                        ))}
                        <button
                          className="add-shift"
                          onClick={() => setEditing({ employeeId: r.id, date: d, start: '10:00', end: '18:00', breakMinutes: 60 })}
                          aria-label={`Add a shift for ${r.label} on ${longDayLabel(d)}`}
                        >
                          +
                        </button>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {team?.employees.length === 0 && <p>No one has this location as their home yet. Add employees to start scheduling.</p>}

      {drafts.length > 0 && (
        <div className="publish-bar">
          <span>
            <strong className="num">{drafts.length}</strong> {drafts.length === 1 ? 'shift is' : 'shifts are'} not published. Staff can't see drafts.
          </span>
          {canPublish(claims.role) ? (
            <button className="btn btn-go" onClick={() => void check()}>Check and publish</button>
          ) : (
            <span className="quiet">A general manager publishes the week.</span>
          )}
        </div>
      )}

      {editing && team && (
        <ShiftDialog
          draft={editing}
          team={team}
          onClose={() => setEditing(null)}
          onSave={save}
          onDelete={editing.id ? () => remove(editing.id!) : undefined}
          published={shifts?.find((s) => s.id === editing.id)?.status === 'published'}
        />
      )}
      {review && (
        <PublishDialog
          findings={review}
          count={drafts.length}
          name={name}
          mayOverride={canOverride(claims.role)}
          onClose={() => setReview(null)}
          onPublish={publish}
        />
      )}
    </main>
  );
}

/** The same warning for the same person on several shifts is shown once, with a count. */
export function groupWarnings(findings: Finding[]): Array<{ employeeId: string; message: string; times: number }> {
  const out = new Map<string, { employeeId: string; message: string; times: number }>();
  for (const f of findings) {
    const k = `${f.employeeId}|${f.ruleKey}|${f.message}`;
    const cur = out.get(k);
    if (cur) cur.times += 1;
    else out.set(k, { employeeId: f.employeeId, message: f.message, times: 1 });
  }
  return [...out.values()];
}

function useModal(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    const close = () => onClose();
    d?.addEventListener('close', close);
    return () => d?.removeEventListener('close', close);
  }, [onClose]);
  return ref;
}

function ShiftDialog(props: {
  draft: Draft;
  team: Team;
  published: boolean;
  onClose: () => void;
  onSave: (d: Draft) => Promise<void>;
  onDelete?: (() => Promise<void>) | undefined;
}) {
  const ref = useModal(props.onClose);
  const [d, setD] = useState(props.draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startsAt = sastInstant(d.date, d.start);
  const minutes = shiftMinutes({ startsAt, endsAt: sastInstant(d.date, d.end, startsAt), plannedBreakMinutes: d.breakMinutes });
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="sheet-dialog" aria-labelledby="shift-title">
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => props.onSave(d));
        }}
      >
        <h2 id="shift-title">{props.draft.id ? 'Edit shift' : 'New shift'}</h2>
        <p className="quiet">{longDayLabel(d.date)}</p>
        {props.published ? (
          <p className="notice">
            This shift is published, so staff can already see it. You can cancel it here; to change the times, cancel it and add a new shift.
          </p>
        ) : (
          <div className="field-grid">
            <label>
              Who
              <select value={d.employeeId ?? ''} onChange={(e) => setD({ ...d, employeeId: e.target.value || null })}>
                <option value="">Open shift (anyone)</option>
                {props.team.employees.map((m) => (
                  <option key={m.id} value={m.id}>{fullName(m)}</option>
                ))}
              </select>
            </label>
            <label>
              Starts
              <input type="time" value={d.start} required onChange={(e) => setD({ ...d, start: e.target.value })} />
            </label>
            <label>
              Ends
              <input type="time" value={d.end} required onChange={(e) => setD({ ...d, end: e.target.value })} />
            </label>
            <label>
              Unpaid break
              <select value={d.breakMinutes} onChange={(e) => setD({ ...d, breakMinutes: Number(e.target.value) })}>
                {[0, 30, 45, 60].map((m) => (
                  <option key={m} value={m}>{m === 0 ? 'None' : `${m} minutes`}</option>
                ))}
              </select>
            </label>
          </div>
        )}
        {!props.published && (
          <p className="quiet">
            <span className="num">{hm(minutes)}</span> paid{d.end <= d.start ? ', ending the next morning' : ''}.
          </p>
        )}
        {error && <p className="notice notice-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          {props.onDelete && (
            <button type="button" className="link danger" disabled={busy} onClick={() => void run(props.onDelete!)}>
              {props.published ? 'Cancel this shift' : 'Delete shift'}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn btn-small" onClick={() => ref.current?.close()}>Close</button>
          {!props.published && (
            <button type="submit" className="btn btn-small btn-rim" disabled={busy}>Save shift</button>
          )}
        </div>
      </form>
    </dialog>
  );
}

function PublishDialog(props: {
  findings: Finding[];
  count: number;
  name: (id: string) => string;
  mayOverride: boolean;
  onClose: () => void;
  onPublish: (overrides: Array<{ ruleKey: string; subjectId: string; reason: string }>) => Promise<void>;
}) {
  const ref = useModal(props.onClose);
  const blocks = props.findings.filter((f) => f.severity === 'block');
  const warnings = groupWarnings(props.findings.filter((f) => f.severity !== 'block'));
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = (f: Finding) => `${f.ruleKey}:${f.subjectId}`;
  const ready = blocks.every((f) => (reasons[key(f)] ?? '').trim().length >= 5);

  return (
    <dialog ref={ref} className="sheet-dialog" aria-labelledby="publish-title">
      <h2 id="publish-title">
        {blocks.length ? 'This week breaks the BCEA' : `Publish ${props.count} ${props.count === 1 ? 'shift' : 'shifts'}`}
      </h2>
      {props.findings.length === 0 && <p>No problems found against the BCEA or the minimum wage.</p>}

      {blocks.length > 0 && (
        <section className="findings" aria-label="Must fix or override">
          <p>
            {props.mayOverride
              ? 'Change the shifts, or record why each one is allowed (for example, a signed overtime agreement). Your reason is kept with the schedule.'
              : 'Change the shifts before publishing.'}
          </p>
          {blocks.map((f) => (
            <div key={key(f)} className="finding" data-severity="block">
              <strong>{props.name(f.employeeId)}</strong>
              <span>{f.message}</span>
              {props.mayOverride && (
                <label>
                  <span className="visually-hidden">Reason this is allowed</span>
                  <input
                    placeholder="Why this is allowed"
                    value={reasons[key(f)] ?? ''}
                    onChange={(e) => setReasons({ ...reasons, [key(f)]: e.target.value })}
                  />
                </label>
              )}
            </div>
          ))}
        </section>
      )}

      {warnings.length > 0 && (
        <section className="findings" aria-label="Worth checking">
          <p className="quiet">Worth checking, but they won't stop publishing:</p>
          {warnings.map((w) => (
            <div key={`${w.employeeId}${w.message}`} className="finding" data-severity="warn">
              <strong>{props.name(w.employeeId)}</strong>
              <span>
                {w.message}
                {w.times > 1 && <span className="quiet"> On {w.times} shifts.</span>}
              </span>
            </div>
          ))}
        </section>
      )}

      {error && <p className="notice notice-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <span className="spacer" />
        <button className="btn btn-small" onClick={() => ref.current?.close()}>Back to the schedule</button>
        {(blocks.length === 0 || props.mayOverride) && (
          <button
            className="btn btn-small btn-go"
            disabled={busy || !ready}
            onClick={() => {
              setBusy(true);
              setError(null);
              props
                .onPublish(blocks.map((f) => ({ ruleKey: f.ruleKey, subjectId: f.subjectId, reason: reasons[key(f)]!.trim() })))
                .catch((err: Error) => {
                  setError(err.message);
                  setBusy(false);
                });
            }}
          >
            {blocks.length ? 'Publish with these reasons' : 'Publish and notify staff'}
          </button>
        )}
      </div>
    </dialog>
  );
}

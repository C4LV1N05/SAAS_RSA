import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, newKey } from '../lib/api';
import { effectiveState, readQueue, toRequest, writeQueue, type ClockAction } from '../lib/clockQueue';
import { dayLabel, hm, minutesBetween, sastDate, timeOf } from '../lib/dates';
import { useStaff } from './StaffShell';
import { MyLeave, MyPayslips } from './MyLeave';

interface MeShift {
  id: string;
  locationId: string;
  startsAt: string;
  endsAt: string;
  plannedBreakMinutes: number;
}
interface MeEntry {
  id: string;
  clockIn: string;
  clockOut: string | null;
  status: string;
  workedMinutes: number;
  breaks: Array<{ id: string; startsAt: string; endsAt: string | null }>;
}
interface MeData {
  employee: { id: string; firstName: string; lastName: string; locationId: string } | null;
  openEntry: MeEntry | null;
  shifts: MeShift[];
  recentEntries: MeEntry[];
}

/** The shift to clock in against: one under way, or starting within two hours. */
export function currentShift(shifts: MeShift[], now = Date.now()): MeShift | undefined {
  return shifts.find((s) => Date.parse(s.startsAt) - 2 * 3_600_000 <= now && Date.parse(s.endsAt) > now);
}

function position(): Promise<{ lat: number; lng: number } | undefined> {
  if (!('geolocation' in navigator)) return Promise.resolve(undefined);
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(undefined), // declined or unavailable: clock in anyway, the manager sees it
      { timeout: 6000, maximumAge: 60_000 },
    ),
  );
}

const STATUS: Record<string, string> = { submitted: 'Waiting for approval', approved: 'Approved', open: 'On shift', rejected: 'Not accepted' };

export function Me() {
  const { token } = useStaff();
  const [data, setData] = useState<MeData | null>(null);
  const [queue, setQueue] = useState<ClockAction[]>(() => readQueue());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const syncing = useRef(false);

  const load = useCallback(async () => {
    try {
      setData(await api<MeData>('/v1/me', { token }));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'offline') setNotice('No signal. You can still clock in and out: it is saved on this phone.');
      else setError((err as Error).message);
    }
  }, [token]);

  const save = (q: ClockAction[]) => {
    writeQueue(q);
    setQueue(q);
  };

  /** Send anything saved while offline, oldest first. */
  const sync = useCallback(async () => {
    if (syncing.current) return;
    const pending = readQueue();
    if (!pending.length) return;
    syncing.current = true;
    let lastInId: string | null = null;
    try {
      while (pending.length) {
        const req = toRequest(pending[0]!, lastInId);
        if (req) {
          const res = await api<{ entry: { id: string } }>(req.path, { token, body: req.body, ...(req.key ? { idempotencyKey: req.key } : {}) });
          if (pending[0]!.kind === 'in') lastInId = res.entry.id;
        }
        pending.shift();
        writeQueue(pending);
        setQueue([...pending]);
      }
      setNotice('Back online. Your saved clock times have been sent.');
      await load();
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'offline')) {
        // The server refused it (e.g. too old): drop it and say so, rather than retrying forever.
        pending.shift();
        writeQueue(pending);
        setQueue([...pending]);
        setError(`A saved clock time could not be sent: ${(err as Error).message}. Ask your manager to correct it.`);
      }
    } finally {
      syncing.current = false;
    }
  }, [token, load]);

  useEffect(() => {
    void sync().then(load);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const retry = setInterval(() => void sync(), 30_000);
    const online = () => void sync();
    window.addEventListener('online', online);
    return () => {
      clearInterval(tick);
      clearInterval(retry);
      window.removeEventListener('online', online);
    };
  }, [sync, load]);

  if (!data && !error) return <main className="staff-main me"><p className="quiet">Loading your shifts…</p></main>;
  if (data && !data.employee) {
    return (
      <main className="staff-main me">
        <h1>My shifts</h1>
        <p>Your login isn't linked to an employee record, so there are no shifts or clock times to show. Ask the owner to link it.</p>
      </main>
    );
  }

  const state = effectiveState(Boolean(data?.openEntry), queue);
  const shift = data ? currentShift(data.shifts, now) : undefined;
  const pendingIn = [...queue].reverse().find((a) => a.kind === 'in');
  const since = data?.openEntry?.clockIn ?? (state === 'in' ? pendingIn?.at : undefined);
  const onBreak = Boolean(data?.openEntry?.breaks.some((b) => !b.endsAt));

  const clock = async (kind: 'in' | 'out') => {
    if (!data?.employee) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const key = newKey();
    const at = new Date().toISOString();
    const gps = kind === 'in' ? await position() : undefined;
    const action: ClockAction =
      kind === 'in'
        ? {
            kind,
            key,
            at,
            body: {
              employeeId: data.employee.id,
              locationId: shift?.locationId ?? data.employee.locationId,
              method: 'mobile',
              ...(shift ? { shiftId: shift.id } : {}),
              ...(gps ? { gps } : {}),
            },
          }
        : { kind, key, at, ...(data.openEntry ? { timeEntryId: data.openEntry.id } : {}) };
    try {
      if (queue.length) throw new ApiError(0, 'offline', 'queued behind earlier actions');
      if (action.kind === 'in') {
        const res = await api<{ warnings: string[] }>('/v1/time/clock-in', { token, body: action.body, idempotencyKey: key });
        if (res.warnings.includes('outside_geofence')) setNotice("You're clocked in. Your phone shows you away from the restaurant, so your manager will check this entry.");
        else if (res.warnings.includes('no_gps')) setNotice("You're clocked in. Your location wasn't shared, so your manager will check this entry.");
      } else {
        await api('/v1/time/clock-out', { token, body: { timeEntryId: data.openEntry!.id } });
      }
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'offline') {
        save([...queue, action]);
        setNotice(`No signal. Clocked ${kind} at ${timeOf(at)} on this phone; it will be sent when you're back online.`);
      } else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const takeBreak = async (action: 'start' | 'end') => {
    setBusy(true);
    setError(null);
    try {
      await api('/v1/me/break', { token, body: { action } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'offline' ? 'Breaks need signal. Try again in a moment.' : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const upcoming = data?.shifts.filter((s) => s.id !== shift?.id) ?? [];

  return (
    <main className="staff-main me">
      <h1>{data?.employee ? `Hi ${data.employee.firstName}` : 'My shifts'}</h1>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}

      <section className="clock-card" data-state={state} aria-live="polite">
        {state === 'in' && since ? (
          <>
            <p className="clock-label">{onBreak ? 'On a break' : 'On shift'} since <span className="num">{timeOf(since)}</span></p>
            <p className="clock-big num">{hm(Math.max(0, minutesBetween(since, new Date(now))))}</p>
            {shift && <p className="clock-sub">Shift ends at <span className="num">{timeOf(shift.endsAt)}</span></p>}
            <div className="clock-actions">
              {data?.openEntry && (
                <button className="btn" disabled={busy} onClick={() => void takeBreak(onBreak ? 'end' : 'start')}>
                  {onBreak ? 'End break' : 'Start break'}
                </button>
              )}
              <button className="btn btn-go" disabled={busy || onBreak} onClick={() => void clock('out')}>Clock out</button>
            </div>
          </>
        ) : (
          <>
            <p className="clock-label">{shift ? 'Your shift' : 'Not on shift'}</p>
            <p className="clock-big num">{shift ? `${timeOf(shift.startsAt)}–${timeOf(shift.endsAt)}` : timeOf(new Date(now))}</p>
            <p className="clock-sub">{shift ? (Date.parse(shift.startsAt) > now ? `Starts in ${hm(minutesBetween(new Date(now), shift.startsAt))}` : 'Started') : 'No shift in the next two hours'}</p>
            <div className="clock-actions">
              <button className="btn btn-go btn-block" disabled={busy} onClick={() => void clock('in')}>
                {busy ? 'Clocking in…' : 'Clock in'}
              </button>
            </div>
          </>
        )}
        {queue.length > 0 && (
          <p className="clock-pending">
            {queue.length} clock {queue.length === 1 ? 'time' : 'times'} saved on this phone, waiting for signal.
          </p>
        )}
      </section>

      <section aria-labelledby="upcoming-h" className="block">
        <h2 id="upcoming-h">Coming up</h2>
        {upcoming.length === 0 ? (
          <p className="quiet">No published shifts in the next two weeks.</p>
        ) : (
          <ul className="plain-list shift-list">
            {upcoming.map((s) => (
              <li key={s.id}>
                <span>{sastDate(new Date(s.startsAt)) === sastDate() ? 'Today' : dayLabel(sastDate(new Date(s.startsAt)))}</span>
                <span className="num">{timeOf(s.startsAt)}–{timeOf(s.endsAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <MyLeave />
      <MyPayslips />

      {data && data.recentEntries.length > 0 && (
        <section aria-labelledby="recent-h" className="block">
          <h2 id="recent-h">Last 7 days</h2>
          <ul className="plain-list">
            {data.recentEntries.map((e) => (
              <li key={e.id}>
                <span>
                  {dayLabel(sastDate(new Date(e.clockIn)))} <span className="num quiet">{timeOf(e.clockIn)}–{e.clockOut ? timeOf(e.clockOut) : ''}</span>
                  <small className="quiet"> · {STATUS[e.status] ?? e.status}</small>
                </span>
                <span className="num">{hm(e.workedMinutes)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

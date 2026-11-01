import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { canSee, homeScreen, type Screen } from './access';
import { chooseLocation, chosenLocation, decodeClaims, getStaffToken, signIn, signOut, usesAuth0, type StaffClaims } from '../lib/staffAuth';

interface StaffContext {
  token: string;
  claims: StaffClaims;
  locationId: string;
  live: boolean;
  setLive: (live: boolean) => void;
}

const Ctx = createContext<StaffContext | null>(null);
export function useStaff(): StaffContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('useStaff outside StaffShell');
  return c;
}

const NAV: Array<{ name: string; links: Array<{ to: string; label: string; screen: Screen }> }> = [
  { name: 'You', links: [{ to: '/staff/me', label: 'My shifts', screen: 'me' }] },
  {
    name: 'Service',
    links: [
      { to: '/staff/floor', label: 'Floor', screen: 'floor' },
      { to: '/staff/station/kitchen', label: 'Kitchen', screen: 'kitchen' },
      { to: '/staff/station/bar', label: 'Bar', screen: 'bar' },
      { to: '/staff/menu', label: 'Menu', screen: 'menu' },
    ],
  },
  {
    name: 'Team',
    links: [
      { to: '/staff/schedule', label: 'Schedule', screen: 'schedule' },
      { to: '/staff/timesheets', label: 'Timesheets', screen: 'timesheets' },
      { to: '/staff/leave', label: 'Leave', screen: 'leave' },
      { to: '/staff/tips', label: 'Tips', screen: 'tips' },
      { to: '/staff/logbook', label: 'Log book', screen: 'logbook' },
      { to: '/staff/payroll', label: 'Payroll', screen: 'payroll' },
    ],
  },
];

/** /staff opens the first screen this role uses. */
export function StaffHome() {
  const { claims } = useStaff();
  return <Navigate to={homeScreen(claims.role)} replace />;
}

export function StaffShell() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const route = useLocation();
  const claims = token ? decodeClaims(token) : null;
  const onStation = route.pathname.includes('/station/');

  useEffect(() => {
    getStaffToken()
      .then(setToken)
      .catch(() => setToken(null));
  }, []);

  useEffect(() => {
    if (claims) setLocationId(chosenLocation(claims));
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  // On a phone the links scroll sideways; keep the current screen's link in view.
  useEffect(() => {
    document.querySelector('.nav-scroll a.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [route.pathname, token]);

  if (token === undefined) return <p className="staff-main quiet">Checking your sign-in…</p>;
  if (!token || !claims) return <SignIn onSignedIn={setToken} />;

  return (
    <div className={onStation ? 'station' : ''}>
      <nav className="staff-bar" aria-label="Staff screens">
        <div className="nav-scroll">
          {NAV.map((group) => {
            const links = group.links.filter((l) => canSee(claims.role, l.screen));
            if (links.length === 0) return null;
            return (
              <div key={group.name} className="nav-group" role="group" aria-label={group.name}>
                {links.map((l) => (
                  <NavLink key={l.to} to={l.to}>{l.label}</NavLink>
                ))}
              </div>
            );
          })}
        </div>
        <span className="spacer" />
        {onStation && <span className="live" data-on={live}>{live ? 'Live' : 'Reconnecting'}</span>}
        {claims.locationIds.length > 1 && (
          <label>
            <span className="visually-hidden">Location</span>
            <select
              value={locationId ?? ''}
              onChange={(e) => {
                chooseLocation(e.target.value);
                setLocationId(e.target.value);
              }}
            >
              {claims.locationIds.map((id, i) => (
                <option key={id} value={id}>Location {i + 1}</option>
              ))}
            </select>
          </label>
        )}
        <button
          className="link"
          style={{ color: 'inherit' }}
          onClick={() => {
            void signOut().then(() => setToken(null));
          }}
        >
          Sign out
        </button>
      </nav>
      {locationId ? (
        <Ctx.Provider value={{ token, claims, locationId, live, setLive }}>
          <Outlet />
        </Ctx.Provider>
      ) : (
        <LocationPrompt onChoose={(id) => { chooseLocation(id); setLocationId(id); }} />
      )}
    </div>
  );
}

function LocationPrompt({ onChoose }: { onChoose: (id: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <main className="signin">
      <h1>Which restaurant?</h1>
      <p>Your account covers every location. Enter the location's ID to open its screens.</p>
      <input className="note-input" value={value} onChange={(e) => setValue(e.target.value.trim())} aria-label="Location ID" />
      <p>
        <button className="btn btn-rim" disabled={!/^[0-9a-f-]{36}$/i.test(value)} onClick={() => onChoose(value)}>Open</button>
      </p>
    </main>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: (token: string) => void }): ReactNode {
  const [devToken, setDevToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (usesAuth0) {
    return (
      <main className="signin">
        <h1>Staff sign-in</h1>
        <p>Sign in to see the floor, kitchen and bar screens.</p>
        <button className="btn btn-rim" onClick={() => void signIn()}>Sign in</button>
      </main>
    );
  }
  return (
    <main className="signin">
      <h1>Staff sign-in</h1>
      <p className="quiet">Development mode: Auth0 isn't configured, so paste a development token.</p>
      <label>
        <span className="visually-hidden">Development token</span>
        <textarea value={devToken} onChange={(e) => setDevToken(e.target.value.trim())} />
      </label>
      {error && <p className="notice notice-error">{error}</p>}
      <button
        className="btn btn-rim"
        onClick={() => {
          signIn(devToken)
            .then(() => onSignedIn(devToken))
            .catch((e: Error) => setError(e.message));
        }}
      >
        Sign in
      </button>
    </main>
  );
}

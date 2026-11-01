import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
// Fonts are bundled (no Google Fonts call): faster on slow connections and no third-party tracking.
import '@fontsource-variable/bricolage-grotesque/opsz.css';
import '@fontsource/atkinson-hyperlegible/latin-400.css';
import '@fontsource/atkinson-hyperlegible/latin-700.css';
import './styles.css';
import { GuestTable } from './guest/GuestTable';
import { TipLanding } from './guest/TipLanding';

// Staff screens load separately, so guests on prepaid data never download them.
const StaffShell = lazy(() => import('./staff/StaffShell').then((m) => ({ default: m.StaffShell })));
const Floor = lazy(() => import('./staff/Floor').then((m) => ({ default: m.Floor })));
const Station = lazy(() => import('./staff/Station').then((m) => ({ default: m.Station })));
const MenuPhotos = lazy(() => import('./staff/MenuPhotos').then((m) => ({ default: m.MenuPhotos })));
const StaffHome = lazy(() => import('./staff/StaffShell').then((m) => ({ default: m.StaffHome })));
const Me = lazy(() => import('./staff/Me').then((m) => ({ default: m.Me })));
const Schedule = lazy(() => import('./staff/Schedule').then((m) => ({ default: m.Schedule })));
const Timesheets = lazy(() => import('./staff/Timesheets').then((m) => ({ default: m.Timesheets })));
const Tips = lazy(() => import('./staff/Tips').then((m) => ({ default: m.Tips })));
const Logbook = lazy(() => import('./staff/Logbook').then((m) => ({ default: m.Logbook })));
const Leave = lazy(() => import('./staff/Leave').then((m) => ({ default: m.Leave })));
const Payroll = lazy(() => import('./staff/Payroll').then((m) => ({ default: m.Payroll })));

function Home() {
  return (
    <main className="landing">
      <h1>Scan the code on your table to order</h1>
      <p>Point your phone's camera at the code on your table. Your menu and bill open here.</p>
      <p className="quiet">
        Working here? <a href="/staff">Open the staff screens</a>
      </p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Suspense fallback={<p className="landing quiet">Loading…</p>}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/t/:tagToken" element={<GuestTable />} />
        <Route path="/tip/:token" element={<TipLanding />} />
        <Route path="/staff" element={<StaffShell />}>
          <Route index element={<StaffHome />} />
          <Route path="me" element={<Me />} />
          <Route path="schedule" element={<Schedule />} />
          <Route path="timesheets" element={<Timesheets />} />
          <Route path="leave" element={<Leave />} />
          <Route path="tips" element={<Tips />} />
          <Route path="logbook" element={<Logbook />} />
          <Route path="payroll" element={<Payroll />} />
          <Route path="floor" element={<Floor />} />
          <Route path="station/:station" element={<Station />} />
          <Route path="menu" element={<MenuPhotos />} />
        </Route>
        <Route path="*" element={<Home />} />
      </Routes>
      </Suspense>
    </BrowserRouter>
  </StrictMode>,
);

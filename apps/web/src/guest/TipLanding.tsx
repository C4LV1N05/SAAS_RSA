import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { lastTable, loadSession, saveTipCode } from '../lib/guestSession';

/** A waiter's personal tip QR code. The tip is applied when the guest pays. */
export function TipLanding() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const table = lastTable();
  const active = table ? loadSession(table) : null;

  useEffect(() => {
    if (token) saveTipCode(token);
    if (active) navigate(`/t/${active.tagToken}?pay=1`, { replace: true });
  }, [token, active, navigate]);

  if (active) return null;
  return (
    <main className="landing">
      <h1>Thanks for tipping</h1>
      <p>Scan the code on your table first. When you pay, your tip goes to this waiter.</p>
    </main>
  );
}

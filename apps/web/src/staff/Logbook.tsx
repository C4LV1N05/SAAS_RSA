import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { stamp } from '../lib/dates';
import { useStaff } from './StaffShell';

type Category = 'handover' | 'maintenance' | 'incident' | 'disciplinary' | 'note';

interface LogEntry {
  id: string;
  entryGroupId: string;
  revision: number;
  category: Category;
  body: string;
  requiresAck: boolean;
  createdAt: string;
  authorName: string | null;
  firstWrittenAt: string;
  firstAuthorName: string | null;
  ackCount: number;
  acknowledgedByMe: boolean;
}

const CATEGORY: Record<Category, string> = {
  handover: 'Handover',
  maintenance: 'Maintenance',
  incident: 'Incident',
  disciplinary: 'Disciplinary',
  note: 'Note',
};

export function Logbook() {
  const { token, locationId } = useStaff();
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [filter, setFilter] = useState<Category | 'all'>('all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [revising, setRevising] = useState<string | null>(null);
  const [proof, setProof] = useState<{ valid: boolean; entries: number; brokenAtSeq?: number } | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries((await api<{ entries: LogEntry[] }>(`/v1/logbook?locationId=${locationId}&limit=100`, { token })).entries);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [token, locationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      setProof(null);
      await load();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work. Try again.');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const shown = entries?.filter((e) => filter === 'all' || e.category === filter) ?? [];
  const unread = entries?.filter((e) => e.requiresAck && !e.acknowledgedByMe).length ?? 0;

  return (
    <main className="staff-main">
      <h1>Log book</h1>
      <p className="quiet summary-line">
        Nothing written here can be changed or deleted. Corrections are added as new versions, and the original stays on record.
      </p>
      {error && <p className="notice notice-error" role="alert">{error}</p>}

      <Compose busy={busy === 'new'} onSubmit={(b) => act('new', () => api('/v1/logbook', { token, body: { ...b, locationId } }))} />

      <div className="filter-row" role="group" aria-label="Show">
        {(['all', ...Object.keys(CATEGORY)] as Array<Category | 'all'>).map((c) => (
          <button key={c} className="chip-toggle" aria-pressed={filter === c} onClick={() => setFilter(c)}>
            {c === 'all' ? `Everything${unread ? ` (${unread} to read)` : ''}` : CATEGORY[c]}
          </button>
        ))}
      </div>

      {entries === null && !error && <p className="quiet">Loading the log book…</p>}
      {entries?.length === 0 && <p>Nothing logged yet. Write the first handover note above.</p>}

      <ol className="log-list">
        {shown.map((e) => (
          <li key={e.id} className="log-entry" data-category={e.category}>
            <div className="log-meta">
              <span className="log-cat">{CATEGORY[e.category]}</span>
              <span className="quiet">
                {e.firstAuthorName ?? 'Someone'}, {stamp(e.firstWrittenAt)}
              </span>
            </div>
            {revising === e.entryGroupId ? (
              <Revise
                initial={e.body}
                busy={busy === e.id}
                onCancel={() => setRevising(null)}
                onSave={(body) =>
                  void act(e.id, () => api(`/v1/logbook/${e.entryGroupId}/revisions`, { token, body: { body } })).then((ok) => ok && setRevising(null))
                }
              />
            ) : (
              <p className="log-body">{e.body}</p>
            )}
            {e.revision > 1 && (
              <p className="quiet small">
                Corrected {e.revision - 1 === 1 ? 'once' : `${e.revision - 1} times`}, last by {e.authorName ?? 'someone'} at {stamp(e.createdAt)}. Earlier versions are kept.
              </p>
            )}
            <div className="row">
              {e.requiresAck &&
                (e.acknowledgedByMe ? (
                  <span className="ack-done">Read by you{e.ackCount > 1 ? ` and ${e.ackCount - 1} more` : ''}</span>
                ) : (
                  <button className="btn btn-small btn-go" disabled={busy === e.id} onClick={() => void act(e.id, () => api(`/v1/logbook/entries/${e.id}/ack`, { token, body: {} }))}>
                    Mark as read
                  </button>
                ))}
              {e.requiresAck && !e.acknowledgedByMe && e.ackCount > 0 && <span className="quiet small">{e.ackCount} read so far</span>}
              {revising !== e.entryGroupId && (
                <button className="link" onClick={() => setRevising(e.entryGroupId)}>Add a correction</button>
              )}
            </div>
          </li>
        ))}
      </ol>

      {entries && entries.length > 0 && (
        <section className="proof" aria-labelledby="proof-h">
          <h2 id="proof-h">Proof nothing was changed</h2>
          <p className="quiet">
            Every entry is sealed with a fingerprint of the one before it. Checking recalculates them all, which shows the record is complete and untouched, for example at a CCMA hearing.
          </p>
          {proof ? (
            proof.valid ? (
              <p className="notice notice-ok" role="status">Intact: all {proof.entries} entries match their seals.</p>
            ) : (
              <p className="notice notice-error" role="alert">Broken at entry {proof.brokenAtSeq}. Contact support: the record may have been tampered with.</p>
            )
          ) : (
            <button
              className="btn btn-small"
              disabled={busy === 'verify'}
              onClick={() => {
                setBusy('verify');
                api<{ valid: boolean; entries: number; brokenAtSeq?: number }>(`/v1/logbook/verify?locationId=${locationId}`, { token })
                  .then(setProof)
                  .catch((err: Error) => setError(err.message))
                  .finally(() => setBusy(null));
              }}
            >
              Check the record
            </button>
          )}
        </section>
      )}
    </main>
  );
}

function Compose(props: { busy: boolean; onSubmit: (b: { category: Category; body: string; requiresAck: boolean }) => Promise<boolean> }) {
  const [category, setCategory] = useState<Category>('handover');
  const [body, setBody] = useState('');
  const [requiresAck, setRequiresAck] = useState(false);
  return (
    <form
      className="compose"
      onSubmit={(e) => {
        e.preventDefault();
        void props.onSubmit({ category, body: body.trim(), requiresAck }).then((ok) => {
          if (ok) {
            setBody('');
            setRequiresAck(false);
          }
        });
      }}
    >
      <label className="visually-hidden" htmlFor="log-body">What happened</label>
      <textarea id="log-body" rows={3} value={body} placeholder="What should the next shift know?" onChange={(e) => setBody(e.target.value)} />
      <div className="row">
        <label>
          <span className="visually-hidden">Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
            {Object.entries(CATEGORY).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </label>
        <label className="switch">
          <input type="checkbox" checked={requiresAck} onChange={(e) => setRequiresAck(e.target.checked)} />
          Managers must mark it as read
        </label>
        <span className="spacer" />
        <button className="btn btn-small btn-rim" type="submit" disabled={props.busy || !body.trim()}>Add to log book</button>
      </div>
    </form>
  );
}

function Revise(props: { initial: string; busy: boolean; onCancel: () => void; onSave: (body: string) => void }) {
  const [body, setBody] = useState(props.initial);
  return (
    <form className="compose" onSubmit={(e) => { e.preventDefault(); props.onSave(body.trim()); }}>
      <label className="visually-hidden" htmlFor="revise-body">Corrected text</label>
      <textarea id="revise-body" rows={3} value={body} onChange={(e) => setBody(e.target.value)} autoFocus />
      <div className="row">
        <button className="btn btn-small btn-rim" type="submit" disabled={props.busy || !body.trim() || body.trim() === props.initial}>Save correction</button>
        <button type="button" className="link" onClick={props.onCancel}>Cancel</button>
      </div>
    </form>
  );
}

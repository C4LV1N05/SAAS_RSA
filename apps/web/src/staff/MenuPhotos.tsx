import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { rand } from '../lib/money';
import { useStaff } from './StaffShell';

interface StaffMenuItem {
  id: string;
  categoryId: string | null;
  name: string;
  priceCents: number;
  available: boolean;
  imageThumbUrl: string | null;
}

interface StaffMenu {
  categories: Array<{ id: string; name: string }>;
  items: StaffMenuItem[];
}

/**
 * Phone photos are often 3-5 MB. Shrink large ones to 1600 px JPEG before
 * uploading so it works on mobile data; the server makes the final sizes.
 */
export async function shrinkForUpload(file: File, maxSide = 1600): Promise<Blob> {
  if (file.size < 1_500_000 || !('createImageBitmap' in window)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return blob ?? file;
  } catch {
    return file; // e.g. a format the browser can't draw; let the server decide
  }
}

export function MenuPhotos() {
  const { token, locationId, claims } = useStaff();
  const canEdit = claims.role === 'owner' || claims.role === 'general_manager';
  const [menu, setMenu] = useState<StaffMenu | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMenu(await api<StaffMenu>(`/v1/menu?locationId=${locationId}`, { token }));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [token, locationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (item: StaffMenuItem, file: File | undefined) => {
    if (!file) return;
    setBusy(item.id);
    setError(null);
    setDone(null);
    try {
      await api(`/v1/menu/items/${item.id}/image`, { token, file: await shrinkForUpload(file) });
      await load();
      setDone(`Photo saved for ${item.name}.`);
    } catch (err) {
      setError(err instanceof ApiError ? `${item.name}: ${err.message}` : 'Upload failed. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const update = async (item: StaffMenuItem, path: string, init: { method: 'PATCH' | 'DELETE'; body?: object }) => {
    setBusy(item.id);
    setError(null);
    try {
      await api(path, { token, method: init.method, ...(init.body ? { body: init.body } : {}) });
      await load();
    } catch (err) {
      setError((err as Error).message);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const sections = menu
    ? [
        ...menu.categories.map((c) => ({ id: c.id, name: c.name, items: menu.items.filter((i) => i.categoryId === c.id) })),
        { id: 'other', name: 'Other', items: menu.items.filter((i) => !i.categoryId) },
      ].filter((s) => s.items.length)
    : [];
  const missing = menu?.items.filter((i) => !i.imageThumbUrl).length ?? 0;

  return (
    <main className="staff-main">
      <h1>Menu</h1>
      {menu && (
        <p className="quiet">
          {missing === 0 ? 'Every dish has a photo.' : `${missing} ${missing === 1 ? 'dish has' : 'dishes have'} no photo yet. Dishes with photos are easier to choose.`}
        </p>
      )}
      {!canEdit && <p className="notice">Only a manager can change photos and availability.</p>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {done && <p className="notice notice-ok" role="status">{done}</p>}
      {menu === null && !error && <p className="quiet">Loading the menu…</p>}

      {sections.map((s) => (
        <section key={s.id} aria-labelledby={`m-${s.id}`}>
          <h2 id={`m-${s.id}`} style={{ fontFamily: 'var(--display)', margin: '1.5rem 0 0' }}>{s.name}</h2>
          {s.items.map((item) => (
            <article key={item.id} className="menu-admin-item">
              <div className="thumb">{item.imageThumbUrl ? <img src={item.imageThumbUrl} alt="" width={88} height={88} loading="lazy" /> : 'No photo'}</div>
              <h3>
                {item.name} <span className="num quiet" style={{ fontWeight: 400 }}>{rand(item.priceCents)}</span>
              </h3>
              {canEdit && (
                <div className="row">
                  <label className="btn btn-small file-button">
                    {busy === item.id ? 'Saving…' : item.imageThumbUrl ? 'Change photo' : 'Add photo'}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/heic"
                      capture="environment"
                      disabled={busy === item.id}
                      aria-label={`${item.imageThumbUrl ? 'Change' : 'Add'} photo for ${item.name}`}
                      onChange={(e) => {
                        void upload(item, e.target.files?.[0]);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  {item.imageThumbUrl && (
                    <button className="link" disabled={busy === item.id} onClick={() => void update(item, `/v1/menu/items/${item.id}/image`, { method: 'DELETE' })}>
                      Remove photo
                    </button>
                  )}
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={item.available}
                      disabled={busy === item.id}
                      onChange={(e) => {
                        const available = e.target.checked;
                        // Flip it now; load() after saving restores the truth if it failed.
                        setMenu((m) => (m ? { ...m, items: m.items.map((i) => (i.id === item.id ? { ...i, available } : i)) } : m));
                        void update(item, `/v1/menu/items/${item.id}`, { method: 'PATCH', body: { available } });
                      }}
                    />
                    On the menu
                  </label>
                </div>
              )}
            </article>
          ))}
        </section>
      ))}
    </main>
  );
}

import { useEffect, useRef, useState } from 'react';
import { rand } from '../lib/money';
import type { MenuCategory, MenuItem } from './types';

export type Cart = Record<string, { quantity: number; notes: string }>;

interface Props {
  menu: { categories: MenuCategory[]; items: MenuItem[] };
  cart: Cart;
  onChange: (cart: Cart) => void;
}

export function Menu({ menu, cart, onChange }: Props) {
  const [open, setOpen] = useState<MenuItem | null>(null);
  const sections = [
    ...menu.categories.map((c) => ({ id: c.id, name: c.name, items: menu.items.filter((i) => i.categoryId === c.id) })),
    { id: 'other', name: 'More', items: menu.items.filter((i) => !i.categoryId || !menu.categories.some((c) => c.id === i.categoryId)) },
  ].filter((s) => s.items.length > 0);

  const set = (id: string, patch: Partial<{ quantity: number; notes: string }>) => {
    const current = cart[id] ?? { quantity: 0, notes: '' };
    const next = { ...current, ...patch };
    next.quantity = Math.max(0, Math.min(20, next.quantity));
    onChange({ ...cart, [id]: next });
  };

  if (sections.length === 0) return <p className="quiet">The menu isn't available right now. Your waiter can take your order.</p>;

  return (
    <>
      {sections.length > 1 && (
        <nav className="categories" aria-label="Menu sections">
          {sections.map((s) => (
            <a key={s.id} href={`#cat-${s.id}`}>{s.name}</a>
          ))}
        </nav>
      )}
      {sections.map((s) => (
        <section key={s.id} id={`cat-${s.id}`} className="menu-section" aria-labelledby={`h-${s.id}`}>
          <h2 id={`h-${s.id}`}>{s.name}</h2>
          {s.items.map((item) => {
            const line = cart[item.id];
            const qty = line?.quantity ?? 0;
            return (
              <article key={item.id} className={`dish${item.soldOut ? ' sold-out' : ''}${item.imageThumbUrl ? ' has-photo' : ''}`}>
                <div className="dish-body">
                  <h3>{item.name}</h3>
                  {item.description && <p>{item.description}</p>}
                  <span className="price num">{rand(item.priceCents)}</span>
                  {item.soldOut && <span className="quiet sold-label">Sold out</span>}
                </div>
                <div className="dish-side">
                  {item.imageThumbUrl && (
                    <button className="photo" onClick={() => setOpen(item)} aria-label={`See a larger photo of ${item.name}`}>
                      <DishImage item={item} size="thumb" />
                    </button>
                  )}
                  {!item.soldOut && qty === 0 && (
                    <button className="btn btn-small add" onClick={() => set(item.id, { quantity: 1 })} aria-label={`Add ${item.name}`}>
                      Add
                    </button>
                  )}
                </div>
                {qty > 0 && !item.soldOut && (
                  <div className="controls">
                    <Stepper item={item} qty={qty} onSet={(q) => set(item.id, { quantity: q })} />
                    <input
                      className="note-input"
                      placeholder={item.station === 'bar' ? 'Note, e.g. no ice' : 'Note, e.g. medium rare'}
                      value={line?.notes ?? ''}
                      maxLength={200}
                      onChange={(e) => set(item.id, { notes: e.target.value })}
                      aria-label={`Note for ${item.name}`}
                    />
                  </div>
                )}
              </article>
            );
          })}
        </section>
      ))}
      <DishDialog item={open} qty={open ? cart[open.id]?.quantity ?? 0 : 0} onSet={(q) => open && set(open.id, { quantity: q })} onClose={() => setOpen(null)} />
    </>
  );
}

function Stepper({ item, qty, onSet }: { item: MenuItem; qty: number; onSet: (q: number) => void }) {
  return (
    <span className="stepper">
      <button onClick={() => onSet(qty - 1)} aria-label={`One less ${item.name}`}>−</button>
      <output aria-live="polite" aria-label={`${qty} ${item.name}`}>{qty}</output>
      <button onClick={() => onSet(qty + 1)} aria-label={`One more ${item.name}`}>+</button>
    </span>
  );
}

/** Thumbnail (320 px) on the list, full (640 px) in the larger view; fixed size so nothing jumps while loading. */
function DishImage({ item, size }: { item: MenuItem; size: 'thumb' | 'full' }) {
  const [failed, setFailed] = useState(false);
  if (failed || !item.imageThumbUrl) return <span className="photo-missing" aria-hidden="true" />;
  return size === 'thumb' ? (
    <img
      src={item.imageThumbUrl}
      srcSet={item.imageUrl ? `${item.imageThumbUrl} 320w, ${item.imageUrl} 640w` : undefined}
      sizes="104px"
      width={104}
      height={104}
      loading="lazy"
      decoding="async"
      alt=""
      onError={() => setFailed(true)}
    />
  ) : (
    <img src={item.imageUrl ?? item.imageThumbUrl} width={640} height={640} decoding="async" alt={item.name} onError={() => setFailed(true)} />
  );
}

function DishDialog({ item, qty, onSet, onClose }: { item: MenuItem | null; qty: number; onSet: (q: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (item && !d.open) d.showModal();
    if (!item && d.open) d.close();
  }, [item]);

  return (
    <dialog
      ref={ref}
      className="dish-dialog"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // tap outside the sheet
      }}
      aria-labelledby="dish-dialog-title"
    >
      {item && (
        <div className="sheet-inner">
          <DishImage item={item} size="full" />
          <div className="dish-dialog-body">
            <h2 id="dish-dialog-title">{item.name}</h2>
            {item.description && <p>{item.description}</p>}
            <p className="price num">{rand(item.priceCents)}</p>
            <div className="dish-dialog-actions">
              {item.soldOut ? (
                <span className="quiet">Sold out</span>
              ) : qty === 0 ? (
                <button className="btn btn-go" onClick={() => onSet(1)}>Add to order</button>
              ) : (
                <Stepper item={item} qty={qty} onSet={onSet} />
              )}
              <button className="btn" onClick={onClose}>{qty > 0 ? 'Done' : 'Close'}</button>
            </div>
          </div>
        </div>
      )}
    </dialog>
  );
}

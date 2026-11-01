import { rand } from '../lib/money';
import type { MenuCategory, MenuItem } from './types';

export type Cart = Record<string, { quantity: number; notes: string }>;

interface Props {
  menu: { categories: MenuCategory[]; items: MenuItem[] };
  cart: Cart;
  onChange: (cart: Cart) => void;
}

export function Menu({ menu, cart, onChange }: Props) {
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
              <article key={item.id} className={`dish${item.soldOut ? ' sold-out' : ''}`}>
                <div>
                  <h3>{item.name}</h3>
                  {item.description && <p>{item.description}</p>}
                </div>
                <div className="price">
                  <span className="num">{rand(item.priceCents)}</span>
                  {item.soldOut ? (
                    <span className="quiet">Sold out</span>
                  ) : (
                    qty === 0 && (
                      <button className="btn btn-small" onClick={() => set(item.id, { quantity: 1 })} aria-label={`Add ${item.name}`}>
                        Add
                      </button>
                    )
                  )}
                </div>
                {qty > 0 && !item.soldOut && (
                  <div className="controls">
                    <span className="stepper">
                      <button onClick={() => set(item.id, { quantity: qty - 1 })} aria-label={`One less ${item.name}`}>−</button>
                      <output aria-live="polite" aria-label={`${qty} ${item.name}`}>{qty}</output>
                      <button onClick={() => set(item.id, { quantity: qty + 1 })} aria-label={`One more ${item.name}`}>+</button>
                    </span>
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
    </>
  );
}

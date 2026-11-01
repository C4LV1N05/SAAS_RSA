/**
 * Stock requirements for an order. Quantities are handled in thousandths
 * (integer milli-units) to match numeric(12,3) in the database and avoid float drift:
 * 1 steak = 1000, 200 g of mince (unit kg) = 200.
 */
export interface Component {
  menuItemId: string;
  inventoryItemId: string;
  /** Decimal string or number as stored, e.g. "0.200". */
  quantity: string | number;
}

export interface OrderLine {
  orderItemId: string;
  menuItemId: string;
  quantity: number;
}

export interface StockLine {
  inventoryItemId: string;
  orderItemId: string;
  /** Milli-units to deduct. */
  milli: number;
}

export function toMilli(quantity: string | number): number {
  const n = typeof quantity === 'number' ? quantity : Number(quantity);
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`Invalid stock quantity: ${quantity}`);
  return Math.round(n * 1000);
}

export function fromMilli(milli: number): string {
  return (milli / 1000).toFixed(3);
}

/** One stock line per (order item, inventory item): what this order consumes. */
export function stockLinesFor(lines: readonly OrderLine[], components: readonly Component[]): StockLine[] {
  const out: StockLine[] = [];
  for (const line of lines) {
    for (const c of components.filter((x) => x.menuItemId === line.menuItemId)) {
      out.push({ inventoryItemId: c.inventoryItemId, orderItemId: line.orderItemId, milli: toMilli(c.quantity) * line.quantity });
    }
  }
  return out;
}

/** Total demand per inventory item, in milli-units. */
export function totalDemand(lines: readonly StockLine[]): Map<string, number> {
  const demand = new Map<string, number>();
  for (const l of lines) demand.set(l.inventoryItemId, (demand.get(l.inventoryItemId) ?? 0) + l.milli);
  return demand;
}

/**
 * A menu item can be sold while every component has enough on hand for one
 * portion. Items without components (most drinks) are always available here.
 */
export function availablePortions(
  menuItemId: string,
  components: readonly Component[],
  onHandMilli: ReadonlyMap<string, number>,
): number {
  const mine = components.filter((c) => c.menuItemId === menuItemId);
  if (mine.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...mine.map((c) => Math.floor((onHandMilli.get(c.inventoryItemId) ?? 0) / Math.max(1, toMilli(c.quantity)))));
}

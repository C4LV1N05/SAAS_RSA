/**
 * Bills and split payments for a table tab.
 *
 * Prices include VAT. A tab can be settled three ways, mixed across guests:
 *   - "items":     a guest pays for specific items (usually what they ordered)
 *   - "remaining": one person pays everything nobody has claimed yet
 *   - "share":     a guest pays 1/n of the bill as an amount
 * Once any "share" payment exists, the remaining money is no longer tied to
 * items, so "items" mode is closed for that tab and "remaining" pays the amount left.
 *
 * Requested payments (waiting at the till) already claim their items/amount, so
 * two guests can never pay for the same thing.
 */
import { assertCents, roundHalfUp, sumCents, type Cents } from '../money';

export interface BillItem {
  id: string;
  name: string;
  guestSessionId: string | null;
  unitPriceCents: Cents;
  quantity: number;
  status: string; // 'void' items are excluded
}

export type PaymentMode = 'items' | 'remaining' | 'share';
export type PaymentStatus = 'requested' | 'succeeded' | 'cancelled';

export interface BillPayment {
  id: string;
  mode: PaymentMode;
  status: PaymentStatus;
  amountCents: Cents;
  allocations: Array<{ itemId: string; amountCents: Cents }>;
}

export interface BillLine extends BillItem {
  lineTotalCents: Cents;
  claimed: boolean; // covered by a requested or succeeded payment
  paid: boolean; // covered by a succeeded payment
}

export interface Bill {
  lines: BillLine[];
  totalCents: Cents;
  /** VAT included in the total (tax fraction 15/115 at 15%). */
  vatCents: Cents;
  paidCents: Cents;
  claimedCents: Cents;
  outstandingCents: Cents; // total - paid
  unclaimedCents: Cents; // total - claimed (what a new payment can still cover)
  itemModeOpen: boolean;
  perGuest: Record<string, Cents>;
  settled: boolean;
}

/** VAT contained in a VAT-inclusive amount. */
export function vatIncluded(amountCents: Cents, vatRateBp: number): Cents {
  return roundHalfUp((amountCents * vatRateBp) / (10_000 + vatRateBp));
}

export function computeBill(items: readonly BillItem[], payments: readonly BillPayment[], vatRateBp: number): Bill {
  const live = items.filter((i) => i.status !== 'void');
  const active = payments.filter((p) => p.status !== 'cancelled');
  const claimedItems = new Set(active.flatMap((p) => p.allocations.map((a) => a.itemId)));
  const paidItems = new Set(active.filter((p) => p.status === 'succeeded').flatMap((p) => p.allocations.map((a) => a.itemId)));

  const lines: BillLine[] = live.map((i) => ({
    ...i,
    lineTotalCents: assertCents(i.unitPriceCents * i.quantity, 'line total'),
    claimed: claimedItems.has(i.id),
    paid: paidItems.has(i.id),
  }));
  const totalCents = sumCents(lines.map((l) => l.lineTotalCents));
  const paidCents = sumCents(active.filter((p) => p.status === 'succeeded').map((p) => p.amountCents));
  const claimedCents = sumCents(active.map((p) => p.amountCents));

  const perGuest: Record<string, Cents> = {};
  for (const l of lines) {
    const key = l.guestSessionId ?? 'table';
    perGuest[key] = (perGuest[key] ?? 0) + l.lineTotalCents;
  }

  return {
    lines,
    totalCents,
    vatCents: vatIncluded(totalCents, vatRateBp),
    paidCents,
    claimedCents,
    outstandingCents: Math.max(0, totalCents - paidCents),
    unclaimedCents: Math.max(0, totalCents - claimedCents),
    itemModeOpen: !active.some((p) => p.mode === 'share'),
    perGuest,
    settled: totalCents > 0 && paidCents >= totalCents,
  };
}

export type PaymentRequest =
  | { mode: 'items'; itemIds: string[] }
  | { mode: 'remaining' }
  | { mode: 'share'; parts: number };

export interface PaymentPlan {
  mode: PaymentMode;
  amountCents: Cents;
  allocations: Array<{ itemId: string; amountCents: Cents }>;
}

export class PaymentPlanError extends Error {
  constructor(
    readonly code: 'nothing_to_pay' | 'items_closed' | 'item_unavailable' | 'invalid_parts',
    message: string,
  ) {
    super(message);
    this.name = 'PaymentPlanError';
  }
}

export function planPayment(bill: Bill, request: PaymentRequest): PaymentPlan {
  if (bill.unclaimedCents <= 0) throw new PaymentPlanError('nothing_to_pay', 'Everything on this tab is already paid or being paid');

  switch (request.mode) {
    case 'items': {
      if (!bill.itemModeOpen) {
        throw new PaymentPlanError('items_closed', 'Someone paid a share of the bill, so pay a share or the remaining amount instead');
      }
      const ids = [...new Set(request.itemIds)];
      if (ids.length === 0) throw new PaymentPlanError('nothing_to_pay', 'Choose at least one item');
      const chosen = ids.map((id) => bill.lines.find((l) => l.id === id));
      const bad = chosen.findIndex((l) => !l || l.claimed);
      if (bad >= 0) throw new PaymentPlanError('item_unavailable', `Item ${ids[bad]} is not on this tab or is already paid`);
      const allocations = chosen.map((l) => ({ itemId: l!.id, amountCents: l!.lineTotalCents })).filter((a) => a.amountCents > 0);
      const amountCents = sumCents(allocations.map((a) => a.amountCents));
      if (amountCents <= 0) throw new PaymentPlanError('nothing_to_pay', 'Those items cost nothing');
      return { mode: 'items', amountCents, allocations };
    }

    case 'remaining': {
      // In item mode, cover every unclaimed item so item ownership stays exact.
      const allocations = bill.itemModeOpen
        ? bill.lines.filter((l) => !l.claimed && l.lineTotalCents > 0).map((l) => ({ itemId: l.id, amountCents: l.lineTotalCents }))
        : [];
      return { mode: 'remaining', amountCents: bill.unclaimedCents, allocations };
    }

    case 'share': {
      if (!Number.isInteger(request.parts) || request.parts < 2 || request.parts > 20) {
        throw new PaymentPlanError('invalid_parts', 'Split between 2 and 20 people');
      }
      if (bill.itemModeOpen && bill.claimedCents > 0) {
        throw new PaymentPlanError('items_closed', 'Some items are already paid individually; pay for items or the remaining amount');
      }
      // Equal shares of the whole bill; the last payer covers any rounding cent.
      const share = Math.ceil(bill.totalCents / request.parts);
      return { mode: 'share', amountCents: Math.min(share, bill.unclaimedCents), allocations: [] };
    }
  }
}

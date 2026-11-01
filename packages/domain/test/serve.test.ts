import { describe, expect, it } from 'vitest';
import {
  availablePortions,
  computeBill,
  planPayment,
  PaymentPlanError,
  resolveTipRecipient,
  RuleSet,
  SA_RULE_VERSIONS,
  stockLinesFor,
  totalDemand,
  vatIncluded,
  type BillItem,
  type BillPayment,
} from '../src';

const VAT = new RuleSet(SA_RULE_VERSIONS).get('vat.rate_bp', '2026-11-01');

// Table 4: Thandi (g1) and Sipho (g2).
const items: BillItem[] = [
  { id: 'steak', name: 'Rump 300g', guestSessionId: 'g1', unitPriceCents: 21_500, quantity: 1, status: 'served' },
  { id: 'wine', name: 'Glass of Chenin', guestSessionId: 'g1', unitPriceCents: 6_500, quantity: 2, status: 'served' },
  { id: 'burger', name: 'Beef burger', guestSessionId: 'g2', unitPriceCents: 14_000, quantity: 1, status: 'served' },
  { id: 'coke', name: 'Coke', guestSessionId: 'g2', unitPriceCents: 3_200, quantity: 1, status: 'void' },
];
const pay = (p: Partial<BillPayment> & Pick<BillPayment, 'id' | 'mode' | 'amountCents'>): BillPayment => ({
  status: 'succeeded',
  allocations: [],
  ...p,
});

describe('VAT', () => {
  it('is 15% and included in menu prices', () => {
    expect(VAT).toBe(1500);
    expect(vatIncluded(11_500, VAT)).toBe(1_500); // R115 includes R15 VAT
    expect(vatIncluded(48_500, VAT)).toBe(6_326);
  });
});

describe('bill', () => {
  it('totals live items, excludes voids and shows per-guest subtotals', () => {
    const bill = computeBill(items, [], VAT);
    expect(bill.totalCents).toBe(48_500);
    expect(bill.vatCents).toBe(6_326);
    expect(bill.perGuest).toEqual({ g1: 34_500, g2: 14_000 });
    expect(bill).toMatchObject({ paidCents: 0, outstandingCents: 48_500, unclaimedCents: 48_500, itemModeOpen: true, settled: false });
  });

  it('lets a guest pay for their own items, then someone pays the rest', () => {
    const first = planPayment(computeBill(items, [], VAT), { mode: 'items', itemIds: ['steak', 'wine'] });
    expect(first).toEqual({
      mode: 'items',
      amountCents: 34_500,
      allocations: [
        { itemId: 'steak', amountCents: 21_500 },
        { itemId: 'wine', amountCents: 13_000 },
      ],
    });
    const afterFirst = computeBill(items, [pay({ id: 'p1', status: 'requested', ...first })], VAT);
    // Requested at the till: claimed, not yet paid.
    expect(afterFirst).toMatchObject({ claimedCents: 34_500, paidCents: 0, unclaimedCents: 14_000 });
    expect(() => planPayment(afterFirst, { mode: 'items', itemIds: ['steak'] })).toThrow(PaymentPlanError);

    const rest = planPayment(afterFirst, { mode: 'remaining' });
    expect(rest).toEqual({ mode: 'remaining', amountCents: 14_000, allocations: [{ itemId: 'burger', amountCents: 14_000 }] });

    const settled = computeBill(items, [pay({ id: 'p1', ...first }), pay({ id: 'p2', ...rest })], VAT);
    expect(settled).toMatchObject({ settled: true, outstandingCents: 0 });
    expect(settled.lines.every((l) => l.paid)).toBe(true);
  });

  it('lets one person pay the whole bill', () => {
    expect(planPayment(computeBill(items, [], VAT), { mode: 'remaining' }).amountCents).toBe(48_500);
  });

  it('splits into equal shares, with the last payer covering the rounding', () => {
    let payments: BillPayment[] = [];
    const amounts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const plan = planPayment(computeBill(items, payments, VAT), { mode: 'share', parts: 3 });
      amounts.push(plan.amountCents);
      payments = [...payments, pay({ id: `s${i}`, ...plan })];
    }
    expect(amounts).toEqual([16_167, 16_167, 16_166]);
    expect(computeBill(items, payments, VAT).settled).toBe(true);
  });

  it('closes item mode once a share has been paid', () => {
    const bill = computeBill(items, [pay({ id: 's1', mode: 'share', amountCents: 16_167 })], VAT);
    expect(bill.itemModeOpen).toBe(false);
    expect(() => planPayment(bill, { mode: 'items', itemIds: ['burger'] })).toThrow(/share/);
    expect(planPayment(bill, { mode: 'remaining' })).toEqual({ mode: 'remaining', amountCents: 32_333, allocations: [] });
  });

  it('frees items again when a till request is cancelled', () => {
    const cancelled = pay({ id: 'p1', mode: 'items', amountCents: 21_500, status: 'cancelled', allocations: [{ itemId: 'steak', amountCents: 21_500 }] });
    expect(planPayment(computeBill(items, [cancelled], VAT), { mode: 'items', itemIds: ['steak'] }).amountCents).toBe(21_500);
  });

  it('rejects void or unknown items and nothing-to-pay', () => {
    const bill = computeBill(items, [], VAT);
    expect(() => planPayment(bill, { mode: 'items', itemIds: ['coke'] })).toThrow(/not on this tab/);
    const paid = computeBill(items, [pay({ id: 'all', mode: 'remaining', amountCents: 48_500 })], VAT);
    expect(() => planPayment(paid, { mode: 'remaining' })).toThrow(/already paid/);
  });
});

describe('stock', () => {
  const components = [
    { menuItemId: 'rump', inventoryItemId: 'steaks', quantity: '1.000' },
    { menuItemId: 'burger', inventoryItemId: 'mince', quantity: '0.200' },
    { menuItemId: 'burger', inventoryItemId: 'buns', quantity: 1 },
  ];

  it('works out what an order consumes, in thousandths', () => {
    const lines = stockLinesFor(
      [
        { orderItemId: 'o1', menuItemId: 'rump', quantity: 2 },
        { orderItemId: 'o2', menuItemId: 'burger', quantity: 3 },
        { orderItemId: 'o3', menuItemId: 'coke', quantity: 1 },
      ],
      components,
    );
    expect(lines).toEqual([
      { inventoryItemId: 'steaks', orderItemId: 'o1', milli: 2000 },
      { inventoryItemId: 'mince', orderItemId: 'o2', milli: 600 },
      { inventoryItemId: 'buns', orderItemId: 'o2', milli: 3000 },
    ]);
    expect(totalDemand(lines).get('mince')).toBe(600);
  });

  it('marks an item sold out when a component runs low', () => {
    const onHand = new Map([['steaks', 3000], ['mince', 500], ['buns', 1000]]);
    expect(availablePortions('rump', components, onHand)).toBe(3);
    expect(availablePortions('burger', components, onHand)).toBe(1); // buns limit it
    expect(availablePortions('coke', components, onHand)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('tip attribution', () => {
  const at = new Date('2026-11-06T19:30:00+02:00');
  const assignments = [
    { employeeId: 'lunch-waiter', tableId: 't4', startsAt: new Date('2026-11-06T11:00:00+02:00'), endsAt: new Date('2026-11-06T17:00:00+02:00') },
    { employeeId: 'dinner-waiter', tableId: 't4', startsAt: new Date('2026-11-06T17:00:00+02:00'), endsAt: new Date('2026-11-06T23:00:00+02:00') },
  ];

  it('prefers the waiter whose QR code was scanned', () => {
    expect(resolveTipRecipient({ tipCodeEmployeeId: 'qr-waiter', tableId: 't4', at, assignments })).toEqual({ source: 'tip_code', employeeId: 'qr-waiter' });
  });

  it('otherwise uses the waiter assigned to the table at that time', () => {
    expect(resolveTipRecipient({ tableId: 't4', at, assignments })).toEqual({ source: 'table_assignment', employeeId: 'dinner-waiter' });
  });

  it('falls back to the tip pool', () => {
    expect(resolveTipRecipient({ tableId: 't9', at, assignments })).toEqual({ source: 'pool', employeeId: null });
  });
});

import { describe, expect, it } from 'vitest';
import { parseRand, rand, tipOptions } from '../src/lib/money';
import { parseSse } from '../src/lib/sse';
import { payChoices } from '../src/guest/pay';
import { ageOf, toTickets } from '../src/staff/Station';
import { sortForAction } from '../src/staff/Floor';
import type { Bill } from '../src/guest/types';

describe('money', () => {
  it('formats rand the South African way', () => {
    expect(rand(48_500)).toBe('R 485.00');
    expect(rand(123_456_78)).toBe('R 123 456.78');
  });
  it('offers tips rounded to whole rand', () => {
    expect(tipOptions(34_500).map((t) => t.cents)).toEqual([0, 3_500, 4_300, 5_200]);
  });
  it('parses typed amounts', () => {
    expect(parseRand('50')).toBe(5_000);
    expect(parseRand('R 45,50')).toBe(4_550);
    expect(parseRand('abc')).toBeNull();
  });
});

describe('live stream parsing', () => {
  it('splits complete events, skips heartbeats and keeps the remainder', () => {
    const { events, rest } = parseSse('event: ready\ndata: {"a":1}\n\n: ping\n\nevent: item\ndata: {"itemId":"x"}\n\nevent: it');
    expect(events).toEqual([
      { event: 'ready', data: '{"a":1}' },
      { event: 'item', data: '{"itemId":"x"}' },
    ]);
    expect(rest).toBe('event: it');
  });
});

describe('pay choices', () => {
  const bill: Bill = {
    lines: [
      { id: 'a', name: 'Rump', unitPriceCents: 21_500, quantity: 1, status: 'served', lineTotalCents: 21_500, claimed: false, paid: false, mine: true },
      { id: 'b', name: 'Burger', unitPriceCents: 14_000, quantity: 1, status: 'served', lineTotalCents: 14_000, claimed: false, paid: false, mine: false },
      { id: 'c', name: 'Coke', unitPriceCents: 3_200, quantity: 1, status: 'void', lineTotalCents: 3_200, claimed: false, paid: false, mine: true },
    ],
    totalCents: 35_500, vatCents: 4_630, paidCents: 0, claimedCents: 0, outstandingCents: 35_500, unclaimedCents: 35_500,
    itemModeOpen: true, settled: false, mySubtotalCents: 21_500,
  };
  it('prices each option like the API does', () => {
    const c = payChoices(bill, 3);
    expect(c.items).toMatchObject({ amountCents: 21_500, itemIds: ['a'], available: true });
    expect(c.remaining.amountCents).toBe(35_500);
    expect(c.share.amountCents).toBe(11_834);
  });
  it('blocks equal shares once someone paid for their own items', () => {
    const c = payChoices({ ...bill, claimedCents: 14_000, unclaimedCents: 21_500 }, 2);
    expect(c.share.available).toBe(false);
  });
});

describe('station dockets', () => {
  const item = (id: string, orderId: string, mins: number) => ({ id, orderId, table: 'T4', name: 'Rump', quantity: 1, notes: null, status: 'queued' as const, waitingMinutes: mins });
  it('groups items into one ticket per order, oldest first', () => {
    const t = toTickets([item('1', 'o1', 3), item('2', 'o2', 12), item('3', 'o1', 4)]);
    expect(t.map((x) => [x.orderId, x.minutes, x.items.length])).toEqual([['o2', 12, 1], ['o1', 4, 2]]);
  });
  it('colours tickets by age', () => {
    expect([ageOf(5), ageOf(10), ageOf(25)]).toEqual(['fresh', 'late', 'overdue']);
  });
});

describe('floor ordering', () => {
  it('puts payment requests first, then tables to confirm', () => {
    const tab = (table: string, status: 'pending' | 'open', requests = 0) => ({
      id: table, table, status, totalCents: 0, outstandingCents: 0, awaitingConfirmation: 0,
      paymentRequests: Array.from({ length: requests }, (_, i) => ({ id: `${table}${i}`, mode: 'remaining', amountCents: 1, tipCents: 0, totalCents: 1 })),
    });
    expect(sortForAction([tab('T10', 'open'), tab('T2', 'pending'), tab('T7', 'open', 1), tab('T3', 'open')]).map((t) => t.table)).toEqual(['T7', 'T2', 'T3', 'T10']);
  });
});

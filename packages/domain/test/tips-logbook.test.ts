import { describe, expect, it } from 'vitest';
import { canonicalJson, computeLogHash, distributeTips, GENESIS_HASH, verifyChain, type ChainedEntry, type LogHashInput } from '../src';

describe('tip distribution', () => {
  const staff = [
    { employeeId: 'w1', minutesWorked: 480, group: 'foh' as const, points: 1 },
    { employeeId: 'w2', minutesWorked: 240, group: 'foh' as const, points: 1 },
    { employeeId: 'c1', minutesWorked: 480, group: 'boh' as const, points: 0.5 },
  ];
  const total = (shares: { amountCents: number }[]) => shares.reduce((s, x) => s + x.amountCents, 0);

  it('splits FOH/BOH 70/30, then by hours within each group', () => {
    const shares = distributeTips({ poolCents: 100_000, strategy: 'group_split_hours', participants: staff, config: { groups: { foh: 0.7, boh: 0.3 } } });
    expect(Object.fromEntries(shares.map((s) => [s.employeeId, s.amountCents]))).toEqual({ c1: 30_000, w1: 46_667, w2: 23_333 });
    expect(total(shares)).toBe(100_000);
  });

  it('gives an empty group\'s share to the groups that worked', () => {
    const shares = distributeTips({ poolCents: 10_001, strategy: 'group_split_hours', participants: staff.filter((s) => s.group === 'foh') });
    expect(total(shares)).toBe(10_001);
  });

  it('weights by points x hours', () => {
    const shares = distributeTips({ poolCents: 1_000, strategy: 'points', participants: staff });
    expect(Object.fromEntries(shares.map((s) => [s.employeeId, s.amountCents]))).toEqual({ c1: 250, w1: 500, w2: 250 });
  });

  it('is deterministic regardless of input order', () => {
    const a = distributeTips({ poolCents: 777, strategy: 'hours_weighted', participants: staff });
    const b = distributeTips({ poolCents: 777, strategy: 'hours_weighted', participants: [...staff].reverse() });
    expect(a).toEqual(b);
    expect(total(a)).toBe(777);
  });
});

describe('log book hash chain', () => {
  const entry = (seq: number, body: string): LogHashInput => ({
    orgId: 'org',
    locationId: 'loc',
    entryGroupId: `g${seq}`,
    revision: 1,
    seq,
    authorUserId: 'u1',
    category: 'handover',
    body,
    attachments: [],
    shiftId: null,
    employeeId: null,
    createdAt: `2026-11-0${seq}T08:00:00.000Z`,
  });

  const chain = (bodies: string[]): ChainedEntry[] => {
    let prev = GENESIS_HASH;
    return bodies.map((b, i) => {
      const input = entry(i + 1, b);
      const hash = computeLogHash(prev, input);
      const out = { ...input, prevHash: prev, hash };
      prev = hash;
      return out;
    });
  };

  it('hashes objects independently of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3] } })).toBe(canonicalJson({ a: { c: [3], d: 2 }, b: 1 }));
  });

  it('verifies an intact chain', () => {
    expect(verifyChain(chain(['Fridge 2 not cooling', 'Keg delivery short', 'All good']))).toEqual({ valid: true, entries: 3 });
  });

  it('detects an edited entry', () => {
    const c = chain(['one', 'two', 'three']);
    c[1] = { ...c[1]!, body: 'two (edited)' };
    expect(verifyChain(c)).toMatchObject({ valid: false, brokenAtSeq: 2 });
  });

  it('detects a deleted entry', () => {
    const c = chain(['one', 'two', 'three']);
    expect(verifyChain([c[0]!, c[2]!])).toMatchObject({ valid: false, brokenAtSeq: 3 });
  });
});

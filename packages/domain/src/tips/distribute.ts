/**
 * Tip pool distribution. Every strategy allocates whole cents with the
 * largest-remainder method, so the shares always add up to the pool exactly.
 */
import { allocateByWeights, assertCents, type Cents } from '../money';

export type TipStrategy = 'group_split_hours' | 'hours_weighted' | 'points' | 'individual';
export type TipGroup = 'foh' | 'boh' | 'none';

export interface TipParticipant {
  employeeId: string;
  minutesWorked: number;
  group: TipGroup;
  /** Role points for the "points" strategy (e.g. waiter 1.0, runner 0.6). */
  points?: number;
  /** Declared individual tips for the "individual" strategy. */
  declaredCents?: Cents;
}

export interface TipPoolConfig {
  /** For group_split_hours, e.g. { foh: 0.7, boh: 0.3 }. */
  groups?: Partial<Record<TipGroup, number>>;
}

export interface TipShare {
  employeeId: string;
  amountCents: Cents;
  basis: { strategy: TipStrategy; minutes: number; weight: number; group: TipGroup };
}

export function distributeTips(input: {
  poolCents: Cents;
  strategy: TipStrategy;
  participants: readonly TipParticipant[];
  config?: TipPoolConfig;
}): TipShare[] {
  assertCents(input.poolCents, 'poolCents');
  // Stable order: results never depend on the order rows came out of the database.
  const people = [...input.participants]
    .filter((p) => p.group !== 'none' || input.strategy === 'individual')
    .sort((a, b) => a.employeeId.localeCompare(b.employeeId));

  const share = (p: TipParticipant, amountCents: Cents, weight: number): TipShare => ({
    employeeId: p.employeeId,
    amountCents,
    basis: { strategy: input.strategy, minutes: p.minutesWorked, weight, group: p.group },
  });

  switch (input.strategy) {
    case 'individual':
      return people.map((p) => share(p, assertCents(p.declaredCents ?? 0, 'declaredCents'), 1));

    case 'hours_weighted': {
      const weights = people.map((p) => p.minutesWorked);
      return allocateByWeights(input.poolCents, weights).map((c, i) => share(people[i]!, c, weights[i]!));
    }

    case 'points': {
      const weights = people.map((p) => (p.points ?? 1) * p.minutesWorked);
      return allocateByWeights(input.poolCents, weights).map((c, i) => share(people[i]!, c, weights[i]!));
    }

    case 'group_split_hours': {
      const config = input.config?.groups ?? { foh: 0.7, boh: 0.3 };
      // Only groups with someone who worked share the pool; empty groups' shares
      // are redistributed proportionally rather than left unpaid.
      const groups = (Object.keys(config) as TipGroup[]).filter((g) =>
        people.some((p) => p.group === g && p.minutesWorked > 0),
      );
      const groupAmounts = allocateByWeights(
        input.poolCents,
        groups.map((g) => config[g] ?? 0),
      );
      const out: TipShare[] = [];
      groups.forEach((g, gi) => {
        const members = people.filter((p) => p.group === g);
        const weights = members.map((p) => p.minutesWorked);
        allocateByWeights(groupAmounts[gi]!, weights).forEach((c, i) => out.push(share(members[i]!, c, weights[i]!)));
      });
      return out.sort((a, b) => a.employeeId.localeCompare(b.employeeId));
    }
  }
}

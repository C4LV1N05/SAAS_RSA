import type { RuleKey, RuleValueMap, RuleVersion } from './types';

export class RuleNotFoundError extends Error {
  constructor(key: string, onDate: string) {
    super(`No rule version for "${key}" effective on ${onDate}`);
    this.name = 'RuleNotFoundError';
  }
}

/**
 * Resolves the rule value in force on a date. An organisation override beats the
 * national rule for the same date. Every lookup is recorded so a payslip can
 * store exactly which rule versions produced it.
 */
export class RuleSet {
  private readonly versions: RuleVersion[];
  private readonly used = new Map<string, RuleVersion>();

  constructor(versions: readonly RuleVersion[], private readonly orgId: string | null = null) {
    this.versions = [...versions];
  }

  version<K extends RuleKey>(key: K, onDate: string): RuleVersion<K> {
    const candidates = this.versions.filter(
      (v) =>
        v.key === key &&
        v.effectiveFrom <= onDate &&
        (v.effectiveTo == null || onDate < v.effectiveTo) &&
        (v.orgId == null || v.orgId === this.orgId),
    );
    if (candidates.length === 0) throw new RuleNotFoundError(key, onDate);
    candidates.sort((a, b) => {
      const aOrg = a.orgId ? 1 : 0;
      const bOrg = b.orgId ? 1 : 0;
      if (aOrg !== bOrg) return bOrg - aOrg; // org override first
      return b.effectiveFrom.localeCompare(a.effectiveFrom); // newest first
    });
    const chosen = candidates[0] as RuleVersion<K>;
    this.used.set(`${key}@${chosen.effectiveFrom}${chosen.orgId ? `#${chosen.orgId}` : ''}`, chosen);
    return chosen;
  }

  get<K extends RuleKey>(key: K, onDate: string): RuleValueMap[K] {
    return this.version(key, onDate).value;
  }

  /** Keys like "nmw.hourly_cents@2026-03-01" for every rule read so far. */
  usedKeys(): string[] {
    return [...this.used.keys()].sort();
  }

  resetUsage(): void {
    this.used.clear();
  }
}

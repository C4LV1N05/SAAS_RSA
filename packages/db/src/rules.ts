import { RuleSet, type RuleVersion } from '@saas-rsa/domain';
import { ruleVersions, publicHolidays } from './schema';
import type { Tx } from './tenant';

const dateStr = (d: string | Date | null) => (d == null ? null : typeof d === 'string' ? d : d.toISOString().slice(0, 10));

/** Load every rule version visible to the tenant (national + its own overrides). */
export async function loadRuleSet(tx: Tx, orgId: string): Promise<RuleSet> {
  const rows = await tx.select().from(ruleVersions);
  const versions = rows.map(
    (r) =>
      ({
        key: r.key,
        value: r.value,
        effectiveFrom: dateStr(r.effectiveFrom)!,
        effectiveTo: dateStr(r.effectiveTo),
        source: r.source,
        orgId: r.orgId,
      }) as RuleVersion,
  );
  return new RuleSet(versions, orgId);
}

export async function loadPublicHolidays(tx: Tx): Promise<Set<string>> {
  const rows = await tx.select({ d: publicHolidays.holidayDate }).from(publicHolidays);
  return new Set(rows.map((r) => dateStr(r.d)!));
}

import { describe, expect, it } from 'vitest';
import { allocateByWeights, formatRand, RuleNotFoundError, RuleSet, SA_RULE_VERSIONS, ageOn, taxYearEnd } from '../src';

describe('money', () => {
  it('allocates whole cents that always sum to the total', () => {
    expect(allocateByWeights(100, [1, 1, 1])).toEqual([34, 33, 33]);
    const parts = allocateByWeights(123_457, [3.3, 1.7, 0.4, 9]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(123_457);
  });

  it('returns zeros when all weights are zero', () => {
    expect(allocateByWeights(500, [0, 0])).toEqual([0, 0]);
  });

  it('formats rand amounts', () => {
    expect(formatRand(123_456)).toBe('R 1 234.56');
    expect(formatRand(-5)).toBe('-R 0.05');
  });
});

describe('time', () => {
  it('computes age and tax year end', () => {
    expect(ageOn('2000-11-02', '2026-11-01')).toBe(25);
    expect(ageOn('2000-11-01', '2026-11-01')).toBe(26);
    expect(taxYearEnd('2026-11-01')).toBe('2027-02-28');
    expect(taxYearEnd('2027-02-10')).toBe('2027-02-28');
    expect(taxYearEnd('2027-06-01')).toBe('2028-02-29');
  });
});

describe('rule versions', () => {
  const rules = new RuleSet(SA_RULE_VERSIONS);

  it('switches the National Minimum Wage on 1 March 2026', () => {
    expect(rules.get('nmw.hourly_cents', '2026-02-28')).toBe(2879);
    expect(rules.get('nmw.hourly_cents', '2026-03-01')).toBe(3023);
  });

  it('picks the right tax year', () => {
    expect(rules.get('paye.tax_table', '2026-02-28').taxYear).toBe('2026');
    expect(rules.get('paye.tax_table', '2026-11-01').taxYear).toBe('2027');
  });

  it('lets an organisation override beat the national rule', () => {
    const withOverride = new RuleSet(
      [...SA_RULE_VERSIONS, { key: 'nmw.hourly_cents', value: 3500, effectiveFrom: '2026-07-01', source: 'Bargaining council', orgId: 'org-1' }],
      'org-1',
    );
    expect(withOverride.get('nmw.hourly_cents', '2026-08-01')).toBe(3500);
    expect(new RuleSet(SA_RULE_VERSIONS, 'org-2').get('nmw.hourly_cents', '2026-08-01')).toBe(3023);
  });

  it('records which versions were used', () => {
    const r = new RuleSet(SA_RULE_VERSIONS);
    r.get('nmw.hourly_cents', '2026-11-01');
    expect(r.usedKeys()).toEqual(['nmw.hourly_cents@2026-03-01']);
  });

  it('fails loudly when no rule is in force', () => {
    expect(() => rules.get('paye.tax_table', '2028-01-01')).toThrow(RuleNotFoundError);
  });
});

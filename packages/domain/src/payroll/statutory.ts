/**
 * Statutory payroll calculations: PAYE, UIF, SDL and ETI.
 *
 * PAYE uses the SARS "annualise the period" method: annual equivalent of this
 * period's taxable remuneration, tax from the table, less age rebates, divided back
 * to the period, less medical scheme fees tax credits. This matches SARS tax
 * deduction tables for regular earnings. Irregular income (bonuses, leave payouts)
 * needs the year-to-date method and is NOT handled yet: see docs/ARCHITECTURE.md.
 * Validate against SARS examples and a registered tax practitioner before go-live.
 */
import { applyBasisPoints, roundHalfUp, type Cents } from '../money';
import type { EtiTable, MedicalCredits, TaxTable } from '../rules/types';

export type PayFrequency = 'weekly' | 'fortnightly' | 'monthly';

export const PERIODS_PER_YEAR: Record<PayFrequency, number> = {
  weekly: 52,
  fortnightly: 26,
  monthly: 12,
};

/** Annual income tax before rebates. */
export function annualTaxBeforeRebates(taxableAnnualCents: Cents, table: TaxTable): Cents {
  if (taxableAnnualCents <= 0) return 0;
  const bracket = [...table.brackets]
    .sort((a, b) => b.thresholdCents - a.thresholdCents)
    .find((b) => taxableAnnualCents > b.thresholdCents) ?? table.brackets[0]!;
  return bracket.baseCents + applyBasisPoints(taxableAnnualCents - bracket.thresholdCents, bracket.rateBp);
}

/** Rebates by age at the end of the tax year. */
export function annualRebates(age: number, table: TaxTable): Cents {
  const { primary, secondary, tertiary } = table.rebatesCents;
  return primary + (age >= 65 ? secondary : 0) + (age >= 75 ? tertiary : 0);
}

export function annualTax(taxableAnnualCents: Cents, age: number, table: TaxTable): Cents {
  return Math.max(0, annualTaxBeforeRebates(taxableAnnualCents, table) - annualRebates(age, table));
}

export interface MedicalCover {
  /** True if the employee is the main member of a medical scheme. */
  mainMember: boolean;
  /** Number of dependants on the scheme. */
  dependants: number;
}

export function monthlyMedicalCredit(cover: MedicalCover | undefined, credits: MedicalCredits): Cents {
  if (!cover?.mainMember) return 0;
  const first = cover.dependants >= 1 ? credits.firstDependantCents : 0;
  const additional = Math.max(0, cover.dependants - 1) * credits.additionalDependantCents;
  return credits.mainMemberCents + first + additional;
}

export function periodicPaye(input: {
  periodTaxableCents: Cents;
  frequency: PayFrequency;
  age: number;
  table: TaxTable;
  medicalCredits: MedicalCredits;
  medicalCover?: MedicalCover;
}): Cents {
  const periods = PERIODS_PER_YEAR[input.frequency];
  const annualTaxCents = annualTax(input.periodTaxableCents * periods, input.age, input.table);
  const periodTax = roundHalfUp(annualTaxCents / periods);
  const periodCredit = roundHalfUp((monthlyMedicalCredit(input.medicalCover, input.medicalCredits) * 12) / periods);
  return Math.max(0, periodTax - periodCredit);
}

/** UIF ceiling pro-rated to the pay period (review fix #4: weekly/fortnightly). */
export function uifCeilingForPeriod(monthlyCeilingCents: Cents, frequency: PayFrequency): Cents {
  return Math.floor((monthlyCeilingCents * 12) / PERIODS_PER_YEAR[frequency]);
}

export function uifContributions(input: {
  remunerationCents: Cents;
  frequency: PayFrequency;
  monthlyCeilingCents: Cents;
  employeeRateBp: number;
  employerRateBp: number;
}): { baseCents: Cents; employeeCents: Cents; employerCents: Cents } {
  const baseCents = Math.min(
    Math.max(0, input.remunerationCents),
    uifCeilingForPeriod(input.monthlyCeilingCents, input.frequency),
  );
  return {
    baseCents,
    employeeCents: applyBasisPoints(baseCents, input.employeeRateBp),
    employerCents: applyBasisPoints(baseCents, input.employerRateBp),
  };
}

/** SDL: 1% of the leviable amount, only for employers liable (payroll > R500 000 a year). */
export function sdlContribution(input: { leviableCents: Cents; liable: boolean; rateBp: number }): Cents {
  return input.liable ? applyBasisPoints(Math.max(0, input.leviableCents), input.rateBp) : 0;
}

export interface EtiInput {
  monthlyRemunerationCents: Cents;
  hoursPaid: number;
  /** 1-based month of qualifying employment (1-12 = first year, 13-24 = second). */
  employmentMonth: number;
  age: number;
  /** Effective hourly rate, to confirm the employee is paid at least the NMW. */
  hourlyRateCents: Cents;
  nmwHourlyCents: Cents;
  table: EtiTable;
}

export type EtiResult =
  | { eligible: true; amountCents: Cents }
  | { eligible: false; amountCents: 0; reason: string };

/** Employment Tax Incentive per month (amounts from 1 April 2025). */
export function employmentTaxIncentive(input: EtiInput): EtiResult {
  const t = input.table;
  const no = (reason: string): EtiResult => ({ eligible: false, amountCents: 0, reason });
  if (input.age < t.minAge || input.age > t.maxAge) return no(`age ${input.age} outside ${t.minAge}-${t.maxAge}`);
  if (input.employmentMonth < 1 || input.employmentMonth > 24) return no('outside the 24-month qualifying period');
  if (input.hourlyRateCents < input.nmwHourlyCents) return no('paid below the National Minimum Wage');
  if (input.hoursPaid <= 0) return no('no hours paid');

  // Grossed up to a full month when fewer than 160 hours were paid.
  const scale = Math.min(1, input.hoursPaid / t.fullHours);
  const remuneration = scale < 1 ? input.monthlyRemunerationCents / scale : input.monthlyRemunerationCents;
  if (remuneration >= t.maxRemunerationCents) return no('remuneration at or above the ETI maximum');

  const firstYear = input.employmentMonth <= 12;
  let full: number;
  if (remuneration < t.band1UpToCents) {
    full = (remuneration * (firstYear ? t.band1FirstBp : t.band1SecondBp)) / 10_000;
  } else if (remuneration < t.band2UpToCents) {
    full = firstYear ? t.flatFirstCents : t.flatSecondCents;
  } else {
    const flat = firstYear ? t.flatFirstCents : t.flatSecondCents;
    const taper = firstYear ? t.taperFirstBp : t.taperSecondBp;
    full = flat - ((remuneration - t.band2UpToCents) * taper) / 10_000;
  }
  return { eligible: true, amountCents: Math.max(0, roundHalfUp(full * scale)) };
}

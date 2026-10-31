/**
 * Builds a payslip as coded lines (review fix #6). Each line carries the SARS IRP5
 * source code it reports under, so EMP201 and EMP501 values are sums over lines.
 *
 * Tips are a separate line and are never part of the minimum-wage test
 * (Sectoral Determination 14). Their tax and UIF treatment is flagged
 * `needsReview` until a registered tax practitioner signs it off.
 */
import { checkMinimumWage } from '../bcea/checks';
import type { ComplianceFinding, PaySegment } from '../bcea/types';
import { payForMinutes, sumCents, type Cents } from '../money';
import type { RuleSet } from '../rules/registry';
import {
  employmentTaxIncentive,
  periodicPaye,
  sdlContribution,
  uifContributions,
  type MedicalCover,
  type PayFrequency,
} from './statutory';

export type PayslipLineKind = 'earning' | 'deduction' | 'employer_contribution' | 'tip' | 'info';

export interface PayslipLine {
  code: string;
  kind: PayslipLineKind;
  description: string;
  quantityMinutes?: number;
  rateCents?: Cents;
  multiplier?: number;
  amountCents: Cents;
  sarsCode?: string;
  needsReview?: boolean;
}

/** IRP5 source codes used by the engine. */
export const SARS_CODES = {
  income: '3601',
  overtime: '3607',
  paye: '4102',
  uif: '4141',
  sdl: '4142',
  eti: '4118',
} as const;

export interface Allowance {
  code: string;
  description: string;
  amountCents: Cents;
  taxable: boolean;
}

export interface PayslipInput {
  employeeId: string;
  frequency: PayFrequency;
  /** Pay date (YYYY-MM-DD): decides which rule versions apply. */
  payDate: string;
  hourlyRateCents: Cents;
  segments: readonly PaySegment[];
  /** Optional night-work allowance per night hour (BCEA s17). */
  nightAllowancePerHourCents?: Cents;
  allowances?: readonly Allowance[];
  /** Tips routed through payroll (card tips, passed-on service charges). */
  tipsCents?: Cents;
  /** Age at the end of the tax year. */
  age: number;
  medicalCover?: MedicalCover;
  sdlLiable: boolean;
  /** For ETI: month of qualifying employment (monthly payroll only). */
  etiEmploymentMonth?: number;
  rules: RuleSet;
}

export interface PayslipResult {
  employeeId: string;
  lines: PayslipLine[];
  grossCents: Cents;
  deductionsCents: Cents;
  netCents: Cents;
  employerContributionsCents: Cents;
  employerCostCents: Cents;
  etiCents: Cents;
  findings: ComplianceFinding[];
  ruleVersionKeys: string[];
}

const EARNING_LABELS: Record<string, { code: string; description: string }> = {
  'ordinary:false': { code: 'ORDINARY', description: 'Ordinary hours' },
  'overtime:true': { code: 'OVERTIME', description: 'Overtime' },
  'sunday:false': { code: 'SUNDAY', description: 'Sunday work' },
  'sunday:true': { code: 'SUNDAY_OVERTIME', description: 'Sunday overtime' },
  'public_holiday:false': { code: 'PUBLIC_HOLIDAY', description: 'Public holiday work' },
  'public_holiday:true': { code: 'PUBLIC_HOLIDAY_OVERTIME', description: 'Public holiday overtime' },
};

export function buildPayslip(input: PayslipInput): PayslipResult {
  const { rules, payDate } = input;
  rules.resetUsage();
  const lines: PayslipLine[] = [];

  // 1. Earnings from segments, grouped by pay type, overtime flag and multiplier.
  const groups = new Map<string, { payType: string; overtime: boolean; multiplier: number; minutes: number }>();
  let nightMinutes = 0;
  for (const s of input.segments) {
    const key = `${s.payType}:${s.isOvertime}:${s.multiplier}`;
    const g = groups.get(key) ?? { payType: s.payType, overtime: s.isOvertime, multiplier: s.multiplier, minutes: 0 };
    g.minutes += s.minutes;
    groups.set(key, g);
    nightMinutes += s.nightMinutes;
  }
  const order = ['ordinary', 'overtime', 'sunday', 'public_holiday'];
  const sortedGroups = [...groups.values()].sort(
    (a, b) => order.indexOf(a.payType) - order.indexOf(b.payType) || Number(a.overtime) - Number(b.overtime),
  );
  for (const g of sortedGroups) {
    const label = EARNING_LABELS[`${g.payType}:${g.overtime}`] ?? { code: g.payType.toUpperCase(), description: g.payType };
    lines.push({
      code: label.code,
      kind: 'earning',
      description: label.description,
      quantityMinutes: g.minutes,
      rateCents: input.hourlyRateCents,
      multiplier: g.multiplier,
      amountCents: payForMinutes(g.minutes, input.hourlyRateCents, g.multiplier),
      sarsCode: g.overtime ? SARS_CODES.overtime : SARS_CODES.income,
    });
  }

  if (input.nightAllowancePerHourCents && nightMinutes > 0) {
    lines.push({
      code: 'NIGHT_ALLOWANCE',
      kind: 'earning',
      description: 'Night work allowance (18:00-06:00)',
      quantityMinutes: nightMinutes,
      rateCents: input.nightAllowancePerHourCents,
      amountCents: payForMinutes(nightMinutes, input.nightAllowancePerHourCents),
      sarsCode: SARS_CODES.income,
    });
  }

  for (const a of input.allowances ?? []) {
    lines.push({
      code: a.code,
      kind: 'earning',
      description: a.description,
      amountCents: a.amountCents,
      ...(a.taxable ? { sarsCode: SARS_CODES.income } : {}),
    });
  }

  const wageCents = sumCents(lines.filter((l) => l.kind === 'earning').map((l) => l.amountCents));
  const workedMinutes = input.segments.reduce((m, s) => m + s.minutes, 0);

  // 2. Tips: own line, outside the NMW test.
  const tipsCents = input.tipsCents ?? 0;
  if (tipsCents > 0) {
    lines.push({
      code: 'TIPS',
      kind: 'tip',
      description: 'Tips paid through payroll',
      amountCents: tipsCents,
      sarsCode: SARS_CODES.income,
      needsReview: true,
    });
  }
  const grossCents = wageCents + tipsCents;
  const taxableCents =
    grossCents - sumCents((input.allowances ?? []).filter((a) => !a.taxable).map((a) => a.amountCents));

  // 3. Statutory deductions and employer contributions.
  const paye = periodicPaye({
    periodTaxableCents: taxableCents,
    frequency: input.frequency,
    age: input.age,
    table: rules.get('paye.tax_table', payDate),
    medicalCredits: rules.get('paye.medical_credits_monthly', payDate),
    ...(input.medicalCover ? { medicalCover: input.medicalCover } : {}),
  });
  // UIF base excludes tips until their treatment is confirmed (see module note).
  const uif = uifContributions({
    remunerationCents: wageCents,
    frequency: input.frequency,
    monthlyCeilingCents: rules.get('uif.monthly_ceiling_cents', payDate),
    employeeRateBp: rules.get('uif.employee_rate_bp', payDate),
    employerRateBp: rules.get('uif.employer_rate_bp', payDate),
  });
  const sdl = sdlContribution({
    leviableCents: taxableCents,
    liable: input.sdlLiable,
    rateBp: rules.get('sdl.rate_bp', payDate),
  });

  lines.push({ code: 'PAYE', kind: 'deduction', description: 'PAYE (income tax)', amountCents: paye, sarsCode: SARS_CODES.paye });
  lines.push({ code: 'UIF_EMPLOYEE', kind: 'deduction', description: 'UIF (employee 1%)', amountCents: uif.employeeCents, sarsCode: SARS_CODES.uif });
  lines.push({ code: 'UIF_EMPLOYER', kind: 'employer_contribution', description: 'UIF (employer 1%)', amountCents: uif.employerCents, sarsCode: SARS_CODES.uif });
  if (sdl > 0) {
    lines.push({ code: 'SDL', kind: 'employer_contribution', description: 'Skills Development Levy (1%)', amountCents: sdl, sarsCode: SARS_CODES.sdl });
  }

  // 4. ETI (monthly payroll only; weekly/fortnightly ETI is computed at month end).
  let etiCents = 0;
  if (input.frequency === 'monthly' && input.etiEmploymentMonth !== undefined) {
    const eti = employmentTaxIncentive({
      monthlyRemunerationCents: wageCents,
      hoursPaid: workedMinutes / 60,
      employmentMonth: input.etiEmploymentMonth,
      age: input.age,
      hourlyRateCents: input.hourlyRateCents,
      nmwHourlyCents: rules.get('nmw.hourly_cents', payDate),
      table: rules.get('eti.table', payDate),
    });
    etiCents = eti.amountCents;
    if (etiCents > 0) {
      lines.push({ code: 'ETI', kind: 'info', description: 'Employment Tax Incentive (offsets PAYE on EMP201)', amountCents: etiCents, sarsCode: SARS_CODES.eti });
    }
  }

  // 5. Minimum wage test on hourly earnings only (no tips, no allowances).
  const hourlyEarnings = sumCents(
    lines.filter((l) => l.kind === 'earning' && l.quantityMinutes !== undefined && l.code !== 'NIGHT_ALLOWANCE').map((l) => l.amountCents),
  );
  const findings = checkMinimumWage({
    subjectId: input.employeeId,
    wageCents: hourlyEarnings,
    workedMinutes,
    onDate: payDate,
    rules,
  });

  const deductionsCents = sumCents(lines.filter((l) => l.kind === 'deduction').map((l) => l.amountCents));
  const employerContributionsCents = sumCents(
    lines.filter((l) => l.kind === 'employer_contribution').map((l) => l.amountCents),
  );

  return {
    employeeId: input.employeeId,
    lines,
    grossCents,
    deductionsCents,
    netCents: grossCents - deductionsCents,
    employerContributionsCents,
    employerCostCents: grossCents + employerContributionsCents,
    etiCents,
    findings,
    ruleVersionKeys: rules.usedKeys(),
  };
}

export interface Emp201Totals {
  payeCents: Cents;
  uifCents: Cents;
  sdlCents: Cents;
  etiCents: Cents;
  /** PAYE less ETI (not below zero) plus UIF and SDL. */
  payableCents: Cents;
}

/**
 * Monthly EMP201 values from payslip lines. EMP201 is captured on SARS eFiling;
 * this produces the figures, not a file (review, Task 5).
 */
export function emp201Totals(payslips: ReadonlyArray<{ lines: readonly PayslipLine[] }>): Emp201Totals {
  const all = payslips.flatMap((p) => p.lines);
  const bySars = (code: string) => sumCents(all.filter((l) => l.sarsCode === code).map((l) => l.amountCents));
  const payeCents = bySars(SARS_CODES.paye);
  const uifCents = bySars(SARS_CODES.uif);
  const sdlCents = bySars(SARS_CODES.sdl);
  const etiCents = bySars(SARS_CODES.eti);
  return {
    payeCents,
    uifCents,
    sdlCents,
    etiCents,
    payableCents: Math.max(0, payeCents - etiCents) + uifCents + sdlCents,
  };
}

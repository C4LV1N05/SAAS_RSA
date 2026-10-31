import { describe, expect, it } from 'vitest';
import {
  annualTax,
  buildPayslip,
  emp201Totals,
  employmentTaxIncentive,
  periodicPaye,
  sdlContribution,
  segmentWork,
  uifCeilingForPeriod,
  uifContributions,
} from '../src';
import { holidays, profile, rules, sast, shift } from './helpers';

const r = rules();
const table2027 = r.get('paye.tax_table', '2026-11-01');
const table2026 = r.get('paye.tax_table', '2026-02-01');
const credits2027 = r.get('paye.medical_credits_monthly', '2026-11-01');
const eti = r.get('eti.table', '2026-11-01');

describe('PAYE (2027 tax year: 1 March 2026 - 28 February 2027)', () => {
  // Hand-calculated from the SARS 2027 table.
  it('computes annual tax after the primary rebate', () => {
    expect(annualTax(24_000_000, 40, table2027)).toBe(2_538_000); // R240 000 -> R25 380
    expect(annualTax(36_000_000, 40, table2027)).toBe(5_617_200); // R360 000 -> R56 172
    expect(annualTax(9_600_000, 40, table2027)).toBe(0); // below the R99 000 threshold
  });

  it('computes monthly PAYE', () => {
    const base = { frequency: 'monthly' as const, age: 40, table: table2027, medicalCredits: credits2027 };
    expect(periodicPaye({ ...base, periodTaxableCents: 2_000_000 })).toBe(211_500); // R2 115.00
    expect(periodicPaye({ ...base, periodTaxableCents: 3_000_000 })).toBe(468_100); // R4 681.00
  });

  it('applies the secondary rebate at 65', () => {
    expect(periodicPaye({ periodTaxableCents: 3_000_000, frequency: 'monthly', age: 65, table: table2027, medicalCredits: credits2027 })).toBe(386_725);
  });

  it('deducts medical scheme fees tax credits', () => {
    expect(
      periodicPaye({
        periodTaxableCents: 3_000_000,
        frequency: 'monthly',
        age: 40,
        table: table2027,
        medicalCredits: credits2027,
        medicalCover: { mainMember: true, dependants: 1 },
      }),
    ).toBe(468_100 - 75_200);
  });

  it('annualises weekly pay', () => {
    // R5 000 x 52 = R260 000 -> R47 992 - R17 820 = R30 172 / 52 = R580.23
    expect(periodicPaye({ periodTaxableCents: 500_000, frequency: 'weekly', age: 30, table: table2027, medicalCredits: credits2027 })).toBe(58_023);
  });

  it('uses the 2026 table before 1 March 2026', () => {
    // R240 000 -> R43 432 - R17 235 = R26 197 / 12 = R2 183.08
    expect(periodicPaye({ periodTaxableCents: 2_000_000, frequency: 'monthly', age: 40, table: table2026, medicalCredits: credits2027 })).toBe(218_308);
  });
});

describe('UIF and SDL', () => {
  const uifRates = { monthlyCeilingCents: 1_771_200, employeeRateBp: 100, employerRateBp: 100 };

  it('caps UIF at the monthly ceiling', () => {
    expect(uifContributions({ ...uifRates, remunerationCents: 2_000_000, frequency: 'monthly' })).toEqual({
      baseCents: 1_771_200,
      employeeCents: 17_712,
      employerCents: 17_712,
    });
  });

  it('pro-rates the ceiling for weekly pay (review fix #4)', () => {
    expect(uifCeilingForPeriod(1_771_200, 'weekly')).toBe(408_738); // R4 087.38
    expect(uifContributions({ ...uifRates, remunerationCents: 500_000, frequency: 'weekly' }).employeeCents).toBe(4_087);
  });

  it('charges SDL only to liable employers', () => {
    expect(sdlContribution({ leviableCents: 2_000_000, liable: true, rateBp: 100 })).toBe(20_000);
    expect(sdlContribution({ leviableCents: 2_000_000, liable: false, rateBp: 100 })).toBe(0);
  });
});

describe('Employment Tax Incentive (from 1 April 2025)', () => {
  const base = { hoursPaid: 160, employmentMonth: 3, age: 22, hourlyRateCents: 3500, nmwHourlyCents: 3023, table: eti };

  it('follows the three bands', () => {
    expect(employmentTaxIncentive({ ...base, monthlyRemunerationCents: 200_000 }).amountCents).toBe(120_000); // 60% of R2 000
    expect(employmentTaxIncentive({ ...base, monthlyRemunerationCents: 400_000 }).amountCents).toBe(150_000); // flat R1 500
    expect(employmentTaxIncentive({ ...base, monthlyRemunerationCents: 650_000 }).amountCents).toBe(75_000); // 1500 - 75% x 1000
    expect(employmentTaxIncentive({ ...base, employmentMonth: 14, monthlyRemunerationCents: 650_000 }).amountCents).toBe(37_500);
  });

  it('pro-rates for fewer than 160 hours', () => {
    expect(employmentTaxIncentive({ ...base, hoursPaid: 80, monthlyRemunerationCents: 200_000 }).amountCents).toBe(75_000);
  });

  it('rejects ineligible employees', () => {
    expect(employmentTaxIncentive({ ...base, monthlyRemunerationCents: 750_000 }).eligible).toBe(false);
    expect(employmentTaxIncentive({ ...base, age: 30, monthlyRemunerationCents: 400_000 }).eligible).toBe(false);
    expect(employmentTaxIncentive({ ...base, hourlyRateCents: 2900, monthlyRemunerationCents: 400_000 }).eligible).toBe(false);
  });
});

describe('payslip', () => {
  // Waiter, R35.00/h. Mon-Fri 08:00-17:00 with a 1 h unpaid lunch, plus Sunday 10:00-14:00.
  const week = [
    ...['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].map((d, i) => ({
      ...shift(`s${i}`, d, '08:00', '17:00'),
      breaks: [{ start: sast(`${d}T12:00`), end: sast(`${d}T13:00`), paid: false }],
    })),
    shift('sun', '2026-11-08', '10:00', '14:00'),
  ];
  const segments = segmentWork(week, profile(), { rules: rules(), publicHolidays: holidays });

  const slip = buildPayslip({
    employeeId: 'emp-1',
    frequency: 'weekly',
    payDate: '2026-11-13',
    hourlyRateCents: 3500,
    segments,
    tipsCents: 30_000,
    age: 24,
    sdlLiable: false,
    rules: rules(),
  });

  it('prices ordinary and Sunday time', () => {
    const byCode = Object.fromEntries(slip.lines.map((l) => [l.code, l]));
    expect(byCode.ORDINARY).toMatchObject({ quantityMinutes: 2400, amountCents: 140_000, sarsCode: '3601' });
    expect(byCode.SUNDAY).toMatchObject({ quantityMinutes: 240, multiplier: 2, amountCents: 28_000 });
    expect(byCode.TIPS).toMatchObject({ kind: 'tip', amountCents: 30_000, needsReview: true });
  });

  it('computes statutory deductions and net pay', () => {
    // Taxable R1 980 x 52 = R102 960 -> R18 532.80 - R17 820 = R712.80 / 52 = R13.71
    const byCode = Object.fromEntries(slip.lines.map((l) => [l.code, l.amountCents]));
    expect(byCode.PAYE).toBe(1_371);
    expect(byCode.UIF_EMPLOYEE).toBe(1_680); // 1% of R1 680 wages (tips excluded)
    expect(byCode.UIF_EMPLOYER).toBe(1_680);
    expect(byCode.SDL).toBeUndefined();
    expect(slip.grossCents).toBe(198_000);
    expect(slip.netCents).toBe(198_000 - 1_371 - 1_680);
    expect(slip.employerCostCents).toBe(198_000 + 1_680);
    expect(slip.findings).toEqual([]);
    expect(slip.ruleVersionKeys).toContain('paye.tax_table@2026-03-01');
  });

  it('never lets tips make up a sub-minimum wage', () => {
    const underpaid = buildPayslip({
      employeeId: 'emp-2',
      frequency: 'weekly',
      payDate: '2026-11-13',
      hourlyRateCents: 2500,
      segments,
      tipsCents: 500_000,
      age: 24,
      sdlLiable: false,
      rules: rules(),
    });
    expect(underpaid.findings.map((f) => f.ruleKey)).toEqual(['nmw.hourly_floor']);
  });

  it('sums payslips into EMP201 values', () => {
    const totals = emp201Totals([slip, slip]);
    expect(totals).toEqual({
      payeCents: 2_742,
      uifCents: 6_720,
      sdlCents: 0,
      etiCents: 0,
      payableCents: 2_742 + 6_720,
    });
  });

  it('applies ETI on a monthly payroll and offsets it against PAYE', () => {
    const monthly = buildPayslip({
      employeeId: 'emp-3',
      frequency: 'monthly',
      payDate: '2026-11-30',
      hourlyRateCents: 3500,
      segments: [{ ...segments[0]!, minutes: 160 * 60, isOvertime: false, payType: 'ordinary', multiplier: 1, nightMinutes: 0 }],
      age: 22,
      sdlLiable: true,
      etiEmploymentMonth: 2,
      rules: rules(),
    });
    // 160 h x R35 = R5 600: R1 500 - 75% x (R5 600 - R5 500) = R1 425
    expect(monthly.etiCents).toBe(142_500);
    expect(monthly.lines.find((l) => l.code === 'SDL')?.amountCents).toBe(5_600);
    // R67 200 a year is below the tax threshold, so PAYE is 0 and ETI offsets nothing;
    // EMP201 payable = UIF (2 x R56) + SDL (R56).
    expect(monthly.lines.find((l) => l.code === 'PAYE')?.amountCents).toBe(0);
    expect(emp201Totals([monthly]).payableCents).toBe(5_600 * 2 + 5_600);
  });
});

/**
 * National South African rule versions. This file is the single source for the
 * database seed (packages/db/src/seed.ts) and for tests.
 *
 * Update every February before the new tax year (1 March) and after each National
 * Minimum Wage gazette. Each value cites its source. Values verified 2026-11-01.
 */
import type { PublicHoliday, RuleVersion } from './types';

const SARS_RATES = 'https://www.sars.gov.za/tax-rates/income-tax/rates-of-tax-for-individuals/';
const BUDGET_2026 = 'Budget 2026 (effective 1 March 2026); https://www.simplepay.co.za/blog/2026/02/27/national-budget-speech-2026/';
const BCEA = 'Basic Conditions of Employment Act 75 of 1997';

export const SA_RULE_VERSIONS: RuleVersion[] = [
  // --- National Minimum Wage (Government Gazette 54075, 3 Feb 2026) ---
  { key: 'nmw.hourly_cents', value: 2879, effectiveFrom: '2025-03-01', effectiveTo: '2026-03-01', source: 'National Minimum Wage 2025' },
  { key: 'nmw.hourly_cents', value: 3023, effectiveFrom: '2026-03-01', source: 'Government Gazette 54075, 3 February 2026' },

  // --- UIF (Unemployment Insurance Contributions Act) ---
  { key: 'uif.monthly_ceiling_cents', value: 1_771_200, effectiveFrom: '2021-06-01', source: 'UIF remuneration ceiling R17 712 per month' },
  { key: 'uif.employee_rate_bp', value: 100, effectiveFrom: '2002-04-01', source: 'UIF Contributions Act: 1% employee' },
  { key: 'uif.employer_rate_bp', value: 100, effectiveFrom: '2002-04-01', source: 'UIF Contributions Act: 1% employer' },

  // --- SDL (Skills Development Levies Act) ---
  { key: 'sdl.rate_bp', value: 100, effectiveFrom: '2000-04-01', source: 'Skills Development Levies Act: 1% of leviable amount' },
  { key: 'sdl.annual_payroll_threshold_cents', value: 50_000_000, effectiveFrom: '2005-08-01', source: 'SDL exemption below R500 000 annual payroll' },

  // --- BCEA hours, rest and premiums ---
  { key: 'bcea.max_ordinary_weekly_minutes', value: 45 * 60, effectiveFrom: '1998-12-01', source: `${BCEA} s9(1)(a)` },
  { key: 'bcea.max_ordinary_daily_minutes_5day', value: 9 * 60, effectiveFrom: '1998-12-01', source: `${BCEA} s9(1)(b)` },
  { key: 'bcea.max_ordinary_daily_minutes_6day', value: 8 * 60, effectiveFrom: '1998-12-01', source: `${BCEA} s9(1)(c)` },
  { key: 'bcea.max_overtime_daily_minutes', value: 3 * 60, effectiveFrom: '1998-12-01', source: `${BCEA} s10(1)(b)` },
  { key: 'bcea.max_overtime_weekly_minutes', value: 10 * 60, effectiveFrom: '1998-12-01', source: `${BCEA} s10(1)(b)` },
  { key: 'bcea.daily_rest_minutes', value: 12 * 60, effectiveFrom: '1998-12-01', source: `${BCEA} s15(1)(a)` },
  { key: 'bcea.weekly_rest_minutes', value: 36 * 60, effectiveFrom: '1998-12-01', source: `${BCEA} s15(1)(b)` },
  { key: 'bcea.meal_interval_after_minutes', value: 5 * 60, effectiveFrom: '1998-12-01', source: `${BCEA} s14(1)` },
  { key: 'bcea.overtime_multiplier', value: 1.5, effectiveFrom: '1998-12-01', source: `${BCEA} s10(2)` },
  { key: 'bcea.sunday_multiplier_ordinarily_worked', value: 1.5, effectiveFrom: '1998-12-01', source: `${BCEA} s16(1)(b)` },
  { key: 'bcea.sunday_multiplier_not_ordinarily_worked', value: 2, effectiveFrom: '1998-12-01', source: `${BCEA} s16(1)(a)` },
  { key: 'bcea.public_holiday_multiplier', value: 2, effectiveFrom: '1998-12-01', source: `${BCEA} s18(3)` },
  { key: 'bcea.night_start_minute', value: 18 * 60, effectiveFrom: '1998-12-01', source: `${BCEA} s17: night work 18:00` },
  { key: 'bcea.night_end_minute', value: 6 * 60, effectiveFrom: '1998-12-01', source: `${BCEA} s17: night work to 06:00` },

  // --- PAYE tax tables ---
  {
    key: 'paye.tax_table',
    effectiveFrom: '2025-03-01',
    effectiveTo: '2026-03-01',
    source: SARS_RATES,
    value: {
      taxYear: '2026',
      brackets: [
        { thresholdCents: 0, baseCents: 0, rateBp: 1800 },
        { thresholdCents: 23_710_000, baseCents: 4_267_800, rateBp: 2600 },
        { thresholdCents: 37_050_000, baseCents: 7_736_200, rateBp: 3100 },
        { thresholdCents: 51_280_000, baseCents: 12_147_500, rateBp: 3600 },
        { thresholdCents: 67_300_000, baseCents: 17_914_700, rateBp: 3900 },
        { thresholdCents: 85_790_000, baseCents: 25_125_800, rateBp: 4100 },
        { thresholdCents: 181_700_000, baseCents: 64_448_900, rateBp: 4500 },
      ],
      rebatesCents: { primary: 1_723_500, secondary: 944_400, tertiary: 314_500 },
    },
  },
  {
    key: 'paye.tax_table',
    effectiveFrom: '2026-03-01',
    effectiveTo: '2027-03-01',
    source: SARS_RATES,
    value: {
      taxYear: '2027',
      brackets: [
        { thresholdCents: 0, baseCents: 0, rateBp: 1800 },
        { thresholdCents: 24_510_000, baseCents: 4_411_800, rateBp: 2600 },
        { thresholdCents: 38_310_000, baseCents: 7_999_800, rateBp: 3100 },
        { thresholdCents: 53_020_000, baseCents: 12_559_900, rateBp: 3600 },
        { thresholdCents: 69_580_000, baseCents: 18_521_500, rateBp: 3900 },
        { thresholdCents: 88_700_000, baseCents: 25_978_300, rateBp: 4100 },
        { thresholdCents: 187_860_000, baseCents: 66_633_900, rateBp: 4500 },
      ],
      rebatesCents: { primary: 1_782_000, secondary: 976_500, tertiary: 324_900 },
    },
  },
  {
    key: 'paye.medical_credits_monthly',
    effectiveFrom: '2025-03-01',
    effectiveTo: '2026-03-01',
    source: BUDGET_2026,
    value: { mainMemberCents: 36_400, firstDependantCents: 36_400, additionalDependantCents: 24_600 },
  },
  {
    key: 'paye.medical_credits_monthly',
    effectiveFrom: '2026-03-01',
    effectiveTo: '2027-03-01',
    source: BUDGET_2026,
    value: { mainMemberCents: 37_600, firstDependantCents: 37_600, additionalDependantCents: 25_400 },
  },

  // --- VAT (menu prices are VAT-inclusive) ---
  {
    key: 'vat.rate_bp',
    value: 1500,
    effectiveFrom: '2018-04-01',
    source: 'Value-Added Tax Act 89 of 1991: 15% from 1 April 2018; 2025 increase withdrawn (rate remains 15%)',
  },

  // --- Employment Tax Incentive (from 1 April 2025) ---
  {
    key: 'eti.table',
    effectiveFrom: '2025-04-01',
    source: 'https://www.sars.gov.za/latest-news/employment-tax-incentive-eti-changes-with-effect-from-1-april-2025/',
    value: {
      minAge: 18,
      maxAge: 29,
      maxRemunerationCents: 750_000,
      fullHours: 160,
      band1UpToCents: 250_000,
      band1FirstBp: 6000,
      band1SecondBp: 3000,
      band2UpToCents: 550_000,
      flatFirstCents: 150_000,
      flatSecondCents: 75_000,
      taperFirstBp: 7500,
      taperSecondBp: 3750,
    },
  },
];

/**
 * National public holidays (Public Holidays Act 36 of 1994). A holiday that falls
 * on a Sunday moves to the Monday (s2(1)); the Monday is listed here.
 */
export const SA_PUBLIC_HOLIDAYS: PublicHoliday[] = [
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-03-21', name: 'Human Rights Day' },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-04-06', name: 'Family Day' },
  { date: '2026-04-27', name: 'Freedom Day' },
  { date: '2026-05-01', name: "Workers' Day" },
  { date: '2026-06-16', name: 'Youth Day' },
  { date: '2026-08-10', name: "National Women's Day (observed)" },
  { date: '2026-09-24', name: 'Heritage Day' },
  { date: '2026-12-16', name: 'Day of Reconciliation' },
  { date: '2026-12-25', name: 'Christmas Day' },
  { date: '2026-12-26', name: 'Day of Goodwill' },
  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-03-22', name: 'Human Rights Day (observed)' },
  { date: '2027-03-26', name: 'Good Friday' },
  { date: '2027-03-29', name: 'Family Day' },
  { date: '2027-04-27', name: 'Freedom Day' },
  { date: '2027-05-01', name: "Workers' Day" },
  { date: '2027-06-16', name: 'Youth Day' },
  { date: '2027-08-09', name: "National Women's Day" },
  { date: '2027-09-24', name: 'Heritage Day' },
  { date: '2027-12-16', name: 'Day of Reconciliation' },
  { date: '2027-12-25', name: 'Christmas Day' },
  { date: '2027-12-27', name: 'Day of Goodwill (observed)' },
];

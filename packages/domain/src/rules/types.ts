import type { Cents } from '../money';

export interface TaxBracket {
  /** Income above this annual amount is taxed at rateBp (cents). */
  thresholdCents: Cents;
  /** Tax on income up to the threshold (cents). */
  baseCents: Cents;
  /** Marginal rate in basis points (1800 = 18%). */
  rateBp: number;
}

export interface TaxTable {
  taxYear: string; // e.g. "2027" = 1 March 2026 - 28 February 2027
  brackets: TaxBracket[];
  rebatesCents: { primary: Cents; secondary: Cents; tertiary: Cents };
}

export interface MedicalCredits {
  mainMemberCents: Cents;
  firstDependantCents: Cents;
  additionalDependantCents: Cents;
}

export interface EtiTable {
  minAge: number;
  maxAge: number;
  maxRemunerationCents: Cents; // remuneration must be LESS than this
  fullHours: number; // hours in a month for the full amount
  band1UpToCents: Cents; // R0 - R2 499.99: percentage of remuneration
  band1FirstBp: number;
  band1SecondBp: number;
  band2UpToCents: Cents; // R2 500 - R5 499.99: flat amount
  flatFirstCents: Cents;
  flatSecondCents: Cents;
  taperFirstBp: number; // R5 500 - R7 499.99: flat minus taper x (rem - band2UpTo)
  taperSecondBp: number;
}

/** Every rule the engine reads, with its value type. Add keys here first. */
export interface RuleValueMap {
  'nmw.hourly_cents': Cents;
  'uif.monthly_ceiling_cents': Cents;
  'uif.employee_rate_bp': number;
  'uif.employer_rate_bp': number;
  'sdl.rate_bp': number;
  'sdl.annual_payroll_threshold_cents': Cents;
  'bcea.max_ordinary_weekly_minutes': number;
  'bcea.max_ordinary_daily_minutes_5day': number;
  'bcea.max_ordinary_daily_minutes_6day': number;
  'bcea.max_overtime_daily_minutes': number;
  'bcea.max_overtime_weekly_minutes': number;
  'bcea.daily_rest_minutes': number;
  'bcea.weekly_rest_minutes': number;
  'bcea.meal_interval_after_minutes': number;
  'bcea.overtime_multiplier': number;
  'bcea.sunday_multiplier_ordinarily_worked': number;
  'bcea.sunday_multiplier_not_ordinarily_worked': number;
  'bcea.public_holiday_multiplier': number;
  'bcea.night_start_minute': number;
  'bcea.night_end_minute': number;
  'paye.tax_table': TaxTable;
  'paye.medical_credits_monthly': MedicalCredits;
  'eti.table': EtiTable;
}

export type RuleKey = keyof RuleValueMap;

export interface RuleVersion<K extends RuleKey = RuleKey> {
  key: K;
  value: RuleValueMap[K];
  /** Inclusive, YYYY-MM-DD. */
  effectiveFrom: string;
  /** Exclusive, YYYY-MM-DD. Null/undefined = open-ended. */
  effectiveTo?: string | null;
  source: string;
  /** Null = national rule; set = employer or bargaining-council override. */
  orgId?: string | null;
}

export interface PublicHoliday {
  date: string;
  name: string;
}

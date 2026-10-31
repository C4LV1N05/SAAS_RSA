export interface BreakInterval {
  start: Date;
  end: Date;
  paid: boolean;
}

/** A planned shift or an actual time entry. */
export interface WorkInterval {
  id: string;
  start: Date;
  end: Date;
  breaks?: BreakInterval[];
}

export interface EmployeeWorkProfile {
  /** Days worked per week. <= 5 => 9 h daily limit, more => 8 h (BCEA s9). */
  daysPerWeek: number;
  ordinarilyWorksSundays: boolean;
  overtimeAgreement: boolean;
  mealIntervalMinutes: 30 | 60;
  /** Above the BCEA earnings threshold: hours and overtime rules do not apply (s6(3)). */
  bceaThresholdExempt: boolean;
}

export type PayType = 'ordinary' | 'overtime' | 'sunday' | 'public_holiday';

export interface PaySegment {
  intervalId: string;
  start: Date;
  end: Date;
  minutes: number;
  /** Local SAST date the minutes fall on (decides Sunday / public holiday). */
  localDate: string;
  /** Local date the shift started on (decides which "day" the daily limit applies to). */
  workday: string;
  payType: PayType;
  isOvertime: boolean;
  multiplier: number;
  /** Minutes inside 18:00-06:00 (BCEA s17 night work). */
  nightMinutes: number;
}

export type Severity = 'info' | 'warn' | 'block';

export interface ComplianceFinding {
  ruleKey: string;
  severity: Severity;
  subjectId: string;
  message: string;
  data?: Record<string, unknown>;
}

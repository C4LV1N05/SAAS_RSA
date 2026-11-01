/**
 * Payslip calculation shared by the payroll preview and saved runs, so a run
 * always matches what was previewed. Reads approved hours, dated pay rates,
 * unpaid-out tip shares and approved leave; returns payslips and EMP201 values.
 */
import { and, eq, gte, isNull, lt, lte, ne } from 'drizzle-orm';
import { loadPublicHolidays, loadRuleSet, schema, type TenantContext, type Tx } from '@saas-rsa/db';
import {
  addDays,
  ageOn,
  buildPayslip,
  emp201Totals,
  localMidnight,
  segmentWork,
  taxYearEnd,
  type PayslipLine,
  type PayslipResult,
} from '@saas-rsa/domain';
import { getEmployee, hourlyRateOn, timeIntervals, workProfile, type EmployeeRow } from './data';
import { HttpError } from './errors';
import { leavePayLines } from './leave-pay';

const { organisations, tipDistributions, timeEntries, jobRoles } = schema;

export type Frequency = 'weekly' | 'fortnightly' | 'monthly';

export interface PayrollInput {
  employeeIds: string[];
  periodStart: string;
  periodEnd: string;
  payDate: string;
  frequency: Frequency;
  perEmployee?: Record<string, { tipsCents?: number; medicalCover?: { mainMember: boolean; dependants: number }; etiEmploymentMonth?: number }>;
}

export interface CalculatedPayslip extends PayslipResult {
  employee: EmployeeRow;
  jobRole: string | null;
  hourlyRateCents: number;
  /** Ids of tip shares and leave movements this payslip pays out (linked when the run is finalised). */
  tipDistributionIds: string[];
  leaveTransactionIds: string[];
}

export interface PayrollCalculation {
  payslips: CalculatedPayslip[];
  emp201: ReturnType<typeof emp201Totals>;
  warnings: Array<{ employeeId: string; code: string; message: string }>;
  employer: { legalName: string; tradingName: string | null; payeReference: string | null; uifReference: string | null; sdlLiable: boolean };
}

export async function calculatePayroll(tx: Tx, auth: TenantContext, input: PayrollInput): Promise<PayrollCalculation> {
  const rules = await loadRuleSet(tx, auth.orgId);
  const publicHolidays = await loadPublicHolidays(tx);
  const [org] = await tx.select().from(organisations).where(eq(organisations.id, auth.orgId));
  const from = localMidnight(input.periodStart);
  const to = localMidnight(addDays(input.periodEnd, 1));

  const payslips: CalculatedPayslip[] = [];
  const warnings: PayrollCalculation['warnings'] = [];
  for (const employeeId of input.employeeIds) {
    const employee = await getEmployee(tx, employeeId);
    if (!employee.dateOfBirth) {
      throw new HttpError(422, 'missing_date_of_birth', `${employee.firstName} ${employee.lastName} has no date of birth (needed for tax rebates)`);
    }
    const extra = input.perEmployee?.[employeeId] ?? {};

    const unapproved = await tx
      .select({ id: timeEntries.id })
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.employeeId, employeeId),
          ne(timeEntries.status, 'approved'),
          ne(timeEntries.status, 'rejected'),
          gte(timeEntries.clockIn, from),
          lt(timeEntries.clockIn, to),
        ),
      );
    if (unapproved.length) {
      warnings.push({ employeeId, code: 'unapproved_time', message: `${unapproved.length} time ${unapproved.length === 1 ? 'entry is' : 'entries are'} not approved and left out` });
    }

    const intervals = await timeIntervals(tx, employeeId, from, to, ['approved']);
    const segments = segmentWork(intervals, workProfile(employee), { rules, publicHolidays });

    let tipsCents = extra.tipsCents;
    let tipDistributionIds: string[] = [];
    if (tipsCents === undefined) {
      const tips = await tx
        .select({ id: tipDistributions.id, amount: tipDistributions.amountCents })
        .from(tipDistributions)
        .where(
          and(
            eq(tipDistributions.employeeId, employeeId),
            gte(tipDistributions.businessDate, input.periodStart),
            lte(tipDistributions.businessDate, input.periodEnd),
            isNull(tipDistributions.payrollRunId),
          ),
        );
      tipsCents = tips.reduce((s, t) => s + t.amount, 0);
      tipDistributionIds = tips.map((t) => t.id);
    }

    const hourlyRateCents = await hourlyRateOn(tx, employeeId, input.periodEnd);
    const leave = await leavePayLines(tx, employeeId, input.periodStart, input.periodEnd, hourlyRateCents);

    const slip = buildPayslip({
      employeeId,
      frequency: input.frequency,
      payDate: input.payDate,
      hourlyRateCents,
      segments,
      tipsCents,
      age: ageOn(employee.dateOfBirth, taxYearEnd(input.payDate)),
      sdlLiable: org?.sdlLiable ?? false,
      ...(leave.amountCents > 0 ? { allowances: [{ code: 'LEAVE_PAY', description: 'Leave pay', amountCents: leave.amountCents, taxable: true }] } : {}),
      ...(extra.medicalCover ? { medicalCover: extra.medicalCover } : {}),
      ...(extra.etiEmploymentMonth ? { etiEmploymentMonth: extra.etiEmploymentMonth } : {}),
      rules,
    });
    // Describe leave pay by type and hours rather than as one generic line.
    const lines: PayslipLine[] = slip.lines.flatMap((l) => (l.code === 'LEAVE_PAY' ? leave.lines : [l]));

    const [role] = employee.jobRoleId ? await tx.select({ name: jobRoles.name }).from(jobRoles).where(eq(jobRoles.id, employee.jobRoleId)) : [];
    payslips.push({
      ...slip,
      lines,
      employee,
      jobRole: role?.name ?? null,
      hourlyRateCents,
      tipDistributionIds,
      leaveTransactionIds: leave.transactionIds,
    });
  }

  return {
    payslips,
    emp201: emp201Totals(payslips),
    warnings,
    employer: {
      legalName: org?.legalName ?? '',
      tradingName: org?.tradingName ?? null,
      payeReference: org?.payeReference ?? null,
      uifReference: org?.uifReference ?? null,
      sdlLiable: org?.sdlLiable ?? false,
    },
  };
}

/** What the API returns for a payslip (no internal row data). */
export function publicPayslip(p: CalculatedPayslip) {
  return {
    employeeId: p.employeeId,
    lines: p.lines,
    grossCents: p.grossCents,
    deductionsCents: p.deductionsCents,
    netCents: p.netCents,
    employerContributionsCents: p.employerContributionsCents,
    employerCostCents: p.employerCostCents,
    etiCents: p.etiCents,
    findings: p.findings,
    ruleVersionKeys: p.ruleVersionKeys,
  };
}



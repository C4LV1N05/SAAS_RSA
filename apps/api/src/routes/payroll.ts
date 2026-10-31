/**
 * Payroll preview: computes payslips and EMP201 values from approved hours without
 * saving anything. Persisted runs (draft -> approved -> finalised) build on this.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, gte, isNull, lt, lte, ne } from 'drizzle-orm';
import { z } from 'zod';
import { loadPublicHolidays, loadRuleSet, schema } from '@saas-rsa/db';
import {
  addDays,
  ageOn,
  buildPayslip,
  emp201Totals,
  localMidnight,
  segmentWork,
  taxYearEnd,
} from '@saas-rsa/domain';
import { requirePermission, tenantTx, type Deps } from '../context';
import { getEmployee, hourlyRateOn, timeIntervals, workProfile } from '../data';
import { HttpError } from '../errors';

const { organisations, tipDistributions, timeEntries } = schema;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Preview = z
  .object({
    employeeIds: z.array(z.string().uuid()).min(1).max(200),
    periodStart: date,
    periodEnd: date,
    payDate: date,
    frequency: z.enum(['weekly', 'fortnightly', 'monthly']),
    perEmployee: z
      .record(
        z.string().uuid(),
        z.object({
          tipsCents: z.number().int().min(0).optional(),
          medicalCover: z.object({ mainMember: z.boolean(), dependants: z.number().int().min(0).max(20) }).optional(),
          etiEmploymentMonth: z.number().int().min(1).max(24).optional(),
        }),
      )
      .default({}),
  })
  .refine((p) => p.periodEnd >= p.periodStart, { message: 'periodEnd must not be before periodStart' });

export function registerPayrollRoutes(app: FastifyInstance, deps: Deps) {
  app.post('/v1/payroll/preview', { preHandler: requirePermission('payroll:run') }, async (request) => {
    const body = Preview.parse(request.body);
    return tenantTx(deps, request, async (tx, auth) => {
      const rules = await loadRuleSet(tx, auth.orgId);
      const publicHolidays = await loadPublicHolidays(tx);
      const [org] = await tx.select().from(organisations).where(eq(organisations.id, auth.orgId));
      const from = localMidnight(body.periodStart);
      const to = localMidnight(addDays(body.periodEnd, 1));

      const payslips = [];
      const warnings: Array<{ employeeId: string; code: string; message: string }> = [];
      for (const employeeId of body.employeeIds) {
        const employee = await getEmployee(tx, employeeId);
        if (!employee.dateOfBirth) {
          throw new HttpError(422, 'missing_date_of_birth', `Employee ${employeeId} has no date of birth (needed for tax rebates)`);
        }
        const extra = body.perEmployee[employeeId] ?? {};

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
          warnings.push({ employeeId, code: 'unapproved_time', message: `${unapproved.length} time entries are not approved and are excluded` });
        }

        const intervals = await timeIntervals(tx, employeeId, from, to, ['approved']);
        const segments = segmentWork(intervals, workProfile(employee), { rules, publicHolidays });

        let tipsCents = extra.tipsCents;
        if (tipsCents === undefined) {
          const tips = await tx
            .select({ amount: tipDistributions.amountCents })
            .from(tipDistributions)
            .where(
              and(
                eq(tipDistributions.employeeId, employeeId),
                gte(tipDistributions.businessDate, body.periodStart),
                lte(tipDistributions.businessDate, body.periodEnd),
                isNull(tipDistributions.payrollRunId),
              ),
            );
          tipsCents = tips.reduce((s, t) => s + t.amount, 0);
        }

        payslips.push(
          buildPayslip({
            employeeId,
            frequency: body.frequency,
            payDate: body.payDate,
            hourlyRateCents: await hourlyRateOn(tx, employeeId, body.periodEnd),
            segments,
            tipsCents,
            age: ageOn(employee.dateOfBirth, taxYearEnd(body.payDate)),
            sdlLiable: org?.sdlLiable ?? false,
            ...(extra.medicalCover ? { medicalCover: extra.medicalCover } : {}),
            ...(extra.etiEmploymentMonth ? { etiEmploymentMonth: extra.etiEmploymentMonth } : {}),
            rules,
          }),
        );
      }
      return { payslips, emp201: emp201Totals(payslips), warnings };
    });
  });
}

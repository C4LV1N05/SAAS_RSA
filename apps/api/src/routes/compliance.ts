import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadPublicHolidays, loadRuleSet } from '@saas-rsa/db';
import { checkEmployeeWeek, DAY_MS, localMidnight, weekStart } from '@saas-rsa/domain';
import { requirePermission, tenantTx, type Deps } from '../context';
import { getEmployee, hourlyRateOn, timeIntervals, workProfile } from '../data';

const EmployeeWeek = z.object({
  employeeId: z.string().uuid(),
  /** Any date in the week; normalised to its Monday. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export function registerComplianceRoutes(app: FastifyInstance, deps: Deps) {
  /** BCEA check on hours actually worked (submitted and approved entries). */
  app.post('/v1/compliance/employee-week', { preHandler: requirePermission('compliance:read') }, async (request) => {
    const body = EmployeeWeek.parse(request.body);
    return tenantTx(deps, request, async (tx, auth) => {
      const week = weekStart(body.date);
      const from = localMidnight(week);
      const to = new Date(from.getTime() + 7 * DAY_MS);
      const employee = await getEmployee(tx, body.employeeId);
      const statuses = ['submitted', 'approved'];
      const intervals = await timeIntervals(tx, employee.id, from, to, statuses);
      const priorIntervals = await timeIntervals(tx, employee.id, new Date(from.getTime() - 2 * DAY_MS), from, statuses);
      const hourlyRateCents = await hourlyRateOn(tx, employee.id, week).catch(() => undefined);
      const result = checkEmployeeWeek({
        intervals,
        priorIntervals,
        profile: workProfile(employee),
        weekStartDate: week,
        rules: await loadRuleSet(tx, auth.orgId),
        publicHolidays: await loadPublicHolidays(tx),
        ...(hourlyRateCents !== undefined ? { hourlyRateCents } : {}),
      });
      return { week, ...result };
    });
  });
}

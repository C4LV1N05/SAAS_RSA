import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';
import { loadPublicHolidays, loadRuleSet, schema } from '@saas-rsa/db';
import {
  checkEmployeeWeek,
  DAY_MS,
  localDate,
  localMidnight,
  weekStart,
  type ComplianceFinding,
  type NotificationJob,
} from '@saas-rsa/domain';
import { requirePermission, tenantTx, type Deps } from '../context';
import { audit, enqueueNotifications, getEmployee, hourlyRateOn, shiftIntervals, workProfile } from '../data';
import { HttpError, notFound } from '../errors';
import { can } from '../permissions';

const { shifts, complianceFindings, employees, users } = schema;

const CreateShift = z
  .object({
    locationId: z.string().uuid(),
    employeeId: z.string().uuid().nullable().default(null),
    jobRoleId: z.string().uuid().nullable().default(null),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    plannedBreakMinutes: z.number().int().min(0).max(180).default(0),
  })
  .refine((s) => s.endsAt > s.startsAt, { message: 'endsAt must be after startsAt', path: ['endsAt'] });

const ListShifts = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  locationId: z.string().uuid().optional(),
});

const Override = z.object({ ruleKey: z.string(), subjectId: z.string(), reason: z.string().min(5).max(500) });
const PublishShifts = z.object({
  shiftIds: z.array(z.string().uuid()).min(1).max(500),
  overrides: z.array(Override).default([]),
});

const UUID = /^[0-9a-f-]{36}$/i;

export function registerShiftRoutes(app: FastifyInstance, deps: Deps) {
  app.post('/v1/shifts', { preHandler: requirePermission('schedule:write') }, async (request, reply) => {
    const body = CreateShift.parse(request.body);
    const shift = await tenantTx(deps, request, async (tx, auth) => {
      const [row] = await tx
        .insert(shifts)
        .values({ ...body, orgId: auth.orgId, status: 'draft' })
        .returning();
      await audit(tx, auth, { action: 'shift.created', entity: 'shift', entityId: row!.id, after: row });
      return row!;
    });
    return reply.status(201).send({ shift });
  });

  app.get('/v1/shifts', { preHandler: requirePermission('schedule:read') }, async (request) => {
    const q = ListShifts.parse(request.query);
    const rows = await tenantTx(deps, request, (tx) =>
      tx
        .select()
        .from(shifts)
        .where(
          and(
            gte(shifts.startsAt, q.from),
            lt(shifts.startsAt, q.to),
            ...(q.locationId ? [eq(shifts.locationId, q.locationId)] : []),
          ),
        )
        .orderBy(asc(shifts.startsAt)),
    );
    return { shifts: rows };
  });

  /**
   * Publish draft shifts. Every affected employee-week is checked against the BCEA
   * first: "block" findings stop the publish unless a manager with
   * compliance:override records a reason for each one.
   */
  app.post('/v1/shifts/publish', { preHandler: requirePermission('schedule:publish') }, async (request) => {
    const body = PublishShifts.parse(request.body);
    const auth = request.auth!;
    if (body.overrides.length > 0 && !can(auth.role, 'compliance:override')) {
      throw new HttpError(403, 'forbidden', 'Your role cannot override compliance findings');
    }

    const result = await tenantTx(deps, request, async (tx) => {
      const targets = await tx.select().from(shifts).where(inArray(shifts.id, body.shiftIds));
      if (targets.length !== new Set(body.shiftIds).size) throw notFound('One or more shifts');
      const notDraft = targets.filter((s) => s.status !== 'draft');
      if (notDraft.length) throw new HttpError(409, 'not_draft', `Shifts already ${notDraft[0]!.status}`, { ids: notDraft.map((s) => s.id) });

      const rules = await loadRuleSet(tx, auth.orgId);
      const publicHolidays = await loadPublicHolidays(tx);
      const drafts = new Set(body.shiftIds);

      // Group by employee and week.
      const groups = new Map<string, { employeeId: string; week: string }>();
      for (const s of targets) {
        if (!s.employeeId) continue; // open shifts have no one to check yet
        const week = weekStart(localDate(s.startsAt));
        groups.set(`${s.employeeId}:${week}`, { employeeId: s.employeeId, week });
      }

      const findings: Array<ComplianceFinding & { employeeId: string; week: string }> = [];
      for (const { employeeId, week } of groups.values()) {
        const employee = await getEmployee(tx, employeeId);
        const from = localMidnight(week);
        const to = new Date(from.getTime() + 7 * DAY_MS);
        const intervals = await shiftIntervals(tx, employeeId, from, to, drafts);
        const priorIntervals = await shiftIntervals(tx, employeeId, new Date(from.getTime() - 2 * DAY_MS), from);
        const hourlyRateCents = await hourlyRateOn(tx, employeeId, week).catch(() => undefined);
        const check = checkEmployeeWeek({
          intervals,
          priorIntervals,
          profile: workProfile(employee),
          weekStartDate: week,
          rules,
          publicHolidays,
          ...(hourlyRateCents !== undefined ? { hourlyRateCents } : {}),
        });
        findings.push(...check.findings.map((f) => ({ ...f, employeeId, week })));
      }

      const overrideFor = (f: ComplianceFinding) =>
        body.overrides.find((o) => o.ruleKey === f.ruleKey && o.subjectId === f.subjectId);
      const unresolved = findings.filter((f) => f.severity === 'block' && !overrideFor(f));
      if (unresolved.length) {
        throw new HttpError(422, 'compliance_blocked', 'Publishing would breach the BCEA', { findings: unresolved });
      }

      const now = new Date();
      await tx.update(shifts).set({ status: 'published', publishedAt: now }).where(inArray(shifts.id, body.shiftIds));

      if (findings.length) {
        await tx.insert(complianceFindings).values(
          findings.map((f) => {
            const override = overrideFor(f);
            const isShift = UUID.test(f.subjectId) && drafts.has(f.subjectId);
            return {
              orgId: auth.orgId,
              ruleKey: f.ruleKey,
              severity: f.severity,
              subjectType: isShift ? 'shift' : 'employee_week',
              subjectId: isShift ? f.subjectId : f.employeeId,
              message: f.message,
              data: { ...(f.data ?? {}), week: f.week, mode: 'schedule' },
              overriddenBy: override ? auth.userId : null,
              overrideReason: override?.reason ?? null,
            };
          }),
        );
      }
      await audit(tx, auth, {
        action: 'shifts.published',
        entity: 'shift',
        after: { shiftIds: body.shiftIds, overrides: body.overrides },
      });

      // Who to tell: employees with a linked user. Queued in this transaction.
      const employeeIds = [...new Set(targets.map((s) => s.employeeId).filter((x): x is string => !!x))];
      const recipients = employeeIds.length
        ? await tx
            .select({ employeeId: employees.id, userId: users.id, phone: users.phoneE164, name: users.displayName })
            .from(employees)
            .innerJoin(users, eq(users.id, employees.userId))
            .where(inArray(employees.id, employeeIds))
        : [];
      const batchKey = createHash('sha256').update([...body.shiftIds].sort().join(',')).digest('hex').slice(0, 16);
      const jobs: NotificationJob[] = recipients.map((r) => ({
        orgId: auth.orgId,
        recipient: { employeeId: r.employeeId, userId: r.userId, ...(r.phone ? { phoneE164: r.phone } : {}), displayName: r.name },
        template: 'schedule_published',
        params: { shifts: targets.filter((s) => s.employeeId === r.employeeId).length },
        channels: ['whatsapp', 'sms'],
        dedupeKey: `schedule_published:${r.employeeId}:${batchKey}`,
      }));
      const notified = await enqueueNotifications(tx, jobs);
      return { findings, notified };
    });

    return { published: body.shiftIds.length, findings: result.findings, notified: result.notified };
  });
}

/**
 * Read endpoints behind the manager and staff screens: the team at a location,
 * timesheets for approval, an employee's own day ("me"), and tip pools.
 * RLS still decides what each role sees: an employee asking for the team gets
 * only themselves, and pay rates come back null for roles that cannot read them.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Tx } from '@saas-rsa/db';
import { addDays, localDate, localMidnight, workedMinutes } from '@saas-rsa/domain';
import { requirePermission, tenantTx, type Deps } from '../context';
import { audit } from '../data';
import { HttpError } from '../errors';

const { employees, jobRoles, payRates, shifts, timeEntries, timeEntryBreaks, tipPools, shiftTips, tipDistributions } = schema;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LocationQuery = z.object({ locationId: z.string().uuid() });
const TimeQuery = z.object({
  locationId: z.string().uuid(),
  from: date,
  to: date,
  status: z.enum(['open', 'submitted', 'approved', 'rejected']).optional(),
});
const TipDayQuery = z.object({ locationId: z.string().uuid(), businessDate: date });
const CreatePool = z.object({
  locationId: z.string().uuid(),
  name: z.string().min(2).max(80),
  strategy: z.enum(['group_split_hours', 'hours_weighted', 'points', 'individual']),
  groups: z.object({ foh: z.number().min(0).max(1), boh: z.number().min(0).max(1) }).optional(),
  effectiveFrom: date.optional(),
});

type EntryRow = typeof timeEntries.$inferSelect;

/** Entries with their breaks and worked minutes (open entries count up to now). */
async function withBreaks(tx: Tx, rows: EntryRow[]) {
  const breaks = rows.length
    ? await tx.select().from(timeEntryBreaks).where(inArray(timeEntryBreaks.timeEntryId, rows.map((r) => r.id))).orderBy(asc(timeEntryBreaks.startsAt))
    : [];
  return rows.map((r) => {
    const own = breaks.filter((b) => b.timeEntryId === r.id);
    const closed = own.filter((b) => b.endsAt).map((b) => ({ start: b.startsAt, end: b.endsAt!, paid: b.paid }));
    const minutes = workedMinutes({ id: r.id, start: r.clockIn, end: r.clockOut ?? new Date(), breaks: closed });
    return {
      id: r.id,
      employeeId: r.employeeId,
      locationId: r.locationId,
      shiftId: r.shiftId,
      clockIn: r.clockIn,
      clockOut: r.clockOut,
      status: r.status,
      method: r.method,
      capturedOffline: r.capturedOffline,
      editReason: r.editReason,
      approvedAt: r.approvedAt,
      workedMinutes: minutes,
      breaks: own.map((b) => ({ id: b.id, startsAt: b.startsAt, endsAt: b.endsAt, paid: b.paid })),
    };
  });
}

export function registerWorkforceRoutes(app: FastifyInstance, deps: Deps) {
  /** Employees whose home is this location, with job role and current hourly rate. */
  app.get('/v1/team', { preHandler: requirePermission('schedule:read') }, async (request) => {
    const { locationId } = LocationQuery.parse(request.query);
    return tenantTx(deps, request, async (tx) => {
      const today = localDate(new Date());
      const rows = await tx
        .select({ employee: employees, roleName: jobRoles.name, tipGroup: jobRoles.tipGroup })
        .from(employees)
        .leftJoin(jobRoles, eq(jobRoles.id, employees.jobRoleId))
        .where(
          and(
            eq(employees.homeLocationId, locationId),
            or(isNull(employees.employmentEnd), gte(employees.employmentEnd, today)),
          ),
        )
        .orderBy(asc(employees.firstName), asc(employees.lastName));
      const rates = rows.length
        ? await tx
            .select()
            .from(payRates)
            .where(and(inArray(payRates.employeeId, rows.map((r) => r.employee.id)), lte(payRates.effectiveFrom, today)))
            .orderBy(desc(payRates.effectiveFrom))
        : [];
      const roles = await tx.select().from(jobRoles).orderBy(asc(jobRoles.name));
      return {
        employees: rows.map(({ employee: e, roleName, tipGroup }) => {
          const rate = rates.find((r) => r.employeeId === e.id);
          return {
            id: e.id,
            firstName: e.firstName,
            lastName: e.lastName,
            jobRoleId: e.jobRoleId,
            jobRole: roleName,
            tipGroup,
            hasLogin: e.userId !== null,
            hasDateOfBirth: e.dateOfBirth !== null,
            hasIdNumber: e.idNumberHint !== null,
            hasTaxNumber: e.taxNumberHint !== null,
            hasBankDetails: e.bankAccountHint !== null,
            daysPerWeek: e.daysPerWeek,
            overtimeAgreement: e.overtimeAgreement,
            rate: rate ? { type: rate.rateType, cents: rate.rateCents } : null,
          };
        }),
        jobRoles: roles.map((r) => ({ id: r.id, name: r.name, tipGroup: r.tipGroup })),
      };
    });
  });

  /** Time entries clocked in at a location between two dates (inclusive). */
  app.get('/v1/time', { preHandler: requirePermission('time:approve') }, async (request) => {
    const q = TimeQuery.parse(request.query);
    if (q.to < q.from) throw new HttpError(400, 'invalid_range', '"to" must not be before "from"');
    return tenantTx(deps, request, async (tx) => {
      const rows = await tx
        .select()
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.locationId, q.locationId),
            gte(timeEntries.clockIn, localMidnight(q.from)),
            lt(timeEntries.clockIn, localMidnight(addDays(q.to, 1))),
            ...(q.status ? [eq(timeEntries.status, q.status)] : [ne(timeEntries.status, 'rejected')]),
          ),
        )
        .orderBy(asc(timeEntries.clockIn));
      const planned = rows.some((r) => r.shiftId)
        ? await tx
            .select({ id: shifts.id, startsAt: shifts.startsAt, endsAt: shifts.endsAt })
            .from(shifts)
            .where(inArray(shifts.id, rows.map((r) => r.shiftId).filter((x): x is string => !!x)))
        : [];
      const entries = await withBreaks(tx, rows);
      return { entries: entries.map((e) => ({ ...e, shift: planned.find((s) => s.id === e.shiftId) ?? null })) };
    });
  });

  /**
   * The signed-in person's own day: their employee record, any open clock entry,
   * published shifts for the next two weeks and the last week's entries.
   */
  app.get('/v1/me', { preHandler: requirePermission('time:clock') }, async (request) => {
    return tenantTx(deps, request, async (tx, auth) => {
      const [employee] = await tx.select().from(employees).where(eq(employees.userId, auth.userId));
      if (!employee) return { employee: null, openEntry: null, shifts: [], recentEntries: [] };

      const now = new Date();
      const [open] = await tx
        .select()
        .from(timeEntries)
        .where(and(eq(timeEntries.employeeId, employee.id), isNull(timeEntries.clockOut)))
        .limit(1);
      const upcoming = await tx
        .select()
        .from(shifts)
        .where(
          and(
            eq(shifts.employeeId, employee.id),
            eq(shifts.status, 'published'),
            gte(shifts.endsAt, new Date(now.getTime() - 12 * 3_600_000)),
            lt(shifts.startsAt, new Date(now.getTime() + 14 * 86_400_000)),
          ),
        )
        .orderBy(asc(shifts.startsAt));
      const recent = await tx
        .select()
        .from(timeEntries)
        .where(and(eq(timeEntries.employeeId, employee.id), isNotNull(timeEntries.clockOut), gte(timeEntries.clockIn, new Date(now.getTime() - 7 * 86_400_000))))
        .orderBy(desc(timeEntries.clockIn))
        .limit(14);
      const [openWithBreaks] = open ? await withBreaks(tx, [open]) : [];
      return {
        employee: { id: employee.id, firstName: employee.firstName, lastName: employee.lastName, locationId: employee.homeLocationId },
        openEntry: openWithBreaks ?? null,
        shifts: upcoming.map((s) => ({ id: s.id, locationId: s.locationId, startsAt: s.startsAt, endsAt: s.endsAt, plannedBreakMinutes: s.plannedBreakMinutes })),
        recentEntries: await withBreaks(tx, recent),
      };
    });
  });

  /** Start or end a break on the caller's open entry. */
  app.post('/v1/me/break', { preHandler: requirePermission('time:clock') }, async (request) => {
    const { action } = z.object({ action: z.enum(['start', 'end']) }).parse(request.body);
    return tenantTx(deps, request, async (tx, auth) => {
      const [employee] = await tx.select({ id: employees.id }).from(employees).where(eq(employees.userId, auth.userId));
      if (!employee) throw new HttpError(404, 'no_employee_record', 'Your login is not linked to an employee record');
      const [open] = await tx.select().from(timeEntries).where(and(eq(timeEntries.employeeId, employee.id), isNull(timeEntries.clockOut))).limit(1);
      if (!open) throw new HttpError(409, 'not_clocked_in', 'Clock in before starting a break');
      const [running] = await tx
        .select()
        .from(timeEntryBreaks)
        .where(and(eq(timeEntryBreaks.timeEntryId, open.id), isNull(timeEntryBreaks.endsAt)))
        .limit(1);
      const now = new Date();
      if (action === 'start') {
        if (running) return { break: running, replayed: true };
        const [row] = await tx.insert(timeEntryBreaks).values({ orgId: auth.orgId, timeEntryId: open.id, startsAt: now, endsAt: null, paid: false }).returning();
        return { break: row!, replayed: false };
      }
      if (!running) throw new HttpError(409, 'no_break_running', 'There is no break to end');
      const [row] = await tx.update(timeEntryBreaks).set({ endsAt: now }).where(eq(timeEntryBreaks.id, running.id)).returning();
      return { break: row!, replayed: false };
    });
  });

  app.get('/v1/tips/pools', { preHandler: requirePermission('tips:manage') }, async (request) => {
    const { locationId } = LocationQuery.parse(request.query);
    const pools = await tenantTx(deps, request, (tx) =>
      tx.select().from(tipPools).where(eq(tipPools.locationId, locationId)).orderBy(asc(tipPools.name), desc(tipPools.effectiveFrom)),
    );
    return { pools };
  });

  app.post('/v1/tips/pools', { preHandler: requirePermission('tips:manage') }, async (request, reply) => {
    const body = CreatePool.parse(request.body);
    if (body.strategy === 'group_split_hours') {
      const g = body.groups;
      if (!g || Math.abs(g.foh + g.boh - 1) > 0.0001) {
        throw new HttpError(400, 'invalid_groups', 'Front and back of house shares must add up to 100%');
      }
    }
    const pool = await tenantTx(deps, request, async (tx, auth) => {
      const [row] = await tx
        .insert(tipPools)
        .values({
          orgId: auth.orgId,
          locationId: body.locationId,
          name: body.name,
          strategy: body.strategy,
          config: body.groups ? { groups: body.groups } : {},
          effectiveFrom: body.effectiveFrom ?? localDate(new Date()),
        })
        .returning();
      await audit(tx, auth, { action: 'tip_pool.created', entity: 'tip_pool', entityId: row!.id, after: row });
      return row!;
    });
    return reply.status(201).send({ pool });
  });

  /** A day's declared tips and any distributions already recorded. */
  app.get('/v1/tips', { preHandler: requirePermission('tips:manage') }, async (request) => {
    const q = TipDayQuery.parse(request.query);
    return tenantTx(deps, request, async (tx) => {
      const declared = await tx
        .select()
        .from(shiftTips)
        .where(and(eq(shiftTips.locationId, q.locationId), eq(shiftTips.businessDate, q.businessDate)))
        .orderBy(asc(shiftTips.declaredAt));
      const pools = await tx.select({ id: tipPools.id }).from(tipPools).where(eq(tipPools.locationId, q.locationId));
      const distributed = pools.length
        ? await tx
            .select()
            .from(tipDistributions)
            .where(and(inArray(tipDistributions.tipPoolId, pools.map((p) => p.id)), eq(tipDistributions.businessDate, q.businessDate)))
        : [];
      return { declared, distributed };
    });
  });
}

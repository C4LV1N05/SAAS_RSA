/**
 * Leave: balances, requests (staff ask from their phone; managers can log leave
 * for anyone), approval, and adjustments such as opening balances. Approving a
 * request writes a 'taken' row to the leave ledger, which the next payroll run
 * pays as leave pay.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type TenantContext, type Tx } from '@saas-rsa/db';
import { addDays, dailyMinutes, daysInRange, localDate, needsMedicalCertificate } from '@saas-rsa/domain';
import { requireAnyPermission, requirePermission, tenantTx, type Deps } from '../context';
import { audit, getEmployee } from '../data';
import { HttpError, notFound } from '../errors';
import { can } from '../permissions';
import { LEAVE_LABEL, leaveBalances, profileOf } from '../leave-pay';

const { leaveRequests, leaveTransactions, employees } = schema;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LeaveType = z.enum(['annual', 'sick', 'family_responsibility']);
const RequestBody = z
  .object({
    employeeId: z.string().uuid().optional(),
    leaveType: LeaveType,
    startsOn: date,
    endsOn: date,
    /** Working days away; defaults to every day in the range. Half days allowed. */
    days: z.number().min(0.5).max(60).multipleOf(0.5).optional(),
    reason: z.string().max(500).optional(),
  })
  .refine((b) => b.endsOn >= b.startsOn, { message: 'The leave must end on or after the day it starts', path: ['endsOn'] });

const Decide = z.object({ note: z.string().max(500).optional() });
const Adjust = z.object({
  employeeId: z.string().uuid(),
  leaveType: LeaveType,
  /** Positive adds leave (e.g. an opening balance), negative removes it. */
  minutes: z.number().int().min(-100_000).max(100_000).refine((m) => m !== 0),
  reason: z.string().min(5).max(500),
});

async function myEmployeeId(tx: Tx, auth: TenantContext): Promise<string> {
  const [e] = await tx.select({ id: employees.id }).from(employees).where(eq(employees.userId, auth.userId));
  if (!e) throw new HttpError(404, 'no_employee_record', 'Your login is not linked to an employee record');
  return e.id;
}

/** Sick absences in the eight weeks before a date, for the medical certificate rule (BCEA s23). */
async function recentSickAbsences(tx: Tx, employeeId: string, before: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.employeeId, employeeId),
        eq(leaveRequests.leaveType, 'sick'),
        inArray(leaveRequests.status, ['requested', 'approved']),
        gte(leaveRequests.startsOn, addDays(before, -56)),
        lte(leaveRequests.startsOn, before),
      ),
    );
  return row?.n ?? 0;
}

async function createRequest(tx: Tx, auth: TenantContext, employeeId: string, body: z.infer<typeof RequestBody>) {
  const e = await getEmployee(tx, employeeId);
  const range = daysInRange(body.startsOn, body.endsOn);
  const days = Math.min(body.days ?? range, range);
  const minutes = Math.round(days * dailyMinutes(profileOf(e)));
  const balances = await leaveBalances(tx, e, localDate(new Date()));
  const balance = balances.find((b) => b.type === body.leaveType)!;
  const warnings: string[] = [];
  if (minutes > balance.availableMinutes) {
    warnings.push(`${LEAVE_LABEL[body.leaveType]} available is less than this request; a manager can still approve it as unpaid or adjust the balance.`);
  }
  const certificate = body.leaveType === 'sick' && needsMedicalCertificate(days, await recentSickAbsences(tx, employeeId, body.startsOn));
  const [row] = await tx
    .insert(leaveRequests)
    .values({
      orgId: auth.orgId,
      employeeId,
      leaveType: body.leaveType,
      startsOn: body.startsOn,
      endsOn: body.endsOn,
      minutes,
      reason: body.reason ?? null,
      requestedBy: auth.userId,
      medicalCertificateRequired: certificate,
    })
    .returning();
  return { request: row!, warnings };
}

export function registerLeaveRoutes(app: FastifyInstance, deps: Deps) {
  /** Balances for one employee (managers) or yourself (anyone with an employee record). */
  app.get('/v1/leave/balances', { preHandler: requireAnyPermission('time:clock', 'time:approve', 'payroll:run') }, async (request) => {
    const { employeeId } = z.object({ employeeId: z.string().uuid().optional() }).parse(request.query);
    return tenantTx(deps, request, async (tx, auth) => {
      const id = employeeId ?? (await myEmployeeId(tx, auth));
      const e = await getEmployee(tx, id); // RLS: employees only find themselves
      return { employeeId: id, balances: await leaveBalances(tx, e, localDate(new Date())) };
    });
  });

  /** Balances for everyone at a location, for the manager's leave screen. */
  app.get('/v1/leave/team-balances', { preHandler: requireAnyPermission('time:approve', 'payroll:run') }, async (request) => {
    const { locationId } = z.object({ locationId: z.string().uuid() }).parse(request.query);
    return tenantTx(deps, request, async (tx) => {
      const team = await tx.select().from(employees).where(eq(employees.homeLocationId, locationId)).orderBy(asc(employees.firstName));
      const today = localDate(new Date());
      return {
        employees: await Promise.all(
          team
            .filter((e) => !e.employmentEnd || e.employmentEnd >= today)
            .map(async (e) => ({ employeeId: e.id, name: `${e.firstName} ${e.lastName}`, balances: await leaveBalances(tx, e, today) })),
        ),
      };
    });
  });

  app.post('/v1/leave/requests', { preHandler: requirePermission('time:clock') }, async (request, reply) => {
    const body = RequestBody.parse(request.body);
    const result = await tenantTx(deps, request, async (tx, auth) => {
      const own = await myEmployeeId(tx, auth).catch(() => null);
      const employeeId = body.employeeId ?? own;
      if (!employeeId) throw new HttpError(404, 'no_employee_record', 'Your login is not linked to an employee record');
      if (employeeId !== own && !can(auth.role, 'time:approve')) throw new HttpError(403, 'forbidden', 'You can only ask for your own leave');
      return createRequest(tx, auth, employeeId, body);
    });
    return reply.status(201).send(result);
  });

  /** Requests to decide, and approved leave coming up, at a location (or your own). */
  app.get('/v1/leave/requests', { preHandler: requireAnyPermission('time:clock', 'time:approve') }, async (request) => {
    const q = z
      .object({ locationId: z.string().uuid().optional(), from: date.optional(), to: date.optional(), status: z.enum(['requested', 'approved', 'declined', 'cancelled']).optional() })
      .parse(request.query);
    return tenantTx(deps, request, async (tx, auth) => {
      const manager = can(auth.role, 'time:approve');
      const rows = await tx
        .select({ request: leaveRequests, firstName: employees.firstName, lastName: employees.lastName, locationId: employees.homeLocationId })
        .from(leaveRequests)
        .innerJoin(employees, eq(employees.id, leaveRequests.employeeId))
        .where(
          and(
            ...(manager && q.locationId ? [eq(employees.homeLocationId, q.locationId)] : []),
            ...(manager ? [] : [sql`${leaveRequests.employeeId} = app.current_employee_id()`]),
            ...(q.status ? [eq(leaveRequests.status, q.status)] : []),
            ...(q.from ? [gte(leaveRequests.endsOn, q.from)] : []),
            ...(q.to ? [lte(leaveRequests.startsOn, q.to)] : []),
          ),
        )
        .orderBy(desc(leaveRequests.startsOn))
        .limit(200);
      return { requests: rows.map((r) => ({ ...r.request, employeeName: `${r.firstName} ${r.lastName}` })) };
    });
  });

  app.post('/v1/leave/requests/:id/approve', { preHandler: requirePermission('time:approve') }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { note } = Decide.parse(request.body ?? {});
    return tenantTx(deps, request, async (tx, auth) => {
      const [req] = await tx.select().from(leaveRequests).where(eq(leaveRequests.id, id));
      if (!req) throw notFound('Leave request');
      if (req.status !== 'requested') throw new HttpError(409, 'already_decided', `This request is ${req.status}`);
      if (req.employeeId === (await myEmployeeId(tx, auth).catch(() => null))) {
        throw new HttpError(403, 'own_request', 'Someone else needs to approve your own leave');
      }
      const [updated] = await tx
        .update(leaveRequests)
        .set({ status: 'approved', decidedBy: auth.userId, decidedAt: new Date(), decisionNote: note ?? null })
        .where(eq(leaveRequests.id, id))
        .returning();
      await tx.insert(leaveTransactions).values({
        orgId: auth.orgId,
        employeeId: req.employeeId,
        leaveType: req.leaveType,
        minutes: -req.minutes,
        reason: `${LEAVE_LABEL[req.leaveType as keyof typeof LEAVE_LABEL]} ${req.startsOn} to ${req.endsOn}`,
        occurredOn: req.startsOn,
        source: 'taken',
        leaveRequestId: id,
        createdBy: auth.userId,
      });
      await audit(tx, auth, { action: 'leave.approved', entity: 'leave_request', entityId: id });
      return { request: updated };
    });
  });

  app.post('/v1/leave/requests/:id/decline', { preHandler: requirePermission('time:approve') }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { note } = Decide.parse(request.body ?? {});
    return tenantTx(deps, request, async (tx, auth) => {
      const [updated] = await tx
        .update(leaveRequests)
        .set({ status: 'declined', decidedBy: auth.userId, decidedAt: new Date(), decisionNote: note ?? null })
        .where(and(eq(leaveRequests.id, id), eq(leaveRequests.status, 'requested')))
        .returning();
      if (!updated) throw new HttpError(409, 'already_decided', 'This request was already decided or does not exist');
      await audit(tx, auth, { action: 'leave.declined', entity: 'leave_request', entityId: id });
      return { request: updated };
    });
  });

  /** Withdraw a request. Approved leave can be cancelled until payroll has paid it. */
  app.post('/v1/leave/requests/:id/cancel', { preHandler: requirePermission('time:clock') }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return tenantTx(deps, request, async (tx, auth) => {
      const [req] = await tx.select().from(leaveRequests).where(eq(leaveRequests.id, id));
      if (!req) throw notFound('Leave request');
      const own = req.employeeId === (await myEmployeeId(tx, auth).catch(() => null));
      if (!own && !can(auth.role, 'time:approve')) throw new HttpError(403, 'forbidden', 'You can only cancel your own leave');
      if (req.status === 'declined' || req.status === 'cancelled') throw new HttpError(409, 'already_closed', `This request is ${req.status}`);
      if (req.status === 'approved') {
        const [paid] = await tx.select({ id: leaveTransactions.id, run: leaveTransactions.payrollRunId }).from(leaveTransactions).where(eq(leaveTransactions.leaveRequestId, id));
        if (paid?.run) throw new HttpError(409, 'already_paid', 'This leave was paid in a payroll run; ask payroll to adjust the balance instead');
        if (own && !can(auth.role, 'time:approve')) {
          // Staff can withdraw requests, but approved leave is cancelled by a manager.
          throw new HttpError(403, 'ask_manager', 'This leave is approved. Ask your manager to cancel it.');
        }
        await tx.delete(leaveTransactions).where(eq(leaveTransactions.leaveRequestId, id));
      }
      const [updated] = await tx.update(leaveRequests).set({ status: 'cancelled', decidedBy: auth.userId, decidedAt: new Date() }).where(eq(leaveRequests.id, id)).returning();
      await audit(tx, auth, { action: 'leave.cancelled', entity: 'leave_request', entityId: id });
      return { request: updated };
    });
  });

  /** Opening balances and corrections. Owners and payroll admins only (RLS too). */
  app.post('/v1/leave/adjustments', { preHandler: requirePermission('payroll:run') }, async (request, reply) => {
    const body = Adjust.parse(request.body);
    const row = await tenantTx(deps, request, async (tx, auth) => {
      await getEmployee(tx, body.employeeId);
      const [r] = await tx
        .insert(leaveTransactions)
        .values({ orgId: auth.orgId, employeeId: body.employeeId, leaveType: body.leaveType, minutes: body.minutes, reason: body.reason, occurredOn: localDate(new Date()), source: 'adjustment', createdBy: auth.userId })
        .returning();
      await audit(tx, auth, { action: 'leave.adjusted', entity: 'employee', entityId: body.employeeId, after: body });
      return r!;
    });
    return reply.status(201).send({ adjustment: row });
  });
}

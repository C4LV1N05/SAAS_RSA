import type { FastifyInstance } from 'fastify';
import { and, eq, gte, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@saas-rsa/db';
import {
  addDays,
  distributeTips,
  localMidnight,
  workedMinutes,
  type TipGroup,
  type TipParticipant,
  type TipPoolConfig,
  type TipStrategy,
} from '@saas-rsa/domain';
import { requirePermission, tenantTx, type Deps } from '../context';
import { audit } from '../data';
import { HttpError, notFound } from '../errors';

const { shiftTips, tipPools, tipDistributions, timeEntries, timeEntryBreaks, employees, jobRoles } = schema;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const Declare = z.object({
  locationId: z.string().uuid(),
  businessDate: date,
  source: z.enum(['cash', 'card', 'service_charge_passed_on']),
  amountCents: z.number().int().min(1).max(100_000_000),
  employeeId: z.string().uuid().optional(),
  posReference: z.string().max(100).optional(),
});

const Distribute = z.object({
  tipPoolId: z.string().uuid(),
  businessDate: date,
  commit: z.boolean().default(false),
});

export function registerTipRoutes(app: FastifyInstance, deps: Deps) {
  app.post('/v1/tips/declare', { preHandler: requirePermission('tips:manage') }, async (request, reply) => {
    const body = Declare.parse(request.body);
    const tip = await tenantTx(deps, request, async (tx, auth) => {
      const [row] = await tx
        .insert(shiftTips)
        .values({ ...body, employeeId: body.employeeId ?? null, posReference: body.posReference ?? null, orgId: auth.orgId, declaredBy: auth.userId })
        .returning();
      return row!;
    });
    return reply.status(201).send({ tip });
  });

  /**
   * Distribute a day's pooled tips by the pool's strategy, from approved hours.
   * commit=false previews; commit=true records the distribution (once per day).
   */
  app.post('/v1/tips/distribute', { preHandler: requirePermission('tips:manage') }, async (request) => {
    const body = Distribute.parse(request.body);
    return tenantTx(deps, request, async (tx, auth) => {
      const [pool] = await tx.select().from(tipPools).where(eq(tipPools.id, body.tipPoolId));
      if (!pool) throw notFound('Tip pool');
      const strategy = pool.strategy as TipStrategy;

      const tips = await tx
        .select()
        .from(shiftTips)
        .where(and(eq(shiftTips.locationId, pool.locationId), eq(shiftTips.businessDate, body.businessDate)));
      const pooled = tips.filter((t) => !t.employeeId);
      const poolCents = pooled.reduce((s, t) => s + t.amountCents, 0);

      const from = localMidnight(body.businessDate);
      const to = localMidnight(addDays(body.businessDate, 1));
      const entries = await tx
        .select({ entry: timeEntries, tipGroup: jobRoles.tipGroup, tipPoints: jobRoles.tipPoints })
        .from(timeEntries)
        .innerJoin(employees, eq(employees.id, timeEntries.employeeId))
        .leftJoin(jobRoles, eq(jobRoles.id, employees.jobRoleId))
        .where(
          and(
            eq(timeEntries.locationId, pool.locationId),
            eq(timeEntries.status, 'approved'),
            isNotNull(timeEntries.clockOut),
            gte(timeEntries.clockIn, from),
            lt(timeEntries.clockIn, to),
          ),
        );
      const breaks = entries.length
        ? await tx.select().from(timeEntryBreaks).where(and(inArray(timeEntryBreaks.timeEntryId, entries.map((e) => e.entry.id)), isNotNull(timeEntryBreaks.endsAt)))
        : [];

      const byEmployee = new Map<string, TipParticipant>();
      for (const { entry, tipGroup, tipPoints } of entries) {
        const minutes = workedMinutes({
          id: entry.id,
          start: entry.clockIn,
          end: entry.clockOut!,
          breaks: breaks.filter((b) => b.timeEntryId === entry.id).map((b) => ({ start: b.startsAt, end: b.endsAt!, paid: b.paid })),
        });
        const p = byEmployee.get(entry.employeeId) ?? {
          employeeId: entry.employeeId,
          minutesWorked: 0,
          group: (tipGroup ?? 'foh') as TipGroup,
          points: Number(tipPoints ?? 1),
        };
        p.minutesWorked += minutes;
        byEmployee.set(entry.employeeId, p);
      }
      if (strategy === 'individual') {
        for (const t of tips.filter((t) => t.employeeId)) {
          const p = byEmployee.get(t.employeeId!) ?? { employeeId: t.employeeId!, minutesWorked: 0, group: 'foh' as TipGroup };
          p.declaredCents = (p.declaredCents ?? 0) + t.amountCents;
          byEmployee.set(t.employeeId!, p);
        }
      }

      const shares = distributeTips({
        poolCents: strategy === 'individual' ? 0 : poolCents,
        strategy,
        participants: [...byEmployee.values()],
        config: pool.config as TipPoolConfig,
      }).filter((s) => s.amountCents > 0);

      if (body.commit) {
        if (shares.length === 0) throw new HttpError(422, 'nothing_to_distribute', 'No tips or no approved hours for this day');
        const [already] = await tx
          .select({ id: tipDistributions.id })
          .from(tipDistributions)
          .where(and(eq(tipDistributions.tipPoolId, pool.id), eq(tipDistributions.businessDate, body.businessDate), isNull(tipDistributions.payrollRunId)))
          .limit(1);
        if (already) throw new HttpError(409, 'already_distributed', 'Tips for this pool and day were already distributed');
        await tx.insert(tipDistributions).values(
          shares.map((s) => ({
            orgId: auth.orgId,
            tipPoolId: pool.id,
            businessDate: body.businessDate,
            employeeId: s.employeeId,
            amountCents: s.amountCents,
            basis: s.basis,
          })),
        );
        await audit(tx, auth, { action: 'tips.distributed', entity: 'tip_pool', entityId: pool.id, after: { businessDate: body.businessDate, shares } });
      }
      return { poolCents, strategy, committed: body.commit, shares };
    });
  });
}

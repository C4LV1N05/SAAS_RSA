/**
 * Manager Log Book. Entries are never updated: a correction is a new revision row,
 * and every row is hash-chained to the previous one at its location, so the chain
 * proves nothing was edited or removed after the fact.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type TenantContext, type Tx } from '@saas-rsa/db';
import { computeLogHash, GENESIS_HASH, verifyChain, type ChainedEntry, type LogHashInput } from '@saas-rsa/domain';
import { requirePermission, tenantTx, type Deps } from '../context';
import { notFound } from '../errors';

const { managerLogs, logAcknowledgements, users } = schema;

const Category = z.enum(['handover', 'maintenance', 'incident', 'disciplinary', 'note']);
const Attachments = z.array(z.object({ url: z.string().url(), name: z.string().max(200) })).max(20).default([]);

const CreateEntry = z.object({
  locationId: z.string().uuid(),
  category: Category,
  body: z.string().min(1).max(10_000),
  requiresAck: z.boolean().default(false),
  shiftId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),
  attachments: Attachments,
});

const Revise = z.object({ body: z.string().min(1).max(10_000), attachments: Attachments.optional() });
const LocationQuery = z.object({ locationId: z.string().uuid(), limit: z.coerce.number().int().min(1).max(200).default(50) });

type LogRow = typeof managerLogs.$inferSelect;

const toHashInput = (r: LogRow): LogHashInput => ({
  orgId: r.orgId,
  locationId: r.locationId,
  entryGroupId: r.entryGroupId,
  revision: r.revision,
  seq: r.seq,
  authorUserId: r.authorUserId,
  category: r.category,
  body: r.body,
  attachments: r.attachments,
  shiftId: r.shiftId,
  employeeId: r.employeeId,
  createdAt: r.createdAt.toISOString(),
});

/** Append one row to a location's chain. The advisory lock serialises writers per location. */
async function appendEntry(
  tx: Tx,
  auth: TenantContext,
  entry: Omit<LogHashInput, 'seq' | 'createdAt' | 'orgId' | 'authorUserId'> & { requiresAck: boolean },
): Promise<LogRow> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${entry.locationId}, 0))`);
  const [last] = await tx
    .select({ seq: managerLogs.seq, hash: managerLogs.hash })
    .from(managerLogs)
    .where(eq(managerLogs.locationId, entry.locationId))
    .orderBy(desc(managerLogs.seq))
    .limit(1);
  const createdAt = new Date();
  const input: LogHashInput = {
    orgId: auth.orgId,
    locationId: entry.locationId,
    entryGroupId: entry.entryGroupId,
    revision: entry.revision,
    seq: (last?.seq ?? 0) + 1,
    authorUserId: auth.userId,
    category: entry.category,
    body: entry.body,
    attachments: entry.attachments,
    shiftId: entry.shiftId,
    employeeId: entry.employeeId,
    createdAt: createdAt.toISOString(),
  };
  const prevHash = last?.hash ?? GENESIS_HASH;
  const [row] = await tx
    .insert(managerLogs)
    .values({ ...input, createdAt, requiresAck: entry.requiresAck, prevHash, hash: computeLogHash(prevHash, input) })
    .returning();
  return row!;
}

export function registerLogbookRoutes(app: FastifyInstance, deps: Deps) {
  app.post('/v1/logbook', { preHandler: requirePermission('logbook:write') }, async (request, reply) => {
    const body = CreateEntry.parse(request.body);
    const entry = await tenantTx(deps, request, (tx, auth) =>
      appendEntry(tx, auth, {
        locationId: body.locationId,
        entryGroupId: crypto.randomUUID(),
        revision: 1,
        category: body.category,
        body: body.body,
        attachments: body.attachments,
        shiftId: body.shiftId ?? null,
        employeeId: body.employeeId ?? null,
        requiresAck: body.requiresAck,
      }),
    );
    return reply.status(201).send({ entry });
  });

  /** A correction: a new revision row; the original stays in the chain untouched. */
  app.post('/v1/logbook/:entryGroupId/revisions', { preHandler: requirePermission('logbook:write') }, async (request, reply) => {
    const { entryGroupId } = z.object({ entryGroupId: z.string().uuid() }).parse(request.params);
    const body = Revise.parse(request.body);
    const entry = await tenantTx(deps, request, async (tx, auth) => {
      const [latest] = await tx
        .select()
        .from(managerLogs)
        .where(eq(managerLogs.entryGroupId, entryGroupId))
        .orderBy(desc(managerLogs.revision))
        .limit(1);
      if (!latest) throw notFound('Log entry');
      return appendEntry(tx, auth, {
        locationId: latest.locationId,
        entryGroupId,
        revision: latest.revision + 1,
        category: latest.category,
        body: body.body,
        attachments: body.attachments ?? latest.attachments,
        shiftId: latest.shiftId,
        employeeId: latest.employeeId,
        requiresAck: latest.requiresAck,
      });
    });
    return reply.status(201).send({ entry });
  });

  /**
   * Latest revision of each entry at a location, newest first, with the author's
   * name, when the entry was first written, and who has acknowledged it.
   */
  app.get('/v1/logbook', { preHandler: requirePermission('logbook:read') }, async (request) => {
    const q = LocationQuery.parse(request.query);
    return tenantTx(deps, request, async (tx, auth) => {
      const rows = await tx
        .selectDistinctOn([managerLogs.entryGroupId])
        .from(managerLogs)
        .where(eq(managerLogs.locationId, q.locationId))
        .orderBy(managerLogs.entryGroupId, desc(managerLogs.revision));
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const page = rows.slice(0, q.limit);
      if (page.length === 0) return { entries: [] };

      const firsts = await tx
        .select({ entryGroupId: managerLogs.entryGroupId, createdAt: managerLogs.createdAt, authorUserId: managerLogs.authorUserId })
        .from(managerLogs)
        .where(and(inArray(managerLogs.entryGroupId, page.map((r) => r.entryGroupId)), eq(managerLogs.revision, 1)));
      const authorIds = [...new Set([...page, ...firsts].map((r) => r.authorUserId))];
      const names = await tx.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, authorIds));
      const acks = await tx
        .select({ managerLogId: logAcknowledgements.managerLogId, userId: logAcknowledgements.userId })
        .from(logAcknowledgements)
        .where(inArray(logAcknowledgements.managerLogId, page.map((r) => r.id)));
      const nameOf = (id: string) => names.find((n) => n.id === id)?.name ?? null;

      return {
        entries: page.map((r) => {
          const first = firsts.find((f) => f.entryGroupId === r.entryGroupId);
          const mine = acks.filter((a) => a.managerLogId === r.id);
          return {
            ...r,
            authorName: nameOf(r.authorUserId),
            firstWrittenAt: first?.createdAt ?? r.createdAt,
            firstAuthorName: first ? nameOf(first.authorUserId) : nameOf(r.authorUserId),
            ackCount: mine.length,
            acknowledgedByMe: mine.some((a) => a.userId === auth.userId),
          };
        }),
      };
    });
  });

  app.post('/v1/logbook/entries/:id/ack', { preHandler: requirePermission('logbook:read') }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return tenantTx(deps, request, async (tx, auth) => {
      const [entry] = await tx.select({ id: managerLogs.id }).from(managerLogs).where(eq(managerLogs.id, id));
      if (!entry) throw notFound('Log entry');
      await tx.insert(logAcknowledgements).values({ orgId: auth.orgId, managerLogId: id, userId: auth.userId }).onConflictDoNothing();
      return { acknowledged: true };
    });
  });

  /** Recompute the location's hash chain: proof for a CCMA hearing. */
  app.get('/v1/logbook/verify', { preHandler: requirePermission('logbook:read') }, async (request) => {
    const { locationId } = LocationQuery.parse(request.query);
    const rows = await tenantTx(deps, request, (tx) =>
      tx.select().from(managerLogs).where(eq(managerLogs.locationId, locationId)).orderBy(asc(managerLogs.seq)),
    );
    const chained: ChainedEntry[] = rows.map((r) => ({ ...toHashInput(r), prevHash: r.prevHash, hash: r.hash }));
    return { locationId, ...verifyChain(chained) };
  });
}

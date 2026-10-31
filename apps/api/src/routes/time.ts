/**
 * Time clocking. Phones and kiosks may be offline during load-shedding, so every
 * clock action carries an Idempotency-Key: a retried sync never creates a second
 * entry. Offline events keep the device time, bounded to the last 72 hours.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Tx } from '@saas-rsa/db';
import { requirePermission, tenantTx, type Deps } from '../context';
import { audit } from '../data';
import { HttpError, notFound } from '../errors';

const { timeEntries, timeEntryBreaks, locations } = schema;

const MAX_OFFLINE_AGE_MS = 72 * 3_600_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

const ClockIn = z.object({
  employeeId: z.string().uuid(),
  locationId: z.string().uuid(),
  shiftId: z.string().uuid().optional(),
  method: z.enum(['mobile', 'kiosk', 'manager']),
  deviceTime: z.coerce.date().optional(),
  offline: z.boolean().default(false),
  gps: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
});

const ClockOut = z.object({
  timeEntryId: z.string().uuid(),
  deviceTime: z.coerce.date().optional(),
  offline: z.boolean().default(false),
});

const AddBreak = z
  .object({ startsAt: z.coerce.date(), endsAt: z.coerce.date(), paid: z.boolean().default(false) })
  .refine((b) => b.endsAt > b.startsAt, { message: 'endsAt must be after startsAt' });

const EditEntry = z.object({
  clockIn: z.coerce.date().optional(),
  clockOut: z.coerce.date().optional(),
  reason: z.string().min(5).max(500),
});

const IdParam = z.object({ id: z.string().uuid() });

function idempotencyKey(headers: Record<string, unknown>): string {
  const key = headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
    throw new HttpError(400, 'idempotency_key_required', 'Send an Idempotency-Key header (8-128 characters)');
  }
  return key;
}

/** The instant to record: device time when it was captured offline, else server time. */
function eventTime(deviceTime: Date | undefined, offline: boolean): Date {
  const now = Date.now();
  if (!offline || !deviceTime) return new Date(now);
  if (deviceTime.getTime() > now + MAX_CLOCK_SKEW_MS) throw new HttpError(400, 'device_time_future', 'Device time is in the future');
  if (deviceTime.getTime() < now - MAX_OFFLINE_AGE_MS) {
    throw new HttpError(400, 'device_time_stale', 'Offline events older than 72 hours need a manager edit');
  }
  return deviceTime;
}

function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

async function geofenceWarnings(tx: Tx, locationId: string, method: string, gps?: { lat: number; lng: number }): Promise<string[]> {
  const [loc] = await tx.select().from(locations).where(eq(locations.id, locationId));
  if (!loc) throw notFound('Location');
  if (method !== 'mobile' || loc.geofenceLat == null || loc.geofenceLng == null || !loc.geofenceRadiusM) return [];
  if (!gps) return ['no_gps'];
  const d = distanceMetres(gps, { lat: loc.geofenceLat, lng: loc.geofenceLng });
  return d > loc.geofenceRadiusM ? ['outside_geofence'] : [];
}

export function registerTimeRoutes(app: FastifyInstance, deps: Deps) {
  app.post('/v1/time/clock-in', { preHandler: requirePermission('time:clock') }, async (request, reply) => {
    const body = ClockIn.parse(request.body);
    const key = idempotencyKey(request.headers);
    const result = await tenantTx(deps, request, async (tx, auth) => {
      const [existing] = await tx.select().from(timeEntries).where(eq(timeEntries.idempotencyKey, key));
      if (existing) return { entry: existing, replayed: true, warnings: [] as string[] };

      const warnings = await geofenceWarnings(tx, body.locationId, body.method, body.gps);
      const clockIn = eventTime(body.deviceTime, body.offline);
      try {
        const [entry] = await tx
          .insert(timeEntries)
          .values({
            orgId: auth.orgId,
            locationId: body.locationId,
            employeeId: body.employeeId,
            shiftId: body.shiftId ?? null,
            clockIn,
            deviceClockIn: body.deviceTime ?? null,
            method: body.method,
            gpsLat: body.gps?.lat ?? null,
            gpsLng: body.gps?.lng ?? null,
            capturedOffline: body.offline,
            idempotencyKey: key,
          })
          .returning();
        return { entry: entry!, replayed: false, warnings };
      } catch (err) {
        const code = (err as { code?: string; cause?: { code?: string } }).code ?? (err as { cause?: { code?: string } }).cause?.code;
        if (code === '23505') throw new HttpError(409, 'already_clocked_in', 'This employee already has an open time entry');
        throw err;
      }
    });
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  app.post('/v1/time/clock-out', { preHandler: requirePermission('time:clock') }, async (request) => {
    const body = ClockOut.parse(request.body);
    return tenantTx(deps, request, async (tx) => {
      const clockOut = eventTime(body.deviceTime, body.offline);
      const [updated] = await tx
        .update(timeEntries)
        .set({ clockOut, deviceClockOut: body.deviceTime ?? null, status: 'submitted' })
        .where(and(eq(timeEntries.id, body.timeEntryId), isNull(timeEntries.clockOut)))
        .returning();
      if (updated) return { entry: updated, replayed: false };
      const [existing] = await tx.select().from(timeEntries).where(eq(timeEntries.id, body.timeEntryId));
      if (!existing) throw notFound('Time entry');
      return { entry: existing, replayed: true }; // already clocked out: idempotent
    });
  });

  app.post('/v1/time/:id/breaks', { preHandler: requirePermission('time:clock') }, async (request, reply) => {
    const { id } = IdParam.parse(request.params);
    const body = AddBreak.parse(request.body);
    const brk = await tenantTx(deps, request, async (tx, auth) => {
      const [entry] = await tx.select().from(timeEntries).where(eq(timeEntries.id, id));
      if (!entry) throw notFound('Time entry');
      if (entry.status === 'approved') throw new HttpError(409, 'approved', 'Approved entries need a manager edit');
      const [row] = await tx.insert(timeEntryBreaks).values({ orgId: auth.orgId, timeEntryId: id, ...body }).returning();
      return row!;
    });
    return reply.status(201).send({ break: brk });
  });

  app.post('/v1/time/:id/approve', { preHandler: requirePermission('time:approve') }, async (request) => {
    const { id } = IdParam.parse(request.params);
    return tenantTx(deps, request, async (tx, auth) => {
      const [entry] = await tx
        .update(timeEntries)
        .set({ status: 'approved', approvedBy: auth.userId, approvedAt: new Date() })
        .where(and(eq(timeEntries.id, id), inArray(timeEntries.status, ['open', 'submitted'])))
        .returning();
      if (!entry) {
        const [existing] = await tx.select().from(timeEntries).where(eq(timeEntries.id, id));
        if (!existing) throw notFound('Time entry');
        throw new HttpError(409, 'not_approvable', `Entry is ${existing.status}`);
      }
      if (!entry.clockOut) throw new HttpError(409, 'still_open', 'Clock the employee out before approving');
      await audit(tx, auth, { action: 'time_entry.approved', entity: 'time_entry', entityId: id });
      return { entry };
    });
  });

  /** Manager correction. A reason is mandatory; an approved entry needs re-approval. */
  app.patch('/v1/time/:id', { preHandler: requirePermission('time:approve') }, async (request) => {
    const { id } = IdParam.parse(request.params);
    const body = EditEntry.parse(request.body);
    return tenantTx(deps, request, async (tx, auth) => {
      const [before] = await tx.select().from(timeEntries).where(eq(timeEntries.id, id));
      if (!before) throw notFound('Time entry');
      const [after] = await tx
        .update(timeEntries)
        .set({
          ...(body.clockIn ? { clockIn: body.clockIn } : {}),
          ...(body.clockOut ? { clockOut: body.clockOut } : {}),
          editReason: body.reason,
          status: 'submitted',
          approvedBy: null,
          approvedAt: null,
        })
        .where(eq(timeEntries.id, id))
        .returning();
      await audit(tx, auth, { action: 'time_entry.edited', entity: 'time_entry', entityId: id, before, after, reason: body.reason });
      return { entry: after };
    });
  });
}

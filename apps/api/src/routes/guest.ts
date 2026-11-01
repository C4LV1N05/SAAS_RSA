/**
 * Guest routes: the table-side ordering app. No login: a guest scans the table's
 * QR/NFC tag, receives a short-lived session token (sent back as the
 * X-Guest-Session header), and can only see and add to that table's tab.
 * The database enforces this too (role 'guest' + app.tab_id in RLS).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, withTenant, type TenantContext, type Tx } from '@saas-rsa/db';
import { planPayment, PaymentPlanError, type PaymentRequest } from '@saas-rsa/domain';
import type { Deps } from '../context';
import { HttpError } from '../errors';
import { getTab, loadBill, lockTab, placeOrder, randomToken, sha256 } from '../serve-data';

const { menuCategories, menuItems, payments, paymentAllocations, diningTables } = schema;

export const GUEST_PREFIX = '/v1/guest';
const SESSION_TTL_MINUTES = 6 * 60;

interface GuestSession {
  session_id: string;
  org_id: string;
  location_id: string;
  tab_id: string;
  tab_status: string;
}

async function guestTx<T>(deps: Deps, request: FastifyRequest, fn: (tx: Tx, ctx: TenantContext & { tabId: string }) => Promise<T>): Promise<T> {
  const token = request.headers['x-guest-session'];
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) {
    throw new HttpError(401, 'guest_session_required', 'Scan the table code to start ordering');
  }
  const result = await deps.db.execute<GuestSession & Record<string, unknown>>(
    sql`select * from app.resolve_guest_session(${sha256(token)})`,
  );
  const s = result.rows[0];
  if (!s) throw new HttpError(401, 'guest_session_expired', 'This table session has ended. Scan the table code again.');
  const ctx = { orgId: s.org_id, userId: s.session_id, role: 'guest' as const, locationIds: [s.location_id], tabId: s.tab_id };
  return withTenant(deps.db, ctx, (tx) => fn(tx, ctx));
}

const StartSession = z.object({ tagToken: z.string().min(20).max(100) });

const PlaceOrder = z.object({
  items: z
    .array(z.object({ menuItemId: z.string().uuid(), quantity: z.number().int().min(1).max(20), notes: z.string().max(200).optional() }))
    .min(1)
    .max(30),
});

const RequestPayment = z
  .object({
    mode: z.enum(['items', 'remaining', 'share']),
    itemIds: z.array(z.string().uuid()).max(100).optional(),
    parts: z.number().int().min(2).max(20).optional(),
    tipCents: z.number().int().min(0).max(1_000_000).default(0),
    tipCode: z.string().min(20).max(100).optional(),
  })
  .refine((p) => p.mode !== 'items' || (p.itemIds && p.itemIds.length > 0), { message: 'itemIds required for items mode' })
  .refine((p) => p.mode !== 'share' || p.parts, { message: 'parts required for share mode' });

function idempotencyKey(headers: Record<string, unknown>): string {
  const key = headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
    throw new HttpError(400, 'idempotency_key_required', 'Send an Idempotency-Key header (8-128 characters)');
  }
  return key;
}

export function registerGuestRoutes(app: FastifyInstance, deps: Deps) {
  /** Scan the table tag: opens (or joins) the table's tab. */
  app.post(`${GUEST_PREFIX}/sessions`, async (request, reply) => {
    const { tagToken } = StartSession.parse(request.body);
    const sessionToken = randomToken(32);
    const result = await deps.db.execute<Record<string, unknown>>(
      sql`select * from app.open_guest_session(${tagToken}, ${sha256(sessionToken)}, ${SESSION_TTL_MINUTES})`,
    );
    const s = result.rows[0] as { tab_id: string; table_label: string; tab_status: string; expires_at: Date } | undefined;
    if (!s) throw new HttpError(404, 'unknown_table', 'This table code is not active');
    return reply.status(201).send({
      sessionToken,
      expiresAt: s.expires_at,
      tab: { id: s.tab_id, table: s.table_label, status: s.tab_status },
    });
  });

  app.get(`${GUEST_PREFIX}/menu`, async (request) =>
    guestTx(deps, request, async (tx, ctx) => {
      const location = ctx.locationIds[0]!;
      const categories = await tx.select().from(menuCategories).where(eq(menuCategories.locationId, location)).orderBy(asc(menuCategories.sortOrder));
      const items = await tx
        .select({
          id: menuItems.id,
          categoryId: menuItems.categoryId,
          name: menuItems.name,
          description: menuItems.description,
          priceCents: menuItems.priceCents,
          station: menuItems.station,
          available: menuItems.available,
        })
        .from(menuItems)
        .where(eq(menuItems.locationId, location))
        .orderBy(asc(menuItems.sortOrder));
      const soldOut = new Set(
        (await tx.execute<{ id: string } & Record<string, unknown>>(sql`select app.sold_out_items(${location}::uuid) as id`)).rows.map((r) => r.id),
      );
      return {
        categories,
        items: items.filter((i) => i.available).map((i) => ({ ...i, soldOut: soldOut.has(i.id), available: undefined })),
      };
    }),
  );

  app.get(`${GUEST_PREFIX}/tab`, async (request) =>
    guestTx(deps, request, async (tx, ctx) => {
      const tab = await getTab(tx, ctx.tabId);
      const bill = await loadBill(tx, tab);
      const [table] = await tx.select({ label: diningTables.label }).from(diningTables).where(eq(diningTables.id, tab.tableId));
      return {
        tab: { id: tab.id, table: table?.label, status: tab.status },
        bill: {
          ...bill,
          perGuest: undefined,
          lines: bill.lines.map((l) => ({ ...l, mine: l.guestSessionId === ctx.userId, guestSessionId: undefined })),
          mySubtotalCents: bill.perGuest[ctx.userId] ?? 0,
        },
      };
    }),
  );

  app.post(`${GUEST_PREFIX}/orders`, async (request, reply) => {
    const body = PlaceOrder.parse(request.body);
    const key = idempotencyKey(request.headers);
    const result = await guestTx(deps, request, async (tx, ctx) => {
      const tab = await getTab(tx, ctx.tabId);
      return placeOrder(tx, ctx, tab, body.items, key, { guestSessionId: ctx.userId });
    });
    return reply.status(result.replayed ? 200 : 201).send({
      orderId: result.order.id,
      items: result.items.map((i) => ({ id: i.id, name: i.name, quantity: i.quantity, status: i.status })),
      awaitingConfirmation: result.items.some((i) => i.status === 'awaiting_confirmation'),
    });
  });

  /** A waiter's personal tip QR code: shows whose code it is before paying. */
  app.get(`${GUEST_PREFIX}/tip-codes/:token`, async (request) => {
    const { token } = z.object({ token: z.string().min(20).max(100) }).parse(request.params);
    return guestTx(deps, request, async (tx) => {
      const rows = (await tx.execute<{ employee_id: string; first_name: string } & Record<string, unknown>>(
        sql`select * from app.resolve_tip_code(${token})`,
      )).rows;
      if (!rows[0]) throw new HttpError(404, 'unknown_tip_code', 'This tip code is not active');
      return { waiter: rows[0].first_name };
    });
  });

  /**
   * Ask to pay: the whole remaining bill, your own items, or a share. The waiter
   * brings the till's card machine and records the payment.
   */
  app.post(`${GUEST_PREFIX}/payments`, async (request, reply) => {
    const body = RequestPayment.parse(request.body);
    const payment = await guestTx(deps, request, async (tx, ctx) => {
      const tab = await getTab(tx, ctx.tabId);
      if (tab.status === 'closed') throw new HttpError(409, 'tab_closed', 'This tab is closed');
      await lockTab(tx, tab.id);
      const bill = await loadBill(tx, tab);

      const req: PaymentRequest =
        body.mode === 'items' ? { mode: 'items', itemIds: body.itemIds! } : body.mode === 'share' ? { mode: 'share', parts: body.parts! } : { mode: 'remaining' };
      let plan;
      try {
        plan = planPayment(bill, req);
      } catch (err) {
        if (err instanceof PaymentPlanError) throw new HttpError(409, err.code, err.message);
        throw err;
      }

      let tipEmployeeId: string | null = null;
      if (body.tipCode) {
        const rows = (await tx.execute<{ employee_id: string } & Record<string, unknown>>(sql`select * from app.resolve_tip_code(${body.tipCode})`)).rows;
        if (!rows[0]) throw new HttpError(404, 'unknown_tip_code', 'This tip code is not active');
        tipEmployeeId = rows[0].employee_id;
      }

      const [row] = await tx
        .insert(payments)
        .values({
          orgId: ctx.orgId,
          locationId: tab.locationId,
          tabId: tab.id,
          guestSessionId: ctx.userId,
          mode: plan.mode,
          amountCents: plan.amountCents,
          tipCents: body.tipCents,
          tipEmployeeId,
          tipSource: tipEmployeeId ? 'tip_code' : null,
        })
        .returning();
      if (plan.allocations.length) {
        await tx.insert(paymentAllocations).values(
          plan.allocations.map((a) => ({ paymentId: row!.id, orderItemId: a.itemId, orgId: ctx.orgId, amountCents: a.amountCents })),
        );
      }
      return row!;
    });
    return reply.status(201).send({
      payment: {
        id: payment.id,
        mode: payment.mode,
        amountCents: payment.amountCents,
        tipCents: payment.tipCents,
        totalCents: payment.amountCents + payment.tipCents,
        status: payment.status,
      },
      next: 'Your waiter is on the way with the card machine.',
    });
  });

  // Guests can see their own payment requests' status.
  app.get(`${GUEST_PREFIX}/payments`, async (request) =>
    guestTx(deps, request, async (tx, ctx) => {
      const rows = await tx
        .select({
          id: payments.id, mode: payments.mode, amountCents: payments.amountCents, tipCents: payments.tipCents,
          status: payments.status, guestSessionId: payments.guestSessionId,
        })
        .from(payments)
        .where(and(eq(payments.tabId, ctx.tabId), inArray(payments.status, ['requested', 'succeeded'])));
      // Everyone at the table sees the table's payments; "mine" marks this guest's own.
      return { payments: rows.map(({ guestSessionId, ...p }) => ({ ...p, mine: guestSessionId === ctx.userId })) };
    }),
  );
}

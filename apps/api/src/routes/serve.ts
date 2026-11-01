/**
 * Staff routes for Serve: set-up (menu, tables, tags, stock, till), service
 * (confirm tables, order for a table, station queues, record till payments,
 * close tabs) and live station streams.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@saas-rsa/db';
import { localDate, resolveTipRecipient, toMilli, fromMilli } from '@saas-rsa/domain';
import { requirePermission, tenantTx, type Deps } from '../context';
import { audit } from '../data';
import { HttpError, notFound } from '../errors';
import type { ServiceEventBus } from '../events';
import { menuImageKeys, processMenuImage, type MediaStore } from '../media';
import { can } from '../permissions';
import { emitOrderToTill, emitTillEvent, getTab, loadBill, lockTab, placeOrder, randomToken } from '../serve-data';

const {
  menuCategories, menuItems, menuItemComponents, inventoryItems, inventoryMovements, diningTables, tableTags,
  tableAssignments, tipCodes, tabs, orderItems, payments, shiftTips, tillIntegrations,
} = schema;

const uuid = z.string().uuid();
const Station = z.enum(['kitchen', 'bar']);
const decimalQty = z.union([z.number(), z.string().regex(/^\d+(\.\d{1,3})?$/)]).transform((v) => fromMilli(toMilli(v)));
const LocationQuery = z.object({ locationId: uuid });

const CreateCategory = z.object({ locationId: uuid, name: z.string().min(1).max(80), sortOrder: z.number().int().default(0) });
const CreateMenuItem = z.object({
  locationId: uuid,
  categoryId: uuid.optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  priceCents: z.number().int().min(0).max(10_000_000),
  station: Station,
  tillCode: z.string().max(40).optional(),
  sortOrder: z.number().int().default(0),
  components: z.array(z.object({ inventoryItemId: uuid, quantity: decimalQty })).max(20).default([]),
});
const CreateTable = z.object({ locationId: uuid, label: z.string().min(1).max(20), section: z.string().max(40).optional(), seats: z.number().int().min(1).max(40).optional() });
const CreateAssignment = z
  .object({ tableIds: z.array(uuid).min(1).max(50), employeeId: uuid, startsAt: z.coerce.date(), endsAt: z.coerce.date() })
  .refine((a) => a.endsAt > a.startsAt, { message: 'endsAt must be after startsAt' });
const CreateInventoryItem = z.object({
  locationId: uuid,
  name: z.string().min(1).max(80),
  unit: z.string().min(1).max(20).default('each'),
  onHand: decimalQty.default('0'),
  reorderLevel: decimalQty.optional(),
});
const StockMovement = z.object({ reason: z.enum(['receive', 'count', 'waste']), quantity: decimalQty, note: z.string().max(200).optional() });
const ItemStatus = z.object({ status: z.enum(['preparing', 'ready', 'served', 'void']), reason: z.string().max(200).optional() });
const StaffOrder = z.object({
  items: z.array(z.object({ menuItemId: uuid, quantity: z.number().int().min(1).max(20), notes: z.string().max(200).optional() })).min(1).max(30),
});
const RecordPayment = z.object({ tillReference: z.string().min(1).max(60) });
const CloseTab = z.object({ tillReference: z.string().min(1).max(60) });
const TillSettings = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('manual') }),
  z.object({ mode: z.literal('webhook'), webhookUrl: z.string().url().startsWith('https://'), signingSecret: z.string().min(32).max(200) }),
]);

const NEXT_STATUS: Record<string, string[]> = {
  queued: ['preparing', 'ready', 'void'],
  preparing: ['ready', 'void'],
  ready: ['served', 'void'],
  awaiting_confirmation: ['void'],
};

function idempotencyKey(headers: Record<string, unknown>): string {
  const key = headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
    throw new HttpError(400, 'idempotency_key_required', 'Send an Idempotency-Key header (8-128 characters)');
  }
  return key;
}

export function registerServeRoutes(
  app: FastifyInstance,
  deps: Deps,
  opts: { events?: ServiceEventBus; media?: MediaStore; guestAppUrl: string },
) {
  // ---------------------------------------------------------------- set-up
  app.post('/v1/menu/categories', { preHandler: requirePermission('service:manage') }, async (request, reply) => {
    const body = CreateCategory.parse(request.body);
    const [row] = await tenantTx(deps, request, (tx, auth) => tx.insert(menuCategories).values({ ...body, orgId: auth.orgId }).returning());
    return reply.status(201).send({ category: row });
  });

  app.post('/v1/menu/items', { preHandler: requirePermission('service:manage') }, async (request, reply) => {
    const { components, ...body } = CreateMenuItem.parse(request.body);
    const item = await tenantTx(deps, request, async (tx, auth) => {
      const [row] = await tx.insert(menuItems).values({ ...body, orgId: auth.orgId }).returning();
      if (components.length) {
        await tx.insert(menuItemComponents).values(components.map((c) => ({ ...c, menuItemId: row!.id, orgId: auth.orgId })));
      }
      return row!;
    });
    return reply.status(201).send({ item, components });
  });

  /** The full menu for staff (including unavailable items). */
  app.get('/v1/menu', { preHandler: requirePermission('service:operate') }, async (request) => {
    const { locationId } = LocationQuery.parse(request.query);
    return tenantTx(deps, request, async (tx) => ({
      categories: await tx.select().from(menuCategories).where(eq(menuCategories.locationId, locationId)).orderBy(asc(menuCategories.sortOrder), asc(menuCategories.name)),
      items: await tx.select().from(menuItems).where(eq(menuItems.locationId, locationId)).orderBy(asc(menuItems.sortOrder), asc(menuItems.name)),
    }));
  });

  app.patch('/v1/menu/items/:id', { preHandler: requirePermission('service:manage') }, async (request) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ available: z.boolean().optional(), priceCents: z.number().int().min(0).optional() }).parse(request.body);
    const [row] = await tenantTx(deps, request, (tx) => tx.update(menuItems).set(body).where(eq(menuItems.id, id)).returning());
    if (!row) throw notFound('Menu item');
    return { item: row };
  });

  /**
   * Upload a dish photo: send the image itself as the body (Content-Type
   * image/jpeg, image/png, image/webp or image/heic, up to 8 MB).
   */
  app.post('/v1/menu/items/:id/image', { preHandler: requirePermission('service:manage') }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    if (!opts.media) throw new HttpError(503, 'unavailable', 'Photo storage is not configured');
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
      throw new HttpError(415, 'unsupported_media_type', 'Send the photo as the request body with an image Content-Type');
    }
    const auth = request.auth!;
    // Check the item exists (and is in this tenant) before doing the work.
    const [existing] = await tenantTx(deps, request, (tx) => tx.select({ id: menuItems.id }).from(menuItems).where(eq(menuItems.id, id)));
    if (!existing) throw notFound('Menu item');

    const image = await processMenuImage(request.body);
    const keys = menuImageKeys(auth.orgId, id, image.hash);
    const [imageUrl, imageThumbUrl] = await Promise.all([
      opts.media.put(keys.full, image.full, 'image/webp'),
      opts.media.put(keys.thumb, image.thumb, 'image/webp'),
    ]);
    const [item] = await tenantTx(deps, request, (tx) =>
      tx.update(menuItems).set({ imageUrl, imageThumbUrl }).where(eq(menuItems.id, id)).returning(),
    );
    return reply.status(201).send({ item, imageUrl, imageThumbUrl });
  });

  app.delete('/v1/menu/items/:id/image', { preHandler: requirePermission('service:manage') }, async (request) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const [item] = await tenantTx(deps, request, (tx) =>
      tx.update(menuItems).set({ imageUrl: null, imageThumbUrl: null }).where(eq(menuItems.id, id)).returning(),
    );
    if (!item) throw notFound('Menu item');
    return { item };
  });

  app.post('/v1/tables', { preHandler: requirePermission('service:manage') }, async (request, reply) => {
    const body = CreateTable.parse(request.body);
    const [row] = await tenantTx(deps, request, (tx, auth) => tx.insert(diningTables).values({ ...body, orgId: auth.orgId }).returning());
    return reply.status(201).send({ table: row });
  });

  /** New QR/NFC tag for a table. Older tags for that table stop working. */
  app.post('/v1/tables/:id/tags', { preHandler: requirePermission('service:manage') }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const token = randomToken(24);
    await tenantTx(deps, request, async (tx, auth) => {
      const [table] = await tx.select().from(diningTables).where(eq(diningTables.id, id));
      if (!table) throw notFound('Table');
      await tx.update(tableTags).set({ active: false }).where(eq(tableTags.tableId, id));
      await tx.insert(tableTags).values({ orgId: auth.orgId, tableId: id, token });
      await audit(tx, auth, { action: 'table_tag.issued', entity: 'dining_table', entityId: id });
    });
    return reply.status(201).send({ token, url: `${opts.guestAppUrl}/t/${token}` });
  });

  app.post('/v1/table-assignments', { preHandler: requirePermission('schedule:write') }, async (request, reply) => {
    const body = CreateAssignment.parse(request.body);
    const rows = await tenantTx(deps, request, async (tx, auth) => {
      const tables = await tx.select().from(diningTables).where(inArray(diningTables.id, body.tableIds));
      if (tables.length !== body.tableIds.length) throw notFound('One or more tables');
      return tx
        .insert(tableAssignments)
        .values(tables.map((t) => ({ orgId: auth.orgId, locationId: t.locationId, tableId: t.id, employeeId: body.employeeId, startsAt: body.startsAt, endsAt: body.endsAt })))
        .returning();
    });
    return reply.status(201).send({ assignments: rows });
  });

  /** A waiter's personal tip QR code (replaces any earlier one). */
  app.post('/v1/tip-codes', { preHandler: requirePermission('tips:manage') }, async (request, reply) => {
    const { employeeId } = z.object({ employeeId: uuid }).parse(request.body);
    const token = randomToken(24);
    await tenantTx(deps, request, async (tx, auth) => {
      await tx.update(tipCodes).set({ active: false }).where(eq(tipCodes.employeeId, employeeId));
      await tx.insert(tipCodes).values({ orgId: auth.orgId, employeeId, token });
    });
    return reply.status(201).send({ token, url: `${opts.guestAppUrl}/tip/${token}` });
  });

  app.put('/v1/till-integration', { preHandler: requirePermission('till:configure') }, async (request) => {
    const body = TillSettings.parse(request.body);
    await tenantTx(deps, request, async (tx, auth) => {
      const values = {
        orgId: auth.orgId,
        mode: body.mode,
        webhookUrl: body.mode === 'webhook' ? body.webhookUrl : null,
        signingSecret: body.mode === 'webhook' ? body.signingSecret : null,
        active: true,
      };
      await tx.insert(tillIntegrations).values(values).onConflictDoUpdate({ target: tillIntegrations.orgId, set: values });
      await audit(tx, auth, { action: 'till_integration.updated', entity: 'till_integration', after: { mode: body.mode } });
    });
    return { mode: body.mode };
  });

  // ---------------------------------------------------------------- stock
  app.post('/v1/inventory/items', { preHandler: requirePermission('inventory:manage') }, async (request, reply) => {
    const body = CreateInventoryItem.parse(request.body);
    const [row] = await tenantTx(deps, request, (tx, auth) => tx.insert(inventoryItems).values({ ...body, orgId: auth.orgId }).returning());
    return reply.status(201).send({ item: row });
  });

  app.get('/v1/inventory', { preHandler: requirePermission('service:operate') }, async (request) => {
    const { locationId } = LocationQuery.parse(request.query);
    const rows = await tenantTx(deps, request, (tx) =>
      tx.select().from(inventoryItems).where(eq(inventoryItems.locationId, locationId)).orderBy(asc(inventoryItems.name)),
    );
    return {
      items: rows.map((r) => ({ ...r, low: r.reorderLevel != null && toMilli(r.onHand) <= toMilli(r.reorderLevel) })),
    };
  });

  /** Deliveries (receive), stock-takes (count: sets the new on-hand) and waste. */
  app.post('/v1/inventory/items/:id/movements', { preHandler: requirePermission('inventory:manage') }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = StockMovement.parse(request.body);
    const result = await tenantTx(deps, request, async (tx, auth) => {
      const [item] = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, id)).for('update');
      if (!item) throw notFound('Inventory item');
      const current = toMilli(item.onHand);
      const qty = toMilli(body.quantity);
      const delta = body.reason === 'receive' ? qty : body.reason === 'waste' ? -qty : qty - current;
      if (current + delta < 0) throw new HttpError(409, 'negative_stock', 'That would take stock below zero');
      const onHand = fromMilli(current + delta);
      await tx.update(inventoryItems).set({ onHand }).where(eq(inventoryItems.id, id));
      await tx.insert(inventoryMovements).values({
        orgId: auth.orgId, locationId: item.locationId, inventoryItemId: id, delta: fromMilli(delta),
        reason: body.reason, note: body.note ?? null, createdBy: auth.userId,
      });
      return { onHand, delta: fromMilli(delta) };
    });
    return reply.status(201).send(result);
  });

  // ---------------------------------------------------------------- service
  /** Open tabs for the floor: totals, items awaiting confirmation, payment requests. */
  app.get('/v1/tabs', { preHandler: requirePermission('service:operate') }, async (request) => {
    const { locationId } = LocationQuery.parse(request.query);
    return tenantTx(deps, request, async (tx) => {
      const open = await tx
        .select({ tab: tabs, table: diningTables.label })
        .from(tabs)
        .innerJoin(diningTables, eq(diningTables.id, tabs.tableId))
        .where(and(eq(tabs.locationId, locationId), inArray(tabs.status, ['pending', 'open'])))
        .orderBy(asc(diningTables.label));
      const requested = open.length
        ? await tx.select().from(payments).where(and(inArray(payments.tabId, open.map((o) => o.tab.id)), eq(payments.status, 'requested')))
        : [];
      const out = [];
      for (const { tab, table } of open) {
        const bill = await loadBill(tx, tab);
        out.push({
          id: tab.id,
          table,
          status: tab.status,
          tillReference: tab.tillReference,
          totalCents: bill.totalCents,
          outstandingCents: bill.outstandingCents,
          awaitingConfirmation: bill.lines.filter((l) => l.status === 'awaiting_confirmation').length,
          paymentRequests: requested
            .filter((p) => p.tabId === tab.id)
            .map((p) => ({ id: p.id, mode: p.mode, amountCents: p.amountCents, tipCents: p.tipCents, totalCents: p.amountCents + p.tipCents })),
        });
      }
      return { tabs: out };
    });
  });

  app.get('/v1/tabs/:id', { preHandler: requirePermission('service:operate') }, async (request) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    return tenantTx(deps, request, async (tx) => {
      const tab = await getTab(tx, id);
      return { tab, bill: await loadBill(tx, tab) };
    });
  });

  /** The waiter confirms a newly scanned table: its waiting items go to the kitchen and bar. */
  app.post('/v1/tabs/:id/confirm', { preHandler: requirePermission('service:operate') }, async (request) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    return tenantTx(deps, request, async (tx, auth) => {
      await lockTab(tx, id);
      const [tab] = await tx
        .update(tabs)
        .set({ status: 'open', confirmedBy: auth.userId, confirmedAt: new Date() })
        .where(and(eq(tabs.id, id), eq(tabs.status, 'pending')))
        .returning();
      if (!tab) throw new HttpError(409, 'not_pending', 'This tab is not waiting for confirmation');
      const released = await tx
        .update(orderItems)
        .set({ status: 'queued', statusChangedAt: new Date() })
        .where(and(eq(orderItems.tabId, id), eq(orderItems.status, 'awaiting_confirmation')))
        .returning();
      const byOrder = new Map<string, typeof released>();
      for (const item of released) byOrder.set(item.orderId, [...(byOrder.get(item.orderId) ?? []), item]);
      for (const [orderId, items] of byOrder) await emitOrderToTill(tx, tab, orderId, items);
      return { tab, released: released.length };
    });
  });

  /** A waiter places an order for the table (guests without phones). */
  app.post('/v1/tabs/:id/orders', { preHandler: requirePermission('service:operate') }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = StaffOrder.parse(request.body);
    const key = idempotencyKey(request.headers);
    const result = await tenantTx(deps, request, async (tx, auth) => {
      const tab = await getTab(tx, id);
      return placeOrder(tx, auth, tab, body.items, key, { placedBy: auth.userId });
    });
    return reply.status(result.replayed ? 200 : 201).send({ orderId: result.order.id, items: result.items });
  });

  /** Closing at the till: the bill was settled there directly (e.g. cash). */
  app.post('/v1/tabs/:id/close', { preHandler: requirePermission('service:operate') }, async (request) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { tillReference } = CloseTab.parse(request.body);
    return tenantTx(deps, request, async (tx, auth) => {
      await lockTab(tx, id);
      const [tab] = await tx
        .update(tabs)
        .set({ status: 'closed', closedAt: new Date(), closedBy: auth.userId, tillReference })
        .where(and(eq(tabs.id, id), inArray(tabs.status, ['pending', 'open'])))
        .returning();
      if (!tab) throw new HttpError(409, 'not_open', 'This tab is already closed');
      await tx.update(payments).set({ status: 'cancelled' }).where(and(eq(payments.tabId, id), eq(payments.status, 'requested')));
      await emitTillEvent(tx, 'tab.closed', tab.locationId, { tabId: tab.id, tillReference }, `tab.closed:${tab.id}`);
      await audit(tx, auth, { action: 'tab.closed', entity: 'tab', entityId: tab.id, after: { tillReference } });
      return { tab };
    });
  });

  /**
   * The waiter took the money on the till's card machine: record it, credit the
   * tip, and close the tab when the bill is fully paid.
   */
  app.post('/v1/payments/:id/record', { preHandler: requirePermission('service:operate') }, async (request) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { tillReference } = RecordPayment.parse(request.body);
    return tenantTx(deps, request, async (tx, auth) => {
      const [pending] = await tx.select().from(payments).where(eq(payments.id, id));
      if (!pending) throw notFound('Payment');
      await lockTab(tx, pending.tabId);
      const tab = await getTab(tx, pending.tabId);
      const now = new Date();

      let tipEmployeeId = pending.tipEmployeeId;
      let tipSource = pending.tipSource;
      if (pending.tipCents > 0 && !tipEmployeeId) {
        const assignments = await tx
          .select()
          .from(tableAssignments)
          .where(and(eq(tableAssignments.tableId, tab.tableId), lte(tableAssignments.startsAt, now), gt(tableAssignments.endsAt, now)));
        const recipient = resolveTipRecipient({ tableId: tab.tableId, at: now, assignments });
        tipEmployeeId = recipient.employeeId;
        tipSource = recipient.source;
      }

      const [payment] = await tx
        .update(payments)
        .set({ status: 'succeeded', tillReference, recordedBy: auth.userId, settledAt: now, tipEmployeeId, tipSource })
        .where(and(eq(payments.id, id), eq(payments.status, 'requested')))
        .returning();
      if (!payment) throw new HttpError(409, 'not_requested', `This payment is ${pending.status}`);

      if (payment.tipCents > 0) {
        // Recorded as a card tip: to the waiter, or to the pool when nobody is assigned.
        await tx.insert(shiftTips).values({
          orgId: auth.orgId, locationId: tab.locationId, businessDate: localDate(now), source: 'card',
          amountCents: payment.tipCents, employeeId: tipEmployeeId, declaredBy: auth.userId, paymentId: payment.id,
        });
      }
      await emitTillEvent(
        tx, 'payment.recorded', tab.locationId,
        { tabId: tab.id, paymentId: payment.id, amountCents: payment.amountCents, tipCents: payment.tipCents, tillReference },
        `payment.recorded:${payment.id}`,
      );

      const bill = await loadBill(tx, tab);
      let closed = false;
      if (bill.settled) {
        await tx.update(tabs).set({ status: 'closed', closedAt: now, closedBy: auth.userId, tillReference: tab.tillReference ?? tillReference }).where(eq(tabs.id, tab.id));
        await emitTillEvent(tx, 'tab.closed', tab.locationId, { tabId: tab.id, tillReference }, `tab.closed:${tab.id}`);
        closed = true;
      }
      return { payment, tip: payment.tipCents > 0 ? { employeeId: tipEmployeeId, source: tipSource } : null, outstandingCents: bill.outstandingCents, tabClosed: closed };
    });
  });

  app.post('/v1/payments/:id/cancel', { preHandler: requirePermission('service:operate') }, async (request) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const [row] = await tenantTx(deps, request, (tx) =>
      tx.update(payments).set({ status: 'cancelled' }).where(and(eq(payments.id, id), eq(payments.status, 'requested'))).returning(),
    );
    if (!row) throw new HttpError(409, 'not_requested', 'Only a requested payment can be cancelled');
    return { payment: row };
  });

  // ---------------------------------------------------------------- stations
  /** Kitchen or bar queue: what to make, oldest first. */
  app.get('/v1/stations/:station/queue', { preHandler: requirePermission('service:operate') }, async (request) => {
    const { station } = z.object({ station: Station }).parse(request.params);
    const { locationId } = LocationQuery.parse(request.query);
    const rows = await tenantTx(deps, request, (tx) =>
      tx
        .select({ item: orderItems, table: diningTables.label })
        .from(orderItems)
        .innerJoin(tabs, eq(tabs.id, orderItems.tabId))
        .innerJoin(diningTables, eq(diningTables.id, tabs.tableId))
        .where(and(eq(orderItems.locationId, locationId), eq(orderItems.station, station), inArray(orderItems.status, ['queued', 'preparing', 'ready'])))
        .orderBy(asc(orderItems.createdAt)),
    );
    const now = Date.now();
    return {
      station,
      items: rows.map(({ item, table }) => ({
        id: item.id, table, name: item.name, quantity: item.quantity, notes: item.notes, status: item.status,
        orderId: item.orderId, waitingMinutes: Math.floor((now - item.createdAt.getTime()) / 60_000),
      })),
    };
  });

  app.post('/v1/order-items/:id/status', { preHandler: requirePermission('service:operate') }, async (request) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = ItemStatus.parse(request.body);
    const auth = request.auth!;
    if (body.status === 'void' && !can(auth.role, 'service:void')) {
      throw new HttpError(403, 'forbidden', 'Only a manager can void an item');
    }
    return tenantTx(deps, request, async (tx) => {
      const [item] = await tx.select().from(orderItems).where(eq(orderItems.id, id));
      if (!item) throw notFound('Order item');
      if (!NEXT_STATUS[item.status]?.includes(body.status)) {
        throw new HttpError(409, 'invalid_transition', `Cannot move an item from ${item.status} to ${body.status}`);
      }
      if (body.status === 'void') {
        if (!body.reason) throw new HttpError(400, 'reason_required', 'Give a reason for voiding');
        const paid = await tx.execute<Record<string, unknown>>(
          sql`select 1 from payment_allocations a join payments p on p.id = a.payment_id where a.order_item_id = ${id} and p.status <> 'cancelled' limit 1`,
        );
        if (paid.rows.length) throw new HttpError(409, 'item_in_payment', 'This item is part of a payment; cancel the payment first');
      }
      const [updated] = await tx
        .update(orderItems)
        .set({ status: body.status, statusChangedAt: new Date(), ...(body.status === 'void' ? { voidReason: body.reason } : {}) })
        .where(and(eq(orderItems.id, id), eq(orderItems.status, item.status)))
        .returning();
      if (!updated) throw new HttpError(409, 'conflict', 'The item changed; refresh and try again');

      if (body.status === 'void') {
        // Return the stock it used and tell the till.
        const used = await tx.select().from(inventoryMovements).where(and(eq(inventoryMovements.orderItemId, id), eq(inventoryMovements.reason, 'order')));
        if (used.length) {
          // Ledger deltas for orders are negative; return the same amount.
          const payload = used.map((m) => ({ inventoryItemId: m.inventoryItemId, quantity: fromMilli(Math.abs(Math.round(Number(m.delta) * 1000))), orderItemId: id }));
          await tx.execute(sql`select app.move_stock(${item.locationId}::uuid, ${JSON.stringify(payload)}::jsonb, 'void')`);
        }
        await emitTillEvent(tx, 'item.voided', item.locationId, { tabId: item.tabId, orderItemId: id, reason: body.reason }, `item.voided:${id}`);
        await audit(tx, auth, { action: 'order_item.voided', entity: 'order_item', entityId: id, reason: body.reason });
      }
      return { item: updated };
    });
  });

  /**
   * Live updates for a station screen (Server-Sent Events). Use fetch() with the
   * Authorization header and read the stream; EventSource cannot send headers.
   */
  app.get('/v1/stations/:station/stream', { preHandler: requirePermission('service:operate') }, async (request, reply) => {
    const { station } = z.object({ station: Station }).parse(request.params);
    const { locationId } = LocationQuery.parse(request.query);
    const auth = request.auth!;
    if (!opts.events) throw new HttpError(503, 'unavailable', 'Live updates are not enabled');
    if (auth.role !== 'owner' && auth.role !== 'payroll_admin' && !auth.locationIds.includes(locationId)) {
      throw new HttpError(403, 'forbidden', 'You do not work at this location');
    }
    // Keep headers already set by plugins (CORS) before taking over the raw response.
    const preset = reply.getHeaders() as Record<string, string | number | string[]>;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      ...preset,
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ station, locationId })}\n\n`);
    const unsubscribe = opts.events.subscribe({
      orgId: auth.orgId,
      locationId,
      station,
      send: (e) => res.write(`event: item\ndata: ${JSON.stringify({ itemId: e.itemId, status: e.status })}\n\n`),
    });
    // Heartbeat keeps proxies (and Azure Container Apps ingress) from closing an idle stream.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}

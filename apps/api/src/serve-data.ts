/** Shared Serve logic used by both guest and staff routes. */
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { loadRuleSet, schema, type TenantContext, type Tx } from '@saas-rsa/db';
import { computeBill, localDate, stockLinesFor, fromMilli, type Bill, type BillPayment } from '@saas-rsa/domain';
import { HttpError, notFound } from './errors';

const { tabs, orders, orderItems, menuItems, menuItemComponents, payments, paymentAllocations, diningTables } = schema;

export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export type TabRow = typeof tabs.$inferSelect;

export async function getTab(tx: Tx, tabId: string): Promise<TabRow> {
  const [tab] = await tx.select().from(tabs).where(eq(tabs.id, tabId));
  if (!tab) throw notFound('Tab');
  return tab;
}

/** Serialise writers on one tab (orders, payment requests) without needing UPDATE rights. */
export async function lockTab(tx: Tx, tabId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tabId}, 0))`);
}

export async function emitTillEvent(tx: Tx, type: string, locationId: string, payload: object, dedupeKey: string): Promise<void> {
  await tx.execute(sql`select app.emit_till_event(${type}, ${locationId}::uuid, ${JSON.stringify(payload)}::jsonb, ${dedupeKey})`);
}

export async function loadBill(tx: Tx, tab: TabRow, onDate = localDate(new Date())): Promise<Bill> {
  const items = await tx.select().from(orderItems).where(eq(orderItems.tabId, tab.id)).orderBy(asc(orderItems.createdAt));
  const pays = await tx.select().from(payments).where(eq(payments.tabId, tab.id));
  const allocs = pays.length
    ? await tx.select().from(paymentAllocations).where(inArray(paymentAllocations.paymentId, pays.map((p) => p.id)))
    : [];
  const rules = await loadRuleSet(tx, tab.orgId);
  const billPayments: BillPayment[] = pays.map((p) => ({
    id: p.id,
    mode: p.mode as BillPayment['mode'],
    status: p.status as BillPayment['status'],
    amountCents: p.amountCents,
    allocations: allocs.filter((a) => a.paymentId === p.id).map((a) => ({ itemId: a.orderItemId, amountCents: a.amountCents })),
  }));
  return computeBill(
    items.map((i) => ({
      id: i.id,
      name: i.name,
      guestSessionId: i.guestSessionId,
      unitPriceCents: i.unitPriceCents,
      quantity: i.quantity,
      status: i.status,
    })),
    billPayments,
    rules.get('vat.rate_bp', onDate),
  );
}

export interface OrderLineInput {
  menuItemId: string;
  quantity: number;
  notes?: string | undefined;
}

/**
 * Place an order on a tab (from a guest or a waiter). Deducts stock atomically;
 * items wait for the waiter's confirmation while the tab is still pending.
 */
export async function placeOrder(
  tx: Tx,
  auth: TenantContext,
  tab: TabRow,
  lines: readonly OrderLineInput[],
  idempotencyKey: string,
  by: { guestSessionId?: string; placedBy?: string },
) {
  if (tab.status === 'closed') throw new HttpError(409, 'tab_closed', 'This tab is closed');
  await lockTab(tx, tab.id);

  const [existing] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.tabId, tab.id), eq(orders.idempotencyKey, idempotencyKey)));
  if (existing) {
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, existing.id));
    return { order: existing, items, replayed: true };
  }

  const menuIds = [...new Set(lines.map((l) => l.menuItemId))];
  const menu = await tx
    .select()
    .from(menuItems)
    .where(and(inArray(menuItems.id, menuIds), eq(menuItems.locationId, tab.locationId)));
  const unavailable = menuIds.filter((id) => !menu.find((m) => m.id === id && m.available));
  if (unavailable.length) throw new HttpError(409, 'item_unavailable', 'Some items are not available', { menuItemIds: unavailable });

  const [order] = await tx
    .insert(orders)
    .values({
      orgId: auth.orgId,
      locationId: tab.locationId,
      tabId: tab.id,
      guestSessionId: by.guestSessionId ?? null,
      placedBy: by.placedBy ?? null,
      idempotencyKey,
    })
    .returning();

  const status = tab.status === 'pending' ? 'awaiting_confirmation' : 'queued';
  const items = await tx
    .insert(orderItems)
    .values(
      lines.map((l) => {
        const m = menu.find((x) => x.id === l.menuItemId)!;
        return {
          orgId: auth.orgId,
          locationId: tab.locationId,
          tabId: tab.id,
          orderId: order!.id,
          guestSessionId: by.guestSessionId ?? null,
          menuItemId: m.id,
          name: m.name,
          unitPriceCents: m.priceCents,
          quantity: l.quantity,
          station: m.station,
          notes: l.notes ?? null,
          status,
        };
      }),
    )
    .returning();

  const components = await tx.select().from(menuItemComponents).where(inArray(menuItemComponents.menuItemId, menuIds));
  const stock = stockLinesFor(
    items.map((i) => ({ orderItemId: i.id, menuItemId: i.menuItemId, quantity: i.quantity })),
    components.map((c) => ({ menuItemId: c.menuItemId, inventoryItemId: c.inventoryItemId, quantity: c.quantity })),
  );
  if (stock.length) {
    const payload = stock.map((s) => ({ inventoryItemId: s.inventoryItemId, quantity: fromMilli(s.milli), orderItemId: s.orderItemId }));
    await tx.execute(sql`select app.move_stock(${tab.locationId}::uuid, ${JSON.stringify(payload)}::jsonb, 'order')`);
  }

  if (tab.status === 'open') await emitOrderToTill(tx, tab, order!.id, items, menu);
  return { order: order!, items, replayed: false };
}

export async function emitOrderToTill(
  tx: Tx,
  tab: TabRow,
  orderId: string,
  items: ReadonlyArray<typeof orderItems.$inferSelect>,
  menu?: ReadonlyArray<typeof menuItems.$inferSelect>,
): Promise<void> {
  const codes = menu ?? (items.length
    ? await tx.select().from(menuItems).where(inArray(menuItems.id, items.map((i) => i.menuItemId)))
    : []);
  const [table] = await tx.select({ label: diningTables.label }).from(diningTables).where(eq(diningTables.id, tab.tableId));
  await emitTillEvent(
    tx,
    'order.placed',
    tab.locationId,
    {
      tabId: tab.id,
      tillReference: tab.tillReference,
      table: table?.label ?? null,
      orderId,
      items: items.map((i) => ({
        orderItemId: i.id,
        tillCode: codes.find((m) => m.id === i.menuItemId)?.tillCode ?? null,
        name: i.name,
        quantity: i.quantity,
        unitPriceCents: i.unitPriceCents,
        station: i.station,
        notes: i.notes,
      })),
    },
    `order.placed:${orderId}`,
  );
}

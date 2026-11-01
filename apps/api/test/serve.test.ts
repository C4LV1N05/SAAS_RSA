/**
 * Serve end to end, against a migrated + seeded PostgreSQL:
 * scan table -> order -> waiter confirms -> kitchen/bar -> split payment at the
 * till -> tips -> tab closes, with stock, voids, live events and till sync.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { createDb, withTenant, type Database, type Role } from '@saas-rsa/db';
import { buildApp } from '../src/app';
import { createVerifier, signDevToken } from '../src/auth';
import { loadEnv } from '../src/env';
import { listenForServiceEvents, ServiceEventBus, type ServiceEvent } from '../src/events';
import { LocalMediaStore } from '../src/media';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const OWNER_URL = process.env.DATABASE_OWNER_URL;
const APP_URL = process.env.DATABASE_URL;
const SECRET = 'test-secret-that-is-at-least-32-characters-long';

describe.skipIf(!OWNER_URL || !APP_URL)('Serve: table ordering alongside the till', () => {
  const ids = {
    org: randomUUID(), loc: randomUUID(), owner: randomUUID(), manager: randomUUID(),
    waiterUser: randomUUID(), waiter: randomUUID(), waiter2: randomUUID(),
  };
  let app: FastifyInstance;
  let db: Database;
  let ownerPool: pg.Pool;
  let closeAll: () => Promise<void>;
  const bus = new ServiceEventBus();
  const events: ServiceEvent[] = [];
  const t = {} as Record<'owner' | 'manager' | 'waiter', string>;
  const state = {
    steakStock: '', rump: '', chenin: '', burger: '', table: '', tag: '', tipCode: '',
    guestA: '', guestB: '', tab: '', rumpItem: '', payA: '', payB: '', rumpPhoto: '',
  };

  const staff = (token: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...headers }, ...(body ? { payload: body } : {}) });
  const guest = (session: string, method: 'GET' | 'POST', url: string, body?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url: `/v1/guest${url}`, headers: { 'x-guest-session': session, ...headers }, ...(body ? { payload: body } : {}) });
  const key = () => `key-${randomUUID()}`;

  const asOwner = async <T>(fn: (c: pg.PoolClient) => Promise<T>) => {
    const c = await ownerPool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true), set_config('app.role', 'owner', true)`, [ids.org, ids.owner]);
      const r = await fn(c);
      await c.query('commit');
      return r;
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  };

  beforeAll(async () => {
    ownerPool = new pg.Pool({ connectionString: OWNER_URL });
    await asOwner(async (c) => {
      await c.query('insert into organisations (id, legal_name) values ($1, $2)', [ids.org, 'Shisa Nyama Group']);
      await c.query('insert into users (id, display_name) values ($1, $2), ($3, $4), ($5, $6)', [ids.owner, 'Owner', ids.manager, 'Manager', ids.waiterUser, 'Ayanda']);
      await c.query('insert into locations (id, org_id, name) values ($1, $2, $3)', [ids.loc, ids.org, 'Maboneng']);
      await c.query(
        `insert into employees (id, org_id, user_id, home_location_id, first_name, last_name, employment_start) values
           ($1, $3, $4, $5, 'Ayanda', 'Zulu', '2026-01-01'), ($2, $3, null, $5, 'Kagiso', 'Molefe', '2026-01-01')`,
        [ids.waiter, ids.waiter2, ids.org, ids.waiterUser, ids.loc],
      );
    });

    const created = createDb(APP_URL!);
    db = created.db;
    const listener = listenForServiceEvents(APP_URL!, bus, { warn: () => {}, info: () => {} });
    bus.subscribe({ orgId: ids.org, locationId: ids.loc, send: (e) => events.push(e) });
    const verify = createVerifier(loadEnv({ NODE_ENV: 'test', DATABASE_URL: APP_URL!, AUTH_AUDIENCE: 'saas-rsa-api', AUTH_DEV_SECRET: SECRET }));
    const media = new LocalMediaStore(await mkdtemp(join(tmpdir(), 'serve-media-')), 'http://api.test/media');
    app = buildApp({ db, verify, events: bus, media, guestAppUrl: 'https://order.example', logLevel: process.env.TEST_LOG ?? 'silent' });
    closeAll = async () => {
      await app.close();
      await listener.close();
      await created.pool.end();
      await ownerPool.end();
    };
    const sign = (userId: string, role: Role) => signDevToken({ userId, role, orgId: ids.org, locationIds: [ids.loc] }, SECRET);
    t.owner = await sign(ids.owner, 'owner');
    t.manager = await sign(ids.manager, 'general_manager');
    t.waiter = await sign(ids.waiterUser, 'employee');
    // Give the LISTEN connection a moment to subscribe.
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(async () => closeAll?.());

  it('sets up the till webhook, menu, stock, table, waiter assignment and tip code', async () => {
    expect((await staff(t.manager, 'PUT', '/v1/till-integration', { mode: 'manual' })).statusCode).toBe(403);
    expect((await staff(t.owner, 'PUT', '/v1/till-integration', { mode: 'webhook', webhookUrl: 'https://till.example/hook', signingSecret: 's'.repeat(40) })).statusCode).toBe(200);

    const cat = await staff(t.manager, 'POST', '/v1/menu/categories', { locationId: ids.loc, name: 'Mains' });
    const steak = await staff(t.manager, 'POST', '/v1/inventory/items', { locationId: ids.loc, name: 'Rump steak 300g', onHand: 2, reorderLevel: 1 });
    state.steakStock = steak.json().item.id;

    const add = async (name: string, priceCents: number, station: string, sortOrder: number, components: object[] = []) =>
      (await staff(t.manager, 'POST', '/v1/menu/items', { locationId: ids.loc, categoryId: cat.json().category.id, name, priceCents, station, sortOrder, tillCode: name.slice(0, 4).toUpperCase(), components })).json().item.id;
    state.rump = await add('Rump 300g', 21_500, 'kitchen', 1, [{ inventoryItemId: state.steakStock, quantity: 1 }]);
    state.chenin = await add('Glass of Chenin', 6_500, 'bar', 2);
    state.burger = await add('Beef burger', 14_000, 'kitchen', 3);

    expect((await staff(t.waiter, 'POST', '/v1/menu/items', { locationId: ids.loc, name: 'x', priceCents: 1, station: 'bar' })).statusCode).toBe(403);

    const table = await staff(t.manager, 'POST', '/v1/tables', { locationId: ids.loc, label: 'T4', seats: 4 });
    state.table = table.json().table.id;
    const tag = await staff(t.manager, 'POST', `/v1/tables/${state.table}/tags`);
    expect(tag.json().url).toMatch(/^https:\/\/order\.example\/t\//);
    state.tag = tag.json().token;

    const now = Date.now();
    const assign = await staff(t.manager, 'POST', '/v1/table-assignments', {
      tableIds: [state.table], employeeId: ids.waiter, startsAt: new Date(now - 3_600_000).toISOString(), endsAt: new Date(now + 5 * 3_600_000).toISOString(),
    });
    expect(assign.statusCode).toBe(201);
    state.tipCode = (await staff(t.manager, 'POST', '/v1/tip-codes', { employeeId: ids.waiter2 })).json().token;
  });

  it('takes a dish photo from a manager and serves it to guests', async () => {
    const png = await sharp({ create: { width: 900, height: 700, channels: 3, background: { r: 150, g: 70, b: 30 } } }).png().toBuffer();
    const upload = (token: string, body: Buffer, type = 'image/png') =>
      app.inject({ method: 'POST', url: `/v1/menu/items/${state.rump}/image`, headers: { authorization: `Bearer ${token}`, 'content-type': type }, payload: body });

    expect((await upload(t.waiter, png)).statusCode).toBe(403);
    expect((await upload(t.manager, Buffer.from('definitely not a photo'))).json().error.code).toBe('not_an_image');
    expect((await upload(t.manager, Buffer.from('hello'), 'text/plain')).statusCode).toBe(415);

    const ok = await upload(t.manager, png);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().imageThumbUrl).toMatch(/^http:\/\/api\.test\/media\/.+-320\.webp$/);
    const served = await app.inject({ method: 'GET', url: new URL(ok.json().imageUrl).pathname });
    expect(served.headers['content-type']).toBe('image/webp');
    expect((await sharp(served.rawPayload).metadata()).width).toBe(640);
    state.rumpPhoto = ok.json().imageThumbUrl;

    const staffMenu = (await staff(t.waiter, 'GET', `/v1/menu?locationId=${ids.loc}`)).json();
    expect(staffMenu.items.map((i: { name: string; imageThumbUrl: string | null }) => [i.name, Boolean(i.imageThumbUrl)])).toEqual([
      ['Rump 300g', true], ['Glass of Chenin', false], ['Beef burger', false],
    ]);
  });

  it('opens one tab per table for every guest who scans it', async () => {
    const a = await app.inject({ method: 'POST', url: '/v1/guest/sessions', payload: { tagToken: state.tag } });
    const b = await app.inject({ method: 'POST', url: '/v1/guest/sessions', payload: { tagToken: state.tag } });
    expect(a.statusCode).toBe(201);
    expect(a.json().tab).toMatchObject({ table: 'T4', status: 'pending' });
    expect(b.json().tab.id).toBe(a.json().tab.id);
    state.guestA = a.json().sessionToken;
    state.guestB = b.json().sessionToken;
    state.tab = a.json().tab.id;
    expect((await app.inject({ method: 'POST', url: '/v1/guest/sessions', payload: { tagToken: 'x'.repeat(32) } })).statusCode).toBe(404);
  });

  it('shows the menu, and holds a new table\'s order until the waiter confirms', async () => {
    const menu = await guest(state.guestA, 'GET', '/menu');
    expect(menu.json().items.map((i: { name: string }) => i.name)).toEqual(['Rump 300g', 'Glass of Chenin', 'Beef burger']);
    expect(menu.json().items[0].soldOut).toBe(false);
    expect(menu.json().items[0].imageThumbUrl).toBe(state.rumpPhoto);
    expect(menu.json().items[1].imageThumbUrl).toBeNull();

    const order = await guest(state.guestA, 'POST', '/orders', { items: [{ menuItemId: state.rump, quantity: 1 }, { menuItemId: state.chenin, quantity: 2, notes: 'Well chilled' }] }, { 'idempotency-key': key() });
    expect(order.statusCode).toBe(201);
    expect(order.json().awaitingConfirmation).toBe(true);
    expect((await staff(t.waiter, 'GET', `/v1/stations/kitchen/queue?locationId=${ids.loc}`)).json().items).toEqual([]);

    const floor = await staff(t.waiter, 'GET', `/v1/tabs?locationId=${ids.loc}`);
    expect(floor.json().tabs[0]).toMatchObject({ table: 'T4', status: 'pending', awaitingConfirmation: 2, totalCents: 34_500 });
  });

  it('routes food to the kitchen and drinks to the bar once confirmed, with live events', async () => {
    events.length = 0;
    expect((await staff(t.waiter, 'POST', `/v1/tabs/${state.tab}/confirm`)).json()).toMatchObject({ released: 2 });
    const kitchen = (await staff(t.waiter, 'GET', `/v1/stations/kitchen/queue?locationId=${ids.loc}`)).json().items;
    const bar = (await staff(t.waiter, 'GET', `/v1/stations/bar/queue?locationId=${ids.loc}`)).json().items;
    expect(kitchen).toEqual([expect.objectContaining({ table: 'T4', name: 'Rump 300g', status: 'queued' })]);
    expect(bar).toEqual([expect.objectContaining({ name: 'Glass of Chenin', quantity: 2, notes: 'Well chilled' })]);
    state.rumpItem = kitchen[0].id;

    await new Promise((r) => setTimeout(r, 300));
    expect(events.map((e) => `${e.station}:${e.status}`).sort()).toEqual(['bar:queued', 'kitchen:queued']);
  });

  it('sends later orders straight through, and refuses what is out of stock', async () => {
    const burger = await guest(state.guestB, 'POST', '/orders', { items: [{ menuItemId: state.burger, quantity: 1 }] }, { 'idempotency-key': 'guest-b-order-1' });
    expect(burger.json()).toMatchObject({ awaitingConfirmation: false, items: [expect.objectContaining({ status: 'queued' })] });
    // Retried by a flaky connection: same order, not a second burger.
    const retry = await guest(state.guestB, 'POST', '/orders', { items: [{ menuItemId: state.burger, quantity: 1 }] }, { 'idempotency-key': 'guest-b-order-1' });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().orderId).toBe(burger.json().orderId);

    const tooMany = await guest(state.guestB, 'POST', '/orders', { items: [{ menuItemId: state.rump, quantity: 2 }] }, { 'idempotency-key': key() });
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.json().error).toMatchObject({ code: 'out_of_stock', details: { item: 'Rump steak 300g' } });
  });

  it('lets a waiter order for the table, marks items sold out, and only managers void (stock returned)', async () => {
    const extra = await staff(t.waiter, 'POST', `/v1/tabs/${state.tab}/orders`, { items: [{ menuItemId: state.rump, quantity: 1 }] }, { 'idempotency-key': key() });
    expect(extra.statusCode).toBe(201);
    const extraItem = extra.json().items[0].id;
    expect((await guest(state.guestA, 'GET', '/menu')).json().items[0].soldOut).toBe(true);

    expect((await staff(t.waiter, 'POST', `/v1/order-items/${extraItem}/status`, { status: 'void', reason: 'Ordered twice' })).statusCode).toBe(403);
    const voided = await staff(t.manager, 'POST', `/v1/order-items/${extraItem}/status`, { status: 'void', reason: 'Ordered twice' });
    expect(voided.json().item.status).toBe('void');
    expect((await guest(state.guestA, 'GET', '/menu')).json().items[0].soldOut).toBe(false);

    const stock = (await staff(t.manager, 'GET', `/v1/inventory?locationId=${ids.loc}`)).json().items[0];
    expect(stock).toMatchObject({ onHand: '1.000', low: true });
  });

  it('moves a dish through the kitchen', async () => {
    for (const status of ['preparing', 'ready', 'served']) {
      expect((await staff(t.waiter, 'POST', `/v1/order-items/${state.rumpItem}/status`, { status })).json().item.status).toBe(status);
    }
    expect((await staff(t.waiter, 'POST', `/v1/order-items/${state.rumpItem}/status`, { status: 'preparing' })).statusCode).toBe(409);
  });

  it('shows each guest the bill with their own items marked', async () => {
    const tab = (await guest(state.guestB, 'GET', '/tab')).json();
    expect(tab.bill).toMatchObject({ totalCents: 48_500, vatCents: 6_326, mySubtotalCents: 14_000, outstandingCents: 48_500 });
    expect(tab.bill.lines.filter((l: { mine: boolean }) => l.mine).map((l: { name: string }) => l.name)).toEqual(['Beef burger']);
  });

  it('splits the bill: guest A pays their items and tips by QR, guest B pays the rest', async () => {
    const lines = (await guest(state.guestA, 'GET', '/tab')).json().bill.lines;
    const mine = lines.filter((l: { mine: boolean; status: string }) => l.mine && l.status !== 'void').map((l: { id: string }) => l.id);

    expect((await guest(state.guestA, 'GET', `/tip-codes/${state.tipCode}`)).json()).toEqual({ waiter: 'Kagiso' });
    const a = await guest(state.guestA, 'POST', '/payments', { mode: 'items', itemIds: mine, tipCents: 5_000, tipCode: state.tipCode });
    expect(a.json().payment).toMatchObject({ amountCents: 34_500, tipCents: 5_000, totalCents: 39_500, status: 'requested' });
    state.payA = a.json().payment.id;

    // Guest B sees A's request, marked as not theirs.
    const seenByB = (await guest(state.guestB, 'GET', '/payments')).json().payments;
    expect(seenByB).toEqual([expect.objectContaining({ amountCents: 34_500, status: 'requested', mine: false })]);

    const clash = await guest(state.guestB, 'POST', '/payments', { mode: 'items', itemIds: [mine[0]] });
    expect(clash.json().error.code).toBe('item_unavailable');

    const b = await guest(state.guestB, 'POST', '/payments', { mode: 'remaining', tipCents: 2_000 });
    expect(b.json().payment).toMatchObject({ amountCents: 14_000, tipCents: 2_000 });
    state.payB = b.json().payment.id;

    const floor = (await staff(t.waiter, 'GET', `/v1/tabs?locationId=${ids.loc}`)).json().tabs[0];
    expect(floor.paymentRequests.map((p: { totalCents: number }) => p.totalCents).sort()).toEqual([16_000, 39_500]);
  });

  it('records till payments, credits tips to the right waiter, and closes the tab when settled', async () => {
    const a = await staff(t.waiter, 'POST', `/v1/payments/${state.payA}/record`, { tillReference: 'TILL-1041' });
    expect(a.json()).toMatchObject({ tip: { employeeId: ids.waiter2, source: 'tip_code' }, outstandingCents: 14_000, tabClosed: false });
    expect((await staff(t.waiter, 'POST', `/v1/payments/${state.payA}/record`, { tillReference: 'TILL-1041' })).statusCode).toBe(409);

    const b = await staff(t.waiter, 'POST', `/v1/payments/${state.payB}/record`, { tillReference: 'TILL-1042' });
    expect(b.json()).toMatchObject({ tip: { employeeId: ids.waiter, source: 'table_assignment' }, outstandingCents: 0, tabClosed: true });

    const tips = await asOwner((c) => c.query('select employee_id, amount_cents, source from shift_tips where location_id = $1 order by amount_cents', [ids.loc]));
    expect(tips.rows).toEqual([
      { employee_id: ids.waiter, amount_cents: '2000', source: 'card' },
      { employee_id: ids.waiter2, amount_cents: '5000', source: 'card' },
    ]);
    // The table session ends with the tab.
    expect((await guest(state.guestA, 'GET', '/tab')).statusCode).toBe(401);
  });

  it('queued every step for the till webhook', async () => {
    const rows = await asOwner((c) => c.query('select event_type from till_events where org_id = $1 order by created_at', [ids.org]));
    const types = rows.rows.map((r) => r.event_type);
    expect(types[0]).toBe('tab.opened');
    expect(types.filter((x) => x === 'order.placed')).toHaveLength(3); // A's order on confirm, B's burger, the waiter's rump
    expect(types).toEqual(expect.arrayContaining(['item.voided', 'payment.recorded', 'tab.closed']));
    expect(types.filter((x) => x === 'payment.recorded')).toHaveLength(2);
  });

  it('receives deliveries and stock-takes', async () => {
    const received = await staff(t.manager, 'POST', `/v1/inventory/items/${state.steakStock}/movements`, { reason: 'receive', quantity: 10 });
    expect(received.json()).toEqual({ onHand: '11.000', delta: '10.000' });
    const counted = await staff(t.manager, 'POST', `/v1/inventory/items/${state.steakStock}/movements`, { reason: 'count', quantity: 9 });
    expect(counted.json()).toEqual({ onHand: '9.000', delta: '-2.000' });
    expect((await staff(t.waiter, 'POST', `/v1/inventory/items/${state.steakStock}/movements`, { reason: 'waste', quantity: 1 })).statusCode).toBe(403);
  });

  it('keeps guests out of staff routes and staff data', async () => {
    const fresh = (await app.inject({ method: 'POST', url: '/v1/guest/sessions', payload: { tagToken: state.tag } })).json();
    expect((await app.inject({ method: 'GET', url: `/v1/tabs?locationId=${ids.loc}`, headers: { 'x-guest-session': fresh.sessionToken } })).statusCode).toBe(401);
    // Even with direct database access, a guest context sees no staff rows and only its own tab.
    const seen = await withTenant(db, { orgId: ids.org, userId: randomUUID(), role: 'guest', locationIds: [ids.loc], tabId: fresh.tab.id }, async (tx) => ({
      employees: (await tx.execute(sql`select count(*)::int as n from employees`)).rows[0],
      tabs: (await tx.execute(sql`select count(*)::int as n from tabs`)).rows[0],
      stock: (await tx.execute(sql`select count(*)::int as n from inventory_items`)).rows[0],
      tips: (await tx.execute(sql`select count(*)::int as n from shift_tips`)).rows[0],
    }));
    expect(seen).toEqual({ employees: { n: 0 }, tabs: { n: 1 }, stock: { n: 0 }, tips: { n: 0 } });
  });
});

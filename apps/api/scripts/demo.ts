/**
 * Creates a demo restaurant for trying the screens locally, and prints the guest
 * table links and staff development tokens.
 *
 *   DATABASE_OWNER_URL=... AUTH_DEV_SECRET=... GUEST_APP_URL=http://localhost:5173 \
 *     pnpm --filter @saas-rsa/api demo
 *
 * Local development only: it signs tokens with the dev secret.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import { signDevToken } from '../src/auth';
import { loadEnv } from '../src/env';
import { createMediaStore, menuImageKeys, processMenuImage } from '../src/media';
import { DEMO_IMAGES } from './demo-images';
import { seedWorkforce } from './demo-workforce';

const ownerUrl = process.env.DATABASE_OWNER_URL;
const secret = process.env.AUTH_DEV_SECRET;
const guestApp = (process.env.GUEST_APP_URL ?? 'http://localhost:5173').replace(/\/$/, '');
if (!ownerUrl || !secret) {
  console.error('Set DATABASE_OWNER_URL and AUTH_DEV_SECRET');
  process.exit(1);
}

const id = () => randomUUID();
const token = () => randomBytes(24).toString('base64url');
const org = id();
const loc = id();
const users = { owner: id(), manager: id(), waiter: id(), chef: id() };
const employees = { waiter: id(), chef: id(), waiter2: id() };

// Photos go to the same store the API serves from (MEDIA_* settings; local folder by default).
const env = loadEnv({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://unused@localhost/x' });
const media = createMediaStore(env);

const pool = new pg.Pool({ connectionString: ownerUrl });
const c = await pool.connect();
try {
  await c.query('begin');
  await c.query(`select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true), set_config('app.role', 'owner', true), set_config('app.location_ids', $3, true)`, [org, users.owner, loc]);
  await c.query('insert into organisations (id, legal_name, trading_name) values ($1, $2, $3)', [org, 'Ember & Salt (Pty) Ltd', 'Ember & Salt']);
  await c.query('insert into locations (id, org_id, name) values ($1, $2, $3)', [loc, org, 'Ember & Salt, Braamfontein']);
  for (const [uid, name] of [[users.owner, 'Nomsa (owner)'], [users.manager, 'Pieter (manager)'], [users.waiter, 'Ayanda'], [users.chef, 'Sipho']]) {
    await c.query('insert into users (id, display_name) values ($1, $2)', [uid, name]);
  }
  await c.query(
    `insert into employees (id, org_id, user_id, home_location_id, first_name, last_name, employment_start) values
       ($1, $4, $5, $7, 'Ayanda', 'Zulu', '2026-01-05'),
       ($2, $4, $6, $7, 'Sipho', 'Dlamini', '2026-01-05'),
       ($3, $4, null, $7, 'Kagiso', 'Molefe', '2026-01-05')`,
    [employees.waiter, employees.chef, employees.waiter2, org, users.waiter, users.chef, loc],
  );

  const stock = async (name: string, onHand: number, unit = 'each') =>
    (await c.query('insert into inventory_items (org_id, location_id, name, unit, on_hand, reorder_level) values ($1, $2, $3, $4, $5, 2) returning id', [org, loc, name, unit, onHand])).rows[0].id as string;
  const rumpStock = await stock('Rump steak 300g', 12);
  const sirloinStock = await stock('Sirloin 250g', 3);
  const minceStock = await stock('Beef mince', 4, 'kg');

  const cat = async (name: string, sort: number) =>
    (await c.query('insert into menu_categories (org_id, location_id, name, sort_order) values ($1, $2, $3, $4) returning id', [org, loc, name, sort])).rows[0].id as string;
  const starters = await cat('Starters', 1);
  const mains = await cat('From the fire', 2);
  const drinks = await cat('Drinks', 3);

  const dish = async (category: string, name: string, description: string, priceCents: number, station: string, sort: number, components: Array<[string, number]> = []) => {
    const menuId = (await c.query(
      'insert into menu_items (org_id, location_id, category_id, name, description, price_cents, station, sort_order, till_code) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id',
      [org, loc, category, name, description, priceCents, station, sort, name.slice(0, 6).toUpperCase().replace(/\W/g, '')],
    )).rows[0].id as string;
    for (const [inv, qty] of components) {
      await c.query('insert into menu_item_components (menu_item_id, inventory_item_id, org_id, quantity) values ($1, $2, $3, $4)', [menuId, inv, org, qty]);
    }
    const svg = DEMO_IMAGES[name];
    if (svg) {
      const image = await processMenuImage(await sharp(Buffer.from(svg)).png().toBuffer());
      const keys = menuImageKeys(org, menuId, image.hash);
      const full = await media.put(keys.full, image.full, 'image/webp');
      const thumb = await media.put(keys.thumb, image.thumb, 'image/webp');
      await c.query('update menu_items set image_url = $1, image_thumb_url = $2 where id = $3', [full, thumb, menuId]);
    }
  };
  await dish(starters, 'Boerewors bites', 'Grilled wors, chakalaka dip', 8_500, 'kitchen', 1);
  await dish(starters, 'Chicken livers', 'Peri-peri cream, toasted ciabatta', 9_500, 'kitchen', 2);
  await dish(mains, 'Rump 300g', 'Basted on the coals, with chips or pap', 21_500, 'kitchen', 1, [[rumpStock, 1]]);
  await dish(mains, 'Sirloin 250g', 'Café de Paris butter, seasonal greens', 23_900, 'kitchen', 2, [[sirloinStock, 1]]);
  await dish(mains, 'Smash burger', 'Two patties, cheddar, house pickles', 14_000, 'kitchen', 3, [[minceStock, 0.2]]);
  await dish(drinks, 'Glass of Chenin Blanc', 'Swartland, 175 ml', 6_500, 'bar', 1);
  await dish(drinks, 'Craft lager', '440 ml draught', 5_200, 'bar', 2);
  await dish(drinks, 'Rooibos iced tea', 'House-brewed, lemon', 3_800, 'bar', 3);

  const tables: Array<{ label: string; tag: string }> = [];
  for (const label of ['T1', 'T2', 'T3', 'T4', 'T5', 'Bar 1']) {
    const tableId = (await c.query('insert into dining_tables (org_id, location_id, label, seats) values ($1, $2, $3, 4) returning id', [org, loc, label])).rows[0].id as string;
    const tag = token();
    await c.query('insert into table_tags (org_id, table_id, token) values ($1, $2, $3)', [org, tableId, tag]);
    await c.query(
      `insert into table_assignments (org_id, location_id, table_id, employee_id, starts_at, ends_at) values ($1, $2, $3, $4, now() - interval '1 hour', now() + interval '12 hours')`,
      [org, loc, tableId, employees.waiter],
    );
    tables.push({ label, tag });
  }
  await seedWorkforce(c, { org, loc, users, employees });

  const tipCode = token();
  await c.query('insert into tip_codes (org_id, employee_id, token) values ($1, $2, $3)', [org, employees.waiter2, tipCode]);
  await c.query('commit');

  const sign = (userId: string, role: 'owner' | 'general_manager' | 'employee') =>
    signDevToken({ userId, orgId: org, role, locationIds: [loc] }, secret);
  console.log('\nDemo restaurant: Ember & Salt, Braamfontein\n');
  console.log('Guest table links (open on a phone-sized window):');
  for (const t of tables) console.log(`  ${t.label.padEnd(6)} ${guestApp}/t/${t.tag}`);
  console.log(`\nKagiso's tip code: ${guestApp}/tip/${tipCode}`);
  console.log(`\nStaff screens: ${guestApp}/staff  (paste a token; valid 15 minutes)`);
  console.log(`  Owner (everything, incl. payroll): ${await sign(users.owner, 'owner')}`);
  console.log(`  Manager (Pieter):                  ${await sign(users.manager, 'general_manager')}`);
  console.log(`  Waiter (Ayanda, can clock in):     ${await sign(users.waiter, 'employee')}`);
  console.log(JSON.stringify({ org, loc, tables, tipCode, users, employees }));
} catch (err) {
  await c.query('rollback');
  throw err;
} finally {
  c.release();
  await pool.end();
}

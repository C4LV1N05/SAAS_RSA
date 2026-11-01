-- 0007_serve.sql
-- Pillar 4, "Serve": table-side ordering that runs alongside the restaurant's till.
--   * Guests scan a table tag (QR/NFC), get a guest session on that table's tab,
--     order from the menu, and ask to pay (whole bill, own items, or a share).
--   * Items route to their station (kitchen or bar) and appear on live displays.
--   * Stock is deducted per order from the menu item's components.
--   * Payment is taken on the till's card machine; the waiter records it here with
--     the till reference. Tips go to the waiter from their QR code or, failing
--     that, the waiter assigned to the table.
--   * Every tab, order and payment can be pushed to the till as signed webhooks.
--
-- Guests are a separate context role ('guest'): no login, scoped to one tab via
-- app.tab_id, and denied every staff table.

-- ---------------------------------------------------------------------------
-- Context helpers
-- ---------------------------------------------------------------------------
create or replace function app.current_tab_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.tab_id', true), '')::uuid
$$;

create or replace function app.is_staff() returns boolean
language sql stable as $$
  select app.has_role('owner', 'payroll_admin', 'general_manager', 'shift_manager', 'employee')
$$;

alter table locations add column require_tab_confirmation boolean not null default true;

-- ---------------------------------------------------------------------------
-- Menu
-- ---------------------------------------------------------------------------
create table menu_categories (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations(id),
  location_id  uuid not null references locations(id),
  name         text not null,
  sort_order   integer not null default 0,
  unique (location_id, name)
);

create table menu_items (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations(id),
  location_id  uuid not null references locations(id),
  category_id  uuid references menu_categories(id),
  name         text not null,
  description  text,
  -- Menu prices include VAT (15%), as South African consumer prices must.
  price_cents  bigint not null check (price_cents >= 0),
  station      text not null check (station in ('kitchen', 'bar')),
  available    boolean not null default true,
  till_code    text,                         -- the item's PLU/code on the till, for sync
  sort_order   integer not null default 0
);
create index on menu_items (location_id) where available;

-- ---------------------------------------------------------------------------
-- Inventory: stock items, a movement ledger, and what each menu item uses.
-- Quantities are numeric(12,3): 1 steak = 1.000, 200 g mince = 0.200 kg.
-- ---------------------------------------------------------------------------
create table inventory_items (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organisations(id),
  location_id       uuid not null references locations(id),
  name              text not null,
  unit              text not null default 'each',
  on_hand           numeric(12,3) not null default 0,
  reorder_level     numeric(12,3),
  unique (location_id, name)
);

create table menu_item_components (
  menu_item_id      uuid not null references menu_items(id) on delete cascade,
  inventory_item_id uuid not null references inventory_items(id),
  org_id            uuid not null references organisations(id),
  quantity          numeric(12,3) not null check (quantity > 0),
  primary key (menu_item_id, inventory_item_id)
);

create table inventory_movements (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organisations(id),
  location_id       uuid not null references locations(id),
  inventory_item_id uuid not null references inventory_items(id),
  delta             numeric(12,3) not null,
  reason            text not null check (reason in ('order', 'void', 'receive', 'count', 'waste')),
  order_item_id     uuid,
  note              text,
  created_by        uuid,
  created_at        timestamptz not null default now()
);
create index on inventory_movements (inventory_item_id, created_at);

create trigger inventory_movements_append_only
  before update or delete on inventory_movements
  for each row execute function app.reject_mutation();

-- ---------------------------------------------------------------------------
-- Tables, tags and waiter assignments
-- ---------------------------------------------------------------------------
create table dining_tables (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations(id),
  location_id  uuid not null references locations(id),
  label        text not null,
  section      text,
  seats        smallint,
  active       boolean not null default true,
  unique (location_id, label)
);

-- The token printed in the QR code / written to the NFC tag. Rotating a tag
-- (deactivate + new row) stops a photographed code from working.
create table table_tags (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations(id),
  table_id     uuid not null references dining_tables(id),
  token        text not null unique check (length(token) >= 20),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table table_assignments (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations(id),
  location_id  uuid not null references locations(id),
  table_id     uuid not null references dining_tables(id),
  employee_id  uuid not null references employees(id),
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  check (ends_at > starts_at)
);
create index on table_assignments (table_id, starts_at);

-- A waiter's personal tip QR code.
create table tip_codes (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations(id),
  employee_id  uuid not null references employees(id),
  token        text not null unique check (length(token) >= 20),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Tabs, guest sessions, orders
-- ---------------------------------------------------------------------------
create table tabs (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organisations(id),
  location_id    uuid not null references locations(id),
  table_id       uuid not null references dining_tables(id),
  -- pending: a guest opened it and a waiter has not confirmed the table yet
  status         text not null default 'pending' check (status in ('pending', 'open', 'closed')),
  confirmed_by   uuid references users(id),
  confirmed_at   timestamptz,
  till_reference text,                       -- the till's bill number, once known
  opened_at      timestamptz not null default now(),
  closed_at      timestamptz,
  closed_by      uuid references users(id)
);
create unique index tabs_one_active_per_table on tabs (table_id) where status <> 'closed';
create index on tabs (location_id, status);

create table guest_sessions (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations(id),
  location_id  uuid not null references locations(id),
  tab_id       uuid not null references tabs(id),
  token_hash   text not null unique,         -- sha256 of the bearer token; the token is never stored
  display_name text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null
);

create table orders (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organisations(id),
  location_id      uuid not null references locations(id),
  tab_id           uuid not null references tabs(id),
  guest_session_id uuid references guest_sessions(id),
  placed_by        uuid references users(id),   -- set when a waiter orders for the table
  idempotency_key  text not null,
  created_at       timestamptz not null default now(),
  unique (tab_id, idempotency_key)
);

create table order_items (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organisations(id),
  location_id      uuid not null references locations(id),
  tab_id           uuid not null references tabs(id),
  order_id         uuid not null references orders(id),
  guest_session_id uuid references guest_sessions(id),  -- who ordered it: used for "pay for my items"
  menu_item_id     uuid not null references menu_items(id),
  name             text not null,             -- snapshot: menu edits never change past bills
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  quantity         integer not null check (quantity between 1 and 50),
  station          text not null check (station in ('kitchen', 'bar')),
  notes            text,
  status           text not null default 'queued'
                     check (status in ('awaiting_confirmation', 'queued', 'preparing', 'ready', 'served', 'void')),
  status_changed_at timestamptz not null default now(),
  void_reason      text,
  created_at       timestamptz not null default now()
);
create index on order_items (location_id, station, status);
create index on order_items (tab_id);

-- ---------------------------------------------------------------------------
-- Payments. A guest asks to pay (status 'requested'); the waiter takes the
-- money on the till's card machine and records it ('succeeded') with the
-- till reference. Allocations tie a payment to the items it covers.
-- ---------------------------------------------------------------------------
create table payments (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organisations(id),
  location_id      uuid not null references locations(id),
  tab_id           uuid not null references tabs(id),
  guest_session_id uuid references guest_sessions(id),
  mode             text not null check (mode in ('items', 'remaining', 'share')),
  amount_cents     bigint not null check (amount_cents > 0),
  tip_cents        bigint not null default 0 check (tip_cents >= 0),
  tip_employee_id  uuid references employees(id),
  tip_source       text check (tip_source in ('tip_code', 'table_assignment', 'pool')),
  method           text not null default 'till' check (method in ('till')),
  status           text not null default 'requested' check (status in ('requested', 'succeeded', 'cancelled')),
  till_reference   text,
  recorded_by      uuid references users(id),
  created_at       timestamptz not null default now(),
  settled_at       timestamptz,
  check (status <> 'succeeded' or (till_reference is not null and recorded_by is not null))
);
create index on payments (tab_id);

create table payment_allocations (
  payment_id    uuid not null references payments(id),
  order_item_id uuid not null references order_items(id),
  org_id        uuid not null references organisations(id),
  amount_cents  bigint not null check (amount_cents > 0),
  primary key (payment_id, order_item_id)
);

alter table shift_tips add column payment_id uuid references payments(id);
create unique index shift_tips_one_per_payment on shift_tips (payment_id) where payment_id is not null;

-- ---------------------------------------------------------------------------
-- Till integration: signed webhooks to the till (or its middleware).
-- ---------------------------------------------------------------------------
create table till_integrations (
  org_id          uuid primary key references organisations(id),
  mode            text not null default 'manual' check (mode in ('manual', 'webhook')),
  webhook_url     text check (webhook_url is null or webhook_url like 'https://%'),
  signing_secret  text check (signing_secret is null or length(signing_secret) >= 32),
  active          boolean not null default true,
  check (mode = 'manual' or (webhook_url is not null and signing_secret is not null))
);

create table till_events (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id),
  location_id     uuid not null references locations(id),
  event_type      text not null check (event_type in ('tab.opened', 'order.placed', 'item.voided', 'payment.recorded', 'tab.closed')),
  payload         jsonb not null,
  dedupe_key      text not null unique,
  status          text not null default 'queued' check (status in ('queued', 'sending', 'delivered', 'failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until    timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz
);
create index till_events_due on till_events (next_attempt_at) where status in ('queued', 'sending');

-- ---------------------------------------------------------------------------
-- SECURITY DEFINER helpers (run as the table owner, which FORCE RLS still binds
-- to the tenant set in the transaction).
-- ---------------------------------------------------------------------------

-- Lookup functions switch to a 'system' context (owner-only policies) and must
-- hand the caller's settings back unchanged, so a guest or staff transaction can
-- never keep that context. app.enter_system() returns the caller's settings;
-- app.leave_system() restores them.
create or replace function app.enter_system() returns text[]
language plpgsql volatile as $$
declare prev text[] := array[
  coalesce(current_setting('app.role', true), ''),
  coalesce(current_setting('app.org_id', true), ''),
  coalesce(current_setting('app.location_ids', true), '')];
begin
  perform set_config('app.role', 'system', true);
  perform set_config('app.org_id', '', true);
  perform set_config('app.location_ids', '', true);
  return prev;
end $$;

create or replace function app.leave_system(prev text[]) returns void
language plpgsql volatile as $$
begin
  perform set_config('app.role', prev[1], true);
  perform set_config('app.org_id', prev[2], true);
  perform set_config('app.location_ids', prev[3], true);
end $$;

-- Before a guest has a session there is no tenant context: resolve the tag,
-- open or reuse the table's tab, and create the session in one step.
create or replace function app.open_guest_session(p_tag_token text, p_token_hash text, p_ttl_minutes integer)
returns table (session_id uuid, org_id uuid, location_id uuid, tab_id uuid, table_label text, tab_status text, expires_at timestamptz)
language plpgsql volatile security definer set search_path = public, app as $$
declare
  v_org uuid; v_loc uuid; v_table uuid; v_label text; v_confirm boolean;
  v_tab uuid; v_status text; v_session uuid; v_expires timestamptz;
  v_prev text[] := app.enter_system();
begin
  -- Look up the tag across tenants ('system' context, owner-only policies).
  select t.org_id, d.location_id, d.id, d.label, l.require_tab_confirmation
    into v_org, v_loc, v_table, v_label, v_confirm
    from table_tags t join dining_tables d on d.id = t.table_id join locations l on l.id = d.location_id
   where t.token = p_tag_token and t.active and d.active;
  if v_org is null then
    perform app.leave_system(v_prev);
    return;
  end if;
  perform set_config('app.org_id', v_org::text, true);
  perform set_config('app.location_ids', v_loc::text, true);

  select t.id, t.status into v_tab, v_status from tabs t where t.table_id = v_table and t.status <> 'closed' for update;
  if v_tab is null then
    insert into tabs (org_id, location_id, table_id, status)
    values (v_org, v_loc, v_table, case when v_confirm then 'pending' else 'open' end)
    returning tabs.id, tabs.status into v_tab, v_status;
    perform app.emit_till_event('tab.opened', v_loc, jsonb_build_object('tabId', v_tab, 'table', v_label), 'tab.opened:' || v_tab);
  end if;

  v_expires := now() + make_interval(mins => p_ttl_minutes);
  insert into guest_sessions (org_id, location_id, tab_id, token_hash, expires_at)
  values (v_org, v_loc, v_tab, p_token_hash, v_expires) returning guest_sessions.id into v_session;

  perform app.leave_system(v_prev);
  return query select v_session, v_org, v_loc, v_tab, v_label, v_status, v_expires;
end $$;

-- Each guest request: token hash -> session context (only for open tabs, unexpired).
create or replace function app.resolve_guest_session(p_token_hash text)
returns table (session_id uuid, org_id uuid, location_id uuid, tab_id uuid, tab_status text)
language plpgsql volatile security definer set search_path = public, app as $$
declare v_prev text[] := app.enter_system();
begin
  return query
    select s.id, s.org_id, s.location_id, s.tab_id, t.status
      from guest_sessions s join tabs t on t.id = s.tab_id
     where s.token_hash = p_token_hash and s.expires_at > now() and t.status <> 'closed';
  perform app.leave_system(v_prev);
end $$;

-- A waiter's tip QR code -> employee and first name (for the guest's screen).
create or replace function app.resolve_tip_code(p_token text)
returns table (employee_id uuid, first_name text)
language sql stable security definer set search_path = public, app as $$
  select e.id, e.first_name
    from tip_codes c join employees e on e.id = c.employee_id
   where c.token = p_token and c.active and c.org_id = app.current_org_id()
     and (e.employment_end is null or e.employment_end >= current_date)
$$;

-- Queue a till event only when this organisation has an active webhook integration.
create or replace function app.emit_till_event(p_type text, p_location uuid, p_payload jsonb, p_dedupe text)
returns void
language plpgsql volatile security definer set search_path = public, app as $$
begin
  if exists (select 1 from till_integrations i
              where i.org_id = app.current_org_id() and i.active and i.mode = 'webhook') then
    insert into till_events (org_id, location_id, event_type, payload, dedupe_key)
    values (app.current_org_id(), p_location, p_type, p_payload, p_dedupe)
    on conflict (dedupe_key) do nothing;
  end if;
end $$;

-- Stock: deduct (order) or return (void) atomically; refuses to go below zero.
-- p_lines: [{"inventoryItemId": "...", "quantity": 1.5, "orderItemId": "..."}]
create or replace function app.move_stock(p_location uuid, p_lines jsonb, p_reason text)
returns void
language plpgsql volatile security definer set search_path = public, app as $$
declare
  r record;
  v_item inventory_items%rowtype;
  v_sign integer := case when p_reason = 'order' then -1 else 1 end;
begin
  if p_reason not in ('order', 'void') then
    raise exception 'move_stock only handles order and void';
  end if;
  for r in
    select (l->>'inventoryItemId')::uuid as item_id, (l->>'quantity')::numeric as qty, (l->>'orderItemId')::uuid as order_item_id
      from jsonb_array_elements(p_lines) l
     order by 1  -- consistent lock order avoids deadlocks
  loop
    select * into v_item from inventory_items
     where id = r.item_id and location_id = p_location and org_id = app.current_org_id()
     for update;
    if not found then
      raise exception 'unknown inventory item %', r.item_id;
    end if;
    if v_sign < 0 and v_item.on_hand < r.qty then
      raise exception 'out_of_stock:%', v_item.name using errcode = 'P0001';
    end if;
    update inventory_items set on_hand = on_hand + v_sign * r.qty where id = v_item.id;
    insert into inventory_movements (org_id, location_id, inventory_item_id, delta, reason, order_item_id, created_by)
    values (v_item.org_id, p_location, v_item.id, v_sign * r.qty, p_reason, r.order_item_id, app.current_user_id());
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Live station displays: notify listeners when items change (ids only; the
-- display re-fetches through RLS).
-- ---------------------------------------------------------------------------
create or replace function app.notify_service_event() returns trigger
language plpgsql as $$
begin
  perform pg_notify('service_events', json_build_object(
    'orgId', new.org_id, 'locationId', new.location_id, 'station', new.station,
    'itemId', new.id, 'status', new.status)::text);
  return new;
end $$;

create trigger order_items_notify
  after insert or update of status on order_items
  for each row execute function app.notify_service_event();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'menu_categories', 'menu_items', 'menu_item_components', 'inventory_items', 'inventory_movements',
    'dining_tables', 'table_tags', 'table_assignments', 'tip_codes', 'tabs', 'guest_sessions',
    'orders', 'order_items', 'payments', 'payment_allocations', 'till_integrations', 'till_events'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (org_id = app.current_org_id()) with check (org_id = app.current_org_id())', t);
  end loop;

  -- Location scope (staff see their locations; a guest's location is its tab's).
  foreach t in array array[
    'menu_categories', 'menu_items', 'inventory_items', 'inventory_movements', 'dining_tables',
    'table_assignments', 'tabs', 'guest_sessions', 'orders', 'order_items', 'payments', 'till_events'
  ] loop
    execute format('create policy location_scope on %I as restrictive using (app.can_access_location(location_id) or app.has_role(''system'')) with check (app.can_access_location(location_id) or app.has_role(''system''))', t);
  end loop;

  -- Guests: only their own tab's rows.
  foreach t in array array['orders', 'order_items', 'payments'] loop
    execute format('create policy guest_own_tab on %I as restrictive using (not app.has_role(''guest'') or tab_id = app.current_tab_id()) with check (not app.has_role(''guest'') or tab_id = app.current_tab_id())', t);
  end loop;

  -- Staff-only tables (no guest access at all).
  foreach t in array array['inventory_items', 'inventory_movements', 'table_tags', 'table_assignments', 'tip_codes', 'guest_sessions', 'till_integrations', 'till_events'] loop
    execute format('create policy staff_only on %I as restrictive to saas_app using (app.is_staff()) with check (app.is_staff())', t);
  end loop;
end $$;

-- Menu: everyone in context may read (guests see the menu); managers edit.
do $$
declare t text;
begin
  foreach t in array array['menu_categories', 'menu_items', 'menu_item_components', 'dining_tables'] loop
    execute format('create policy manage_insert on %I as restrictive for insert to saas_app with check (app.has_role(''owner'', ''general_manager''))', t);
    execute format('create policy manage_update on %I as restrictive for update to saas_app using (app.has_role(''owner'', ''general_manager''))', t);
    execute format('create policy manage_delete on %I as restrictive for delete to saas_app using (app.has_role(''owner'', ''general_manager''))', t);
  end loop;
end $$;

-- Tabs: guests read only their own tab and never change it.
create policy guest_own_tab on tabs as restrictive
  using (not app.has_role('guest') or id = app.current_tab_id());
create policy guest_read_only on tabs as restrictive for update to saas_app using (not app.has_role('guest'));
create policy guest_no_insert on tabs as restrictive for insert to saas_app with check (not app.has_role('guest'));

-- Guests may create orders and payment requests but never change them afterwards.
do $$
declare t text;
begin
  foreach t in array array['orders', 'order_items', 'payments', 'payment_allocations'] loop
    execute format('create policy guest_no_update on %I as restrictive for update to saas_app using (not app.has_role(''guest''))', t);
    execute format('create policy guest_no_delete on %I as restrictive for delete to saas_app using (not app.has_role(''guest''))', t);
  end loop;
end $$;

-- Payment allocations follow their payment's visibility.
create policy follows_payment on payment_allocations as restrictive
  using (exists (select 1 from payments p where p.id = payment_allocations.payment_id));

-- Stock and till settings: managers write; inventory counts are a manager job.
create policy manage_stock on inventory_items as restrictive for insert to saas_app
  with check (app.has_role('owner', 'general_manager'));
create policy manage_stock_update on inventory_items as restrictive for update to saas_app
  using (app.has_role('owner', 'general_manager'));
create policy manage_tags on table_tags as restrictive for insert to saas_app
  with check (app.has_role('owner', 'general_manager'));
create policy manage_tip_codes on tip_codes as restrictive for insert to saas_app
  with check (app.has_role('owner', 'general_manager', 'shift_manager'));
create policy owner_till on till_integrations as restrictive to saas_app
  using (app.has_role('owner')) with check (app.has_role('owner'));

-- Guests are denied every pre-existing staff table, as defence in depth: the
-- API never queries these for guests, and if it ever did, RLS returns nothing.
do $$
declare t text;
begin
  foreach t in array array[
    'organisations', 'locations', 'users', 'memberships', 'audit_log', 'job_roles', 'employees', 'pay_rates',
    'rotation_patterns', 'shifts', 'time_entries', 'time_entry_breaks', 'compliance_findings',
    'pay_periods', 'payroll_runs', 'payslips', 'payslip_lines', 'leave_transactions',
    'tip_pools', 'shift_tips', 'tip_distributions', 'manager_logs', 'log_acknowledgements',
    'performance_tracking', 'notification_outbox'
  ] loop
    execute format('create policy deny_guest on %I as restrictive to saas_app using (not app.has_role(''guest'')) with check (not app.has_role(''guest''))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Worker: claim/complete till events (saas_worker has no table access).
-- ---------------------------------------------------------------------------
create or replace function app.claim_till_events(p_limit integer, p_lease_seconds integer)
returns table (id uuid, org_id uuid, event_type text, payload jsonb, attempts integer, created_at timestamptz,
               webhook_url text, signing_secret text)
language plpgsql volatile security definer set search_path = public, app as $$
declare v_prev text[] := app.enter_system();
begin
  return query
  with claimed as (
    update till_events e
       set status = 'sending', attempts = e.attempts + 1,
           locked_until = now() + make_interval(secs => p_lease_seconds)
     where e.id in (
       select x.id from till_events x
        where x.next_attempt_at <= now()
          and (x.status = 'queued' or (x.status = 'sending' and x.locked_until < now()))
        order by x.next_attempt_at
        limit least(p_limit, 100)
        for update skip locked)
    returning e.*
  )
  select c.id, c.org_id, c.event_type, c.payload, c.attempts, c.created_at, i.webhook_url, i.signing_secret
    from claimed c join till_integrations i on i.org_id = c.org_id;
  perform app.leave_system(v_prev);
end $$;

create or replace function app.complete_till_event(p_id uuid, p_ok boolean, p_error text)
returns void
language plpgsql volatile security definer set search_path = public, app as $$
declare v_prev text[] := app.enter_system();
begin
  update till_events
     set status = case when p_ok then 'delivered' when attempts >= 8 then 'failed' else 'queued' end,
         delivered_at = case when p_ok then now() else delivered_at end,
         last_error = case when p_ok then null else left(p_error, 1000) end,
         next_attempt_at = case when p_ok then next_attempt_at
                                else now() + make_interval(secs => 15 * power(2, least(attempts, 9))::int) end,
         locked_until = null
   where id = p_id and status = 'sending';
  perform app.leave_system(v_prev);
end $$;

-- The 0005 location policy on locations must also let the system lookup through.
drop policy location_scope on locations;
create policy location_scope on locations as restrictive
  using (app.can_access_location(id) or app.has_role('system'));

-- The owner-scoped lookups above need to see across tenants before a context
-- exists ('system' role); these policies apply only to the owner role.
do $$
declare t text;
begin
  foreach t in array array['table_tags', 'dining_tables', 'locations', 'tabs', 'guest_sessions', 'till_events', 'till_integrations'] loop
    execute format('create policy owner_system_lookup on %I for all to %I using (app.has_role(''system'')) with check (app.has_role(''system''))', t, current_user);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on
  menu_categories, menu_items, menu_item_components, inventory_items, dining_tables, table_tags,
  table_assignments, tip_codes, tabs, guest_sessions, orders, order_items, payments,
  payment_allocations, till_integrations
  to saas_app;
grant select, insert on inventory_movements, till_events to saas_app;

revoke execute on function app.open_guest_session(text, text, integer) from public;
revoke execute on function app.resolve_guest_session(text) from public;
revoke execute on function app.resolve_tip_code(text) from public;
revoke execute on function app.emit_till_event(text, uuid, jsonb, text) from public;
revoke execute on function app.move_stock(uuid, jsonb, text) from public;
revoke execute on function app.claim_till_events(integer, integer) from public;
revoke execute on function app.complete_till_event(uuid, boolean, text) from public;
grant execute on function app.open_guest_session(text, text, integer), app.resolve_guest_session(text),
  app.resolve_tip_code(text), app.emit_till_event(text, uuid, jsonb, text), app.move_stock(uuid, jsonb, text),
  app.current_tab_id(), app.is_staff()
  to saas_app;
grant execute on function app.claim_till_events(integer, integer), app.complete_till_event(uuid, boolean, text) to saas_worker;

-- Waiters record till payments, which records the tip for them: allow staff
-- with the employee role to insert a tip that is tied to a payment.
drop policy tips_roles on shift_tips;
create policy tips_roles on shift_tips as restrictive
  using (app.has_role('owner', 'payroll_admin', 'general_manager', 'shift_manager'))
  with check (app.has_role('owner', 'payroll_admin', 'general_manager', 'shift_manager')
              or (app.has_role('employee') and payment_id is not null));

-- Guests cannot read stock, so the menu asks this function which items are sold out.
create or replace function app.sold_out_items(p_location uuid)
returns setof uuid
language sql stable security definer set search_path = public, app as $$
  select distinct c.menu_item_id
    from menu_item_components c
    join inventory_items i on i.id = c.inventory_item_id
   where i.location_id = p_location and i.org_id = app.current_org_id() and i.on_hand < c.quantity
$$;
revoke execute on function app.sold_out_items(uuid) from public;
grant execute on function app.sold_out_items(uuid) to saas_app;

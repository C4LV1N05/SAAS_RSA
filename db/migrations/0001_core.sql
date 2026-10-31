-- 0001_core.sql
-- Shared core: organisation -> location tenancy, identities, memberships,
-- dated rule versions, and an append-only audit log.
--
-- Review fix #1/#2: tenancy is NOT `tenant_id = auth.uid()`. A user belongs to an
-- organisation (legal employer) through a membership; the API sets the active
-- organisation, role and locations per transaction with set_config(), and RLS
-- reads them through the app.* helper functions below.

-- gen_random_uuid() is built into PostgreSQL 13+; no extension needed.

-- Application role: the API and worker connect as this role. It does not own the
-- tables and has no BYPASSRLS, so every policy applies to it.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'saas_app') then
    create role saas_app nologin;
  end if;
end $$;

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Request context helpers (set per transaction by the API: see packages/db/src/tenant.ts)
-- ---------------------------------------------------------------------------
create or replace function app.current_org_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.org_id', true), '')::uuid
$$;

create or replace function app.current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function app.current_role() returns text
language sql stable as $$
  select nullif(current_setting('app.role', true), '')
$$;

create or replace function app.current_location_ids() returns uuid[]
language sql stable as $$
  select coalesce(
    string_to_array(nullif(current_setting('app.location_ids', true), ''), ',')::uuid[],
    '{}'::uuid[]
  )
$$;

create or replace function app.has_role(variadic roles text[]) returns boolean
language sql stable as $$
  select app.current_role() = any(roles)
$$;

-- Owners and payroll admins see every location in the organisation;
-- everyone else only the locations on their membership.
create or replace function app.can_access_location(loc uuid) returns boolean
language sql stable as $$
  select app.has_role('owner', 'payroll_admin')
      or loc = any(app.current_location_ids())
$$;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
create table organisations (
  id              uuid primary key default gen_random_uuid(),
  legal_name      text not null,
  trading_name    text,
  -- SARS references for the legal employer (one PAYE reference per organisation)
  paye_reference  text,
  uif_reference   text,
  sdl_reference   text,
  sdl_liable      boolean not null default false,  -- annual payroll expected > R500,000
  created_at      timestamptz not null default now()
);

create table locations (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id),
  name            text not null,
  address         text,
  geofence_lat    double precision,
  geofence_lng    double precision,
  geofence_radius_m integer check (geofence_radius_m is null or geofence_radius_m > 0),
  timezone        text not null default 'Africa/Johannesburg',
  created_at      timestamptz not null default now()
);
create index on locations (org_id);

-- Global identities (one person can work for more than one organisation).
-- The id matches the identity provider's subject (`sub`) claim.
create table users (
  id              uuid primary key,
  phone_e164      text unique,
  email           text unique,
  display_name    text not null,
  created_at      timestamptz not null default now()
);

create table memberships (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id),
  user_id         uuid not null references users(id),
  role            text not null check (role in (
                    'owner', 'payroll_admin', 'general_manager',
                    'shift_manager', 'employee', 'kiosk_device')),
  location_ids    uuid[] not null default '{}',
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (org_id, user_id)
);
create index on memberships (user_id) where active;

-- ---------------------------------------------------------------------------
-- Review fix #3: legal values are dated rule versions, never constants.
-- org_id null = national rule; org_id set = employer/bargaining-council override.
-- ---------------------------------------------------------------------------
create table rule_versions (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid references organisations(id),
  key             text not null,
  value           jsonb not null,
  effective_from  date not null,
  effective_to    date,
  source          text not null,
  created_at      timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from)
);
create unique index rule_versions_unique
  on rule_versions (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), key, effective_from);

-- ---------------------------------------------------------------------------
-- Append-only audit log: who changed what, when and why.
-- ---------------------------------------------------------------------------
create table audit_log (
  id              bigint generated always as identity primary key,
  org_id          uuid not null references organisations(id),
  actor_user_id   uuid,
  action          text not null,
  entity          text not null,
  entity_id       uuid,
  before          jsonb,
  after           jsonb,
  reason          text,
  at              timestamptz not null default now()
);
create index on audit_log (org_id, entity, entity_id);

create or replace function app.reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only: % is not allowed', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end $$;

create trigger audit_log_append_only
  before update or delete on audit_log
  for each row execute function app.reject_mutation();

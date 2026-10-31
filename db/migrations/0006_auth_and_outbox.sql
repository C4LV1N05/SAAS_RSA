-- 0006_auth_and_outbox.sql
-- 1. Auth0 linking: Auth0 subjects ("auth0|...", "sms|...") are not our user ids,
--    so users carry the external subject, and the first login links an invited user
--    by verified phone or email.
-- 2. Notification outbox: messages are written in the same transaction as the
--    change that causes them, then delivered by the worker (replaces Redis/BullMQ;
--    new Azure Cache for Redis instances are no longer available to new customers).

alter table users add column auth_subject text unique;

-- SECURITY DEFINER functions run as the table owner, and FORCE ROW LEVEL SECURITY
-- binds the owner too, so the login lookup could not see any user. These policies
-- apply only to the owner role (the role running this migration, which owns the
-- tables and could already disable RLS); saas_app gains nothing from them.
do $$
begin
  execute format('create policy owner_login_lookup on users for select to %I using (true)', current_user);
  execute format('create policy owner_login_link on users for update to %I using (auth_subject is null) with check (true)', current_user);
  execute format('create policy owner_login_lookup on memberships for select to %I using (true)', current_user);
end $$;

-- The restrictive membership policy from 0005 is meant for the API; scope it to
-- saas_app so it does not also hide memberships from the login lookup above.
drop policy membership_visibility on memberships;
create policy membership_visibility on memberships as restrictive to saas_app
  using (app.has_role('owner', 'general_manager') or user_id = app.current_user_id())
  with check (app.has_role('owner'));

-- Called by the API's internal claims endpoint (from the Auth0 Post-Login Action).
-- SECURITY DEFINER: runs before any tenant context exists.
create or replace function app.resolve_login(
  p_subject text,
  p_phone text,
  p_email text,
  p_org uuid
) returns table (user_id uuid, org_id uuid, role text, location_ids uuid[])
language plpgsql volatile security definer set search_path = public, app as $$
declare
  v_user uuid;
begin
  select u.id into v_user from users u where u.auth_subject = p_subject;

  -- First login: link the invited user record by verified phone, then verified email.
  if v_user is null and p_phone is not null then
    update users u set auth_subject = p_subject
     where u.id = (select id from users where phone_e164 = p_phone and auth_subject is null limit 1)
    returning u.id into v_user;
  end if;
  if v_user is null and p_email is not null then
    update users u set auth_subject = p_subject
     where u.id = (select id from users where lower(email) = lower(p_email) and auth_subject is null limit 1)
    returning u.id into v_user;
  end if;
  if v_user is null then
    return;
  end if;

  return query
    select v_user, m.org_id, m.role, m.location_ids
      from memberships m
     where m.user_id = v_user and m.active
       and (p_org is null or m.org_id = p_org)
     order by m.created_at;
end $$;

revoke execute on function app.resolve_login(text, text, text, uuid) from public;
grant execute on function app.resolve_login(text, text, text, uuid) to saas_app;

-- ---------------------------------------------------------------------------
-- Notification outbox
-- ---------------------------------------------------------------------------
create table notification_outbox (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organisations(id),
  recipient        jsonb not null,
  template         text not null,
  params           jsonb not null default '{}',
  channels         text[] not null,
  dedupe_key       text not null unique,
  status           text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  locked_until     timestamptz,
  delivered_via    text,
  provider_ref     text,
  last_error       text,
  created_at       timestamptz not null default now(),
  sent_at          timestamptz
);
create index notification_outbox_due on notification_outbox (next_attempt_at) where status in ('queued', 'sending');

-- Tenant isolation for the API. Not FORCEd: the worker functions below run as the
-- table owner (SECURITY DEFINER) and must see every tenant's queued messages.
alter table notification_outbox enable row level security;
create policy tenant_isolation on notification_outbox
  using (org_id = app.current_org_id()) with check (org_id = app.current_org_id());
create policy outbox_read on notification_outbox as restrictive for select
  using (app.has_role('owner', 'general_manager', 'payroll_admin'));
grant select, insert on notification_outbox to saas_app;

-- Worker role: no table access at all, only these two functions.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'saas_worker') then
    create role saas_worker nologin;
  end if;
end $$;

create or replace function app.claim_notifications(p_limit integer, p_lease_seconds integer)
returns setof notification_outbox
language sql volatile security definer set search_path = public, app as $$
  update notification_outbox o
     set status = 'sending',
         attempts = o.attempts + 1,
         locked_until = now() + make_interval(secs => p_lease_seconds)
   where o.id in (
     select id from notification_outbox
      where next_attempt_at <= now()
        and (status = 'queued' or (status = 'sending' and locked_until < now()))
      order by next_attempt_at
      limit least(p_limit, 100)
      for update skip locked)
  returning o.*
$$;

-- Success marks it sent; failure retries with exponential backoff, up to 6 attempts.
create or replace function app.complete_notification(
  p_id uuid, p_ok boolean, p_channel text, p_provider_ref text, p_error text
) returns void
language sql volatile security definer set search_path = public, app as $$
  update notification_outbox
     set status = case when p_ok then 'sent' when attempts >= 6 then 'failed' else 'queued' end,
         delivered_via = case when p_ok then p_channel else delivered_via end,
         provider_ref = coalesce(p_provider_ref, provider_ref),
         last_error = case when p_ok then null else left(p_error, 1000) end,
         sent_at = case when p_ok then now() else sent_at end,
         next_attempt_at = case when p_ok then next_attempt_at
                                else now() + make_interval(secs => 30 * power(2, least(attempts, 8))::int) end,
         locked_until = null
   where id = p_id and status = 'sending'
$$;

revoke execute on function app.claim_notifications(integer, integer) from public;
revoke execute on function app.complete_notification(uuid, boolean, text, text, text) from public;
grant usage on schema app to saas_worker;
grant execute on function app.claim_notifications(integer, integer) to saas_worker;
grant execute on function app.complete_notification(uuid, boolean, text, text, text) to saas_worker;

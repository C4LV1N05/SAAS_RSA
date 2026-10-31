-- 0005_rls.sql
-- Row-Level Security. Two layers:
--   1. PERMISSIVE tenant policy: org_id must equal the organisation the API set for
--      this transaction (app.current_org_id()). No org set => zero rows.
--   2. RESTRICTIVE policies (AND-ed on top): location scope, role scope and
--      employee self-scope.
-- FORCE ROW LEVEL SECURITY makes the policies apply even to the table owner;
-- only superusers and BYPASSRLS roles skip them, and the app role is neither.

-- ---------------------------------------------------------------------------
-- Helper: the employee row of the signed-in user in the active organisation.
-- SECURITY DEFINER so policies can call it without recursing into employees RLS.
-- ---------------------------------------------------------------------------
create or replace function app.current_employee_id() returns uuid
language sql stable security definer set search_path = public, app as $$
  select e.id from employees e
   where e.org_id = app.current_org_id()
     and e.user_id = app.current_user_id()
   limit 1
$$;

-- Sign-in resolution: list a user's active memberships before an org is chosen.
-- SECURITY DEFINER because no org context exists yet at that point.
create or replace function app.memberships_for_user(uid uuid)
returns table (org_id uuid, role text, location_ids uuid[])
language sql stable security definer set search_path = public, app as $$
  select m.org_id, m.role, m.location_ids
    from memberships m
   where m.user_id = uid and m.active
$$;

-- ---------------------------------------------------------------------------
-- 1. Tenant isolation on every table that carries org_id.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'locations', 'memberships', 'audit_log',
    'job_roles', 'employees', 'pay_rates', 'rotation_patterns', 'shifts',
    'time_entries', 'time_entry_breaks', 'compliance_findings',
    'pay_periods', 'payroll_runs', 'payslips', 'payslip_lines', 'leave_transactions',
    'tip_pools', 'shift_tips', 'tip_distributions',
    'manager_logs', 'log_acknowledgements', 'performance_tracking'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = app.current_org_id()) with check (org_id = app.current_org_id())',
      t);
  end loop;
end $$;

-- organisations: only the active organisation is visible.
alter table organisations enable row level security;
alter table organisations force row level security;
create policy tenant_isolation on organisations
  using (id = app.current_org_id())
  with check (id = app.current_org_id());
create policy owner_writes on organisations as restrictive for update
  using (app.has_role('owner')) with check (app.has_role('owner'));

-- users: yourself, or people who are members of the active organisation.
alter table users enable row level security;
alter table users force row level security;
create policy self_or_colleague on users
  using (
    id = app.current_user_id()
    or exists (select 1 from memberships m
                where m.user_id = users.id and m.org_id = app.current_org_id())
  )
  with check (id = app.current_user_id() or app.has_role('owner', 'general_manager'));

-- Global reference data: national rows (org_id null) are readable by everyone;
-- organisation overrides are readable by that organisation only and writable by admins.
-- Not FORCEd: the migration owner seeds national rows; saas_app is still bound by the policies.
do $$
declare
  t text;
begin
  foreach t in array array['rule_versions', 'public_holidays'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy read_national_or_own on %I for select using (org_id is null or org_id = app.current_org_id())', t);
    execute format(
      'create policy admin_insert_own on %I for insert with check (org_id = app.current_org_id() and app.has_role(''owner'', ''payroll_admin''))', t);
    execute format(
      'create policy admin_update_own on %I for update using (org_id = app.current_org_id() and app.has_role(''owner'', ''payroll_admin'')) with check (org_id = app.current_org_id())', t);
    execute format(
      'create policy admin_delete_own on %I for delete using (org_id = app.current_org_id() and app.has_role(''owner'', ''payroll_admin''))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2a. Location scope: managers and staff only see their locations.
-- ---------------------------------------------------------------------------
create policy location_scope on locations as restrictive
  using (app.can_access_location(id));

do $$
declare
  t text;
begin
  foreach t in array array['shifts', 'time_entries', 'rotation_patterns', 'manager_logs', 'tip_pools', 'shift_tips'] loop
    execute format(
      'create policy location_scope on %I as restrictive using (app.can_access_location(location_id)) with check (app.can_access_location(location_id))', t);
  end loop;
end $$;

create policy location_scope on employees as restrictive
  using (app.can_access_location(home_location_id) or user_id = app.current_user_id());

-- ---------------------------------------------------------------------------
-- 2b. Employee self-scope: an employee sees their own records only.
-- ---------------------------------------------------------------------------
create policy employee_self on employees as restrictive
  using (not app.has_role('employee') or user_id = app.current_user_id())
  with check (not app.has_role('employee', 'kiosk_device'));

create policy employee_self on time_entries as restrictive
  using (not app.has_role('employee') or employee_id = app.current_employee_id())
  with check (not app.has_role('employee') or employee_id = app.current_employee_id());

create policy employee_self on time_entry_breaks as restrictive
  using (not app.has_role('employee') or exists (
    select 1 from time_entries te
     where te.id = time_entry_breaks.time_entry_id
       and te.employee_id = app.current_employee_id()));

-- Employees see published shifts that are theirs or open; they never edit shifts.
create policy employee_published_only on shifts as restrictive
  using (not app.has_role('employee', 'kiosk_device')
         or (status = 'published' and (employee_id is null or employee_id = app.current_employee_id()
             or app.has_role('kiosk_device'))));
create policy managers_write_shifts on shifts as restrictive for insert
  with check (app.has_role('owner', 'general_manager', 'shift_manager'));
create policy managers_update_shifts on shifts as restrictive for update
  using (app.has_role('owner', 'general_manager', 'shift_manager'));
create policy managers_delete_shifts on shifts as restrictive for delete
  using (app.has_role('owner', 'general_manager', 'shift_manager'));

-- Memberships are managed by owners; everyone else reads only their own.
create policy membership_visibility on memberships as restrictive
  using (app.has_role('owner', 'general_manager') or user_id = app.current_user_id())
  with check (app.has_role('owner'));

-- ---------------------------------------------------------------------------
-- 2c. Payroll: owners and payroll admins; employees read their own payslips.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['pay_periods', 'payroll_runs', 'payslips', 'payslip_lines', 'leave_transactions'] loop
    execute format('create policy payroll_insert on %I as restrictive for insert with check (app.has_role(''owner'', ''payroll_admin''))', t);
    execute format('create policy payroll_update on %I as restrictive for update using (app.has_role(''owner'', ''payroll_admin''))', t);
    execute format('create policy payroll_delete on %I as restrictive for delete using (app.has_role(''owner'', ''payroll_admin''))', t);
  end loop;
end $$;

create policy payroll_read on pay_periods as restrictive for select
  using (app.has_role('owner', 'payroll_admin', 'employee'));
create policy payroll_read on payroll_runs as restrictive for select
  using (app.has_role('owner', 'payroll_admin'));
create policy payroll_read on payslips as restrictive for select
  using (app.has_role('owner', 'payroll_admin')
         or (app.has_role('employee') and employee_id = app.current_employee_id()));
create policy payroll_read on payslip_lines as restrictive for select
  using (app.has_role('owner', 'payroll_admin')
         or (app.has_role('employee') and exists (
               select 1 from payslips p
                where p.id = payslip_lines.payslip_id
                  and p.employee_id = app.current_employee_id())));
create policy payroll_read on leave_transactions as restrictive for select
  using (app.has_role('owner', 'payroll_admin', 'general_manager')
         or (app.has_role('employee') and employee_id = app.current_employee_id()));

-- Pay rates: managers need them to cost schedules; only payroll admins change them.
create policy rates_read on pay_rates as restrictive for select
  using (app.has_role('owner', 'payroll_admin', 'general_manager', 'shift_manager'));
create policy rates_insert on pay_rates as restrictive for insert
  with check (app.has_role('owner', 'payroll_admin'));
create policy rates_update on pay_rates as restrictive for update
  using (app.has_role('owner', 'payroll_admin'));
create policy rates_delete on pay_rates as restrictive for delete
  using (app.has_role('owner', 'payroll_admin'));

-- ---------------------------------------------------------------------------
-- 2d. Tips: managers and payroll admins; employees read their own distributions.
-- ---------------------------------------------------------------------------
create policy tips_roles on tip_pools as restrictive
  using (app.has_role('owner', 'payroll_admin', 'general_manager', 'shift_manager'));
create policy tips_roles on shift_tips as restrictive
  using (app.has_role('owner', 'payroll_admin', 'general_manager', 'shift_manager'));
create policy tips_roles on tip_distributions as restrictive
  using (app.has_role('owner', 'payroll_admin', 'general_manager', 'shift_manager')
         or (app.has_role('employee') and employee_id = app.current_employee_id()))
  with check (app.has_role('owner', 'payroll_admin', 'general_manager', 'shift_manager'));

-- ---------------------------------------------------------------------------
-- 2e. Manager Log Book: shift managers, general managers and owners only (POPIA).
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['manager_logs', 'log_acknowledgements', 'performance_tracking'] loop
    execute format(
      'create policy logbook_roles on %I as restrictive using (app.has_role(''shift_manager'', ''general_manager'', ''owner'')) with check (app.has_role(''shift_manager'', ''general_manager'', ''owner''))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2f. Compliance findings and audit log: management only (any member may write audit rows).
-- ---------------------------------------------------------------------------
create policy findings_roles on compliance_findings as restrictive
  using (app.has_role('owner', 'payroll_admin', 'general_manager', 'shift_manager'));
create policy audit_read on audit_log as restrictive for select
  using (app.has_role('owner', 'payroll_admin', 'general_manager'));

-- Configuration tables: managers and admins write; everyone in the org reads.
do $$
declare
  t text;
begin
  foreach t in array array['job_roles', 'rotation_patterns', 'locations'] loop
    execute format('create policy config_insert on %I as restrictive for insert with check (app.has_role(''owner'', ''general_manager''))', t);
    execute format('create policy config_update on %I as restrictive for update using (app.has_role(''owner'', ''general_manager''))', t);
    execute format('create policy config_delete on %I as restrictive for delete using (app.has_role(''owner'', ''general_manager''))', t);
  end loop;
end $$;

create policy employees_insert on employees as restrictive for insert
  with check (app.has_role('owner', 'payroll_admin', 'general_manager'));
create policy employees_update on employees as restrictive for update
  using (app.has_role('owner', 'payroll_admin', 'general_manager'));
create policy employees_delete on employees as restrictive for delete
  using (app.has_role('owner'));

-- ---------------------------------------------------------------------------
-- Grants for the application role.
-- ---------------------------------------------------------------------------
grant usage on schema public, app to saas_app;
grant execute on all functions in schema app to saas_app;
grant select, insert, update, delete on all tables in schema public to saas_app;
grant usage, select on all sequences in schema public to saas_app;
-- Append-only tables: the triggers already reject changes; the grants say so too.
revoke update, delete on audit_log, manager_logs, log_acknowledgements, performance_tracking from saas_app;

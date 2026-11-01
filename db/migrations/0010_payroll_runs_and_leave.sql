-- 0010_payroll_runs_and_leave.sql
-- Saved payroll runs (draft -> approved -> finalised -> paid) and leave requests.

-- ---------------------------------------------------------------------------
-- Payroll runs
-- ---------------------------------------------------------------------------
alter table payroll_runs
  add column approved_at timestamptz,
  add column paid_at     timestamptz,
  add column paid_by     uuid references users(id),
  -- One run per pay period: corrections go into the next run.
  add constraint payroll_runs_one_per_period unique (pay_period_id);

alter table payslips
  add column eti_cents   bigint not null default 0,
  -- Everything printed on the payslip, frozen when it was calculated
  -- (names, masked numbers, period, employer), so the PDF never changes.
  add column snapshot    jsonb not null default '{}',
  -- Set when the run is finalised: from then on the employee can see it.
  add column released_at timestamptz;

-- Lines keep the order they were calculated in (earnings, tips, deductions, employer).
alter table payslip_lines add column line_no smallint not null default 0;

-- Employees (including managers who are also employees) see their own payslips
-- once released. Replaces the 0005 policies, which allowed the employee role
-- only and did not wait for finalisation.
drop policy payroll_read on payslips;
create policy payroll_read on payslips as restrictive for select
  using (app.has_role('owner', 'payroll_admin')
         or (employee_id = app.current_employee_id() and released_at is not null));

drop policy payroll_read on payslip_lines;
create policy payroll_read on payslip_lines as restrictive for select
  using (app.has_role('owner', 'payroll_admin')
         or exists (select 1 from payslips p where p.id = payslip_lines.payslip_id
                     and p.employee_id = app.current_employee_id() and p.released_at is not null));

drop policy payroll_read on pay_periods;
create policy payroll_read on pay_periods as restrictive for select using (true);

-- ---------------------------------------------------------------------------
-- Leave
-- ---------------------------------------------------------------------------
create table leave_requests (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id),
  employee_id     uuid not null references employees(id),
  leave_type      text not null check (leave_type in ('annual', 'sick', 'family_responsibility')),
  starts_on       date not null,
  ends_on         date not null,
  minutes         integer not null check (minutes > 0),
  reason          text,
  status          text not null default 'requested'
                    check (status in ('requested', 'approved', 'declined', 'cancelled')),
  requested_by    uuid references users(id),
  decided_by      uuid references users(id),
  decided_at      timestamptz,
  decision_note   text,
  medical_certificate_required boolean not null default false,
  created_at      timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create index on leave_requests (org_id, status, starts_on);
create index on leave_requests (employee_id, starts_on);

-- Ledger rows say where they came from: only 'taken' rows are paid as leave pay.
alter table leave_transactions
  add column source text not null default 'adjustment' check (source in ('adjustment', 'taken')),
  add column leave_request_id uuid references leave_requests(id),
  add column created_by uuid references users(id);
create index on leave_transactions (leave_request_id);

alter table leave_requests enable row level security;
alter table leave_requests force row level security;
create policy tenant_isolation on leave_requests
  using (org_id = app.current_org_id()) with check (org_id = app.current_org_id());
create policy employee_self on leave_requests as restrictive
  using (not app.has_role('employee') or employee_id = app.current_employee_id())
  with check (not app.has_role('employee') or employee_id = app.current_employee_id());
create policy deny_guest on leave_requests as restrictive to saas_app
  using (not app.has_role('guest')) with check (not app.has_role('guest'));
create policy deny_kiosk on leave_requests as restrictive
  using (not app.has_role('kiosk_device')) with check (not app.has_role('kiosk_device'));
grant select, insert, update on leave_requests to saas_app;

-- Managers approve leave, which writes a 'taken' row; payroll admins and owners
-- make adjustments. Replaces the owner/payroll-only write policies from 0005.
drop policy payroll_insert on leave_transactions;
drop policy payroll_update on leave_transactions;
drop policy payroll_read on leave_transactions;
drop policy payroll_delete on leave_transactions;
create policy leave_insert on leave_transactions as restrictive for insert
  with check (app.has_role('owner', 'payroll_admin')
              or (app.has_role('general_manager', 'shift_manager') and source = 'taken'));
create policy leave_update on leave_transactions as restrictive for update
  using (app.has_role('owner', 'payroll_admin'));
-- A cancelled leave request removes its 'taken' row, unless payroll already paid it.
create policy leave_delete on leave_transactions as restrictive for delete
  using (app.has_role('owner', 'payroll_admin')
         or (app.has_role('general_manager', 'shift_manager') and source = 'taken' and payroll_run_id is null));
create policy leave_read on leave_transactions as restrictive for select
  using (app.has_role('owner', 'payroll_admin', 'general_manager', 'shift_manager')
         or employee_id = app.current_employee_id());

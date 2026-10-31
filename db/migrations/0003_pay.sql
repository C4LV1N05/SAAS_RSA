-- 0003_pay.sql
-- Phase 2: Payroll, Leave and Tip Management.
-- Review fix #6: payslips are coded lines (with SARS IRP5 source codes), not fixed
-- columns, so EMP201 / EMP501 / IRP5 totals are sums over lines.
-- Review fix #8: all money is integer cents (bigint).

create table pay_periods (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id),
  frequency       text not null check (frequency in ('weekly', 'fortnightly', 'monthly')),
  starts_on       date not null,
  ends_on         date not null,
  pay_date        date not null,
  unique (org_id, frequency, starts_on),
  check (ends_on >= starts_on)
);

create table payroll_runs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id),
  pay_period_id   uuid not null references pay_periods(id),
  status          text not null default 'draft'
                    check (status in ('draft', 'approved', 'finalised', 'paid')),
  -- The rule versions used, so a run can be reproduced exactly.
  rule_snapshot   jsonb not null default '{}',
  created_by      uuid references users(id),
  approved_by     uuid references users(id),
  finalised_at    timestamptz,
  created_at      timestamptz not null default now()
);

create table payslips (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organisations(id),
  payroll_run_id      uuid not null references payroll_runs(id),
  employee_id         uuid not null references employees(id),
  gross_cents         bigint not null,
  deductions_cents    bigint not null,
  net_cents           bigint not null,
  employer_cost_cents bigint not null,
  unique (payroll_run_id, employee_id),
  check (net_cents = gross_cents - deductions_cents)
);

create table payslip_lines (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organisations(id),
  payslip_id        uuid not null references payslips(id),
  code              text not null,          -- internal code, e.g. ORDINARY, OVERTIME, PAYE
  kind              text not null check (kind in ('earning', 'deduction', 'employer_contribution', 'tip', 'info')),
  description       text not null,
  quantity_minutes  integer,
  rate_cents        bigint,
  multiplier        numeric(4,2),
  amount_cents      bigint not null,
  sars_code         text,                   -- IRP5 source code, e.g. 3601, 3607, 4102, 4141
  needs_review      boolean not null default false,
  rule_version_keys text[] not null default '{}'
);
create index on payslip_lines (payslip_id);

-- Finalised runs are locked: corrections go into the next run.
create or replace function app.guard_payroll_run() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('finalised', 'paid') then
      raise exception 'payroll run % is %; it cannot be deleted', old.id, old.status;
    end if;
    return old;
  end if;
  if old.status in ('finalised', 'paid') then
    if not (old.status = 'finalised' and new.status = 'paid'
            and new.rule_snapshot = old.rule_snapshot
            and new.pay_period_id = old.pay_period_id) then
      raise exception 'payroll run % is %; only finalised -> paid is allowed', old.id, old.status;
    end if;
  end if;
  return new;
end $$;

create trigger payroll_runs_guard
  before update or delete on payroll_runs
  for each row execute function app.guard_payroll_run();

create or replace function app.guard_payslip_child() returns trigger
language plpgsql as $$
declare
  run_status text;
  run_id uuid;
begin
  if tg_table_name = 'payslips' then
    run_id := coalesce(new.payroll_run_id, old.payroll_run_id);
  else
    select p.payroll_run_id into run_id
      from payslips p where p.id = coalesce(new.payslip_id, old.payslip_id);
  end if;
  select status into run_status from payroll_runs where id = run_id;
  if run_status in ('finalised', 'paid') then
    raise exception 'payroll run % is %; payslips are immutable', run_id, run_status;
  end if;
  return coalesce(new, old);
end $$;

create trigger payslips_guard
  before insert or update or delete on payslips
  for each row execute function app.guard_payslip_child();
create trigger payslip_lines_guard
  before insert or update or delete on payslip_lines
  for each row execute function app.guard_payslip_child();

-- Leave is a ledger of minute movements (accruals positive, leave taken negative).
create table leave_transactions (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id),
  employee_id     uuid not null references employees(id),
  leave_type      text not null check (leave_type in ('annual', 'sick', 'family_responsibility')),
  minutes         integer not null,
  reason          text not null,
  occurred_on     date not null,
  payroll_run_id  uuid references payroll_runs(id),
  created_at      timestamptz not null default now()
);
create index on leave_transactions (employee_id, leave_type);

-- Tips. Sectoral Determination 14: tips never count toward the minimum wage,
-- so they live in their own tables and payslip lines.
create table tip_pools (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id),
  location_id     uuid not null references locations(id),
  name            text not null,
  strategy        text not null check (strategy in ('group_split_hours', 'hours_weighted', 'points', 'individual')),
  -- e.g. {"groups": {"foh": 0.7, "boh": 0.3}}
  config          jsonb not null default '{}',
  effective_from  date not null,
  unique (location_id, name, effective_from)
);

create table shift_tips (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id),
  location_id     uuid not null references locations(id),
  business_date   date not null,
  source          text not null check (source in ('cash', 'card', 'service_charge_passed_on')),
  amount_cents    bigint not null check (amount_cents >= 0),
  employee_id     uuid references employees(id),   -- set for individual (unpooled) tips
  declared_by     uuid references users(id),
  declared_at     timestamptz not null default now(),
  pos_reference   text
);
create index on shift_tips (location_id, business_date);

create table tip_distributions (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id),
  tip_pool_id     uuid not null references tip_pools(id),
  business_date   date not null,
  employee_id     uuid not null references employees(id),
  amount_cents    bigint not null check (amount_cents >= 0),
  basis           jsonb not null default '{}',     -- minutes, points, group share used
  payroll_run_id  uuid references payroll_runs(id),
  created_at      timestamptz not null default now(),
  unique (tip_pool_id, business_date, employee_id)
);

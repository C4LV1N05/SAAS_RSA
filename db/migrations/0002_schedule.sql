-- 0002_schedule.sql
-- Phase 1: Scheduling, Time Clocking and Labour Compliance.

create table job_roles (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id),
  name            text not null,                    -- waiter, chef, barista, cashier
  tip_group       text not null default 'foh' check (tip_group in ('foh', 'boh', 'none')),
  tip_points      numeric(6,2) not null default 1,
  unique (org_id, name)
);

create table employees (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references organisations(id),
  user_id                 uuid references users(id),
  home_location_id        uuid not null references locations(id),
  job_role_id             uuid references job_roles(id),
  first_name              text not null,
  last_name               text not null,
  -- POPIA: sensitive identifiers are encrypted by the API before storage.
  id_number_enc           bytea,
  tax_number_enc          bytea,
  bank_account_enc        bytea,
  date_of_birth           date,                     -- ETI age test, tax rebates
  contract_type           text not null default 'permanent'
                            check (contract_type in ('permanent', 'fixed_term', 'part_time', 'casual')),
  -- BCEA s9: 9 ordinary hours a day for <= 5 days a week, 8 hours for more days.
  days_per_week           smallint not null default 5 check (days_per_week between 1 and 7),
  standard_weekly_minutes integer not null default 2700 check (standard_weekly_minutes <= 2700),
  -- BCEA s16: Sunday work is 1.5x if ordinarily worked, otherwise 2x.
  ordinarily_works_sundays boolean not null default false,
  -- BCEA s10: overtime only by agreement.
  overtime_agreement      boolean not null default false,
  -- BCEA s14: 60 minutes, reducible to 30 by written agreement.
  meal_interval_minutes   smallint not null default 60 check (meal_interval_minutes in (30, 60)),
  -- BCEA s6(3): earners above the gazetted threshold are excluded from hours/overtime rules.
  bcea_threshold_exempt   boolean not null default false,
  employment_start        date not null,
  employment_end          date,
  created_at              timestamptz not null default now()
);
create index on employees (org_id, home_location_id);
create unique index employees_user_per_org on employees (org_id, user_id) where user_id is not null;

-- Review fix #5: rates are dated, so past payslips always reproduce.
create table pay_rates (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id),
  employee_id     uuid not null references employees(id),
  rate_type       text not null check (rate_type in ('hourly', 'monthly')),
  rate_cents      bigint not null check (rate_cents > 0),
  effective_from  date not null,
  unique (employee_id, effective_from)
);

create table public_holidays (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid references organisations(id),  -- null = national
  holiday_date    date not null,
  name            text not null
);
create unique index public_holidays_unique
  on public_holidays (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), holiday_date);

-- Rotational scheduling: a pattern generates shifts (replaces the boolean `rotational` flag).
create table rotation_patterns (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id),
  location_id     uuid not null references locations(id),
  name            text not null,
  cycle_days      smallint not null check (cycle_days between 1 and 56),
  -- [{ "day": 0, "start": "10:00", "end": "18:00", "jobRoleId": "..." }, ...]
  pattern         jsonb not null,
  created_at      timestamptz not null default now()
);

create table shifts (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organisations(id),
  location_id           uuid not null references locations(id),
  employee_id           uuid references employees(id),      -- null = open shift
  job_role_id           uuid references job_roles(id),
  starts_at             timestamptz not null,
  ends_at               timestamptz not null,
  planned_break_minutes smallint not null default 0,
  rotation_pattern_id   uuid references rotation_patterns(id),
  status                text not null default 'draft' check (status in ('draft', 'published', 'cancelled')),
  published_at          timestamptz,
  created_at            timestamptz not null default now(),
  check (ends_at > starts_at),
  check (ends_at - starts_at <= interval '16 hours')
);
create index on shifts (org_id, location_id, starts_at);
create index on shifts (employee_id, starts_at);

create table time_entries (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organisations(id),
  location_id       uuid not null references locations(id),
  employee_id       uuid not null references employees(id),
  shift_id          uuid references shifts(id),             -- nullable: unscheduled work happens
  clock_in          timestamptz not null,
  clock_out         timestamptz,
  device_clock_in   timestamptz,                            -- device time, kept for offline audits
  device_clock_out  timestamptz,
  method            text not null check (method in ('mobile', 'kiosk', 'manager')),
  gps_lat           double precision,
  gps_lng           double precision,
  captured_offline  boolean not null default false,
  idempotency_key   text not null,
  status            text not null default 'open'
                      check (status in ('open', 'submitted', 'approved', 'rejected')),
  approved_by       uuid references users(id),
  approved_at       timestamptz,
  edit_reason       text,
  created_at        timestamptz not null default now(),
  unique (org_id, idempotency_key),
  check (clock_out is null or clock_out > clock_in)
);
create index on time_entries (org_id, employee_id, clock_in);
create unique index time_entries_one_open
  on time_entries (employee_id) where clock_out is null;

create table time_entry_breaks (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id),
  time_entry_id   uuid not null references time_entries(id) on delete cascade,
  starts_at       timestamptz not null,
  ends_at         timestamptz,
  paid            boolean not null default false,
  check (ends_at is null or ends_at > starts_at)
);

create table compliance_findings (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id),
  rule_key        text not null,
  severity        text not null check (severity in ('info', 'warn', 'block')),
  subject_type    text not null check (subject_type in ('shift', 'time_entry', 'employee_week', 'payslip')),
  subject_id      uuid not null,
  message         text not null,
  data            jsonb not null default '{}',
  overridden_by   uuid references users(id),
  override_reason text,
  created_at      timestamptz not null default now(),
  check ((overridden_by is null) = (override_reason is null))
);
create index on compliance_findings (org_id, subject_type, subject_id);

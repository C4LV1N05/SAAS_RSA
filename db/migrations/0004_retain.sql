-- 0004_retain.sql
-- Phase 3: Manager Log Book.
-- Append-only with revisions AND a hash chain per location, so any tampering with
-- past entries is detectable (the property that makes it CCMA evidence). The chain
-- is per location because a manager can only see their own locations' entries.

create table manager_logs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id),
  location_id     uuid not null references locations(id),
  entry_group_id  uuid not null,                 -- stable id across revisions
  revision        integer not null check (revision >= 1),
  author_user_id  uuid not null references users(id),
  category        text not null check (category in ('handover', 'maintenance', 'incident', 'disciplinary', 'note')),
  requires_ack    boolean not null default false,
  shift_id        uuid references shifts(id),
  employee_id     uuid references employees(id),
  body            text not null,
  attachments     jsonb not null default '[]',
  seq             bigint not null,               -- position in the location's chain
  prev_hash       text not null,
  hash            text not null,
  created_at      timestamptz not null default now(),
  unique (entry_group_id, revision),
  unique (location_id, seq)
);
create index on manager_logs (org_id, location_id, created_at desc);

create trigger manager_logs_append_only
  before update or delete on manager_logs
  for each row execute function app.reject_mutation();

create table log_acknowledgements (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id),
  manager_log_id  uuid not null references manager_logs(id),
  user_id         uuid not null references users(id),
  acknowledged_at timestamptz not null default now(),
  unique (manager_log_id, user_id)
);

create trigger log_acknowledgements_append_only
  before update or delete on log_acknowledgements
  for each row execute function app.reject_mutation();

-- Each infraction points at the record that proves it.
create table performance_tracking (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id),
  employee_id     uuid not null references employees(id),
  infraction_type text not null check (infraction_type in (
                    'late_arrival', 'absence', 'early_departure', 'missed_clock_out',
                    'conduct', 'customer_complaint', 'other')),
  occurred_at     timestamptz not null,
  source_type     text not null check (source_type in ('time_entry', 'shift', 'manager_log')),
  source_id       uuid not null,
  notes           text,
  recorded_by     uuid not null references users(id),
  created_at      timestamptz not null default now()
);
create index on performance_tracking (employee_id, occurred_at);

create trigger performance_tracking_append_only
  before update or delete on performance_tracking
  for each row execute function app.reject_mutation();

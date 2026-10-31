/**
 * Drizzle table definitions for query building. The SQL files in db/migrations are
 * the source of truth (they also hold RLS policies and triggers); keep these in step.
 */
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const cents = (name: string) => bigint(name, { mode: 'number' });

export const organisations = pgTable('organisations', {
  id: uuid('id').primaryKey().defaultRandom(),
  legalName: text('legal_name').notNull(),
  tradingName: text('trading_name'),
  payeReference: text('paye_reference'),
  uifReference: text('uif_reference'),
  sdlReference: text('sdl_reference'),
  sdlLiable: boolean('sdl_liable').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const locations = pgTable('locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  name: text('name').notNull(),
  address: text('address'),
  geofenceLat: doublePrecision('geofence_lat'),
  geofenceLng: doublePrecision('geofence_lng'),
  geofenceRadiusM: integer('geofence_radius_m'),
  timezone: text('timezone').notNull().default('Africa/Johannesburg'),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  phoneE164: text('phone_e164'),
  email: text('email'),
  displayName: text('display_name').notNull(),
  authSubject: text('auth_subject'),
});

export const memberships = pgTable('memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  userId: uuid('user_id').notNull(),
  role: text('role').notNull(),
  locationIds: uuid('location_ids').array().notNull(),
  active: boolean('active').notNull().default(true),
});

export const ruleVersions = pgTable('rule_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id'),
  key: text('key').notNull(),
  value: jsonb('value').notNull(),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  source: text('source').notNull(),
});

export const auditLog = pgTable('audit_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  orgId: uuid('org_id').notNull(),
  actorUserId: uuid('actor_user_id'),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: uuid('entity_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  reason: text('reason'),
  at: ts('at').notNull().defaultNow(),
});

export const jobRoles = pgTable('job_roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  name: text('name').notNull(),
  tipGroup: text('tip_group').notNull().default('foh'),
  tipPoints: numeric('tip_points').notNull().default('1'),
});

export const employees = pgTable('employees', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  userId: uuid('user_id'),
  homeLocationId: uuid('home_location_id').notNull(),
  jobRoleId: uuid('job_role_id'),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  dateOfBirth: date('date_of_birth'),
  contractType: text('contract_type').notNull().default('permanent'),
  daysPerWeek: smallint('days_per_week').notNull().default(5),
  standardWeeklyMinutes: integer('standard_weekly_minutes').notNull().default(2700),
  ordinarilyWorksSundays: boolean('ordinarily_works_sundays').notNull().default(false),
  overtimeAgreement: boolean('overtime_agreement').notNull().default(false),
  mealIntervalMinutes: smallint('meal_interval_minutes').notNull().default(60),
  bceaThresholdExempt: boolean('bcea_threshold_exempt').notNull().default(false),
  employmentStart: date('employment_start').notNull(),
  employmentEnd: date('employment_end'),
});

export const payRates = pgTable('pay_rates', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  rateType: text('rate_type').notNull(),
  rateCents: cents('rate_cents').notNull(),
  effectiveFrom: date('effective_from').notNull(),
});

export const publicHolidays = pgTable('public_holidays', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id'),
  holidayDate: date('holiday_date').notNull(),
  name: text('name').notNull(),
});

export const shifts = pgTable('shifts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  locationId: uuid('location_id').notNull(),
  employeeId: uuid('employee_id'),
  jobRoleId: uuid('job_role_id'),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  plannedBreakMinutes: smallint('planned_break_minutes').notNull().default(0),
  rotationPatternId: uuid('rotation_pattern_id'),
  status: text('status').notNull().default('draft'),
  publishedAt: ts('published_at'),
});

export const timeEntries = pgTable('time_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  locationId: uuid('location_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  shiftId: uuid('shift_id'),
  clockIn: ts('clock_in').notNull(),
  clockOut: ts('clock_out'),
  deviceClockIn: ts('device_clock_in'),
  deviceClockOut: ts('device_clock_out'),
  method: text('method').notNull(),
  gpsLat: doublePrecision('gps_lat'),
  gpsLng: doublePrecision('gps_lng'),
  capturedOffline: boolean('captured_offline').notNull().default(false),
  idempotencyKey: text('idempotency_key').notNull(),
  status: text('status').notNull().default('open'),
  approvedBy: uuid('approved_by'),
  approvedAt: ts('approved_at'),
  editReason: text('edit_reason'),
});

export const timeEntryBreaks = pgTable('time_entry_breaks', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  timeEntryId: uuid('time_entry_id').notNull(),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at'),
  paid: boolean('paid').notNull().default(false),
});

export const complianceFindings = pgTable('compliance_findings', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  ruleKey: text('rule_key').notNull(),
  severity: text('severity').notNull(),
  subjectType: text('subject_type').notNull(),
  subjectId: uuid('subject_id').notNull(),
  message: text('message').notNull(),
  data: jsonb('data').notNull().default({}),
  overriddenBy: uuid('overridden_by'),
  overrideReason: text('override_reason'),
});

export const tipPools = pgTable('tip_pools', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  locationId: uuid('location_id').notNull(),
  name: text('name').notNull(),
  strategy: text('strategy').notNull(),
  config: jsonb('config').notNull().default({}),
  effectiveFrom: date('effective_from').notNull(),
});

export const shiftTips = pgTable('shift_tips', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  locationId: uuid('location_id').notNull(),
  businessDate: date('business_date').notNull(),
  source: text('source').notNull(),
  amountCents: cents('amount_cents').notNull(),
  employeeId: uuid('employee_id'),
  declaredBy: uuid('declared_by'),
  posReference: text('pos_reference'),
});

export const tipDistributions = pgTable('tip_distributions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  tipPoolId: uuid('tip_pool_id').notNull(),
  businessDate: date('business_date').notNull(),
  employeeId: uuid('employee_id').notNull(),
  amountCents: cents('amount_cents').notNull(),
  basis: jsonb('basis').notNull().default({}),
  payrollRunId: uuid('payroll_run_id'),
});

export const managerLogs = pgTable('manager_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  locationId: uuid('location_id').notNull(),
  entryGroupId: uuid('entry_group_id').notNull(),
  revision: integer('revision').notNull(),
  authorUserId: uuid('author_user_id').notNull(),
  category: text('category').notNull(),
  requiresAck: boolean('requires_ack').notNull().default(false),
  shiftId: uuid('shift_id'),
  employeeId: uuid('employee_id'),
  body: text('body').notNull(),
  attachments: jsonb('attachments').notNull().default([]),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
  createdAt: ts('created_at').notNull(),
});

export const logAcknowledgements = pgTable('log_acknowledgements', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  managerLogId: uuid('manager_log_id').notNull(),
  userId: uuid('user_id').notNull(),
  acknowledgedAt: ts('acknowledged_at').notNull().defaultNow(),
});

export const notificationOutbox = pgTable('notification_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  recipient: jsonb('recipient').notNull(),
  template: text('template').notNull(),
  params: jsonb('params').notNull().default({}),
  channels: text('channels').array().notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  status: text('status').notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
  deliveredVia: text('delivered_via'),
  providerRef: text('provider_ref'),
  lastError: text('last_error'),
  createdAt: ts('created_at').notNull().defaultNow(),
  sentAt: ts('sent_at'),
});

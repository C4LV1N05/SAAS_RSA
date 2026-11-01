/**
 * Payroll: a preview that saves nothing, and saved runs that move
 * draft -> approved -> finalised -> paid. Finalising releases payslips to
 * employees, links the tip shares and leave it paid (so they are never paid
 * twice) and locks the run (database triggers refuse any later change).
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type TenantContext, type Tx } from '@saas-rsa/db';
import { emp201Totals, type PayslipLine } from '@saas-rsa/domain';
import { requirePermission, tenantTx, type Deps } from '../context';
import { bankPaymentCsv, type BankRow } from '../bank-file';
import type { FieldCipher } from '../crypto';
import { audit } from '../data';
import { HttpError, notFound } from '../errors';
import { calculatePayroll, publicPayslip, type PayrollCalculation, type PayrollInput } from '../payroll-calc';
import { renderPayslipPdf, type PayslipSnapshot } from '../payslip-pdf';
import { bankAccountOf } from './employees';

const { payPeriods, payrollRuns, payslips, payslipLines, tipDistributions, leaveTransactions, employees } = schema;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PayrollBody = z
  .object({
    employeeIds: z.array(z.string().uuid()).min(1).max(200),
    periodStart: date,
    periodEnd: date,
    payDate: date,
    frequency: z.enum(['weekly', 'fortnightly', 'monthly']),
    perEmployee: z
      .record(
        z.string().uuid(),
        z.object({
          tipsCents: z.number().int().min(0).optional(),
          medicalCover: z.object({ mainMember: z.boolean(), dependants: z.number().int().min(0).max(20) }).optional(),
          etiEmploymentMonth: z.number().int().min(1).max(24).optional(),
        }),
      )
      .default({}),
  })
  .refine((p) => p.periodEnd >= p.periodStart, { message: 'periodEnd must not be before periodStart' });

const RunParam = z.object({ id: z.string().uuid() });

interface Links {
  tipDistributionIds: string[];
  leaveTransactionIds: string[];
}

/** Save calculated payslips (and their lines) into a run. */
async function savePayslips(tx: Tx, auth: TenantContext, runId: string, calc: PayrollCalculation, input: PayrollInput) {
  for (const p of calc.payslips) {
    const e = p.employee;
    const snapshot: PayslipSnapshot & { links: Links } = {
      employer: calc.employer,
      employee: {
        name: `${e.firstName} ${e.lastName}`,
        jobRole: p.jobRole,
        idHint: e.idNumberHint,
        taxHint: e.taxNumberHint,
        employmentStart: e.employmentStart,
      },
      period: { start: input.periodStart, end: input.periodEnd, payDate: input.payDate, frequency: input.frequency },
      hourlyRateCents: p.hourlyRateCents,
      bank: e.bankAccountHint ? { bankName: e.bankName, hint: e.bankAccountHint } : null,
      links: { tipDistributionIds: p.tipDistributionIds, leaveTransactionIds: p.leaveTransactionIds },
    };
    const [slip] = await tx
      .insert(payslips)
      .values({
        orgId: auth.orgId,
        payrollRunId: runId,
        employeeId: p.employeeId,
        grossCents: p.grossCents,
        deductionsCents: p.deductionsCents,
        netCents: p.netCents,
        employerCostCents: p.employerCostCents,
        etiCents: p.etiCents,
        snapshot,
      })
      .returning({ id: payslips.id });
    if (p.lines.length) {
      await tx.insert(payslipLines).values(
        p.lines.map((l: PayslipLine, i: number) => ({
          orgId: auth.orgId,
          payslipId: slip!.id,
          lineNo: i,
          code: l.code,
          kind: l.kind,
          description: l.description,
          quantityMinutes: l.quantityMinutes ?? null,
          rateCents: l.rateCents ?? null,
          multiplier: l.multiplier !== undefined ? String(l.multiplier) : null,
          amountCents: l.amountCents,
          sarsCode: l.sarsCode ?? null,
          needsReview: l.needsReview ?? false,
        })),
      );
    }
  }
}

async function clearPayslips(tx: Tx, runId: string) {
  const ids = (await tx.select({ id: payslips.id }).from(payslips).where(eq(payslips.payrollRunId, runId))).map((r) => r.id);
  if (ids.length) await tx.delete(payslipLines).where(inArray(payslipLines.payslipId, ids));
  await tx.delete(payslips).where(eq(payslips.payrollRunId, runId));
}

async function getRun(tx: Tx, id: string) {
  const [row] = await tx
    .select({ run: payrollRuns, period: payPeriods })
    .from(payrollRuns)
    .innerJoin(payPeriods, eq(payPeriods.id, payrollRuns.payPeriodId))
    .where(eq(payrollRuns.id, id));
  if (!row) throw notFound('Payroll run');
  return row;
}

const inputOf = (run: typeof payrollRuns.$inferSelect) => (run.ruleSnapshot as { input: PayrollInput }).input;

/** A run with its payslips, lines and EMP201 totals. */
async function runDetail(tx: Tx, id: string) {
  const { run, period } = await getRun(tx, id);
  const slips = await tx.select().from(payslips).where(eq(payslips.payrollRunId, id));
  const lines = slips.length
    ? await tx.select().from(payslipLines).where(inArray(payslipLines.payslipId, slips.map((s) => s.id))).orderBy(asc(payslipLines.lineNo))
    : [];
  const out = slips
    .map((s) => {
      const snap = s.snapshot as PayslipSnapshot;
      return {
        id: s.id,
        employeeId: s.employeeId,
        employeeName: snap.employee?.name ?? '',
        grossCents: s.grossCents,
        deductionsCents: s.deductionsCents,
        netCents: s.netCents,
        employerCostCents: s.employerCostCents,
        etiCents: s.etiCents,
        hasBankDetails: Boolean(snap.bank?.hint),
        lines: lines
          .filter((l) => l.payslipId === s.id)
          .map((l) => ({
            code: l.code,
            kind: l.kind as PayslipLine['kind'],
            description: l.description,
            amountCents: l.amountCents,
            ...(l.quantityMinutes !== null ? { quantityMinutes: l.quantityMinutes } : {}),
            ...(l.sarsCode ? { sarsCode: l.sarsCode } : {}),
            ...(l.needsReview ? { needsReview: true } : {}),
          })),
      };
    })
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
  return {
    run: {
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
      approvedAt: run.approvedAt,
      finalisedAt: run.finalisedAt,
      paidAt: run.paidAt,
      period: { start: period.startsOn, end: period.endsOn, payDate: period.payDate, frequency: period.frequency },
    },
    payslips: out,
    emp201: emp201Totals(out),
  };
}

export function registerPayrollRoutes(app: FastifyInstance, deps: Deps, cipher?: FieldCipher) {
  app.post('/v1/payroll/preview', { preHandler: requirePermission('payroll:run') }, async (request) => {
    const body = PayrollBody.parse(request.body);
    return tenantTx(deps, request, async (tx, auth) => {
      const calc = await calculatePayroll(tx, auth, body);
      return { payslips: calc.payslips.map(publicPayslip), emp201: calc.emp201, warnings: calc.warnings };
    });
  });

  app.get('/v1/payroll/runs', { preHandler: requirePermission('payroll:run') }, async (request) => {
    const runs = await tenantTx(deps, request, (tx) =>
      tx
        .select({
          id: payrollRuns.id,
          status: payrollRuns.status,
          createdAt: payrollRuns.createdAt,
          start: payPeriods.startsOn,
          end: payPeriods.endsOn,
          payDate: payPeriods.payDate,
          frequency: payPeriods.frequency,
          people: sql<number>`(select count(*) from payslips p where p.payroll_run_id = ${payrollRuns.id})::int`,
          netCents: sql<number>`(select coalesce(sum(p.net_cents), 0) from payslips p where p.payroll_run_id = ${payrollRuns.id})::bigint`,
        })
        .from(payrollRuns)
        .innerJoin(payPeriods, eq(payPeriods.id, payrollRuns.payPeriodId))
        .orderBy(desc(payPeriods.startsOn))
        .limit(52),
    );
    return { runs: runs.map((r) => ({ ...r, netCents: Number(r.netCents) })) };
  });

  /** Calculate and save a draft run for a pay period (one run per period). */
  app.post('/v1/payroll/runs', { preHandler: requirePermission('payroll:run') }, async (request, reply) => {
    const body = PayrollBody.parse(request.body);
    const result = await tenantTx(deps, request, async (tx, auth) => {
      const calc = await calculatePayroll(tx, auth, body);
      const [period] = await tx
        .insert(payPeriods)
        .values({ orgId: auth.orgId, frequency: body.frequency, startsOn: body.periodStart, endsOn: body.periodEnd, payDate: body.payDate })
        .onConflictDoUpdate({
          target: [payPeriods.orgId, payPeriods.frequency, payPeriods.startsOn],
          set: { endsOn: body.periodEnd, payDate: body.payDate },
        })
        .returning();
      const [existing] = await tx.select({ id: payrollRuns.id, status: payrollRuns.status }).from(payrollRuns).where(eq(payrollRuns.payPeriodId, period!.id));
      if (existing) throw new HttpError(409, 'run_exists', `There is already a ${existing.status} run for this period`, { runId: existing.id });
      const ruleVersionKeys = [...new Set(calc.payslips.flatMap((p) => p.ruleVersionKeys))].sort();
      const [run] = await tx
        .insert(payrollRuns)
        .values({ orgId: auth.orgId, payPeriodId: period!.id, status: 'draft', createdBy: auth.userId, ruleSnapshot: { ruleVersionKeys, input: body } })
        .returning();
      await savePayslips(tx, auth, run!.id, calc, body);
      await audit(tx, auth, { action: 'payroll.run_created', entity: 'payroll_run', entityId: run!.id, after: { period: body.periodStart, people: body.employeeIds.length } });
      return { detail: await runDetail(tx, run!.id), warnings: calc.warnings };
    });
    return reply.status(201).send(result);
  });

  app.get('/v1/payroll/runs/:id', { preHandler: requirePermission('payroll:run') }, async (request) => {
    const { id } = RunParam.parse(request.params);
    return tenantTx(deps, request, (tx) => runDetail(tx, id));
  });

  /** Work a draft or approved run out again (e.g. after approving more hours). It goes back to draft. */
  app.post('/v1/payroll/runs/:id/recalculate', { preHandler: requirePermission('payroll:run') }, async (request) => {
    const { id } = RunParam.parse(request.params);
    return tenantTx(deps, request, async (tx, auth) => {
      const { run } = await getRun(tx, id);
      if (run.status !== 'draft' && run.status !== 'approved') throw new HttpError(409, 'locked', `This run is ${run.status}; corrections go into the next run`);
      const input = inputOf(run);
      const calc = await calculatePayroll(tx, auth, input);
      await clearPayslips(tx, id);
      await savePayslips(tx, auth, id, calc, input);
      const ruleVersionKeys = [...new Set(calc.payslips.flatMap((p) => p.ruleVersionKeys))].sort();
      await tx.update(payrollRuns).set({ status: 'draft', approvedBy: null, approvedAt: null, ruleSnapshot: { ruleVersionKeys, input } }).where(eq(payrollRuns.id, id));
      await audit(tx, auth, { action: 'payroll.run_recalculated', entity: 'payroll_run', entityId: id });
      return { detail: await runDetail(tx, id), warnings: calc.warnings };
    });
  });

  app.post('/v1/payroll/runs/:id/approve', { preHandler: requirePermission('payroll:run') }, async (request) => {
    const { id } = RunParam.parse(request.params);
    return tenantTx(deps, request, async (tx, auth) => {
      const { run } = await getRun(tx, id);
      if (run.status !== 'draft') throw new HttpError(409, 'not_draft', `This run is ${run.status}`);
      await tx.update(payrollRuns).set({ status: 'approved', approvedBy: auth.userId, approvedAt: new Date() }).where(eq(payrollRuns.id, id));
      await audit(tx, auth, { action: 'payroll.run_approved', entity: 'payroll_run', entityId: id });
      return runDetail(tx, id);
    });
  });

  /** Lock the run, release payslips to employees and mark the tips and leave it paid. */
  app.post('/v1/payroll/runs/:id/finalise', { preHandler: requirePermission('payroll:run') }, async (request) => {
    const { id } = RunParam.parse(request.params);
    return tenantTx(deps, request, async (tx, auth) => {
      const { run } = await getRun(tx, id);
      if (run.status !== 'approved') throw new HttpError(409, 'not_approved', run.status === 'draft' ? 'Approve the run before finalising it' : `This run is ${run.status}`);
      const slips = await tx.select({ id: payslips.id, snapshot: payslips.snapshot }).from(payslips).where(eq(payslips.payrollRunId, id));
      const tipIds = slips.flatMap((s) => (s.snapshot as { links?: Links }).links?.tipDistributionIds ?? []);
      const leaveIds = slips.flatMap((s) => (s.snapshot as { links?: Links }).links?.leaveTransactionIds ?? []);
      if (tipIds.length) {
        const linked = await tx.update(tipDistributions).set({ payrollRunId: id }).where(and(inArray(tipDistributions.id, tipIds), isNull(tipDistributions.payrollRunId))).returning({ id: tipDistributions.id });
        if (linked.length !== tipIds.length) throw new HttpError(409, 'stale', 'Some tips were paid elsewhere since this run was calculated. Recalculate it.');
      }
      if (leaveIds.length) {
        const linked = await tx.update(leaveTransactions).set({ payrollRunId: id }).where(and(inArray(leaveTransactions.id, leaveIds), isNull(leaveTransactions.payrollRunId))).returning({ id: leaveTransactions.id });
        if (linked.length !== leaveIds.length) throw new HttpError(409, 'stale', 'Some leave changed since this run was calculated. Recalculate it.');
      }
      // Release before locking: once the run is finalised, payslips cannot change at all.
      await tx.update(payslips).set({ releasedAt: new Date() }).where(eq(payslips.payrollRunId, id));
      await tx.update(payrollRuns).set({ status: 'finalised', finalisedAt: new Date() }).where(eq(payrollRuns.id, id));
      await audit(tx, auth, { action: 'payroll.run_finalised', entity: 'payroll_run', entityId: id, after: { payslips: slips.length, tips: tipIds.length, leave: leaveIds.length } });
      return runDetail(tx, id);
    });
  });

  app.post('/v1/payroll/runs/:id/paid', { preHandler: requirePermission('payroll:run') }, async (request) => {
    const { id } = RunParam.parse(request.params);
    return tenantTx(deps, request, async (tx, auth) => {
      const { run } = await getRun(tx, id);
      if (run.status !== 'finalised') throw new HttpError(409, 'not_finalised', `This run is ${run.status}`);
      await tx.update(payrollRuns).set({ status: 'paid', paidAt: new Date(), paidBy: auth.userId }).where(eq(payrollRuns.id, id));
      await audit(tx, auth, { action: 'payroll.run_paid', entity: 'payroll_run', entityId: id });
      return runDetail(tx, id);
    });
  });

  app.delete('/v1/payroll/runs/:id', { preHandler: requirePermission('payroll:run') }, async (request) => {
    const { id } = RunParam.parse(request.params);
    return tenantTx(deps, request, async (tx, auth) => {
      const { run } = await getRun(tx, id);
      if (run.status !== 'draft' && run.status !== 'approved') throw new HttpError(409, 'locked', `A ${run.status} run cannot be deleted`);
      await clearPayslips(tx, id);
      await tx.delete(payrollRuns).where(eq(payrollRuns.id, id));
      await audit(tx, auth, { action: 'payroll.run_deleted', entity: 'payroll_run', entityId: id });
      return { deleted: true };
    });
  });

  /** CSV of net pay per employee for the bank's bulk-payment import. */
  app.get('/v1/payroll/runs/:id/bank-file', { preHandler: requirePermission('payroll:run') }, async (request, reply) => {
    const { id } = RunParam.parse(request.params);
    const { skipMissing } = z.object({ skipMissing: z.enum(['true', 'false']).default('false') }).parse(request.query);
    if (!cipher) throw new HttpError(503, 'encryption_unavailable', 'Field encryption is not configured');
    const csv = await tenantTx(deps, request, async (tx, auth) => {
      const { run, period } = await getRun(tx, id);
      if (run.status !== 'finalised' && run.status !== 'paid') throw new HttpError(409, 'not_finalised', 'Finalise the run before downloading the bank file');
      const slips = await tx
        .select({ slip: payslips, employee: employees })
        .from(payslips)
        .innerJoin(employees, eq(employees.id, payslips.employeeId))
        .where(eq(payslips.payrollRunId, id));
      const missing = slips.filter((s) => !s.employee.bankAccountEnc).map((s) => `${s.employee.firstName} ${s.employee.lastName}`);
      if (missing.length && skipMissing !== 'true') {
        throw new HttpError(422, 'missing_bank_details', `No bank details for ${missing.join(', ')}`, { missing });
      }
      const rows: BankRow[] = slips
        .filter((s) => s.employee.bankAccountEnc && s.slip.netCents > 0)
        .map((s) => ({
          name: s.employee.bankAccountHolder ?? `${s.employee.firstName} ${s.employee.lastName}`,
          bankName: s.employee.bankName ?? '',
          branchCode: s.employee.bankBranchCode ?? '',
          accountNumber: bankAccountOf(cipher, s.employee)!,
          accountType: s.employee.bankAccountType ?? 'savings',
          amountCents: s.slip.netCents,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const employer = ((slips[0]?.slip.snapshot as PayslipSnapshot | undefined)?.employer.tradingName ?? (slips[0]?.slip.snapshot as PayslipSnapshot | undefined)?.employer.legalName) ?? 'WAGES';
      await audit(tx, auth, { action: 'payroll.bank_file_downloaded', entity: 'payroll_run', entityId: id, after: { rows: rows.length, skipped: missing } });
      return { body: bankPaymentCsv(rows, { employer, payDate: period.payDate }), payDate: period.payDate };
    });
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="bank-payments-${csv.payDate}.csv"`)
      .header('cache-control', 'no-store')
      .send(csv.body);
  });

  /**
   * A payslip as PDF. Payroll staff can open any payslip in a run; employees
   * (including managers) can open their own once it is released. RLS decides.
   */
  app.get('/v1/payslips/:id/pdf', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const pdf = await tenantTx(deps, request, async (tx) => {
      const [slip] = await tx.select().from(payslips).where(eq(payslips.id, id));
      if (!slip) throw notFound('Payslip');
      const lines = await tx.select().from(payslipLines).where(eq(payslipLines.payslipId, id)).orderBy(asc(payslipLines.lineNo));
      const snap = slip.snapshot as PayslipSnapshot;
      return {
        name: snap.employee.name,
        payDate: snap.period.payDate,
        body: await renderPayslipPdf(snap, lines, slip),
      };
    });
    const file = `payslip-${pdf.name.replace(/[^A-Za-z0-9]+/g, '-')}-${pdf.payDate}.pdf`;
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${file}"`).header('cache-control', 'private, no-store').send(pdf.body);
  });

  /** The signed-in person's released payslips. */
  app.get('/v1/me/payslips', async (request) => {
    const rows = await tenantTx(deps, request, async (tx) => {
      const own = await tx.select().from(payslips).where(sql`${payslips.employeeId} = app.current_employee_id() and ${payslips.releasedAt} is not null`);
      return own
        .map((s) => {
          const snap = s.snapshot as PayslipSnapshot;
          return { id: s.id, payDate: snap.period.payDate, periodStart: snap.period.start, periodEnd: snap.period.end, grossCents: s.grossCents, netCents: s.netCents };
        })
        .sort((a, b) => b.payDate.localeCompare(a.payDate));
    });
    return { payslips: rows };
  });
}

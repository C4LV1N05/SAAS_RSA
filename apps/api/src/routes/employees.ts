/**
 * Pay-related personal details: SA ID, tax and bank numbers, encrypted field by
 * field (crypto.ts). Reads are masked; seeing a full number is a deliberate
 * "reveal" that is written to the audit log. Owners and payroll admins only.
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Tx } from '@saas-rsa/db';
import { BANK_ACCOUNT_TYPES, checkBankDetails, checkSaIdNumber, checkTaxNumber } from '@saas-rsa/domain';
import { requirePermission, tenantTx, type Deps } from '../context';
import { employeeAad, type FieldCipher } from '../crypto';
import { audit, getEmployee, type EmployeeRow } from '../data';
import { HttpError } from '../errors';

const { employees } = schema;

const digits = (s: string) => s.replace(/\s/g, '');
const UpdatePersonal = z
  .object({
    idNumber: z.string().max(20).nullable().optional(),
    taxNumber: z.string().max(20).nullable().optional(),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    bank: z
      .object({
        holder: z.string().min(2).max(120),
        bankName: z.string().min(2).max(60),
        branchCode: z.string(),
        accountNumber: z.string().max(30),
        accountType: z.enum(BANK_ACCOUNT_TYPES),
      })
      .nullable()
      .optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });

export interface PersonalView {
  idNumber: string | null;
  taxNumber: string | null;
  dateOfBirth: string | null;
  bank: { holder: string; bankName: string; branchCode: string; accountType: string; accountNumber: string } | null;
  revealed: boolean;
  updatedAt: Date | null;
}

/** Decrypt an employee's bank account number; used by the bank payment file. */
export function bankAccountOf(cipher: FieldCipher, e: EmployeeRow): string | null {
  return e.bankAccountEnc ? cipher.decrypt(e.bankAccountEnc, employeeAad(e.orgId, e.id, 'bank_account')) : null;
}

function view(cipher: FieldCipher, e: EmployeeRow, reveal: boolean): PersonalView {
  const open = (blob: Buffer | null, field: 'id_number' | 'tax_number' | 'bank_account', hint: string | null) => {
    if (!blob) return null;
    return reveal ? cipher.decrypt(blob, employeeAad(e.orgId, e.id, field)) : `••••••${hint ?? ''}`;
  };
  return {
    idNumber: open(e.idNumberEnc, 'id_number', e.idNumberHint),
    taxNumber: open(e.taxNumberEnc, 'tax_number', e.taxNumberHint),
    dateOfBirth: e.dateOfBirth,
    bank: e.bankAccountEnc
      ? {
          holder: e.bankAccountHolder ?? '',
          bankName: e.bankName ?? '',
          branchCode: e.bankBranchCode ?? '',
          accountType: e.bankAccountType ?? '',
          accountNumber: open(e.bankAccountEnc, 'bank_account', e.bankAccountHint)!,
        }
      : null,
    revealed: reveal,
    updatedAt: e.personalUpdatedAt,
  };
}

async function load(tx: Tx, id: string) {
  return getEmployee(tx, id);
}

export function registerEmployeeRoutes(app: FastifyInstance, deps: Deps, cipher: FieldCipher | undefined) {
  const need = () => {
    if (!cipher) throw new HttpError(503, 'encryption_unavailable', 'Field encryption is not configured');
    return cipher;
  };

  app.get('/v1/employees/:id/personal', { preHandler: requirePermission('payroll:run') }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { reveal } = z.object({ reveal: z.enum(['true', 'false']).default('false') }).parse(request.query);
    const c = need();
    return tenantTx(deps, request, async (tx, auth) => {
      const e = await load(tx, id);
      if (reveal === 'true') {
        await audit(tx, auth, { action: 'employee.personal_revealed', entity: 'employee', entityId: id });
      }
      return { personal: view(c, e, reveal === 'true') };
    });
  });

  app.put('/v1/employees/:id/personal', { preHandler: requirePermission('payroll:run') }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = UpdatePersonal.parse(request.body);
    const c = need();
    const warnings: string[] = [];
    const set: Partial<typeof employees.$inferInsert> = {};

    return tenantTx(deps, request, async (tx, auth) => {
      const e = await load(tx, id);
      const aad = (f: 'id_number' | 'tax_number' | 'bank_account') => employeeAad(auth.orgId, id, f);

      if (body.idNumber !== undefined) {
        if (body.idNumber === null || body.idNumber.trim() === '') Object.assign(set, { idNumberEnc: null, idNumberHint: null });
        else {
          const n = digits(body.idNumber);
          const check = checkSaIdNumber(n);
          if (!check.valid) throw new HttpError(400, 'invalid_id_number', check.reason);
          Object.assign(set, { idNumberEnc: c.encrypt(n, aad('id_number')), idNumberHint: n.slice(-4) });
          if (!e.dateOfBirth && !body.dateOfBirth) set.dateOfBirth = check.dateOfBirth;
          else if ((body.dateOfBirth ?? e.dateOfBirth) !== check.dateOfBirth) warnings.push('The date of birth does not match the ID number');
        }
      }
      if (body.taxNumber !== undefined) {
        if (body.taxNumber === null || body.taxNumber.trim() === '') Object.assign(set, { taxNumberEnc: null, taxNumberHint: null });
        else {
          const n = digits(body.taxNumber);
          const check = checkTaxNumber(n);
          if (!check.valid) throw new HttpError(400, 'invalid_tax_number', check.reason);
          if (check.warning) warnings.push(check.warning);
          Object.assign(set, { taxNumberEnc: c.encrypt(n, aad('tax_number')), taxNumberHint: n.slice(-4) });
        }
      }
      if (body.dateOfBirth) set.dateOfBirth = body.dateOfBirth;
      if (body.bank !== undefined) {
        if (body.bank === null) {
          Object.assign(set, { bankAccountEnc: null, bankAccountHint: null, bankName: null, bankBranchCode: null, bankAccountType: null, bankAccountHolder: null });
        } else {
          const b = { ...body.bank, accountNumber: digits(body.bank.accountNumber), branchCode: digits(body.bank.branchCode) };
          const check = checkBankDetails(b);
          if (!check.valid) throw new HttpError(400, 'invalid_bank_details', check.reason);
          Object.assign(set, {
            bankAccountEnc: c.encrypt(b.accountNumber, aad('bank_account')),
            bankAccountHint: b.accountNumber.slice(-4),
            bankName: b.bankName,
            bankBranchCode: b.branchCode,
            bankAccountType: b.accountType,
            bankAccountHolder: b.holder.trim(),
          });
        }
      }

      set.personalUpdatedAt = new Date();
      const [after] = await tx.update(employees).set(set).where(eq(employees.id, id)).returning();
      if (!after) throw new HttpError(403, 'forbidden', 'You cannot change this employee');
      // The audit log records which fields changed, never the numbers themselves.
      await audit(tx, auth, {
        action: 'employee.personal_updated',
        entity: 'employee',
        entityId: id,
        after: { fields: Object.keys(body) },
      });
      return { personal: view(c, after, false), warnings };
    });
  });
}

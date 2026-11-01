/**
 * Bank payment file for a finalised payroll run: one row per employee with their
 * net pay. SA banks each have their own bulk-payment template, but all of them
 * ask for these columns, so this CSV maps straight onto the bank's import screen
 * (Standard Bank, FNB, ABSA, Nedbank and Capitec Business all accept CSV imports).
 */
export interface BankRow {
  name: string;
  bankName: string;
  branchCode: string;
  accountNumber: string;
  accountType: string;
  amountCents: number;
}

const ACCOUNT_TYPE_CODE: Record<string, string> = { cheque: '1', savings: '2', transmission: '3' };

/** Bank references allow letters, numbers and spaces, up to 20 characters. */
export const reference = (s: string) => s.replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);

const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function bankPaymentCsv(rows: BankRow[], refs: { employer: string; payDate: string }): string {
  const header = ['Beneficiary name', 'Bank', 'Branch code', 'Account number', 'Account type', 'Account type code', 'Amount', 'Beneficiary reference', 'Own reference'];
  const own = reference(`PAY ${refs.payDate}`);
  const theirs = reference(`${refs.employer} SALARY`);
  const body = rows.map((r) =>
    [
      r.name,
      r.bankName,
      r.branchCode,
      r.accountNumber,
      r.accountType,
      ACCOUNT_TYPE_CODE[r.accountType] ?? '',
      (r.amountCents / 100).toFixed(2),
      theirs,
      own,
    ]
      .map(cell)
      .join(','),
  );
  return [header.join(','), ...body].join('\r\n') + '\r\n';
}

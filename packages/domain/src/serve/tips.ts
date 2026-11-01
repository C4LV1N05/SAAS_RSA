/**
 * Who receives a tip paid with a table's bill:
 *   1. the waiter whose personal tip QR code the guest scanned, else
 *   2. the waiter assigned to that table when the payment is recorded, else
 *   3. the location's tip pool (shared out by the existing tip module).
 */
export interface TableAssignment {
  employeeId: string;
  tableId: string;
  startsAt: Date;
  endsAt: Date;
}

export type TipRecipient =
  | { source: 'tip_code' | 'table_assignment'; employeeId: string }
  | { source: 'pool'; employeeId: null };

export function resolveTipRecipient(input: {
  tipCodeEmployeeId?: string | null;
  tableId: string;
  at: Date;
  assignments: readonly TableAssignment[];
}): TipRecipient {
  if (input.tipCodeEmployeeId) return { source: 'tip_code', employeeId: input.tipCodeEmployeeId };
  const current = input.assignments
    .filter((a) => a.tableId === input.tableId && a.startsAt <= input.at && input.at < a.endsAt)
    // Overlapping assignments: the most recently started one wins.
    .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())[0];
  return current ? { source: 'table_assignment', employeeId: current.employeeId } : { source: 'pool', employeeId: null };
}

/**
 * Payslip PDF. BCEA s33 says what a payslip must show: employer name and address,
 * employee name and job, period, rate, hours (ordinary and overtime), gross pay,
 * each deduction, net pay, and any other payments. Everything here comes from the
 * payslip's frozen snapshot and lines, so a reprint always matches the original.
 */
import PDFDocument from 'pdfkit';

export interface PayslipSnapshot {
  employer: { legalName: string; tradingName: string | null; payeReference: string | null; uifReference: string | null };
  employee: { name: string; jobRole: string | null; idHint: string | null; taxHint: string | null; employmentStart: string };
  period: { start: string; end: string; payDate: string; frequency: string };
  hourlyRateCents: number;
  bank: { bankName: string | null; hint: string | null } | null;
}

export interface PdfLine {
  code: string;
  kind: string;
  description: string;
  quantityMinutes: number | null;
  rateCents: number | null;
  amountCents: number;
  sarsCode: string | null;
}

const rand = (cents: number) => {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}R ${Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${String(abs % 100).padStart(2, '0')}`;
};
const hours = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
const day = (d: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${d}T00:00:00Z`));

export function renderPayslipPdf(s: PayslipSnapshot, lines: PdfLine[], totals: { grossCents: number; deductionsCents: number; netCents: number }): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Payslip ${s.employee.name} ${s.period.payDate}`, Author: s.employer.legalName } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const navy = '#1B2F4E';
  const grey = '#5B6472';
  const left = 48;
  const right = doc.page.width - 48;
  const width = right - left;

  // Header
  doc.fillColor(navy).font('Helvetica-Bold').fontSize(18).text(s.employer.tradingName ?? s.employer.legalName, left, 48);
  doc.font('Helvetica').fontSize(9).fillColor(grey);
  if (s.employer.tradingName) doc.text(s.employer.legalName);
  doc.text([s.employer.payeReference && `PAYE ${s.employer.payeReference}`, s.employer.uifReference && `UIF ${s.employer.uifReference}`].filter(Boolean).join('   ') || ' ');
  doc.font('Helvetica-Bold').fontSize(22).fillColor(navy).text('Payslip', left, 48, { width, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor(grey).text(`Paid ${day(s.period.payDate)}`, left, 76, { width, align: 'right' });

  // Employee block
  let y = 120;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1.5).strokeColor(navy).stroke();
  y += 12;
  const field = (label: string, value: string, x: number, yy: number) => {
    doc.font('Helvetica').fontSize(8).fillColor(grey).text(label.toUpperCase() === label ? label : label, x, yy);
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(navy).text(value, x, yy + 11, { width: width / 3 - 8 });
  };
  field('Employee', s.employee.name, left, y);
  field('Job', s.employee.jobRole ?? '-', left + width / 3, y);
  field('Pay period', `${day(s.period.start)} - ${day(s.period.end)}`, left + (2 * width) / 3, y);
  y += 36;
  field('ID number', s.employee.idHint ? `******${s.employee.idHint}` : 'Not on file', left, y);
  field('Tax number', s.employee.taxHint ? `******${s.employee.taxHint}` : 'Not on file', left + width / 3, y);
  field('Hourly rate', rand(s.hourlyRateCents), left + (2 * width) / 3, y);
  y += 44;

  // Lines
  const section = (title: string, rows: PdfLine[], sign: 1 | -1) => {
    if (!rows.length) return;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(navy).text(title, left, y);
    doc.font('Helvetica').fontSize(8).fillColor(grey);
    doc.text('Hours', left + width * 0.5, y + 1, { width: 60, align: 'right' });
    doc.text('Rate', left + width * 0.62, y + 1, { width: 70, align: 'right' });
    doc.text('Amount', right - 90, y + 1, { width: 90, align: 'right' });
    y += 16;
    for (const l of rows) {
      doc.font('Helvetica').fontSize(10).fillColor(navy).text(l.description, left, y, { width: width * 0.48 });
      if (l.sarsCode) doc.fontSize(7).fillColor(grey).text(`IRP5 ${l.sarsCode}`, left, y + 12);
      doc.fontSize(10).fillColor(navy);
      if (l.quantityMinutes) doc.text(hours(l.quantityMinutes), left + width * 0.5, y, { width: 60, align: 'right' });
      if (l.rateCents) doc.text(rand(l.rateCents), left + width * 0.62, y, { width: 70, align: 'right' });
      doc.text(rand(sign * l.amountCents), right - 90, y, { width: 90, align: 'right' });
      y += l.sarsCode ? 24 : 18;
    }
    y += 6;
  };
  section('Earnings', lines.filter((l) => l.kind === 'earning' || l.kind === 'tip'), 1);
  section('Deductions', lines.filter((l) => l.kind === 'deduction'), -1);

  // Totals
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(navy).stroke();
  y += 10;
  const total = (label: string, cents: number, big = false) => {
    doc.font(big ? 'Helvetica-Bold' : 'Helvetica').fontSize(big ? 14 : 10.5).fillColor(navy);
    doc.text(label, left + width * 0.5, y, { width: width * 0.3 });
    doc.text(rand(cents), right - 120, y, { width: 120, align: 'right' });
    y += big ? 24 : 18;
  };
  total('Gross pay', totals.grossCents);
  total('Deductions', -totals.deductionsCents);
  total('Net pay', totals.netCents, true);
  if (s.bank?.hint) {
    doc.font('Helvetica').fontSize(9).fillColor(grey).text(`Paid into ${s.bank.bankName ?? 'bank'} account ******${s.bank.hint}`, left + width * 0.5, y);
    y += 18;
  }

  const employer = lines.filter((l) => l.kind === 'employer_contribution');
  if (employer.length) {
    y += 10;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(grey).text('Paid by your employer (not deducted from your pay)', left, y);
    y += 14;
    for (const l of employer) {
      doc.font('Helvetica').fontSize(9).fillColor(grey).text(l.description, left, y);
      doc.text(rand(l.amountCents), right - 90, y, { width: 90, align: 'right' });
      y += 14;
    }
  }

  doc.font('Helvetica').fontSize(7.5).fillColor(grey).text(
    `Employed since ${day(s.employee.employmentStart)}. Tips are paid through payroll and never count toward the minimum wage. Questions about this payslip? Ask your manager.`,
    left,
    doc.page.height - 72,
    { width },
  );
  doc.end();
  return done;
}

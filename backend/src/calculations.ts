export interface LoanItem {
  id?: string;
  amount: number | string;
  status: "PENDING" | "REPAID";
  dueDate: string | Date;
  customOverdueAmount?: number | string | null;
}

export interface FinancialSummary {
  totalLent: number;
  totalRepaid: number;
  overdueAmount: number;
  outstandingAmount: number;
}

/**
 * Pure function to calculate financial totals and overdue status.
 * All amounts are rounded to 2 decimal places to prevent floating-point inaccuracies.
 */
export function calculateLoanSummary(
  loans: LoanItem[],
  referenceDate: Date = new Date()
): FinancialSummary {
  const refYear = referenceDate.getUTCFullYear();
  const refMonth = referenceDate.getUTCMonth();
  const refDay = referenceDate.getUTCDate();
  const startOfRefUTC = new Date(Date.UTC(refYear, refMonth, refDay)).getTime();

  let totalLent = 0;
  let totalRepaid = 0;
  let overdueAmount = 0;

  for (const loan of loans) {
    const amount = Number(loan.amount) || 0;
    totalLent += amount;

    if (loan.status === "REPAID") {
      totalRepaid += amount;
    } else if (loan.status === "PENDING") {
      const dueTime = typeof loan.dueDate === "string"
        ? new Date(`${loan.dueDate.slice(0, 10)}T00:00:00.000Z`).getTime()
        : new Date(Date.UTC(loan.dueDate.getUTCFullYear(), loan.dueDate.getUTCMonth(), loan.dueDate.getUTCDate())).getTime();

      if (dueTime < startOfRefUTC) {
        const custom = loan.customOverdueAmount !== undefined && loan.customOverdueAmount !== null
          ? Number(loan.customOverdueAmount)
          : NaN;
        overdueAmount += Number.isFinite(custom) && custom >= 0 ? custom : amount;
      }
    }
  }

  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

  return {
    totalLent: round2(totalLent),
    totalRepaid: round2(totalRepaid),
    overdueAmount: round2(overdueAmount),
    outstandingAmount: round2(totalLent - totalRepaid),
  };
}

/**
 * Checks if a single loan is overdue based on reference date.
 * Repaid loans are NEVER overdue.
 */
export function isLoanOverdue(
  loan: { status: "PENDING" | "REPAID"; dueDate: string | Date },
  referenceDate: Date = new Date()
): boolean {
  if (loan.status === "REPAID") return false;

  const refTime = new Date(
    Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), referenceDate.getUTCDate())
  ).getTime();

  const dueTime = typeof loan.dueDate === "string"
    ? new Date(`${loan.dueDate.slice(0, 10)}T00:00:00.000Z`).getTime()
    : new Date(Date.UTC(loan.dueDate.getUTCFullYear(), loan.dueDate.getUTCMonth(), loan.dueDate.getUTCDate())).getTime();

  return dueTime < refTime;
}

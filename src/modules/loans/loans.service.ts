import { Prisma, TransactionKind } from "@prisma/client";
import { assertNotBeforeJoin } from "../../lib/joinDate";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../utils/asyncHandler";
import { dayKeyInZone, monthKeyInZone, startOfTomorrowInZone } from "../../utils/date";
import { invalidateUserDashboard } from "../../lib/cache";
import { inSerializableTransaction } from "../../lib/serializable";
import { clampPositive, min, money, subtract, toNumber } from "../../utils/money";

export interface CreateLoanInput {
  type: "LENT" | "BORROWED";
  personName: string;
  amount: number;
  dueDate?: string | null;
  notes?: string | null;
  /**
   * Whether the principal actually changed hands now.
   *
   * Defaults to true, because usually it did. Set false to record a debt that predates the app
   * ("I've owed Ali 5,000 since last year") without fabricating a cash movement today.
   */
  recordCashflow?: boolean;
  /** When the money moved (D-62). Defaults to now; never in the future (D-63). */
  date?: Date;
}

export interface UpdateLoanInput {
  personName?: string;
  amount?: number;
  dueDate?: string | null;
  notes?: string | null;
  date?: Date;
}

const SETTLEMENT_KINDS: TransactionKind[] = ["COLLECT", "REPAY"];

/**
 * A loan as of the end of `month` (D-9, D-62): whether it's open by then, what had been repaid by
 * then, and whether it was still outstanding when the month began. The dashboard's debt position
 * and `GET /loans?month` both use this, so the Loans tab's totals and Home's always agree.
 */
export function loanAsOfMonth(
  loan: { amount: Prisma.Decimal; date: Date },
  settlements: { amount: Prisma.Decimal; month: string }[],
  month: string,
  timezone: string
) {
  const opened = monthKeyInZone(loan.date, timezone) <= month;
  const repaidBy = settlements.filter((s) => s.month <= month).reduce((t, s) => t.add(s.amount), money(0));
  const repaidBefore = settlements.filter((s) => s.month < month).reduce((t, s) => t.add(s.amount), money(0));
  const settledAmount = min(repaidBy, loan.amount);
  const remaining = clampPositive(subtract(loan.amount, repaidBy));
  // Of what was still owed at the month's end, the part repaid in later months. A past month's
  // figures stay as they were then (D-9); this lets the app say "since paid back" next to them.
  const repaidAfter = settlements.filter((s) => s.month > month).reduce((t, s) => t.add(s.amount), money(0));
  const repaidSince = min(repaidAfter, remaining);
  return {
    opened,
    repaidSince,
    // Shown in `month` if open by its end and not already cleared before it began.
    visible: opened && subtract(loan.amount, repaidBefore).greaterThan(0),
    settledAmount,
    remaining,
    status: (remaining.isZero() ? "SETTLED" : settledAmount.greaterThan(0) ? "PARTIAL" : "PENDING") as
      | "PENDING"
      | "PARTIAL"
      | "SETTLED",
  };
}

/** A loan's date must not be in the user's future (D-63). */
function assertNotFuture(date: Date, timezone: string, what: string) {
  if (date.getTime() >= startOfTomorrowInZone(new Date(), timezone).getTime()) {
    throw new AppError(400, `${what} can't be in the future`);
  }
}

function serializeLoan(loan: {
  id: string;
  userId: string;
  type: string;
  personName: string;
  amount: Prisma.Decimal;
  settledAmount: Prisma.Decimal;
  dueDate: Date | null;
  status: string;
  notes: string | null;
  date: Date;
  createdAt: Date;
  updatedAt: Date;
}) {
  const remaining = clampPositive(subtract(loan.amount, loan.settledAmount));
  return {
    id: loan.id,
    userId: loan.userId,
    type: loan.type,
    personName: loan.personName,
    amount: toNumber(loan.amount),
    settledAmount: toNumber(loan.settledAmount),
    remainingAmount: toNumber(remaining),
    dueDate: loan.dueDate ? loan.dueDate.toISOString() : null,
    status: loan.status,
    notes: loan.notes,
    date: loan.date.toISOString(),
    createdAt: loan.createdAt.toISOString(),
    updatedAt: loan.updatedAt.toISOString(),
  };
}

type LoanFilters = { type?: "LENT" | "BORROWED"; status?: "PENDING" | "PARTIAL" | "SETTLED" };

function loanWhere(userId: string, filters?: LoanFilters): Prisma.LoanWhereInput {
  const where: Prisma.LoanWhereInput = { userId };
  if (filters?.type) where.type = filters.type;
  if (filters?.status) where.status = filters.status;
  return where;
}

/** Every loan, as of today. Unchanged for older builds. */
export async function getLoans(userId: string, filters?: LoanFilters) {
  const loans = await prisma.loan.findMany({
    where: loanWhere(userId, filters),
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
  return loans.map(serializeLoan);
}

/**
 * The Loans tab's month view (R-41): the loans visible in `month`, each carrying its position as
 * of that month's end in `asOf`. The top-level fields stay today's, because the settle sheet acts
 * on today's loan (D-63).
 */
export async function getLoansForMonth(userId: string, month: string, filters?: LoanFilters) {
  const where = loanWhere(userId, filters);
  const [loans, settlements, timezone] = await Promise.all([
    prisma.loan.findMany({ where, orderBy: [{ date: "desc" }, { id: "desc" }] }),
    prisma.transaction.findMany({
      where: { userId, loanId: { not: null }, kind: { in: SETTLEMENT_KINDS } },
      select: { loanId: true, amount: true, month: true, date: true },
    }),
    userTimezone(prisma, userId),
  ]);
  const byLoan = new Map<string, { amount: Prisma.Decimal; month: string; date: Date }[]>();
  for (const s of settlements) {
    if (!s.loanId) continue;
    byLoan.set(s.loanId, [...(byLoan.get(s.loanId) ?? []), s]);
  }

  return loans.flatMap((loan) => {
    const asOf = loanAsOfMonth(loan, byLoan.get(loan.id) ?? [], month, timezone);
    if (!asOf.visible) return [];
    return [
      {
        ...serializeLoan(loan),
        asOf: {
          settledAmount: toNumber(asOf.settledAmount),
          remainingAmount: toNumber(asOf.remaining),
          status: asOf.status,
          // After this month: how much of `remainingAmount` has been repaid since, and the day the
          // loan was cleared if it has been (Bilal: a past month mustn't look stale).
          repaidSince: toNumber(asOf.repaidSince),
          settledOn: asOf.remaining.greaterThan(0) ? settledOnAfter(loan, byLoan.get(loan.id) ?? [], month) : null,
        },
      },
    ];
  });
}

/** The day a now-settled loan was cleared, when that happened after `month`; otherwise null. */
function settledOnAfter(
  loan: { status: string },
  settlements: { month: string; date: Date }[],
  month: string,
): string | null {
  if (loan.status !== "SETTLED") return null;
  const last = settlements.reduce<Date | null>((latest, s) => (!latest || s.date > latest ? s.date : latest), null);
  if (!last || !settlements.some((s) => s.month > month)) return null;
  return last.toISOString();
}

export async function getLoansSummary(userId: string) {
  const loans = await prisma.loan.findMany({ where: { userId } });

  let totalLentPending = money(0);
  let totalBorrowedPending = money(0);
  let totalLentOverall = money(0);
  let totalBorrowedOverall = money(0);
  let activeLentCount = 0;
  let activeBorrowedCount = 0;

  for (const loan of loans) {
    const remaining = clampPositive(subtract(loan.amount, loan.settledAmount));
    const isActive = loan.status !== "SETTLED";

    if (loan.type === "LENT") {
      totalLentOverall = totalLentOverall.add(loan.amount);
      if (isActive) {
        totalLentPending = totalLentPending.add(remaining);
        activeLentCount++;
      }
    } else {
      totalBorrowedOverall = totalBorrowedOverall.add(loan.amount);
      if (isActive) {
        totalBorrowedPending = totalBorrowedPending.add(remaining);
        activeBorrowedCount++;
      }
    }
  }

  return {
    totalLentPending: toNumber(totalLentPending),
    totalBorrowedPending: toNumber(totalBorrowedPending),
    netBalance: toNumber(subtract(totalLentPending, totalBorrowedPending)),
    totalLentOverall: toNumber(totalLentOverall),
    totalBorrowedOverall: toNumber(totalBorrowedOverall),
    activeLentCount,
    activeBorrowedCount,
    totalActiveCount: activeLentCount + activeBorrowedCount,
  };
}

async function userTimezone(
  tx: Prisma.TransactionClient | typeof prisma,
  userId: string
): Promise<string> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  return user?.timezone ?? "Asia/Karachi";
}

export async function createLoan(userId: string, input: CreateLoanInput) {
  if (input.amount <= 0) {
    throw new AppError(400, "Amount must be greater than zero");
  }

  const recordCashflow = input.recordCashflow ?? true;
  const personName = input.personName.trim();
  const timezone = await userTimezone(prisma, userId);
  // When the money moved: now unless the user backdated it, never in the future (D-62, D-63).
  const date = input.date ?? new Date();
  assertNotFuture(date, timezone, "A loan's date");
  await assertNotBeforeJoin(prisma, userId, date);

  const loan = await prisma.$transaction(async (tx) => {
    const created = await tx.loan.create({
      data: {
        userId,
        type: input.type,
        personName,
        date,
        amount: money(input.amount),
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        notes: input.notes?.trim() || null,
        status: "PENDING",
        settledAmount: money(0),
      },
    });

    // The principal moving is itself a cash event. Omitting it is what made the ledger
    // asymmetric: settlement credited cash with nothing ever having debited it, so lending
    // money and collecting it back invented net worth.
    if (recordCashflow) {
      await tx.transaction.create({
        data: {
          userId,
          kind: input.type === "LENT" ? "LEND_OUT" : "BORROW_IN",
          amount: money(input.amount),
          date,
          month: monthKeyInZone(date, timezone),
          description:
            input.type === "LENT" ? `Lent to ${personName}` : `Borrowed from ${personName}`,
          paymentMethod: "Cash",
          loanId: created.id,
        },
      });
    }

    return created;
  });

  invalidateUserDashboard(userId);
  return serializeLoan(loan);
}

/**
 * Records a payment against a loan and the cash movement that goes with it.
 *
 * Collecting a loan you made credits cash (COLLECT); repaying a debt debits it (REPAY). Neither
 * counts as income or spending — a transfer is not an expense, so settling a large debt no
 * longer detonates the month's budget the way the old auto-generated Expense did.
 */
export async function settleLoan(
  userId: string,
  loanId: string,
  paymentAmount?: number,
  settledOn?: Date
) {
  if (paymentAmount !== undefined && paymentAmount <= 0) {
    throw new AppError(400, "Payment amount must be greater than zero");
  }

  const updated = await inSerializableTransaction(async (tx) => {
    const loan = await tx.loan.findFirst({ where: { id: loanId, userId } });
    if (!loan) throw new AppError(404, "Loan record not found");

    const remaining = clampPositive(subtract(loan.amount, loan.settledAmount));
    if (loan.status === "SETTLED" || !remaining.greaterThan(0)) {
      throw new AppError(400, "Loan is already fully settled");
    }

    const date = settledOn ?? new Date();
    const timezone = await userTimezone(tx, userId);
    // A repayment happens on or after the loan's day, and never in the future (D-63). Compared as
    // calendar days, so a repayment the same day as the loan is fine whatever the hour. Checked
    // before anything is written.
    assertNotFuture(date, timezone, "A repayment's date");
    await assertNotBeforeJoin(tx, userId, date);
    if (dayKeyInZone(date, timezone) < dayKeyInZone(loan.date, timezone)) {
      throw new AppError(400, "A repayment can't be dated before the loan");
    }

    const requested = paymentAmount !== undefined ? money(paymentAmount) : remaining;
    const payment = min(requested, remaining);

    const newSettled = loan.settledAmount.add(payment).toDecimalPlaces(2);
    const fullySettled = newSettled.greaterThanOrEqualTo(loan.amount);

    const loanAfter = await tx.loan.update({
      where: { id: loanId },
      data: {
        settledAmount: fullySettled ? loan.amount : newSettled,
        status: fullySettled ? "SETTLED" : "PARTIAL",
      },
    });

    const kind: TransactionKind = loan.type === "LENT" ? "COLLECT" : "REPAY";

    await tx.transaction.create({
      data: {
        userId,
        kind,
        amount: payment,
        date,
        month: monthKeyInZone(date, timezone),
        description:
          loan.type === "LENT"
            ? `Repayment from ${loan.personName}`
            : `Repayment to ${loan.personName}`,
        paymentMethod: "Cash",
        loanId: loan.id,
      },
    });

    return loanAfter;
  });

  invalidateUserDashboard(userId);
  return serializeLoan(updated);
}

export async function updateLoan(userId: string, loanId: string, input: UpdateLoanInput) {
  // Serializable: the date and amount checks read repayments and then write (D-63).
  const updated = await inSerializableTransaction(async (tx) => {
    const loan = await tx.loan.findFirst({ where: { id: loanId, userId } });
    if (!loan) throw new AppError(404, "Loan record not found");

    const data: Prisma.LoanUpdateInput = {};
    const opening = await tx.transaction.findFirst({
      where: { loanId, kind: loan.type === "LENT" ? "LEND_OUT" : "BORROW_IN" },
    });

    if (input.date !== undefined) {
      const timezone = await userTimezone(tx, userId);
      assertNotFuture(input.date, timezone, "A loan's date");
      await assertNotBeforeJoin(tx, userId, input.date, loan.date);
      const firstRepayment = await tx.transaction.findFirst({
        where: { loanId, kind: { in: SETTLEMENT_KINDS } },
        orderBy: { date: "asc" },
      });
      if (firstRepayment && dayKeyInZone(input.date, timezone) > dayKeyInZone(firstRepayment.date, timezone)) {
        throw new AppError(400, "The loan's date can't be after its first repayment");
      }
      data.date = input.date;
      // The principal moved on the new date. A loan recorded without cashflow has no movement, so
      // only its as-of debt moves.
      if (opening) {
        await tx.transaction.update({
          where: { id: opening.id },
          data: { date: input.date, month: monthKeyInZone(input.date, timezone) },
        });
      }
    }
    if (input.personName !== undefined) data.personName = input.personName.trim();
    if (input.dueDate !== undefined) {
      data.dueDate = input.dueDate ? new Date(input.dueDate) : null;
    }
    if (input.notes !== undefined) data.notes = input.notes ? input.notes.trim() : null;

    if (input.amount !== undefined) {
      if (input.amount <= 0) throw new AppError(400, "Amount must be greater than zero");
      const amount = money(input.amount);

      // Reducing the principal below what has already been settled would leave the loan
      // over-paid, with cashflow on record that no longer corresponds to anything.
      if (amount.lessThan(loan.settledAmount)) {
        throw new AppError(
          400,
          `Amount cannot be less than the ${toNumber(loan.settledAmount)} already settled`
        );
      }

      data.amount = amount;
      data.status = amount.equals(loan.settledAmount)
        ? "SETTLED"
        : loan.settledAmount.greaterThan(0)
          ? "PARTIAL"
          : "PENDING";

      // Keep the opening movement in step with the principal, otherwise the cash position
      // silently drifts from the loan it describes.
      if (opening) {
        await tx.transaction.update({ where: { id: opening.id }, data: { amount } });
      }
    }

    // A renamed counterparty should not leave stale descriptions on its movements.
    if (input.personName !== undefined && input.personName.trim() !== loan.personName) {
      const name = input.personName.trim();
      const isLent = loan.type === "LENT";
      await tx.transaction.updateMany({
        where: { loanId, kind: isLent ? "LEND_OUT" : "BORROW_IN" },
        data: { description: isLent ? `Lent to ${name}` : `Borrowed from ${name}` },
      });
      await tx.transaction.updateMany({
        where: { loanId, kind: isLent ? "COLLECT" : "REPAY" },
        data: {
          description: isLent ? `Repayment from ${name}` : `Repayment to ${name}`,
        },
      });
    }

    return tx.loan.update({ where: { id: loanId }, data });
  });

  invalidateUserDashboard(userId);
  return serializeLoan(updated);
}

export async function deleteLoan(userId: string, loanId: string) {
  const loan = await prisma.loan.findFirst({ where: { id: loanId, userId } });
  if (!loan) throw new AppError(404, "Loan record not found");

  // Linked transactions cascade, so deleting a loan removes its movements rather than leaving
  // orphaned cashflow behind — which is what the old unlinked auto-created rows did.
  await prisma.loan.delete({ where: { id: loanId } });

  invalidateUserDashboard(userId);
}

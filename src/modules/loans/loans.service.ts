import { Prisma, TransactionKind } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../utils/asyncHandler";
import { monthKeyInZone } from "../../utils/date";
import { invalidateUserDashboard } from "../../lib/cache";
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
}

export interface UpdateLoanInput {
  personName?: string;
  amount?: number;
  dueDate?: string | null;
  notes?: string | null;
}

/**
 * Concurrent settlements on the same loan must not both read the same `settledAmount` and each
 * decide there is room to pay — that over-settles the loan and double-writes cashflow. Serializable
 * makes the conflict detectable; Postgres then aborts one with 40001 and we retry it.
 */
async function inSerializableTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  attempts = 3
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error: any) {
      // 40001 serialization_failure, 40P01 deadlock_detected — both are safe to retry.
      if (error?.code === "P2034" || ["40001", "40P01"].includes(error?.meta?.code)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError ?? new AppError(409, "Could not complete the update, please try again");
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
    createdAt: loan.createdAt.toISOString(),
    updatedAt: loan.updatedAt.toISOString(),
  };
}

export async function getLoans(
  userId: string,
  filters?: { type?: "LENT" | "BORROWED"; status?: "PENDING" | "PARTIAL" | "SETTLED" }
) {
  const where: Prisma.LoanWhereInput = { userId };
  if (filters?.type) where.type = filters.type;
  if (filters?.status) where.status = filters.status;

  const loans = await prisma.loan.findMany({
    where,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });

  return loans.map(serializeLoan);
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

  const loan = await prisma.$transaction(async (tx) => {
    const created = await tx.loan.create({
      data: {
        userId,
        type: input.type,
        personName,
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
      const now = new Date();
      const timezone = await userTimezone(tx, userId);

      await tx.transaction.create({
        data: {
          userId,
          kind: input.type === "LENT" ? "LEND_OUT" : "BORROW_IN",
          amount: money(input.amount),
          date: now,
          month: monthKeyInZone(now, timezone),
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

    const date = settledOn ?? new Date();
    const timezone = await userTimezone(tx, userId);
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
  const updated = await prisma.$transaction(async (tx) => {
    const loan = await tx.loan.findFirst({ where: { id: loanId, userId } });
    if (!loan) throw new AppError(404, "Loan record not found");

    const data: Prisma.LoanUpdateInput = {};
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
      const opening = await tx.transaction.findFirst({
        where: { loanId, kind: loan.type === "LENT" ? "LEND_OUT" : "BORROW_IN" },
      });
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

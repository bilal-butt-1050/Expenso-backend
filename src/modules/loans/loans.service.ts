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
  /** Changes the cash choice after saving: flips the starting movement's `movesCash`. */
  recordCashflow?: boolean;
}

const SETTLEMENT_KINDS: TransactionKind[] = ["COLLECT", "REPAY"];
const OPENING_KINDS: TransactionKind[] = ["LEND_OUT", "BORROW_IN"];

/** Everything a loan's response describes, read with the loan. */
const LOAN_INCLUDE = {
  transactions: {
    select: {
      id: true,
      kind: true,
      amount: true,
      date: true,
      month: true,
      movesCash: true,
      description: true,
      paymentMethod: true,
      needWant: true,
      categoryId: true,
      category: { select: { id: true, name: true, icon: true, color: true, isDefault: true } },
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  },
} satisfies Prisma.LoanInclude;

type LoanWithMovements = Prisma.LoanGetPayload<{ include: typeof LOAN_INCLUDE }>;

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

function serializeLoan(loan: LoanWithMovements) {
  const remaining = clampPositive(subtract(loan.amount, loan.settledAmount));
  const opening = loan.transactions.find((t) => OPENING_KINDS.includes(t.kind));
  const expense = loan.transactions.find((t) => t.kind === "SPEND");
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
    /**
     * Whether the money went out of (or came into) the user's cash when the loan started. False for
     * an old debt and for an expense someone else paid.
     */
    cashMoved: opening?.movesCash ?? false,
    /** The expense this loan came from: someone else paid it, or the user split it. */
    expense: expense
      ? {
          id: expense.id,
          description: expense.description,
          categoryId: expense.categoryId,
          category: expense.category,
          /** The user's own share: what counts as spending. */
          amount: toNumber(expense.amount),
          date: expense.date.toISOString(),
          month: expense.month,
          paymentMethod: expense.paymentMethod,
          needWant: expense.needWant,
          movesCash: expense.movesCash,
        }
      : null,
    /** Repayments, oldest first. `movesCash` false = settled without money (forgiven, in kind). */
    payments: loan.transactions
      .filter((t) => SETTLEMENT_KINDS.includes(t.kind))
      .map((t) => ({ id: t.id, amount: toNumber(t.amount), date: t.date.toISOString(), movesCash: t.movesCash })),
  };
}

/** The loan as the API returns it, read fresh with its movements. */
export async function loadLoan(tx: Prisma.TransactionClient | typeof prisma, loanId: string) {
  return serializeLoan(await tx.loan.findUniqueOrThrow({ where: { id: loanId }, include: LOAN_INCLUDE }));
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
    include: LOAN_INCLUDE,
  });
  return loans.map(serializeLoan);
}

/**
 * The Loans tab's month view (R-41): the loans visible in `month`, each carrying its position as
 * of that month's end in `asOf`. The top-level fields stay today's, because the settle sheet acts
 * on today's loan (D-63).
 */
export async function getLoansForMonth(userId: string, month: string, filters?: LoanFilters) {
  const [loans, timezone] = await Promise.all([
    prisma.loan.findMany({
      where: loanWhere(userId, filters),
      orderBy: [{ date: "desc" }, { id: "desc" }],
      include: LOAN_INCLUDE,
    }),
    userTimezone(prisma, userId),
  ]);

  return loans.flatMap((loan) => {
    const settlements = loan.transactions.filter((t) => SETTLEMENT_KINDS.includes(t.kind));
    const asOf = loanAsOfMonth(loan, settlements, month, timezone);
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
          settledOn: asOf.remaining.greaterThan(0) ? settledOnAfter(loan, settlements, month) : null,
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

export function openingDescription(type: string, personName: string) {
  return type === "LENT" ? `Lent to ${personName}` : `Borrowed from ${personName}`;
}

function settlementDescription(type: string, personName: string) {
  return type === "LENT" ? `Repayment from ${personName}` : `Repayment to ${personName}`;
}

/** Status from what's been repaid. */
function statusFor(amount: Prisma.Decimal, settled: Prisma.Decimal): "PENDING" | "PARTIAL" | "SETTLED" {
  return settled.greaterThanOrEqualTo(amount) ? "SETTLED" : settled.greaterThan(0) ? "PARTIAL" : "PENDING";
}

/**
 * Creates a loan and its starting movement, inside the caller's transaction. Shared by the loan
 * form and by an expense someone else paid or the user split. The starting movement is written
 * even when no cash moved (`movesCash` false), so the choice is stored and can be changed later.
 * Returns the loan's id.
 */
export async function createLoanIn(
  tx: Prisma.TransactionClient,
  userId: string,
  input: { type: "LENT" | "BORROWED"; personName: string; amount: Prisma.Decimal; date: Date; month: string; movesCash: boolean; dueDate?: Date | null; notes?: string | null },
  opening = true,
) {
  const created = await tx.loan.create({
    data: {
      userId,
      type: input.type,
      personName: input.personName,
      date: input.date,
      amount: input.amount,
      dueDate: input.dueDate ?? null,
      notes: input.notes ?? null,
      status: "PENDING",
      settledAmount: money(0),
    },
  });
  // The principal moving is itself a cash event. Omitting it is what made the ledger asymmetric:
  // settlement credited cash with nothing ever having debited it, so lending money and collecting
  // it back invented net worth.
  if (opening) {
    await tx.transaction.create({
      data: {
        userId,
        kind: input.type === "LENT" ? "LEND_OUT" : "BORROW_IN",
        amount: input.amount,
        date: input.date,
        month: input.month,
        description: openingDescription(input.type, input.personName),
        paymentMethod: "Cash",
        loanId: created.id,
        movesCash: input.movesCash,
      },
    });
  }
  return created.id;
}

export async function createLoan(userId: string, input: CreateLoanInput) {
  if (input.amount <= 0) {
    throw new AppError(400, "Amount must be greater than zero");
  }

  const timezone = await userTimezone(prisma, userId);
  // When the money moved: now unless the user backdated it, never in the future (D-62, D-63).
  const date = input.date ?? new Date();
  assertNotFuture(date, timezone, "A loan's date");
  await assertNotBeforeJoin(prisma, userId, date);

  const loan = await prisma.$transaction(async (tx) => {
    const id = await createLoanIn(tx, userId, {
      type: input.type,
      personName: input.personName.trim(),
      amount: money(input.amount),
      date,
      month: monthKeyInZone(date, timezone),
      movesCash: input.recordCashflow ?? true,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      notes: input.notes?.trim() || null,
    });
    return loadLoan(tx, id);
  });

  invalidateUserDashboard(userId);
  return loan;
}

/**
 * Records a payment against a loan and the cash movement that goes with it.
 *
 * Collecting a loan you made credits cash (COLLECT); repaying a debt debits it (REPAY). Neither
 * counts as income or spending — a transfer is not an expense, so settling a large debt no
 * longer detonates the month's budget the way the old auto-generated Expense did. A payment
 * without money (`movesCash` false: forgiven, paid in kind) reduces the debt and leaves cash alone.
 */
export async function settleLoan(
  userId: string,
  loanId: string,
  /** Omitted = the whole remainder. More than the remainder is refused. */
  paymentAmount?: number,
  /** When the payment happened. Defaults to now. */
  settledOn?: Date,
  /** False = settled without money changing hands: forgiven, paid in kind, or offset. */
  movesCash = true,
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

    const payment = paymentAmount !== undefined ? money(paymentAmount) : remaining;
    // Refused rather than capped: a capped payment silently recorded less than the user entered.
    if (payment.greaterThan(remaining)) {
      throw new AppError(400, `Only ${toNumber(remaining)} is left on this loan`);
    }

    const settled = loan.settledAmount.add(payment).toDecimalPlaces(2);
    await tx.loan.update({
      where: { id: loanId },
      data: { settledAmount: settled, status: statusFor(loan.amount, settled) },
    });

    await tx.transaction.create({
      data: {
        userId,
        kind: loan.type === "LENT" ? "COLLECT" : "REPAY",
        amount: payment,
        date,
        month: monthKeyInZone(date, timezone),
        description: settlementDescription(loan.type, loan.personName),
        paymentMethod: "Cash",
        loanId: loan.id,
        movesCash,
      },
    });

    return loadLoan(tx, loanId);
  });

  invalidateUserDashboard(userId);
  return updated;
}

/**
 * Undoes one repayment (a wrong amount, date or kind): removes it and recomputes what's been
 * repaid from the payments that remain, so `settledAmount` can't drift from the ledger.
 */
export async function deleteLoanPayment(userId: string, loanId: string, paymentId: string) {
  const updated = await inSerializableTransaction(async (tx) => {
    const loan = await tx.loan.findFirst({ where: { id: loanId, userId } });
    if (!loan) throw new AppError(404, "Loan record not found");
    const payment = await tx.transaction.findFirst({
      where: { id: paymentId, loanId, userId, kind: { in: SETTLEMENT_KINDS } },
    });
    if (!payment) throw new AppError(404, "Payment not found");

    await tx.transaction.delete({ where: { id: payment.id } });
    const rest = await tx.transaction.aggregate({
      where: { loanId, kind: { in: SETTLEMENT_KINDS } },
      _sum: { amount: true },
    });
    const settled = min(rest._sum.amount ?? money(0), loan.amount);
    await tx.loan.update({ where: { id: loanId }, data: { settledAmount: settled, status: statusFor(loan.amount, settled) } });
    return loadLoan(tx, loanId);
  });

  invalidateUserDashboard(userId);
  return updated;
}

export interface LoanChanges {
  personName?: string;
  amount?: Prisma.Decimal;
  date?: Date;
  dueDate?: Date | null;
  notes?: string | null;
  recordCashflow?: boolean;
}

/**
 * Applies changes to a loan and keeps its movements in step: the starting movement's amount, date
 * and cash flag, and every description after a rename. Shared by the loan form and by an expense
 * that carries a loan. Call inside a Serializable transaction: the checks read, then write.
 */
export async function applyLoanChanges(
  tx: Prisma.TransactionClient,
  userId: string,
  loan: { id: string; type: string; personName: string; amount: Prisma.Decimal; settledAmount: Prisma.Decimal; date: Date },
  changes: LoanChanges,
) {
  const data: Prisma.LoanUpdateInput = {};
  const opening = await tx.transaction.findFirst({ where: { loanId: loan.id, kind: { in: OPENING_KINDS } } });

  if (changes.date !== undefined) {
    const timezone = await userTimezone(tx, userId);
    assertNotFuture(changes.date, timezone, "A loan's date");
    await assertNotBeforeJoin(tx, userId, changes.date, loan.date);
    const firstRepayment = await tx.transaction.findFirst({
      where: { loanId: loan.id, kind: { in: SETTLEMENT_KINDS } },
      orderBy: { date: "asc" },
    });
    if (firstRepayment && dayKeyInZone(changes.date, timezone) > dayKeyInZone(firstRepayment.date, timezone)) {
      throw new AppError(400, "The loan's date can't be after its first repayment");
    }
    data.date = changes.date;
    if (opening) {
      await tx.transaction.update({
        where: { id: opening.id },
        data: { date: changes.date, month: monthKeyInZone(changes.date, timezone) },
      });
    }
  }
  if (changes.dueDate !== undefined) data.dueDate = changes.dueDate;
  if (changes.notes !== undefined) data.notes = changes.notes;

  if (changes.amount !== undefined) {
    if (!changes.amount.greaterThan(0)) throw new AppError(400, "Amount must be greater than zero");
    // Reducing the principal below what has already been settled would leave the loan
    // over-paid, with cashflow on record that no longer corresponds to anything.
    if (changes.amount.lessThan(loan.settledAmount)) {
      throw new AppError(400, `Amount cannot be less than the ${toNumber(loan.settledAmount)} already settled`);
    }
    data.amount = changes.amount;
    data.status = statusFor(changes.amount, loan.settledAmount);
    // Keep the opening movement in step with the principal, otherwise the cash position
    // silently drifts from the loan it describes.
    if (opening) await tx.transaction.update({ where: { id: opening.id }, data: { amount: changes.amount } });
  }

  if (changes.recordCashflow !== undefined && opening) {
    await tx.transaction.update({ where: { id: opening.id }, data: { movesCash: changes.recordCashflow } });
  }

  // A renamed counterparty should not leave stale descriptions on its movements.
  if (changes.personName !== undefined && changes.personName !== loan.personName) {
    const name = changes.personName;
    data.personName = name;
    await tx.transaction.updateMany({
      where: { loanId: loan.id, kind: { in: OPENING_KINDS } },
      data: { description: openingDescription(loan.type, name) },
    });
    await tx.transaction.updateMany({
      where: { loanId: loan.id, kind: { in: SETTLEMENT_KINDS } },
      data: { description: settlementDescription(loan.type, name) },
    });
  }

  await tx.loan.update({ where: { id: loan.id }, data });
}

/** Repayments recorded against a loan. */
export function paymentCount(tx: Prisma.TransactionClient, loanId: string) {
  return tx.transaction.count({ where: { loanId, kind: { in: SETTLEMENT_KINDS } } });
}

export async function updateLoan(userId: string, loanId: string, input: UpdateLoanInput) {
  // Serializable: the date and amount checks read repayments and then write (D-63).
  const updated = await inSerializableTransaction(async (tx) => {
    const loan = await tx.loan.findFirst({ where: { id: loanId, userId } });
    if (!loan) throw new AppError(404, "Loan record not found");

    // A loan that came from an expense moves with it: its amount, date and cash are the expense's.
    const fromExpense = await tx.transaction.findFirst({ where: { loanId, kind: "SPEND" }, select: { id: true } });
    if (fromExpense && (input.amount !== undefined || input.date !== undefined || input.recordCashflow !== undefined)) {
      throw new AppError(409, "This loan comes from an expense. Change it from the expense.");
    }

    await applyLoanChanges(tx, userId, loan, {
      personName: input.personName?.trim(),
      amount: input.amount !== undefined ? money(input.amount) : undefined,
      date: input.date,
      dueDate: input.dueDate === undefined ? undefined : input.dueDate ? new Date(input.dueDate) : null,
      notes: input.notes === undefined ? undefined : input.notes?.trim() || null,
      recordCashflow: input.recordCashflow,
    });
    return loadLoan(tx, loanId);
  });

  invalidateUserDashboard(userId);
  return updated;
}

export async function deleteLoan(userId: string, loanId: string) {
  const loan = await prisma.loan.findFirst({ where: { id: loanId, userId } });
  if (!loan) throw new AppError(404, "Loan record not found");

  // Linked transactions cascade, so deleting a loan removes its movements rather than leaving
  // orphaned cashflow behind — which is what the old unlinked auto-created rows did. That includes
  // the expense it came from, if any: the two are one record.
  await prisma.loan.delete({ where: { id: loanId } });

  invalidateUserDashboard(userId);
}

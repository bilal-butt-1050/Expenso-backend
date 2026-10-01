import { Prisma } from "@prisma/client";
import { assertNotBeforeJoin } from "../../lib/joinDate";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../utils/asyncHandler";
import { monthKeyInZone } from "../../utils/date";
import { invalidateUserDashboard } from "../../lib/cache";
import { money, toNumber } from "../../utils/money";

/**
 * COMPATIBILITY ADAPTER.
 *
 * `/expenses` is the shape the currently installed mobile build talks to. Storage has moved to the
 * unified `transactions` ledger, so this module now reads and writes SPEND transactions and
 * presents them in the old Expense shape. Nothing here touches the legacy `expenses` table, which
 * is retained purely as migration provenance.
 *
 * New clients should use `/transactions`. This goes away once no installed build depends on it.
 */

export interface ExpenseInput {
  categoryId: string;
  date: Date;
  description?: string;
  amount: number;
  paymentMethod?: string;
  needWant?: "Need" | "Want";
  status?: "Paid";
}

type Row = Prisma.TransactionGetPayload<{ include: { category: true } }>;

function toLegacyExpense(t: Row) {
  return {
    id: t.id,
    userId: t.userId,
    categoryId: t.categoryId,
    category: t.category,
    date: t.date.toISOString(),
    month: t.month,
    description: t.description,
    amount: toNumber(t.amount),
    paymentMethod: t.paymentMethod,
    needWant: t.needWant ?? "Need",
    // Every expense is a settled cashflow; the field survives only for old clients.
    status: "Paid" as const,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export async function listExpenses(
  userId: string,
  filters: { month?: string; categoryId?: string; status?: string; skip?: number; take?: number }
) {
  const take = filters.take || 50;
  const skip = filters.skip || 0;

  const rows = await prisma.transaction.findMany({
    where: {
      userId,
      kind: "SPEND",
      month: filters.month,
      categoryId: filters.categoryId,
    },
    include: { category: true },
    // `id` breaks ties. Dates are day-level, so ordering by date alone made offset paging
    // return rows in an unstable order and silently duplicate or drop them between pages.
    orderBy: [{ date: "desc" }, { id: "desc" }],
    skip,
    take: take + 1,
  });

  const hasMore = rows.length > take;
  return { items: (hasMore ? rows.slice(0, take) : rows).map(toLegacyExpense), hasMore };
}

async function assertCategoryOwnership(userId: string, categoryId: string) {
  const category = await prisma.category.findFirst({ where: { id: categoryId, userId } });
  if (!category) throw new AppError(400, "Invalid category");
}

async function userTimezone(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  return user?.timezone ?? "Asia/Karachi";
}

export async function createExpense(userId: string, input: ExpenseInput) {
  await assertCategoryOwnership(userId, input.categoryId);
  await assertNotBeforeJoin(prisma, userId, input.date);

  const created = await prisma.transaction.create({
    data: {
      userId,
      kind: "SPEND",
      categoryId: input.categoryId,
      date: input.date,
      month: monthKeyInZone(input.date, await userTimezone(userId)),
      description: input.description ?? null,
      amount: money(input.amount),
      paymentMethod: input.paymentMethod ?? "Cash",
      needWant: input.needWant ?? "Need",
    },
    include: { category: true },
  });

  invalidateUserDashboard(userId);
  return toLegacyExpense(created);
}

export async function updateExpense(userId: string, id: string, input: Partial<ExpenseInput>) {
  const existing = await assertSpendOwnership(userId, id);
  if (input.categoryId) await assertCategoryOwnership(userId, input.categoryId);

  const data: Prisma.TransactionUpdateInput = {};
  if (input.amount !== undefined) data.amount = money(input.amount);
  if (input.description !== undefined) data.description = input.description || null;
  if (input.paymentMethod !== undefined) data.paymentMethod = input.paymentMethod;
  if (input.needWant !== undefined) data.needWant = input.needWant;
  if (input.categoryId !== undefined) data.category = { connect: { id: input.categoryId } };
  if (input.date !== undefined) {
    data.date = input.date;
    data.month = monthKeyInZone(input.date, await assertNotBeforeJoin(prisma, userId, input.date, existing.date));
  }

  void existing;

  const updated = await prisma.transaction.update({
    where: { id },
    data,
    include: { category: true },
  });

  invalidateUserDashboard(userId);
  return toLegacyExpense(updated);
}

export async function deleteExpense(userId: string, id: string) {
  await assertSpendOwnership(userId, id);
  await prisma.transaction.delete({ where: { id } });
  invalidateUserDashboard(userId);
}

/**
 * @deprecated Expenses are always settled cashflows. Kept so old clients calling
 * `/expenses/:id/toggle-status` get a sane response instead of a 404.
 */
export async function toggleExpenseStatus(userId: string, id: string) {
  const existing = await assertSpendOwnership(userId, id);
  const row = await prisma.transaction.findUniqueOrThrow({
    where: { id: existing.id },
    include: { category: true },
  });
  return toLegacyExpense(row);
}

async function assertSpendOwnership(userId: string, id: string) {
  const row = await prisma.transaction.findFirst({ where: { id, userId, kind: "SPEND" } });
  if (!row) throw new AppError(404, "Expense not found");

  // A loan's movements are owned by the loan. Letting one be edited or deleted here is exactly
  // how a loan used to end up marked SETTLED with its payment record gone.
  if (row.loanId) {
    throw new AppError(
      409,
      "This entry belongs to a loan. Manage it from the loan itself so the balance stays correct."
    );
  }
  return row;
}

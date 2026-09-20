import { prisma } from "../../lib/prisma";
import { AppError } from "../../utils/asyncHandler";
import { toMonthKey } from "../../utils/date";
import { invalidateUserDashboard } from "../../lib/cache";

export interface ExpenseInput {
  categoryId: string;
  date: Date;
  description?: string;
  amount: number;
  paymentMethod?: string;
  needWant?: "Need" | "Want";
  status?: "Paid";
}

export async function listExpenses(
  userId: string,
  filters: { month?: string; categoryId?: string; status?: string; skip?: number; take?: number }
) {
  const take = filters.take || 50;
  const skip = filters.skip || 0;

  const data = await prisma.expense.findMany({
    where: {
      userId,
      month: filters.month,
      categoryId: filters.categoryId,
    },
    include: { category: true },
    orderBy: { date: "desc" },
    skip,
    take: take + 1, // Fetch one extra to determine hasMore
  });

  const hasMore = data.length > take;
  const items = hasMore ? data.slice(0, take) : data;

  return { items, hasMore };
}

export async function createExpense(userId: string, input: ExpenseInput) {
  await assertCategoryOwnership(userId, input.categoryId);
  const result = await prisma.expense.create({
    data: {
      userId,
      categoryId: input.categoryId,
      date: input.date,
      month: toMonthKey(input.date),
      description: input.description,
      amount: input.amount,
      paymentMethod: input.paymentMethod,
      needWant: input.needWant,
      status: "Paid",
    },
    include: { category: true },
  });
  invalidateUserDashboard(userId);
  return result;
}

export async function updateExpense(userId: string, id: string, input: Partial<ExpenseInput>) {
  await assertExpenseOwnership(userId, id);
  if (input.categoryId) {

    await assertCategoryOwnership(userId, input.categoryId);
  }

  const result = await prisma.expense.update({
    where: { id },
    data: {
      ...input,
      status: "Paid",
      month: input.date ? toMonthKey(input.date) : undefined,
    },
    include: { category: true },
  });
  
  invalidateUserDashboard(userId);
  return result;
}

export async function deleteExpense(userId: string, id: string) {
  await assertExpenseOwnership(userId, id);
  await prisma.expense.delete({ where: { id } });
  invalidateUserDashboard(userId);
}

/**
 * @deprecated Expenses strictly represent settled cashflows ("Paid").
 * Retained for backwards compatibility: ensures the expense is marked "Paid".
 */
export async function toggleExpenseStatus(userId: string, id: string) {
  await assertExpenseOwnership(userId, id);
  const result = await prisma.expense.update({
    where: { id },
    data: { status: "Paid" },
    include: { category: true },
  });
  invalidateUserDashboard(userId);
  return result;
}


async function assertExpenseOwnership(userId: string, id: string) {
  const expense = await prisma.expense.findFirst({ where: { id, userId } });
  if (!expense) {
    throw new AppError(404, "Expense not found");
  }
  return expense;
}

async function assertCategoryOwnership(userId: string, categoryId: string) {
  const category = await prisma.category.findFirst({ where: { id: categoryId, userId } });
  if (!category) {
    throw new AppError(400, "Invalid category");
  }
}

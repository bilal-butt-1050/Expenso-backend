import { prisma } from "../../lib/prisma";
import { AppError } from "../../utils/asyncHandler";
import { toMonthKey } from "../../utils/date";

export interface ExpenseInput {
  categoryId: string;
  date: Date;
  description?: string;
  amount: number;
  paymentMethod?: string;
  needWant?: "Need" | "Want";
  status?: "Paid" | "Unpaid";
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
      status: filters.status,
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
  return prisma.expense.create({
    data: {
      userId,
      categoryId: input.categoryId,
      date: input.date,
      month: toMonthKey(input.date),
      description: input.description,
      amount: input.amount,
      paymentMethod: input.paymentMethod,
      needWant: input.needWant,
      status: input.status,
    },
    include: { category: true },
  });
}

export async function updateExpense(userId: string, id: string, input: Partial<ExpenseInput>) {
  await assertExpenseOwnership(userId, id);
  if (input.categoryId) {
    await assertCategoryOwnership(userId, input.categoryId);
  }

  return prisma.expense.update({
    where: { id },
    data: {
      ...input,
      month: input.date ? toMonthKey(input.date) : undefined,
    },
    include: { category: true },
  });
}

export async function deleteExpense(userId: string, id: string) {
  await assertExpenseOwnership(userId, id);
  await prisma.expense.delete({ where: { id } });
}

// A quick one-tap toggle for the most common action on this screen: marking
// something paid once you've cleared the bill.
export async function toggleExpenseStatus(userId: string, id: string) {
  const expense = await assertExpenseOwnership(userId, id);
  return prisma.expense.update({
    where: { id },
    data: { status: expense.status === "Paid" ? "Unpaid" : "Paid" },
    include: { category: true },
  });
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

import { prisma } from "../../lib/prisma";
import { AppError } from "../../utils/asyncHandler";
import { toMonthKey } from "../../utils/date";

export interface IncomeInput {
  date: Date;
  source: string;
  sourceIcon?: string;
  sourceColor?: string;
  description?: string;
  amount: number;
  paymentMethod?: string;
}

export async function listIncome(
  userId: string,
  filters?: { month?: string; skip?: number; take?: number }
) {
  const take = filters?.take || 50;
  const skip = filters?.skip || 0;

  const data = await prisma.income.findMany({
    where: {
      userId,
      month: filters?.month,
    },
    orderBy: { date: "desc" },
    skip,
    take: take + 1,
  });

  const hasMore = data.length > take;
  const items = hasMore ? data.slice(0, take) : data;

  return { items, hasMore };
}

export async function createIncome(userId: string, input: IncomeInput) {
  return prisma.income.create({
    data: {
      userId,
      date: input.date,
      month: toMonthKey(input.date),
      source: input.source,
      sourceIcon: input.sourceIcon || "cash-multiple",
      sourceColor: input.sourceColor || "#00E676",
      description: input.description,
      amount: input.amount,
      paymentMethod: input.paymentMethod || "Bank",
    },
  });
}

export async function updateIncome(
  userId: string,
  id: string,
  input: Partial<IncomeInput>
) {
  await assertIncomeOwnership(userId, id);
  return prisma.income.update({
    where: { id },
    data: {
      ...input,
      month: input.date ? toMonthKey(input.date) : undefined,
    },
  });
}


export async function deleteIncome(userId: string, id: string) {
  await assertIncomeOwnership(userId, id);
  await prisma.income.delete({ where: { id } });
}

export async function getIncomeSummary(userId: string, month: string) {
  const incomes = await prisma.income.findMany({
    where: { userId, month },
  });

  const totalIncome = incomes.reduce((sum, i) => sum + i.amount, 0);

  return {
    month,
    totalIncome,
  };
}

async function assertIncomeOwnership(userId: string, id: string) {
  const income = await prisma.income.findFirst({ where: { id, userId } });
  if (!income) {
    throw new AppError(404, "Income entry not found");
  }
  return income;
}

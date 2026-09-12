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
  status?: "Received" | "Expected";
  paymentMethod?: string;
}

export function listIncome(
  userId: string,
  filters?: { month?: string; status?: string }
) {
  return prisma.income.findMany({
    where: {
      userId,
      month: filters?.month,
      status: filters?.status,
    },
    orderBy: { date: "desc" },
  });
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
      status: input.status || "Received",
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

export async function toggleIncomeStatus(userId: string, id: string) {
  const income = await assertIncomeOwnership(userId, id);
  const nextStatus = income.status === "Received" ? "Expected" : "Received";
  return prisma.income.update({
    where: { id },
    data: { status: nextStatus },
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

  const receivedIncome = incomes
    .filter((i) => i.status === "Received")
    .reduce((sum, i) => sum + i.amount, 0);

  const expectedIncome = incomes
    .filter((i) => i.status === "Expected")
    .reduce((sum, i) => sum + i.amount, 0);

  const totalIncome = receivedIncome + expectedIncome;

  return {
    month,
    totalIncome,
    receivedIncome,
    expectedIncome,
  };
}

async function assertIncomeOwnership(userId: string, id: string) {
  const income = await prisma.income.findFirst({ where: { id, userId } });
  if (!income) {
    throw new AppError(404, "Income entry not found");
  }
  return income;
}

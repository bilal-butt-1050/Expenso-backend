import { Prisma, Transaction } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../utils/asyncHandler";
import { monthKeyInZone } from "../../utils/date";
import { invalidateUserDashboard } from "../../lib/cache";
import { money, toNumber } from "../../utils/money";

/**
 * COMPATIBILITY ADAPTER — see the note in `expenses.service.ts`.
 *
 * Reads and writes EARN transactions, presented in the old Income shape for installed clients.
 * New clients should use `/transactions`.
 */

export interface IncomeInput {
  date: Date;
  source: string;
  sourceIcon?: string;
  sourceColor?: string;
  description?: string;
  amount: number;
  paymentMethod?: string;
}

type Row = Transaction;

function toLegacyIncome(t: Row) {
  return {
    id: t.id,
    userId: t.userId,
    date: t.date.toISOString(),
    month: t.month,
    source: t.source ?? "Other",
    sourceIcon: t.sourceIcon ?? "cash-multiple",
    sourceColor: t.sourceColor ?? "#10B981",
    description: t.description,
    amount: toNumber(t.amount),
    paymentMethod: t.paymentMethod,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

async function userTimezone(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  return user?.timezone ?? "Asia/Karachi";
}

export async function listIncome(
  userId: string,
  filters?: { month?: string; skip?: number; take?: number }
) {
  const take = filters?.take || 50;
  const skip = filters?.skip || 0;

  const rows = await prisma.transaction.findMany({
    where: { userId, kind: "EARN", month: filters?.month },
    // `id` breaks ties so paging is stable — see the note in expenses.service.ts.
    orderBy: [{ date: "desc" }, { id: "desc" }],
    skip,
    take: take + 1,
  });

  const hasMore = rows.length > take;
  return { items: (hasMore ? rows.slice(0, take) : rows).map(toLegacyIncome), hasMore };
}

export async function createIncome(userId: string, input: IncomeInput) {
  const created = await prisma.transaction.create({
    data: {
      userId,
      kind: "EARN",
      date: input.date,
      month: monthKeyInZone(input.date, await userTimezone(userId)),
      source: input.source,
      sourceIcon: input.sourceIcon || "cash-multiple",
      sourceColor: input.sourceColor || "#10B981",
      description: input.description ?? null,
      amount: money(input.amount),
      // Was "Bank" here but "Bank Transfer" in the schema default, so the same concept was
      // stored under two different strings depending on which path created the row.
      paymentMethod: input.paymentMethod || "Bank Transfer",
    },
  });

  invalidateUserDashboard(userId);
  return toLegacyIncome(created);
}

export async function updateIncome(userId: string, id: string, input: Partial<IncomeInput>) {
  await assertEarnOwnership(userId, id);

  const data: Prisma.TransactionUpdateInput = {};
  if (input.amount !== undefined) data.amount = money(input.amount);
  if (input.source !== undefined) data.source = input.source;
  if (input.sourceIcon !== undefined) data.sourceIcon = input.sourceIcon;
  if (input.sourceColor !== undefined) data.sourceColor = input.sourceColor;
  if (input.description !== undefined) data.description = input.description || null;
  if (input.paymentMethod !== undefined) data.paymentMethod = input.paymentMethod;
  if (input.date !== undefined) {
    data.date = input.date;
    data.month = monthKeyInZone(input.date, await userTimezone(userId));
  }

  const updated = await prisma.transaction.update({ where: { id }, data });
  invalidateUserDashboard(userId);
  return toLegacyIncome(updated);
}

export async function deleteIncome(userId: string, id: string) {
  await assertEarnOwnership(userId, id);
  await prisma.transaction.delete({ where: { id } });
  invalidateUserDashboard(userId);
}

export async function getIncomeSummary(userId: string, month: string) {
  const result = await prisma.transaction.aggregate({
    where: { userId, kind: "EARN", month },
    _sum: { amount: true },
  });
  return { month, totalIncome: toNumber(result._sum.amount) };
}

async function assertEarnOwnership(userId: string, id: string) {
  const row = await prisma.transaction.findFirst({ where: { id, userId, kind: "EARN" } });
  if (!row) throw new AppError(404, "Income entry not found");

  if (row.loanId) {
    throw new AppError(
      409,
      "This entry belongs to a loan. Manage it from the loan itself so the balance stays correct."
    );
  }
  return row;
}

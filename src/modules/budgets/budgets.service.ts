import { prisma } from "../../lib/prisma";
import { AppError } from "../../utils/asyncHandler";
import { cache } from "../../lib/cache";

export function listBudgets(userId: string, month: string) {
  return prisma.budget.findMany({ where: { userId, month }, include: { category: true } });
}

export async function upsertBudget(userId: string, categoryId: string, amount: number, month: string) {
  const category = await prisma.category.findFirst({ where: { id: categoryId, userId } });
  if (!category) {
    throw new AppError(400, "Invalid category");
  }

  const result = await prisma.budget.upsert({
    where: { userId_categoryId_month: { userId, categoryId, month } },
    create: { userId, categoryId, amount, month },
    update: { amount },
    include: { category: true },
  });
  cache.del(`dashboard_${userId}_${month}`);
  return result;
}

export async function deleteBudget(userId: string, categoryId: string, month: string) {
  await prisma.budget.deleteMany({ where: { userId, categoryId, month } });
  cache.del(`dashboard_${userId}_${month}`);
}

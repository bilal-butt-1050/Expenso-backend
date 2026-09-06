import { prisma } from "../../lib/prisma";
import { AppError } from "../../utils/asyncHandler";

export function listBudgets(userId: string) {
  return prisma.budget.findMany({ where: { userId }, include: { category: true } });
}

export async function upsertBudget(userId: string, categoryId: string, amount: number) {
  const category = await prisma.category.findFirst({ where: { id: categoryId, userId } });
  if (!category) {
    throw new AppError(400, "Invalid category");
  }

  return prisma.budget.upsert({
    where: { userId_categoryId: { userId, categoryId } },
    create: { userId, categoryId, amount },
    update: { amount },
    include: { category: true },
  });
}

export async function deleteBudget(userId: string, categoryId: string) {
  await prisma.budget.deleteMany({ where: { userId, categoryId } });
}

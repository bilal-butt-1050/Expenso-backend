import { prisma } from "../../lib/prisma";

export function listIncome(userId: string) {
  return prisma.income.findMany({ where: { userId }, orderBy: { month: "desc" } });
}

// One row per month: adding income for a month you've already logged
// updates that row instead of creating a duplicate.
export function upsertIncome(
  userId: string,
  data: { month: string; salary: number; bonus: number; otherIncome: number }
) {
  return prisma.income.upsert({
    where: { userId_month: { userId, month: data.month } },
    create: { userId, ...data },
    update: data,
  });
}

export async function deleteIncome(userId: string, id: string) {
  await prisma.income.deleteMany({ where: { id, userId } });
}

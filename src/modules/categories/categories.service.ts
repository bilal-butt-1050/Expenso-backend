import { prisma } from "../../lib/prisma";
import { AppError } from "../../utils/asyncHandler";

export function listCategories(userId: string) {
  return prisma.category.findMany({
    where: { userId },
    orderBy: [{ name: "asc" }],
  });
}

export async function createCategory(
  userId: string,
  data: { name: string; icon?: string; color?: string }
) {
  const count = await prisma.category.count({ where: { userId } });
  if (count >= 20) {
    throw new AppError(400, "Maximum of 20 categories allowed");
  }

  return prisma.category.create({
    data: { userId, name: data.name, icon: data.icon, color: data.color, isDefault: false },
  });
}

export async function updateCategory(
  userId: string,
  categoryId: string,
  data: { name?: string; icon?: string; color?: string }
) {
  const category = await assertOwnership(userId, categoryId);

  if (category.name === "Other" || category.name === "Savings") {
    throw new AppError(400, `The "${category.name}" category cannot be modified`);
  }

  return prisma.category.update({ where: { id: categoryId }, data });
}

// Deleting a category re-homes its expenses/budgets to the user's "Other"
// bucket (creating one if it somehow doesn't exist) instead of orphaning
// or cascading, so past spending history is never silently lost.
export async function deleteCategory(userId: string, categoryId: string) {
  const category = await assertOwnership(userId, categoryId);

  if (category.name === "Other" || category.name === "Savings") {
    throw new AppError(400, `The "${category.name}" category cannot be deleted`);
  }

  const count = await prisma.category.count({ where: { userId } });
  if (count <= 5) {
    throw new AppError(400, "Minimum of 5 categories required");
  }

  const fallback = await getOrCreateOtherCategory(userId, categoryId);

  await prisma.$transaction([
    prisma.expense.updateMany({
      where: { userId, categoryId },
      data: { categoryId: fallback.id },
    }),
    prisma.budget.deleteMany({ where: { userId, categoryId } }),
    prisma.category.delete({ where: { id: categoryId } }),
  ]);

  return { movedTo: fallback.name };
}

async function assertOwnership(userId: string, categoryId: string) {
  const category = await prisma.category.findFirst({ where: { id: categoryId, userId } });
  if (!category) {
    throw new AppError(404, "Category not found");
  }
  return category;
}

async function getOrCreateOtherCategory(userId: string, excludingId: string) {
  const existing = await prisma.category.findFirst({
    where: { userId, name: "Other", id: { not: excludingId } },
  });
  if (existing) return existing;

  return prisma.category.create({
    data: { userId, name: "Other", icon: "shape-outline", color: "#9E9E9E", isDefault: true },
  });
}

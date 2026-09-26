import { prisma } from "../../lib/prisma";
import { AppError } from "../../utils/asyncHandler";
import { invalidateUserDashboard } from "../../lib/cache";
import { inSerializableTransaction } from "../../lib/serializable";

export async function listCategories(userId: string) {
  const categories = await prisma.category.findMany({
    where: { userId },
    orderBy: [{ name: "asc" }],
  });

  return categories.sort((a, b) => {
    if (a.name === "Other") return 1;
    if (b.name === "Other") return -1;
    return 0; // maintain existing alphabetical order for everything else
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

  const result = await prisma.category.create({
    data: { userId, name: data.name, icon: data.icon, color: data.color, isDefault: false },
  });
  invalidateUserDashboard(userId);
  return result;
}

export async function updateCategory(
  userId: string,
  categoryId: string,
  data: { name?: string; icon?: string; color?: string }
) {
  const category = await assertOwnership(userId, categoryId);

  if (category.name === "Other") {
    throw new AppError(400, `The "${category.name}" category cannot be modified`);
  }

  const result = await prisma.category.update({ where: { id: categoryId }, data });
  invalidateUserDashboard(userId);
  return result;
}

// Deleting a category re-homes its spending to the user's "Other" bucket
// (creating one if it somehow doesn't exist) instead of orphaning or
// cascading, so past spending history is never silently lost. The ledger
// rows must move explicitly: `transactions.categoryId` is ON DELETE SET NULL,
// and a SPEND with no category drops out of every breakdown and budget.
export async function deleteCategory(userId: string, categoryId: string) {
  const category = await assertOwnership(userId, categoryId);

  if (category.name === "Other") {
    throw new AppError(400, `The "${category.name}" category cannot be deleted`);
  }

  const count = await prisma.category.count({ where: { userId } });
  if (count <= 5) {
    throw new AppError(400, "Minimum of 5 categories required");
  }

  const fallback = await getOrCreateOtherCategory(userId, categoryId);

  // Serializable, retried: a SPEND written into this category mid-delete
  // forces a retry, and the retry's fresh snapshot moves it too, rather than
  // the FK silently nulling it.
  await inSerializableTransaction(async (tx) => {
    await tx.transaction.updateMany({
      where: { userId, categoryId },
      data: { categoryId: fallback.id },
    });
    await tx.expense.updateMany({
      where: { userId, categoryId },
      data: { categoryId: fallback.id },
    });
    await tx.budget.deleteMany({ where: { userId, categoryId } });
    await tx.category.delete({ where: { id: categoryId } });
  });

  invalidateUserDashboard(userId);
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

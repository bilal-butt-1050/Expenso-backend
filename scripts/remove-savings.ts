import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Finding all Savings categories...");
  const savingsCategories = await prisma.category.findMany({
    where: { name: "Savings" },
  });

  console.log(`Found ${savingsCategories.length} users with a Savings category.`);

  for (const savingsCat of savingsCategories) {
    const userId = savingsCat.userId;

    // Find or create "Other" for this user
    let otherCat = await prisma.category.findFirst({
      where: { userId, name: "Other" },
    });

    if (!otherCat) {
      otherCat = await prisma.category.create({
        data: {
          userId,
          name: "Other",
          icon: "shape-outline",
          color: "#9E9E9E",
          isDefault: true,
        },
      });
    }

    // Move all expenses from Savings to Other
    const updatedExpenses = await prisma.expense.updateMany({
      where: { categoryId: savingsCat.id },
      data: { categoryId: otherCat.id },
    });
    console.log(`User ${userId}: Moved ${updatedExpenses.count} expenses from Savings to Other.`);

    // Budgets for savings can just be deleted, as they cascade if we delete the category anyway.
    // Let Prisma handle it via cascade, or delete explicitly:
    await prisma.budget.deleteMany({
      where: { categoryId: savingsCat.id },
    });

    // Delete the Savings category
    await prisma.category.delete({
      where: { id: savingsCat.id },
    });
    console.log(`User ${userId}: Deleted Savings category.`);
  }

  console.log("Migration complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

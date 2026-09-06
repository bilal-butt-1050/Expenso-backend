import { prisma } from "../../lib/prisma";
import { trailingMonths } from "../../utils/date";

/**
 * Aggregates and computes all dashboard metrics for a given user and month,
 * including income, total and categorized expenses, budget progress, and historical trends.
 */
export async function getDashboardSummary(userId: string, month: string) {
  const [income, monthExpenses, allIncome, allPaidExpensesAgg, budgets, categories] =
    await Promise.all([
      prisma.income.findUnique({ where: { userId_month: { userId, month } } }),
      prisma.expense.findMany({ where: { userId, month }, include: { category: true } }),
      prisma.income.aggregate({ where: { userId }, _sum: { salary: true, bonus: true, otherIncome: true } }),
      prisma.expense.aggregate({ where: { userId, status: "Paid" }, _sum: { amount: true } }),
      prisma.budget.findMany({ where: { userId }, include: { category: true } }),
      prisma.category.findMany({ where: { userId } }),
    ]);

  const monthlyIncome = (income?.salary ?? 0) + (income?.bonus ?? 0) + (income?.otherIncome ?? 0);

  const totalExpenses = sum(monthExpenses, (e) => e.amount);
  const paidExpenses = sum(
    monthExpenses.filter((e) => e.status === "Paid"),
    (e) => e.amount
  );
  const unpaidExpenses = totalExpenses - paidExpenses;

  const remainingBalance = monthlyIncome - paidExpenses;
  const projectedBalance = remainingBalance - unpaidExpenses;

  const allTimeIncome =
    (allIncome._sum.salary ?? 0) + (allIncome._sum.bonus ?? 0) + (allIncome._sum.otherIncome ?? 0);
  const allTimePaidExpenses = allPaidExpensesAgg._sum.amount ?? 0;
  const savingsAllTime = allTimeIncome - allTimePaidExpenses;
  const savingsPercentage = monthlyIncome > 0 ? remainingBalance / monthlyIncome : 0;

  const categoryBreakdown = categories
    .map((c) => ({
      categoryId: c.id,
      name: c.name,
      color: c.color,
      icon: c.icon,
      amount: sum(
        monthExpenses.filter((e) => e.categoryId === c.id),
        (e) => e.amount
      ),
    }))
    .filter((c) => c.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const budgetVsActual = budgets.map((b) => {
    const categoryExpenses = monthExpenses.filter((e) => e.categoryId === b.categoryId);
    const actual = sum(categoryExpenses, (e) => e.amount);
    const unpaid = sum(
      categoryExpenses.filter((e) => e.status === "Unpaid"),
      (e) => e.amount
    );
    const remaining = b.amount - actual;
    return {
      categoryId: b.categoryId,
      name: b.category.name,
      color: b.category.color,
      icon: b.category.icon,
      budget: b.amount,
      actual,
      unpaid,
      remaining,
      status: remaining >= 0 ? "On Track" : "Over Budget",
    };
  });

  const trend = await getMonthlyTrend(userId, month, 12);

  return {
    month,
    monthlyIncome,
    totalExpenses,
    paidExpenses,
    unpaidExpenses,
    remainingBalance,
    projectedBalance,
    savingsAllTime,
    savingsPercentage,
    categoryBreakdown,
    budgetVsActual,
    trend,
  };
}

async function getMonthlyTrend(userId: string, month: string, count: number) {
  const months = trailingMonths(month, count);
  const rows = await prisma.expense.groupBy({
    by: ["month"],
    where: { userId, month: { in: months } },
    _sum: { amount: true },
  });
  const byMonth = new Map(rows.map((r) => [r.month, r._sum.amount ?? 0]));
  return months.map((m) => ({ month: m, totalExpenses: byMonth.get(m) ?? 0 }));
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

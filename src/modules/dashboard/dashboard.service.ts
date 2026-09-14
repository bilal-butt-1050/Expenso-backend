import { prisma } from "../../lib/prisma";
import { trailingMonths } from "../../utils/date";

/**
 * Aggregates and computes all dashboard metrics for a given user and month,
 * including income, total and categorized expenses, budget progress, and historical trends.
 */
export async function getDashboardSummary(userId: string, month: string) {
  const prevMonth = getPreviousMonth(month);
  const [user, monthIncomes, monthExpenses, prevMonthExpenses, allIncomeAgg, allPaidExpensesAgg, unpaidAgg, budgets, prevMonthBudgets, categories] =
    await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.income.findMany({ where: { userId, month } }),
      prisma.expense.findMany({ where: { userId, month }, include: { category: true } }),
      prisma.expense.findMany({ where: { userId, month: prevMonth } }),
      prisma.income.aggregate({ where: { userId, month: { lte: month } }, _sum: { amount: true } }),
      prisma.expense.aggregate({ where: { userId, status: "Paid", month: { lte: month } }, _sum: { amount: true } }),
      prisma.expense.aggregate({ where: { userId, status: "Unpaid", month: { lte: month } }, _sum: { amount: true } }),
      prisma.budget.findMany({ where: { userId, month }, include: { category: true } }),
      prisma.budget.findMany({ where: { userId, month: prevMonth } }),
      prisma.category.findMany({ where: { userId } }),
    ]);

  const monthlyIncome = sum(monthIncomes, (i) => i.amount);
  const unpaidExpenses = unpaidAgg._sum.amount ?? 0;

  const totalExpenses = sum(monthExpenses, (e) => e.amount);
  const paidExpenses = sum(
    monthExpenses.filter((e) => e.status === "Paid"),
    (e) => e.amount
  );

  // Real-time liquidity in hand (Total Income - Paid Expenses)
  const cashInHand = monthlyIncome - paidExpenses;
  // True projected net balance for the month (Total Income - Total Expenses)
  const remainingBalance = monthlyIncome - totalExpenses;

  // Calculate calendar days and remaining days for daily allowance
  const [yearStr, monthStr] = month.split("-");
  const year = parseInt(yearStr, 10);
  const monthNum = parseInt(monthStr, 10);
  const daysInMonth = new Date(year, monthNum, 0).getDate();

  const now = new Date();
  const currentY = now.getFullYear();
  const currentM = now.getMonth() + 1;
  const currentD = now.getDate();

  let daysElapsed = daysInMonth;
  let daysRemaining = 0;

  if (year === currentY && monthNum === currentM) {
    daysElapsed = currentD;
    daysRemaining = Math.max(1, daysInMonth - currentD + 1);
  } else if (year > currentY || (year === currentY && monthNum > currentM)) {
    daysElapsed = 0;
    daysRemaining = daysInMonth;
  } else {
    daysElapsed = daysInMonth;
    daysRemaining = 0;
  }

  const dailyAllowance =
    daysRemaining > 0 && remainingBalance > 0
      ? Math.round(remainingBalance / daysRemaining)
      : 0;

  // Needs vs Wants breakdown
  const needsTotal = sum(
    monthExpenses.filter((e) => e.needWant === "Need"),
    (e) => e.amount
  );
  const wantsTotal = sum(
    monthExpenses.filter((e) => e.needWant === "Want"),
    (e) => e.amount
  );
  const needsPercentage = totalExpenses > 0 ? Math.round((needsTotal / totalExpenses) * 100) : 0;
  const wantsPercentage = totalExpenses > 0 ? Math.round((wantsTotal / totalExpenses) * 100) : 0;

  // Month Pacing calculation
  const monthProgressPercentage = Math.round((daysElapsed / daysInMonth) * 100);
  const spentPercentage = monthlyIncome > 0 ? Math.round((totalExpenses / monthlyIncome) * 100) : 0;

  let pacingStatus: "On Track" | "Pacing Fast" | "Over Budget" = "On Track";
  if (totalExpenses > monthlyIncome && monthlyIncome > 0) {
    pacingStatus = "Over Budget";
  } else if (spentPercentage > monthProgressPercentage + 15) {
    pacingStatus = "Pacing Fast";
  } else {
    pacingStatus = "On Track";
  }

  const allTimeIncome = allIncomeAgg._sum.amount ?? 0;
  const allTimePaidExpenses = allPaidExpensesAgg._sum.amount ?? 0;
  const savingsAllTime = allTimeIncome - allTimePaidExpenses;
  const savingsPercentage = monthlyIncome > 0 ? Math.max(0, remainingBalance / monthlyIncome) : 0;

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
      status: (remaining >= 0 ? "On Track" : "Over Budget") as "On Track" | "Over Budget",
    };
  });

  // Calculate rollover savings from previous month
  const rolloverSavings = prevMonthBudgets.reduce((total, b) => {
    const prevActual = sum(
      prevMonthExpenses.filter((e) => e.categoryId === b.categoryId),
      (e) => e.amount
    );
    return total + Math.max(0, b.amount - prevActual);
  }, 0);

  const trend = await getMonthlyTrend(userId, month, 12);

  return {
    month,
    savingsGoal: user?.savingsGoal ?? 0,
    rolloverSavings,
    monthlyIncome,
    totalExpenses,
    paidExpenses,
    unpaidExpenses,
    remainingBalance,
    cashInHand,
    projectedBalance: remainingBalance,
    savingsAllTime,
    savingsPercentage,
    dailyAllowance,
    daysRemaining,
    daysInMonth,
    needsTotal,
    wantsTotal,
    needsPercentage,
    wantsPercentage,
    monthProgressPercentage,
    spentPercentage,
    pacingStatus,
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

function getPreviousMonth(month: string): string {
  const [yearStr, monthStr] = month.split("-");
  let year = parseInt(yearStr, 10);
  let monthNum = parseInt(monthStr, 10);
  monthNum -= 1;
  if (monthNum === 0) {
    monthNum = 12;
    year -= 1;
  }
  return `${year}-${monthNum.toString().padStart(2, "0")}`;
}

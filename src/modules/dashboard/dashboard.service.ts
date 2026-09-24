import { Prisma, TransactionKind } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { trailingMonths } from "../../utils/date";
import { cache } from "../../lib/cache";
import { CASH_SIGN } from "../transactions/transactions.service";
import { clampPositive, money, subtract, toNumber } from "../../utils/money";

type Row = { kind: TransactionKind; amount: Prisma.Decimal; categoryId: string | null; needWant: string | null };

const sum = (rows: { amount: Prisma.Decimal }[]) =>
  rows.reduce((total, r) => total.add(r.amount), money(0));

const ofKind = (rows: Row[], ...kinds: TransactionKind[]) =>
  rows.filter((r) => kinds.includes(r.kind));

/**
 * Aggregates every dashboard metric for one user and month.
 *
 * Reads the unified ledger, which is what makes the headline numbers honest:
 * - spending and budgets count SPEND only, so lending money no longer blows a budget;
 * - cash on hand sums all six kinds, so lending and collecting nets to zero;
 * - net worth folds in what is still owed in each direction.
 */
export async function getDashboardSummary(userId: string, month: string) {
  const cacheKey = `dashboard_${userId}_${month}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const prevMonth = getPreviousMonth(month);

  const [monthRows, prevMonthRows, allTimeRows, budgets, prevMonthBudgets, categories, loans] =
    await Promise.all([
      prisma.transaction.findMany({
        where: { userId, month },
        select: { kind: true, amount: true, categoryId: true, needWant: true },
      }),
      prisma.transaction.findMany({
        where: { userId, month: prevMonth, kind: "SPEND" },
        select: { kind: true, amount: true, categoryId: true, needWant: true },
      }),
      prisma.transaction.groupBy({
        by: ["kind"],
        where: { userId, month: { lte: month } },
        _sum: { amount: true },
      }),
      prisma.budget.findMany({ where: { userId, month }, include: { category: true } }),
      prisma.budget.findMany({ where: { userId, month: prevMonth } }),
      prisma.category.findMany({ where: { userId } }),
      prisma.loan.findMany({ where: { userId } }),
    ]);

  const monthlyIncome = sum(ofKind(monthRows, "EARN"));
  const totalExpenses = sum(ofKind(monthRows, "SPEND"));

  // Every kind moves cash, not just spending and earning.
  const netCashThisMonth = monthRows.reduce(
    (total, r) => total.add(r.amount.mul(CASH_SIGN[r.kind])),
    money(0)
  );

  // Cash accumulated to the end of the selected month.
  const cashOnHand = allTimeRows.reduce(
    (total, r) => total.add((r._sum.amount ?? money(0)).mul(CASH_SIGN[r.kind])),
    money(0)
  );

  let totalLentOutstanding = money(0);
  let totalBorrowedOutstanding = money(0);
  for (const loan of loans) {
    if (loan.status === "SETTLED") continue;
    const remaining = clampPositive(subtract(loan.amount, loan.settledAmount));
    if (loan.type === "LENT") totalLentOutstanding = totalLentOutstanding.add(remaining);
    else totalBorrowedOutstanding = totalBorrowedOutstanding.add(remaining);
  }

  // What you'd actually be worth: cash, plus what's owed to you, minus what you owe.
  const netWorth = cashOnHand.add(totalLentOutstanding).sub(totalBorrowedOutstanding);

  // --- month pacing ---------------------------------------------------------------------
  const [yearStr, monthStr] = month.split("-");
  const year = parseInt(yearStr, 10);
  const monthNum = parseInt(monthStr, 10);
  const daysInMonth = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();

  const now = new Date();
  const currentY = now.getUTCFullYear();
  const currentM = now.getUTCMonth() + 1;

  let daysElapsed: number;
  let daysRemaining: number;
  if (year === currentY && monthNum === currentM) {
    daysElapsed = now.getUTCDate();
    daysRemaining = Math.max(1, daysInMonth - daysElapsed + 1);
  } else if (year > currentY || (year === currentY && monthNum > currentM)) {
    daysElapsed = 0;
    daysRemaining = daysInMonth;
  } else {
    daysElapsed = daysInMonth;
    daysRemaining = 0;
  }

  // Unspent money for the rest of the month. Deliberately *not* floored at zero elsewhere —
  // a negative month must stay visible — but a daily allowance below zero is meaningless.
  const remainingBalance = subtract(monthlyIncome, totalExpenses);
  const dailyAllowance =
    daysRemaining > 0 && remainingBalance.greaterThan(0)
      ? Math.round(toNumber(remainingBalance) / daysRemaining)
      : 0;

  const needsTotal = sum(ofKind(monthRows, "SPEND").filter((r) => r.needWant === "Need"));
  const wantsTotal = sum(ofKind(monthRows, "SPEND").filter((r) => r.needWant === "Want"));
  const pct = (part: Prisma.Decimal, whole: Prisma.Decimal) =>
    whole.greaterThan(0) ? Math.round((toNumber(part) / toNumber(whole)) * 100) : 0;

  const monthProgressPercentage = Math.round((daysElapsed / daysInMonth) * 100);
  const spentPercentage = pct(totalExpenses, monthlyIncome);

  let pacingStatus: "On Track" | "Pacing Fast" | "Over Budget" = "On Track";
  if (monthlyIncome.greaterThan(0) && totalExpenses.greaterThan(monthlyIncome)) {
    pacingStatus = "Over Budget";
  } else if (spentPercentage > monthProgressPercentage + 15) {
    pacingStatus = "Pacing Fast";
  }

  const totalBudgeted = budgets.reduce((t, b) => t.add(b.amount), money(0));
  const plannedSavings = clampPositive(subtract(monthlyIncome, totalBudgeted));

  // --- per-category ---------------------------------------------------------------------
  const spendRows = ofKind(monthRows, "SPEND");
  const spentByCategory = new Map<string, Prisma.Decimal>();
  for (const r of spendRows) {
    if (!r.categoryId) continue;
    spentByCategory.set(r.categoryId, (spentByCategory.get(r.categoryId) ?? money(0)).add(r.amount));
  }

  const categoryBreakdown = categories
    .map((c) => ({
      categoryId: c.id,
      name: c.name,
      color: c.color,
      icon: c.icon,
      amount: toNumber(spentByCategory.get(c.id) ?? money(0)),
    }))
    .filter((c) => c.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const budgetVsActual = budgets.map((b) => {
    const actual = spentByCategory.get(b.categoryId) ?? money(0);
    const remaining = subtract(b.amount, actual);
    return {
      categoryId: b.categoryId,
      name: b.category.name,
      color: b.category.color,
      icon: b.category.icon,
      budget: toNumber(b.amount),
      actual: toNumber(actual),
      remaining: toNumber(remaining),
      status: (remaining.isNegative() ? "Over Budget" : "On Track") as "On Track" | "Over Budget",
    };
  });

  const prevSpentByCategory = new Map<string, Prisma.Decimal>();
  for (const r of prevMonthRows) {
    if (!r.categoryId) continue;
    prevSpentByCategory.set(
      r.categoryId,
      (prevSpentByCategory.get(r.categoryId) ?? money(0)).add(r.amount)
    );
  }
  const rolloverSavings = prevMonthBudgets.reduce(
    (total, b) =>
      total.add(clampPositive(subtract(b.amount, prevSpentByCategory.get(b.categoryId) ?? money(0)))),
    money(0)
  );

  // --- obligations ----------------------------------------------------------------------
  const upcomingObligations = loans
    .filter((l) => l.status !== "SETTLED" && l.dueDate)
    .sort((a, b) => a.dueDate!.getTime() - b.dueDate!.getTime())
    .slice(0, 5)
    .map((l) => ({
      id: l.id,
      type: l.type,
      personName: l.personName,
      remainingAmount: toNumber(clampPositive(subtract(l.amount, l.settledAmount))),
      dueDate: l.dueDate!.toISOString(),
      isOverdue: l.dueDate!.getTime() < Date.now(),
    }));

  const result = {
    month,

    // Cash and worth
    cashOnHand: toNumber(cashOnHand),
    netWorth: toNumber(netWorth),
    netCashThisMonth: toNumber(netCashThisMonth),

    // This month
    monthlyIncome: toNumber(monthlyIncome),
    totalExpenses: toNumber(totalExpenses),
    // Signed on purpose: an overspent month must read negative, not be clamped to zero.
    remainingBalance: toNumber(remainingBalance),
    plannedSavings: toNumber(plannedSavings),
    rolloverSavings: toNumber(rolloverSavings),
    totalBudgeted: toNumber(totalBudgeted),

    // Pacing
    dailyAllowance,
    daysRemaining,
    daysInMonth,
    monthProgressPercentage,
    spentPercentage,
    pacingStatus,

    // Needs / wants
    needsTotal: toNumber(needsTotal),
    wantsTotal: toNumber(wantsTotal),
    needsPercentage: pct(needsTotal, totalExpenses),
    wantsPercentage: pct(wantsTotal, totalExpenses),

    // Debt position
    netDebtSnapshot: {
      totalLent: toNumber(totalLentOutstanding),
      totalBorrowed: toNumber(totalBorrowedOutstanding),
      net: toNumber(subtract(totalLentOutstanding, totalBorrowedOutstanding)),
    },
    upcomingObligations,

    categoryBreakdown,
    budgetVsActual,
    trend: await getMonthlyTrend(userId, month, 12),
  };

  cache.set(cacheKey, result);
  return result;
}

async function getMonthlyTrend(userId: string, month: string, count: number) {
  const months = trailingMonths(month, count);
  const rows = await prisma.transaction.groupBy({
    by: ["month"],
    where: { userId, month: { in: months }, kind: "SPEND" },
    _sum: { amount: true },
  });
  const byMonth = new Map(rows.map((r) => [r.month, toNumber(r._sum.amount)]));
  return months.map((m) => ({ month: m, totalExpenses: byMonth.get(m) ?? 0 }));
}

function getPreviousMonth(month: string): string {
  const [yearStr, monthStr] = month.split("-");
  let year = parseInt(yearStr, 10);
  let monthNum = parseInt(monthStr, 10) - 1;
  if (monthNum === 0) {
    monthNum = 12;
    year -= 1;
  }
  return `${year}-${monthNum.toString().padStart(2, "0")}`;
}

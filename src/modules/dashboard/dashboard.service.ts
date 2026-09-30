import { Prisma, TransactionKind } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import {
  DEFAULT_TIMEZONE,
  datePartsInZone,
  dayKeyInZone,
  monthKeyInZone,
  startOfDayInZone,
  startOfTomorrowInZone,
  trailingMonths,
} from "../../utils/date";
import { cache } from "../../lib/cache";
import { CASH_SIGN } from "../transactions/transactions.service";
import { clampPositive, money, subtract, toNumber } from "../../utils/money";
import { loanAsOfMonth } from "../loans/loans.service";

type Row = {
  kind: TransactionKind;
  amount: Prisma.Decimal;
  categoryId: string | null;
  needWant: string | null;
  date: Date;
};

const sum = (rows: { amount: Prisma.Decimal }[]) =>
  rows.reduce((total, r) => total.add(r.amount), money(0));

const ofKind = (rows: Row[], ...kinds: TransactionKind[]) =>
  rows.filter((r) => kinds.includes(r.kind));

/**
 * Aggregates every dashboard metric for one user and month.
 *
 * Reads the unified ledger, which is what makes the headline numbers honest:
 * - spending and budgets count SPEND only, so lending money no longer blows a budget;
 * - cash on hand sums every kind, plus the user's opening balance, so lending and collecting nets to
 *   zero and the figure can match real money (D-62);
 * - net worth folds in what is still owed in each direction.
 */
export async function getDashboardSummary(userId: string, month: string): Promise<DashboardSummary> {
  // Today's date (user's timezone) is in the key: "up to today" figures and the comparison's day
  // change at midnight, so yesterday's cached answer must not be served today.
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const today = dayKeyInZone(new Date(), user?.timezone ?? DEFAULT_TIMEZONE);
  const cacheKey = `dashboard_${userId}_${month}_${today}`;
  const cached = cache.get<DashboardSummary>(cacheKey);
  if (cached) return cached;

  const result = await buildDashboardSummary(userId, month);
  cache.set(cacheKey, result);
  return result;
}

export type DashboardSummary = Awaited<ReturnType<typeof buildDashboardSummary>>;

async function buildDashboardSummary(userId: string, month: string) {
  const prevMonth = getPreviousMonth(month);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true, openingBalance: true },
  });
  const timezone = user?.timezone ?? DEFAULT_TIMEZONE;
  // Cash before the first entry (D-62). Null = never set, counted as 0.
  const openingBalance = user?.openingBalance ?? money(0);

  const [monthRows, prevMonthRows, toDateRows, toPrevMonthRows, budgets, prevMonthBudgets, categories, allLoans, settlementRows] =
    await Promise.all([
      prisma.transaction.findMany({
        where: { userId, month },
        select: { kind: true, amount: true, categoryId: true, needWant: true, date: true },
      }),
      prisma.transaction.findMany({
        where: { userId, month: prevMonth, kind: "SPEND" },
        select: { kind: true, amount: true, categoryId: true, needWant: true, date: true },
      }),
      // Everything up to and including the selected month — the closing position.
      prisma.transaction.groupBy({
        by: ["kind"],
        where: { userId, month: { lte: month } },
        _sum: { amount: true },
      }),
      // Everything up to the *previous* month — the opening position. Having both is what makes
      // month-over-month continuity expressible, and checkable.
      prisma.transaction.groupBy({
        by: ["kind"],
        where: { userId, month: { lt: month } },
        _sum: { amount: true },
      }),
      prisma.budget.findMany({ where: { userId, month }, include: { category: true } }),
      prisma.budget.findMany({ where: { userId, month: prevMonth } }),
      prisma.category.findMany({ where: { userId } }),
      prisma.loan.findMany({ where: { userId } }),
      // Settlement movements, so a loan's outstanding balance can be reconstructed *as of* a past
      // month rather than read from its present-day settledAmount.
      prisma.transaction.findMany({
        where: { userId, loanId: { not: null }, kind: { in: ["COLLECT", "REPAY"] } },
        select: { loanId: true, amount: true, month: true },
      }),
    ]);

  const monthlyIncome = sum(ofKind(monthRows, "EARN"));
  const totalExpenses = sum(ofKind(monthRows, "SPEND"));

  // Every kind moves cash, not just spending and earning.
  const netCashThisMonth = monthRows.reduce(
    (total, r) => total.add(r.amount.mul(CASH_SIGN[r.kind])),
    money(0)
  );

  const cashFrom = (rows: { kind: TransactionKind; _sum: { amount: Prisma.Decimal | null } }[]) =>
    rows.reduce((total, r) => total.add((r._sum.amount ?? money(0)).mul(CASH_SIGN[r.kind])), money(0));

  const closingCash = cashFrom(toDateRows).add(openingBalance);
  const openingCash = cashFrom(toPrevMonthRows).add(openingBalance);

  /**
   * Outstanding debt **as of the end of the selected month**.
   *
   * This used to read every loan's present-day `settledAmount`, regardless of when the loan was
   * opened — so viewing August added a loan created in September to August's net worth. The two
   * halves of the balance sheet were measured at different instants.
   *
   * A loan counts once it was opened on or before the period, and its outstanding balance is the
   * principal less the settlements recorded by then. Deriving it this way also handles a loan
   * created with `recordCashflow: false`: it has no opening cash movement but is still a real
   * obligation.
   */
  const settlementsByLoan = new Map<string, { amount: Prisma.Decimal; month: string }[]>();
  for (const s of settlementRows) {
    if (!s.loanId) continue;
    settlementsByLoan.set(s.loanId, [...(settlementsByLoan.get(s.loanId) ?? []), s]);
  }

  // Shared with GET /loans?month, so the Loans tab's totals always equal these (R-41). A loan counts
  // from its own date (D-62), not from when it was recorded.
  function debtPositionAsOf(periodMonth: string) {
    let lent = money(0);
    let borrowed = money(0);
    for (const loan of allLoans) {
      const position = loanAsOfMonth(loan, settlementsByLoan.get(loan.id) ?? [], periodMonth, timezone);
      if (!position.opened) continue;
      if (loan.type === "LENT") lent = lent.add(position.remaining);
      else borrowed = borrowed.add(position.remaining);
    }
    return { lent, borrowed };
  }

  const closingDebt = debtPositionAsOf(month);
  const openingDebt = debtPositionAsOf(prevMonth);

  const totalLentOutstanding = closingDebt.lent;
  const totalBorrowedOutstanding = closingDebt.borrowed;

  // Balance sheet, all measured at the same instant: what you'd be worth at the end of this month.
  const closingNetWorth = closingCash.add(closingDebt.lent).sub(closingDebt.borrowed);
  const openingNetWorth = openingCash.add(openingDebt.lent).sub(openingDebt.borrowed);

  // Income-statement figure for the period. Signed — an overspent month must read negative.
  const savingsThisMonth = subtract(monthlyIncome, totalExpenses);

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
  const dailyAllowance =
    daysRemaining > 0 && savingsThisMonth.greaterThan(0)
      ? Math.round(toNumber(savingsThisMonth) / daysRemaining)
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
  // Deliberately a live, forward-looking list rather than an as-of-date one: "what is coming up"
  // only means anything relative to now, so it reads today's settledAmount and today's clock.
  //
  // A loan due *today* is not overdue. Comparing against the raw instant marked anything due
  // today as already late from one minute past midnight, so the boundary is the start of today:
  // overdue means the due date has actually passed.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const upcomingObligations = allLoans
    .filter((l) => l.status !== "SETTLED" && l.dueDate)
    .sort((a, b) => a.dueDate!.getTime() - b.dueDate!.getTime())
    .slice(0, 5)
    .map((l) => ({
      id: l.id,
      type: l.type,
      personName: l.personName,
      remainingAmount: toNumber(clampPositive(subtract(l.amount, l.settledAmount))),
      dueDate: l.dueDate!.toISOString(),
      isOverdue: l.dueDate!.getTime() < startOfToday.getTime(),
    }));

  // --- Home v3 (R-35, R-39) ----------------------------------------------------------------
  // The month's place relative to today, in the user's timezone (not UTC, as the pacing above is).
  // `now` is the pacing code's clock, above.
  const currentMonth = monthKeyInZone(now, timezone);
  const period: "past" | "current" | "future" =
    month < currentMonth ? "past" : month > currentMonth ? "future" : "current";
  // "Up to today" = dated before the start of tomorrow (a picked day is saved at 12:00, D-63).
  const endOfToday = startOfTomorrowInZone(now, timezone);

  // Cash available: this month's story (D-63). The cash at the start of the month, plus the month's
  // movements (for the current month, only those up to today), is the figure.
  const storyRows = period === "current" ? monthRows.filter((r) => r.date < endOfToday) : monthRows;
  const story = {
    startOfMonth: openingCash,
    income: sum(ofKind(storyRows, "EARN")),
    expenses: sum(ofKind(storyRows, "SPEND")),
    lent: sum(ofKind(storyRows, "LEND_OUT")),
    borrowed: sum(ofKind(storyRows, "BORROW_IN")),
    collected: sum(ofKind(storyRows, "COLLECT")),
    repaid: sum(ofKind(storyRows, "REPAY")),
  };
  const cashAvailableAmount = story.startOfMonth
    .add(story.income)
    .add(story.borrowed)
    .add(story.collected)
    .sub(story.expenses)
    .sub(story.lent)
    .sub(story.repaid);

  // Spending against the previous month. For the current month both sides stop at the same day
  // (day N), or "you spent less than last month" would be true on every day but the last (R-39).
  const byCategory = (rows: Row[]) => {
    const totals = new Map<string, Prisma.Decimal>();
    for (const r of rows) {
      if (!r.categoryId) continue;
      totals.set(r.categoryId, (totals.get(r.categoryId) ?? money(0)).add(r.amount));
    }
    return [...totals].map(([categoryId, amount]) => ({ categoryId, amount: toNumber(amount) }));
  };
  let comparison: {
    currentTotal: number;
    currentByCategory: { categoryId: string; amount: number }[];
    previousTotal: number;
    previousByCategory: { categoryId: string; amount: number }[];
    toDay: number | null;
  } | null = null;
  if (period !== "future") {
    let currentSpend = ofKind(monthRows, "SPEND");
    let previousSpend = prevMonthRows;
    let toDay: number | null = null;
    if (period === "current") {
      toDay = datePartsInZone(now, timezone).day;
      currentSpend = currentSpend.filter((r) => r.date < endOfToday);
      const [prevYear, prevMonthNum] = prevMonth.split("-").map(Number);
      const prevMonthDays = new Date(Date.UTC(prevYear, prevMonthNum, 0)).getUTCDate();
      const previousCutoff = startOfDayInZone(prevYear, prevMonthNum, Math.min(toDay, prevMonthDays) + 1, timezone);
      previousSpend = previousSpend.filter((r) => r.date < previousCutoff);
    }
    comparison = {
      currentTotal: toNumber(sum(currentSpend)),
      currentByCategory: byCategory(currentSpend),
      previousTotal: toNumber(sum(previousSpend)),
      previousByCategory: byCategory(previousSpend),
      toDay,
    };
  }

  const result = {
    month,

    cashAvailable: {
      amount: toNumber(cashAvailableAmount),
      period,
      /** Null until the user sets it: Home asks for it then (R-34). */
      openingBalance: user?.openingBalance === null || user?.openingBalance === undefined ? null : toNumber(user.openingBalance),
      breakdown: {
        startOfMonth: toNumber(story.startOfMonth),
        income: toNumber(story.income),
        expenses: toNumber(story.expenses),
        lent: toNumber(story.lent),
        borrowed: toNumber(story.borrowed),
        collected: toNumber(story.collected),
        repaid: toNumber(story.repaid),
      },
    },
    comparison,

    // --- Balance sheet: measured at the END of this month ---------------------------------
    cashOnHand: toNumber(closingCash),
    netWorth: toNumber(closingNetWorth),

    // Opening position, i.e. the close of the previous month. `openingCash + netCashThisMonth`
    // must equal `cashOnHand`, which is what makes month-over-month continuity checkable.
    openingCash: toNumber(openingCash),
    closingCash: toNumber(closingCash),
    openingNetWorth: toNumber(openingNetWorth),
    closingNetWorth: toNumber(closingNetWorth),

    netCashThisMonth: toNumber(netCashThisMonth),

    // This month
    monthlyIncome: toNumber(monthlyIncome),
    totalExpenses: toNumber(totalExpenses),
    // Income statement for the period. Signed on purpose: an overspent month must read negative.
    savingsThisMonth: toNumber(savingsThisMonth),
    /** @deprecated superseded by `savingsThisMonth`; retained for installed clients. */
    remainingBalance: toNumber(savingsThisMonth),
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

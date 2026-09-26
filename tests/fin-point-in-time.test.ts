import { describe, it, expect } from "vitest";
import { getDashboardSummary } from "../src/modules/dashboard/dashboard.service";
import { createLoan, settleLoan } from "../src/modules/loans/loans.service";
import { createTransaction, deleteTransaction } from "../src/modules/transactions/transactions.service";
import { makeUser, makeLoan, spend, earn, dateOf, categoryFor, currentMonth } from "./helpers/factories";

/**
 * FIN — point-in-time accounting (P0).
 *
 * Net worth is a balance-sheet figure: every component must be measured at the SAME instant.
 * The dashboard previously scoped cash to the selected month but read every loan's present-day
 * balance, so viewing August included debt opened in September.
 */
describe("FIN — point-in-time accounting", () => {
  it("FIN-001: a loan opened in September does not appear in August's debt position", async () => {
    const user = await makeUser();
    await earn(user.id, 55_000, dateOf("2026-08-10"));

    await makeLoan({
      userId: user.id,
      type: "LENT",
      amount: 10_000,
      createdAt: dateOf("2026-09-15"),
    });

    const august = await getDashboardSummary(user.id, "2026-08");

    expect(august.netDebtSnapshot.totalLent).toBe(0);
    expect(august.cashOnHand).toBe(55_000);
    expect(august.netWorth).toBe(55_000);
  });

  it("FIN-002: a loan settled in September still shows outstanding in August", async () => {
    const user = await makeUser();
    const loan = await makeLoan({
      userId: user.id,
      type: "LENT",
      amount: 10_000,
      createdAt: dateOf("2026-08-05"),
    });
    await settleLoan(user.id, loan.id, undefined, dateOf("2026-09-20"));

    const august = await getDashboardSummary(user.id, "2026-08");
    const september = await getDashboardSummary(user.id, "2026-09");

    expect(august.netDebtSnapshot.totalLent).toBe(10_000);
    expect(september.netDebtSnapshot.totalLent).toBe(0);
  });

  it("FIN-003: netWorth = cash + lent − borrowed, in every month", async () => {
    const user = await makeUser();
    await earn(user.id, 100_000, dateOf("2026-06-01"));
    await spend(user.id, 20_000, dateOf("2026-06-15"));
    await makeLoan({ userId: user.id, type: "LENT", amount: 15_000, createdAt: dateOf("2026-07-02") });
    await makeLoan({ userId: user.id, type: "BORROWED", amount: 5_000, createdAt: dateOf("2026-07-10") });
    await spend(user.id, 8_000, dateOf("2026-08-03"));

    for (const month of ["2026-06", "2026-07", "2026-08", "2026-09"]) {
      const d = await getDashboardSummary(user.id, month);
      expect(
        d.cashOnHand + d.netDebtSnapshot.totalLent - d.netDebtSnapshot.totalBorrowed,
        `netWorth identity failed for ${month}`
      ).toBe(d.netWorth);
    }
  });

  it("FIN-004: with every loan carrying its opening movement, netWorth = ΣEARN − ΣSPEND", async () => {
    const user = await makeUser();
    await earn(user.id, 100_000, dateOf("2026-06-01"));
    await spend(user.id, 20_000, dateOf("2026-06-15"));
    await makeLoan({ userId: user.id, type: "LENT", amount: 15_000, createdAt: dateOf("2026-07-02") });
    await makeLoan({ userId: user.id, type: "BORROWED", amount: 5_000, createdAt: dateOf("2026-07-10") });
    await spend(user.id, 8_000, dateOf("2026-08-03"));

    // Every loan term cancels: moving money between pockets can't change what you're worth.
    expect((await getDashboardSummary(user.id, "2026-07")).netWorth).toBe(100_000 - 20_000);
    expect((await getDashboardSummary(user.id, "2026-09")).netWorth).toBe(100_000 - 20_000 - 8_000);
  });

  it("FIN-005: each month's closing cash is the next month's opening cash, with no gaps", async () => {
    const user = await makeUser();
    await earn(user.id, 50_000, dateOf("2026-01-10"));
    await spend(user.id, 12_000, dateOf("2026-02-05"));
    await earn(user.id, 30_000, dateOf("2026-03-01"));
    await spend(user.id, 9_500, dateOf("2026-03-20"));

    let previousClosing: number | null = null;
    for (const month of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"]) {
      const d = await getDashboardSummary(user.id, month);
      if (previousClosing !== null) expect(d.openingCash, `gap between months at ${month}`).toBe(previousClosing);
      previousClosing = d.closingCash;
    }
  });

  it("FIN-006: opening cash plus the month's net cash is the closing cash", async () => {
    const user = await makeUser();
    await earn(user.id, 50_000, dateOf("2026-01-10"));
    await spend(user.id, 12_000, dateOf("2026-02-05"));
    await makeLoan({ userId: user.id, type: "LENT", amount: 6_000, createdAt: dateOf("2026-02-12") });
    await earn(user.id, 30_000, dateOf("2026-03-01"));

    for (const month of ["2026-01", "2026-02", "2026-03", "2026-04"]) {
      const d = await getDashboardSummary(user.id, month);
      expect(d.openingCash + d.netCashThisMonth, `continuity broke inside ${month}`).toBe(d.closingCash);
    }
  });

  it("FIN-007: opening net worth plus this month's savings equals closing net worth", async () => {
    const user = await makeUser();
    await earn(user.id, 40_000, dateOf("2026-04-02"));
    await spend(user.id, 15_000, dateOf("2026-05-08"));
    await earn(user.id, 10_000, dateOf("2026-05-25"));

    for (const month of ["2026-04", "2026-05", "2026-06"]) {
      const d = await getDashboardSummary(user.id, month);
      expect(d.openingNetWorth + d.savingsThisMonth, `net worth continuity broke at ${month}`).toBe(
        d.closingNetWorth
      );
    }
  });

  it("FIN-008: a month with no activity carries the balance through unchanged", async () => {
    const user = await makeUser();
    await earn(user.id, 25_000, dateOf("2026-01-15"));

    const quiet = await getDashboardSummary(user.id, "2026-02");

    expect(quiet.monthlyIncome).toBe(0);
    expect(quiet.totalExpenses).toBe(0);
    expect(quiet.netCashThisMonth).toBe(0);
    expect(quiet.openingCash).toBe(25_000);
    expect(quiet.closingCash).toBe(25_000);
    expect(quiet.netWorth).toBe(25_000);
  });

  it("FIN-009: income in the selected month counts toward that month and the running cash", async () => {
    const user = await makeUser();
    await earn(user.id, 12_000, dateOf("2026-03-05"));
    await earn(user.id, 8_000, dateOf("2026-03-28"));

    const march = await getDashboardSummary(user.id, "2026-03");

    expect(march.monthlyIncome).toBe(20_000);
    expect(march.openingCash).toBe(0);
    expect(march.closingCash).toBe(20_000);
    expect(march.savingsThisMonth).toBe(20_000);
  });

  it("FIN-012: the first month ever opens at zero", async () => {
    const user = await makeUser();
    await earn(user.id, 1_000, dateOf("2026-05-01"));

    const first = await getDashboardSummary(user.id, "2026-05");
    expect(first.openingCash).toBe(0);
    expect(first.openingNetWorth).toBe(0);
  });

  it("FIN-013: a long gap with no activity preserves the balance across it", async () => {
    const user = await makeUser();
    await earn(user.id, 70_000, dateOf("2025-01-10"));

    const muchLater = await getDashboardSummary(user.id, "2026-01");
    expect(muchLater.openingCash).toBe(70_000);
    expect(muchLater.closingCash).toBe(70_000);
  });

  it("FIN-014: a loan recorded without cashflow lowers net worth but not cash", async () => {
    const user = await makeUser();
    await earn(user.id, 30_000, dateOf("2026-02-01"));

    // A debt that predates the app: the money moved before we were tracking it.
    await createLoan(user.id, { type: "BORROWED", personName: "Old Debt", amount: 5_000, recordCashflow: false });

    const d = await getDashboardSummary(user.id, "2026-12");
    expect(d.cashOnHand, "cash must not move").toBe(30_000);
    expect(d.netDebtSnapshot.totalBorrowed).toBe(5_000);
    expect(d.netWorth).toBe(25_000);
  });

  it("FIN-015: repaying such a loan costs cash, and net worth holds because the debt goes too", async () => {
    const user = await makeUser();
    await earn(user.id, 30_000, dateOf("2026-02-01"));
    const loan = await createLoan(user.id, { type: "BORROWED", personName: "Old Debt", amount: 5_000, recordCashflow: false });

    await settleLoan(user.id, loan.id);

    const d = await getDashboardSummary(user.id, "2026-12");
    expect(d.cashOnHand).toBe(25_000);
    expect(d.netDebtSnapshot.totalBorrowed).toBe(0);
    expect(d.netWorth, "settling must not change net worth").toBe(25_000);
  });

  it("FIN-016: December's closing balance is January's opening balance", async () => {
    const user = await makeUser();
    await earn(user.id, 20_000, dateOf("2026-12-10"));

    const dec = await getDashboardSummary(user.id, "2026-12");
    const jan = await getDashboardSummary(user.id, "2027-01");

    expect(dec.closingCash).toBe(20_000);
    expect(jan.openingCash).toBe(20_000);
  });

  it("FIN-017: backdating into a closed month ripples into every later opening balance", async () => {
    const user = await makeUser();
    await earn(user.id, 10_000, dateOf("2026-06-01"));

    const beforeBackdate = await getDashboardSummary(user.id, "2026-08");
    expect(beforeBackdate.openingCash).toBe(10_000);

    // Deliberately through the service rather than a fixture: backdating must also invalidate the
    // cached dashboards of every *later* month, not just the one the row lands in.
    const food = await categoryFor(user.id, "Food");
    await createTransaction(user.id, {
      kind: "SPEND",
      amount: 4_000,
      date: dateOf("2026-06-20"),
      categoryId: food.id,
    });

    const afterBackdate = await getDashboardSummary(user.id, "2026-08");
    expect(afterBackdate.openingCash, "later months must reflect the backdated row").toBe(6_000);
  });

  it("FIN-019: an overspent month reports a negative figure, never clamped to zero", async () => {
    const user = await makeUser();
    await earn(user.id, 5_000, dateOf("2026-07-01"));
    await spend(user.id, 12_000, dateOf("2026-07-15"));

    const july = await getDashboardSummary(user.id, "2026-07");
    expect(july.savingsThisMonth).toBe(-7_000);
    expect(july.remainingBalance).toBe(-7_000); // legacy alias kept for installed clients
  });

  it("FIN-022: two users' balances never influence one another", async () => {
    const alice = await makeUser();
    const bob = await makeUser();

    await earn(alice.id, 90_000, dateOf("2026-05-01"));
    await earn(bob.id, 1_000, dateOf("2026-05-01"));
    await makeLoan({ userId: bob.id, type: "LENT", amount: 500, createdAt: dateOf("2026-05-02") });

    const a = await getDashboardSummary(alice.id, "2026-05");
    const b = await getDashboardSummary(bob.id, "2026-05");

    expect(a.cashOnHand).toBe(90_000);
    expect(a.netDebtSnapshot.totalLent).toBe(0);
    expect(b.cashOnHand).toBe(500); // 1000 earned, 500 lent out
    expect(b.netDebtSnapshot.totalLent).toBe(500);
  });

  it("FIN-020: the trend series agrees with each month's own spending figure", async () => {
    const user = await makeUser();
    const food = await categoryFor(user.id, "Food");
    await spend(user.id, 1_000, dateOf("2026-07-05"), food.id);
    await spend(user.id, 2_500, dateOf("2026-08-05"), food.id);

    const d = await getDashboardSummary(user.id, "2026-08");
    const byMonth = new Map(d.trend.map((t) => [t.month, t.totalExpenses]));

    expect(d.trend).toHaveLength(12);
    expect(byMonth.get("2026-07")).toBe(1_000);
    expect(byMonth.get("2026-08")).toBe(2_500);
    expect(byMonth.get("2026-08")).toBe(d.totalExpenses);
  });
});

describe("FIN — the current month, future months and deletions", () => {
  it("FIN-010: income dated later this month already counts in this month's figures (D-9: end of month)", async () => {
    // The spec's other half, "excluded as of today", has no figure to test: D-9 measures every
    // dashboard figure at the end of the selected month, and the API has no as-of-today value.
    const user = await makeUser();
    const now = currentMonth();
    await earn(user.id, 3_000, now.day(1));
    await earn(user.id, 7_000, now.day(now.lastDay));

    const d = await getDashboardSummary(user.id, now.key);

    expect(d.monthlyIncome).toBe(10_000);
    expect(d.closingCash).toBe(10_000);
  });

  it("FIN-011: a future month shows today's cash, with no income or spending of its own", async () => {
    const user = await makeUser();
    const now = currentMonth();
    await earn(user.id, 20_000, now.day(1));
    await spend(user.id, 4_500, now.day(1));
    const current = await getDashboardSummary(user.id, now.key);

    const future = await getDashboardSummary(user.id, now.plusMonths(3));

    expect(future.closingCash).toBe(current.closingCash);
    expect(future.openingCash).toBe(current.closingCash);
    expect(future.monthlyIncome).toBe(0);
    expect(future.totalExpenses).toBe(0);
  });

  it("FIN-018: deleting a past transaction ripples into every later month", async () => {
    const user = await makeUser();
    const food = await categoryFor(user.id, "Food");
    await earn(user.id, 10_000, dateOf("2026-06-01"));
    const lunch = await createTransaction(user.id, { kind: "SPEND", amount: 3_000, date: dateOf("2026-06-15"), categoryId: food.id });

    expect((await getDashboardSummary(user.id, "2026-08")).openingCash).toBe(7_000);

    // Through the service, so every later month's cached dashboard must be invalidated too.
    await deleteTransaction(user.id, lunch.id);

    const june = await getDashboardSummary(user.id, "2026-06");
    expect(june.totalExpenses).toBe(0);
    expect(june.closingCash).toBe(10_000);
    for (const month of ["2026-07", "2026-08", "2026-12"]) {
      const d = await getDashboardSummary(user.id, month);
      expect(d.openingCash, month).toBe(10_000);
      expect(d.openingNetWorth, month).toBe(10_000);
    }
  });
});

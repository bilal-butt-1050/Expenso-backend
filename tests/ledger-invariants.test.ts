import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { getDashboardSummary } from "../src/modules/dashboard/dashboard.service";
import { createLoan, settleLoan, updateLoan, deleteLoan } from "../src/modules/loans/loans.service";
import {
  createTransaction,
  deleteTransaction,
  updateTransaction,
  CASH_SIGN,
} from "../src/modules/transactions/transactions.service";
import { makeUser, categoryFor, earn, dateOf, currentMonth } from "./helpers/factories";

/**
 * LEDGER — the invariants that make the numbers trustworthy (P0).
 *
 * Lending money and collecting it back used to invent net worth: creating a loan wrote no
 * cashflow, settling one wrote income. These assert the properties that make that impossible.
 */

/** Cash derived straight from the rows, independent of the dashboard's own arithmetic. */
async function cashFromLedger(userId: string): Promise<number> {
  const rows = await prisma.transaction.findMany({
    where: { userId },
    select: { kind: true, amount: true },
  });
  return rows
    .reduce((t, r) => t.add(r.amount.mul(CASH_SIGN[r.kind])), new Prisma.Decimal(0))
    .toNumber();
}

describe("LEDGER — money invariants", () => {
  it("LED-001: lend then collect in full leaves net worth untouched", async () => {
    const user = await makeUser();
    await earn(user.id, 50_000, dateOf("2026-03-01"));

    const before = await getDashboardSummary(user.id, "2026-12");

    const loan = await createLoan(user.id, {
      type: "LENT",
      personName: "Ahmed",
      amount: 10_000,
    });

    const lent = await getDashboardSummary(user.id, "2026-12");
    expect(lent.cashOnHand, "cash must fall when the money leaves").toBe(before.cashOnHand - 10_000);
    expect(lent.netWorth, "net worth must not move on a transfer").toBe(before.netWorth);

    await settleLoan(user.id, loan.id);

    const after = await getDashboardSummary(user.id, "2026-12");
    expect(after.cashOnHand).toBe(before.cashOnHand);
    expect(after.netWorth).toBe(before.netWorth);
  });

  it("LED-002: borrow then repay in full leaves net worth untouched", async () => {
    const user = await makeUser();
    await earn(user.id, 50_000, dateOf("2026-03-01"));
    const before = await getDashboardSummary(user.id, "2026-12");

    const loan = await createLoan(user.id, {
      type: "BORROWED",
      personName: "Bank",
      amount: 8_000,
    });

    const borrowed = await getDashboardSummary(user.id, "2026-12");
    expect(borrowed.cashOnHand).toBe(before.cashOnHand + 8_000);
    expect(borrowed.netWorth).toBe(before.netWorth);

    await settleLoan(user.id, loan.id);

    const after = await getDashboardSummary(user.id, "2026-12");
    expect(after.cashOnHand).toBe(before.cashOnHand);
    expect(after.netWorth).toBe(before.netWorth);
  });

  it("LED-005: reported cash always equals the sum of signed movements", async () => {
    const user = await makeUser();
    const food = await categoryFor(user.id, "Food");

    await earn(user.id, 40_000, dateOf("2026-01-05"));
    await createTransaction(user.id, {
      kind: "SPEND",
      amount: 3_000,
      date: dateOf("2026-01-10"),
      categoryId: food.id,
    });
    const l1 = await createLoan(user.id, { type: "LENT", personName: "A", amount: 6_000 });
    await createLoan(user.id, { type: "BORROWED", personName: "B", amount: 2_500 });
    await settleLoan(user.id, l1.id, 2_000);

    const d = await getDashboardSummary(user.id, "2026-12");
    expect(d.cashOnHand).toBe(await cashFromLedger(user.id));
  });

  it("LED-007: partial settlements sum to the same outcome as one full settlement", async () => {
    const user = await makeUser();
    await earn(user.id, 30_000, dateOf("2026-02-01"));
    const loan = await createLoan(user.id, { type: "LENT", personName: "C", amount: 9_000 });

    await settleLoan(user.id, loan.id, 3_000);
    await settleLoan(user.id, loan.id, 3_000);
    await settleLoan(user.id, loan.id, 3_000);

    const fresh = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(fresh.status).toBe("SETTLED");
    expect(fresh.settledAmount.toNumber()).toBe(9_000);

    const d = await getDashboardSummary(user.id, "2026-12");
    expect(d.netDebtSnapshot.totalLent).toBe(0);
    expect(d.cashOnHand).toBe(30_000);
  });

  it("LED-008: a hundred one-paisa settlements leave no rounding drift", async () => {
    const user = await makeUser();
    await earn(user.id, 100, dateOf("2026-02-01"));
    const loan = await createLoan(user.id, { type: "LENT", personName: "D", amount: 1 });

    for (let i = 0; i < 100; i++) {
      await settleLoan(user.id, loan.id, 0.01);
    }

    const fresh = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(fresh.settledAmount.toNumber()).toBe(1);
    expect(fresh.status).toBe("SETTLED");
  });

  const statusOf = (p: Promise<unknown>) => p.then(() => 200, (e: { statusCode?: number }) => e.statusCode);

  it("LED-011: an amount of zero is refused, for a loan and for a settlement, and nothing is written", async () => {
    const user = await makeUser();
    expect(await statusOf(createLoan(user.id, { type: "LENT", personName: "E", amount: 0 }))).toBe(400);

    const loan = await createLoan(user.id, { type: "LENT", personName: "E", amount: 100 });
    expect(await statusOf(settleLoan(user.id, loan.id, 0))).toBe(400);

    expect(await prisma.loan.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.transaction.count({ where: { loanId: loan.id, kind: "COLLECT" } })).toBe(0);
  });

  it("LED-012: a negative amount is refused, for a loan and for a settlement, and nothing is written", async () => {
    const user = await makeUser();
    expect(await statusOf(createLoan(user.id, { type: "LENT", personName: "E", amount: -5 }))).toBe(400);

    const loan = await createLoan(user.id, { type: "LENT", personName: "E", amount: 100 });
    expect(await statusOf(settleLoan(user.id, loan.id, -1))).toBe(400);

    expect(await prisma.loan.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.transaction.count({ where: { loanId: loan.id, kind: "COLLECT" } })).toBe(0);
  });

  it("LED-014: settling more than what's left clamps to what's left", async () => {
    const user = await makeUser();
    const loan = await createLoan(user.id, { type: "LENT", personName: "E", amount: 100 });
    await settleLoan(user.id, loan.id, 30);

    await settleLoan(user.id, loan.id, 500);

    const fresh = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(fresh.settledAmount.toNumber()).toBe(100);
    expect(fresh.status).toBe("SETTLED");
    const collected = (await prisma.transaction.findMany({ where: { loanId: loan.id, kind: "COLLECT" } }))
      .map((t) => t.amount.toNumber())
      .sort((a, b) => a - b);
    expect(collected, "the second movement is the clamped amount, not the requested one").toEqual([30, 70]);
  });

  it("LED-015: settling an already settled loan is a 400 and writes nothing", async () => {
    const user = await makeUser();
    const loan = await createLoan(user.id, { type: "LENT", personName: "E", amount: 100 });
    await settleLoan(user.id, loan.id);
    const movements = await prisma.transaction.count({ where: { loanId: loan.id } });

    const err = await settleLoan(user.id, loan.id).catch((e) => e);

    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/already fully settled/i);
    expect(await prisma.transaction.count({ where: { loanId: loan.id } })).toBe(movements);
  });

  it("LED-019: deleting a loan removes its movements and restores cash", async () => {
    const user = await makeUser();
    await earn(user.id, 20_000, dateOf("2026-04-01"));
    const before = await cashFromLedger(user.id);

    const loan = await createLoan(user.id, { type: "LENT", personName: "F", amount: 7_000 });
    await settleLoan(user.id, loan.id, 3_000);
    await deleteLoan(user.id, loan.id);

    expect(await cashFromLedger(user.id)).toBe(before);
    const orphans = await prisma.transaction.count({ where: { loanId: loan.id } });
    expect(orphans, "movements must cascade with the loan").toBe(0);
  });

  it("LED-020: deleting a loan-linked transaction directly is a 409, and nothing changes", async () => {
    const user = await makeUser();
    const loan = await createLoan(user.id, { type: "BORROWED", personName: "G", amount: 4_000 });
    const movement = await prisma.transaction.findFirstOrThrow({ where: { loanId: loan.id } });

    const err = await deleteTransaction(user.id, movement.id).catch((e) => e);

    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/belongs to a loan/i);
    expect(await prisma.transaction.count({ where: { id: movement.id } })).toBe(1);
  });

  it("LED-021: editing a loan-linked transaction directly is a 409, and nothing changes", async () => {
    const user = await makeUser();
    const loan = await createLoan(user.id, { type: "BORROWED", personName: "G", amount: 4_000 });
    const movement = await prisma.transaction.findFirstOrThrow({ where: { loanId: loan.id } });

    const err = await updateTransaction(user.id, movement.id, { amount: 1 }).catch((e) => e);

    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/belongs to a loan/i);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: movement.id } })).amount.toNumber()).toBe(4_000);
  });

  it("LED-022: principal can't drop below what's already settled", async () => {
    const user = await makeUser();
    const loan = await createLoan(user.id, { type: "LENT", personName: "H", amount: 5_000 });
    await settleLoan(user.id, loan.id, 3_000);

    const err = await updateLoan(user.id, loan.id, { amount: 1_000 }).catch((e) => e);

    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/cannot be less than/i);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).amount.toNumber()).toBe(5_000);
  });

  it("LED-023: editing the principal moves the opening movement with it", async () => {
    const user = await makeUser();
    const loan = await createLoan(user.id, { type: "LENT", personName: "H", amount: 5_000 });
    await settleLoan(user.id, loan.id, 3_000);

    await updateLoan(user.id, loan.id, { amount: 8_000 });

    const opening = await prisma.transaction.findFirstOrThrow({ where: { loanId: loan.id, kind: "LEND_OUT" } });
    expect(opening.amount.toNumber(), "opening movement must follow the principal").toBe(8_000);
  });

  it("LED-025: budgets, the category breakdown and needs/wants ignore all four loan kinds", async () => {
    const user = await makeUser();
    const food = await categoryFor(user.id, "Food");
    // Loans and their movements are stamped "now", so everything happens in the current month.
    const month = currentMonth();
    await prisma.budget.create({ data: { userId: user.id, categoryId: food.id, amount: new Prisma.Decimal(5_000), month: month.key } });
    await earn(user.id, 60_000, month.day(1));
    await createTransaction(user.id, { kind: "SPEND", amount: 1_200, date: month.day(1), categoryId: food.id, needWant: "Need" });

    const lent = await createLoan(user.id, { type: "LENT", personName: "Out", amount: 9_000 });
    await settleLoan(user.id, lent.id, 4_000);
    const owed = await createLoan(user.id, { type: "BORROWED", personName: "In", amount: 7_000 });
    await settleLoan(user.id, owed.id, 3_000);
    const kinds = await prisma.transaction.findMany({
      where: { userId: user.id, month: month.key },
      distinct: ["kind"],
      select: { kind: true },
    });
    expect(kinds.map((k) => k.kind).sort()).toEqual(["BORROW_IN", "COLLECT", "EARN", "LEND_OUT", "REPAY", "SPEND"]);

    const d = await getDashboardSummary(user.id, month.key);

    expect(d.totalExpenses).toBe(1_200);
    expect(d.budgetVsActual.find((b) => b.categoryId === food.id)?.actual).toBe(1_200);
    expect(d.categoryBreakdown.map((c) => [c.categoryId, c.amount])).toEqual([[food.id, 1_200]]);
    expect(d.needsTotal).toBe(1_200);
    expect(d.wantsTotal).toBe(0);
  });

  it("LED-026: a large settlement doesn't consume any category budget", async () => {
    const user = await makeUser();
    const food = await categoryFor(user.id, "Food");
    const month = "2026-05";
    await earn(user.id, 60_000, dateOf("2026-05-01"));
    await prisma.budget.create({ data: { userId: user.id, categoryId: food.id, amount: new Prisma.Decimal(5_000), month } });
    await createTransaction(user.id, { kind: "SPEND", amount: 1_200, date: dateOf("2026-05-03"), categoryId: food.id });

    const loan = await createLoan(user.id, { type: "BORROWED", personName: "Big Debt", amount: 40_000 });
    await settleLoan(user.id, loan.id, undefined, dateOf("2026-05-20"));

    const d = await getDashboardSummary(user.id, month);
    const foodBudget = d.budgetVsActual.find((b) => b.categoryId === food.id);
    expect(foodBudget?.actual, "a 40,000 repayment must not touch the Food budget").toBe(1_200);
    expect(foodBudget?.status).toBe("On Track");
    expect(d.totalExpenses, "spending counts SPEND only").toBe(1_200);
  });

  it("LED-016: concurrent full settlements cannot over-settle a loan", async () => {
    const user = await makeUser();
    await earn(user.id, 50_000, dateOf("2026-06-01"));
    const loan = await createLoan(user.id, { type: "LENT", personName: "Race", amount: 5_000 });

    const results = await Promise.allSettled([
      settleLoan(user.id, loan.id),
      settleLoan(user.id, loan.id),
    ]);

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    expect(succeeded, "exactly one settlement may win").toBe(1);

    const fresh = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(fresh.settledAmount.toNumber()).toBe(5_000);

    const settlements = await prisma.transaction.count({
      where: { loanId: loan.id, kind: "COLLECT" },
    });
    expect(settlements, "only one cashflow row may be written").toBe(1);
  });

  it("LED-029: every money column is numeric(14,2), never a float", async () => {
    const rows = await prisma.$queryRawUnsafe<
      { table_name: string; column_name: string; data_type: string; numeric_scale: number }[]
    >(`
      SELECT table_name, column_name, data_type, numeric_scale
      FROM information_schema.columns
      WHERE table_name IN ('transactions', 'loans', 'budgets')
        AND column_name IN ('amount', 'settledAmount')
    `);

    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.data_type, `${r.table_name}.${r.column_name} must be numeric`).toBe("numeric");
      expect(Number(r.numeric_scale)).toBe(2);
    }
  });
});

describe("LEDGER — loans move cash, not net worth", () => {
  it("LED-003: lending X lowers cash by X, leaves net worth alone, and adds X to what's lent", async () => {
    const user = await makeUser();
    await earn(user.id, 50_000, dateOf("2026-03-01"));
    const before = await getDashboardSummary(user.id, "2026-12");

    await createLoan(user.id, { type: "LENT", personName: "Ahmed", amount: 12_345.67 });

    const after = await getDashboardSummary(user.id, "2026-12");
    expect(after.cashOnHand).toBe(before.cashOnHand - 12_345.67);
    expect(after.netWorth).toBe(before.netWorth);
    expect(after.netDebtSnapshot.totalLent).toBe(before.netDebtSnapshot.totalLent + 12_345.67);
  });

  it("LED-004: borrowing X raises cash by X, leaves net worth alone, and adds X to what's owed", async () => {
    const user = await makeUser();
    await earn(user.id, 5_000, dateOf("2026-03-01"));
    const before = await getDashboardSummary(user.id, "2026-12");

    await createLoan(user.id, { type: "BORROWED", personName: "Bank", amount: 8_000.5 });

    const after = await getDashboardSummary(user.id, "2026-12");
    expect(after.cashOnHand).toBe(before.cashOnHand + 8_000.5);
    expect(after.netWorth).toBe(before.netWorth);
    expect(after.netDebtSnapshot.totalBorrowed).toBe(before.netDebtSnapshot.totalBorrowed + 8_000.5);
  });

  it("LED-006: net worth = cash + outstanding lent − outstanding borrowed, from the rows themselves", async () => {
    const user = await makeUser();
    await earn(user.id, 90_000, dateOf("2026-02-01"));
    const lent = await createLoan(user.id, { type: "LENT", personName: "A", amount: 20_000 });
    const owed = await createLoan(user.id, { type: "BORROWED", personName: "B", amount: 15_000 });
    await createLoan(user.id, { type: "LENT", personName: "C", amount: 4_000, recordCashflow: false });
    await settleLoan(user.id, lent.id, 7_500);
    await settleLoan(user.id, owed.id, 2_000);

    const loans = await prisma.loan.findMany({ where: { userId: user.id } });
    const outstanding = (type: "LENT" | "BORROWED") =>
      loans
        .filter((l) => l.type === type)
        .reduce((t, l) => t.add(l.amount.sub(l.settledAmount)), new Prisma.Decimal(0))
        .toNumber();

    const d = await getDashboardSummary(user.id, "2026-12");
    expect(d.netWorth).toBe(
      new Prisma.Decimal(await cashFromLedger(user.id)).add(outstanding("LENT")).sub(outstanding("BORROWED")).toNumber()
    );
    expect(d.netDebtSnapshot.totalLent).toBe(outstanding("LENT"));
    expect(d.netDebtSnapshot.totalBorrowed).toBe(outstanding("BORROWED"));
  });

  it("LED-018: recordCashflow false writes the loan but no opening movement", async () => {
    const user = await makeUser();

    const loan = await createLoan(user.id, { type: "BORROWED", personName: "Old debt", amount: 3_000, recordCashflow: false });

    expect(await prisma.loan.count({ where: { id: loan.id } })).toBe(1);
    expect(await prisma.transaction.count({ where: { loanId: loan.id } })).toBe(0);
    expect(await cashFromLedger(user.id)).toBe(0);
  });

  it("LED-024: renaming a counterparty rewrites the descriptions of all its movements", async () => {
    const user = await makeUser();
    await earn(user.id, 10_000, dateOf("2026-03-01"));
    const loan = await createLoan(user.id, { type: "LENT", personName: "Ali", amount: 1_000 });
    await settleLoan(user.id, loan.id, 200);

    await updateLoan(user.id, loan.id, { personName: "  Ali Khan " });

    const descriptions = (await prisma.transaction.findMany({ where: { loanId: loan.id }, orderBy: { kind: "asc" } }))
      .map((t) => `${t.kind}: ${t.description}`)
      .sort();
    expect(descriptions).toEqual(["COLLECT: Repayment from Ali Khan", "LEND_OUT: Lent to Ali Khan"]);
  });

  it("LED-027: a loan of zero can't be created", async () => {
    const user = await makeUser();

    const err = await createLoan(user.id, { type: "LENT", personName: "Nobody", amount: 0 }).catch((e) => e);

    expect(err.statusCode).toBe(400);
    expect(await prisma.loan.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe("LEDGER — precision", () => {
  it("LED-009: 0.005 rounds to 0.01 as numeric(14,2) does, never truncating to zero", async () => {
    const user = await makeUser();

    const t = await createTransaction(user.id, { kind: "EARN", amount: 0.005, date: dateOf("2026-03-01"), source: "Tip" });

    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.amount.toString()).toBe("0.01");
  });

  it("LED-010: the largest numeric(14,2) amount stores and reads back exactly", async () => {
    const user = await makeUser();
    const max = 999_999_999_999.99;

    const t = await createTransaction(user.id, { kind: "EARN", amount: max, date: dateOf("2026-03-01"), source: "Big" });

    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.amount.toString()).toBe("999999999999.99");
    expect(t.amount).toBe(max);
    expect((await getDashboardSummary(user.id, "2026-03")).monthlyIncome).toBe(max);
  });
});

describe("LEDGER — concurrency", () => {
  it("LED-017: concurrent partial settlements totalling more than what's left never over-settle", async () => {
    const user = await makeUser();
    await earn(user.id, 1_000, dateOf("2026-03-01"));
    const loan = await createLoan(user.id, { type: "LENT", personName: "Many", amount: 100 });

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => settleLoan(user.id, loan.id, 30)));

    for (const r of results) {
      if (r.status === "rejected") expect([400, 409]).toContain((r.reason as { statusCode?: number }).statusCode);
    }
    const fresh = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    const collected = (await prisma.transaction.findMany({ where: { loanId: loan.id, kind: "COLLECT" } }))
      .reduce((t, r) => t.add(r.amount), new Prisma.Decimal(0));
    expect(fresh.settledAmount.lessThanOrEqualTo(100)).toBe(true);
    expect(collected.toString(), "every settled paisa has exactly one cash movement").toBe(fresh.settledAmount.toString());
  });

  it("LED-028: settling and deleting the same loan at once leaves no orphaned movements", async () => {
    const user = await makeUser();
    await earn(user.id, 50_000, dateOf("2026-03-01"));

    for (let i = 0; i < 10; i++) {
      const loan = await createLoan(user.id, { type: "LENT", personName: `Race ${i}`, amount: 1_000 });
      await Promise.allSettled([settleLoan(user.id, loan.id, 400), deleteLoan(user.id, loan.id)]);
    }

    const orphans = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "transactions" t
      LEFT JOIN "loans" l ON l."id" = t."loanId"
      WHERE t."loanId" IS NOT NULL AND l."id" IS NULL`;
    expect(Number(orphans[0].n)).toBe(0);
    // Whatever order they landed in, what's reported still matches the rows.
    expect((await getDashboardSummary(user.id, "2026-12")).cashOnHand).toBe(await cashFromLedger(user.id));
  });
});

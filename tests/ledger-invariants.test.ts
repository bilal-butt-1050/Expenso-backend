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
import { makeUser, categoryFor, earn, dateOf } from "./helpers/factories";

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

    const before = (await getDashboardSummary(user.id, "2026-12")) as any;

    const loan = await createLoan(user.id, {
      type: "LENT",
      personName: "Ahmed",
      amount: 10_000,
    });

    const lent = (await getDashboardSummary(user.id, "2026-12")) as any;
    expect(lent.cashOnHand, "cash must fall when the money leaves").toBe(before.cashOnHand - 10_000);
    expect(lent.netWorth, "net worth must not move on a transfer").toBe(before.netWorth);

    await settleLoan(user.id, loan.id);

    const after = (await getDashboardSummary(user.id, "2026-12")) as any;
    expect(after.cashOnHand).toBe(before.cashOnHand);
    expect(after.netWorth).toBe(before.netWorth);
  });

  it("LED-002: borrow then repay in full leaves net worth untouched", async () => {
    const user = await makeUser();
    await earn(user.id, 50_000, dateOf("2026-03-01"));
    const before = (await getDashboardSummary(user.id, "2026-12")) as any;

    const loan = await createLoan(user.id, {
      type: "BORROWED",
      personName: "Bank",
      amount: 8_000,
    });

    const borrowed = (await getDashboardSummary(user.id, "2026-12")) as any;
    expect(borrowed.cashOnHand).toBe(before.cashOnHand + 8_000);
    expect(borrowed.netWorth).toBe(before.netWorth);

    await settleLoan(user.id, loan.id);

    const after = (await getDashboardSummary(user.id, "2026-12")) as any;
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

    const d = (await getDashboardSummary(user.id, "2026-12")) as any;
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

    const d = (await getDashboardSummary(user.id, "2026-12")) as any;
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

  it("LED-011/012/014/015: invalid and excessive settlements are refused", async () => {
    const user = await makeUser();
    await expect(
      createLoan(user.id, { type: "LENT", personName: "E", amount: 0 })
    ).rejects.toThrow();
    await expect(
      createLoan(user.id, { type: "LENT", personName: "E", amount: -5 })
    ).rejects.toThrow();

    const loan = await createLoan(user.id, { type: "LENT", personName: "E", amount: 100 });
    await expect(settleLoan(user.id, loan.id, -1)).rejects.toThrow();
    await expect(settleLoan(user.id, loan.id, 0)).rejects.toThrow();

    // Overpaying clamps to what is actually outstanding rather than over-settling.
    await settleLoan(user.id, loan.id, 500);
    const fresh = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(fresh.settledAmount.toNumber()).toBe(100);

    await expect(settleLoan(user.id, loan.id)).rejects.toThrow(/already fully settled/i);
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

  it("LED-020/021: loan-linked rows cannot be edited or deleted directly", async () => {
    const user = await makeUser();
    await earn(user.id, 20_000, dateOf("2026-04-01"));
    const loan = await createLoan(user.id, { type: "BORROWED", personName: "G", amount: 4_000 });

    const movement = await prisma.transaction.findFirstOrThrow({ where: { loanId: loan.id } });

    await expect(deleteTransaction(user.id, movement.id)).rejects.toThrow(/belongs to a loan/i);
    await expect(
      updateTransaction(user.id, movement.id, { amount: 1 })
    ).rejects.toThrow(/belongs to a loan/i);
  });

  it("LED-022/023: principal cannot drop below what is settled, and tracks its movement", async () => {
    const user = await makeUser();
    await earn(user.id, 20_000, dateOf("2026-04-01"));
    const loan = await createLoan(user.id, { type: "LENT", personName: "H", amount: 5_000 });
    await settleLoan(user.id, loan.id, 3_000);

    await expect(updateLoan(user.id, loan.id, { amount: 1_000 })).rejects.toThrow(
      /cannot be less than/i
    );

    await updateLoan(user.id, loan.id, { amount: 8_000 });
    const opening = await prisma.transaction.findFirstOrThrow({
      where: { loanId: loan.id, kind: "LEND_OUT" },
    });
    expect(opening.amount.toNumber(), "opening movement must follow the principal").toBe(8_000);
  });

  it("LED-025/026: settling a debt never consumes a category budget", async () => {
    const user = await makeUser();
    const food = await categoryFor(user.id, "Food");
    const month = "2026-05";

    await earn(user.id, 60_000, dateOf("2026-05-01"));
    await prisma.budget.create({
      data: { userId: user.id, categoryId: food.id, amount: new Prisma.Decimal(5_000), month },
    });
    await createTransaction(user.id, {
      kind: "SPEND",
      amount: 1_200,
      date: dateOf("2026-05-03"),
      categoryId: food.id,
    });

    const loan = await createLoan(user.id, {
      type: "BORROWED",
      personName: "Big Debt",
      amount: 40_000,
    });
    await settleLoan(user.id, loan.id, undefined, dateOf("2026-05-20"));

    const d = (await getDashboardSummary(user.id, month)) as any;
    const foodBudget = d.budgetVsActual.find((b: any) => b.categoryId === food.id);

    expect(foodBudget.actual, "a 40,000 repayment must not touch the Food budget").toBe(1_200);
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

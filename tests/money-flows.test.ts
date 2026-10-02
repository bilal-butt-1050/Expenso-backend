import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AddressInfo } from "net";
import { Server } from "http";
import { prisma } from "../src/lib/prisma";
import { invalidateUserDashboard } from "../src/lib/cache";
import { createApp } from "../src/app";
import { signToken } from "../src/utils/jwt";
import { AppError } from "../src/utils/asyncHandler";
import { getDashboardSummary } from "../src/modules/dashboard/dashboard.service";
import { createLoan, deleteLoanPayment, getLoans, settleLoan, updateLoan } from "../src/modules/loans/loans.service";
import {
  adjustBalance,
  createTransaction,
  deleteTransaction,
  updateTransaction,
} from "../src/modules/transactions/transactions.service";
import { makeUser, categoryFor, earn, dateOf } from "./helpers/factories";

/**
 * MFL: money flows (Bilal, 2026-10-02). Every entry records whether cash moved, separately from
 * spending and from debts. Each test is one row of the scenario table: cash, spending and debt.
 */

const JUNE = "2026-06";
const day = (n: number) => dateOf(`2026-06-${String(n).padStart(2, "0")}`);

async function startWith(cash: number) {
  const user = await makeUser();
  await earn(user.id, cash, dateOf("2026-05-01"));
  return { user, food: await categoryFor(user.id) };
}

/** The three answers, as the dashboard gives them for June. */
async function position(userId: string) {
  const d = await getDashboardSummary(userId, JUNE);
  return {
    cash: d.closingCash,
    spent: d.totalExpenses,
    lent: d.netDebtSnapshot.totalLent,
    borrowed: d.netDebtSnapshot.totalBorrowed,
    netWorth: d.netWorth,
  };
}

const refused = (promise: Promise<unknown>) => promise.then(() => null, (e) => e as AppError);

describe("MFL: someone else paid", () => {
  it("MFL-001: an expense someone paid is spending and a debt, with no cash; repaying it moves the cash", async () => {
    const { user, food } = await startWith(10_000);
    const lunch = await createTransaction(user.id, {
      kind: "SPEND", amount: 500, date: day(5), categoryId: food.id, description: "KFC", paidBy: { personName: " Ali " },
    });
    expect(lunch.movesCash).toBe(false);
    expect(lunch.paidBy).toEqual({ personName: "Ali" });
    expect(await position(user.id)).toEqual({ cash: 10_000, spent: 500, lent: 0, borrowed: 500, netWorth: 9_500 });

    // The budget counts it too.
    await prisma.budget.create({ data: { userId: user.id, categoryId: food.id, month: JUNE, amount: 1_000 } });
    invalidateUserDashboard(user.id);
    expect((await getDashboardSummary(user.id, JUNE)).budgetVsActual.map((b) => b.actual)).toEqual([500]);

    const [loan] = await getLoans(user.id);
    expect(loan).toMatchObject({ type: "BORROWED", personName: "Ali", amount: 500, cashMoved: false });
    expect(loan.expense).toMatchObject({ id: lunch.id, description: "KFC", amount: 500 });

    await settleLoan(user.id, loan.id, undefined, day(10));
    expect(await position(user.id)).toEqual({ cash: 9_500, spent: 500, lent: 0, borrowed: 0, netWorth: 9_500 });
  });

  it("MFL-002: editing it moves the loan with it; it can't drop below what's been repaid", async () => {
    const { user, food } = await startWith(10_000);
    const lunch = await createTransaction(user.id, {
      kind: "SPEND", amount: 500, date: day(5), categoryId: food.id, paidBy: { personName: "Ali" },
    });
    await updateTransaction(user.id, lunch.id, { amount: 700, date: day(6), paidBy: { personName: "Ali Khan" } });
    const [loan] = await getLoans(user.id);
    expect(loan).toMatchObject({ personName: "Ali Khan", amount: 700, date: day(6).toISOString() });
    expect(await position(user.id)).toMatchObject({ cash: 10_000, spent: 700, borrowed: 700 });

    await settleLoan(user.id, loan.id, 600, day(8));
    const tooLow = await refused(updateTransaction(user.id, lunch.id, { amount: 500 }));
    expect(tooLow?.statusCode).toBe(400);
    // An older app sends no sharing fields: the sharing stays.
    await updateTransaction(user.id, lunch.id, { description: "Dinner" });
    expect((await getLoans(user.id))[0]).toMatchObject({ amount: 700, personName: "Ali Khan" });
  });

  it("MFL-003: switching to paid-by-me drops the loan, but never once something has been repaid", async () => {
    const { user, food } = await startWith(10_000);
    const a = await createTransaction(user.id, { kind: "SPEND", amount: 500, date: day(5), categoryId: food.id, paidBy: { personName: "Ali" } });
    await updateTransaction(user.id, a.id, { paidBy: null, split: null });
    expect(await prisma.loan.count({ where: { userId: user.id } })).toBe(0);
    expect(await position(user.id)).toMatchObject({ cash: 9_500, spent: 500, borrowed: 0 });

    const b = await createTransaction(user.id, { kind: "SPEND", amount: 300, date: day(5), categoryId: food.id, paidBy: { personName: "Sara" } });
    const [loan] = (await getLoans(user.id)).filter((l) => l.personName === "Sara");
    await settleLoan(user.id, loan.id, 100, day(6));
    const blocked = await refused(updateTransaction(user.id, b.id, { paidBy: null, split: null }));
    expect(blocked?.statusCode).toBe(409);
    expect(blocked?.message).toMatch(/Remove those payments first/);
  });

  it("MFL-004: deleting the expense deletes its loan and repayments; deleting the loan deletes the expense", async () => {
    const { user, food } = await startWith(10_000);
    const a = await createTransaction(user.id, { kind: "SPEND", amount: 500, date: day(5), categoryId: food.id, paidBy: { personName: "Ali" } });
    const [loan] = await getLoans(user.id);
    await settleLoan(user.id, loan.id, 200, day(6));
    await deleteTransaction(user.id, a.id);
    expect(await prisma.transaction.count({ where: { userId: user.id, kind: { not: "EARN" } } })).toBe(0);
    expect(await prisma.loan.count({ where: { userId: user.id } })).toBe(0);
    expect(await position(user.id)).toMatchObject({ cash: 10_000, spent: 0, borrowed: 0 });

    await createTransaction(user.id, { kind: "SPEND", amount: 400, date: day(5), categoryId: food.id, paidBy: { personName: "Sara" } });
    const [second] = await getLoans(user.id);
    await prisma.loan.delete({ where: { id: second.id } });
    expect(await prisma.transaction.count({ where: { userId: user.id, kind: "SPEND" } })).toBe(0);
  });

  it("MFL-005: the loan form can't change an expense's loan amount, date or cash", async () => {
    const { user, food } = await startWith(10_000);
    await createTransaction(user.id, { kind: "SPEND", amount: 500, date: day(5), categoryId: food.id, paidBy: { personName: "Ali" } });
    const [loan] = await getLoans(user.id);
    expect((await refused(updateLoan(user.id, loan.id, { amount: 900 })))?.statusCode).toBe(409);
    expect((await refused(updateLoan(user.id, loan.id, { recordCashflow: true })))?.statusCode).toBe(409);
    // A rename or a due date is fine.
    await updateLoan(user.id, loan.id, { personName: "Ali K" });
    expect((await getLoans(user.id))[0].personName).toBe("Ali K");
  });
});

describe("MFL: split", () => {
  it("MFL-010: I paid 1,000, my share 600: cash −1,000, spending 600, owed to me 400; their payment brings 400 back", async () => {
    const { user, food } = await startWith(10_000);
    const dinner = await createTransaction(user.id, {
      kind: "SPEND", amount: 600, date: day(5), categoryId: food.id, split: { personName: "Ali", share: 400 },
    });
    expect(dinner.split).toEqual({ personName: "Ali", share: 400 });
    expect(await position(user.id)).toEqual({ cash: 9_000, spent: 600, lent: 400, borrowed: 0, netWorth: 9_400 });

    const [loan] = await getLoans(user.id);
    expect(loan).toMatchObject({ type: "LENT", amount: 400, cashMoved: true });
    await settleLoan(user.id, loan.id, undefined, day(9));
    expect(await position(user.id)).toEqual({ cash: 9_400, spent: 600, lent: 0, borrowed: 0, netWorth: 9_400 });
  });

  it("MFL-011: changing the share or the total moves the loan; split → paid by them swaps the loan", async () => {
    const { user, food } = await startWith(10_000);
    const dinner = await createTransaction(user.id, {
      kind: "SPEND", amount: 600, date: day(5), categoryId: food.id, split: { personName: "Ali", share: 400 },
    });
    await updateTransaction(user.id, dinner.id, { amount: 500, split: { personName: "Ali", share: 500 } });
    expect(await position(user.id)).toMatchObject({ cash: 9_000, spent: 500, lent: 500 });

    await updateTransaction(user.id, dinner.id, { amount: 500, split: null, paidBy: { personName: "Ali" } });
    expect(await position(user.id)).toMatchObject({ cash: 10_000, spent: 500, lent: 0, borrowed: 500 });
    const loans = await getLoans(user.id);
    expect(loans.map((l) => l.type)).toEqual(["BORROWED"]);
  });

  it("MFL-012: both at once, or on income, is refused", async () => {
    const { user, food } = await startWith(10_000);
    const both = await refused(createTransaction(user.id, {
      kind: "SPEND", amount: 600, date: day(5), categoryId: food.id, split: { personName: "Ali", share: 1 }, paidBy: { personName: "Ali" },
    }));
    expect(both?.statusCode).toBe(400);
    const income = await refused(createTransaction(user.id, {
      kind: "EARN", amount: 600, date: day(5), source: "Salary", paidBy: { personName: "Ali" },
    }));
    expect(income?.statusCode).toBe(400);
    expect(await prisma.loan.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe("MFL: loans and payments", () => {
  it("MFL-020: the cash choice is stored and can be changed after saving", async () => {
    const { user } = await startWith(10_000);
    const old = await createLoan(user.id, { type: "LENT", personName: "Ali", amount: 2_000, recordCashflow: false, date: day(3) });
    expect(old.cashMoved).toBe(false);
    expect(await position(user.id)).toMatchObject({ cash: 10_000, lent: 2_000 });

    // It was a new loan after all: the money did leave.
    const fixed = await updateLoan(user.id, old.id, { recordCashflow: true });
    expect(fixed.cashMoved).toBe(true);
    expect(await position(user.id)).toMatchObject({ cash: 8_000, lent: 2_000, netWorth: 10_000 });
  });

  it("MFL-021: a payment without money (forgiven) closes the debt and leaves cash alone", async () => {
    const { user } = await startWith(10_000);
    const loan = await createLoan(user.id, { type: "LENT", personName: "Ali", amount: 1_000, date: day(3) });
    await settleLoan(user.id, loan.id, 300, day(4));
    const forgiven = await settleLoan(user.id, loan.id, undefined, day(5), false);
    expect(forgiven).toMatchObject({ status: "SETTLED", remainingAmount: 0 });
    expect(forgiven.payments.map((p) => [p.amount, p.movesCash])).toEqual([[300, true], [700, false]]);
    // 1,000 left, 300 came back, 700 was let go: cash and net worth both 700 down, not income or spending.
    expect(await position(user.id)).toEqual({ cash: 9_300, spent: 0, lent: 0, borrowed: 0, netWorth: 9_300 });
  });

  it("MFL-022: a payment can be undone; the loan reopens and the cash goes back", async () => {
    const { user } = await startWith(10_000);
    const loan = await createLoan(user.id, { type: "BORROWED", personName: "Sara", amount: 1_000, date: day(3) });
    const paid = await settleLoan(user.id, loan.id, undefined, day(4));
    expect(paid.status).toBe("SETTLED");
    expect(await position(user.id)).toMatchObject({ cash: 10_000, borrowed: 0 });

    const undone = await deleteLoanPayment(user.id, loan.id, paid.payments[0].id);
    expect(undone).toMatchObject({ status: "PENDING", settledAmount: 0, payments: [] });
    expect(await position(user.id)).toMatchObject({ cash: 11_000, borrowed: 1_000 });

    // Someone else's payment id, or a movement that isn't a payment, is a 404.
    const opening = await prisma.transaction.findFirstOrThrow({ where: { loanId: loan.id, kind: "BORROW_IN" } });
    expect((await refused(deleteLoanPayment(user.id, loan.id, opening.id)))?.statusCode).toBe(404);
  });

  it("MFL-023: a payment is dated, and can't be before the loan or in the future", async () => {
    const { user } = await startWith(10_000);
    const loan = await createLoan(user.id, { type: "LENT", personName: "Ali", amount: 1_000, date: day(10) });
    expect((await refused(settleLoan(user.id, loan.id, 100, day(9))))?.statusCode).toBe(400);
    expect((await refused(settleLoan(user.id, loan.id, 100, new Date(Date.now() + 3 * 86_400_000))))?.statusCode).toBe(400);
    const ok = await settleLoan(user.id, loan.id, 100, day(20));
    expect(ok.payments[0].date).toBe(day(20).toISOString());
  });
});

describe("MFL: balance correction", () => {
  it("MFL-030: correcting the balance records the difference; it isn't income or spending", async () => {
    const { user } = await startWith(10_000);
    const before = await getDashboardSummary(user.id, "2026-05");
    const row = await adjustBalance(user.id, 9_250.5);
    expect(row).toMatchObject({ kind: "ADJUST", amount: -749.5, movesCash: true, description: "Balance correction" });

    const now = await getDashboardSummary(user.id, row.month);
    expect(now.cashAvailable.amount).toBe(9_250.5);
    expect([now.monthlyIncome, now.totalExpenses]).toEqual([0, 0]);
    expect(now.cashAvailable.breakdown.adjusted).toBe(-749.5);
    expect(before.monthlyIncome).toBe(10_000);

    // Already right: nothing to record. It can't be edited, only deleted and redone.
    expect((await refused(adjustBalance(user.id, 9_250.5)))?.statusCode).toBe(400);
    expect((await refused(updateTransaction(user.id, row.id, { description: "x" })))?.statusCode).toBe(409);
    await deleteTransaction(user.id, row.id);
    expect((await getDashboardSummary(user.id, row.month)).cashAvailable.amount).toBe(10_000);
  });
});

describe("MFL: over HTTP", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  async function call(token: string, method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  it("MFL-040: the routes take the new fields, and validate them", async () => {
    const { user, food } = await startWith(10_000);
    const token = signToken({ userId: user.id, tv: 0 });

    const split = await call(token, "POST", "/transactions", {
      kind: "SPEND", amount: 600, date: day(5).toISOString(), categoryId: food.id, split: { personName: "Ali", share: 400 },
    });
    expect(split.status).toBe(201);
    expect(split.json.split).toEqual({ personName: "Ali", share: 400 });

    const noName = await call(token, "POST", "/transactions", {
      kind: "SPEND", amount: 600, date: day(5).toISOString(), categoryId: food.id, paidBy: { personName: "  " },
    });
    expect(noName.status).toBe(400);

    const loans = await call(token, "GET", "/loans");
    const loan = loans.json[0];
    const over = await call(token, "PATCH", `/loans/${loan.id}/settle`, { paymentAmount: 401 });
    expect(over.status).toBe(400);
    const forgive = await call(token, "PATCH", `/loans/${loan.id}/settle`, { movesCash: false, date: day(6).toISOString() });
    expect(forgive.json).toMatchObject({ status: "SETTLED" });
    const undo = await call(token, "DELETE", `/loans/${loan.id}/payments/${forgive.json.payments[0].id}`);
    expect(undo.json).toMatchObject({ status: "PENDING" });

    const adjust = await call(token, "POST", "/transactions/adjust-balance", { actualCash: -5 });
    expect(adjust.status).toBe(400);
    const list = await call(token, "GET", `/transactions?month=${JUNE}&kinds=SPEND,LEND_OUT`);
    expect(list.json.items.map((t: { kind: string }) => t.kind).sort()).toEqual(["LEND_OUT", "SPEND"]);
  });
});

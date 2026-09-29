import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { AddressInfo } from "net";
import { Server } from "http";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { createApp } from "../src/app";
import { signToken } from "../src/utils/jwt";
import { MAX_AMOUNT } from "../src/utils/validation";
import { getBalance, setBalance } from "../src/modules/balance/balance.service";
import { getDashboardSummary } from "../src/modules/dashboard/dashboard.service";
import { createLoan, settleLoan } from "../src/modules/loans/loans.service";
import { deleteTransaction, updateTransaction } from "../src/modules/transactions/transactions.service";
import { makeUser, makeTransaction, categoryFor, earn, spend, dateOf, currentMonth } from "./helpers/factories";

/**
 * "You have" and "Can still spend" (TEST_SPEC D5: BAL-001..012, SPN-001..006; D-55).
 */

/** Noon in Karachi on the day `offsetDays` from today (Karachi), as the app's date picker saves it. */
function karachiNoon(offsetDays: number): Date {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays, 7, 0, 0)); // 12:00 PKT = 07:00 UTC
}

const corrections = (userId: string) =>
  prisma.transaction.findMany({ where: { userId, kind: { in: ["ADJUST_IN", "ADJUST_OUT"] } }, orderBy: { createdAt: "asc" } });

afterEach(() => {
  vi.useRealTimers();
});

describe("BAL: the balance right now", () => {
  it("BAL-001: counts everything dated up to the end of today, including today at noon, and nothing later", async () => {
    // 09:00 in Karachi, so today's noon entry is still in the future: the case "up to now" gets wrong.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T04:00:00.000Z"));
    const user = await makeUser();
    await earn(user.id, 1_000, new Date("2026-09-13T07:00:00.000Z"));
    await spend(user.id, 200, new Date("2026-09-15T07:00:00.000Z")); // today 12:00 PKT: counts already
    await earn(user.id, 5_000, new Date("2026-09-16T07:00:00.000Z")); // tomorrow 12:00 PKT: not yet
    await earn(user.id, 70, new Date("2026-09-15T18:59:00.000Z")); // 23:59 PKT today: counts

    expect((await getBalance(user.id)).cash).toBe(870);
  });

  it("BAL-002: the breakdown lines add up to the balance, each carrying its sign", async () => {
    const user = await makeUser();
    await earn(user.id, 1_000, karachiNoon(-3));
    await spend(user.id, 200, karachiNoon(-2));
    const lent = await createLoan(user.id, { type: "LENT", personName: "A", amount: 300 });
    await settleLoan(user.id, lent.id, 100);
    const owed = await createLoan(user.id, { type: "BORROWED", personName: "B", amount: 50 });
    await settleLoan(user.id, owed.id, 20);
    await setBalance(user.id, 700);

    const { cash, breakdown } = await getBalance(user.id);

    expect(breakdown).toEqual({
      income: 1_000,
      spending: -200,
      lentOut: -300,
      collected: 100,
      borrowed: 50,
      repaid: -20,
      corrections: 70, // 630 before the update
    });
    const sum = Object.values(breakdown).reduce((t, v) => t.add(v), new Prisma.Decimal(0));
    expect(sum.toNumber()).toBe(cash);
    expect(cash).toBe(700);
  });

  it("BAL-003: an update lands exactly on the target: ADJUST_IN to rise, ADJUST_OUT to fall, nothing if equal", async () => {
    const user = await makeUser();
    await earn(user.id, 800, karachiNoon(-1));

    expect((await setBalance(user.id, 1_000)).cash).toBe(1_000);
    expect((await setBalance(user.id, 900)).cash).toBe(900);
    expect((await setBalance(user.id, 900)).cash).toBe(900);

    const rows = await corrections(user.id);
    expect(rows.map((r) => [r.kind, r.amount.toNumber(), r.description])).toEqual([
      ["ADJUST_IN", 200, "Balance correction"],
      ["ADJUST_OUT", 100, "Balance correction"],
    ]);
  });

  it("BAL-004: a correction moves cash and net worth, and nothing else", async () => {
    const user = await makeUser();
    const month = currentMonth();
    const food = await categoryFor(user.id, "Food");
    await prisma.budget.create({ data: { userId: user.id, categoryId: food.id, amount: new Prisma.Decimal(5_000), month: month.key } });
    await earn(user.id, 10_000, month.day(1));
    await spend(user.id, 1_500, month.day(1), food.id);
    const before = await getDashboardSummary(user.id, month.key);

    await setBalance(user.id, (await getBalance(user.id)).cash + 2_500);

    const after = await getDashboardSummary(user.id, month.key);
    expect(after.cashOnHand).toBe(before.cashOnHand + 2_500);
    expect(after.netWorth).toBe(before.netWorth + 2_500);
    expect(after.monthlyIncome).toBe(before.monthlyIncome);
    expect(after.totalExpenses).toBe(before.totalExpenses);
    expect(after.categoryBreakdown).toEqual(before.categoryBreakdown);
    expect(after.budgetVsActual).toEqual(before.budgetVsActual);
    expect(after.spendable).toEqual(before.spendable);
  });

  it("BAL-005: two concurrent updates end on one of the targets, never on a sum of both differences", async () => {
    for (let i = 0; i < 5; i++) {
      const user = await makeUser();
      await earn(user.id, 100, karachiNoon(-1));

      const results = await Promise.allSettled([setBalance(user.id, 1_000), setBalance(user.id, 5_000)]);

      for (const r of results) {
        if (r.status === "rejected") expect((r.reason as { statusCode?: number }).statusCode).toBe(409);
      }
      expect([1_000, 5_000]).toContain((await getBalance(user.id)).cash);
    }
  });

  it("BAL-008: balanceSetAt is null until the first update, and set by it even when nothing needed correcting", async () => {
    const user = await makeUser();
    expect((await getBalance(user.id)).balanceSetAt).toBeNull();

    const after = await setBalance(user.id, 0); // a new account already holds 0: no correction needed

    expect(after.balanceSetAt).not.toBeNull();
    expect(await corrections(user.id)).toEqual([]);
  });

  it("BAL-009: a correction can't be edited (409), and stays as it was", async () => {
    const user = await makeUser();
    await setBalance(user.id, 500);
    const [row] = await corrections(user.id);

    const err = await updateTransaction(user.id, row.id, { amount: 1 }).catch((e) => e);

    expect(err.statusCode).toBe(409);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } })).amount.toNumber()).toBe(500);
  });

  it("BAL-010: deleting a correction puts the balance back", async () => {
    const user = await makeUser();
    await earn(user.id, 300, karachiNoon(-1));
    await setBalance(user.id, 1_000);
    const [row] = await corrections(user.id);

    await deleteTransaction(user.id, row.id);

    expect((await getBalance(user.id)).cash).toBe(300);
  });

  it("BAL-011: a correction at 00:30 on the 1st (Karachi) is filed in the new month", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T19:30:00.000Z")); // 00:30 PKT, 1 Nov
    const user = await makeUser();

    await setBalance(user.id, 1_000);

    const [row] = await corrections(user.id);
    expect(row.month).toBe("2026-11");
    expect((await getBalance(user.id)).cash).toBe(1_000);
  });

  it("BAL-012: an update refreshes the cached dashboard", async () => {
    const user = await makeUser();
    const month = currentMonth();
    await earn(user.id, 1_000, month.day(1));
    const cached = await getDashboardSummary(user.id, month.key);

    await setBalance(user.id, 4_000);

    expect((await getDashboardSummary(user.id, month.key)).cashOnHand).toBe(cached.cashOnHand + 3_000);
  });
});

describe("BAL over HTTP: validation and ownership", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  const post = (token: string, raw: string) =>
    fetch(`${base}/balance`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: raw,
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as { cash?: number } }));

  it("BAL-006: invalid targets are refused and write nothing; zero and negative targets are fine", async () => {
    const user = await makeUser();
    const token = signToken({ userId: user.id, tv: 0 });

    for (const bad of ["NaN", "1e999", '"abc"', "null", String(MAX_AMOUNT + 1), String(-MAX_AMOUNT - 1)]) {
      expect((await post(token, `{"amount":${bad}}`)).status, bad).toBe(400);
    }
    expect(await corrections(user.id)).toEqual([]);

    expect((await post(token, '{"amount":0}')).body.cash).toBe(0);
    expect((await post(token, '{"amount":-500}')).body.cash).toBe(-500);

    // A target within bounds whose difference isn't: cash is -500, so reaching the ceiling is too far.
    expect((await post(token, `{"amount":${MAX_AMOUNT}}`)).status).toBe(400);
    expect((await getBalance(user.id)).cash).toBe(-500);
  });

  it("BAL-007: one user's update and read never touch another's balance", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await earn(b.id, 777.77, karachiNoon(-1));

    await post(signToken({ userId: a.id, tv: 0 }), '{"amount":1234}');

    expect((await getBalance(b.id)).cash).toBe(777.77);
    expect(await corrections(b.id)).toEqual([]);
    const aRead = await fetch(`${base}/balance`, { headers: { Authorization: `Bearer ${signToken({ userId: a.id, tv: 0 })}` } });
    const text = await aRead.text();
    expect(text).not.toContain("777.77");
    expect(JSON.parse(text).cash).toBe(1234);
  });
});

describe("SPN: can still spend", () => {
  const month = "2026-05";

  async function budget(userId: string, name: string, amount: number, m = month) {
    const category = await categoryFor(userId, name);
    await prisma.budget.create({ data: { userId, categoryId: category.id, amount: new Prisma.Decimal(amount), month: m } });
    return category;
  }

  it("SPN-001: with budgets, the limit is their total and all spending counts, budgeted or not", async () => {
    const user = await makeUser();
    const food = await budget(user.id, "Food", 40_000);
    await budget(user.id, "Bills", 20_000);
    const shopping = await categoryFor(user.id, "Shopping"); // no budget
    await spend(user.id, 10_000, dateOf("2026-05-10"), food.id);
    await spend(user.id, 5_000, dateOf("2026-05-11"), shopping.id);

    const { spendable } = await getDashboardSummary(user.id, month);

    expect(spendable).toEqual({ basis: "budget", limit: 60_000, spent: 15_000, left: 45_000 });
  });

  it("SPN-002: without budgets, the limit is the month's income", async () => {
    const user = await makeUser();
    await earn(user.id, 100_000, dateOf("2026-05-01"));
    await spend(user.id, 30_000, dateOf("2026-05-12"));

    expect((await getDashboardSummary(user.id, month)).spendable).toEqual({
      basis: "income",
      limit: 100_000,
      spent: 30_000,
      left: 70_000,
    });
  });

  it("SPN-003: overspending reads negative, never clamped", async () => {
    const user = await makeUser();
    await budget(user.id, "Food", 1_000);
    await spend(user.id, 1_500.5, dateOf("2026-05-12"));

    expect((await getDashboardSummary(user.id, month)).spendable.left).toBe(-500.5);
  });

  it("SPN-004: loan movements and corrections change neither what's spent nor the limit", async () => {
    const user = await makeUser();
    const now = currentMonth();
    await budget(user.id, "Food", 8_000, now.key);
    await earn(user.id, 20_000, now.day(1));
    await spend(user.id, 2_000, now.day(1));
    const before = (await getDashboardSummary(user.id, now.key)).spendable;

    const lent = await createLoan(user.id, { type: "LENT", personName: "X", amount: 5_000 });
    await settleLoan(user.id, lent.id, 1_000);
    const owed = await createLoan(user.id, { type: "BORROWED", personName: "Y", amount: 3_000 });
    await settleLoan(user.id, owed.id, 500);
    await setBalance(user.id, 99_999);

    expect((await getDashboardSummary(user.id, now.key)).spendable).toEqual(before);
  });

  it("SPN-005: no budgets and no income: income basis, limit 0, everything spent is over", async () => {
    const user = await makeUser();
    await spend(user.id, 300, dateOf("2026-05-12"));

    expect((await getDashboardSummary(user.id, month)).spendable).toEqual({ basis: "income", limit: 0, spent: 300, left: -300 });
  });

  it("SPN-006: budgets totalling zero count as no budget, and a past month's figure doesn't drift", async () => {
    const user = await makeUser();
    await budget(user.id, "Food", 0);
    await earn(user.id, 50_000, dateOf("2026-05-01"));
    await spend(user.id, 10_000, dateOf("2026-05-02"));
    const may = (await getDashboardSummary(user.id, month)).spendable;
    expect(may).toEqual({ basis: "income", limit: 50_000, spent: 10_000, left: 40_000 });

    await makeTransaction({ userId: user.id, kind: "SPEND", amount: 999, date: dateOf("2026-06-03"), categoryId: (await categoryFor(user.id)).id });
    await budget(user.id, "Bills", 7_000, "2026-06");

    expect((await getDashboardSummary(user.id, month)).spendable).toEqual(may);
  });
});

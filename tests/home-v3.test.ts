import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { AddressInfo } from "net";
import { Server } from "http";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { createApp } from "../src/app";
import { signToken } from "../src/utils/jwt";
import { MAX_AMOUNT } from "../src/utils/validation";
import { getDashboardSummary } from "../src/modules/dashboard/dashboard.service";
import { createLoan, settleLoan, updateLoan, getLoansForMonth } from "../src/modules/loans/loans.service";
import { setOpeningBalanceFromToday } from "../src/modules/opening-balance/opening-balance.service";
import { makeUser, makeTransaction, makeLoan, categoryFor, earn, spend, dateOf } from "./helpers/factories";

/**
 * Home v3: opening cash, Cash available, the spending comparison and loan timelines (TEST_SPEC D6,
 * R-34..R-41, D-62, D-63). The clock is pinned where "today" matters, in Karachi time.
 */

/** A fixed "now": 09:00 PKT on 15 Sep 2026, before noon, so "up to now" and "up to today" differ. */
const SEP_15_0900_PKT = new Date("2026-09-15T04:00:00.000Z");
const pkt = (iso: string) => new Date(`${iso}+05:00`); // local Karachi wall-clock time

function pinClock(at: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
}

afterEach(() => {
  vi.useRealTimers();
});

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
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const tokenFor = (userId: string) => signToken({ userId, tv: 0 });

// ------------------------------------------------------------------------------------ OPN
describe("OPN: opening cash", () => {
  it("OPN-001: it lifts every month's cash and net worth by the same amount, and nothing else", async () => {
    const plain = await makeUser();
    const withOpening = await makeUser();
    for (const user of [plain, withOpening]) {
      const food = await categoryFor(user.id);
      await prisma.budget.create({ data: { userId: user.id, categoryId: food.id, amount: new Prisma.Decimal(4_000), month: "2026-08" } });
      await earn(user.id, 20_000, dateOf("2026-08-01"));
      await spend(user.id, 3_000, dateOf("2026-08-10"), food.id);
      await makeLoan({ userId: user.id, type: "LENT", amount: 2_000, createdAt: dateOf("2026-08-12") });
    }
    await prisma.user.update({ where: { id: withOpening.id }, data: { openingBalance: new Prisma.Decimal(10_000) } });

    for (const month of ["2026-07", "2026-08", "2026-09"]) {
      const a = await getDashboardSummary(plain.id, month);
      const b = await getDashboardSummary(withOpening.id, month);
      for (const field of ["openingCash", "closingCash", "cashOnHand", "netWorth", "openingNetWorth", "closingNetWorth"] as const) {
        expect(b[field], `${month} ${field}`).toBe(a[field] + 10_000);
      }
      expect(b.monthlyIncome).toBe(a.monthlyIncome);
      expect(b.totalExpenses).toBe(a.totalExpenses);
      expect(b.savingsThisMonth).toBe(a.savingsThisMonth);
      // Figures only: the two users' categories have different ids.
      const figures = (d: typeof a) => d.budgetVsActual.map((x) => [x.name, x.budget, x.actual, x.status]);
      expect(figures(b)).toEqual(figures(a));
    }
  });

  it("OPN-002: netWorth = opening + ΣEARN − ΣSPEND, and month-to-month continuity holds", async () => {
    const user = await makeUser();
    await prisma.user.update({ where: { id: user.id }, data: { openingBalance: new Prisma.Decimal(7_500) } });
    await earn(user.id, 30_000, dateOf("2026-06-01"));
    await spend(user.id, 4_000, dateOf("2026-06-15"));
    await makeLoan({ userId: user.id, type: "BORROWED", amount: 5_000, createdAt: dateOf("2026-07-03") });
    await spend(user.id, 1_000, dateOf("2026-07-20"));

    let previousClosing: number | null = null;
    for (const month of ["2026-05", "2026-06", "2026-07", "2026-08"]) {
      const d = await getDashboardSummary(user.id, month);
      if (previousClosing !== null) expect(d.openingCash, month).toBe(previousClosing);
      expect(d.openingCash + d.netCashThisMonth, month).toBe(d.closingCash);
      expect(d.openingNetWorth + d.savingsThisMonth, month).toBe(d.closingNetWorth);
      previousClosing = d.closingCash;
    }
    expect((await getDashboardSummary(user.id, "2026-08")).netWorth).toBe(7_500 + 30_000 - 4_000 - 1_000);
    expect((await getDashboardSummary(user.id, "2026-05")).openingCash).toBe(7_500); // FIN-012 restated
  });

  it("OPN-003: entering today's money makes today's Cash available exactly that; re-entering recomputes", async () => {
    pinClock(SEP_15_0900_PKT);
    const user = await makeUser();
    await earn(user.id, 20_000, pkt("2026-09-01T12:00:00"));
    await spend(user.id, 1_500, pkt("2026-09-15T12:00:00")); // today, after "now": still today's

    const put = await call(tokenFor(user.id), "PUT", "/opening-balance", { cashToday: 45_000 });
    expect(put.status).toBe(200);
    expect(put.json.openingBalance).toBe(45_000 - 18_500);
    expect((await getDashboardSummary(user.id, "2026-09")).cashAvailable.amount).toBe(45_000);

    await call(tokenFor(user.id), "PUT", "/opening-balance", { cashToday: 30_000 });
    expect((await getDashboardSummary(user.id, "2026-09")).cashAvailable.amount).toBe(30_000);
  });

  it("OPN-003: two at once end on one of the targets", async () => {
    const user = await makeUser();
    await earn(user.id, 1_000, dateOf("2026-09-01"));

    const results = await Promise.allSettled([
      setOpeningBalanceFromToday(user.id, 5_000),
      setOpeningBalanceFromToday(user.id, 9_000),
    ]);
    for (const r of results) if (r.status === "rejected") expect((r.reason as { statusCode?: number }).statusCode).toBe(409);
    const month = (await getDashboardSummary(user.id, "2026-09")).cashAvailable;
    expect([5_000, 9_000]).toContain(month.openingBalance! + 1_000);
  });

  it("OPN-004: bad amounts are refused and write nothing; zero and negative are fine", async () => {
    const user = await makeUser();
    const token = tokenFor(user.id);
    for (const bad of ["NaN", "1e999", '"abc"', "null", String(MAX_AMOUNT + 1)]) {
      expect((await call(token, "PUT", "/opening-balance", `{"cashToday":${bad}}`)).status, bad).toBe(400);
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).openingBalance).toBeNull();

    expect((await call(token, "PUT", "/opening-balance", { cashToday: 0 })).status).toBe(200);
    expect((await call(token, "PUT", "/opening-balance", { cashToday: -2_500 })).json.openingBalance).toBe(-2_500);

    // Within bounds, but the resulting opening amount isn't: the ledger is -1,000.
    await spend(user.id, 1_000, dateOf("2026-09-01"));
    expect((await call(token, "PUT", "/opening-balance", { cashToday: MAX_AMOUNT })).status).toBe(400);
  });

  it("OPN-005: null until set, as null; after setting, every cached month reflects it", async () => {
    const user = await makeUser();
    const token = tokenFor(user.id);
    expect((await call(token, "GET", "/auth/me")).json.openingBalance).toBeNull();
    const aug = await getDashboardSummary(user.id, "2026-08");
    expect(aug.cashAvailable.openingBalance).toBeNull();

    await call(token, "PUT", "/opening-balance", { cashToday: 12_000 });

    expect((await call(token, "GET", "/auth/me")).json.openingBalance).toBe(12_000);
    const augAfter = await getDashboardSummary(user.id, "2026-08");
    expect(augAfter.closingCash).toBe(aug.closingCash + 12_000);
    expect(augAfter.cashAvailable.openingBalance).toBe(12_000);
  });
});

// ------------------------------------------------------------------------------------ CAV
describe("CAV: Cash available", () => {
  it("CAV-001: the current month counts everything up to the end of today, not later", async () => {
    pinClock(SEP_15_0900_PKT);
    const user = await makeUser();
    await earn(user.id, 1_000, pkt("2026-09-01T12:00:00"));
    await spend(user.id, 200, pkt("2026-09-15T12:00:00")); // today at noon: counts though it's 09:00
    await earn(user.id, 5_000, pkt("2026-09-16T12:00:00")); // tomorrow: not yet

    const d = await getDashboardSummary(user.id, "2026-09");

    expect(d.cashAvailable.period).toBe("current");
    expect(d.cashAvailable.amount).toBe(800);
    expect(d.closingCash).toBe(5_800);
  });

  it("CAV-002: past and future months show their month-end cash", async () => {
    pinClock(SEP_15_0900_PKT);
    const user = await makeUser();
    await earn(user.id, 4_000, pkt("2026-08-10T12:00:00"));
    await earn(user.id, 900, pkt("2026-10-05T12:00:00"));

    const aug = await getDashboardSummary(user.id, "2026-08");
    const oct = await getDashboardSummary(user.id, "2026-10");
    expect([aug.cashAvailable.period, aug.cashAvailable.amount]).toEqual(["past", aug.closingCash]);
    expect([oct.cashAvailable.period, oct.cashAvailable.amount]).toEqual(["future", 4_900]);
  });

  it("CAV-003/004: the month's story adds up, and lending moves cash but not income or spending", async () => {
    pinClock(SEP_15_0900_PKT);
    const user = await makeUser();
    await prisma.user.update({ where: { id: user.id }, data: { openingBalance: new Prisma.Decimal(10_000) } });
    await earn(user.id, 30_000, pkt("2026-08-05T12:00:00"));
    await earn(user.id, 55_000, pkt("2026-09-01T12:00:00"));
    await spend(user.id, 18_400, pkt("2026-09-03T12:00:00"));
    const before = await getDashboardSummary(user.id, "2026-09");

    const lent = await createLoan(user.id, { type: "LENT", personName: "Ali", amount: 5_000, date: pkt("2026-09-04T12:00:00") });
    await settleLoan(user.id, lent.id, 1_000, pkt("2026-09-10T12:00:00"));
    const owed = await createLoan(user.id, { type: "BORROWED", personName: "Bank", amount: 2_000, date: pkt("2026-09-05T12:00:00") });
    await settleLoan(user.id, owed.id, 500, pkt("2026-09-12T12:00:00"));

    const d = await getDashboardSummary(user.id, "2026-09");
    const b = d.cashAvailable.breakdown;
    expect(b).toEqual({ startOfMonth: 40_000, income: 55_000, expenses: 18_400, lent: 5_000, borrowed: 2_000, collected: 1_000, repaid: 500 });
    expect(b.startOfMonth).toBe(d.openingCash);
    expect(b.startOfMonth + b.income + b.borrowed + b.collected - b.expenses - b.lent - b.repaid).toBe(d.cashAvailable.amount);
    expect(d.cashAvailable.amount).toBe(before.cashAvailable.amount - 5_000 + 1_000 + 2_000 - 500);
    expect([d.monthlyIncome, d.totalExpenses, d.savingsThisMonth]).toEqual([before.monthlyIncome, before.totalExpenses, before.savingsThisMonth]);
  });

  it("CAV-005: at 00:30 on the 1st (Karachi), the current month is already the new one", async () => {
    pinClock(new Date("2026-10-31T19:30:00.000Z")); // 00:30 PKT, 1 Nov
    const user = await makeUser();
    await earn(user.id, 700, new Date("2026-10-31T19:30:00.000Z"));

    const nov = await getDashboardSummary(user.id, "2026-11");
    expect(nov.cashAvailable.period).toBe("current");
    expect(nov.cashAvailable.amount).toBe(700);
    expect((await getDashboardSummary(user.id, "2026-10")).cashAvailable.period).toBe("past");
  });

  it("CAV-006: the cached current month isn't served past midnight", async () => {
    pinClock(new Date("2026-09-15T18:59:00.000Z")); // 23:59 PKT, 15 Sep
    const user = await makeUser();
    await earn(user.id, 1_000, pkt("2026-09-01T12:00:00"));
    expect((await getDashboardSummary(user.id, "2026-09")).cashAvailable.amount).toBe(1_000);

    // Written straight to the table, so nothing invalidates the cache: only the date in the key can.
    await makeTransaction({ userId: user.id, kind: "EARN", amount: 250, date: pkt("2026-09-16T12:00:00") });
    vi.setSystemTime(new Date("2026-09-15T19:01:00.000Z")); // 00:01 PKT, 16 Sep

    expect((await getDashboardSummary(user.id, "2026-09")).cashAvailable.amount).toBe(1_250);
  });
});

// ------------------------------------------------------------------------------------ CMP
describe("CMP: this month against last", () => {
  it("CMP-001: on day 15, both sides stop at the end of the 15th", async () => {
    pinClock(SEP_15_0900_PKT);
    const user = await makeUser();
    const food = await categoryFor(user.id, "Food");
    await spend(user.id, 1_000, pkt("2026-09-10T12:00:00"), food.id);
    await spend(user.id, 300, pkt("2026-09-15T12:00:00"), food.id); // today: in
    await spend(user.id, 5_000, pkt("2026-09-20T12:00:00"), food.id); // later this month: out
    await spend(user.id, 800, pkt("2026-08-15T23:30:00"), food.id); // last month, day 15: in
    await spend(user.id, 3_000, pkt("2026-08-16T00:30:00"), food.id); // day 16: out

    const { comparison } = await getDashboardSummary(user.id, "2026-09");

    expect(comparison).toEqual({
      currentTotal: 1_300,
      currentByCategory: [{ categoryId: food.id, amount: 1_300 }],
      previousTotal: 800,
      previousByCategory: [{ categoryId: food.id, amount: 800 }],
      toDay: 15,
    });
  });

  it("CMP-002: day 31 against a 30-day month counts that whole month", async () => {
    pinClock(new Date("2026-10-31T04:00:00.000Z")); // 09:00 PKT, 31 Oct
    const user = await makeUser();
    await spend(user.id, 600, pkt("2026-09-30T20:00:00"));

    expect((await getDashboardSummary(user.id, "2026-10")).comparison?.previousTotal).toBe(600);
  });

  it("CMP-003: a past month compares whole months; a future month has no comparison", async () => {
    pinClock(SEP_15_0900_PKT);
    const user = await makeUser();
    await spend(user.id, 1_000, pkt("2026-07-28T12:00:00"));
    await spend(user.id, 2_000, pkt("2026-08-29T12:00:00"));

    const aug = await getDashboardSummary(user.id, "2026-08");
    expect([aug.comparison?.currentTotal, aug.comparison?.previousTotal, aug.comparison?.toDay]).toEqual([2_000, 1_000, null]);
    expect((await getDashboardSummary(user.id, "2026-10")).comparison).toBeNull();
  });

  it("CMP-004: only spending is compared, per category", async () => {
    const user = await makeUser();
    const food = await categoryFor(user.id, "Food");
    const bills = await categoryFor(user.id, "Bills");
    await spend(user.id, 400, dateOf("2026-08-05"), food.id);
    await spend(user.id, 600, dateOf("2026-08-06"), bills.id);
    await earn(user.id, 9_000, dateOf("2026-08-07"));
    await makeLoan({ userId: user.id, type: "LENT", amount: 2_000, createdAt: dateOf("2026-08-08") });

    const { comparison } = await getDashboardSummary(user.id, "2026-08");
    expect(comparison?.currentTotal).toBe(1_000);
    expect([...(comparison?.currentByCategory ?? [])].sort((x, y) => x.amount - y.amount)).toEqual([
      { categoryId: food.id, amount: 400 },
      { categoryId: bills.id, amount: 600 },
    ]);
  });
});

// ------------------------------------------------------------------------------------ LTL
describe("LTL: dated loans and the month timeline", () => {
  const monthView = (userId: string, month: string) => getLoansForMonth(userId, month);
  const ids = (loans: { id: string }[]) => loans.map((l) => l.id);

  it("LTL-001: a loan dated 5 Sep isn't in August, and is in September", async () => {
    pinClock(SEP_15_0900_PKT);
    const user = await makeUser();
    const loan = await createLoan(user.id, { type: "LENT", personName: "Ali", amount: 5_000, date: pkt("2026-09-05T12:00:00") });

    expect(ids(await monthView(user.id, "2026-08"))).toEqual([]);
    expect(ids(await monthView(user.id, "2026-09"))).toEqual([loan.id]);
  });

  it("LTL-002/003: shown every month from its date until the month it's cleared, then not", async () => {
    pinClock(new Date("2026-11-15T04:00:00.000Z"));
    const user = await makeUser();
    const loan = await createLoan(user.id, { type: "LENT", personName: "Sara", amount: 3_000, date: pkt("2026-08-20T12:00:00") });
    await settleLoan(user.id, loan.id, 1_000, pkt("2026-09-01T09:00:00")); // on the 1st
    await settleLoan(user.id, loan.id, 2_000, pkt("2026-10-10T12:00:00")); // cleared in October

    const shown = async (m: string) => (await monthView(user.id, m)).map((l) => [l.asOf.status, l.asOf.remainingAmount]);
    expect(await shown("2026-07")).toEqual([]);
    expect(await shown("2026-08")).toEqual([["PENDING", 3_000]]);
    expect(await shown("2026-09")).toEqual([["PARTIAL", 2_000]]);
    expect(await shown("2026-10")).toEqual([["SETTLED", 0]]);
    expect(await shown("2026-11")).toEqual([]);
  });

  it("LTL-004: the month's view is as of its end; the top-level fields stay today's", async () => {
    pinClock(new Date("2026-10-15T04:00:00.000Z"));
    const user = await makeUser();
    const loan = await createLoan(user.id, { type: "LENT", personName: "Ali", amount: 5_000, date: pkt("2026-08-05T12:00:00") });
    await settleLoan(user.id, loan.id, 2_000, pkt("2026-09-10T12:00:00"));

    const [aug] = await monthView(user.id, "2026-08");
    expect(aug.asOf).toEqual({ settledAmount: 0, remainingAmount: 5_000, status: "PENDING" });
    expect([aug.settledAmount, aug.status]).toEqual([2_000, "PARTIAL"]);
  });

  it("LTL-005: a loan's date dates its opening movement; no date means now; a future date is refused", async () => {
    pinClock(SEP_15_0900_PKT);
    const user = await makeUser();
    const backdated = await createLoan(user.id, { type: "LENT", personName: "A", amount: 100, date: pkt("2026-08-31T23:30:00") });
    const opening = await prisma.transaction.findFirstOrThrow({ where: { loanId: backdated.id } });
    expect([opening.date.toISOString(), opening.month]).toEqual([pkt("2026-08-31T23:30:00").toISOString(), "2026-08"]); // LTL-012
    expect(ids(await monthView(user.id, "2026-08"))).toEqual([backdated.id]);
    expect((await getDashboardSummary(user.id, "2026-08")).netDebtSnapshot.totalLent).toBe(100);

    const undated = await createLoan(user.id, { type: "LENT", personName: "B", amount: 100 });
    expect(undated.date).toBe(SEP_15_0900_PKT.toISOString());

    const err = await createLoan(user.id, { type: "LENT", personName: "C", amount: 100, date: pkt("2026-09-16T12:00:00") }).catch((e) => e);
    expect(err.statusCode).toBe(400);
    expect(await prisma.loan.count({ where: { userId: user.id } })).toBe(2);
  });

  it("LTL-006/007: moving the date moves the loan's cash between months, but never past its first repayment", async () => {
    pinClock(SEP_15_0900_PKT);
    const user = await makeUser();
    const loan = await createLoan(user.id, { type: "LENT", personName: "Ali", amount: 4_000, date: pkt("2026-09-02T12:00:00") });
    const augBefore = await getDashboardSummary(user.id, "2026-08");

    await updateLoan(user.id, loan.id, { date: pkt("2026-08-20T12:00:00") });
    const aug = await getDashboardSummary(user.id, "2026-08");
    expect(aug.closingCash).toBe(augBefore.closingCash - 4_000);
    expect(aug.netDebtSnapshot.totalLent).toBe(4_000);
    expect((await prisma.transaction.findFirstOrThrow({ where: { loanId: loan.id } })).month).toBe("2026-08");

    await settleLoan(user.id, loan.id, 1_000, pkt("2026-09-01T08:00:00"));
    // The same day as the repayment is fine, whatever the hour; the next day isn't.
    await updateLoan(user.id, loan.id, { date: pkt("2026-09-01T12:00:00") });
    const late = await updateLoan(user.id, loan.id, { date: pkt("2026-09-02T12:00:00") }).catch((e) => e);
    expect(late.statusCode).toBe(400);
    const future = await updateLoan(user.id, loan.id, { date: pkt("2026-09-16T12:00:00") }).catch((e) => e);
    expect(future.statusCode).toBe(400);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).date.toISOString()).toBe(pkt("2026-09-01T12:00:00").toISOString());
    const opening = await prisma.transaction.findFirstOrThrow({ where: { loanId: loan.id, kind: "LEND_OUT" } });
    expect([opening.date.toISOString(), opening.month]).toEqual([pkt("2026-09-01T12:00:00").toISOString(), "2026-09"]);
  });

  it("LTL-013: changing the amount and the date together moves the opening movement in both", async () => {
    pinClock(SEP_15_0900_PKT);
    const user = await makeUser();
    const loan = await createLoan(user.id, { type: "BORROWED", personName: "Bank", amount: 2_000, date: pkt("2026-09-10T12:00:00") });

    await updateLoan(user.id, loan.id, { amount: 3_500, date: pkt("2026-08-25T12:00:00") });

    const opening = await prisma.transaction.findFirstOrThrow({ where: { loanId: loan.id } });
    expect([opening.amount.toNumber(), opening.month]).toEqual([3_500, "2026-08"]);
    expect((await getDashboardSummary(user.id, "2026-08")).netDebtSnapshot.totalBorrowed).toBe(3_500);
  });

  it("LTL-008: without a month the list is as before; a bad month is a 400; no other user's loans", async () => {
    pinClock(SEP_15_0900_PKT);
    const a = await makeUser();
    const b = await makeUser();
    await createLoan(a.id, { type: "LENT", personName: "A-loan", amount: 100, date: pkt("2026-09-01T12:00:00") });
    await createLoan(b.id, { type: "LENT", personName: "B-secret", amount: 100, date: pkt("2026-09-01T12:00:00") });

    const all = await call(tokenFor(a.id), "GET", "/loans");
    expect(all.json).toHaveLength(1);
    expect(all.json[0]).not.toHaveProperty("asOf");
    expect((await call(tokenFor(a.id), "GET", "/loans?month=nope")).status).toBe(400);
    expect((await call(tokenFor(a.id), "GET", "/loans?type=bogus")).status).toBe(400);
    expect((await call(tokenFor(a.id), "GET", "/loans?month=2026-09&status=SETTLED")).status).toBe(400);
    const month = await call(tokenFor(a.id), "GET", "/loans?month=2026-09");
    expect(JSON.stringify(month.json)).not.toContain("B-secret");
  });

  it("LTL-009: a repayment before the loan's day, or in the future, is refused", async () => {
    pinClock(SEP_15_0900_PKT);
    const user = await makeUser();
    const loan = await createLoan(user.id, { type: "BORROWED", personName: "Bank", amount: 1_000, date: pkt("2026-09-10T18:00:00") });

    for (const when of [pkt("2026-09-09T23:00:00"), pkt("2026-09-16T12:00:00")]) {
      expect((await settleLoan(user.id, loan.id, 100, when).catch((e) => e)).statusCode).toBe(400);
    }
    const untouched = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect([untouched.settledAmount.toNumber(), untouched.status]).toEqual([0, "PENDING"]);
    expect(await prisma.transaction.count({ where: { loanId: loan.id, kind: "REPAY" } })).toBe(0);

    await settleLoan(user.id, loan.id, 100, pkt("2026-09-10T08:00:00")); // same day, earlier hour: fine
    expect(await prisma.transaction.count({ where: { loanId: loan.id, kind: "REPAY" } })).toBe(1);
  });

  it("LTL-010: a loan recorded without cashflow moves only its debt when redated", async () => {
    pinClock(SEP_15_0900_PKT);
    const user = await makeUser();
    const loan = await createLoan(user.id, { type: "BORROWED", personName: "Old", amount: 3_000, recordCashflow: false, date: pkt("2026-09-01T12:00:00") });
    const augBefore = await getDashboardSummary(user.id, "2026-08");

    await updateLoan(user.id, loan.id, { date: pkt("2026-07-01T12:00:00") });

    const aug = await getDashboardSummary(user.id, "2026-08");
    expect(aug.closingCash).toBe(augBefore.closingCash);
    expect(aug.netDebtSnapshot.totalBorrowed).toBe(3_000);
    expect(await prisma.transaction.count({ where: { loanId: loan.id } })).toBe(0);
  });

  it("LTL-011: the month view's totals equal the dashboard's debt position, month by month", async () => {
    pinClock(new Date("2026-11-15T04:00:00.000Z"));
    const user = await makeUser();
    const l1 = await createLoan(user.id, { type: "LENT", personName: "A", amount: 5_000, date: pkt("2026-08-03T12:00:00") });
    const l2 = await createLoan(user.id, { type: "BORROWED", personName: "B", amount: 2_500, date: pkt("2026-09-07T12:00:00") });
    await createLoan(user.id, { type: "LENT", personName: "C", amount: 800, date: pkt("2026-10-01T12:00:00"), recordCashflow: false });
    await settleLoan(user.id, l1.id, 1_500, pkt("2026-09-20T12:00:00"));
    await settleLoan(user.id, l2.id, 2_500, pkt("2026-10-02T12:00:00"));

    for (const month of ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]) {
      const view = await monthView(user.id, month);
      const total = (type: string) =>
        view.filter((l) => l.type === type).reduce((t, l) => t.add(l.asOf.remainingAmount), new Prisma.Decimal(0)).toNumber();
      const { netDebtSnapshot } = await getDashboardSummary(user.id, month);
      expect([total("LENT"), total("BORROWED")], month).toEqual([netDebtSnapshot.totalLent, netDebtSnapshot.totalBorrowed]);
    }
  });
});


describe("Dates at the boundary (G4 PR #27)", () => {
  it("a loan or repayment date must be an ISO date-time with an offset, from 2000 on", async () => {
    pinClock(SEP_15_0900_PKT);
    const user = await makeUser();
    const token = tokenFor(user.id);
    const loan = await createLoan(user.id, { type: "LENT", personName: "Ali", amount: 1_000, date: pkt("2026-09-01T12:00:00") });

    // null, 0 and true used to become 1 Jan 1970; an offset-less string is read in the server's zone.
    const bad = ["null", "0", "true", '"2026-09-01T12:00:00"', '"1990-05-01T12:00:00.000Z"', '"soon"'];
    for (const date of bad) {
      const post = await call(token, "POST", "/loans", `{"type":"LENT","personName":"X","amount":10,"date":${date}}`);
      const patch = await call(token, "PATCH", `/loans/${loan.id}`, `{"date":${date}}`);
      const settle = await call(token, "PATCH", `/loans/${loan.id}/settle`, `{"paymentAmount":10,"date":${date}}`);
      expect([post.status, patch.status, settle.status], date).toEqual([400, 400, 400]);
    }
    expect(await prisma.loan.count({ where: { userId: user.id } })).toBe(1);
    const unchanged = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect([unchanged.date.toISOString(), unchanged.settledAmount.toNumber()]).toEqual([pkt("2026-09-01T12:00:00").toISOString(), 0]);

    // What the app sends: toISOString(), with its Z.
    const ok = await call(token, "POST", "/loans", { type: "LENT", personName: "Y", amount: 10, date: pkt("2026-09-02T12:00:00").toISOString() });
    expect(ok.status).toBe(201);
  });

  it("opening cash is stored to the paisa, and the response is what was stored", async () => {
    const user = await makeUser();
    const res = await call(tokenFor(user.id), "PUT", "/opening-balance", `{"cashToday":${0.1 + 0.2}}`);
    expect(res.json.openingBalance).toBe(0.3);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).openingBalance?.toString()).toBe("0.3");
  });

  it("changing the timezone drops the cached dashboard", async () => {
    pinClock(SEP_15_0900_PKT); // 15 Sep in both Karachi and UTC
    const user = await makeUser();
    await earn(user.id, 1_000, pkt("2026-09-01T12:00:00"));
    expect((await getDashboardSummary(user.id, "2026-09")).closingCash).toBe(1_000);

    // Straight to the table, so only the timezone change can clear the cache.
    await makeTransaction({ userId: user.id, kind: "EARN", amount: 50, date: pkt("2026-09-02T12:00:00") });
    expect((await call(tokenFor(user.id), "PATCH", "/auth/profile", { timezone: "UTC" })).status).toBe(200);

    expect((await getDashboardSummary(user.id, "2026-09")).closingCash).toBe(1_050);
  });
});

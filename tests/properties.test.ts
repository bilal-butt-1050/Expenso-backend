import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { AppError } from "../src/utils/asyncHandler";
import { monthKeyInZone } from "../src/utils/date";
import { getDashboardSummary } from "../src/modules/dashboard/dashboard.service";
import { createLoan, settleLoan, updateLoan, deleteLoan } from "../src/modules/loans/loans.service";
import {
  createTransaction,
  updateTransaction,
  deleteTransaction,
  CASH_SIGN,
} from "../src/modules/transactions/transactions.service";
import { makeUser, categoryFor, dateOf, currentMonth, addMonths } from "./helpers/factories";

/**
 * Property tests (LED-030, FIN-021): long random sequences of real service calls, with the ledger
 * and point-in-time invariants checked along the way against figures computed here, straight from
 * the rows. Seeded, so a failure reproduces exactly: the message names the seed and the step.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = D(0);

/** mulberry32: small, fast and deterministic. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(items: T[]): T => items[Math.floor(next() * items.length)],
    /** 0.01 to 5,000.00, in whole paisa. */
    amount: () => (1 + Math.floor(next() * 500_000)) / 100,
  };
}

/** The window the random dates fall in: 8 months back to 3 ahead of the real current month. */
const now = currentMonth();
const FIRST = addMonths(now.key, -8);
const LAST = addMonths(now.key, 3);
const MONTHS = Array.from({ length: 13 }, (_, i) => addMonths(FIRST, i - 1)); // one before FIRST, to LAST
const dateIn = (r: ReturnType<typeof rng>, from: string, to: string) => {
  const span = MONTHS.indexOf(to) - MONTHS.indexOf(from);
  return dateOf(`${addMonths(from, r.int(0, span))}-${String(r.int(1, 28)).padStart(2, "0")}`);
};

/** Refusals the services are allowed to give a random operation (e.g. settling a settled loan). */
function expectedRefusal(error: unknown): boolean {
  return error instanceof AppError && [400, 404, 409].includes(error.statusCode);
}

/**
 * Runs `steps` random operations for one user. `cashflowOnly` keeps every loan's opening movement,
 * which FIN-007 needs: a loan recorded without cashflow changes net worth with no savings.
 */
async function randomHistory(opts: {
  seed: number;
  steps: number;
  cashflowOnly: boolean;
  every: number;
  check: (userId: string, step: number) => Promise<void>;
}) {
  const r = rng(opts.seed);
  const user = await makeUser();
  // Every history starts from some opening cash (D-62), which must shift every cash figure alike.
  await prisma.user.update({ where: { id: user.id }, data: { openingBalance: D(r.amount()).mul(10) } });
  const categories = await Promise.all(["Food", "Commute", "Bills"].map((n) => categoryFor(user.id, n)));
  const plain: string[] = []; // SPEND/EARN ids the user can edit or delete
  const loans: { id: string; date: Date }[] = [];
  /** A day in the window up to today: loans and repayments can't be in the future (D-63). */
  const pastDate = () => {
    const d = dateIn(r, FIRST, now.key);
    return d.getTime() > Date.now() ? new Date(Date.now() - 60 * 60 * 1000) : d;
  };

  const ops: [number, () => Promise<unknown>][] = [
    [20, async () => {
      const t = await createTransaction(user.id, { kind: "EARN", amount: r.amount() * 2, date: dateIn(r, FIRST, LAST), source: "Salary" });
      plain.push(t.id);
    }],
    [20, async () => {
      const t = await createTransaction(user.id, {
        kind: "SPEND", amount: r.amount(), date: dateIn(r, FIRST, LAST), categoryId: r.pick(categories).id,
      });
      plain.push(t.id);
    }],
    [10, async () => {
      if (!plain.length) return;
      const change = r.next() < 0.5 ? { amount: r.amount() } : { date: dateIn(r, FIRST, LAST) };
      await updateTransaction(user.id, r.pick(plain), change);
    }],
    [8, async () => {
      if (!plain.length) return;
      const id = plain.splice(r.int(0, plain.length - 1), 1)[0];
      await deleteTransaction(user.id, id);
    }],
    [10, async () => {
      const loan = await createLoan(user.id, {
        type: r.next() < 0.5 ? "LENT" : "BORROWED",
        personName: `P${r.int(1, 5)}`,
        amount: r.amount(),
        recordCashflow: opts.cashflowOnly ? true : r.next() < 0.7,
        date: pastDate(),
      });
      loans.push({ id: loan.id, date: new Date(loan.date) });
    }],
    [15, async () => {
      if (!loans.length) return;
      // Sometimes more than what's left, which is refused; sometimes a loan that's already settled.
      // Dated between the loan's date and now, as the rules require.
      const loan = r.pick(loans);
      const when = new Date(loan.date.getTime() + r.next() * (Date.now() - loan.date.getTime()));
      await settleLoan(user.id, loan.id, r.amount() / 2, when);
    }],
    [5, async () => {
      if (!loans.length) return;
      await updateLoan(user.id, r.pick(loans).id, { amount: r.amount() });
    }],
    [4, async () => {
      if (!loans.length) return;
      await deleteLoan(user.id, loans.splice(r.int(0, loans.length - 1), 1)[0].id);
    }],
    [4, async () => {
      if (!loans.length) return;
      // Redate a loan; refused (400) when that would put it after its first repayment.
      const loan = r.pick(loans);
      const date = pastDate();
      await updateLoan(user.id, loan.id, { date });
      loan.date = date;
    }],
  ];
  const totalWeight = ops.reduce((t, [w]) => t + w, 0);

  for (let step = 1; step <= opts.steps; step++) {
    let roll = r.next() * totalWeight;
    const op = ops.find(([w]) => (roll -= w) < 0)![1];
    try {
      await op();
    } catch (error) {
      if (!expectedRefusal(error)) throw new Error(`seed ${opts.seed}, step ${step}: ${String(error)}`);
    }
    if (step % opts.every === 0 || step === opts.steps) await opts.check(user.id, step);
  }
}

/** Cash and outstanding debt as of the end of `month`, computed from the rows, not the dashboard. */
/**
 * The month the opening amount starts counting (D-65b): the earlier of the account's month and the
 * first entry's month. It's in every position from that month's start on, and in none before.
 */
async function openingFrom(userId: string) {
  const [user, first] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { openingBalance: true, createdAt: true } }),
    prisma.transaction.findFirst({ where: { userId }, orderBy: { month: "asc" }, select: { month: true } }),
  ]);
  const accountMonth = monthKeyInZone(user.createdAt, "Asia/Karachi");
  const startMonth = first && first.month < accountMonth ? first.month : accountMonth;
  return { startMonth, amount: user.openingBalance ?? ZERO };
}

async function positionFromRows(userId: string, month: string) {
  const opening = await openingFrom(userId);
  const [rows, loans, settlements] = await Promise.all([
    // Only rows that moved cash: an old debt's starting row doesn't.
    prisma.transaction.findMany({ where: { userId, month: { lte: month }, movesCash: true }, select: { kind: true, amount: true } }),
    prisma.loan.findMany({ where: { userId } }),
    prisma.transaction.findMany({
      where: { userId, month: { lte: month }, kind: { in: ["COLLECT", "REPAY"] } },
      select: { loanId: true, amount: true },
    }),
  ]);
  const cash = rows.reduce(
    (t, row) => t.add(row.amount.mul(CASH_SIGN[row.kind])),
    month >= opening.startMonth ? opening.amount : ZERO
  );
  let lent = ZERO;
  let borrowed = ZERO;
  for (const loan of loans) {
    if (monthKeyInZone(loan.date, "Asia/Karachi") > month) continue; // counts from its own date (D-62)
    const settled = settlements.filter((s) => s.loanId === loan.id).reduce((t, s) => t.add(s.amount), ZERO);
    const outstanding = Prisma.Decimal.max(ZERO, loan.amount.sub(settled));
    if (loan.type === "LENT") lent = lent.add(outstanding);
    else borrowed = borrowed.add(outstanding);
  }
  return { cash, lent, borrowed };
}

describe("property tests", () => {
  it("LED-030: 1,000 random operations keep LED-005 and LED-006 true throughout", async () => {
    for (const seed of [1, 2]) {
      await randomHistory({
        seed,
        steps: 500,
        cashflowOnly: false,
        every: 25,
        check: async (userId, step) => {
          const at = `seed ${seed}, step ${step}`;
          const d = await getDashboardSummary(userId, LAST);
          const rows = await positionFromRows(userId, LAST);
          // LED-005: reported cash is the signed sum of every movement.
          expect(d.cashOnHand, `LED-005 ${at}`).toBe(rows.cash.toNumber());
          // LED-006: net worth is cash plus what's owed to you, less what you owe.
          expect(d.netWorth, `LED-006 ${at}`).toBe(rows.cash.add(rows.lent).sub(rows.borrowed).toNumber());
          // And each loan's settled amount is exactly the cash its settlements moved, never more
          // than the principal: over-collecting would create money that LED-005/006 can't see.
          const loans = await prisma.loan.findMany({ where: { userId } });
          const settlements = await prisma.transaction.findMany({
            where: { userId, kind: { in: ["COLLECT", "REPAY"] } },
            select: { loanId: true, amount: true },
          });
          for (const loan of loans) {
            const moved = settlements.filter((s) => s.loanId === loan.id).reduce((t, s) => t.add(s.amount), ZERO);
            expect(moved.toString(), `settlements vs settledAmount ${loan.id} ${at}`).toBe(loan.settledAmount.toString());
            expect(loan.settledAmount.lessThanOrEqualTo(loan.amount), `over-settled ${loan.id} ${at}`).toBe(true);
          }
        },
      });
    }
  }, 180_000);

  it("FIN-021: 500 random operations keep FIN-003, 005, 006 and 007 true in every month", async () => {
    await randomHistory({
      seed: 21,
      steps: 500,
      cashflowOnly: true,
      every: 50,
      check: async (userId, step) => {
        let previousClosing: number | null = null;
        for (const month of MONTHS) {
          const at = `step ${step}, ${month}`;
          const d = await getDashboardSummary(userId, month);
          const rows = await positionFromRows(userId, month);

          // FIN-003, against the rows: net worth = cash + lent − borrowed, all at the end of the month.
          expect(d.closingCash, `FIN-003 cash ${at}`).toBe(rows.cash.toNumber());
          expect(d.netWorth, `FIN-003 ${at}`).toBe(rows.cash.add(rows.lent).sub(rows.borrowed).toNumber());
          // FIN-005: no gap between one month's close and the next month's open, except where the
          // opening amount starts counting: that month opens with it added.
          const opening = await openingFrom(userId);
          const added = month === opening.startMonth ? opening.amount.toNumber() : 0;
          if (previousClosing !== null) {
            expect(d.openingCash, `FIN-005 ${at}`).toBe(D(previousClosing).add(added).toNumber());
          }
          previousClosing = d.closingCash;
          // FIN-006: opening cash plus this month's movements is the closing cash.
          expect(D(d.openingCash).add(d.netCashThisMonth).toNumber(), `FIN-006 ${at}`).toBe(d.closingCash);
          // FIN-007: opening net worth plus savings is closing net worth.
          expect(D(d.openingNetWorth).add(d.savingsThisMonth).toNumber(), `FIN-007 ${at}`).toBe(d.closingNetWorth);
        }
      },
    });
  }, 180_000);
});

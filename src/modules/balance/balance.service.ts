import { Prisma, TransactionKind } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { inSerializableTransaction } from "../../lib/serializable";
import { invalidateUserDashboard } from "../../lib/cache";
import { AppError } from "../../utils/asyncHandler";
import { DEFAULT_TIMEZONE, monthKeyInZone, startOfTomorrowInZone } from "../../utils/date";
import { money, toNumber } from "../../utils/money";
import { MAX_AMOUNT } from "../../utils/validation";
import { CASH_SIGN } from "../transactions/transactions.service";

/**
 * "You have": the balance right now, and the corrections that make it match reality (D-55).
 *
 * The balance is the signed sum of every movement dated before tomorrow in the user's timezone.
 * A correction records the difference between what the user says they hold and that sum. It is a
 * difference, not an anchor: an entry logged later but dated earlier moves the balance again.
 */

type Db = Prisma.TransactionClient | typeof prisma;

/** Which line of the breakdown each kind belongs to. Each line is signed, so they sum to cash. */
const BREAKDOWN_LINE: Record<TransactionKind, keyof Breakdown> = {
  EARN: "income",
  SPEND: "spending",
  LEND_OUT: "lentOut",
  COLLECT: "collected",
  BORROW_IN: "borrowed",
  REPAY: "repaid",
  ADJUST_IN: "corrections",
  ADJUST_OUT: "corrections",
};

interface Breakdown {
  income: number;
  spending: number;
  lentOut: number;
  collected: number;
  borrowed: number;
  repaid: number;
  corrections: number;
}

async function cashNow(db: Db, userId: string, timezone: string) {
  const cutoff = startOfTomorrowInZone(new Date(), timezone);
  const rows = await db.transaction.groupBy({
    by: ["kind"],
    where: { userId, date: { lt: cutoff } },
    _sum: { amount: true },
  });

  const lines: Record<keyof Breakdown, Prisma.Decimal> = {
    income: money(0),
    spending: money(0),
    lentOut: money(0),
    collected: money(0),
    borrowed: money(0),
    repaid: money(0),
    corrections: money(0),
  };
  let cash = money(0);
  for (const row of rows) {
    const signed = (row._sum.amount ?? money(0)).mul(CASH_SIGN[row.kind]);
    lines[BREAKDOWN_LINE[row.kind]] = lines[BREAKDOWN_LINE[row.kind]].add(signed);
    cash = cash.add(signed);
  }
  return { cash, lines };
}

async function userSettings(db: Db, userId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { timezone: true, balanceSetAt: true } });
  if (!user) throw new AppError(404, "User not found");
  return { timezone: user.timezone ?? DEFAULT_TIMEZONE, balanceSetAt: user.balanceSetAt };
}

export async function getBalance(userId: string) {
  const { timezone, balanceSetAt } = await userSettings(prisma, userId);
  const { cash, lines } = await cashNow(prisma, userId, timezone);
  const breakdown = Object.fromEntries(
    Object.entries(lines).map(([line, value]) => [line, toNumber(value)])
  ) as unknown as Breakdown;

  return {
    cash: toNumber(cash),
    asOf: new Date().toISOString(),
    balanceSetAt: balanceSetAt?.toISOString() ?? null,
    breakdown,
  };
}

/**
 * Makes the balance equal `target` by recording one correction for the difference (none if it
 * already matches), and remembers that the user confirmed it.
 *
 * Serializable: two concurrent updates can't both apply a difference computed from the same
 * starting balance. A retried attempt recomputes from scratch, so the last one wins cleanly.
 */
export async function setBalance(userId: string, target: number) {
  await inSerializableTransaction(async (tx) => {
    const { timezone } = await userSettings(tx, userId);
    const { cash } = await cashNow(tx, userId, timezone);
    const difference = money(target).sub(cash);

    if (difference.abs().greaterThan(MAX_AMOUNT)) {
      throw new AppError(400, "That's too far from your current balance to record in one correction");
    }

    const now = new Date();
    if (!difference.isZero()) {
      await tx.transaction.create({
        data: {
          userId,
          kind: difference.isPositive() ? "ADJUST_IN" : "ADJUST_OUT",
          amount: difference.abs(),
          date: now,
          month: monthKeyInZone(now, timezone),
          // Also what an older app build shows as the row's title (D-56).
          description: "Balance correction",
          paymentMethod: "Cash",
        },
      });
    }
    await tx.user.update({ where: { id: userId }, data: { balanceSetAt: now } });
  });

  invalidateUserDashboard(userId);
  return getBalance(userId);
}

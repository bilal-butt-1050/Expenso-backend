import { inSerializableTransaction } from "../../lib/serializable";
import { invalidateUserDashboard } from "../../lib/cache";
import { AppError } from "../../utils/asyncHandler";
import { DEFAULT_TIMEZONE, startOfTomorrowInZone } from "../../utils/date";
import { money, toNumber } from "../../utils/money";
import { MAX_AMOUNT } from "../../utils/validation";
import { CASH_SIGN } from "../transactions/transactions.service";

/**
 * Sets the user's opening cash from what they hold today (R-34, D-63).
 *
 * The user rarely knows what they had when they started, but they do know what they have now. So
 * they enter today's money and this stores the one opening amount that makes today's figure match
 * it: `openingBalance = cashToday − (the ledger's cash up to today)`. Re-entering recomputes it.
 *
 * Serializable, like every read-then-write on a balance: an entry saved at the same moment would
 * otherwise make the stored amount miss the target.
 */
export async function setOpeningBalanceFromToday(userId: string, cashToday: number) {
  const openingBalance = await inSerializableTransaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { timezone: true } });
    if (!user) throw new AppError(404, "User not found");

    // "Up to today" = dated before the start of tomorrow in the user's timezone.
    const cutoff = startOfTomorrowInZone(new Date(), user.timezone ?? DEFAULT_TIMEZONE);
    const byKind = await tx.transaction.groupBy({
      by: ["kind"],
      where: { userId, date: { lt: cutoff } },
      _sum: { amount: true },
    });
    const ledgerCash = byKind.reduce(
      (total, row) => total.add((row._sum.amount ?? money(0)).mul(CASH_SIGN[row.kind])),
      money(0)
    );

    const opening = money(cashToday).sub(ledgerCash);
    if (opening.abs().greaterThan(MAX_AMOUNT)) {
      throw new AppError(400, "That's too far from what your entries add up to");
    }
    await tx.user.update({ where: { id: userId }, data: { openingBalance: opening } });
    return opening;
  });

  // Every month's cash moves with it, so every cached month goes.
  invalidateUserDashboard(userId);
  return { openingBalance: toNumber(openingBalance) };
}

import { inSerializableTransaction } from "../../lib/serializable";
import { invalidateUserDashboard } from "../../lib/cache";
import { AppError } from "../../utils/asyncHandler";
import { DEFAULT_TIMEZONE, monthKeyInZone, startOfTomorrowInZone } from "../../utils/date";
import { money, round2, toNumber } from "../../utils/money";
import { MAX_AMOUNT } from "../../utils/validation";
import { CASH_SIGN } from "../transactions/transactions.service";

/**
 * Sets the user's opening cash from what they hold today (R-34, D-63).
 *
 * The user rarely knows what they had when they started, but they do know what they have now. So
 * they enter today's money and this stores the one opening amount that makes today's figure match
 * it: `openingBalance = cashToday − (the ledger's cash up to today)`. Re-entering recomputes it.
 *
 * Serializable, so two of these at once can't both apply. It doesn't guard against an ordinary
 * entry saved in the same instant (those writes aren't Serializable); for a single-user app that's
 * accepted, and re-entering today's money corrects it.
 */
export async function setOpeningBalanceFromToday(userId: string, cashToday: number) {
  const openingBalance = await inSerializableTransaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { timezone: true } });
    if (!user) throw new AppError(404, "User not found");

    // Exactly the dashboard's rule for the current month's Cash available: every earlier month, plus
    // this month's rows dated before the start of tomorrow. Using the same rule means the figure
    // lands on the target by construction, even if month keys were filed under an older timezone.
    const timezone = user.timezone ?? DEFAULT_TIMEZONE;
    const now = new Date();
    const currentMonth = monthKeyInZone(now, timezone);
    const cutoff = startOfTomorrowInZone(now, timezone);
    const byKind = await tx.transaction.groupBy({
      by: ["kind"],
      where: { userId, OR: [{ month: { lt: currentMonth } }, { month: currentMonth, date: { lt: cutoff } }] },
      _sum: { amount: true },
    });
    const ledgerCash = byKind.reduce(
      (total, row) => total.add((row._sum.amount ?? money(0)).mul(CASH_SIGN[row.kind])),
      money(0)
    );

    // Rounded to paisa before it's checked and stored, so the response is what was saved.
    const opening = round2(money(cashToday).sub(ledgerCash));
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

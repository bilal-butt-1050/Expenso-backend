import { Prisma, PrismaClient } from "@prisma/client";
import { AppError } from "../utils/asyncHandler";
import { DEFAULT_TIMEZONE, datePartsInZone, dayKeyInZone } from "../utils/date";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * History starts on the day the account was created (Bilal, D-67): nothing can be dated before
 * it. Money before joining is the opening cash, entered once at sign-up; an entry dated earlier
 * would count it a second time. Compared as calendar days in the user's timezone.
 *
 * On an edit, pass the entry's current date: only a move to an earlier day is checked. Older
 * entries (backdated before this rule) stay editable, and the app sends the date on every edit.
 *
 * Returns the user's timezone, which every caller needs next.
 */
export async function assertNotBeforeJoin(
  db: PrismaClient | Prisma.TransactionClient,
  userId: string,
  date: Date,
  previous?: Date,
): Promise<string> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { createdAt: true, timezone: true } });
  const timezone = user?.timezone ?? DEFAULT_TIMEZONE;
  if (!user) return timezone;
  if (previous && dayKeyInZone(date, timezone) >= dayKeyInZone(previous, timezone)) return timezone;
  if (dayKeyInZone(date, timezone) < dayKeyInZone(user.createdAt, timezone)) {
    const { year, month, day } = datePartsInZone(user.createdAt, timezone);
    throw new AppError(400, `Entries can't be dated before you joined (${day} ${MONTHS[month - 1]} ${year})`);
  }
  return timezone;
}

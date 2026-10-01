import { Prisma, PrismaClient } from "@prisma/client";
import { AppError } from "../utils/asyncHandler";
import { DEFAULT_TIMEZONE, datePartsInZone, dayKeyInZone } from "../utils/date";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * History starts on the day the account was created (Bilal, D-67): nothing can be dated before
 * it. Money before joining is the opening cash, entered once at sign-up; an entry dated earlier
 * would count it a second time. Compared as calendar days in the user's timezone.
 */
export async function assertNotBeforeJoin(
  db: PrismaClient | Prisma.TransactionClient,
  userId: string,
  date: Date,
): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { createdAt: true, timezone: true } });
  if (!user) return;
  const timezone = user.timezone ?? DEFAULT_TIMEZONE;
  if (dayKeyInZone(date, timezone) < dayKeyInZone(user.createdAt, timezone)) {
    const { year, month, day } = datePartsInZone(user.createdAt, timezone);
    throw new AppError(400, `Entries can't be dated before you joined (${day} ${MONTHS[month - 1]} ${year})`);
  }
}

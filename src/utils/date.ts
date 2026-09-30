// All months are keyed as "YYYY-MM" strings — easy to index, sort, and
// compare without timezone surprises.

export const DEFAULT_TIMEZONE = "Asia/Karachi";

/**
 * Which calendar month an instant falls in, **from the user's point of view**.
 *
 * This used to be computed in UTC while the client computed it locally, so the two disagreed. For
 * a user in PKT (UTC+5) an expense logged at 2am on the 1st is 21:00 UTC on the last day of the
 * previous month — it was filed under the wrong month, and the app then jumped to a month where
 * the new expense wasn't listed.
 *
 * `en-CA` is used because it formats as YYYY-MM-DD, so the parts come out already zero-padded.
 */
export function monthKeyInZone(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
    }).formatToParts(date);

    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    if (year && month) return `${year}-${month}`;
  } catch {
    // An invalid IANA zone reaching this far shouldn't take a write down with it.
  }
  return toMonthKey(date);
}

/** A date's calendar parts as seen in `timeZone`. */
export function datePartsInZone(date: Date, timeZone: string = DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

/** "YYYY-MM-DD" in `timeZone`: compares calendar days as the user sees them. */
export function dayKeyInZone(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  const { year, month, day } = datePartsInZone(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The instant a calendar day begins in `timeZone` (local midnight), as a UTC Date. `day` may
 * overflow the month (32 → the 1st of the next), which is how "the start of tomorrow" is found.
 */
export function startOfDayInZone(year: number, month: number, day: number, timeZone: string = DEFAULT_TIMEZONE): Date {
  const wallClock = Date.UTC(year, month - 1, day);
  // Read local midnight as if it were UTC, then shift by the zone's offset at that instant. Done
  // twice, so a DST change around midnight lands on the right side.
  let instant = wallClock - zoneOffsetMs(new Date(wallClock), timeZone);
  instant = wallClock - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/**
 * When the user's *tomorrow* begins. "Up to today" means dated before this: the app saves a
 * picked day at 12:00 local, so "up to now" would leave out today's entries until noon (D-63).
 */
export function startOfTomorrowInZone(now: Date, timeZone: string = DEFAULT_TIMEZONE): Date {
  const { year, month, day } = datePartsInZone(now, timeZone);
  return startOfDayInZone(year, month, day + 1, timeZone);
}

/** How far `timeZone`'s wall clock is ahead of UTC at `date`, in milliseconds. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC month key. Prefer `monthKeyInZone` for anything a user will see. */
export function toMonthKey(date: Date | string): string {
  if (typeof date === "string") {
    const match = date.match(/^(\d{4})-(\d{2})/);
    if (match) {
      return `${match[1]}-${match[2]}`;
    }
  }
  const d = typeof date === "string" ? new Date(date) : date;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Guard against a bad IANA name being persisted to a user's profile. */
export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}


export function isValidMonthKey(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

// Returns the `n` month keys ending at (and including) `monthKey`, oldest first.
export function trailingMonths(monthKey: string, n: number): string[] {
  const [year, month] = monthKey.split("-").map(Number);
  const months: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    months.push(toMonthKey(d));
  }
  return months;
}

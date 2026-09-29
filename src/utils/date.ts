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

/**
 * The instant the user's *tomorrow* begins: midnight at the start of the next calendar day in
 * `timeZone`, as a UTC Date.
 *
 * "Up to now" is the wrong cutoff for a balance: the app saves a picked day at 12:00 local, so an
 * expense dated today would not count until noon (D-55).
 */
export function startOfTomorrowInZone(now: Date, timeZone: string = DEFAULT_TIMEZONE): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  // Local midnight of tomorrow, first read as if it were UTC, then shifted by the zone's offset at
  // that instant. Checked twice, so a DST change around midnight lands on the right side.
  const wallClock = Date.UTC(part("year"), part("month") - 1, part("day") + 1);
  let instant = wallClock - zoneOffsetMs(new Date(wallClock), timeZone);
  instant = wallClock - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
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

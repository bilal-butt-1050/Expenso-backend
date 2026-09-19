// All months are keyed as "YYYY-MM" strings — easy to index, sort, and
// compare without timezone surprises.

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

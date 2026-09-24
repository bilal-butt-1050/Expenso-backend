import { Prisma } from "@prisma/client";

/**
 * Money is stored as `Decimal(14,2)` and must never round-trip through a float. The previous
 * `Float` columns accumulated error across partial settlements, which is why settle logic was
 * peppered with `Math.round(x * 100) / 100`.
 *
 * `Prisma.Decimal` serializes to a JSON *string*, so responses must convert explicitly at the
 * boundary — the mobile client types every amount as `number`. Doing that in one place keeps the
 * conversion from being forgotten on a new field.
 */

export type Money = Prisma.Decimal;

export function money(value: Prisma.Decimal | number | string): Money {
  return new Prisma.Decimal(value);
}

/** Convert to the `number` the API contract promises. Safe well past any realistic amount. */
export function toNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : value.toNumber();
}

export function add(a: Money, b: Money | number): Money {
  return a.add(b);
}

export function subtract(a: Money, b: Money | number): Money {
  return a.sub(b);
}

/** Never negative — used for remaining balances, which are floored at zero. */
export function clampPositive(value: Money): Money {
  return value.isNegative() ? money(0) : value;
}

export function min(a: Money, b: Money): Money {
  return a.lessThan(b) ? a : b;
}

export function isPositive(value: Money | number): boolean {
  return money(value).greaterThan(0);
}

/** Quantize to 2dp, the storage precision, so comparisons don't fail on trailing noise. */
export function round2(value: Money): Money {
  return value.toDecimalPlaces(2);
}

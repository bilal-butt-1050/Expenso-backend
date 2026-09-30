import { z } from "zod";

/** The largest value a `numeric(14,2)` column holds. */
export const MAX_AMOUNT = 999_999_999_999.99;

/**
 * Every money amount a request carries. `z.number()` alone accepts Infinity (JSON's `1e999`
 * parses to it) and values past the column's ceiling, which then failed in Postgres as a 500.
 */
export const amountSchema = (message = "Amount must be greater than 0") =>
  z.number().finite().positive(message).max(MAX_AMOUNT, "Amount is too large");

/** The earliest date a money movement may carry. Anything older is a client bug, not a record. */
export const EARLIEST_DATE = new Date("2000-01-01T00:00:00.000Z");

/**
 * A money movement's date: an ISO 8601 date-time **with** an offset (the app sends `toISOString()`),
 * from 2000 on. `z.coerce.date()` accepted `null`, `0` and `true` as 1 Jan 1970, which a loan's
 * as-of logic would then count in every month since (G4 PR #27 M1). Offset-less strings are refused
 * too: they'd be read in the server's own timezone.
 */
export const movementDateSchema = z
  .string()
  .datetime({ offset: true, message: "Use an ISO date-time with a timezone offset" })
  .transform((s) => new Date(s))
  .refine((d) => d.getTime() >= EARLIEST_DATE.getTime(), "That date is too far in the past");

/** A money amount that may be zero (a budget of nothing). */
export const nonNegativeAmountSchema = z.number().finite().min(0).max(MAX_AMOUNT, "Amount is too large");

/**
 * An email address as every auth route takes it: trimmed, lowercased, at most 254 characters (the
 * longest a real address can be), and a valid address.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "That email is too long")
  .email("Please provide a valid email address");


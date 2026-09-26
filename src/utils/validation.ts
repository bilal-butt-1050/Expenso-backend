import { z } from "zod";

/** The largest value a `numeric(14,2)` column holds. */
export const MAX_AMOUNT = 999_999_999_999.99;

/**
 * Every money amount a request carries. `z.number()` alone accepts Infinity (JSON's `1e999`
 * parses to it) and values past the column's ceiling, which then failed in Postgres as a 500.
 */
export const amountSchema = (message = "Amount must be greater than 0") =>
  z.number().finite().positive(message).max(MAX_AMOUNT, "Amount is too large");

/** A money amount that may be zero (a budget of nothing). */
export const nonNegativeAmountSchema = z.number().finite().min(0).max(MAX_AMOUNT, "Amount is too large");

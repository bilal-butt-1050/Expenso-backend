import { Router } from "express";
import { z } from "zod";
import { amountSchema, nonNegativeAmountSchema } from "../../utils/validation";
import { TransactionKind } from "@prisma/client";
import { asyncHandler } from "../../utils/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import { isValidMonthKey } from "../../utils/date";
import {
  adjustBalance,
  createOrReplayTransaction,
  deleteTransaction,
  listTransactions,
  updateTransaction,
} from "./transactions.service";

export const transactionsRouter = Router();
transactionsRouter.use(requireAuth);

const KINDS = [
  "SPEND",
  "EARN",
  "LEND_OUT",
  "COLLECT",
  "BORROW_IN",
  "REPAY",
  "ADJUST",
] as const satisfies readonly TransactionKind[];

const personNameSchema = z.string().trim().min(1, "Who was it?").max(80, "Name is too long");

export const createSchema = z.object({
  /**
   * Optional client-generated id, for idempotent offline replay (ARCH N7.3). Lowercased so a client
   * that changes the case of an id between attempts can't create a duplicate.
   */
  id: z
    .string()
    .uuid()
    .transform((v) => v.toLowerCase())
    .optional(),
  kind: z.enum(["SPEND", "EARN"]),
  amount: amountSchema(),
  date: z.coerce.date(),
  description: z.string().max(200).optional(),
  paymentMethod: z.string().max(50).optional(),
  // SPEND
  categoryId: z.string().uuid().optional(),
  needWant: z.enum(["Need", "Want"]).optional(),
  // EARN
  source: z.string().max(50).optional(),
  sourceIcon: z.string().max(50).optional(),
  sourceColor: z.string().max(20).optional(),
  // SPEND involving someone else. `amount` is always the user's own share.
  /** They paid it: the user owes them `amount`, and no cash moved. */
  paidBy: z.object({ personName: personNameSchema }).nullable().optional(),
  /** The user paid it all; `share` is theirs, so they owe the user that much. */
  split: z.object({ personName: personNameSchema, share: amountSchema("Their share must be greater than 0") }).nullable().optional(),
});

const adjustSchema = z.object({
  /** What the user actually has now. The difference from the ledger is recorded. */
  actualCash: nonNegativeAmountSchema,
});

// An id is fixed at creation; PATCH can never change it.
export const updateSchema = createSchema.partial().omit({ kind: true, id: true });

const listSchema = z.object({
  month: z.string().refine(isValidMonthKey, "month must be in YYYY-MM format").optional(),
  /** Comma-separated, e.g. `kinds=SPEND,EARN`. Omitted means every kind. */
  kinds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(KINDS)).optional()),
  categoryId: z.string().uuid().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

transactionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = listSchema.parse(req.query);
    res.json(await listTransactions(req.userId!, query));
  })
);

transactionsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const { transaction, replayed } = await createOrReplayTransaction(req.userId!, body);
    // 200 for a replay of a row that already exists, 201 when this request created it.
    res.status(replayed ? 200 : 201).json(transaction);
  })
);

/** Correct the balance to what the user actually has (an ADJUST row). */
transactionsRouter.post(
  "/adjust-balance",
  asyncHandler(async (req, res) => {
    const { actualCash } = adjustSchema.parse(req.body);
    res.status(201).json(await adjustBalance(req.userId!, actualCash));
  })
);

transactionsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const body = updateSchema.parse(req.body);
    res.json(await updateTransaction(req.userId!, req.params.id, body));
  })
);

transactionsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await deleteTransaction(req.userId!, req.params.id);
    res.status(204).end();
  })
);

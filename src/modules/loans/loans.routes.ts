import { Router } from "express";
import { z } from "zod";
import { isValidMonthKey } from "../../utils/date";
import { movementDateSchema } from "../../utils/validation";
import { amountSchema } from "../../utils/validation";
import { asyncHandler } from "../../utils/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import {
  createLoan,
  deleteLoan,
  deleteLoanPayment,
  getLoans,
  getLoansForMonth,
  getLoansSummary,
  settleLoan,
  updateLoan,
} from "./loans.service";

export const loansRouter = Router();

loansRouter.use(requireAuth);

const createLoanSchema = z.object({
  type: z.enum(["LENT", "BORROWED"]),
  personName: z.string().trim().min(1, "Person or institution name is required").max(80, "Name is too long"),
  amount: amountSchema(),
  dueDate: z.string().datetime().optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  /** False records a debt that predates the app without fabricating a cash movement today. */
  recordCashflow: z.boolean().optional(),
  /** When the money moved (D-62). Defaults to now. */
  date: movementDateSchema.optional(),
});

const settleLoanSchema = z.object({
  paymentAmount: amountSchema("Payment amount must be greater than 0").optional(),
  /** When the payment actually happened. Defaults to now. */
  date: movementDateSchema.optional(),
  /** False = settled without money (forgiven, paid in kind). Defaults to true. */
  movesCash: z.boolean().optional(),
});

const updateLoanSchema = z.object({
  personName: z.string().trim().min(1).max(80, "Name is too long").optional(),
  amount: amountSchema().optional(),
  dueDate: z.string().datetime().optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  date: movementDateSchema.optional(),
  /** Whether the money went through the user's cash when the loan started. */
  recordCashflow: z.boolean().optional(),
});

/** Validated, so a bad filter is a 400 rather than a Prisma error (it used to be a 500). */
const listLoansSchema = z
  .object({
    type: z.enum(["LENT", "BORROWED"]).optional(),
    status: z.enum(["PENDING", "PARTIAL", "SETTLED"]).optional(),
    /** The Loans tab's month view (R-41): visible loans, with their position as of its end. */
    month: z.string().refine(isValidMonthKey, "month must be in YYYY-MM format").optional(),
  })
  // `status` is today's, while `month` is a view as of that month's end: filtering one by the other
  // would give a list that can't match the month's totals.
  .refine((q) => !(q.month && q.status), { message: "status can't be combined with month", path: ["status"] });

loansRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { month, ...filters } = listLoansSchema.parse(req.query);
    res.json(month ? await getLoansForMonth(req.userId!, month, filters) : await getLoans(req.userId!, filters));
  })
);

loansRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const summary = await getLoansSummary(req.userId!);
    res.json(summary);
  })
);

loansRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = createLoanSchema.parse(req.body);
    const loan = await createLoan(req.userId!, body);
    res.status(201).json(loan);
  })
);

loansRouter.patch(
  "/:id/settle",
  asyncHandler(async (req, res) => {
    const body = settleLoanSchema.parse(req.body);
    const updated = await settleLoan(req.userId!, req.params.id, body.paymentAmount, body.date, body.movesCash);
    res.json(updated);
  })
);

loansRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const body = updateLoanSchema.parse(req.body);
    const updated = await updateLoan(req.userId!, req.params.id, body);
    res.json(updated);
  })
);

/** Undoes one repayment. */
loansRouter.delete(
  "/:id/payments/:paymentId",
  asyncHandler(async (req, res) => {
    res.json(await deleteLoanPayment(req.userId!, req.params.id, req.params.paymentId));
  })
);

loansRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await deleteLoan(req.userId!, req.params.id);
    res.status(204).end();
  })
);

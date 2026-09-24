import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import {
  createLoan,
  deleteLoan,
  getLoans,
  getLoansSummary,
  settleLoan,
  updateLoan,
} from "./loans.service";

export const loansRouter = Router();

loansRouter.use(requireAuth);

const createLoanSchema = z.object({
  type: z.enum(["LENT", "BORROWED"]),
  personName: z.string().trim().min(1, "Person or institution name is required"),
  amount: z.number().positive("Amount must be greater than 0"),
  dueDate: z.string().datetime().optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  /** False records a debt that predates the app without fabricating a cash movement today. */
  recordCashflow: z.boolean().optional(),
});

const settleLoanSchema = z.object({
  paymentAmount: z.number().positive("Payment amount must be greater than 0").optional(),
  /** When the payment actually happened. Defaults to now. */
  date: z.coerce.date().optional(),
});

const updateLoanSchema = z.object({
  personName: z.string().trim().min(1).optional(),
  amount: z.number().positive().optional(),
  dueDate: z.string().datetime().optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
});

loansRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const type = req.query.type as "LENT" | "BORROWED" | undefined;
    const status = req.query.status as "PENDING" | "PARTIAL" | "SETTLED" | undefined;
    const loans = await getLoans(req.userId!, { type, status });
    res.json(loans);
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
    const updated = await settleLoan(req.userId!, req.params.id, body.paymentAmount, body.date);
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

loansRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await deleteLoan(req.userId!, req.params.id);
    res.status(204).end();
  })
);

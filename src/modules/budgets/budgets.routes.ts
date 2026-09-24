import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError } from "../../utils/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import { isValidMonthKey } from "../../utils/date";
import { listBudgets, upsertBudget, deleteBudget } from "./budgets.service";

export const budgetsRouter = Router();
budgetsRouter.use(requireAuth);

const budgetSchema = z.object({
  categoryId: z.string().uuid(),
  amount: z.number().min(0),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be in YYYY-MM format"),
});

/**
 * A missing or malformed month previously threw a bare `Error`, which the error handler reported
 * as a 500 "Something went wrong on our end" — a client mistake presented as a server fault.
 * It also accepted month 00 and 13 via a loose `\d{2}`.
 */
function requireMonth(value: unknown): string {
  if (typeof value !== "string" || !isValidMonthKey(value)) {
    throw new AppError(400, "A month query parameter in YYYY-MM format is required");
  }
  return value;
}

budgetsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const month = requireMonth(req.query.month);
    res.json(await listBudgets(req.userId!, month));
  })
);

budgetsRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    const body = budgetSchema.parse(req.body);
    res.json(await upsertBudget(req.userId!, body.categoryId, body.amount, body.month));
  })
);

budgetsRouter.delete(
  "/:categoryId",
  asyncHandler(async (req, res) => {
    const month = requireMonth(req.query.month);
    await deleteBudget(req.userId!, req.params.categoryId, month);
    res.status(204).send();
  })
);

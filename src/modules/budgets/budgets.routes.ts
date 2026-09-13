import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import { listBudgets, upsertBudget, deleteBudget } from "./budgets.service";

export const budgetsRouter = Router();
budgetsRouter.use(requireAuth);

const budgetSchema = z.object({
  categoryId: z.string().uuid(),
  amount: z.number().min(0),
  month: z.string().regex(/^\d{4}-\d{2}$/, "Invalid month format"),
});

budgetsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const month = req.query.month as string | undefined;
    if (!month) throw new Error("Month is required");
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
    const month = req.query.month as string | undefined;
    if (!month) throw new Error("Month is required");
    await deleteBudget(req.userId!, req.params.categoryId, month);
    res.status(204).send();
  })
);

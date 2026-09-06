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
});

budgetsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listBudgets(req.userId!));
  })
);

budgetsRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    const body = budgetSchema.parse(req.body);
    res.json(await upsertBudget(req.userId!, body.categoryId, body.amount));
  })
);

budgetsRouter.delete(
  "/:categoryId",
  asyncHandler(async (req, res) => {
    await deleteBudget(req.userId!, req.params.categoryId);
    res.status(204).send();
  })
);

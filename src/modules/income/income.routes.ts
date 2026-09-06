import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import { listIncome, upsertIncome, deleteIncome } from "./income.service";
import { isValidMonthKey } from "../../utils/date";

export const incomeRouter = Router();
incomeRouter.use(requireAuth);

const incomeSchema = z.object({
  month: z.string().refine(isValidMonthKey, "month must be in YYYY-MM format"),
  salary: z.number().min(0),
  bonus: z.number().min(0).default(0),
  otherIncome: z.number().min(0).default(0),
});

incomeRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listIncome(req.userId!));
  })
);

incomeRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    const body = incomeSchema.parse(req.body);
    res.json(await upsertIncome(req.userId!, body));
  })
);

incomeRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await deleteIncome(req.userId!, req.params.id);
    res.status(204).send();
  })
);

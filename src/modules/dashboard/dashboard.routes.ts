import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import { getDashboardSummary } from "./dashboard.service";
import { isValidMonthKey, toMonthKey } from "../../utils/date";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

const querySchema = z.object({
  month: z
    .string()
    .refine(isValidMonthKey, "month must be in YYYY-MM format")
    .default(() => toMonthKey(new Date())),
});

dashboardRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const { month } = querySchema.parse(req.query);
    res.json(await getDashboardSummary(req.userId!, month));
  })
);

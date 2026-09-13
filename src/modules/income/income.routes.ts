import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import {
  listIncome,
  createIncome,
  updateIncome,
  deleteIncome,
  getIncomeSummary,
} from "./income.service";
import { isValidMonthKey } from "../../utils/date";

export const incomeRouter = Router();
incomeRouter.use(requireAuth);

const incomeSchema = z.object({
  date: z.coerce.date(),
  source: z.string().min(1).max(50),
  sourceIcon: z.string().max(50).optional(),
  sourceColor: z.string().max(20).optional(),
  description: z.string().max(200).optional(),
  amount: z.number().positive(),
  paymentMethod: z.string().max(50).optional(),
});

const updateIncomeSchema = incomeSchema.partial();

const querySchema = z.object({
  month: z.string().optional(),
  skip: z.coerce.number().min(0).optional(),
  take: z.coerce.number().min(1).max(100).optional(),
});

incomeRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    res.json(await listIncome(req.userId!, query));
  })
);

incomeRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const month = typeof req.query.month === "string" ? req.query.month : "";
    if (!month || !isValidMonthKey(month)) {
      res.status(400).json({ error: "Valid month query param in YYYY-MM format required" });
      return;
    }
    res.json(await getIncomeSummary(req.userId!, month));
  })
);

incomeRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = incomeSchema.parse(req.body);
    res.status(201).json(await createIncome(req.userId!, body));
  })
);

incomeRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const body = updateIncomeSchema.parse(req.body);
    res.json(await updateIncome(req.userId!, req.params.id, body));
  })
);


incomeRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await deleteIncome(req.userId!, req.params.id);
    res.status(204).send();
  })
);

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import {
  listExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
  toggleExpenseStatus,
} from "./expenses.service";

export const expensesRouter = Router();
expensesRouter.use(requireAuth);

const expenseSchema = z.object({
  categoryId: z.string().uuid(),
  date: z.coerce.date(),
  description: z.string().max(200).optional(),
  amount: z.number().positive(),
  paymentMethod: z.enum(["Cash", "Bank Transfer", "Card", "Cheque"]).optional(),
  needWant: z.enum(["Need", "Want"]).optional(),
  status: z.enum(["Paid", "Unpaid"]).optional(),
});

const updateExpenseSchema = expenseSchema.partial();

const querySchema = z.object({
  month: z.string().optional(),
  categoryId: z.string().uuid().optional(),
  status: z.enum(["Paid", "Unpaid"]).optional(),
});

expensesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    res.json(await listExpenses(req.userId!, query));
  })
);

expensesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = expenseSchema.parse(req.body);
    res.status(201).json(await createExpense(req.userId!, body));
  })
);

expensesRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const body = updateExpenseSchema.parse(req.body);
    res.json(await updateExpense(req.userId!, req.params.id, body));
  })
);

expensesRouter.patch(
  "/:id/toggle-status",
  asyncHandler(async (req, res) => {
    res.json(await toggleExpenseStatus(req.userId!, req.params.id));
  })
);

expensesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await deleteExpense(req.userId!, req.params.id);
    res.status(204).send();
  })
);

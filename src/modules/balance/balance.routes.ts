import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import { MAX_AMOUNT } from "../../utils/validation";
import { getBalance, setBalance } from "./balance.service";

export const balanceRouter = Router();
balanceRouter.use(requireAuth);

/** What the user actually holds. Zero and negative (overdrawn) are real answers. */
const setBalanceSchema = z.object({
  amount: z
    .number()
    .finite()
    .min(-MAX_AMOUNT, "Amount is too large")
    .max(MAX_AMOUNT, "Amount is too large"),
});

balanceRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await getBalance(req.userId!));
  })
);

balanceRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { amount } = setBalanceSchema.parse(req.body);
    res.json(await setBalance(req.userId!, amount));
  })
);

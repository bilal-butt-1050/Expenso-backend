import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import { MAX_AMOUNT } from "../../utils/validation";
import { setOpeningBalanceFromToday } from "./opening-balance.service";

export const openingBalanceRouter = Router();
openingBalanceRouter.use(requireAuth);

/** What the user holds today, all cash and bank money together. Money can't be negative (D-64). */
const schema = z.object({
  cashToday: z.number().finite().min(0, "Enter zero or more").max(MAX_AMOUNT, "Amount is too large"),
});

openingBalanceRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    const { cashToday } = schema.parse(req.body);
    res.json(await setOpeningBalanceFromToday(req.userId!, cashToday));
  })
);

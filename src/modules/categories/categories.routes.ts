import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import { listCategories, createCategory, updateCategory, deleteCategory } from "./categories.service";

export const categoriesRouter = Router();
categoriesRouter.use(requireAuth);

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Must be a hex color like #00E676");

const createSchema = z.object({
  name: z.string().min(1).max(30),
  icon: z.string().min(1).max(40).optional(),
  color: hexColor.optional(),
});

const updateSchema = createSchema.partial();

categoriesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listCategories(req.userId!));
  })
);

categoriesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    res.status(201).json(await createCategory(req.userId!, body));
  })
);

categoriesRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const body = updateSchema.parse(req.body);
    res.json(await updateCategory(req.userId!, req.params.id, body));
  })
);

categoriesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await deleteCategory(req.userId!, req.params.id));
  })
);

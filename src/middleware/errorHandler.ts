import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../utils/asyncHandler";

// Single place that turns any thrown error into a consistent JSON shape.
// Keeping this separate from business logic means every module can just
// `throw new AppError(...)` (or let a ZodError bubble up) and trust it will
// be reported to the client sensibly.
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Validation failed",
      details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  // Prisma unique-constraint violations etc. surface here with a `code`.
  if (typeof err === "object" && err !== null && "code" in err && err.code === "P2002") {
    res.status(409).json({ error: "A record with that value already exists" });
    return;
  }

  console.error(err);
  res.status(500).json({ error: "Something went wrong on our end" });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
}

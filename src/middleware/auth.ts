import { NextFunction, Request, Response } from "express";
import { verifyToken } from "../utils/jwt";
import { AppError } from "../utils/asyncHandler";

// Every protected route runs this first. It expects `Authorization: Bearer
// <token>`, verifies it, and stamps `req.userId` for downstream handlers —
// so a controller never has to think about tokens, only `req.userId`.
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new AppError(401, "Missing or invalid Authorization header");
  }

  const token = header.slice("Bearer ".length);
  try {
    const payload = verifyToken(token);
    req.userId = payload.userId;
    next();
  } catch {
    throw new AppError(401, "Invalid or expired token");
  }
}

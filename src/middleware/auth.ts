import { NextFunction, Request, Response } from "express";
import { verifyToken } from "../utils/jwt";
import { AppError } from "../utils/asyncHandler";
import { prisma } from "../lib/prisma";
import { cache } from "../lib/cache";

const TOKEN_VERSION_TTL_S = 60;

/**
 * Current `tokenVersion` for a user, cached briefly.
 *
 * Checking the version means a DB read on every authenticated request, which is too much for a
 * hot path. A short TTL bounds the window in which a revoked session still works to a minute,
 * which is an acceptable trade for not querying on every call. `bumpTokenVersion` clears the
 * entry so a password change takes effect immediately on this instance.
 */
async function currentTokenVersion(userId: string): Promise<number | null> {
  const key = `token_version_${userId}`;
  const cached = cache.get<number>(key);
  if (cached !== undefined) return cached;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tokenVersion: true },
  });
  if (!user) return null;

  cache.set(key, user.tokenVersion, TOKEN_VERSION_TTL_S);
  return user.tokenVersion;
}

export function invalidateTokenVersionCache(userId: string): void {
  cache.del(`token_version_${userId}`);
}

/**
 * Every protected route runs this first. It expects `Authorization: Bearer <token>`, verifies it,
 * and stamps `req.userId` — so a controller never has to think about tokens, only `req.userId`.
 *
 * Deliberately a sync function wrapping an async body: Express 4 does not catch rejections from
 * an async middleware, so throwing out of one would surface as an unhandled rejection rather
 * than a 401.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  void (async () => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new AppError(401, "Missing or invalid Authorization header");
    }

    let payload;
    try {
      payload = verifyToken(header.slice("Bearer ".length));
    } catch {
      throw new AppError(401, "Invalid or expired token");
    }

    // A valid signature is not sufficient — a token issued before a password change must stop
    // working, and a token for a deleted user must not resolve.
    const version = await currentTokenVersion(payload.userId);
    if (version === null || version !== payload.tv) {
      throw new AppError(401, "Session has expired, please sign in again");
    }

    req.userId = payload.userId;
    req.tokenVersion = payload.tv;
  })().then(() => next(), next);
}

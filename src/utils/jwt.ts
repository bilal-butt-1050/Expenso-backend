import jwt from "jsonwebtoken";
import { env } from "../config/env";

export interface JwtPayload {
  userId: string;
  /**
   * Snapshot of `User.tokenVersion` at issue time. `requireAuth` rejects the token when the
   * stored version has moved on, so changing a password actually ends other sessions — a
   * 30-day token used to outlive the password it was issued under.
   */
  tv: number;
}

export function signToken(payload: JwtPayload): string {
  const options: jwt.SignOptions = { expiresIn: env.jwtExpiresIn as jwt.SignOptions["expiresIn"] };
  return jwt.sign(payload, env.jwtSecret, options);
}

export function verifyToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] }) as Partial<JwtPayload>;
  if (!decoded?.userId) {
    throw new Error("Malformed token payload");
  }
  // Tokens issued before tokenVersion existed carry no `tv`; treat them as version 0 so
  // existing sessions survive this deploy rather than everyone being logged out.
  return { userId: decoded.userId, tv: decoded.tv ?? 0 };
}

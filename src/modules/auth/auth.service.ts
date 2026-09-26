import { prisma } from "../../lib/prisma";
import { hashPassword, comparePassword } from "../../utils/password";
import { signToken } from "../../utils/jwt";
import { AppError } from "../../utils/asyncHandler";
import { consumeOtp } from "./otp.service";
import { OAuth2Client } from "google-auth-library";
import { env } from "../../config/env";
import { DEFAULT_TIMEZONE } from "../../utils/date";
import { invalidateTokenVersionCache } from "../../middleware/auth";

// Seeded once per new user with the FinTech design system palette — every one of
// these can be renamed, recolored, or deleted afterwards.
export const DEFAULT_CATEGORIES = [
  { name: "Housing", icon: "home", color: "#3B82F6" },
  { name: "Commute", icon: "bus", color: "#10B981" },
  { name: "Food", icon: "food", color: "#F59E0B" },
  { name: "Shopping", icon: "shopping", color: "#8B5CF6" },
  { name: "Entertainment", icon: "movie", color: "#EC4899" },
  { name: "Bills", icon: "file-document", color: "#0EA5E9" },
  { name: "Health", icon: "heart-pulse", color: "#EF4444" },
  { name: "Education", icon: "school", color: "#14B8A6" },
  { name: "Family", icon: "account-group", color: "#84CC16" },
  { name: "Subscriptions", icon: "refresh", color: "#6366F1" },
  { name: "Personal Care", icon: "face-man-shimmer", color: "#F43F5E" },
  { name: "Travel", icon: "airplane", color: "#06B6D4" },
  { name: "Gifts", icon: "gift", color: "#D946EF" },
  { name: "Other", icon: "shape-outline", color: "#9CA3AF" },
];

const googleClient = new OAuth2Client(env.googleClientIdWeb || "dummy-client-id");

export async function registerUser(
  email: string,
  password: string,
  name: string,
  otp?: string
) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppError(409, "An account with that email already exists");
  }

  // Previously verification was skipped entirely whenever the client simply omitted `otp`, so
  // any address could be registered with no proof of ownership. Now a supplied code is *always*
  // checked, and whether one is mandatory is an explicit deployment decision rather than an
  // accident of what the client happened to send.
  if (env.requireEmailVerification && !otp) {
    throw new AppError(400, "Enter the 6-digit code sent to your email");
  }
  // A consumed code is proof the person signing up owns this address (D-22).
  let emailVerifiedAt: Date | null = null;
  if (otp) {
    await consumeOtp(email, otp);
    emailVerifiedAt = new Date();
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name,
      emailVerifiedAt,
      categories: { create: DEFAULT_CATEGORIES.map((c) => ({ ...c, isDefault: true })) },
    },
  });

  const token = signToken({ userId: user.id, tv: user.tokenVersion });
  return { token, user: toPublicUser(user) };
}

export async function loginUser(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new AppError(401, "Invalid email or password");
  }

  if (!user.passwordHash) {
    throw new AppError(401, "Invalid email or password");
  }

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) {
    throw new AppError(401, "Invalid email or password");
  }

  const token = signToken({ userId: user.id, tv: user.tokenVersion });
  return { token, user: toPublicUser(user) };
}

/**
 * Why a Google token was rejected, from the error's leading text only. google-auth-library's
 * messages can embed the decoded token payload, so the message itself is never logged.
 */
function classifyGoogleTokenError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  // Google's signing keys couldn't be fetched: an outage or a network problem, not a bad token.
  if (/^Failed to retrieve verification certificates/i.test(message)) return "certs";
  if (/recipient|audience/i.test(message)) return "audience";
  if (/too late|expired/i.test(message)) return "expired";
  if (/signature|pem|certificate/i.test(message)) return "signature";
  return "other";
}

/**
 * Whether Google's "verified" means the Google account owns this address *now* (threat S2): a
 * Gmail address, or a Workspace account whose domain (`hd`) is the address's domain. For any other
 * address, Google only checked it once, when the Google account was created, and the mailbox may
 * since have changed hands. So it can't override a local account.
 */
function googleIsAuthoritative(email: string, hostedDomain: string | undefined): boolean {
  if (email.endsWith("@gmail.com") || email.endsWith("@googlemail.com")) return true;
  return Boolean(hostedDomain) && email.endsWith(`@${hostedDomain!.toLowerCase()}`);
}

/**
 * Google sign-in (ARCH N2, D-19, D-22, D-36, D-40).
 *
 * It used to link a Google sign-in to *any* account with the same email and hand back a session.
 * Someone who had registered a victim's address with a password therefore kept a working password
 * on the account the victim then used. Now:
 * - a user is found by Google's stable id first, and by email only when Google is authoritative
 *   for that address;
 * - an account that never proved it owns its email loses its password (and every other session)
 *   the moment Google proves ownership.
 */
/**
 * Verifies a Google ID token against our client ids and returns its claims. Throws 503 when Google
 * sign-in isn't configured or Google's keys can't be fetched, and 401 for any bad token.
 */
async function verifyGoogleIdToken(idToken: string) {
  const audience = [
    env.googleClientIdWeb || "",
    env.googleClientIdIos || "",
    env.googleClientIdAndroid || "",
  ].filter(Boolean);

  // With no configured client ids the audience list is empty, which disables audience checking
  // and would accept a Google token minted for any application at all.
  if (audience.length === 0) {
    throw new AppError(503, "Google sign-in is not configured");
  }

  let ticket;
  try {
    ticket = await googleClient.verifyIdToken({ idToken, audience });
  } catch (error) {
    const reason = classifyGoogleTokenError(error);
    if (reason === "certs") {
      console.error("[auth] google sign-in unavailable: couldn't fetch Google's certificates");
      throw new AppError(503, "Google sign-in is temporarily unavailable. Please try again later.");
    }
    console.warn(`[auth] google token rejected: ${reason}`);
    throw new AppError(401, "Invalid Google token");
  }

  const payload = ticket.getPayload();
  if (!payload || !payload.sub) {
    throw new AppError(401, "Invalid Google token");
  }
  return payload;
}

export async function loginWithGoogle(idToken: string) {
  const payload = await verifyGoogleIdToken(idToken);
  if (!payload.email) {
    throw new AppError(401, "Invalid Google token");
  }

  // Without this, an unverified Google account bearing someone else's address could claim theirs.
  if (payload.email_verified !== true) {
    throw new AppError(403, "Your Google email address is not verified");
  }

  const email = payload.email.toLowerCase();
  const { sub: googleId, name, picture, hd } = payload;
  const now = new Date();

  // 1. By Google's stable id. The email isn't changed even if Google's has.
  const bySub = await prisma.user.findUnique({ where: { googleId } });
  if (bySub) {
    // Google proves ownership of the *stored* address only if it's the same address it just
    // verified, and one it's authoritative for. An account linked by the old unconditional code to,
    // say, victim@corp.com proves nothing: clearing its password there would hand the account to
    // whoever holds that Google login (security review of T3.8). Such rows are left for review.
    const proves = !bySub.emailVerifiedAt && bySub.email === email && googleIsAuthoritative(email, hd);
    const reclaim = proves && Boolean(bySub.passwordHash);
    const user = await prisma.user.update({
      where: { id: bySub.id },
      data: {
        avatarUrl: picture || bySub.avatarUrl,
        // D-40: linked before this rule existed, never proved ownership, and has a password, which
        // may not be the owner's. Google now proves ownership, so the password goes, and with it
        // every other session.
        ...(reclaim ? { passwordHash: null, tokenVersion: { increment: 1 } } : {}),
        ...(proves ? { emailVerifiedAt: now } : {}),
      },
    });
    if (reclaim) invalidateTokenVersionCache(user.id);
    return { token: signToken({ userId: user.id, tv: user.tokenVersion }), user: toPublicUser(user) };
  }

  // 2. By email.
  const byEmail = await prisma.user.findUnique({ where: { email } });

  if (!byEmail) {
    const user = await prisma.user.create({
      data: {
        email,
        googleId,
        name,
        avatarUrl: picture,
        emailVerifiedAt: now,
        categories: { create: DEFAULT_CATEGORIES.map((c) => ({ ...c, isDefault: true })) },
      },
    });
    return { token: signToken({ userId: user.id, tv: user.tokenVersion }), user: toPublicUser(user) };
  }

  if (byEmail.googleId) {
    throw new AppError(409, "This email is linked to a different Google account.");
  }
  if (!googleIsAuthoritative(email, hd)) {
    throw new AppError(409, "An account with this email already exists. Sign in with your password.");
  }

  const reclaim = !byEmail.emailVerifiedAt && Boolean(byEmail.passwordHash);
  // Conditional on the row still being unlinked, with the same password we just read: a concurrent
  // link, or a password change racing this reclaim, makes this match nothing instead of overwriting.
  const linked = await prisma.user.updateMany({
    where: { id: byEmail.id, googleId: null, passwordHash: byEmail.passwordHash },
    data: {
      googleId,
      avatarUrl: picture || byEmail.avatarUrl,
      // D-19: never proved ownership, but has a password, which may not be the owner's. One update,
      // so there's no moment where the account is linked and the old password still works.
      ...(reclaim ? { passwordHash: null, tokenVersion: { increment: 1 } } : {}),
      ...(!byEmail.emailVerifiedAt ? { emailVerifiedAt: now } : {}),
    },
  });
  if (linked.count !== 1) {
    throw new AppError(409, "This account changed while signing in. Please try again.");
  }
  if (reclaim) invalidateTokenVersionCache(byEmail.id);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: byEmail.id } });
  return { token: signToken({ userId: user.id, tv: user.tokenVersion }), user: toPublicUser(user) };
}

export async function getUserById(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppError(404, "User not found");
  }
  return toPublicUser(user);
}

export async function updateUserProfile(
  userId: string,
  data: { name?: string; currency?: string; timezone?: string; avatarUrl?: string | null }
) {
  const user = await prisma.user.update({
    where: { id: userId },
    data,
  });
  return toPublicUser(user);
}

/** How recently a Google ID token must have been issued to prove the user is present. */
const GOOGLE_PROOF_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Changes the password, or sets the first one on a Google-only account.
 *
 * Changing needs the current password. Setting the first one needs fresh proof from Google (threat
 * model M4): an ID token for this account's Google id, issued in the last few minutes. Without it,
 * a stolen session alone could add a password and keep the account after that session ends.
 *
 * Returns a new session token: the change ends every other session, including the one that asked.
 */
export async function changePassword(
  userId: string,
  tokenVersion: number,
  currentPassword?: string,
  newPassword?: string,
  googleIdToken?: string
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppError(404, "User not found");
  }
  // A session ended by a Google reclaim or an earlier change gets no further (the conditional write
  // below catches the same thing racing this request).
  if (user.tokenVersion !== tokenVersion) {
    throw new AppError(401, "Session has expired, please sign in again");
  }

  if (user.passwordHash) {
    if (!currentPassword) {
      throw new AppError(400, "Current password is required");
    }
    const isValid = await comparePassword(currentPassword, user.passwordHash);
    if (!isValid) {
      throw new AppError(400, "Incorrect current password");
    }
  } else {
    if (!user.googleId) {
      throw new AppError(400, "This account can't set a password");
    }
    if (!googleIdToken) {
      throw new AppError(400, "Confirm with Google to set a password");
    }
    // A bad token here is a 400, never a 401: the app ends the session on any 401.
    const payload = await verifyGoogleIdToken(googleIdToken).catch((error) => {
      if (error instanceof AppError && error.statusCode === 401) {
        throw new AppError(400, "Google couldn't confirm it's you. Please try again.");
      }
      throw error;
    });
    if (payload.sub !== user.googleId) {
      throw new AppError(403, "That Google account isn't the one linked to this account");
    }
    if (!payload.iat || Date.now() - payload.iat * 1000 > GOOGLE_PROOF_MAX_AGE_MS) {
      throw new AppError(400, "Google confirmation expired. Please try again.");
    }
  }

  if (!newPassword || newPassword.length < 8) {
    throw new AppError(400, "New password must be at least 8 characters");
  }

  const newHash = await hashPassword(newPassword);

  // Bumping tokenVersion invalidates every token issued under the old password. Without this a
  // leaked 30-day JWT kept working after the user changed their password to lock someone out.
  //
  // Only while this session is still current, and the password is still the one checked above. A
  // Google sign-in can clear a squatter's password and end their sessions between the check and
  // this write; an unconditional write would then give the squatter a fresh, permanent password.
  const updated = await prisma.user.updateMany({
    where: { id: userId, tokenVersion, passwordHash: user.passwordHash },
    data: { passwordHash: newHash, tokenVersion: { increment: 1 } },
  });
  if (updated.count !== 1) {
    throw new AppError(401, "Session has expired, please sign in again");
  }
  invalidateTokenVersionCache(userId);
  return { token: signToken({ userId, tv: tokenVersion + 1 }) };
}

// Never leak the password hash back to a client.
function toPublicUser(user: {
  id: string;
  email: string;
  name: string | null;
  currency: string;
  timezone?: string;
  avatarUrl?: string | null;
  createdAt?: Date;
  // Required, so every caller passes the full row: a missing field would read as "no password".
  passwordHash: string | null;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    currency: user.currency,
    timezone: user.timezone ?? DEFAULT_TIMEZONE,
    avatarUrl: user.avatarUrl ?? null,
    // Lets the app tell a new account from an existing one on a new device (e.g. whether to show
    // the first-run tour). Additive: older app builds ignore it.
    createdAt: user.createdAt?.toISOString() ?? null,
    // Whether Settings offers "Change password" (needs the current one) or "Set a password".
    hasPassword: user.passwordHash !== null,
  };
}

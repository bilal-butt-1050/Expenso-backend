import crypto from "crypto";
import { prisma } from "../../lib/prisma";
import { cache } from "../../lib/cache";
import { hashPassword, comparePassword } from "../../utils/password";
import { signToken } from "../../utils/jwt";
import { AppError } from "../../utils/asyncHandler";
import { sendOtpEmail } from "./email.service";
import { OAuth2Client } from "google-auth-library";
import { env } from "../../config/env";

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

/** Wrong codes tolerated before the OTP is burned and must be re-requested. */
const OTP_MAX_ATTEMPTS = 5;
/** Minimum gap between resend requests for the same address. */
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_ATTEMPT_TTL_S = 15 * 60;

const attemptKey = (email: string) => `otp_attempts_${email}`;
const cooldownKey = (email: string) => `otp_cooldown_${email}`;

export async function generateAndSendOtp(email: string) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppError(409, "An account with that email already exists");
  }

  // Per-address cooldown. The global IP limiter does not stop someone spraying one victim's
  // inbox from rotating addresses, and it does not stop a client retry loop.
  const lastSentAt = cache.get<number>(cooldownKey(email));
  if (lastSentAt && Date.now() - lastSentAt < OTP_RESEND_COOLDOWN_MS) {
    const waitSeconds = Math.ceil((OTP_RESEND_COOLDOWN_MS - (Date.now() - lastSentAt)) / 1000);
    throw new AppError(429, `Please wait ${waitSeconds}s before requesting another code`);
  }

  // Cryptographically secure 6-digit OTP
  const otp = crypto.randomInt(100000, 1000000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await prisma.otpVerification.upsert({
    where: { email },
    create: { email, otp, expiresAt },
    update: { otp, expiresAt },
  });

  await sendOtpEmail(email, otp);

  cache.set(cooldownKey(email), Date.now(), OTP_RESEND_COOLDOWN_MS / 1000);
  cache.del(attemptKey(email));
}

/**
 * Verifies a signup code, consuming it on success.
 *
 * A 6-digit code is only 10^6 wide, so unlimited guesses are a real attack — the IP rate limiter
 * alone permits 20 tries per window and an attacker can rotate IPs. Wrong guesses are counted per
 * address and the code is destroyed once the budget is spent, forcing a fresh send.
 *
 * Compared in constant time so response latency does not leak how much of the code matched.
 */
async function consumeOtp(email: string, otp: string): Promise<void> {
  const verification = await prisma.otpVerification.findUnique({ where: { email } });
  if (!verification) {
    throw new AppError(400, "Request a verification code first");
  }

  if (verification.expiresAt < new Date()) {
    await prisma.otpVerification.delete({ where: { email } }).catch(() => {});
    cache.del(attemptKey(email));
    throw new AppError(400, "Verification code has expired. Request a new one.");
  }

  const expected = Buffer.from(verification.otp);
  const supplied = Buffer.from(otp);
  const matches =
    expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);

  if (!matches) {
    const attempts = (cache.get<number>(attemptKey(email)) ?? 0) + 1;

    if (attempts >= OTP_MAX_ATTEMPTS) {
      await prisma.otpVerification.delete({ where: { email } }).catch(() => {});
      cache.del(attemptKey(email));
      throw new AppError(429, "Too many incorrect codes. Request a new one.");
    }

    cache.set(attemptKey(email), attempts, OTP_ATTEMPT_TTL_S);
    throw new AppError(400, "Invalid verification code");
  }

  await prisma.otpVerification.delete({ where: { email } }).catch(() => {});
  cache.del(attemptKey(email));
}

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
  if (env.requireEmailVerification) {
    if (!otp) {
      throw new AppError(400, "Enter the 6-digit code sent to your email");
    }
    await consumeOtp(email, otp);
  } else if (otp) {
    await consumeOtp(email, otp);
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name,
      categories: { create: DEFAULT_CATEGORIES.map((c) => ({ ...c, isDefault: true })) },
    },
  });

  const token = signToken({ userId: user.id });
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

  const token = signToken({ userId: user.id });
  return { token, user: toPublicUser(user) };
}

export async function loginWithGoogle(idToken: string) {
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

  const ticket = await googleClient.verifyIdToken({ idToken, audience });

  const payload = ticket.getPayload();
  if (!payload || !payload.email) {
    throw new AppError(400, "Invalid Google token");
  }

  // Without this, an unverified Google account bearing someone else's address would be linked
  // onto their existing password account below, handing over the session.
  if (payload.email_verified !== true) {
    throw new AppError(403, "Your Google email address is not verified");
  }

  const { email, sub: googleId, name, picture } = payload;

  let user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    // Register
    user = await prisma.user.create({
      data: {
        email,
        googleId,
        name,
        avatarUrl: picture,
        categories: { create: DEFAULT_CATEGORIES.map((c) => ({ ...c, isDefault: true })) },
      },
    });
  } else {
    // Update googleId and avatarUrl if provided
    user = await prisma.user.update({
      where: { email },
      data: {
        googleId: user.googleId || googleId,
        avatarUrl: picture || user.avatarUrl,
      },
    });
  }

  const token = signToken({ userId: user.id });
  return { token, user: toPublicUser(user) };
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
  data: { name?: string; currency?: string; avatarUrl?: string | null }
) {
  const user = await prisma.user.update({
    where: { id: userId },
    data,
  });
  return toPublicUser(user);
}

export async function changePassword(userId: string, currentPassword?: string, newPassword?: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppError(404, "User not found");
  }

  // If user signed up with Google, they might not have a password hash
  if (user.passwordHash) {
    if (!currentPassword) {
      throw new AppError(400, "Current password is required");
    }
    const isValid = await comparePassword(currentPassword, user.passwordHash);
    if (!isValid) {
      throw new AppError(400, "Incorrect current password");
    }
  }

  if (!newPassword || newPassword.length < 8) {
    throw new AppError(400, "New password must be at least 8 characters");
  }

  const newHash = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: newHash },
  });
}

// Never leak the password hash back to a client.
function toPublicUser(user: {
  id: string;
  email: string;
  name: string | null;
  currency: string;
  avatarUrl?: string | null;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    currency: user.currency,
    avatarUrl: user.avatarUrl ?? null,
  };
}

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

  const token = signToken({ userId: user.id, tv: user.tokenVersion });
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
  data: { name?: string; currency?: string; timezone?: string; avatarUrl?: string | null }
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

  // Bumping tokenVersion invalidates every token issued under the old password. Without this a
  // leaked 30-day JWT kept working after the user changed their password to lock someone out.
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: newHash, tokenVersion: { increment: 1 } },
  });
  invalidateTokenVersionCache(userId);
}

// Never leak the password hash back to a client.
function toPublicUser(user: {
  id: string;
  email: string;
  name: string | null;
  currency: string;
  timezone?: string;
  avatarUrl?: string | null;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    currency: user.currency,
    timezone: user.timezone ?? DEFAULT_TIMEZONE,
    avatarUrl: user.avatarUrl ?? null,
  };
}

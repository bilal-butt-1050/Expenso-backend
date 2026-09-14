import { prisma } from "../../lib/prisma";
import { hashPassword, comparePassword } from "../../utils/password";
import { signToken } from "../../utils/jwt";
import { AppError } from "../../utils/asyncHandler";
import { sendOtpEmail } from "./email.service";
import { OAuth2Client } from "google-auth-library";

// Seeded once per new user so the app is immediately usable — every one of
// these can be renamed, recolored, or deleted afterwards, and the user can
// add as many of their own on top.
const DEFAULT_CATEGORIES = [
  { name: "Housing", icon: "home", color: "#00B0FF" },
  { name: "Commute", icon: "bus", color: "#00E676" },
  { name: "Food", icon: "food", color: "#FFB300" },
  { name: "Shopping", icon: "shopping", color: "#7C4DFF" },
  { name: "Entertainment", icon: "movie", color: "#FF4081" },
  { name: "Bills", icon: "file-document", color: "#40C4FF" },
  { name: "Health", icon: "heart-pulse", color: "#FF5252" },
  { name: "Education", icon: "school", color: "#69F0AE" },
  { name: "Family", icon: "account-group", color: "#FFD740" },
  { name: "Subscriptions", icon: "refresh", color: "#B388FF" },
  { name: "Personal Care", icon: "face-man-shimmer", color: "#F50057" },
  { name: "Travel", icon: "airplane", color: "#00E5FF" },
  { name: "Gifts", icon: "gift", color: "#E040FB" },
  { name: "Other", icon: "shape-outline", color: "#9E9E9E" },
];

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID_WEB || "dummy-client-id");

export async function generateAndSendOtp(email: string) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppError(409, "An account with that email already exists");
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await prisma.otpVerification.upsert({
    where: { email },
    create: { email, otp, expiresAt },
    update: { otp, expiresAt },
  });

  await sendOtpEmail(email, otp);
}

export async function registerUser(email: string, password: string, otp: string, name?: string) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppError(409, "An account with that email already exists");
  }

  const verification = await prisma.otpVerification.findUnique({ where: { email } });
  if (!verification || verification.otp !== otp) {
    throw new AppError(400, "Invalid verification code");
  }
  if (verification.expiresAt < new Date()) {
    throw new AppError(400, "Verification code has expired");
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

  await prisma.otpVerification.delete({ where: { email } });

  const token = signToken({ userId: user.id });
  return { token, user: toPublicUser(user) };
}

export async function loginUser(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new AppError(401, "Invalid email or password");
  }

  if (!user.passwordHash) {
    throw new AppError(401, "Please sign in with Google");
  }

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) {
    throw new AppError(401, "Invalid email or password");
  }

  const token = signToken({ userId: user.id });
  return { token, user: toPublicUser(user) };
}

export async function loginWithGoogle(idToken: string) {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: [
      process.env.GOOGLE_CLIENT_ID_WEB || "",
      process.env.GOOGLE_CLIENT_ID_IOS || "",
      process.env.GOOGLE_CLIENT_ID_ANDROID || "",
    ].filter(Boolean),
  });

  const payload = ticket.getPayload();
  if (!payload || !payload.email) {
    throw new AppError(400, "Invalid Google token");
  }

  const { email, sub: googleId, name } = payload;

  let user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    // Register
    user = await prisma.user.create({
      data: {
        email,
        googleId,
        name,
        categories: { create: DEFAULT_CATEGORIES.map((c) => ({ ...c, isDefault: true })) },
      },
    });
  } else if (!user.googleId) {
    // Link existing email/password account to Google
    user = await prisma.user.update({
      where: { email },
      data: { googleId },
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
  data: { name?: string; currency?: string }
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
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    currency: user.currency,
  };
}

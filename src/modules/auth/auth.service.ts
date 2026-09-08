import { prisma } from "../../lib/prisma";
import { hashPassword, comparePassword } from "../../utils/password";
import { signToken } from "../../utils/jwt";
import { AppError } from "../../utils/asyncHandler";

// Seeded once per new user so the app is immediately usable — every one of
// these can be renamed, recolored, or deleted afterwards, and the user can
// add as many of their own on top.
const DEFAULT_CATEGORIES = [
  { name: "Commute", icon: "bus", color: "#00E676" },
  { name: "Food", icon: "food", color: "#FFB300" },
  { name: "Shopping", icon: "shopping", color: "#7C4DFF" },
  { name: "Entertainment", icon: "movie", color: "#FF4081" },
  { name: "Bills", icon: "file-document", color: "#40C4FF" },
  { name: "Health", icon: "heart-pulse", color: "#FF5252" },
  { name: "Education", icon: "school", color: "#69F0AE" },
  { name: "Family", icon: "account-group", color: "#FFD740" },
  { name: "Subscriptions", icon: "refresh", color: "#B388FF" },
  { name: "Other", icon: "shape-outline", color: "#9E9E9E" },
];

export async function registerUser(email: string, password: string, name?: string) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppError(409, "An account with that email already exists");
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

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) {
    throw new AppError(401, "Invalid email or password");
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
  data: { name?: string; savingsGoal?: number; currency?: string }
) {
  const user = await prisma.user.update({
    where: { id: userId },
    data,
  });
  return toPublicUser(user);
}

// Never leak the password hash back to a client.
function toPublicUser(user: {
  id: string;
  email: string;
  name: string | null;
  currency: string;
  savingsGoal: number;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    currency: user.currency,
    savingsGoal: user.savingsGoal,
  };
}

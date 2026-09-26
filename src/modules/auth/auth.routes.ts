import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import { isValidTimeZone } from "../../utils/date";
import { registerUser, loginUser, getUserById, updateUserProfile, loginWithGoogle, changePassword } from "./auth.service";
import { generateAndSendOtp } from "./otp.service";

export const authRouter = Router();

const sendOtpSchema = z.object({
  email: z.string().trim().toLowerCase().email("Please provide a valid email address"),
});

/**
 * `otp` stays optional at the schema level, but its *meaning* changed: a supplied code is now
 * always verified by the service, and whether one is mandatory is governed by
 * `REQUIRE_EMAIL_VERIFICATION`. Previously an omitted field silently skipped verification.
 * The empty-string escape hatch is gone — a blank code is now a validation error, not a bypass.
 */
const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email("Please provide a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().trim().min(1, "Name is required"),
  otp: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code sent to your email").optional(),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Please provide a valid email address"),
  password: z.string().min(1, "Password is required"),
});

const googleSchema = z.object({
  idToken: z.string().min(1),
});

/**
 * Currencies the client can actually render. `formatCurrency` on mobile maps PKR to "Rs" and
 * otherwise prints the raw code, so an arbitrary string here becomes a broken label on every
 * amount in the app. Changing this is a display setting only — no amounts are converted.
 */
const SUPPORTED_CURRENCIES = ["PKR", "USD", "EUR", "GBP", "AED", "SAR", "INR", "CAD", "AUD"] as const;

const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  currency: z.enum(SUPPORTED_CURRENCIES).optional(),
  // Month buckets are derived in this zone, so a bad value would silently misfile every
  // transaction the user records from then on.
  timezone: z.string().refine(isValidTimeZone, "Unknown time zone").optional(),
  avatarUrl: z.string().url().max(2048).nullable().optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8, "New password must be at least 8 characters").max(200),
  // Proof for setting the first password on a Google-only account.
  googleIdToken: z.string().min(1).max(4096).optional(),
});

authRouter.post(
  "/send-otp",
  asyncHandler(async (req, res) => {
    const body = sendOtpSchema.parse(req.body);
    // Counted per IP for the send cap. Until `trust proxy` is set (T3.7), this is the proxy's
    // address, so the per-IP cap is effectively global. Acceptable with one active user.
    await generateAndSendOtp(body.email, req.ip ?? "unknown");
    res.json({ message: "OTP sent" });
  })
);

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const result = await registerUser(body.email, body.password, body.name, body.otp);
    res.status(201).json(result);
  })
);


authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const result = await loginUser(body.email, body.password);
    res.json(result);
  })
);

authRouter.post(
  "/google",
  asyncHandler(async (req, res) => {
    const body = googleSchema.parse(req.body);
    const result = await loginWithGoogle(body.idToken);
    res.json(result);
  })
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await getUserById(req.userId!);
    res.json(user);
  })
);

authRouter.patch(
  "/profile",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = updateProfileSchema.parse(req.body);
    const user = await updateUserProfile(req.userId!, body);
    res.json(user);
  })
);

authRouter.patch(
  "/password",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = changePasswordSchema.parse(req.body);
    const { token } = await changePassword(
      req.userId!,
      req.tokenVersion ?? 0,
      body.currentPassword,
      body.newPassword,
      body.googleIdToken
    );
    res.json({ message: "Password updated successfully", token });
  })
);

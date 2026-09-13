import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import { registerUser, loginUser, getUserById, updateUserProfile, generateAndSendOtp, loginWithGoogle } from "./auth.service";

export const authRouter = Router();

const sendOtpSchema = z.object({
  email: z.string().email(),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  otp: z.string().length(6, "OTP must be exactly 6 digits"),
  name: z.string().min(1).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const googleSchema = z.object({
  idToken: z.string().min(1),
});

const updateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  savingsGoal: z.number().min(0).max(100).optional(),
  currency: z.string().min(1).optional(),
});

authRouter.post(
  "/send-otp",
  asyncHandler(async (req, res) => {
    const body = sendOtpSchema.parse(req.body);
    await generateAndSendOtp(body.email);
    res.json({ message: "OTP sent" });
  })
);

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const result = await registerUser(body.email, body.password, body.otp, body.name);
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

import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { AppError } from "../../utils/asyncHandler";
import { sendOtpEmail } from "./email.service";

/**
 * Signup codes (ARCH N3, threats S1 and S4). All state lives in Postgres, so a restart or deploy
 * can't reset an attempt counter or a send cap, as the in-memory counters it replaces could.
 */

const OTP_TTL_MS = 10 * 60 * 1000;
/** Wrong codes allowed before the code is burned and must be re-requested. */
export const OTP_MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const PER_EMAIL_PER_DAY = 5;
const PER_IP_PER_HOUR = 5;
/** Stays well under Brevo's free 300/day, so a burst can't exhaust the account (D-42). */
const GLOBAL_PER_DAY = 150;
const SEND_LOG_RETENTION_MS = 48 * 60 * 60 * 1000;
/** Serialises sends so concurrent requests can't both slip under a cap. Any fixed number works. */
const SEND_LOCK_KEY = 747_001;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * The OTP columns are `timestamp without time zone` holding UTC, and `now()` or a bound
 * `timestamptz` would be converted through the session's time zone, which is PKT on a local
 * Windows install. So every raw-SQL comparison binds the UTC wall-clock time as text and casts it.
 */
export const utc = (date: Date) => Prisma.sql`${date.toISOString().replace("Z", "")}::timestamp`;

/** HMAC-SHA256 of email + code, keyed from JWT_SECRET, so a database read can't reveal a live code. */
function hashOtp(email: string, otp: string): string {
  const key = Buffer.from(crypto.hkdfSync("sha256", env.jwtSecret, "", "expenso-otp-v1", 32));
  return crypto.createHmac("sha256", key).update(`${email}:${otp}`).digest("hex");
}

/** The sign-up code of the password flow (1.0 apps): refused for an address that has an account. */
export async function generateAndSendOtp(email: string, ip: string): Promise<void> {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppError(409, "An account with that email already exists");
  }
  await issueCode(email, ip);
}

/**
 * A sign-in code for passwordless email (D-66): sent whether or not the address has an account,
 * so the answer can't be used to find out which addresses are registered.
 */
export async function sendSignInCode(email: string, ip: string): Promise<void> {
  await issueCode(email, ip);
}

async function issueCode(email: string, ip: string): Promise<void> {
  const otp = crypto.randomInt(100000, 1000000).toString();
  const now = new Date();

  // Caps, the log row and the code are one transaction behind a lock: concurrent sends are
  // counted one at a time. The send itself happens after, outside the transaction, and a failed
  // send still counts, so a retry loop can't drain the Brevo quota.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${SEND_LOCK_KEY})`);
    await tx.otpSendLog.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - SEND_LOG_RETENTION_MS) } } });

    const last = await tx.otpSendLog.findFirst({ where: { email }, orderBy: { createdAt: "desc" } });
    if (last && now.getTime() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((RESEND_COOLDOWN_MS - (now.getTime() - last.createdAt.getTime())) / 1000);
      throw new AppError(429, `Please wait ${wait}s before requesting another code`);
    }

    const sentToEmail = await tx.otpSendLog.count({
      where: { email, createdAt: { gt: new Date(now.getTime() - DAY) } },
    });
    if (sentToEmail >= PER_EMAIL_PER_DAY) {
      throw new AppError(429, "Too many codes requested for this email. Try again tomorrow.");
    }

    const sentFromIp = await tx.otpSendLog.count({
      where: { ip, createdAt: { gt: new Date(now.getTime() - HOUR) } },
    });
    if (sentFromIp >= PER_IP_PER_HOUR) {
      throw new AppError(429, "Too many codes requested. Please try again later.");
    }

    const sentToday = await tx.otpSendLog.count({ where: { createdAt: { gt: new Date(now.getTime() - DAY) } } });
    if (sentToday >= GLOBAL_PER_DAY) {
      throw new AppError(503, "We can't send codes right now. Please try again later.");
    }

    await tx.otpSendLog.create({ data: { email, ip, createdAt: now } });
    const code = { otpHash: hashOtp(email, otp), attempts: 0, expiresAt: new Date(now.getTime() + OTP_TTL_MS) };
    await tx.otpVerification.upsert({ where: { email }, create: { email, ...code }, update: code });
  }, { timeout: 10_000 });

  await sendOtpEmail(email, otp);
}

/**
 * Checks a signup code and consumes it on success (threat S1, AUT-024).
 *
 * The attempt is counted *before* the code is compared, in one atomic UPDATE. However many guesses
 * arrive at once, at most five are ever evaluated. The comparison is constant-time, and consuming
 * is a delete that must remove exactly one row, so two requests can't both spend the same code.
 */
export async function consumeOtp(email: string, otp: string): Promise<void> {
  const now = new Date();

  const counted = await prisma.$queryRaw<{ otpHash: string; attempts: number }[]>(Prisma.sql`
    UPDATE "otp_verifications"
    SET "attempts" = "attempts" + 1
    WHERE "email" = ${email} AND "attempts" < ${OTP_MAX_ATTEMPTS} AND "expiresAt" > ${utc(now)}
    RETURNING "otpHash", "attempts"
  `);

  if (counted.length === 0) {
    const pending = await prisma.otpVerification.findUnique({ where: { email } });
    if (!pending) {
      throw new AppError(400, "Request a verification code first");
    }
    if (pending.expiresAt.getTime() <= now.getTime()) {
      // Only this expired code: a resend racing this request may have just stored a fresh one.
      await prisma.otpVerification.deleteMany({ where: { email, otpHash: pending.otpHash } });
      throw new AppError(400, "Verification code has expired. Request a new one.");
    }
    throw new AppError(429, "Too many incorrect codes. Request a new one.");
  }

  const { otpHash, attempts } = counted[0];
  const expected = Buffer.from(otpHash, "hex");
  const supplied = Buffer.from(hashOtp(email, otp), "hex");
  const matches = expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);

  if (!matches) {
    if (attempts >= OTP_MAX_ATTEMPTS) {
      throw new AppError(429, "Too many incorrect codes. Request a new one.");
    }
    throw new AppError(400, "Invalid verification code");
  }

  const consumed = await prisma.otpVerification.deleteMany({ where: { email, otpHash } });
  if (consumed.count !== 1) {
    // Another request with the same code got there first.
    throw new AppError(400, "Request a verification code first");
  }
}

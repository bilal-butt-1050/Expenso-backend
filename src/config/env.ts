import dotenv from "dotenv";

dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const nodeEnv = process.env.NODE_ENV ?? "development";

/**
 * Every session token in the system is only as strong as this value. A short or placeholder
 * secret is forgeable, so refuse to boot on one in production rather than serve traffic that
 * looks authenticated but isn't.
 */
function requireJwtSecret(): string {
  const secret = required("JWT_SECRET");
  const weak = ["secret", "changeme", "jwt_secret", "your-secret-key", "dev", "test"];

  if (nodeEnv === "production") {
    if (secret.length < 32) {
      throw new Error("JWT_SECRET must be at least 32 characters in production");
    }
    if (weak.includes(secret.toLowerCase())) {
      throw new Error("JWT_SECRET is a known placeholder value — set a real secret");
    }
  } else if (secret.length < 32) {
    console.warn("[env] JWT_SECRET is shorter than 32 characters; this will be rejected in production");
  }

  return secret;
}

export const env = {
  nodeEnv,
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  directUrl: process.env.DIRECT_URL,
  jwtSecret: requireJwtSecret(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "30d",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  resendApiKey: process.env.RESEND_API_KEY,
  /**
   * Sender for verification email. Resend's shared `resend.dev` domain is testing-only and
   * returns 403 for any recipient other than the account owner, so real delivery needs a
   * verified domain here.
   */
  mailFrom: process.env.MAIL_FROM ?? "Expenso <auth@resend.dev>",
  /**
   * Whether signup must present a valid emailed code.
   *
   * Off by default, deliberately. The verification path below is fully implemented and hardened,
   * but turning it on before email can actually be delivered — and before the mobile client has a
   * code-entry step — would lock every new user out of signup. Flip this to `true` in the same
   * change that ships a verified MAIL_FROM domain and the mobile OTP screen.
   */
  requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === "true",
  googleClientIdWeb: process.env.GOOGLE_CLIENT_ID_WEB,
  googleClientIdIos: process.env.GOOGLE_CLIENT_ID_IOS,
  googleClientIdAndroid: process.env.GOOGLE_CLIENT_ID_ANDROID,
};


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

if (!process.env.BREVO_API_KEY || !process.env.MAIL_FROM_EMAIL) {
  console.warn("[env] BREVO_API_KEY or MAIL_FROM_EMAIL is not set: signup codes can't be emailed");
}

export const env = {
  nodeEnv,
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  directUrl: process.env.DIRECT_URL,
  jwtSecret: requireJwtSecret(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "30d",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  /** Brevo transactional email (D-17, D-21). Without it, OTP email is unavailable in production. */
  brevoApiKey: process.env.BREVO_API_KEY,
  /** The sender verified in Brevo. Brevo rewrites a free-mail sender to its own domain. */
  mailFromEmail: process.env.MAIL_FROM_EMAIL,
  mailFromName: process.env.MAIL_FROM_NAME ?? "Expenso",
  /**
   * Whether signup must present a valid emailed code.
   *
   * Off by default, deliberately. The verification path below is fully implemented and hardened,
   * but turning it on before email can actually be delivered — and before the mobile client has a
   * code-entry step — would lock every new user out of signup. Flip this to `true` in the same
   * change that ships working OTP email (Brevo) and the mobile OTP screen.
   */
  requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === "true",
  googleClientIdWeb: process.env.GOOGLE_CLIENT_ID_WEB,
  googleClientIdIos: process.env.GOOGLE_CLIENT_ID_IOS,
  googleClientIdAndroid: process.env.GOOGLE_CLIENT_ID_ANDROID,
};


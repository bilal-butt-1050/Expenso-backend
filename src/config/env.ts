import dotenv from "dotenv";

dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  directUrl: process.env.DIRECT_URL,
  jwtSecret: required("JWT_SECRET"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "30d",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  resendApiKey: process.env.RESEND_API_KEY,
  googleClientIdWeb: process.env.GOOGLE_CLIENT_ID_WEB,
  googleClientIdIos: process.env.GOOGLE_CLIENT_ID_IOS,
  googleClientIdAndroid: process.env.GOOGLE_CLIENT_ID_ANDROID,
};


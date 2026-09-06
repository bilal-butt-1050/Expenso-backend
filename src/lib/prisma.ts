import { PrismaClient } from "@prisma/client";

// A single shared Prisma instance. Re-using one client (instead of `new
// PrismaClient()` in every file) avoids exhausting Postgres connections,
// and the global-cache trick below stops `tsx watch` from creating a fresh
// client on every hot reload during development.
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma = global.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.__prisma = prisma;
}

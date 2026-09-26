import { execSync } from "node:child_process";
import { beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../src/lib/prisma";
import { cache } from "../src/lib/cache";

/**
 * Tests run against a real Postgres database, not mocks.
 *
 * The suite these replace imported nothing from `src/` — it exercised a parallel reimplementation
 * in `tests/lib/`, which is why 172 passing tests sat happily on top of an accounting bug that
 * invented money. Everything here drives the real services against real SQL, because the defects
 * that matter in this app live in the interaction between them.
 */

const TEST_DB = "expenso_test";

if (!process.env.DATABASE_URL?.includes(TEST_DB)) {
  throw new Error(
    `Refusing to run: DATABASE_URL must point at "${TEST_DB}". ` +
      `Set it in .env.test (copy .env.test.example). Never point it at a database you care about — ` +
      `every test truncates the whole schema.`
  );
}

beforeAll(() => {
  // Rebuild the schema from the committed migrations on every run, so the suite exercises exactly
  // what production will apply — and proves the migration chain can still build a database from
  // nothing. The first run of this harness is what revealed that it could not: `loans` and
  // `otp_verifications` had been created by `db push` and existed in no migration.
  //
  // `reset` rather than `deploy` also makes the run hermetic: a previous failure cannot leave the
  // database in a state that poisons the next one.
  execSync("npx prisma migrate reset --force --skip-seed --skip-generate", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  });
});

beforeEach(async () => {
  // Order matters only for speed; CASCADE handles the FKs.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "transactions", "loans", "budgets", "expenses", "incomes",
                   "categories", "otp_verifications", "users"
    RESTART IDENTITY CASCADE
  `);
  // The dashboard memoises per user and month; a stale entry would mask a real regression.
  cache.flushAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

-- Baseline repair: bring `loans` and `otp_verifications` into the migration history.
--
-- These two tables (and the LoanType / LoanStatus enums) exist in production, but no migration
-- ever created them — they were introduced with `prisma db push`, which mutates the live schema
-- and records nothing. The consequence is that the migration chain could not build a database
-- from scratch: applying it to an empty database failed at the unified-ledger migration with
--
--     ERROR: relation "loans" does not exist
--
-- which means no new environment, no test database, and no restore-from-migrations could work.
-- Found by the first test run against a fresh database.
--
-- Every statement here is guarded, so this is a no-op on any database that already has these
-- objects (production, and the developer databases) and a genuine create on an empty one. It is
-- dated before the ledger migration so a fresh database builds in the right order.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LoanType') THEN
        CREATE TYPE "LoanType" AS ENUM ('LENT', 'BORROWED');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LoanStatus') THEN
        CREATE TYPE "LoanStatus" AS ENUM ('PENDING', 'PARTIAL', 'SETTLED');
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "loans" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "LoanType" NOT NULL DEFAULT 'LENT',
    "personName" TEXT NOT NULL,
    -- Widened to DECIMAL(14,2) by the unified-ledger migration that follows.
    "amount" DOUBLE PRECISION NOT NULL,
    "settledAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dueDate" TIMESTAMP(3),
    "status" "LoanStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "loans_userId_status_idx" ON "loans"("userId", "status");
CREATE INDEX IF NOT EXISTS "loans_userId_type_idx" ON "loans"("userId", "type");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'loans_userId_fkey'
    ) THEN
        ALTER TABLE "loans"
            ADD CONSTRAINT "loans_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "otp_verifications" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "otp" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_verifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "otp_verifications_email_key" ON "otp_verifications"("email");

-- ---------------------------------------------------------------------------
-- The rest of the `db push` drift.
--
-- `prisma migrate diff` against a shadow database shows these changes exist in production but in
-- no migration: Google sign-in columns, the nullable password hash that OAuth users need, the
-- per-month budget key, and the removal of the abandoned income `status` and user `savingsGoal`
-- fields. All guarded, so this is a no-op where they already exist.
-- ---------------------------------------------------------------------------

-- users: OAuth support, and passwordHash becomes optional for Google-only accounts.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "googleId" TEXT;
ALTER TABLE "users" DROP COLUMN IF EXISTS "savingsGoal";
ALTER TABLE "users" ALTER COLUMN "passwordHash" DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "users_googleId_key" ON "users"("googleId");

-- budgets: keyed per month, not once per category for all time.
ALTER TABLE "budgets" ADD COLUMN IF NOT EXISTS "month" TEXT;
UPDATE "budgets" SET "month" = to_char("createdAt", 'YYYY-MM') WHERE "month" IS NULL;
ALTER TABLE "budgets" ALTER COLUMN "month" SET NOT NULL;
DROP INDEX IF EXISTS "budgets_userId_categoryId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "budgets_userId_categoryId_month_key"
    ON "budgets"("userId", "categoryId", "month");

-- incomes: the unpaid/paid state was removed when cashflows became strictly settled.
DROP INDEX IF EXISTS "incomes_userId_status_idx";
ALTER TABLE "incomes" DROP COLUMN IF EXISTS "status";
ALTER TABLE "incomes" ALTER COLUMN "paymentMethod" SET DEFAULT 'Bank Transfer';

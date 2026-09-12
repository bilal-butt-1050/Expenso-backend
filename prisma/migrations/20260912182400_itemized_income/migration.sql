-- AlterTable: Add new columns with safe defaults
ALTER TABLE "incomes" 
  ADD COLUMN "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'Salary',
  ADD COLUMN "sourceIcon" TEXT NOT NULL DEFAULT 'cash-multiple',
  ADD COLUMN "sourceColor" TEXT NOT NULL DEFAULT '#00E676',
  ADD COLUMN "description" TEXT,
  ADD COLUMN "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'Received',
  ADD COLUMN "paymentMethod" TEXT NOT NULL DEFAULT 'Bank';

-- Drop the unique constraint early so that inserting multiple incomes for the same month succeeds
DROP INDEX IF EXISTS "incomes_userId_month_key";

-- Data preservation: migrate existing salary / bonus / otherIncome
-- 1. Rows with salary > 0 become Primary Salary
UPDATE "incomes" 
SET "amount" = "salary",
    "source" = 'Salary',
    "sourceIcon" = 'briefcase-outline',
    "sourceColor" = '#00E676',
    "description" = 'Monthly Salary',
    "date" = TO_TIMESTAMP("month" || '-01', 'YYYY-MM-DD')
WHERE "salary" > 0;

-- 2. Rows where salary is 0 but bonus > 0
UPDATE "incomes"
SET "amount" = "bonus",
    "source" = 'Bonus',
    "sourceIcon" = 'gift-outline',
    "sourceColor" = '#B388FF',
    "description" = 'Bonus & Commission',
    "date" = TO_TIMESTAMP("month" || '-01', 'YYYY-MM-DD')
WHERE "salary" = 0 AND "bonus" > 0;

-- 3. Rows where salary and bonus are 0 but otherIncome > 0
UPDATE "incomes"
SET "amount" = "otherIncome",
    "source" = 'Other',
    "sourceIcon" = 'laptop',
    "sourceColor" = '#FFB300',
    "description" = 'Other Income',
    "date" = TO_TIMESTAMP("month" || '-01', 'YYYY-MM-DD')
WHERE "salary" = 0 AND "bonus" = 0 AND "otherIncome" > 0;

-- 4. Separate row for bonus if salary was also present
INSERT INTO "incomes" ("id", "userId", "month", "date", "source", "sourceIcon", "sourceColor", "description", "amount", "status", "paymentMethod", "createdAt", "updatedAt")
SELECT 
  gen_random_uuid()::text,
  "userId",
  "month",
  TO_TIMESTAMP("month" || '-01', 'YYYY-MM-DD'),
  'Bonus',
  'gift-outline',
  '#B388FF',
  'Bonus & Commission',
  "bonus",
  'Received',
  'Bank',
  "createdAt",
  "updatedAt"
FROM "incomes"
WHERE "salary" > 0 AND "bonus" > 0;

-- 5. Separate row for otherIncome if salary or bonus was also present
INSERT INTO "incomes" ("id", "userId", "month", "date", "source", "sourceIcon", "sourceColor", "description", "amount", "status", "paymentMethod", "createdAt", "updatedAt")
SELECT 
  gen_random_uuid()::text,
  "userId",
  "month",
  TO_TIMESTAMP("month" || '-01', 'YYYY-MM-DD'),
  'Other',
  'laptop',
  '#FFB300',
  'Other Income',
  "otherIncome",
  'Received',
  'Bank',
  "createdAt",
  "updatedAt"
FROM "incomes"
WHERE ("salary" > 0 OR "bonus" > 0) AND "otherIncome" > 0;

-- Drop default constraints from date, source, and amount to match Prisma schema
ALTER TABLE "incomes" ALTER COLUMN "date" DROP DEFAULT;
ALTER TABLE "incomes" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "incomes" ALTER COLUMN "amount" DROP DEFAULT;

-- Drop obsolete columns
ALTER TABLE "incomes" 
  DROP COLUMN "salary",
  DROP COLUMN "bonus",
  DROP COLUMN "otherIncome";

-- Create new indexes
CREATE INDEX "incomes_userId_month_idx" ON "incomes"("userId", "month");
CREATE INDEX "incomes_userId_status_idx" ON "incomes"("userId", "status");

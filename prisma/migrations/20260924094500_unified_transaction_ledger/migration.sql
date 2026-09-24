-- Unified transaction ledger.
--
-- Collapses `expenses` and `incomes` into one `transactions` table carrying a `kind`, so that
-- movements of money which are *not* spending or earning — lending, collecting, borrowing,
-- repaying — can finally be represented. Their absence is why lending money and collecting it
-- back invented net worth: creating a loan wrote no cashflow, but settling one wrote income.
--
-- This migration is deliberately NON-DESTRUCTIVE. `expenses` and `incomes` are read, copied, and
-- then left exactly as they are. Dropping them is a separate migration, to be run only once the
-- unified ledger has been verified against real use.

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------

CREATE TYPE "TransactionKind" AS ENUM ('SPEND', 'EARN', 'LEND_OUT', 'COLLECT', 'BORROW_IN', 'REPAY');

-- Left behind by an earlier `db push` against a model that no longer declares it.
DROP INDEX IF EXISTS "expenses_userId_status_month_idx";

-- double precision -> numeric(14,2). Lossless for any realistic amount, and stops error
-- accumulating across partial settlements.
ALTER TABLE "loans" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "settledAmount" SET DATA TYPE DECIMAL(14,2);

ALTER TABLE "budgets" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2);

ALTER TABLE "users" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Asia/Karachi',
ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "TransactionKind" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "month" TEXT NOT NULL,
    "description" TEXT,
    "paymentMethod" TEXT NOT NULL DEFAULT 'Cash',
    "categoryId" TEXT,
    "needWant" TEXT,
    "source" TEXT,
    "sourceIcon" TEXT,
    "sourceColor" TEXT,
    "loanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "transactions_userId_month_kind_idx" ON "transactions"("userId", "month", "kind");
-- Keyset pagination. Day-level dates make ties the norm, so ordering by date alone made offset
-- paging silently duplicate and drop rows.
CREATE INDEX "transactions_userId_date_id_idx" ON "transactions"("userId", "date", "id");
CREATE INDEX "transactions_userId_categoryId_idx" ON "transactions"("userId", "categoryId");
CREATE INDEX "transactions_loanId_idx" ON "transactions"("loanId");

ALTER TABLE "transactions" ADD CONSTRAINT "transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Backfill
-- ---------------------------------------------------------------------------
-- Primary keys are carried across unchanged, so identity is preserved and re-running this
-- migration would fail loudly on a PK collision rather than silently duplicating the ledger.
--
-- `month` is recomputed in the owning user's timezone rather than copied. The old code derived
-- it in UTC, so an expense logged at 2am on the 1st in PKT was filed under the previous month.

INSERT INTO "transactions" (
    "id", "userId", "kind", "amount", "date", "month", "description",
    "paymentMethod", "categoryId", "needWant", "createdAt", "updatedAt"
)
SELECT
    e."id", e."userId", 'SPEND'::"TransactionKind", e."amount"::numeric(14,2), e."date",
    to_char(e."date" AT TIME ZONE u."timezone", 'YYYY-MM'),
    e."description", e."paymentMethod", e."categoryId", e."needWant", e."createdAt", e."updatedAt"
FROM "expenses" e
JOIN "users" u ON u."id" = e."userId";

INSERT INTO "transactions" (
    "id", "userId", "kind", "amount", "date", "month", "description",
    "paymentMethod", "source", "sourceIcon", "sourceColor", "createdAt", "updatedAt"
)
SELECT
    i."id", i."userId", 'EARN'::"TransactionKind", i."amount"::numeric(14,2), i."date",
    to_char(i."date" AT TIME ZONE u."timezone", 'YYYY-MM'),
    i."description", i."paymentMethod", i."source", i."sourceIcon", i."sourceColor",
    i."createdAt", i."updatedAt"
FROM "incomes" i
JOIN "users" u ON u."id" = i."userId";

-- ---------------------------------------------------------------------------
-- 3. Re-link historical settlement rows
-- ---------------------------------------------------------------------------
-- The old settlement code wrote plain expenses/incomes with a generated description and no
-- reference back to the loan. Recover the link by matching that description, and reclassify
-- them as REPAY/COLLECT so they stop counting as spending and income.
--
-- Heuristic: where two loans share a counterparty name the match is ambiguous and Postgres
-- picks one arbitrarily. Both loans belong to the same user and the amount is unchanged, so the
-- cash position stays correct either way; only the loan attribution could be off.

UPDATE "transactions" t
SET "kind" = 'REPAY'::"TransactionKind",
    "loanId" = l."id",
    "categoryId" = NULL,
    "needWant" = NULL
FROM "loans" l
WHERE t."kind" = 'SPEND'
  AND l."userId" = t."userId"
  AND l."type" = 'BORROWED'
  AND t."description" = 'Repayment to ' || l."personName";

UPDATE "transactions" t
SET "kind" = 'COLLECT'::"TransactionKind",
    "loanId" = l."id",
    "source" = NULL,
    "sourceIcon" = NULL,
    "sourceColor" = NULL
FROM "loans" l
WHERE t."kind" = 'EARN'
  AND l."userId" = t."userId"
  AND l."type" = 'LENT'
  AND t."description" = 'Repayment from ' || l."personName";

-- ---------------------------------------------------------------------------
-- 4. Record the principal movement for pre-existing loans
-- ---------------------------------------------------------------------------
-- Under the old model, creating a loan moved no money. That is what made the ledger asymmetric:
-- a settlement credited cash with nothing ever having debited it.
--
-- Every existing loan therefore gets its opening movement, dated to the loan's creation:
--   LENT     -> LEND_OUT  (cash went out when you handed the money over)
--   BORROWED -> BORROW_IN (cash came in when you received it)
--
-- This makes the ledger internally consistent and is a correction, not a distortion: if money
-- was lent, cash on hand really was lower. A fully settled loan now nets to zero as it should,
-- and an outstanding one correctly shows the cash as gone.
--
-- Expect the reported balance to move on first load: down by total outstanding lent, up by
-- total outstanding borrowed. That is the previously missing half of the entry.

INSERT INTO "transactions" (
    "id", "userId", "kind", "amount", "date", "month", "description",
    "paymentMethod", "loanId", "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    l."userId",
    CASE WHEN l."type" = 'LENT' THEN 'LEND_OUT'::"TransactionKind"
         ELSE 'BORROW_IN'::"TransactionKind" END,
    l."amount",
    l."createdAt",
    to_char(l."createdAt" AT TIME ZONE u."timezone", 'YYYY-MM'),
    CASE WHEN l."type" = 'LENT' THEN 'Lent to ' || l."personName"
         ELSE 'Borrowed from ' || l."personName" END,
    'Cash',
    l."id",
    l."createdAt",
    l."updatedAt"
FROM "loans" l
JOIN "users" u ON u."id" = l."userId";

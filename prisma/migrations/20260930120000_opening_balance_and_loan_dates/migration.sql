-- Home v3 (D-62, D-63): the user's opening cash, and the day each loan's money moved.
--
-- Additive. loans.date gets a database default so the previous backend image, which doesn't
-- know the column, can still insert loans after this deploys or on a rollback.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "openingBalance" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "loans" ADD COLUMN "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: a loan's date is when its principal moved, which the ledger migration recorded as the
-- opening movement's date. A loan recorded without cashflow has no movement, so use when it was
-- created.
UPDATE "loans" l
SET "date" = COALESCE(
  (SELECT t."date" FROM "transactions" t
   WHERE t."loanId" = l."id" AND t."kind" IN ('LEND_OUT', 'BORROW_IN')
   ORDER BY t."date" ASC
   LIMIT 1),
  l."createdAt"
);

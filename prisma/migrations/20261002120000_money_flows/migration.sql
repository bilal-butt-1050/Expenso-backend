-- Money flows (Bilal, 2026-10-02): every movement records whether cash changed, and a balance
-- correction kind. Additive: the column has a default, so the previous backend image keeps working.

-- AlterEnum
ALTER TYPE "TransactionKind" ADD VALUE 'ADJUST';

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN "movesCash" BOOLEAN NOT NULL DEFAULT true;

-- Backfill: a loan recorded as an old debt had no starting movement at all, so its "no cash" choice
-- was only implied. Give it one, marked as not moving cash, so every loan has a starting row that
-- carries the choice and can be changed later. Cash is unchanged: the new rows don't count.
INSERT INTO "transactions" ("id", "userId", "kind", "amount", "date", "month", "description",
                            "paymentMethod", "loanId", "movesCash", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text,
       l."userId",
       (CASE l."type" WHEN 'LENT' THEN 'LEND_OUT' ELSE 'BORROW_IN' END)::"TransactionKind",
       l."amount",
       l."date",
       to_char((l."date" AT TIME ZONE 'UTC') AT TIME ZONE u."timezone", 'YYYY-MM'),
       CASE l."type" WHEN 'LENT' THEN 'Lent to ' ELSE 'Borrowed from ' END || l."personName",
       'Cash',
       l."id",
       false,
       l."createdAt",
       CURRENT_TIMESTAMP
FROM "loans" l
JOIN "users" u ON u."id" = l."userId"
WHERE NOT EXISTS (
  SELECT 1 FROM "transactions" t
  WHERE t."loanId" = l."id" AND t."kind" IN ('LEND_OUT', 'BORROW_IN')
);

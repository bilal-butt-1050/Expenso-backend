-- Data correction, no schema change.
--
-- Deleting a category used to re-home only the legacy `expenses` rows. `transactions.categoryId`
-- is ON DELETE SET NULL, so every ledger SPEND in the deleted category lost its category and
-- dropped out of the category breakdown and budgets. The service now moves those rows itself;
-- this repairs the rows already orphaned.
--
-- A SPEND always has a category (the API requires one), so a SPEND with a NULL categoryId can only
-- come from that bug. Other kinds never carry a category and are left alone.
--
-- Idempotent: a second run finds no orphans and changes nothing.

-- 1. Every user with an orphaned SPEND gets an "Other" category if they somehow lack one.
INSERT INTO "categories" ("id", "userId", "name", "icon", "color", "isDefault")
SELECT gen_random_uuid()::text, t."userId", 'Other', 'shape-outline', '#9E9E9E', true
FROM "transactions" t
WHERE t."kind" = 'SPEND' AND t."categoryId" IS NULL
GROUP BY t."userId"
ON CONFLICT ("userId", "name") DO NOTHING;

-- 2. Re-home the orphans to their owner's "Other".
UPDATE "transactions" t
SET "categoryId" = c."id", "updatedAt" = CURRENT_TIMESTAMP
FROM "categories" c
WHERE t."kind" = 'SPEND'
  AND t."categoryId" IS NULL
  AND c."userId" = t."userId"
  AND c."name" = 'Other';

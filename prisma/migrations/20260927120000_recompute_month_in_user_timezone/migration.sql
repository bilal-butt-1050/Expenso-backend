-- Recompute every transaction's `month` in its owner's timezone.
--
-- The unified-ledger migration (20260924094500) computed it as
--   to_char("date" AT TIME ZONE u."timezone", 'YYYY-MM')
-- but "date" is a `timestamp without time zone` holding UTC, and on that type AT TIME ZONE goes
-- the other way: it reads the value as Karachi time. In a UTC session (production's Postgres) a
-- row from the first five hours of a month, UTC, was filed under the previous month. That caught
-- every old monthly salary row, which the itemized-income migration had dated at midnight on the
-- 1st, and anything else dated at the start of a day on the 1st. Found by test MIG-010.
--
-- The app itself derives `month` correctly (monthKeyInZone), so rows it wrote are already right
-- and this changes only the rows the migration got wrong. It is idempotent: a second run matches
-- nothing. The expression below is independent of the session's timezone.
--
-- No down migration: the previous values were wrong.

UPDATE "transactions" t
SET "month" = to_char((t."date" AT TIME ZONE 'UTC') AT TIME ZONE u."timezone", 'YYYY-MM')
FROM "users" u
WHERE u."id" = t."userId"
  AND t."month" <> to_char((t."date" AT TIME ZONE 'UTC') AT TIME ZONE u."timezone", 'YYYY-MM');

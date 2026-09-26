-- Rollback for 20260926151125_otp_hardening. Prisma never runs this file; apply it by hand with
-- psql, then redeploy the previous image, and delete this migration's row from _prisma_migrations.
--
-- The old code reads a plaintext "otp" column and can't use hashed rows, so pending codes are voided
-- again.
--
-- "emailVerifiedAt" is deliberately KEPT (ARCH N2): the old code ignores it, and dropping it would
-- throw away the proof for everyone who registered with a code. Re-applying the forward migration
-- would then treat them as unverified, and a later Google sign-in would clear their password.
-- So after running this, the forward migration can't simply be re-applied: its
-- "ADD COLUMN emailVerifiedAt" would fail. Re-apply it by hand without that statement.
--
-- Stop the API container first: a signup between the DELETE and the ADD COLUMN would make the
-- NOT NULL "otp" column fail (the transaction then rolls back, which is safe).
BEGIN;
DELETE FROM "otp_verifications";
ALTER TABLE "otp_verifications" DROP COLUMN "otpHash", DROP COLUMN "attempts", ADD COLUMN "otp" TEXT NOT NULL;
DROP TABLE "otp_send_log";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260926151125_otp_hardening';
COMMIT;

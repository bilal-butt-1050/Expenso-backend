-- Rollback for 20260926151125_otp_hardening. Prisma never runs this file; apply it by hand with
-- psql, then redeploy the previous image, and delete this migration's row from _prisma_migrations.
--
-- The old code reads a plaintext "otp" column and can't use hashed rows, so pending codes are voided
-- again. "emailVerifiedAt" is dropped too; the old code ignores it, but keeping it would leave a
-- half-applied migration.
BEGIN;
DELETE FROM "otp_verifications";
ALTER TABLE "otp_verifications" DROP COLUMN "otpHash", DROP COLUMN "attempts", ADD COLUMN "otp" TEXT NOT NULL;
DROP TABLE "otp_send_log";
ALTER TABLE "users" DROP COLUMN "emailVerifiedAt";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260926151125_otp_hardening';
COMMIT;

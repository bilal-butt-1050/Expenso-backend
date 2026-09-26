-- OTP hardening (ARCH N3, threats S1 and S4) and proof of email ownership (N2, D-22).
-- Generated with `prisma migrate diff` from the schema, then two hand edits marked HAND-EDIT.
-- Rollback: down.sql in this folder (Prisma never runs it; apply by hand with psql).

-- HAND-EDIT: pending codes are ephemeral (10 minutes) and stored in plain text. Deleting them only
-- forces a resend, and lets the new NOT NULL "otpHash" column be added. Destructive: dry-run
-- inside BEGIN ... ROLLBACK against a production copy before deploying.
DELETE FROM "otp_verifications";

-- AlterTable
ALTER TABLE "otp_verifications" DROP COLUMN "otp",
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "otpHash" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

-- HAND-EDIT: backfill. Only Google-only accounts have proven their address (Google verified it).
-- Password-only and password+Google accounts stay NULL: the password may predate the link and
-- belong to someone else, which is exactly the case D-19/D-40 protect against.
UPDATE "users" SET "emailVerifiedAt" = "createdAt"
WHERE "googleId" IS NOT NULL AND "passwordHash" IS NULL;

-- CreateTable
CREATE TABLE "otp_send_log" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_send_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "otp_send_log_email_createdAt_idx" ON "otp_send_log"("email", "createdAt");

-- CreateIndex
CREATE INDEX "otp_send_log_ip_createdAt_idx" ON "otp_send_log"("ip", "createdAt");

-- CreateIndex
CREATE INDEX "otp_send_log_createdAt_idx" ON "otp_send_log"("createdAt");


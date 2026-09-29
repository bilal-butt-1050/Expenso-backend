-- Balance corrections (D-55): what the user says they hold, minus what the ledger adds up to,
-- recorded as ADJUST_IN / ADJUST_OUT. Plus users.balanceSetAt, set by every POST /balance.
--
-- Additive only, and no backfill: a value added to an enum can't be used in the same transaction.
-- Rollback note: once a correction row exists, an older backend image can't read it (Prisma
-- rejects enum values its schema doesn't know), so rollback is a forward fix.

-- AlterEnum (Postgres 12+ allows several ADD VALUEs in one migration)
ALTER TYPE "TransactionKind" ADD VALUE 'ADJUST_IN';
ALTER TYPE "TransactionKind" ADD VALUE 'ADJUST_OUT';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "balanceSetAt" TIMESTAMP(3);

import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { AppError } from "../utils/asyncHandler";

/**
 * Runs `fn` Serializable and retries on a serialization conflict.
 *
 * Concurrent settlements on the same loan must not both read the same `settledAmount` and each
 * decide there is room to pay — that over-settles the loan and double-writes cashflow. Serializable
 * makes the conflict detectable; Postgres then aborts one with 40001 and we retry it. `fn` must be
 * safe to run again from scratch, since each retry sees a fresh snapshot.
 *
 * If every attempt conflicts, the caller gets a 409 it can act on rather than a raw 500.
 */
export async function inSerializableTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  attempts = 3
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error: any) {
      // 40001 serialization_failure, 40P01 deadlock_detected — both are safe to retry.
      if (error?.code === "P2034" || ["40001", "40P01"].includes(error?.meta?.code)) {
        continue;
      }
      throw error;
    }
  }

  throw new AppError(409, "Could not complete the update, please try again");
}

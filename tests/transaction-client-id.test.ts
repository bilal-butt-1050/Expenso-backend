import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { createOrReplayTransaction } from "../src/modules/transactions/transactions.service";
import { deleteCategory } from "../src/modules/categories/categories.service";
import { createSchema, updateSchema } from "../src/modules/transactions/transactions.routes";
import { makeUser, categoryFor, dateOf } from "./helpers/factories";

/**
 * Idempotent create (ARCH N7.3, R-21). An offline write can be sent twice: the first request
 * succeeds on the server but its response is lost, so the app replays it. With a client-generated
 * id the replay must return the row it already made, never a duplicate.
 */
async function spend(userId: string, id: string | undefined, amount = 500) {
  const food = await categoryFor(userId, "Food");
  return createOrReplayTransaction(userId, {
    id,
    kind: "SPEND",
    amount,
    date: dateOf("2026-09-10"),
    categoryId: food.id,
    description: "Lunch",
  });
}

describe("POST /transactions with a client id", () => {
  it("creates the row with the client's id", async () => {
    const user = await makeUser();
    const id = randomUUID();

    const result = await spend(user.id, id);

    expect(result.replayed).toBe(false);
    expect(result.transaction.id).toBe(id);
  });

  it("a same-user replay returns the existing row and writes nothing new", async () => {
    const user = await makeUser();
    const id = randomUUID();
    const first = await spend(user.id, id, 500);

    // The replay carries a different amount, as a corrupted or edited resend might. It must not
    // overwrite what was saved.
    const replay = await spend(user.id, id, 999);

    expect(replay.replayed).toBe(true);
    expect(replay.transaction).toEqual(first.transaction);
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(1);
  });

  it("two concurrent sends of the same id create exactly one row", async () => {
    const user = await makeUser();
    const id = randomUUID();

    const results = await Promise.all([spend(user.id, id), spend(user.id, id)]);

    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(1);
  });

  it("a replay still returns the saved row after its category was deleted", async () => {
    const user = await makeUser();
    const id = randomUUID();
    const first = await spend(user.id, id);
    const food = await categoryFor(user.id, "Food");
    await deleteCategory(user.id, food.id);

    // The queued request still carries the deleted category's id, as a real replay would.
    const replay = await createOrReplayTransaction(user.id, {
      id,
      kind: "SPEND",
      amount: 500,
      date: dateOf("2026-09-10"),
      categoryId: food.id,
    });

    expect(replay.replayed).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
  });

  it("OWN-008: another user's id gets a generic 409, and their row is untouched", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const id = randomUUID();
    const aRow = await spend(a.id, id, 500);

    const error = await spend(b.id, id, 1).catch((e) => e);

    expect(error.statusCode).toBe(409);
    expect(error.message).toBe("Conflict");
    // Nothing about A's row appears in what B gets back.
    expect(JSON.stringify({ message: error.message })).not.toMatch(/Lunch|500|Food/);
    const after = await prisma.transaction.findUniqueOrThrow({ where: { id } });
    expect(after.userId).toBe(a.id);
    expect(after.amount.toString()).toBe("500");
    expect(aRow.transaction.id).toBe(id);
    expect(await prisma.transaction.count({ where: { userId: b.id } })).toBe(0);
  });

  it("without an id, creates still work as before (backward compatible)", async () => {
    const user = await makeUser();

    const first = await spend(user.id, undefined);
    const second = await spend(user.id, undefined);

    expect(first.transaction.id).not.toBe(second.transaction.id);
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(2);
  });
});

describe("transaction schemas", () => {
  const base = { kind: "SPEND", amount: 10, date: "2026-09-10" };

  it("rejects an id that is not a UUID", () => {
    expect(createSchema.safeParse({ ...base, id: "not-a-uuid" }).success).toBe(false);
    expect(createSchema.safeParse({ ...base, id: "" }).success).toBe(false);
  });

  it("accepts a UUID id, or none", () => {
    expect(createSchema.safeParse({ ...base, id: randomUUID() }).success).toBe(true);
    expect(createSchema.safeParse(base).success).toBe(true);
  });

  it("an update can never change the id", () => {
    const parsed = updateSchema.parse({ id: randomUUID(), amount: 20 });
    expect(parsed).not.toHaveProperty("id");
  });
});

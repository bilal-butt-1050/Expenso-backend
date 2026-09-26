import { describe, it, expect, vi, afterEach } from "vitest";
import { Prisma } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/lib/prisma";
import { deleteCategory } from "../src/modules/categories/categories.service";
import { getDashboardSummary } from "../src/modules/dashboard/dashboard.service";
import { makeUser, categoryFor, makeTransaction, dateOf } from "./helpers/factories";

/**
 * CATEGORIES — deleting a category must never lose spending (CAT-007).
 *
 * `transactions.categoryId` is ON DELETE SET NULL. Deleting a category used to re-home only the
 * legacy `expenses` rows, so every ledger SPEND in it lost its category and silently dropped out of
 * the category breakdown and every budget.
 */
describe("deleteCategory", () => {
  it("re-homes the category's SPEND transactions to Other (CAT-007)", async () => {
    const user = await makeUser();
    const food = await categoryFor(user.id, "Food");
    const other = await categoryFor(user.id, "Other");
    const spend = await makeTransaction({
      userId: user.id,
      kind: "SPEND",
      amount: "1250.50",
      date: dateOf("2026-09-10"),
      categoryId: food.id,
    });

    const result = await deleteCategory(user.id, food.id);

    expect(result.movedTo).toBe("Other");
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: spend.id } });
    expect(row.categoryId).toBe(other.id);
    expect(row.amount.toString()).toBe("1250.5");
  });

  it("keeps the spending visible in the dashboard's category breakdown", async () => {
    const user = await makeUser();
    const food = await categoryFor(user.id, "Food");
    const other = await categoryFor(user.id, "Other");
    await makeTransaction({ userId: user.id, kind: "SPEND", amount: 800, date: dateOf("2026-09-10"), categoryId: food.id });
    await makeTransaction({ userId: user.id, kind: "SPEND", amount: 200, date: dateOf("2026-09-11"), categoryId: other.id });

    await deleteCategory(user.id, food.id);

    const summary = await getDashboardSummary(user.id, "2026-09");
    const breakdownTotal = summary.categoryBreakdown.reduce((t: number, c: { amount: number }) => t + c.amount, 0);
    expect(breakdownTotal).toBe(1000);
    const otherRow = summary.categoryBreakdown.find((c: { categoryId: string }) => c.categoryId === other.id);
    expect(otherRow?.amount).toBe(1000);
  });

  it("does not touch another user's transactions", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const aFood = await categoryFor(a.id, "Food");
    const bFood = await categoryFor(b.id, "Food");
    const bSpend = await makeTransaction({ userId: b.id, kind: "SPEND", amount: 50, date: dateOf("2026-09-10"), categoryId: bFood.id });

    await deleteCategory(a.id, aFood.id);

    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: bSpend.id } });
    expect(row.categoryId).toBe(bFood.id);
  });
});

describe("deleteCategory edge cases", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates Other when the user has none, moves the spend there, and drops the category's budgets", async () => {
    const user = await makeUser();
    await prisma.category.deleteMany({ where: { userId: user.id, name: "Other" } });
    const food = await categoryFor(user.id, "Food");
    await prisma.budget.create({ data: { userId: user.id, categoryId: food.id, amount: 5000, month: "2026-09" } });
    const spend = await makeTransaction({ userId: user.id, kind: "SPEND", amount: 300, date: dateOf("2026-09-10"), categoryId: food.id });

    await deleteCategory(user.id, food.id);

    const other = await categoryFor(user.id, "Other");
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: spend.id } })).categoryId).toBe(other.id);
    expect(await prisma.budget.count({ where: { userId: user.id } })).toBe(0);
  });

  it("deletes a category with no spending without touching anything else", async () => {
    const user = await makeUser();
    const food = await categoryFor(user.id, "Food");
    const commute = await categoryFor(user.id, "Commute");
    const kept = await makeTransaction({ userId: user.id, kind: "SPEND", amount: 40, date: dateOf("2026-09-10"), categoryId: food.id });
    const before = await prisma.category.count({ where: { userId: user.id } });

    await deleteCategory(user.id, commute.id);

    expect(await prisma.category.count({ where: { userId: user.id } })).toBe(before - 1);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: kept.id } })).categoryId).toBe(food.id);
  });

  const conflict = () =>
    new Prisma.PrismaClientKnownRequestError("serialization failure", { code: "P2034", clientVersion: "test" });

  it("retries a serialization conflict and still re-homes the spend", async () => {
    const user = await makeUser();
    const food = await categoryFor(user.id, "Food");
    const other = await categoryFor(user.id, "Other");
    const spend = await makeTransaction({ userId: user.id, kind: "SPEND", amount: 90, date: dateOf("2026-09-10"), categoryId: food.id });
    const real = prisma.$transaction.bind(prisma);
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(conflict()).mockImplementation(real as never);

    await deleteCategory(user.id, food.id);

    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: spend.id } })).categoryId).toBe(other.id);
  });

  it("returns 409, not 500, when every attempt conflicts, and deletes nothing", async () => {
    const user = await makeUser();
    const food = await categoryFor(user.id, "Food");
    vi.spyOn(prisma, "$transaction").mockRejectedValue(conflict());

    await expect(deleteCategory(user.id, food.id)).rejects.toMatchObject({ statusCode: 409 });
    vi.restoreAllMocks();
    expect(await prisma.category.findUnique({ where: { id: food.id } })).not.toBeNull();
  });
});

/**
 * The one-off repair for rows orphaned before the fix. Seeds the broken state directly, then runs
 * the committed migration SQL exactly as `prisma migrate deploy` would.
 */
describe("migration 20260926120000_rehome_orphaned_spend", () => {
  const sql = readFileSync(
    join(__dirname, "../prisma/migrations/20260926120000_rehome_orphaned_spend/migration.sql"),
    "utf8"
  );
  // Prisma runs one statement per call. Comments are stripped first because they contain ';'.
  const statements = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const runRepair = async () => {
    for (const s of statements) await prisma.$executeRawUnsafe(s);
  };

  it("re-homes orphaned SPEND to Other, creating Other when missing, and leaves other rows alone", async () => {
    const withOther = await makeUser();
    const withoutOther = await makeUser();
    await prisma.category.deleteMany({ where: { userId: withoutOther.id, name: "Other" } });

    const orphanA = await makeTransaction({ userId: withOther.id, kind: "SPEND", amount: 100, date: dateOf("2026-09-10") });
    const orphanB = await makeTransaction({ userId: withoutOther.id, kind: "SPEND", amount: 70, date: dateOf("2026-09-10") });
    const earn = await makeTransaction({ userId: withOther.id, kind: "EARN", amount: 500, date: dateOf("2026-09-10") });
    const food = await categoryFor(withOther.id, "Food");
    const healthy = await makeTransaction({ userId: withOther.id, kind: "SPEND", amount: 30, date: dateOf("2026-09-10"), categoryId: food.id });

    await runRepair();

    const otherA = await categoryFor(withOther.id, "Other");
    const otherB = await categoryFor(withoutOther.id, "Other");
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: orphanA.id } })).categoryId).toBe(otherA.id);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: orphanB.id } })).categoryId).toBe(otherB.id);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: earn.id } })).categoryId).toBeNull();
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: healthy.id } })).categoryId).toBe(food.id);
  });

  it("is idempotent: a second run changes nothing and creates no duplicate Other", async () => {
    const user = await makeUser();
    await makeTransaction({ userId: user.id, kind: "SPEND", amount: 100, date: dateOf("2026-09-10") });

    await runRepair();
    const before = await prisma.transaction.findMany({ where: { userId: user.id }, orderBy: { id: "asc" } });
    await runRepair();
    const after = await prisma.transaction.findMany({ where: { userId: user.id }, orderBy: { id: "asc" } });

    expect(after.map((t) => t.categoryId)).toEqual(before.map((t) => t.categoryId));
    expect(await prisma.category.count({ where: { userId: user.id, name: "Other" } })).toBe(1);
  });
});

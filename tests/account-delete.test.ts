import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AddressInfo } from "net";
import { Server } from "http";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { createApp } from "../src/app";
import { signToken } from "../src/utils/jwt";
import { makeUser, makeLoan, categoryFor, spend, earn, dateOf } from "./helpers/factories";
import { deleteAccount } from "../src/modules/auth/auth.service";

/** DEL: in-app account deletion (Play Store requirement). */

let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status;
}

async function userWithData() {
  const user = await makeUser();
  const food = await categoryFor(user.id);
  // Legacy rows: `expenses.categoryId` is the one RESTRICT foreign key, so the cascade order matters.
  await prisma.expense.create({ data: { userId: user.id, categoryId: food.id, amount: 50, date: dateOf("2026-08-01"), month: "2026-08" } });
  await prisma.otpVerification.create({ data: { email: user.email, otpHash: "x", expiresAt: new Date(Date.now() + 600_000) } });
  await prisma.budget.create({ data: { userId: user.id, categoryId: food.id, amount: new Prisma.Decimal(1_000), month: "2026-09" } });
  await earn(user.id, 5_000, dateOf("2026-09-01"));
  await spend(user.id, 700, dateOf("2026-09-02"), food.id);
  await makeLoan({ userId: user.id, type: "LENT", amount: 300 });
  return user;
}

const owned = async (userId: string) => ({
  transactions: await prisma.transaction.count({ where: { userId } }),
  loans: await prisma.loan.count({ where: { userId } }),
  budgets: await prisma.budget.count({ where: { userId } }),
  categories: await prisma.category.count({ where: { userId } }),
});

describe("DEL: delete my account", () => {
  it("DEL-001: refuses without the explicit confirmation, or without a session, and deletes nothing", async () => {
    const user = await userWithData();
    const token = signToken({ userId: user.id, tv: 0 });
    const before = await owned(user.id);

    expect(await call("DELETE", "/auth/account", token)).toBe(400);
    expect(await call("DELETE", "/auth/account", token, { confirm: "yes" })).toBe(400);
    expect(await call("DELETE", "/auth/account", undefined, { confirm: "DELETE" })).toBe(401);

    expect(await prisma.user.count({ where: { id: user.id } })).toBe(1);
    expect(await owned(user.id)).toEqual(before);
  });

  it("DEL-002: deletes the user and everything they own, ends the session, and leaves others alone", async () => {
    const user = await userWithData();
    const other = await userWithData();
    const token = signToken({ userId: user.id, tv: 0 });
    const otherBefore = await owned(other.id);
    expect(await call("GET", "/auth/me", token)).toBe(200);

    expect(await call("DELETE", "/auth/account", token, { confirm: "DELETE" })).toBe(204);

    expect(await prisma.user.count({ where: { id: user.id } })).toBe(0);
    expect(await owned(user.id)).toEqual({ transactions: 0, loans: 0, budgets: 0, categories: 0 });
    expect(await prisma.expense.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.otpVerification.count({ where: { email: user.email } })).toBe(0);
    // The same token stops working at once (the token-version cache is cleared).
    expect(await call("GET", "/auth/me", token)).toBe(401);
    expect(await owned(other.id)).toEqual(otherBefore);
    expect(await prisma.otpVerification.count({ where: { email: other.email } })).toBe(1);
  });

  it("DEL-003: a second delete (double tap, retry) is harmless", async () => {
    const user = await userWithData();
    await Promise.all([deleteAccount(user.id), deleteAccount(user.id)]);
    await deleteAccount(user.id);
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(0);
  });
});

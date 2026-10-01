import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AddressInfo } from "net";
import { Server } from "http";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { createApp } from "../src/app";
import { signToken } from "../src/utils/jwt";
import { makeUser, makeLoan, categoryFor, spend, earn, dateOf } from "./helpers/factories";

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
    // The same token stops working at once (the token-version cache is cleared).
    expect(await call("GET", "/auth/me", token)).toBe(401);
    expect(await owned(other.id)).toEqual(otherBefore);
  });
});

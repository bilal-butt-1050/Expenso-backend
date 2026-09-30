import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AddressInfo } from "net";
import { Server } from "http";
import { prisma } from "../src/lib/prisma";
import { createApp } from "../src/app";
import { signToken } from "../src/utils/jwt";
import { makeUser, makeLoan } from "./helpers/factories";

/**
 * Text fields have the same limits the app enforces: a malformed or over-long email, an over-long
 * password or name, a blank category name. Each is a 400 at the boundary, and nothing is written.
 */

let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

async function send(method: string, path: string, body: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return res.status;
}

const longEmail = `${"a".repeat(250)}@x.co`; // 255 characters: one past the limit

describe("VAL-001: emails are checked on every auth route", () => {
  it("refuses a malformed or over-long email", async () => {
    for (const email of ["bilal@gmail", "not-an-email", "", longEmail]) {
      expect(await send("POST", "/auth/send-otp", { email })).toBe(400);
      expect(await send("POST", "/auth/login", { email, password: "whatever1" })).toBe(400);
      expect(await send("POST", "/auth/register", { email, password: "Password1", name: "A" })).toBe(400);
    }
  });
});

describe("VAL-002: passwords and names have an upper bound", () => {
  it("refuses an over-long password or name, and creates nothing", async () => {
    const before = await prisma.user.count();
    const email = `limits-${Date.now()}@test.local`;
    expect(await send("POST", "/auth/register", { email, password: "p".repeat(201), name: "A" })).toBe(400);
    expect(await send("POST", "/auth/register", { email, password: "Password1", name: "n".repeat(81) })).toBe(400);
    expect(await send("POST", "/auth/login", { email, password: "p".repeat(201) })).toBe(400);
    expect(await prisma.user.count()).toBe(before);
  });
});

describe("VAL-003: loan and category names", () => {
  it("refuses an over-long loan person name and a blank category name", async () => {
    const user = await makeUser();
    const token = signToken({ userId: user.id, tv: 0 });
    const loan = await makeLoan({ userId: user.id, type: "LENT", amount: 500 });

    expect(await send("POST", "/loans", { type: "LENT", personName: "x".repeat(81), amount: 100 }, token)).toBe(400);
    expect(await send("PATCH", `/loans/${loan.id}`, { personName: "x".repeat(81) }, token)).toBe(400);
    expect(await send("POST", "/categories", { name: "   ", color: "#00E676" }, token)).toBe(400);

    expect(await prisma.loan.count({ where: { userId: user.id } })).toBe(1);
  });
});

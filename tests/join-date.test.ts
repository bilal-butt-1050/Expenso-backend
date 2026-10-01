import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AddressInfo } from "net";
import { Server } from "http";
import { prisma } from "../src/lib/prisma";
import { createApp } from "../src/app";
import { signToken } from "../src/utils/jwt";
import { makeUser, categoryFor } from "./helpers/factories";

/** JOIN: nothing can be dated before the day the account was created (D-67). */

let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

const pkt = (iso: string) => new Date(`${iso}+05:00`);

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function joinedOn(iso: string) {
  const user = await makeUser({ createdAt: pkt(iso) });
  return { user, token: signToken({ userId: user.id, tv: 0 }) };
}

describe("JOIN: history starts on the join day", () => {
  it("JOIN-001: an entry dated before the join day is refused; the join day itself is fine at any hour", async () => {
    const { user, token } = await joinedOn("2026-08-10T15:00:00");
    const food = await categoryFor(user.id);

    const before = await call(token, "POST", "/transactions", {
      kind: "SPEND", amount: 100, categoryId: food.id, date: pkt("2026-08-09T12:00:00").toISOString(),
    });
    expect(before.status).toBe(400);
    expect(before.json.error).toMatch(/before you joined \(10 Aug 2026\)/);

    // Earlier the same morning than the account: the same calendar day, so allowed.
    const sameDay = await call(token, "POST", "/transactions", {
      kind: "EARN", amount: 100, source: "Salary", date: pkt("2026-08-10T08:00:00").toISOString(),
    });
    expect(sameDay.status).toBe(201);

    // Moving an existing entry before the join day is refused too.
    const moved = await call(token, "PATCH", `/transactions/${sameDay.json.id}`, {
      date: pkt("2026-07-30T12:00:00").toISOString(),
    });
    expect(moved.status).toBe(400);
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(1);
  });

  it("JOIN-002: a loan or a repayment dated before the join day is refused", async () => {
    const { user, token } = await joinedOn("2026-08-10T15:00:00");

    const early = await call(token, "POST", "/loans", {
      type: "LENT", personName: "Ali", amount: 500, date: pkt("2026-08-01T12:00:00").toISOString(),
    });
    expect(early.status).toBe(400);

    const loan = await call(token, "POST", "/loans", {
      type: "LENT", personName: "Ali", amount: 500, date: pkt("2026-08-12T12:00:00").toISOString(),
    });
    expect(loan.status).toBe(201);

    const redated = await call(token, "PATCH", `/loans/${loan.json.id}`, { date: pkt("2026-08-05T12:00:00").toISOString() });
    expect(redated.status).toBe(400);

    // Before the loan's own day is already refused; the join day sits under it as well.
    const repaid = await call(token, "PATCH", `/loans/${loan.json.id}/settle`, {
      paymentAmount: 100, date: pkt("2026-08-09T12:00:00").toISOString(),
    });
    expect(repaid.status).toBe(400);
    expect(await prisma.loan.count({ where: { userId: user.id } })).toBe(1);
  });
});

describe("JOIN: entries from before the rule", () => {
  it("JOIN-003: an entry already dated before the join day stays editable, but can't move earlier", async () => {
    const { user, token } = await joinedOn("2026-08-10T15:00:00");
    // Backdated before D-67 existed.
    const old = await prisma.transaction.create({
      data: { userId: user.id, kind: "EARN", amount: 100, source: "Salary", date: pkt("2026-08-01T12:00:00"), month: "2026-08" },
    });
    // The app sends the date on every edit, unchanged here.
    const fixed = await call(token, "PATCH", `/transactions/${old.id}`, { amount: 150, date: old.date.toISOString() });
    expect(fixed.status).toBe(200);
    expect(fixed.json.amount).toBe(150);
    // Later, still before joining: not earlier than it was, so allowed.
    expect((await call(token, "PATCH", `/transactions/${old.id}`, { date: pkt("2026-08-05T12:00:00").toISOString() })).status).toBe(200);
    // Earlier than it was, and before joining: refused.
    expect((await call(token, "PATCH", `/transactions/${old.id}`, { date: pkt("2026-07-20T12:00:00").toISOString() })).status).toBe(400);
  });

  it("JOIN-004: a repayment dated after the loan but before the join day is refused by the join rule", async () => {
    const { user, token } = await joinedOn("2026-08-10T15:00:00");
    // A loan from before the rule, dated 1 Aug.
    const loan = await prisma.loan.create({
      data: { userId: user.id, type: "LENT", personName: "Ali", amount: 500, date: pkt("2026-08-01T12:00:00") },
    });
    const repaid = await call(token, "PATCH", `/loans/${loan.id}/settle`, {
      paymentAmount: 100, date: pkt("2026-08-05T12:00:00").toISOString(),
    });
    expect(repaid.status).toBe(400);
    expect(repaid.json.error).toMatch(/before you joined/);
  });
});

describe("ORD/CAT: small fixes from the end-to-end test", () => {
  it("ORD-001: a day's entries list newest-recorded first, and paging across the tie loses nothing", async () => {
    const { token } = await joinedOn("2026-08-01T09:00:00");
    const noon = pkt("2026-08-20T12:00:00").toISOString();
    const ids: string[] = [];
    for (const source of ["First", "Second", "Third"]) {
      const res = await call(token, "POST", "/transactions", { kind: "EARN", amount: 10, source, date: noon });
      expect(res.status).toBe(201);
      ids.push(res.json.id);
      await new Promise((r) => setTimeout(r, 15));
    }
    const page1 = await call(token, "GET", "/transactions?month=2026-08&limit=2");
    expect(page1.json.items.map((t: { source: string }) => t.source)).toEqual(["Third", "Second"]);
    const page2 = await call(token, "GET", `/transactions?month=2026-08&limit=2&cursor=${page1.json.nextCursor}`);
    expect(page2.json.items.map((t: { source: string }) => t.source)).toEqual(["First"]);
    expect(page2.json.hasMore).toBe(false);
  });

  it("CAT-010: a category name that differs only by case is a duplicate, on create and on rename", async () => {
    const { user, token } = await joinedOn("2026-08-01T09:00:00");
    await categoryFor(user.id, "Food");
    const dup = await call(token, "POST", "/categories", { name: "food", color: "#00E676" });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toMatch(/already have a category called "Food"/);

    const other = await call(token, "POST", "/categories", { name: "Pets", color: "#00E676" });
    expect(other.status).toBe(201);
    expect((await call(token, "PUT", `/categories/${other.json.id}`, { name: "FOOD" })).status).toBe(409);
    // Renaming a category to a new casing of its own name is fine.
    expect((await call(token, "PUT", `/categories/${other.json.id}`, { name: "pets" })).status).toBe(200);
  });
});


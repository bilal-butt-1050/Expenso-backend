import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AddressInfo } from "net";
import { Server } from "http";
import { createApp } from "../src/app";
import { signToken } from "../src/utils/jwt";
import { makeUser, categoryFor } from "./helpers/factories";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

describe("budgets", () => {
  it("amounts come back as numbers, like every other amount (they were Decimal strings)", async () => {
    const user = await makeUser();
    const food = await categoryFor(user.id, "Food");
    const headers = { Authorization: `Bearer ${signToken({ userId: user.id, tv: 0 })}`, "content-type": "application/json" };

    const saved = await fetch(`${base}/budgets`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ categoryId: food.id, amount: 1234.56, month: "2026-09" }),
    }).then((r) => r.json() as Promise<{ amount: unknown }>);
    const listed = (await fetch(`${base}/budgets?month=2026-09`, { headers }).then((r) => r.json())) as { amount: unknown }[];

    expect(saved.amount).toBe(1234.56);
    expect(listed.map((b) => b.amount)).toEqual([1234.56]);
  });
});

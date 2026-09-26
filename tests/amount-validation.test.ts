import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AddressInfo } from "net";
import { Server } from "http";
import { prisma } from "../src/lib/prisma";
import { createApp } from "../src/app";
import { signToken } from "../src/utils/jwt";
import { makeUser, makeLoan, makeTransaction, categoryFor, dateOf } from "./helpers/factories";

/**
 * LED-013: an amount that isn't a real, storable number is a 400 at the boundary, on every
 * endpoint that takes one. JSON can't carry NaN or Infinity, but `1e999` parses to Infinity, and
 * an amount past numeric(14,2)'s ceiling used to get as far as Postgres and come back as a 500.
 */

let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

/** Raw JSON text, so values JSON.stringify can't produce (NaN, 1e999) reach the server as sent. */
async function send(token: string, method: string, path: string, rawJson: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: rawJson,
  });
  return { status: res.status, text: await res.text() };
}

const BAD_AMOUNTS = ["NaN", "Infinity", "-Infinity", "1e999", '"abc"', '"100"', "null", "1000000000000", "1e20"];

describe("LED-013: amounts that aren't real, storable numbers are refused with 400", () => {
  it("on every endpoint that takes an amount, and nothing is written", async () => {
    const user = await makeUser();
    const token = signToken({ userId: user.id, tv: 0 });
    const food = await categoryFor(user.id, "Food");
    const spend = await makeTransaction({ userId: user.id, kind: "SPEND", amount: 10, date: dateOf("2026-09-01"), categoryId: food.id });
    const earn = await makeTransaction({ userId: user.id, kind: "EARN", amount: 10, date: dateOf("2026-09-01") });
    const loan = await makeLoan({ userId: user.id, type: "LENT", amount: 500 });
    const before = await prisma.transaction.count();

    const endpoints: [string, string, (amount: string) => string][] = [
      ["POST", "/transactions", (a) => `{"kind":"SPEND","amount":${a},"date":"2026-09-02","categoryId":"${food.id}"}`],
      ["PATCH", `/transactions/${spend.id}`, (a) => `{"amount":${a}}`],
      ["POST", "/expenses", (a) => `{"amount":${a},"date":"2026-09-02","categoryId":"${food.id}"}`],
      ["PUT", `/expenses/${spend.id}`, (a) => `{"amount":${a}}`],
      ["POST", "/income", (a) => `{"amount":${a},"date":"2026-09-02","source":"Salary"}`],
      ["PUT", `/income/${earn.id}`, (a) => `{"amount":${a}}`],
      ["PUT", "/budgets", (a) => `{"amount":${a},"month":"2026-09","categoryId":"${food.id}"}`],
      ["POST", "/loans", (a) => `{"type":"LENT","personName":"X","amount":${a}}`],
      ["PATCH", `/loans/${loan.id}`, (a) => `{"amount":${a}}`],
      ["PATCH", `/loans/${loan.id}/settle`, (a) => `{"paymentAmount":${a}}`],
    ];

    const failures: string[] = [];
    for (const [method, path, body] of endpoints) {
      for (const amount of BAD_AMOUNTS) {
        const res = await send(token, method, path, body(amount));
        if (res.status !== 400) failures.push(`${method} ${path} amount=${amount} → ${res.status} ${res.text.slice(0, 80)}`);
      }
    }

    expect(failures).toEqual([]);
    expect(await prisma.transaction.count()).toBe(before);
    expect(await prisma.budget.count()).toBe(0);
    expect(await prisma.loan.count()).toBe(1);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).amount.toNumber()).toBe(500);
  });

  it("the largest storable amount is still accepted", async () => {
    const user = await makeUser();
    const token = signToken({ userId: user.id, tv: 0 });

    const res = await send(token, "POST", "/transactions", '{"kind":"EARN","amount":999999999999.99,"date":"2026-09-02","source":"Max"}');

    expect(res.status).toBe(201);
  });
});

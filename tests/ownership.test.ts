import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { AddressInfo } from "net";
import { Server } from "http";
import { Router } from "express";
import { prisma } from "../src/lib/prisma";
import { createApp } from "../src/app";
import { signToken } from "../src/utils/jwt";
import { authRouter } from "../src/modules/auth/auth.routes";
import { budgetsRouter } from "../src/modules/budgets/budgets.routes";
import { categoriesRouter } from "../src/modules/categories/categories.routes";
import { dashboardRouter } from "../src/modules/dashboard/dashboard.routes";
import { expensesRouter } from "../src/modules/expenses/expenses.routes";
import { incomeRouter } from "../src/modules/income/income.routes";
import { loansRouter } from "../src/modules/loans/loans.routes";
import { transactionsRouter } from "../src/modules/transactions/transactions.routes";
import { balanceRouter } from "../src/modules/balance/balance.routes";
import { makeUser, makeTransaction, makeLoan, categoryFor, dateOf } from "./helpers/factories";

/**
 * Ownership and isolation (TEST_SPEC B9, OWN-001..007): user A must never see or change user B's
 * money. Everything goes over HTTP through the real app, so routing, validation and the services'
 * userId scoping are all under test together.
 */

const MONTH = "2026-09";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function call(token: string, method: Method, path: string, body?: object) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}

/** Two users with money in the same month. B's rows carry markers that must never reach A. */
async function world() {
  const a = await makeUser({ email: "a@test.local" });
  const b = await makeUser({ email: "b-secret@test.local" });

  const aFood = await categoryFor(a.id, "Food");
  const aSpend = await makeTransaction({
    userId: a.id, kind: "SPEND", amount: 100, date: dateOf("2026-09-10"), categoryId: aFood.id, description: "A lunch",
  });

  const bCategory = await prisma.category.create({
    data: { userId: b.id, name: "B-SECRET-CAT", icon: "shape-outline", color: "#123456" },
  });
  const bSpend = await makeTransaction({
    userId: b.id, kind: "SPEND", amount: 777.77, date: dateOf("2026-09-12"), categoryId: bCategory.id,
    description: "B-SECRET-SPEND",
  });
  const bEarn = await makeTransaction({
    userId: b.id, kind: "EARN", amount: 555.55, date: dateOf("2026-09-11"), source: "B-SECRET-SOURCE",
    description: "B-SECRET-EARN",
  });
  const bLoan = await makeLoan({
    userId: b.id, type: "LENT", amount: 333.33, createdAt: dateOf("2026-09-05"), personName: "B-SECRET-PERSON",
  });
  const bBudget = await prisma.budget.create({
    data: { userId: b.id, categoryId: bCategory.id, amount: 999.99, month: MONTH },
  });

  return {
    a: { user: a, token: signToken({ userId: a.id, tv: 0 }), food: aFood, spend: aSpend },
    b: { user: b, token: signToken({ userId: b.id, tv: 0 }), category: bCategory, spend: bSpend, earn: bEarn, loan: bLoan, budget: bBudget },
    /** Anything whose presence in a response means B's data leaked. */
    bMarkers: [
      b.id, b.email, bCategory.id, bSpend.id, bEarn.id, bLoan.id, bBudget.id,
      "B-SECRET", "777.77", "555.55", "333.33", "999.99",
    ],
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** Everything B owns, as stored. Compared before and after A's attempts. */
async function snapshotOf(userId: string) {
  const [transactions, loans, categories, budgets] = await Promise.all([
    prisma.transaction.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    prisma.loan.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    prisma.category.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    prisma.budget.findMany({ where: { userId }, orderBy: { id: "asc" } }),
  ]);
  return JSON.stringify({ transactions, loans, categories, budgets });
}

const leaks = (text: string, markers: string[]) => markers.filter((m) => text.includes(m));

// --- The route table ---------------------------------------------------------------------------

/**
 * Every mounted route, classified. A route added without a line here fails the coverage test,
 * so a new endpoint can't skip the ownership checks.
 */
const READS = [
  "GET /auth/me",
  "GET /balance/",
  "GET /budgets/",
  "GET /categories/",
  "GET /dashboard/summary",
  "GET /expenses/",
  "GET /income/",
  "GET /income/summary",
  "GET /loans/",
  "GET /loans/summary",
  "GET /transactions/",
];
/** Take another user's resource id in the path. */
const MUTATIONS_BY_ID = [
  "PUT /categories/:id",
  "DELETE /categories/:id",
  "DELETE /budgets/:categoryId",
  "PUT /expenses/:id",
  "PATCH /expenses/:id/toggle-status",
  "DELETE /expenses/:id",
  "PUT /income/:id",
  "DELETE /income/:id",
  "PATCH /loans/:id",
  "PATCH /loans/:id/settle",
  "DELETE /loans/:id",
  "PATCH /transactions/:id",
  "DELETE /transactions/:id",
];
/** Create for the caller; the only foreign reference they accept is a categoryId (OWN-003). */
const CREATES = ["POST /categories/", "PUT /budgets/", "POST /expenses/", "POST /income/", "POST /loans/", "POST /transactions/"];
/** No session, or they act only on the caller's own account: nothing of another user's to reach. */
const SELF_OR_PUBLIC = [
  "POST /auth/send-otp",
  "POST /auth/register",
  "POST /auth/login",
  "POST /auth/google",
  "PATCH /auth/profile",
  "PATCH /auth/password",
  // Sets the caller's own balance: there is no id to point at someone else's (BAL-007).
  "POST /balance/",
];

describe("route coverage", () => {
  it("every mounted route is classified for the ownership tests (37 endpoints)", () => {
    const mounted: [string, Router][] = [
      ["/auth", authRouter], ["/budgets", budgetsRouter], ["/categories", categoriesRouter],
      ["/dashboard", dashboardRouter], ["/expenses", expensesRouter], ["/income", incomeRouter],
      ["/loans", loansRouter], ["/transactions", transactionsRouter], ["/balance", balanceRouter],
    ];
    const actual = mounted.flatMap(([prefix, router]) =>
      router.stack
        .filter((layer) => layer.route)
        .flatMap((layer) => {
          const route = layer.route as unknown as { path: string; methods: Record<string, boolean> };
          return Object.keys(route.methods).map((m) => `${m.toUpperCase()} ${prefix}${route.path}`);
        })
    );
    const classified = [...READS, ...MUTATIONS_BY_ID, ...CREATES, ...SELF_OR_PUBLIC];

    expect(actual.sort()).toEqual(classified.sort());
    expect(actual).toHaveLength(37);
  });
});

// --- OWN-001: reads ------------------------------------------------------------------------------

describe("OWN-001: A cannot read B's data", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  const readPaths = [
    "/auth/me",
    "/balance",
    `/budgets?month=${MONTH}`,
    "/categories",
    `/dashboard/summary?month=${MONTH}`,
    `/expenses?month=${MONTH}`,
    `/income?month=${MONTH}`,
    `/income/summary?month=${MONTH}`,
    "/loans",
    "/loans/summary",
    `/transactions?month=${MONTH}`,
  ];

  it.each(readPaths)("GET %s shows A none of B's rows (and B sees their own)", async (path) => {
    const asA = await call(w.a.token, "GET", path);
    expect(asA.status).toBe(200);
    expect(leaks(asA.text, w.bMarkers)).toEqual([]);

    // The control: the same read as B does show B's data, so the check above means something.
    const asB = await call(w.b.token, "GET", path);
    expect(asB.status).toBe(200);
    expect(leaks(asB.text, w.bMarkers).length).toBeGreaterThan(0);
  });

  it("filtering by B's categoryId returns none of B's rows", async () => {
    for (const path of [
      `/transactions?categoryId=${w.b.category.id}`,
      `/expenses?month=${MONTH}&categoryId=${w.b.category.id}`,
    ]) {
      const res = await call(w.a.token, "GET", path);
      expect(res.status, path).toBe(200);
      expect(leaks(res.text, w.bMarkers), path).toEqual([]);
    }
  });
});

// --- OWN-002: mutations by id ------------------------------------------------------------------

/**
 * "Clear this month's budget for this category" succeeds whether or not one exists (204), so the
 * app can clear without checking first. Scoped by userId, it is a no-op on another user's category.
 */
const IDEMPOTENT_DELETES = ["DELETE /budgets/:categoryId"];
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

describe("OWN-002: A cannot modify B's rows", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  const attempts = (w: World): [string, Method, string, object?][] => [
    ["PUT /categories/:id", "PUT", `/categories/${w.b.category.id}`, { name: "hacked" }],
    ["DELETE /categories/:id", "DELETE", `/categories/${w.b.category.id}`],
    ["DELETE /budgets/:categoryId", "DELETE", `/budgets/${w.b.category.id}?month=${MONTH}`],
    ["PUT /expenses/:id", "PUT", `/expenses/${w.b.spend.id}`, { amount: 1 }],
    ["PATCH /expenses/:id/toggle-status", "PATCH", `/expenses/${w.b.spend.id}/toggle-status`],
    ["DELETE /expenses/:id", "DELETE", `/expenses/${w.b.spend.id}`],
    ["PUT /income/:id", "PUT", `/income/${w.b.earn.id}`, { amount: 1 }],
    ["DELETE /income/:id", "DELETE", `/income/${w.b.earn.id}`],
    ["PATCH /loans/:id", "PATCH", `/loans/${w.b.loan.id}`, { personName: "hacked" }],
    ["PATCH /loans/:id/settle", "PATCH", `/loans/${w.b.loan.id}/settle`, {}],
    ["DELETE /loans/:id", "DELETE", `/loans/${w.b.loan.id}`],
    ["PATCH /transactions/:id", "PATCH", `/transactions/${w.b.spend.id}`, { amount: 1 }],
    ["DELETE /transactions/:id", "DELETE", `/transactions/${w.b.spend.id}`],
  ];

  it("covers every mutation that takes an id", () => {
    expect(attempts(w).map(([route]) => route).sort()).toEqual([...MUTATIONS_BY_ID].sort());
  });

  it("each one is refused with 404 or 403, leaks nothing, and leaves B's data untouched", async () => {
    const before = await snapshotOf(w.b.user.id);

    for (const [route, method, path, body] of attempts(w)) {
      const res = await call(w.a.token, method, path, body);
      if (IDEMPOTENT_DELETES.includes(route)) {
        // Same answer as for an id that doesn't exist, so it confirms nothing about B.
        const unknown = await call(w.a.token, method, path.replace(w.b.category.id, UNKNOWN_ID), body);
        expect(res.status, route).toBe(unknown.status);
      } else {
        expect([403, 404], `${route} → ${res.status} ${res.text}`).toContain(res.status);
      }
      expect(leaks(res.text, w.bMarkers), route).toEqual([]);
    }

    expect(await snapshotOf(w.b.user.id)).toBe(before);
  });
});

// --- OWN-003: foreign categoryId -----------------------------------------------------------------

describe("OWN-003: A cannot use B's category", () => {
  it("on any create or update that takes a categoryId", async () => {
    const w = await world();
    const bCat = w.b.category.id;
    const before = await snapshotOf(w.b.user.id);

    const attempts: [Method, string, object][] = [
      ["POST", "/transactions", { kind: "SPEND", amount: 5, date: "2026-09-15", categoryId: bCat }],
      ["PATCH", `/transactions/${w.a.spend.id}`, { categoryId: bCat }],
      ["POST", "/expenses", { amount: 5, date: "2026-09-15", categoryId: bCat }],
      ["PUT", `/expenses/${w.a.spend.id}`, { categoryId: bCat }],
      ["PUT", "/budgets", { categoryId: bCat, amount: 1, month: MONTH }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(w.a.token, method, path, body);
      expect(res.status, `${method} ${path} → ${res.text}`).toBeGreaterThanOrEqual(400);
      expect(res.status, `${method} ${path}`).toBeLessThan(500);
    }

    expect(await prisma.transaction.count({ where: { userId: w.a.user.id, categoryId: bCat } })).toBe(0);
    expect(await prisma.budget.count({ where: { userId: w.a.user.id } })).toBe(0);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: w.a.spend.id } })).categoryId).toBe(w.a.food.id);
    expect(await snapshotOf(w.b.user.id)).toBe(before);
  });
});

// --- OWN-004: settling -----------------------------------------------------------------------------

describe("OWN-004: A cannot settle B's loan", () => {
  it("partly or fully, and no settlement movement is written for either user", async () => {
    const w = await world();
    const movements = () => prisma.transaction.count({ where: { loanId: w.b.loan.id } });
    const movementsBefore = await movements();

    for (const body of [{ paymentAmount: 10 }, {}]) {
      const res = await call(w.a.token, "PATCH", `/loans/${w.b.loan.id}/settle`, body);
      expect(res.status).toBe(404);
    }

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: w.b.loan.id } });
    expect(loan.settledAmount.toNumber()).toBe(0);
    expect(loan.status).toBe("PENDING");
    expect(await movements()).toBe(movementsBefore);
    expect(await prisma.transaction.count({ where: { userId: w.a.user.id, kind: { in: ["COLLECT", "REPAY"] } } })).toBe(0);
  });
});

// --- OWN-005: dashboard totals ---------------------------------------------------------------------

describe("OWN-005: A's dashboard counts only A's rows", () => {
  it("totals, debts and breakdown ignore B entirely", async () => {
    const w = await world();

    const { json: d } = await call(w.a.token, "GET", `/dashboard/summary?month=${MONTH}`);

    expect(d.totalExpenses).toBe(100);
    expect(d.monthlyIncome).toBe(0);
    expect(d.cashOnHand).toBe(-100);
    expect(d.netDebtSnapshot.totalLent).toBe(0);
    expect(d.netDebtSnapshot.totalBorrowed).toBe(0);
    expect(d.categoryBreakdown.map((c: { categoryId: string }) => c.categoryId)).toEqual([w.a.food.id]);
  });
});

// --- OWN-006: pagination cursor ------------------------------------------------------------------

describe("OWN-006: a cursor can't cross the user boundary", () => {
  it("a cursor built from B's row still returns only A's rows", async () => {
    const w = await world();
    // Newer than every row either user has, keyed on B's id.
    const cursor = Buffer.from(`2027-01-01T00:00:00.000Z|${w.b.spend.id}`).toString("base64url");

    const res = await call(w.a.token, "GET", `/transactions?cursor=${cursor}`);

    expect(res.status).toBe(200);
    expect(res.json.items.map((t: { id: string }) => t.id)).toEqual([w.a.spend.id]);
    expect(leaks(res.text, w.bMarkers)).toEqual([]);
  });

  it("paging through A's list one row at a time never reaches B's rows", async () => {
    const w = await world();
    await makeTransaction({ userId: w.a.user.id, kind: "EARN", amount: 50, date: dateOf("2026-09-20") });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const q: string = cursor ? `&cursor=${cursor}` : "";
      const res = await call(w.a.token, "GET", `/transactions?limit=1${q}`);
      expect(leaks(res.text, w.bMarkers)).toEqual([]);
      seen.push(...res.json.items.map((t: { id: string }) => t.id));
      cursor = res.json.nextCursor;
    } while (cursor);

    const aIds = (await prisma.transaction.findMany({ where: { userId: w.a.user.id } })).map((t) => t.id);
    expect(seen.sort()).toEqual(aIds.sort());
  });
});

// --- OWN-007: account deletion ---------------------------------------------------------------------

describe("OWN-007: deleting a user leaves nothing of theirs behind", () => {
  it("every owned row is removed, and the other user's rows are untouched", async () => {
    const w = await world();
    // A legacy-table row too: those tables still exist.
    await prisma.expense.create({
      data: {
        userId: w.b.user.id, categoryId: w.b.category.id, amount: 1, date: dateOf("2026-09-01"), month: MONTH,
      },
    });
    const aBefore = await snapshotOf(w.a.user.id);

    await prisma.user.delete({ where: { id: w.b.user.id } });

    const userId = w.b.user.id;
    const left = await Promise.all([
      prisma.transaction.count({ where: { userId } }),
      prisma.transaction.count({ where: { loanId: w.b.loan.id } }),
      prisma.loan.count({ where: { userId } }),
      prisma.category.count({ where: { userId } }),
      prisma.budget.count({ where: { userId } }),
      prisma.expense.count({ where: { userId } }),
      prisma.income.count({ where: { userId } }),
    ]);
    expect(left).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(await snapshotOf(w.a.user.id)).toBe(aBefore);
  });
});

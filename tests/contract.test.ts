import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { AddressInfo } from "net";
import { Server } from "http";
import { z } from "zod";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/config/env";
import { createApp } from "../src/app";
import { signToken } from "../src/utils/jwt";
import { currentMonth } from "./helpers/factories";

/**
 * API contract (CON-001, CON-002). The schemas below mirror `mobile/src/types/models.ts`: what the
 * installed app reads. A server change that breaks one of them breaks the app, so these must pass
 * before and after every dependency upgrade (M8). Extra fields are allowed; missing or retyped
 * ones are not. Deprecated fields stay required while older builds may still read them (NFR-2).
 */

// --- Schemas, mirroring mobile/src/types/models.ts ------------------------------------------

const isoDate = z.string().datetime({ offset: true });
const monthKey = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const money = z.number().finite();

const User = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().nullable(),
  currency: z.string(),
  avatarUrl: z.string().nullable(),
  createdAt: isoDate.nullable(),
  hasPassword: z.boolean(),
});
const AuthResponse = z.object({ token: z.string().min(1), user: User });

const Category = z.object({
  id: z.string().uuid(),
  name: z.string(),
  icon: z.string(),
  color: z.string(),
  isDefault: z.boolean(),
});

const Budget = z.object({ categoryId: z.string().uuid(), category: Category, amount: money });

const TransactionKind = z.enum(["SPEND", "EARN", "LEND_OUT", "COLLECT", "BORROW_IN", "REPAY"]);
const Transaction = z.object({
  id: z.string().uuid(),
  kind: TransactionKind,
  amount: money,
  date: isoDate,
  month: monthKey,
  description: z.string().nullable(),
  paymentMethod: z.string(),
  categoryId: z.string().uuid().nullable(),
  category: Category.nullable(),
  needWant: z.enum(["Need", "Want"]).nullable(),
  source: z.string().nullable(),
  sourceIcon: z.string().nullable(),
  sourceColor: z.string().nullable(),
  loanId: z.string().uuid().nullable(),
  createdAt: isoDate,
});
const TransactionPage = z.object({
  items: z.array(Transaction),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

const LoanType = z.enum(["LENT", "BORROWED"]);
const Loan = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  type: LoanType,
  personName: z.string(),
  amount: money,
  settledAmount: money,
  remainingAmount: money.optional(),
  dueDate: isoDate.nullable(),
  status: z.enum(["PENDING", "PARTIAL", "SETTLED"]),
  notes: z.string().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
const LoansSummary = z.object({
  totalLentPending: money,
  totalBorrowedPending: money,
  netBalance: money,
  totalLentOverall: money,
  totalBorrowedOverall: money,
  activeLentCount: z.number().int(),
  activeBorrowedCount: z.number().int(),
  totalActiveCount: z.number().int(),
});

const DashboardSummary = z.object({
  month: monthKey,
  cashOnHand: money,
  netWorth: money,
  openingCash: money,
  closingCash: money,
  openingNetWorth: money,
  closingNetWorth: money,
  netCashThisMonth: money,
  monthlyIncome: money,
  totalExpenses: money,
  savingsThisMonth: money,
  remainingBalance: money, // deprecated alias, still read by older builds
  plannedSavings: money,
  rolloverSavings: money,
  totalBudgeted: money,
  dailyAllowance: money,
  daysRemaining: z.number().int(),
  daysInMonth: z.number().int(),
  monthProgressPercentage: z.number(),
  spentPercentage: z.number(),
  pacingStatus: z.enum(["On Track", "Pacing Fast", "Over Budget"]),
  needsTotal: money,
  wantsTotal: money,
  needsPercentage: z.number(),
  wantsPercentage: z.number(),
  netDebtSnapshot: z.object({ totalLent: money, totalBorrowed: money, net: money }),
  upcomingObligations: z.array(
    z.object({
      id: z.string().uuid(),
      type: LoanType,
      personName: z.string(),
      remainingAmount: money,
      dueDate: isoDate,
      isOverdue: z.boolean(),
    })
  ),
  categoryBreakdown: z.array(
    z.object({ categoryId: z.string().uuid(), name: z.string(), color: z.string(), icon: z.string(), amount: money })
  ),
  budgetVsActual: z.array(
    z.object({
      categoryId: z.string().uuid(),
      name: z.string(),
      color: z.string(),
      icon: z.string(),
      budget: money,
      actual: money,
      remaining: money,
      status: z.enum(["On Track", "Over Budget"]),
    })
  ),
  trend: z.array(z.object({ month: monthKey, totalExpenses: money })),
});

// Legacy endpoints, kept for builds installed before the unified ledger (NFR-2).
const Expense = z.object({
  id: z.string().uuid(),
  categoryId: z.string().uuid(),
  category: Category,
  date: isoDate,
  month: monthKey,
  description: z.string().nullable(),
  amount: money,
  paymentMethod: z.string(),
  needWant: z.string(),
});
const Income = z.object({
  id: z.string().uuid(),
  date: isoDate,
  month: monthKey,
  source: z.string(),
  sourceIcon: z.string(),
  sourceColor: z.string(),
  description: z.string().nullable(),
  amount: money,
  paymentMethod: z.string(),
});
const IncomeSummary = z.object({ month: monthKey, totalIncome: money });
/** The legacy lists are pages, as the pre-ledger app's `api/expenses.ts` and `api/income.ts` read them. */
const legacyPage = (item: z.ZodTypeAny) => z.object({ items: z.array(item).min(1), hasMore: z.boolean() });

/** CON-002: every error body. */
const ErrorEnvelope = z.object({
  error: z.string().min(1),
  details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

// --- Harness -------------------------------------------------------------------------------

let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

async function call(method: string, path: string, opts: { token?: string; body?: object; raw?: string } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body || opts.raw ? { "content-type": "application/json" } : {}),
    },
    body: opts.raw ?? (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** Parses, and on failure names the endpoint and the fields that broke the contract. */
function expectShape(schema: z.ZodTypeAny, value: unknown, endpoint: string) {
  const result = schema.safeParse(value);
  const problems = result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  expect(problems, endpoint).toEqual([]);
}

/** Google, stubbed to vouch for one account. */
function googleSays(email: string, sub: string) {
  vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
    getPayload: () => ({ email, sub, email_verified: true, name: "Google User", iat: Math.floor(Date.now() / 1000) }),
  } as never);
}

// --- CON-001 -------------------------------------------------------------------------------

describe("CON-001: every endpoint the app calls returns the shape the app reads", () => {
  const saved = {
    brevoApiKey: env.brevoApiKey,
    mailFromEmail: env.mailFromEmail,
    googleClientIdWeb: env.googleClientIdWeb,
    requireEmailVerification: env.requireEmailVerification,
  };
  let codes: string[];

  beforeEach(() => {
    env.brevoApiKey = "test-key";
    env.mailFromEmail = "codes@example.com";
    env.googleClientIdWeb = "test-client-id";
    env.requireEmailVerification = true;
    codes = [];
    // Only Brevo is stubbed: the test's own requests must still reach the server.
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (!String(url).includes("api.brevo.com")) return realFetch(url, init);
      const payload = JSON.parse(String(init?.body));
      codes.push(payload.htmlContent.match(/letter-spacing: 8px;[^>]*>(\d{6})</)[1]);
      return new Response(JSON.stringify({ messageId: "<m>" }), { status: 201 });
    });
  });

  afterEach(() => {
    env.brevoApiKey = saved.brevoApiKey;
    env.mailFromEmail = saved.mailFromEmail;
    env.googleClientIdWeb = saved.googleClientIdWeb;
    env.requireEmailVerification = saved.requireEmailVerification;
    vi.restoreAllMocks();
  });

  it("auth: send-otp, register, login, google, me, profile, password", async () => {
    const email = "contract@example.com";
    expect((await call("POST", "/auth/send-otp", { body: { email } })).status).toBe(200);

    const reg = await call("POST", "/auth/register", {
      body: { email, password: "password123", name: "Contract", otp: codes[0] },
    });
    expect(reg.status).toBe(201);
    expectShape(AuthResponse, reg.json, "POST /auth/register");

    const login = await call("POST", "/auth/login", { body: { email, password: "password123" } });
    expect(login.status).toBe(200);
    expectShape(AuthResponse, login.json, "POST /auth/login");
    const token = login.json.token;

    expectShape(User, (await call("GET", "/auth/me", { token })).json, "GET /auth/me");

    const profile = await call("PATCH", "/auth/profile", { token, body: { name: "Renamed" } });
    expect(profile.status).toBe(200);
    expectShape(User, profile.json, "PATCH /auth/profile");

    const password = await call("PATCH", "/auth/password", {
      token,
      body: { currentPassword: "password123", newPassword: "password456" },
    });
    expect(password.status).toBe(200);
    expectShape(z.object({ token: z.string().min(1) }), password.json, "PATCH /auth/password");

    googleSays("g-contract@gmail.com", "g-contract");
    const google = await call("POST", "/auth/google", { body: { idToken: "t" } });
    expect(google.status).toBe(200);
    expectShape(AuthResponse, google.json, "POST /auth/google");
  });

  it("money: categories, budgets, transactions, loans, dashboard, and the legacy reads", async () => {
    googleSays("money@gmail.com", "g-money");
    const token = (await call("POST", "/auth/google", { body: { idToken: "t" } })).json.token;
    const month = currentMonth();

    expectShape(z.array(Category).min(1), (await call("GET", "/categories", { token })).json, "GET /categories");
    const created = await call("POST", "/categories", { token, body: { name: "Contract", icon: "tag", color: "#112233" } });
    expect(created.status).toBe(201);
    expectShape(Category, created.json, "POST /categories");
    const renamed = await call("PUT", `/categories/${created.json.id}`, { token, body: { name: "Contract 2" } });
    expectShape(Category, renamed.json, "PUT /categories/:id");
    const categoryId = created.json.id;

    const budget = await call("PUT", "/budgets", { token, body: { categoryId, amount: 5_000, month: month.key } });
    expect(budget.status).toBe(200);
    expectShape(Budget, budget.json, "PUT /budgets");
    expectShape(z.array(Budget).min(1), (await call("GET", `/budgets?month=${month.key}`, { token })).json, "GET /budgets");

    const spend = await call("POST", "/transactions", {
      token,
      body: { kind: "SPEND", amount: 1_200.5, date: month.day(1).toISOString(), categoryId, needWant: "Want", description: "Lunch" },
    });
    expect(spend.status).toBe(201);
    expectShape(Transaction, spend.json, "POST /transactions (SPEND)");
    const earn = await call("POST", "/transactions", {
      token,
      body: { kind: "EARN", amount: 50_000, date: month.day(1).toISOString(), source: "Salary" },
    });
    expectShape(Transaction, earn.json, "POST /transactions (EARN)");
    const patched = await call("PATCH", `/transactions/${spend.json.id}`, { token, body: { amount: 1_300 } });
    expectShape(Transaction, patched.json, "PATCH /transactions/:id");

    const loan = await call("POST", "/loans", {
      token,
      body: {
        type: "LENT",
        personName: "Ali",
        amount: 10_000,
        dueDate: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        notes: null,
      },
    });
    expect(loan.status).toBe(201);
    expectShape(Loan, loan.json, "POST /loans");
    const settled = await call("PATCH", `/loans/${loan.json.id}/settle`, { token, body: { paymentAmount: 2_500 } });
    expectShape(Loan, settled.json, "PATCH /loans/:id/settle");
    const edited = await call("PATCH", `/loans/${loan.json.id}`, { token, body: { personName: "Ali Khan" } });
    expectShape(Loan, edited.json, "PATCH /loans/:id");
    expectShape(z.array(Loan).min(1), (await call("GET", "/loans", { token })).json, "GET /loans");
    expectShape(LoansSummary, (await call("GET", "/loans/summary", { token })).json, "GET /loans/summary");

    // The loan's movements are in the list too, so the row shape is checked for those kinds as well.
    const page = await call("GET", `/transactions?month=${month.key}`, { token });
    expectShape(TransactionPage, page.json, "GET /transactions");
    expect(new Set(page.json.items.map((t: { kind: string }) => t.kind))).toEqual(
      new Set(["SPEND", "EARN", "LEND_OUT", "COLLECT"])
    );

    const dashboard = await call("GET", `/dashboard/summary?month=${month.key}`, { token });
    expectShape(DashboardSummary, dashboard.json, "GET /dashboard/summary");
    // Every array holds an item, so the item schemas were actually exercised.
    for (const key of ["upcomingObligations", "categoryBreakdown", "budgetVsActual", "trend"]) {
      expect(dashboard.json[key].length, `dashboard.${key}`).toBeGreaterThan(0);
    }

    expectShape(legacyPage(Expense), (await call("GET", `/expenses?month=${month.key}`, { token })).json, "GET /expenses");
    expectShape(legacyPage(Income), (await call("GET", `/income?month=${month.key}`, { token })).json, "GET /income");
    expectShape(IncomeSummary, (await call("GET", `/income/summary?month=${month.key}`, { token })).json, "GET /income/summary");

    // Deletes: the app only needs a 2xx.
    for (const path of [
      `/transactions/${spend.json.id}`,
      `/loans/${loan.json.id}`,
      `/budgets/${categoryId}?month=${month.key}`,
      `/categories/${categoryId}`,
    ]) {
      const res = await call("DELETE", path, { token });
      expect(res.status, `DELETE ${path}`).toBeGreaterThanOrEqual(200);
      expect(res.status, `DELETE ${path}`).toBeLessThan(300);
    }
  });
});

// --- CON-002 -------------------------------------------------------------------------------

describe("CON-002: every error is { error, details? }", () => {
  it("across validation, auth, not found, conflict, malformed JSON and a server fault", async () => {
    const user = await prisma.user.create({ data: { email: "errors@example.com" } });
    const token = signToken({ userId: user.id, tv: 0 });

    const cases: [string, number, Awaited<ReturnType<typeof call>>][] = [
      ["validation", 400, await call("POST", "/transactions", { token, body: { kind: "SPEND", amount: -1 } })],
      ["bad month", 400, await call("GET", "/income/summary?month=nope", { token })],
      ["malformed JSON", 400, await call("POST", "/transactions", { token, raw: "{nope" })],
      ["no session", 401, await call("GET", "/transactions")],
      ["bad session", 401, await call("GET", "/transactions", { token: "not-a-jwt" })],
      ["unknown row", 404, await call("DELETE", "/loans/00000000-0000-4000-8000-000000000000", { token })],
      ["unknown route", 404, await call("GET", "/nope", { token })],
      ["conflict", 409, await call("POST", "/auth/send-otp", { body: { email: "errors@example.com" } })],
    ];

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prisma.category, "findMany").mockRejectedValueOnce(new Error("secret internal detail"));
    const fault = await call("GET", "/categories", { token });
    expect(logged).toHaveBeenCalled();
    vi.restoreAllMocks();
    cases.push(["server fault", 500, fault]);

    for (const [name, status, res] of cases) {
      expect(res.status, name).toBe(status);
      expectShape(ErrorEnvelope, res.json, name);
    }
    // A validation failure says which field and why.
    expect(cases[0][2].json.details.length).toBeGreaterThan(0);
    // A server fault never leaks its internals.
    expect(JSON.stringify(fault.json)).not.toContain("secret internal detail");
  });
});

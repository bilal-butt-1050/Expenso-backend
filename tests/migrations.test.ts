import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { monthKeyInZone } from "../src/utils/date";
import { CASH_SIGN } from "../src/modules/transactions/transactions.service";
import { scratchDatabase, migrationSql, ALL_MIGRATIONS } from "./helpers/migrationDb";

/**
 * MIGRATION integrity (TEST_SPEC B5, MIG-001..013). A database is built from the real migrations
 * up to the last pre-ledger one, seeded with data in the old shape, then taken through every later
 * migration, as production was.
 */

const PRE_LEDGER = "20260912190000_loans_and_otp_baseline";
const LEDGER = "20260924094500_unified_transaction_ledger";
const TZ = "Asia/Karachi";

type Kind = keyof typeof CASH_SIGN;
interface Row {
  id: string;
  userId: string;
  kind: Kind;
  amount: Prisma.Decimal;
  date: Date;
  month: string;
  categoryId: string | null;
  needWant: string | null;
  source: string | null;
  sourceIcon: string | null;
  sourceColor: string | null;
  loanId: string | null;
}

// Seed, in the pre-ledger shape. Dates are UTC wall-clock, as Prisma stored them.
const EXPENSES = [
  { id: "e-mid", date: "2026-09-15 12:00", amount: 1234.56, description: "Groceries" },
  { id: "e-first", date: "2026-09-01 00:00", amount: 500, description: "Rent" }, // 05:00 PKT, Sep 1
  { id: "e-late", date: "2026-08-31 21:30", amount: 250, description: "Late dinner" }, // 02:30 PKT, Sep 1
  { id: "e-aug", date: "2026-08-31 18:00", amount: 80, description: "Snack" }, // 23:00 PKT, Aug 31
  { id: "e-float", date: "2026-09-10 12:00", amount: 0.1 + 0.2, description: "Float noise" }, // 0.30000000000000004
  { id: "e-cents", date: "2026-09-11 12:00", amount: 19.99, description: "Cents" },
  { id: "e-repay", date: "2026-09-20 12:00", amount: 1000, description: "Repayment to Bank" },
];
const INCOMES = [
  // The itemized-income migration dated the old monthly salary rows at midnight on the 1st.
  { id: "i-salary", date: "2026-09-01 00:00", amount: 150000, source: "Salary", description: "Monthly Salary" },
  { id: "i-ali", date: "2026-09-18 12:00", amount: 5000, source: "Other", description: "Repayment from Ali" },
  { id: "i-sara", date: "2026-09-19 12:00", amount: 700, source: "Other", description: "Repayment from Sara" },
];
const LOANS = [
  { id: "l-ali", type: "LENT", person: "Ali", amount: 5000, settled: 5000, status: "SETTLED", created: "2026-09-05 12:00" },
  { id: "l-bank", type: "BORROWED", person: "Bank", amount: 3000, settled: 1000, status: "PARTIAL", created: "2026-09-02 12:00" },
  { id: "l-sara1", type: "LENT", person: "Sara", amount: 1000, settled: 700, status: "PARTIAL", created: "2026-09-03 12:00" },
  { id: "l-sara2", type: "LENT", person: "Sara", amount: 2000, settled: 0, status: "PENDING", created: "2026-09-04 12:00" },
  { id: "l-first", type: "LENT", person: "Zed", amount: 100, settled: 0, status: "PENDING", created: "2026-09-01 00:00" },
];
const RELINKED: Record<string, { kind: Kind; loanId: string | string[] }> = {
  "e-repay": { kind: "REPAY", loanId: "l-bank" },
  "i-ali": { kind: "COLLECT", loanId: "l-ali" },
  "i-sara": { kind: "COLLECT", loanId: ["l-sara1", "l-sara2"] }, // MIG-008: either is acceptable
};

const utc = (s: string) => new Date(`${s.replace(" ", "T")}:00.000Z`);
const round2 = (n: number) => new Prisma.Decimal(n).toDecimalPlaces(2).toString();

let db: Awaited<ReturnType<typeof scratchDatabase>>;
let rows: Row[];
let checksumBefore: string;
let checksumAfter: string;

const checksum = async () => {
  const [r] = await db.client.$queryRawUnsafe<{ e: string; i: string }[]>(`
    SELECT (SELECT md5(string_agg(x::text, '|' ORDER BY x."id")) FROM "expenses" x) AS e,
           (SELECT md5(string_agg(x::text, '|' ORDER BY x."id")) FROM "incomes" x) AS i`);
  return `${r.e}/${r.i}`;
};

beforeAll(async () => {
  db = await scratchDatabase("expenso_test_mig");
  db.deployThrough(PRE_LEDGER);
  const q = (sql: string, ...values: unknown[]) => db.client.$executeRawUnsafe(sql, ...values);

  await q(`INSERT INTO "users" ("id", "email", "passwordHash") VALUES ('u1', 'one@test.local', 'x'), ('u2', 'empty@test.local', 'x')`);
  await q(`INSERT INTO "categories" ("id", "userId", "name") VALUES ('c1', 'u1', 'Food')`);
  for (const e of EXPENSES) {
    // The old code filed `month` in UTC.
    await q(
      `INSERT INTO "expenses" ("id", "userId", "categoryId", "date", "month", "description", "amount", "updatedAt")
       VALUES ($1, 'u1', 'c1', $2::timestamp, to_char($2::timestamp, 'YYYY-MM'), $3, $4, now())`,
      e.id, e.date, e.description, e.amount
    );
  }
  for (const i of INCOMES) {
    await q(
      `INSERT INTO "incomes" ("id", "userId", "date", "month", "source", "description", "amount", "updatedAt")
       VALUES ($1, 'u1', $2::timestamp, to_char($2::timestamp, 'YYYY-MM'), $3, $4, $5, now())`,
      i.id, i.date, i.source, i.description, i.amount
    );
  }
  for (const l of LOANS) {
    await q(
      `INSERT INTO "loans" ("id", "userId", "type", "personName", "amount", "settledAmount", "status", "createdAt", "updatedAt")
       VALUES ($1, 'u1', $2::"LoanType", $3, $4, $5, $6::"LoanStatus", $7::timestamp, $7::timestamp)`,
      l.id, l.type, l.person, l.amount, l.settled, l.status, l.created
    );
  }
  await q(`INSERT INTO "budgets" ("id", "userId", "categoryId", "amount", "month", "updatedAt") VALUES ('b1', 'u1', 'c1', 3333.33, '2026-09', now())`);

  checksumBefore = await checksum();
  db.deployThrough(); // the ledger migration and everything after it
  checksumAfter = await checksum();
  rows = await db.client.$queryRawUnsafe<Row[]>(`SELECT * FROM "transactions" ORDER BY "id"`);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const byId = (id: string) => rows.filter((r) => r.id === id);
const movementsOf = (loanId: string) => rows.filter((r) => r.loanId === loanId);

describe("MIG — the unified ledger migration, on data in the old shape", () => {
  it("MIG-001: every expense appears exactly once, same id and amount, as SPEND (or REPAY if re-linked)", () => {
    for (const e of EXPENSES) {
      const found = byId(e.id);
      expect(found, e.id).toHaveLength(1);
      expect(found[0].kind, e.id).toBe(RELINKED[e.id]?.kind ?? "SPEND");
      expect(found[0].amount.toString(), e.id).toBe(round2(e.amount));
    }
  });

  it("MIG-002: every income appears exactly once, same id and amount, as EARN (or COLLECT if re-linked)", () => {
    for (const i of INCOMES) {
      const found = byId(i.id);
      expect(found, i.id).toHaveLength(1);
      expect(found[0].kind, i.id).toBe(RELINKED[i.id]?.kind ?? "EARN");
      expect(found[0].amount.toString(), i.id).toBe(round2(i.amount));
    }
  });

  it("MIG-003: the source tables are untouched", () => {
    expect(checksumAfter).toBe(checksumBefore);
  });

  it("MIG-004: every pre-existing loan gets exactly one opening movement, for its amount, on its date", () => {
    for (const l of LOANS) {
      const opening = movementsOf(l.id).filter((r) => r.kind === (l.type === "LENT" ? "LEND_OUT" : "BORROW_IN"));
      expect(opening, l.id).toHaveLength(1);
      expect(opening[0].amount.toString(), l.id).toBe(round2(l.amount));
      expect(opening[0].date.toISOString(), l.id).toBe(utc(l.created).toISOString());
    }
  });

  it("MIG-005: a settled loan nets to zero cash", () => {
    const net = movementsOf("l-ali").reduce((t, r) => t.add(r.amount.mul(CASH_SIGN[r.kind])), new Prisma.Decimal(0));
    expect(net.toString()).toBe("0");
  });

  it("MIG-006: legacy repayment rows re-link to their loan as REPAY/COLLECT", () => {
    for (const [id, expected] of Object.entries(RELINKED)) {
      const [row] = byId(id);
      expect(row.kind, id).toBe(expected.kind);
      expect([expected.loanId].flat(), id).toContain(row.loanId);
    }
  });

  it("MIG-007: re-linked rows carry no leftover category or income source", () => {
    for (const id of Object.keys(RELINKED)) {
      const [row] = byId(id);
      expect([row.categoryId, row.needWant, row.source, row.sourceIcon, row.sourceColor], id).toEqual([null, null, null, null, null]);
    }
  });

  it("MIG-008: two loans with the same counterparty: attribution may be either, the cash total is exact", () => {
    const [sara] = byId("i-sara");
    expect(["l-sara1", "l-sara2"]).toContain(sara.loanId);

    const expected = new Prisma.Decimal(0)
      .sub(EXPENSES.reduce((t, e) => t.add(round2(e.amount)), new Prisma.Decimal(0)))
      .add(INCOMES.reduce((t, i) => t.add(round2(i.amount)), new Prisma.Decimal(0)))
      .sub(LOANS.filter((l) => l.type === "LENT").reduce((t, l) => t + l.amount, 0))
      .add(LOANS.filter((l) => l.type === "BORROWED").reduce((t, l) => t + l.amount, 0));
    const cash = rows.reduce((t, r) => t.add(r.amount.mul(CASH_SIGN[r.kind])), new Prisma.Decimal(0));
    expect(cash.toString()).toBe(expected.toString());
  });

  it("MIG-009: re-running the backfill fails on the primary key instead of duplicating the ledger", async () => {
    const sql = readFileSync(migrationSql(LEDGER), "utf8");
    const backfill = sql.slice(sql.indexOf("-- 2. Backfill"), sql.indexOf("-- 3. Re-link"));
    const dir = mkdtempSync(join(tmpdir(), "expenso-mig9-"));
    const file = join(dir, "backfill.sql");
    writeFileSync(file, backfill);
    try {
      expect(() => db.runSqlFile(file)).toThrow(/P2002|unique constraint|duplicate key/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const [{ n }] = await db.client.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "transactions"`);
    expect(Number(n)).toBe(rows.length);
  });

  it("MIG-010: every month is the user's local month (Karachi), not UTC's", () => {
    const expectations: [string, string][] = [
      ["e-first", "2026-09"], // 05:00 on Sep 1 in Karachi
      ["e-late", "2026-09"], // 02:30 on Sep 1 in Karachi
      ["e-aug", "2026-08"], // 23:00 on Aug 31 in Karachi
      ["i-salary", "2026-09"],
    ];
    for (const [id, month] of expectations) expect(byId(id)[0].month, id).toBe(month);
    expect(movementsOf("l-first")[0].month, "l-first opening").toBe("2026-09");

    const wrong = rows.filter((r) => r.month !== monthKeyInZone(r.date, TZ)).map((r) => `${r.id}: ${r.month}`);
    expect(wrong).toEqual([]);
  });

  it("MIG-011: Float → Decimal is exact for every value", async () => {
    expect(byId("e-float")[0].amount.toString()).toBe("0.3");
    expect(byId("e-cents")[0].amount.toString()).toBe("19.99");
    const [budget] = await db.client.$queryRawUnsafe<{ amount: Prisma.Decimal }[]>(`SELECT "amount" FROM "budgets" WHERE "id" = 'b1'`);
    expect(budget.amount.toString()).toBe("3333.33");
    const loans = await db.client.$queryRawUnsafe<{ id: string; amount: Prisma.Decimal; settledAmount: Prisma.Decimal }[]>(
      `SELECT "id", "amount", "settledAmount" FROM "loans"`
    );
    for (const l of LOANS) {
      const row = loans.find((x) => x.id === l.id)!;
      expect([row.amount.toString(), row.settledAmount.toString()], l.id).toEqual([round2(l.amount), round2(l.settled)]);
    }
  });

  it("MIG-013: a user with no transactions migrates cleanly", async () => {
    const [u2] = await db.client.$queryRawUnsafe<{ timezone: string; tokenVersion: number }[]>(
      `SELECT "timezone", "tokenVersion" FROM "users" WHERE "id" = 'u2'`
    );
    expect(u2).toEqual({ timezone: TZ, tokenVersion: 0 });
    expect(rows.filter((r) => r.userId === "u2")).toEqual([]);
  });
});

describe("MIG-012: migrating an empty database", () => {
  it("succeeds, and applies every migration", async () => {
    const empty = await scratchDatabase("expenso_test_mig_empty");
    try {
      empty.deployThrough(PRE_LEDGER);
      empty.deployThrough();
      const applied = await empty.client.$queryRawUnsafe<{ migration_name: string }[]>(
        `SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL ORDER BY 1`
      );
      expect(applied.map((m) => m.migration_name)).toEqual(ALL_MIGRATIONS);
    } finally {
      await empty.drop();
    }
  }, 120_000);
});

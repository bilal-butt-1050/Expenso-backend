import { Prisma, TransactionKind } from "@prisma/client";
import { prisma } from "../../src/lib/prisma";
import { DEFAULT_CATEGORIES } from "../../src/modules/auth/auth.service";
import { monthKeyInZone } from "../../src/utils/date";

/** Deterministic fixtures. No randomness unless a test asks for it explicitly. */

export async function makeUser(
  overrides: { email?: string; timezone?: string; currency?: string } = {}
) {
  const email = overrides.email ?? `user-${Math.random().toString(36).slice(2, 10)}@test.local`;
  return prisma.user.create({
    data: {
      email,
      name: "Test User",
      passwordHash: "$2a$10$notarealhashnotarealhashnotarealhashnotarealhash",
      timezone: overrides.timezone ?? "Asia/Karachi",
      currency: overrides.currency ?? "PKR",
      categories: { create: DEFAULT_CATEGORIES.map((c) => ({ ...c, isDefault: true })) },
    },
    include: { categories: true },
  });
}

export async function categoryFor(userId: string, name = "Food") {
  const category = await prisma.category.findFirst({ where: { userId, name } });
  if (!category) throw new Error(`No category "${name}" for user ${userId}`);
  return category;
}

/** A date at noon in the given zone, so a test never straddles a month boundary by accident. */
export function dateOf(iso: string): Date {
  return new Date(`${iso}T12:00:00.000Z`);
}

export async function makeTransaction(opts: {
  userId: string;
  kind: TransactionKind;
  amount: number | string;
  date: Date;
  categoryId?: string;
  source?: string;
  loanId?: string;
  timezone?: string;
  description?: string;
}) {
  const tz = opts.timezone ?? "Asia/Karachi";
  return prisma.transaction.create({
    data: {
      userId: opts.userId,
      kind: opts.kind,
      amount: new Prisma.Decimal(opts.amount),
      date: opts.date,
      month: monthKeyInZone(opts.date, tz),
      categoryId: opts.kind === "SPEND" ? opts.categoryId ?? null : null,
      needWant: opts.kind === "SPEND" ? "Need" : null,
      source: opts.kind === "EARN" ? opts.source ?? "Salary" : null,
      loanId: opts.loanId ?? null,
      description: opts.description ?? null,
    },
  });
}

export async function spend(userId: string, amount: number, date: Date, categoryId?: string) {
  const cat = categoryId ?? (await categoryFor(userId)).id;
  return makeTransaction({ userId, kind: "SPEND", amount, date, categoryId: cat });
}

export async function earn(userId: string, amount: number, date: Date) {
  return makeTransaction({ userId, kind: "EARN", amount, date });
}

/** Creates a loan directly, bypassing the service, so tests can control `createdAt`. */
export async function makeLoan(opts: {
  userId: string;
  type: "LENT" | "BORROWED";
  amount: number | string;
  createdAt?: Date;
  personName?: string;
  dueDate?: Date | null;
  withOpeningMovement?: boolean;
}) {
  const createdAt = opts.createdAt ?? new Date();
  const loan = await prisma.loan.create({
    data: {
      userId: opts.userId,
      type: opts.type,
      personName: opts.personName ?? "Counterparty",
      amount: new Prisma.Decimal(opts.amount),
      settledAmount: new Prisma.Decimal(0),
      status: "PENDING",
      dueDate: opts.dueDate ?? null,
      createdAt,
      updatedAt: createdAt,
    },
  });

  if (opts.withOpeningMovement !== false) {
    await makeTransaction({
      userId: opts.userId,
      kind: opts.type === "LENT" ? "LEND_OUT" : "BORROW_IN",
      amount: opts.amount,
      date: createdAt,
      loanId: loan.id,
    });
  }

  return loan;
}

export const money = (v: number | string) => new Prisma.Decimal(v);

/** Adds `n` months to a `YYYY-MM` key. */
export function addMonths(key: string, n: number): string {
  const [y, m] = key.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The real current month in the fixtures' zone, for code that stamps rows with "now" (a new loan
 * and its opening movement). `day(d)` is noon on day d of it; `plusMonths(n)` is a later month key.
 */
export function currentMonth() {
  const key = monthKeyInZone(new Date(), "Asia/Karachi");
  const [y, m] = key.split("-").map(Number);
  return {
    key,
    lastDay: new Date(Date.UTC(y, m, 0)).getUTCDate(),
    day: (d: number) => dateOf(`${key}-${String(d).padStart(2, "0")}`),
    plusMonths: (n: number) => addMonths(key, n),
  };
}

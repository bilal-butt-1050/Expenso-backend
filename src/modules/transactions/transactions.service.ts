import { Prisma, TransactionKind } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../utils/asyncHandler";
import { invalidateUserDashboard } from "../../lib/cache";
import { monthKeyInZone } from "../../utils/date";
import { money, toNumber } from "../../utils/money";

/**
 * The unified ledger.
 *
 * Every movement of money is one row with a `kind`. Cash on hand sums all kinds; spending
 * analytics read SPEND only. See the enum docs in schema.prisma for the full table.
 */

/** Kinds the user creates directly. The rest are written by the loan lifecycle. */
export const MANUAL_KINDS = ["SPEND", "EARN"] as const;
export type ManualKind = (typeof MANUAL_KINDS)[number];

/** Kinds owned by a loan — never created or deleted on their own. */
export const LOAN_KINDS: TransactionKind[] = ["LEND_OUT", "COLLECT", "BORROW_IN", "REPAY"];

/** Which direction each kind moves cash. */
export const CASH_SIGN: Record<TransactionKind, 1 | -1> = {
  SPEND: -1,
  EARN: 1,
  LEND_OUT: -1,
  COLLECT: 1,
  BORROW_IN: 1,
  REPAY: -1,
};

export interface CreateTransactionInput {
  kind: ManualKind;
  amount: number;
  date: Date;
  description?: string;
  paymentMethod?: string;
  categoryId?: string;
  needWant?: "Need" | "Want";
  source?: string;
  sourceIcon?: string;
  sourceColor?: string;
}

export interface ListFilters {
  month?: string;
  kinds?: TransactionKind[];
  categoryId?: string;
  limit?: number;
  /** Opaque keyset cursor from a previous page. */
  cursor?: string;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

// --- serialization -----------------------------------------------------------------------

type TransactionRow = Prisma.TransactionGetPayload<{ include: { category: true } }>;

/**
 * Prisma returns `Decimal` objects, which JSON-encode as strings. Every amount crosses the wire
 * as a `number`, so the conversion happens here rather than being remembered per-endpoint.
 */
export function serializeTransaction(t: TransactionRow) {
  return {
    id: t.id,
    kind: t.kind,
    amount: toNumber(t.amount),
    date: t.date.toISOString(),
    month: t.month,
    description: t.description,
    paymentMethod: t.paymentMethod,
    categoryId: t.categoryId,
    category: t.category
      ? {
          id: t.category.id,
          name: t.category.name,
          icon: t.category.icon,
          color: t.category.color,
          isDefault: t.category.isDefault,
        }
      : null,
    needWant: t.needWant,
    source: t.source,
    sourceIcon: t.sourceIcon,
    sourceColor: t.sourceColor,
    loanId: t.loanId,
    createdAt: t.createdAt.toISOString(),
  };
}

// --- keyset pagination -------------------------------------------------------------------

/**
 * Cursors encode (date, id) rather than an offset. Dates are day-level, so ties are the norm and
 * `skip`/`take` over `ORDER BY date DESC` silently duplicated and dropped rows between pages.
 */
function encodeCursor(date: Date, id: string): string {
  return Buffer.from(`${date.toISOString()}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { date: Date; id: string } {
  try {
    const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    const date = new Date(iso);
    if (!id || Number.isNaN(date.getTime())) throw new Error("malformed");
    return { date, id };
  } catch {
    throw new AppError(400, "Invalid pagination cursor");
  }
}

// --- reads -------------------------------------------------------------------------------

export async function listTransactions(userId: string, filters: ListFilters) {
  const limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const where: Prisma.TransactionWhereInput = { userId };
  if (filters.month) where.month = filters.month;
  if (filters.kinds?.length) where.kind = { in: filters.kinds };
  if (filters.categoryId) where.categoryId = filters.categoryId;

  if (filters.cursor) {
    const { date, id } = decodeCursor(filters.cursor);
    // Strictly "after" the cursor in (date desc, id desc) order.
    where.OR = [{ date: { lt: date } }, { date, id: { lt: id } }];
  }

  const rows = await prisma.transaction.findMany({
    where,
    include: { category: true },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    items: items.map(serializeTransaction),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last.date, last.id) : null,
  };
}

// --- writes ------------------------------------------------------------------------------

async function assertCategoryOwnership(userId: string, categoryId: string) {
  const category = await prisma.category.findFirst({ where: { id: categoryId, userId } });
  if (!category) throw new AppError(400, "Invalid category");
}

async function getUserTimezone(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  return user?.timezone ?? "Asia/Karachi";
}

export async function createTransaction(userId: string, input: CreateTransactionInput) {
  if (input.kind === "SPEND") {
    if (!input.categoryId) throw new AppError(400, "A category is required for an expense");
    await assertCategoryOwnership(userId, input.categoryId);
  }
  if (input.kind === "EARN" && !input.source) {
    throw new AppError(400, "A source is required for income");
  }

  const timezone = await getUserTimezone(userId);

  const created = await prisma.transaction.create({
    data: {
      userId,
      kind: input.kind,
      amount: money(input.amount),
      date: input.date,
      month: monthKeyInZone(input.date, timezone),
      description: input.description ?? null,
      paymentMethod: input.paymentMethod ?? (input.kind === "EARN" ? "Bank Transfer" : "Cash"),
      categoryId: input.kind === "SPEND" ? input.categoryId! : null,
      needWant: input.kind === "SPEND" ? input.needWant ?? "Need" : null,
      source: input.kind === "EARN" ? input.source! : null,
      sourceIcon: input.kind === "EARN" ? input.sourceIcon ?? "cash-multiple" : null,
      sourceColor: input.kind === "EARN" ? input.sourceColor ?? "#10B981" : null,
    },
    include: { category: true },
  });

  invalidateUserDashboard(userId);
  return serializeTransaction(created);
}

/**
 * Loan-linked rows are owned by their loan's lifecycle. Editing one by hand would desynchronise
 * it from `settledAmount` — the exact silent divergence that used to happen when a user deleted
 * an auto-generated "Loan Repayment" expense and the loan stayed marked SETTLED.
 */
async function assertManualTransaction(userId: string, id: string) {
  const existing = await prisma.transaction.findFirst({ where: { id, userId } });
  if (!existing) throw new AppError(404, "Transaction not found");

  if (existing.loanId) {
    throw new AppError(
      409,
      "This entry belongs to a loan. Manage it from the loan itself so the balance stays correct."
    );
  }
  return existing;
}

export async function updateTransaction(
  userId: string,
  id: string,
  input: Partial<CreateTransactionInput>
) {
  const existing = await assertManualTransaction(userId, id);

  if (input.categoryId) await assertCategoryOwnership(userId, input.categoryId);

  const data: Prisma.TransactionUpdateInput = {};
  if (input.amount !== undefined) data.amount = money(input.amount);
  if (input.description !== undefined) data.description = input.description || null;
  if (input.paymentMethod !== undefined) data.paymentMethod = input.paymentMethod;

  if (input.date !== undefined) {
    const timezone = await getUserTimezone(userId);
    data.date = input.date;
    data.month = monthKeyInZone(input.date, timezone);
  }

  if (existing.kind === "SPEND") {
    if (input.categoryId !== undefined) data.category = { connect: { id: input.categoryId } };
    if (input.needWant !== undefined) data.needWant = input.needWant;
  }
  if (existing.kind === "EARN") {
    if (input.source !== undefined) data.source = input.source;
    if (input.sourceIcon !== undefined) data.sourceIcon = input.sourceIcon;
    if (input.sourceColor !== undefined) data.sourceColor = input.sourceColor;
  }

  const updated = await prisma.transaction.update({
    where: { id },
    data,
    include: { category: true },
  });

  invalidateUserDashboard(userId);
  return serializeTransaction(updated);
}

export async function deleteTransaction(userId: string, id: string) {
  await assertManualTransaction(userId, id);
  await prisma.transaction.delete({ where: { id } });
  invalidateUserDashboard(userId);
}

import { Prisma, TransactionKind } from "@prisma/client";
import { assertNotBeforeJoin } from "../../lib/joinDate";
import { prisma } from "../../lib/prisma";
import { inSerializableTransaction } from "../../lib/serializable";
import { AppError } from "../../utils/asyncHandler";
import { invalidateUserDashboard } from "../../lib/cache";
import { DEFAULT_TIMEZONE, monthKeyInZone, startOfTomorrowInZone } from "../../utils/date";
import { money, round2, toNumber } from "../../utils/money";
import { MAX_AMOUNT } from "../../utils/validation";
import { applyLoanChanges, createLoanIn, paymentCount } from "../loans/loans.service";

/**
 * The unified ledger.
 *
 * Every movement of money is one row with a `kind`. Cash on hand sums the rows that moved cash
 * (`movesCash`); spending analytics read SPEND only, whoever paid. See the enum docs in
 * schema.prisma for the full table.
 */

/** Kinds the user creates directly. The rest are written by the loan lifecycle. */
export const MANUAL_KINDS = ["SPEND", "EARN"] as const;
export type ManualKind = (typeof MANUAL_KINDS)[number];

/** Kinds owned by a loan — never created or deleted on their own. */
export const LOAN_KINDS: TransactionKind[] = ["LEND_OUT", "COLLECT", "BORROW_IN", "REPAY"];

/** Which direction each kind moves cash. ADJUST carries its own sign in its amount. */
export const CASH_SIGN: Record<TransactionKind, 1 | -1> = {
  SPEND: -1,
  EARN: 1,
  LEND_OUT: -1,
  COLLECT: 1,
  BORROW_IN: 1,
  REPAY: -1,
  ADJUST: 1,
};

/**
 * An expense that involves someone else (Bilal, 2026-10-02). The expense's `amount` is always the
 * user's own share, which is what counts as spending.
 * - `paidBy`: they paid it; the user owes them `amount`, and no cash moved.
 * - `split`: the user paid it all; `share` is theirs, so they owe the user that much.
 */
export interface SharingInput {
  paidBy?: { personName: string } | null;
  split?: { personName: string; share: number } | null;
}

export interface CreateTransactionInput extends SharingInput {
  /**
   * Client-generated UUID (optional). Makes the create idempotent: an offline write replayed after
   * a timeout returns the row it already created instead of a duplicate (ARCH N7.3).
   */
  id?: string;
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

const TX_INCLUDE = {
  category: true,
  loan: { select: { personName: true, type: true, amount: true } },
} satisfies Prisma.TransactionInclude;

// --- serialization -----------------------------------------------------------------------

type TransactionRow = Prisma.TransactionGetPayload<{ include: typeof TX_INCLUDE }>;

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
    /** False when the user's cash didn't change (see `Transaction.movesCash`). */
    movesCash: t.movesCash,
    /** For an expense: who else was involved. Null for everything else. */
    paidBy: t.kind === "SPEND" && t.loan?.type === "BORROWED" ? { personName: t.loan.personName } : null,
    split:
      t.kind === "SPEND" && t.loan?.type === "LENT"
        ? { personName: t.loan.personName, share: toNumber(t.loan.amount) }
        : null,
    /** For a loan movement: the person on the other side. */
    personName: t.loan?.personName ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}

// --- keyset pagination -------------------------------------------------------------------

/**
 * Cursors encode (date, id) rather than an offset. Dates are day-level, so ties are the norm and
 * `skip`/`take` over `ORDER BY date DESC` silently duplicated and dropped rows between pages.
 */
function encodeCursor(date: Date, createdAt: Date, id: string): string {
  return Buffer.from(`${date.toISOString()}|${createdAt.toISOString()}|${id}`).toString("base64url");
}

/** `createdAt` is null for a cursor issued before it was part of the order (date|id). */
function decodeCursor(cursor: string): { date: Date; createdAt: Date | null; id: string } {
  try {
    const parts = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    const [iso, createdIso, id] = parts.length === 2 ? [parts[0], null, parts[1]] : parts;
    const date = new Date(iso);
    const createdAt = createdIso === null ? null : new Date(createdIso);
    if (!id || Number.isNaN(date.getTime()) || (createdAt && Number.isNaN(createdAt.getTime()))) {
      throw new Error("malformed");
    }
    return { date, createdAt, id };
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
    const { date, createdAt, id } = decodeCursor(filters.cursor);
    // Strictly "after" the cursor in (date desc, createdAt desc, id desc) order.
    where.OR = createdAt
      ? [{ date: { lt: date } }, { date, createdAt: { lt: createdAt } }, { date, createdAt, id: { lt: id } }]
      : [{ date: { lt: date } }, { date, id: { lt: id } }];
  }

  // A picked day is saved at 12:00, so a day's entries share a date: the newest recorded comes first.
  const rows = await prisma.transaction.findMany({
    where,
    include: TX_INCLUDE,
    orderBy: [{ date: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    items: items.map(serializeTransaction),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last.date, last.createdAt, last.id) : null,
  };
}

/**
 * Cash today from the ledger, without the opening balance: every earlier month, plus this month's
 * rows dated before the start of tomorrow, counting only rows that moved cash. The same rule as the
 * dashboard's Cash available for the current month, so a figure built on it lands exactly there.
 */
export async function ledgerCashToday(tx: Prisma.TransactionClient, userId: string, timezone: string) {
  const now = new Date();
  const currentMonth = monthKeyInZone(now, timezone);
  const cutoff = startOfTomorrowInZone(now, timezone);
  const byKind = await tx.transaction.groupBy({
    by: ["kind"],
    where: {
      userId,
      movesCash: true,
      OR: [{ month: { lt: currentMonth } }, { month: currentMonth, date: { lt: cutoff } }],
    },
    _sum: { amount: true },
  });
  return byKind.reduce((total, row) => total.add((row._sum.amount ?? money(0)).mul(CASH_SIGN[row.kind])), money(0));
}

// --- writes ------------------------------------------------------------------------------

async function assertCategoryOwnership(db: Prisma.TransactionClient | typeof prisma, userId: string, categoryId: string) {
  const category = await db.category.findFirst({ where: { id: categoryId, userId } });
  if (!category) throw new AppError(400, "Invalid category");
}

type Sharing =
  | { mode: "PAID_BY"; personName: string }
  | { mode: "SPLIT"; personName: string; share: Prisma.Decimal }
  | null;

/** The sharing a request asks for. Both at once is refused. */
function requestedSharing(input: SharingInput): Sharing {
  if (input.paidBy && input.split) throw new AppError(400, "An expense is either paid by someone else or split, not both");
  if (input.paidBy) return { mode: "PAID_BY", personName: input.paidBy.personName.trim() };
  if (input.split) return { mode: "SPLIT", personName: input.split.personName.trim(), share: money(input.split.share) };
  return null;
}

/** The loan an expense's sharing becomes: they paid = the user borrowed; split = the user lent. */
function loanFor(sharing: NonNullable<Sharing>, ownShare: Prisma.Decimal) {
  return sharing.mode === "PAID_BY"
    ? { type: "BORROWED" as const, amount: ownShare, movesCash: false, opening: false }
    : { type: "LENT" as const, amount: sharing.share, movesCash: true, opening: true };
}

export async function createTransaction(userId: string, input: CreateTransactionInput) {
  return (await createOrReplayTransaction(userId, input)).transaction;
}

/**
 * Creates the transaction, or, when a client `id` was already used by this user, returns that row
 * untouched with `replayed: true`. An `id` held by anyone else is a generic 409 that reveals nothing
 * about the row (OWN-008).
 *
 * The replay check comes before validation on purpose: a replay whose category was deleted in the
 * meantime must still return the row that was saved, not fail validation.
 *
 * An expense paid by someone else or split also creates its loan, in the same database transaction.
 */
export async function createOrReplayTransaction(
  userId: string,
  input: CreateTransactionInput
): Promise<{ transaction: ReturnType<typeof serializeTransaction>; replayed: boolean }> {
  if (input.id) {
    const existing = await findOwnTransaction(userId, input.id);
    if (existing) return { transaction: serializeTransaction(existing), replayed: true };
  }

  const sharing = requestedSharing(input);
  if (sharing && input.kind !== "SPEND") {
    throw new AppError(400, "Only an expense can be paid by someone else or split");
  }
  if (input.kind === "SPEND") {
    if (!input.categoryId) throw new AppError(400, "A category is required for an expense");
    await assertCategoryOwnership(prisma, userId, input.categoryId);
  }
  if (input.kind === "EARN" && !input.source) {
    throw new AppError(400, "A source is required for income");
  }

  const timezone = await assertNotBeforeJoin(prisma, userId, input.date);
  const month = monthKeyInZone(input.date, timezone);
  const amount = money(input.amount);

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      let loanId: string | null = null;
      if (sharing) {
        const loan = loanFor(sharing, amount);
        loanId = await createLoanIn(
          tx,
          userId,
          { type: loan.type, personName: sharing.personName, amount: loan.amount, date: input.date, month, movesCash: loan.movesCash },
          loan.opening,
        );
      }
      return tx.transaction.create({
        data: {
          ...(input.id ? { id: input.id } : {}),
          userId,
          kind: input.kind,
          amount,
          date: input.date,
          month,
          description: input.description ?? null,
          paymentMethod: input.paymentMethod ?? (input.kind === "EARN" ? "Bank Transfer" : "Cash"),
          categoryId: input.kind === "SPEND" ? input.categoryId! : null,
          needWant: input.kind === "SPEND" ? input.needWant ?? "Need" : null,
          source: input.kind === "EARN" ? input.source! : null,
          sourceIcon: input.kind === "EARN" ? input.sourceIcon ?? "cash-multiple" : null,
          sourceColor: input.kind === "EARN" ? input.sourceColor ?? "#10B981" : null,
          // Someone else paid: the spending is the user's, the cash wasn't.
          movesCash: sharing?.mode !== "PAID_BY",
          loanId,
        },
        include: TX_INCLUDE,
      });
    });
  } catch (error) {
    // Lost a race with a concurrent replay of the same id, or the id is someone else's.
    if (input.id && isPrimaryKeyConflict(error)) {
      const existing = await findOwnTransaction(userId, input.id);
      if (existing) return { transaction: serializeTransaction(existing), replayed: true };
      throw new AppError(409, "Conflict");
    }
    throw error;
  }

  invalidateUserDashboard(userId);
  return { transaction: serializeTransaction(created), replayed: false };
}

function findOwnTransaction(userId: string, id: string) {
  return prisma.transaction.findFirst({ where: { id, userId }, include: TX_INCLUDE });
}

function isPrimaryKeyConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  const target = error.meta?.target;
  return Array.isArray(target) ? target.includes("id") : String(target ?? "").includes("pkey");
}

/**
 * Loan movements are owned by their loan's lifecycle. Editing one by hand would desynchronise it
 * from `settledAmount` — the exact silent divergence that used to happen when a user deleted an
 * auto-generated "Loan Repayment" expense and the loan stayed marked SETTLED. An expense that
 * carries a loan is the exception: it's edited here, and its loan follows.
 */
const LOAN_OWNED_MESSAGE = "This entry belongs to a loan. Manage it from the loan itself so the balance stays correct.";

export async function updateTransaction(
  userId: string,
  id: string,
  input: Partial<CreateTransactionInput>
) {
  const updated = await inSerializableTransaction(async (tx) => {
    const existing = await tx.transaction.findFirst({ where: { id, userId }, include: { loan: true } });
    if (!existing) throw new AppError(404, "Transaction not found");
    if (existing.kind === "ADJUST") {
      throw new AppError(409, "A balance correction can't be edited. Delete it and correct your balance again.");
    }
    if (existing.loanId && existing.kind !== "SPEND") throw new AppError(409, LOAN_OWNED_MESSAGE);
    if (input.categoryId) await assertCategoryOwnership(tx, userId, input.categoryId);

    const data: Prisma.TransactionUpdateInput = {};
    if (input.amount !== undefined) data.amount = money(input.amount);
    if (input.description !== undefined) data.description = input.description || null;
    if (input.paymentMethod !== undefined) data.paymentMethod = input.paymentMethod;

    const date = input.date ?? existing.date;
    const timezone = await assertNotBeforeJoin(tx, userId, date, existing.date);
    if (input.date !== undefined) {
      data.date = input.date;
      data.month = monthKeyInZone(input.date, timezone);
    }

    if (existing.kind === "SPEND") {
      if (input.categoryId !== undefined) data.category = { connect: { id: input.categoryId } };
      if (input.needWant !== undefined) data.needWant = input.needWant;
      await syncSharing(tx, userId, existing, input, data, { date, month: monthKeyInZone(date, timezone) });
    } else if (input.paidBy || input.split) {
      throw new AppError(400, "Only an expense can be paid by someone else or split");
    }
    if (existing.kind === "EARN") {
      if (input.source !== undefined) data.source = input.source;
      if (input.sourceIcon !== undefined) data.sourceIcon = input.sourceIcon;
      if (input.sourceColor !== undefined) data.sourceColor = input.sourceColor;
    }

    return tx.transaction.update({ where: { id }, data, include: TX_INCLUDE });
  });

  invalidateUserDashboard(userId);
  return serializeTransaction(updated);
}

/**
 * Keeps an expense's loan in step with the expense. Same kind of sharing: the loan follows the new
 * name, amount and date. A different kind (or none): the old loan goes and a new one is made, but
 * only while nothing has been repaid on it, so no repayment is ever lost silently.
 */
async function syncSharing(
  tx: Prisma.TransactionClient,
  userId: string,
  existing: { id: string; amount: Prisma.Decimal; loan: { id: string; type: string; personName: string; amount: Prisma.Decimal; settledAmount: Prisma.Decimal; date: Date } | null },
  input: Partial<CreateTransactionInput>,
  data: Prisma.TransactionUpdateInput,
  when: { date: Date; month: string },
) {
  const loan = existing.loan;
  const current: Sharing = !loan
    ? null
    : loan.type === "BORROWED"
      ? { mode: "PAID_BY", personName: loan.personName }
      : { mode: "SPLIT", personName: loan.personName, share: loan.amount };
  // Neither field sent (an older app): the sharing stays as it is.
  const wanted = input.paidBy === undefined && input.split === undefined ? current : requestedSharing(input);
  const ownShare = input.amount !== undefined ? money(input.amount) : existing.amount;

  if (loan && wanted && wanted.mode === current?.mode) {
    const target = loanFor(wanted, ownShare);
    await applyLoanChanges(tx, userId, loan, {
      personName: wanted.personName,
      amount: target.amount,
      date: input.date,
    });
  } else {
    if (loan) {
      if ((await paymentCount(tx, loan.id)) > 0) {
        throw new AppError(409, `${loan.personName} has already been paid back some of this. Remove those payments first.`);
      }
      // Detached first, so deleting the loan doesn't cascade to the expense itself.
      await tx.transaction.update({ where: { id: existing.id }, data: { loanId: null } });
      await tx.loan.delete({ where: { id: loan.id } });
    }
    if (wanted) {
      const target = loanFor(wanted, ownShare);
      const loanId = await createLoanIn(
        tx,
        userId,
        { type: target.type, personName: wanted.personName, amount: target.amount, date: when.date, month: when.month, movesCash: target.movesCash },
        target.opening,
      );
      data.loan = { connect: { id: loanId } };
    }
  }
  data.movesCash = wanted?.mode !== "PAID_BY";
}

export async function deleteTransaction(userId: string, id: string) {
  const existing = await prisma.transaction.findFirst({ where: { id, userId } });
  if (!existing) throw new AppError(404, "Transaction not found");
  if (existing.loanId) {
    if (existing.kind !== "SPEND") throw new AppError(409, LOAN_OWNED_MESSAGE);
    // An expense and the loan it made are one record: the cascade removes the expense, the loan's
    // movements and any repayments together.
    await prisma.loan.delete({ where: { id: existing.loanId } });
  } else {
    await prisma.transaction.delete({ where: { id } });
  }
  invalidateUserDashboard(userId);
}

/**
 * Corrects the balance to what the user actually has (Bilal, 2026-10-02): records the difference
 * as an ADJUST row dated now. It moves cash but is neither income nor spending, unlike the "balance
 * it out" income users entered by hand. Serializable, so the difference is taken against the
 * ledger as it stands at the write.
 */
export async function adjustBalance(userId: string, actualCash: number) {
  const created = await inSerializableTransaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { timezone: true, openingBalance: true } });
    if (!user) throw new AppError(404, "User not found");
    const timezone = user.timezone ?? DEFAULT_TIMEZONE;
    const current = (user.openingBalance ?? money(0)).add(await ledgerCashToday(tx, userId, timezone));
    const difference = round2(money(actualCash).sub(current));
    if (difference.isZero()) throw new AppError(400, "That's already your balance");
    if (difference.abs().greaterThan(MAX_AMOUNT)) throw new AppError(400, "That's too far from your balance");

    const now = new Date();
    return tx.transaction.create({
      data: {
        userId,
        kind: "ADJUST",
        amount: difference,
        date: now,
        month: monthKeyInZone(now, timezone),
        description: "Balance correction",
        paymentMethod: "Cash",
      },
      include: TX_INCLUDE,
    });
  });

  invalidateUserDashboard(userId);
  return serializeTransaction(created);
}

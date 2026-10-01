import { describe, it, expect, afterEach, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { createLoan, getLoansForMonth, settleLoan } from "../src/modules/loans/loans.service";
import { getDashboardSummary } from "../src/modules/dashboard/dashboard.service";
import { invalidateUserDashboard } from "../src/lib/cache";
import { makeUser } from "./helpers/factories";

/**
 * LNX: a loan that spans months (Bilal's report). Lent 2,000 on 15 Sep, got it back on 15 Oct.
 * Point in time: September's cash is 2,000 lower and 2,000 is still to come back at its end;
 * October's cash is back up and nothing is owed. Neither month counts the money twice.
 */

const pkt = (iso: string) => new Date(`${iso}+05:00`);

afterEach(() => {
  vi.useRealTimers();
});

async function accountSince(joined: string, opening: number) {
  const user = await makeUser();
  await prisma.user.update({
    where: { id: user.id },
    data: { createdAt: pkt(joined), openingBalance: new Prisma.Decimal(opening) },
  });
  return user;
}

describe("LNX: a loan across months", () => {
  it("LNX-001: lent in September, collected in October: each month's cash and debt are right", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(pkt("2026-09-15T15:00:00"));
    const user = await accountSince("2026-08-10T10:00:00", 10_000);
    const loan = await createLoan(user.id, {
      type: "LENT",
      personName: "Ali",
      amount: 2_000,
      date: pkt("2026-09-15T12:00:00"),
    });

    vi.setSystemTime(pkt("2026-10-15T15:00:00"));
    await settleLoan(user.id, loan.id);
    invalidateUserDashboard(user.id);

    const sep = await getDashboardSummary(user.id, "2026-09");
    const oct = await getDashboardSummary(user.id, "2026-10");
    expect({ sepCash: sep.closingCash, sepOwedToMe: sep.netDebtSnapshot.totalLent }).toEqual({
      sepCash: 8_000,
      sepOwedToMe: 2_000,
    });
    expect({ octOpen: oct.openingCash, octCash: oct.cashAvailable.amount, octOwedToMe: oct.netDebtSnapshot.totalLent }).toEqual({
      octOpen: 8_000,
      octCash: 10_000,
      octOwedToMe: 0,
    });

    // September says what happened since: all 2,000 came back, on 15 Oct.
    expect(sep.netDebtSnapshot.lentRepaidSince).toBe(2_000);
    expect(oct.netDebtSnapshot.lentRepaidSince).toBe(0);
    const [sepLoan] = await getLoansForMonth(user.id, "2026-09");
    expect(sepLoan.asOf).toMatchObject({ remainingAmount: 2_000, status: "PENDING", repaidSince: 2_000 });
    expect(sepLoan.asOf.settledOn?.slice(0, 10)).toBe("2026-10-15");
    const [octLoan] = await getLoansForMonth(user.id, "2026-10");
    expect(octLoan.asOf).toMatchObject({ status: "SETTLED", repaidSince: 0, settledOn: null });
  });

  // A loan saved without its cash movement means a debt from before joining: the money had already
  // left, so September doesn't drop, and getting it back is new cash in October. Saved that way for
  // a loan made after joining, it inflates October by 2,000: the app now asks the question plainly.
  it("LNX-002: a loan saved without its cash movement adds the money only when collected", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(pkt("2026-09-15T15:00:00"));
    const user = await accountSince("2026-08-10T10:00:00", 10_000);
    const loan = await createLoan(user.id, {
      type: "LENT",
      personName: "Ali",
      amount: 2_000,
      date: pkt("2026-09-15T12:00:00"),
      recordCashflow: false,
    });
    vi.setSystemTime(pkt("2026-10-15T15:00:00"));
    await settleLoan(user.id, loan.id);
    invalidateUserDashboard(user.id);

    const sep = await getDashboardSummary(user.id, "2026-09");
    const oct = await getDashboardSummary(user.id, "2026-10");
    expect({ sepCash: sep.closingCash, octCash: oct.cashAvailable.amount }).toEqual({ sepCash: 10_000, octCash: 12_000 });
  });
});

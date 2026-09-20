import { prisma } from "../../lib/prisma";
import { AppError } from "../../utils/asyncHandler";
import { toMonthKey } from "../../utils/date";
import { invalidateUserDashboard } from "../../lib/cache";

export interface CreateLoanInput {
  type: "LENT" | "BORROWED";
  personName: string;
  amount: number;
  dueDate?: string | null;
  notes?: string | null;
}

export interface UpdateLoanInput {
  personName?: string;
  amount?: number;
  dueDate?: string | null;
  notes?: string | null;
}

export async function getLoans(
  userId: string,
  filters?: { type?: "LENT" | "BORROWED"; status?: "PENDING" | "PARTIAL" | "SETTLED" }
) {
  const where: any = { userId };
  if (filters?.type) where.type = filters.type;
  if (filters?.status) where.status = filters.status;

  return prisma.loan.findMany({
    where,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
}

export async function getLoansSummary(userId: string) {
  const allLoans = await prisma.loan.findMany({
    where: { userId },
  });

  let totalLentPending = 0;
  let totalBorrowedPending = 0;
  let totalLentOverall = 0;
  let totalBorrowedOverall = 0;
  let activeLentCount = 0;
  let activeBorrowedCount = 0;

  for (const loan of allLoans) {
    const remaining = Math.max(0, loan.amount - loan.settledAmount);
    if (loan.type === "LENT") {
      totalLentOverall += loan.amount;
      if (loan.status !== "SETTLED") {
        totalLentPending += remaining;
        activeLentCount++;
      }
    } else {
      totalBorrowedOverall += loan.amount;
      if (loan.status !== "SETTLED") {
        totalBorrowedPending += remaining;
        activeBorrowedCount++;
      }
    }
  }

  return {
    totalLentPending,
    totalBorrowedPending,
    netBalance: totalLentPending - totalBorrowedPending,
    totalLentOverall,
    totalBorrowedOverall,
    activeLentCount,
    activeBorrowedCount,
    totalActiveCount: activeLentCount + activeBorrowedCount,
  };
}

export async function createLoan(userId: string, input: CreateLoanInput) {
  if (input.amount <= 0) {
    throw new AppError(400, "Amount must be greater than zero");
  }

  return prisma.loan.create({
    data: {
      userId,
      type: input.type,
      personName: input.personName.trim(),
      amount: input.amount,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      notes: input.notes?.trim() || null,
      status: "PENDING",
      settledAmount: 0,
    },
  });
}

export async function settleLoan(
  userId: string,
  loanId: string,
  paymentAmount?: number
) {
  const updatedLoan = await prisma.$transaction(async (tx) => {
    const loan = await tx.loan.findFirst({
      where: { id: loanId, userId },
    });

    if (!loan) {
      throw new AppError(404, "Loan record not found");
    }

    const remaining = Math.max(0, loan.amount - loan.settledAmount);

    if (loan.status === "SETTLED" || remaining <= 0) {
      throw new AppError(400, "Loan is already fully settled");
    }

    if (paymentAmount !== undefined && paymentAmount <= 0) {
      throw new AppError(400, "Payment amount must be greater than zero");
    }

    const requestedPayment =
      paymentAmount !== undefined ? paymentAmount : remaining;
    const actualPayment = Math.min(requestedPayment, remaining);

    const newSettled = Math.min(
      loan.amount,
      Math.round((loan.settledAmount + actualPayment) * 100) / 100
    );
    const newStatus = newSettled >= loan.amount ? "SETTLED" : "PARTIAL";

    const updated = await tx.loan.update({
      where: { id: loanId },
      data: {
        settledAmount: newSettled,
        status: newStatus,
      },
    });

    if (actualPayment > 0) {
      const now = new Date();
      const month = toMonthKey(now);

      if (loan.type === "BORROWED") {
        // Settling borrowed debt -> auto-create Expense
        let category = await tx.category.findFirst({
          where: { userId, name: "Bills" },
        });
        if (!category) {
          category = await tx.category.findFirst({
            where: { userId, name: "Other" },
          });
        }
        if (!category) {
          category = await tx.category.findFirst({
            where: { userId },
            orderBy: { createdAt: "asc" },
          });
        }
        if (!category) {
          category = await tx.category.create({
            data: {
              userId,
              name: "Bills",
              icon: "file-document",
              color: "#0EA5E9",
              isDefault: true,
            },
          });
        }

        await tx.expense.create({
          data: {
            userId,
            categoryId: category.id,
            date: now,
            month,
            description: `Loan repayment: ${loan.personName}`,
            amount: actualPayment,
            paymentMethod: "Cash",
            needWant: "Need",
            status: "Paid",
          },
        });
      } else {
        // Settling lent loan -> auto-create Income
        await tx.income.create({
          data: {
            userId,
            date: now,
            month,
            source: `Loan repayment: ${loan.personName}`,
            sourceIcon: "cash-multiple",
            sourceColor: "#00E676",
            description: `Loan repayment: ${loan.personName}`,
            amount: actualPayment,
            paymentMethod: "Cash",
          },
        });
      }
    }

    return updated;
  });

  invalidateUserDashboard(userId);
  return updatedLoan;
}

export async function updateLoan(
  userId: string,
  loanId: string,
  input: UpdateLoanInput
) {
  const loan = await prisma.loan.findFirst({
    where: { id: loanId, userId },
  });

  if (!loan) {
    throw new AppError(404, "Loan record not found");
  }

  const data: any = {};
  if (input.personName !== undefined) data.personName = input.personName.trim();
  if (input.amount !== undefined) {
    if (input.amount <= 0) throw new AppError(400, "Amount must be greater than zero");
    data.amount = input.amount;
    // Recalculate status if amount changes
    if (loan.settledAmount >= input.amount) {
      data.status = "SETTLED";
    } else if (loan.settledAmount > 0) {
      data.status = "PARTIAL";
    } else {
      data.status = "PENDING";
    }
  }
  if (input.dueDate !== undefined) {
    data.dueDate = input.dueDate ? new Date(input.dueDate) : null;
  }
  if (input.notes !== undefined) {
    data.notes = input.notes ? input.notes.trim() : null;
  }

  return prisma.loan.update({
    where: { id: loanId },
    data,
  });
}

export async function deleteLoan(userId: string, loanId: string) {
  const loan = await prisma.loan.findFirst({
    where: { id: loanId, userId },
  });

  if (!loan) {
    throw new AppError(404, "Loan record not found");
  }

  return prisma.loan.delete({
    where: { id: loanId },
  });
}

# Product Brief — Expenso Backend API

## Goal
Provide a fast, secure, reliable REST API that powers the Expenso client applications. Single source of truth for all financial transactions, budgets, loans, and calculations.

## Scope of Endpoints
1. `/auth`: User registration, email OTP verification, JWT login, Google OAuth, session checks.
2. `/categories`: Default category seeding on registration, custom category CRUD with cascading reassignments.
3. `/expenses`: Expense logging, multi-filter queries (`month`, `status`, `categoryId`), one-tap paid/unpaid status toggles.
4. `/income`: Income entries by source (Salary, Freelance, Rental, etc.) and payment method.
5. `/budgets`: Category budget ceilings with live spend aggregation.
6. `/loans`: Debts and loans with settlement history and due date tracking.
7. `/dashboard`: Server-aggregated totals (Income, Expenses, Paid/Unpaid, Current Balance, Projected Balance, Category breakdown, 12-month trends).

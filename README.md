# Expenso API

REST API for Expenso, a personal finance app for tracking spending, income, budgets and money
lent or borrowed. It is the backend for the `Expenso-mobile` app.

**Stack:** Node.js · Express · TypeScript · Prisma · PostgreSQL · Vitest

## What it does

- **Auth**: email + password (bcrypt, JWT with `tokenVersion`), Google sign-in, email OTP.
- **Transactions**: a single ledger. Every movement of money is one row with a kind:
  `SPEND`, `EARN`, `LEND_OUT`, `COLLECT`, `BORROW_IN` or `REPAY`.
- **Loans**: money lent or borrowed, with partial settlements. The opening movement and each
  settlement are ledger rows owned by the loan.
- **Budgets and categories**: monthly limits per category. Only `SPEND` counts against them.
- **Dashboard**: one call returns the month's income, spending and savings. It also returns cash
  and net worth as of the end of that month, with opening and closing balances.

Money is stored as `Decimal(14,2)`. The month a transaction belongs to is derived on the server,
in the user's timezone.

## Run it locally

Requires Node.js 20+ and a local PostgreSQL.

```bash
cp .env.example .env     # set DATABASE_URL, DIRECT_URL, JWT_SECRET
npm install
npm run db:create        # one-off: creates expenso_dev
npm run prisma:migrate   # apply migrations
npm run dev              # http://localhost:4000
```

## Check it

```bash
npm run typecheck        # must be 0 errors
npm run lint             # must be 0 errors
npm test                 # Vitest against a local expenso_test database
```

## Layout

```
src/modules/<domain>/   routes (HTTP + zod validation) and service (logic + DB)
src/middleware/         auth, error handling
src/lib, src/utils      prisma client, cache, money, dates, jwt
prisma/                 schema.prisma and migrations (the source of truth for the schema)
tests/                  integration tests against a real database
```

## Deploy

A merge to `main` triggers `.github/workflows/deploy.yml`. The job backs up the database, rebuilds the
Docker image on the VPS, runs `prisma migrate deploy` and restarts the API.

Working rules (branching, migrations, money handling, security) are in [CLAUDE.md](CLAUDE.md).

# Expenso Backend

REST API for Expenso — auth, transactions, budgets, loans and dashboard aggregation.
Express · Prisma · PostgreSQL · TypeScript.

Paired with the `Expenso-mobile` repo. They are separate repos and must stay API-compatible;
a breaking change needs both sides shipped together.

## Run it

```bash
cp .env.example .env     # DATABASE_URL, JWT_SECRET at minimum
npm install
npm run prisma:generate
npm run prisma:migrate   # dev migrations
npm run dev              # tsx watch
npm run typecheck        # tsc --noEmit — must be 0 errors before any commit
```

## Layout

```
src/
  modules/<domain>/   <domain>.routes.ts  — HTTP + zod validation, thin
                      <domain>.service.ts — business logic, owns the DB
  middleware/         auth, error handling
  lib/                prisma client, cache
  utils/              jwt, password, dates, asyncHandler
  config/             env loading
prisma/
  schema.prisma
  migrations/         the source of truth for schema — see below
```

**Layer rule:** routes parse and validate, services decide and persist. A route must never touch
`prisma` directly; a service must never touch `req`/`res`.

## Non-negotiables

1. **Never commit to `main`.** Branch per task, and every push to this repo gets a PR with a real
   description. The repo owner merges.
2. **`npm run typecheck` passes with 0 errors** before every commit.
3. **Migrations, not `db push`.** Schema changes ship as committed migrations applied with
   `prisma migrate deploy`. This is a finance app — schema history must be auditable and replayable.
4. **Money is `Decimal(14,2)`**, never `Float`. Server-side arithmetic uses `Prisma.Decimal`.
5. **Every multi-row mutation runs inside `prisma.$transaction`** with an explicit isolation level.
   Read-modify-write on balances uses `Serializable` with a retry wrapper — two concurrent
   settlements must not both observe the same `settledAmount`.
6. **Every query is scoped by `userId`.** Ownership is asserted before mutation, always.
7. **Validate with zod at the route boundary.** Never trust `req.body` or `req.query`.
8. **Invalidate the dashboard cache** (`invalidateUserDashboard`) on every write that can affect
   aggregates — transactions, budgets, categories *and* loans.

## Security

- Passwords: bcrypt. Tokens: JWT with `tokenVersion`, bumped on password change so a password change
  actually ends other sessions.
- Errors go through `errorHandler`; never leak stack traces or Prisma internals to clients.
- Secrets come from env. `.env` is never committed.

## Deploy

Push to `main` triggers `.github/workflows/deploy.yml` — SSH to the Oracle VPS, rebuild the Docker
image, apply migrations, restart. Check the Actions tab before assuming a deploy succeeded.

## Current work

Architecture is mid-overhaul. See `../IMPLEMENTATION_PLAN.md` (outside both repos) for the batch plan
and the reasoning — in particular the unified `Transaction` ledger that replaces the separate
`Expense`/`Income` tables and fixes the lend/borrow accounting asymmetry.

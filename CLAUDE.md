# Expenso Backend

REST API for Expenso — auth, transactions, budgets, loans and dashboard aggregation.
Express · Prisma · PostgreSQL · TypeScript.

Paired with the `Expenso-mobile` repo. They are separate repos and must stay API-compatible;
a breaking change needs both sides shipped together.

## Environments

Database config is **per environment**, via the `.env` sitting next to the code. Same repo, same
`docker-compose.yml`, different target:

| | Database | Configured by |
|---|---|---|
| Local dev | Your own PostgreSQL install (pgAdmin), `expenso_dev` | `backend/.env` on your machine |
| Production | Postgres on the VPS — the `db` service in `docker-compose.yml` | `.env` on the VPS |

The point is that a migration can be proven locally before it ever reaches production.

## Run it

```bash
cp .env.example .env     # then set DATABASE_URL / DIRECT_URL and JWT_SECRET
npm install
npm run db:create        # one-off: creates expenso_dev
npm run prisma:migrate   # apply migrations locally
npm run dev              # tsx watch
npm run typecheck        # tsc --noEmit — must be 0 errors before any commit
```

### Changing the schema

```bash
npm run migrate:new -- --name what_changed   # writes the SQL, applies nothing
# review and hand-edit prisma/migrations/<stamp>_what_changed/migration.sql
npm run prisma:migrate                       # apply locally
npm run db:status                            # confirm
```

Backfills and data corrections belong in the migration SQL, written by hand. Before a migration
touches a database with real data in it, dry-run it inside `BEGIN … ROLLBACK` with psql — Postgres
DDL is transactional, so that exercises the real schema against real rows with nothing persisted.

`prisma db push` is deliberately **not** available as a script. It diffs the live schema and
silently mutates to match, which bypasses migration history — production was found carrying an
index no migration ever created.

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

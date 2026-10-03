# Expenso API

The backend for **Expenso**, a personal finance app for tracking spending, income, budgets and money lent or borrowed. It serves the [Expenso mobile app](https://github.com/bilal-butt-1050/Expenso-mobile).

**Stack:** Node.js · Express · TypeScript · Prisma 5 · PostgreSQL · zod · Vitest

[![CI](https://github.com/bilal-butt-1050/Expenso-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/bilal-butt-1050/Expenso-backend/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

---

## What it does

- **Auth:** passwordless email sign-in with a 6-digit code, and Google sign-in. Sessions are JWTs carrying a token version, so they can be revoked. Codes are hashed, expire after 10 minutes, allow 5 attempts, and are rate-limited per email, per IP and in total.
- **A single money ledger:** every movement of money is one row in `transactions` with a kind:

  | Kind | Cash | Counts as |
  |---|---|---|
  | `SPEND` | − | spending (and budgets) |
  | `EARN` | + | income |
  | `LEND_OUT` / `COLLECT` | − / + | a loan you made, and its repayments |
  | `BORROW_IN` / `REPAY` | + / − | a loan you took, and its repayments |
  | `ADJUST` | ± | a balance correction, neither income nor spending |

  Each row also records `movesCash`, whether the user's cash actually changed. That covers an old debt recorded after the fact, an expense someone else paid, and a loan forgiven or paid in kind. Cash sums only rows that moved cash. Spending, income and debts read every row.
- **Loans:** money lent or borrowed, with a date, a due date and partial repayments. A repayment can be dated, can be settled without money changing hands, and can be undone. Each loan's movements are owned by the loan, so they can't drift from its balance.
- **Shared expenses:** an expense can be paid by someone else (spending plus a debt to them) or split (your part is spending, their share is lent). The expense and its loan stay in step.
- **Budgets and categories:** monthly limits per category. Only `SPEND` counts against them.
- **Dashboard:** one call returns a month's income, spending, savings, budgets and category breakdown. It also returns cash, net worth and money owed **as of the end of that month**, so a past month never changes because of later activity.

Money is stored as `Decimal(14,2)` and never touches a float. The server derives which month an entry belongs to in the user's own timezone.

---

## API overview

All routes except `/health` and sign-in need `Authorization: Bearer <token>`, and every query is scoped to the signed-in user.

| Area | Routes |
|---|---|
| Health | `GET /health` |
| Auth | `POST /auth/email/start`, `/email/verify`, `/email/complete`, `/google` · `GET /auth/me` · `PATCH /auth/profile` · `DELETE /auth/account` |
| Transactions | `GET /transactions?month&kinds&cursor` (keyset paging) · `POST /transactions` (idempotent with a client id) · `PATCH`/`DELETE /transactions/:id` · `POST /transactions/adjust-balance` |
| Loans | `GET /loans?month` · `POST /loans` · `PATCH /loans/:id` · `PATCH /loans/:id/settle` · `DELETE /loans/:id/payments/:paymentId` · `DELETE /loans/:id` |
| Dashboard | `GET /dashboard/summary?month` |
| Budgets | `GET`/`PUT /budgets` · `DELETE /budgets/:categoryId` |
| Categories | `GET`/`POST /categories` · `PUT`/`DELETE /categories/:id` |
| Opening balance | `PUT /opening-balance` (set once) |

`/expenses`, `/income` and the password routes are kept for older installed apps and are deprecated.

---

## Run it locally

Requires **Node.js 20+** and a local **PostgreSQL**.

```bash
git clone https://github.com/bilal-butt-1050/Expenso-backend.git
cd Expenso-backend
cp .env.example .env     # set DATABASE_URL, DIRECT_URL and JWT_SECRET
npm install
npm run db:create        # one-off: creates expenso_dev
npm run prisma:migrate   # apply the migrations
npm run dev              # http://localhost:4000
```

In development no email is sent. **Sign-in codes are printed in this terminal** (`OTP for you@example.com: 123456`), so you can sign in from the app with any address.

Optional: `npm run seed` creates a demo user, `demo@expenso.app`.

### With Docker

```bash
cp .env.example .env     # also set POSTGRES_PASSWORD, and point DATABASE_URL at host "db"
docker compose up -d --build
```

---

## Check it

```bash
npm run typecheck        # 0 errors required
npm run lint             # 0 errors required
npm test                 # integration tests against a real PostgreSQL
```

The tests use their own database, `expenso_test`. Copy `.env.test.example` to `.env.test`. The suite rebuilds that database from the migrations on every run, so the migration chain is tested too. There are 247 tests, including property tests that run a thousand random operations and check after every step that cash equals the ledger's sum and net worth equals cash plus what's owed.

CI runs all three on every pull request.

---

## Project layout

```
src/
  modules/<domain>/   <domain>.routes.ts   HTTP + zod validation, thin
                      <domain>.service.ts  business rules, owns the database
  middleware/         auth, error handling
  lib/                prisma client, dashboard cache, serializable transactions, join-date rule
  utils/              money, dates, jwt, validation
  config/             environment loading
prisma/
  schema.prisma
  migrations/         the source of truth for the schema
tests/                integration and property tests
```

Routes parse and validate; services decide and persist. A route never touches the database, and a service never touches the request.

---

## Deployment

A merge to `main` runs `.github/workflows/deploy.yml`. On the server, it:
1. backs up the database and refuses to continue if the backup is empty or truncated;
2. rebuilds the Docker image;
3. runs `prisma migrate deploy`;
4. restarts the API.

The schema changes only through committed migrations, never `prisma db push`.

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Found a security problem? Please report it privately; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Muhammad Bilal Afzal

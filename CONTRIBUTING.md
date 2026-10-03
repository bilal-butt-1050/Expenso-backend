# Contributing to the Expenso API

Thanks for helping. This is the backend for the Expenso mobile app. Contributions are welcome: bug fixes, tests and features.

## Getting started

```bash
cp .env.example .env     # set DATABASE_URL / DIRECT_URL and JWT_SECRET
npm install
npm run db:create        # one-off: creates expenso_dev on your local PostgreSQL
npm run prisma:migrate   # apply the migrations
npm run dev
```

The tests need their own database, `expenso_test`. Copy `.env.test.example` to `.env.test` and run `npm test`. The suite rebuilds that database from the migrations on every run, so never point it at a database you care about.

## How changes are made

1. Fork the repository and create a branch: `feat/…`, `fix/…`, `chore/…` or `refactor/…`.
2. Make your change. Keep it focused on one thing.
3. Before you open a pull request, make sure all of these pass:
   ```bash
   npm run typecheck
   npm run lint
   npm test
   ```
4. Open a pull request against `main` and describe what changed and why. CI runs the same three checks.

`main` is protected: every change goes through a reviewed pull request, and merging deploys to production. So please keep pull requests small and easy to review.

## Rules the code follows

- **Layers:** routes parse and validate with zod; services hold the business rules and talk to the database. A route never touches the database, and a service never touches `req` or `res`.
- **Money** is `Decimal(14,2)`, never a float. Server arithmetic uses `Prisma.Decimal`.
- **Every query is scoped to the signed-in user**, and ownership is checked before any change.
- **Multi-row changes run in one transaction.** Read-modify-write on balances uses Serializable isolation with retries.
- **Schema changes are migrations** (`npm run migrate:new -- --name what_changed`), never `prisma db push`.
- **Every bug fix comes with a test** that fails before the fix and passes after.
- **API changes stay backward compatible.** Installed apps keep using old fields until they update.

## Reporting bugs and security issues

- Bugs: open an issue with steps to reproduce.
- Security problems: **don't** open a public issue. See [SECURITY.md](SECURITY.md).

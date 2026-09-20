# AGENTS.md — Expenso Backend API

Entry point for every agent working in the `expenso-backend` repository. Read this first, then the docs it links.
Keep it accurate: if it contradicts the code, fix it in the same PR.

## What this is
The central REST API service for Expenso. Built with Node.js, Express, TypeScript, and Prisma ORM on PostgreSQL. Handles user authentication, itemized expenses with paid/unpaid toggling, incomes, monthly budgets, loan/debt tracking, and high-performance financial dashboard aggregation.

## Stack
| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript 5.6 | Strict typing, zero `any` |
| Framework | Express 4.21 | Modular vertical slices in `src/modules/` |
| Database & ORM | PostgreSQL 16+ & Prisma 5.20 | Type-safe queries, foreign key cascades, parameterized SQL |
| Auth & Security | JWT, bcryptjs, Helmet, RateLimit | Stateless bearer tokens, rate-limited auth endpoints |
| Validation | Zod 3.23 | Schema validation on all controller inputs |
| Hosting & CI | Docker Compose on Oracle VPS | GitHub Actions (`deploy.yml`) auto-deploy on merge to `main` |

## Run it
```bash
cp .env.example .env     # configure DATABASE_URL, PORT=4000, JWT_SECRET
docker compose up -d     # launches PostgreSQL container
npm install
npx prisma generate
npx prisma db push       # safe, non-destructive schema synchronization
npm run dev              # starts tsx watch on src/server.ts
```

## Scripts (use these exact commands — CI runs the same ones)
| Purpose | Command |
|---|---|
| dev | `npm run dev` |
| build | `npm run build` (`tsc -p tsconfig.json`) |
| typecheck | `npm run typecheck` (`tsc --noEmit`) |
| lint | `npm run lint` |
| db generate | `npm run prisma:generate` |
| db push | `npx prisma db push` |
| db migrate | `npm run prisma:migrate` |
| db seed | `npm run seed` |

## Structure
```
backend/
├── prisma/
│   ├── schema.prisma        # Database models & relationships
│   ├── seed.ts              # Demo seed data
│   └── migrations/          # Versioned migration logs
├── src/
│   ├── config/              # Environment schema & validation
│   ├── middleware/          # Auth, error handling, rate limits
│   ├── modules/             # Vertical slices
│   │   ├── auth/            # Register, login, google, otp
│   │   ├── categories/      # Category management & seeding
│   │   ├── expenses/        # Expense tracking & status toggles
│   │   ├── income/          # Income entry & tracking
│   │   ├── budgets/         # Category monthly limits
│   │   ├── loans/           # Debt & lent money tracking
│   │   └── dashboard/       # Aggregated financial analytics
│   ├── app.ts               # Express configuration & middleware
│   └── server.ts            # Entry point listener
└── .agents/                 # Backend agent documentation & rules
```

## Read before you work
- `docs/00-product-brief.md` — API scope, requirements, and user stories
- `docs/01-architecture.md` — Module map, boundaries, and data flow
- `docs/03-data-model.md` — Prisma schema, models, indexes, and relations
- `docs/04-api-contracts.md` — REST endpoints, DTOs, and response shapes
- `docs/05-conventions.md` — Validation patterns, error handling, and gotchas
- `docs/07-environments-ops.md` — Oracle VPS deployment and safe Prisma db push
- `docs/08-tasks.md` — Live plan; update it as you go
- `rules/` — Backend non-negotiables

## Backend Non-Negotiables
1. **Never commit or push directly to `main`**: Always create a feature branch (`feat/`, `fix/`, `refactor/`).
2. **Quality Gates**: Every commit must pass `npm run typecheck` and `npm run build` with **0 errors**.
3. **Layer Separation**: `*.routes.ts` (HTTP & Zod validation) → `*.service.ts` (business logic) → Prisma (data access). Never put business logic or DB calls in route handlers.
4. **Tenant Isolation**: Every query accessing User data must filter by `userId` extracted from the authenticated JWT session.
5. **Safe Database Operations**: Use non-destructive `npx prisma db push` on VPS. Never run destructive migrations that drop data.

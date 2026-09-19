# Graph Report - backend  (2026-09-19)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 192 nodes · 370 edges · 11 communities (10 shown, 1 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 9 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `67843e09`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- AppError
- auth.service.ts
- income.routes.ts
- package.json
- compilerOptions
- app.ts
- expenses.routes.ts
- dependencies
- devDependencies
- scripts
- express.d.ts

## God Nodes (most connected - your core abstractions)
1. `AppError` - 24 edges
2. `compilerOptions` - 17 edges
3. `express` - 11 edges
4. `toMonthKey()` - 10 edges
5. `scripts` - 10 edges
6. `requireAuth()` - 9 edges
7. `registerUser()` - 8 edges
8. `zod` - 8 edges
9. `prisma` - 8 edges
10. `asyncHandler()` - 7 edges

## Surprising Connections (you probably didn't know these)
- `main()` --calls--> `registerUser()`  [EXTRACTED]
  prisma/seed.ts → src/modules/auth/auth.service.ts
- `changePassword()` --calls--> `AppError`  [EXTRACTED]
  src/modules/auth/auth.service.ts → src/utils/asyncHandler.ts
- `generateAndSendOtp()` --calls--> `AppError`  [EXTRACTED]
  src/modules/auth/auth.service.ts → src/utils/asyncHandler.ts
- `getUserById()` --calls--> `AppError`  [EXTRACTED]
  src/modules/auth/auth.service.ts → src/utils/asyncHandler.ts
- `loginUser()` --calls--> `AppError`  [EXTRACTED]
  src/modules/auth/auth.service.ts → src/utils/asyncHandler.ts

## Import Cycles
- None detected.

## Communities (11 total, 1 thin omitted)

### Community 0 - "AppError"
Cohesion: 0.16
Nodes (21): express, zod, requireAuth(), budgetSchema, deleteBudget(), listBudgets(), upsertBudget(), categoriesRouter (+13 more)

### Community 1 - "auth.service.ts"
Cohesion: 0.14
Nodes (23): resend, authRouter, changePasswordSchema, googleSchema, loginSchema, registerSchema, sendOtpSchema, updateProfileSchema (+15 more)

### Community 2 - "income.routes.ts"
Cohesion: 0.14
Nodes (18): main(), prisma, getDashboardSummary(), getMonthlyTrend(), getPreviousMonth(), incomeRouter, incomeSchema, querySchema (+10 more)

### Community 3 - "package.json"
Cohesion: 0.09
Nodes (20): description, main, name, private, version, bcryptjs, dotenv, google-auth-library (+12 more)

### Community 4 - "compilerOptions"
Cohesion: 0.10
Nodes (19): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noImplicitReturns (+11 more)

### Community 5 - "app.ts"
Cohesion: 0.18
Nodes (11): cors, helmet, jsonwebtoken, createApp(), env, errorHandler(), notFoundHandler(), budgetsRouter (+3 more)

### Community 6 - "expenses.routes.ts"
Cohesion: 0.23
Nodes (14): querySchema, expenseSchema, expensesRouter, querySchema, updateExpenseSchema, assertCategoryOwnership(), assertExpenseOwnership(), createExpense() (+6 more)

### Community 7 - "dependencies"
Cohesion: 0.17
Nodes (12): dependencies, bcryptjs, cors, dotenv, express, google-auth-library, helmet, jsonwebtoken (+4 more)

### Community 8 - "devDependencies"
Cohesion: 0.20
Nodes (10): devDependencies, prisma, tsx, @types/bcryptjs, @types/cors, @types/express, @types/jsonwebtoken, @types/morgan (+2 more)

### Community 9 - "scripts"
Cohesion: 0.20
Nodes (10): scripts, build, dev, lint, prisma:generate, prisma:migrate, prisma:studio, seed (+2 more)

## Knowledge Gaps
- **88 isolated node(s):** `AsyncRouteHandler`, `Request`, `IncomeInput`, `JwtPayload`, `ExpenseInput` (+83 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 92 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `express` connect `AppError` to `auth.service.ts`, `income.routes.ts`, `package.json`, `app.ts`, `expenses.routes.ts`?**
  _High betweenness centrality (0.125) - this node is a cross-community bridge._
- **Why does `zod` connect `AppError` to `auth.service.ts`, `income.routes.ts`, `package.json`, `expenses.routes.ts`?**
  _High betweenness centrality (0.098) - this node is a cross-community bridge._
- **Why does `dependencies` connect `dependencies` to `package.json`?**
  _High betweenness centrality (0.098) - this node is a cross-community bridge._
- **What connects `AsyncRouteHandler`, `Request`, `IncomeInput` to the rest of the system?**
  _88 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `auth.service.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1396011396011396 - nodes in this community are weakly interconnected._
- **Should `income.routes.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.13666666666666666 - nodes in this community are weakly interconnected._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.08695652173913043 - nodes in this community are weakly interconnected._
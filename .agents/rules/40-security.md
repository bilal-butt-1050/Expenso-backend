# Security Standards — Expenso Backend

1. **Zero Hardcoded Secrets**:
   - `DATABASE_URL`, `JWT_SECRET`, `RESEND_API_KEY`, and `PORT` must be loaded from `src/config/env.ts` (validated with Zod at startup).
   - Never commit `.env`. Maintain safe placeholders in `.env.example`.
2. **Tenant Isolation**:
   - Every database query accessing User data, Expenses, Incomes, Categories, Budgets, or Loans MUST filter by `userId: req.user.id`.
   - Never trust client-supplied `userId` parameters.
3. **Password Security**:
   - Passwords hashed with `bcryptjs` (salt rounds = 10). Never return password hashes in responses.
4. **Parameterized Queries**:
   - Use Prisma ORM methods exclusively. Never concatenate raw SQL strings.
5. **Rate Limiting**:
   - General API: 500 requests per 15 minutes.
   - Authentication routes (`/auth/*`): Strict 20 requests per 15 minutes.

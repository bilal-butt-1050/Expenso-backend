# Core Rules — Expenso Backend

1. **Understand before building**: Read `.agents/AGENTS.md` and `.agents/docs/` before making changes.
2. **Smallest correct change**: Write clean, targeted code. No unrequested rewrites or speculative abstractions.
3. **Layer boundaries are sacred**:
   - `*.routes.ts`: Route declarations, middleware attachments, and Zod input validation.
   - `*.service.ts`: Pure business logic, calculations, and Prisma queries.
   - Never write Prisma database queries inside route handlers.
4. **Single source of truth**: The PostgreSQL database is the single authority. All balance and budget aggregations are computed server-side to guarantee consistency across clients.
5. **Continuous verification**: Always verify with `npm run typecheck` and `npm run build`.

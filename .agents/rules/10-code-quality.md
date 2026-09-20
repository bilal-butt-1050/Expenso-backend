# Code Quality Standards — Expenso Backend

1. **Strict Typing**: Zero `any`. Type all Prisma relations, DTO inputs, and service returns explicitly.
2. **Input Validation**: Validate every request body, query parameter, and route parameter using Zod schemas before processing.
3. **Structured Error Handling**:
   - Throw typed `AppError(message, statusCode)` from services.
   - Handled centrally by `src/middleware/errorHandler.ts`. Never use empty `catch {}` blocks.
4. **Transactions**: Use `prisma.$transaction([...])` whenever updating multiple dependent tables (e.g. loan settlements or category deletions with reassignments).

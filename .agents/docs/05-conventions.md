# Coding Conventions & Patterns — Expenso Backend

## Module Conventions
1. **Schema Validation**:
   - Every route file must export or consume a Zod schema defined in `<feature>.schema.ts`.
   - Validate bodies via `validateBody(schema)` and query strings via `validateQuery(schema)`.
2. **Error Responses**:
   - Always throw `AppError(message, statusCode)`.
   - The centralized error handler outputs `{ error: string, details?: any }`.
3. **Database Transactions**:
   - When updating loans or deleting categories (which reassigns expenses to "Other"), always use `prisma.$transaction`.

## Known Gotchas
- Month string format is strictly `YYYY-MM` (e.g. `2026-09`).
- Prisma Client queries in Docker VPS must match the schema generated via `npx prisma generate`.

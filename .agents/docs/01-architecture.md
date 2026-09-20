# System Architecture — Expenso Backend

## Vertical Slice Structure
Every domain entity lives in `src/modules/<feature>/`:
```
src/modules/<feature>/
├── <feature>.routes.ts    # Express router, authentication middleware, validation middleware
├── <feature>.service.ts   # Business logic, Prisma ORM operations, calculations
└── <feature>.schema.ts    # Zod schemas, input/output types
```

## Layer Boundaries
1. **Routes layer (`*.routes.ts`)**:
   - Parses HTTP request.
   - Validates body/params with Zod schema.
   - Extracts `userId` from `req.user`.
   - Calls service function and returns JSON response with proper HTTP status.
2. **Service layer (`*.service.ts`)**:
   - Implements business logic and queries Prisma.
   - Throws `AppError` on domain errors (e.g. `AppError("Category not found", 404)`).
   - Never accesses Express request/response objects directly.
3. **Database layer**:
   - `src/lib/prisma.ts`: Singleton PrismaClient instance.

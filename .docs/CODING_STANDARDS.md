# Coding Standards

1. **SOLID & Clean Architecture**: Domain logic is isolated in service files. Controllers/Routes handle HTTP request extraction and validation.
2. **YAGNI (Ponytail Principle)**: Prefer standard library features over external dependencies. Build simple abstractions. Avoid over-engineering.
3. **No `any` Types**: Strict TypeScript definitions for all functions. Rely on inferred return types where obvious, but always type input arguments.
4. **Error Handling**: Use `asyncHandler` wrapper on all express routes to automatically forward rejections to the global `errorHandler`. Use custom `AppError` class for expected business logic errors with proper HTTP status codes.
5. **Caching**: Cache heavy computational/aggregation queries (`dashboard.service.ts`). Invalidate exactly when underlying data mutations occur.

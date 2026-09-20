# Testing Strategy — Expenso Backend

## Quality Gates
1. `npm run typecheck` (`tsc --noEmit`) must report **0 errors**.
2. `npm run build` (`tsc -p tsconfig.json`) must output cleanly to `dist/` with **0 errors**.

## Verification Scenarios
- Authenticated requests without a token or with an invalid token return 401.
- Requests with invalid payloads return 400 with descriptive validation errors from Zod.
- Tenant isolation: User A cannot read, update, or delete records belonging to User B (must return 404 or 403).

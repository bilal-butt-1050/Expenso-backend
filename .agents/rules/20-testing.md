# Testing & Quality Gates — Expenso Backend

1. **Mandatory Build Gates**:
   - `npm run typecheck` (`tsc --noEmit`) must exit with **0 errors**.
   - `npm run build` (`tsc -p tsconfig.json`) must compile cleanly to `dist/` with **0 errors**.
2. **Bug Fixing Protocol**:
   - Reproduce the exact issue first by tracing request payloads and database state.
   - Grep all callers and dependent modules before modifying shared services.
   - Fix at the root origin in `*.service.ts` or validation schemas.
3. **Real Evidence**: Always report actual command output. Never claim checks passed without executing them.

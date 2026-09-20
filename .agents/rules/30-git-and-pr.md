# Git & CI/CD Protocol — Expenso Backend

1. **Never Commit to Main**: Direct pushes to `main` are strictly forbidden. Always branch off `main`:
   - `feat/<name>`: New API capabilities
   - `fix/<name>`: Bug fixes and calculation corrections
   - `refactor/<name>`: Cleanups without functional change
2. **Conventional Commits**:
   - `feat(loans): implement partial and full loan settlement endpoints`
   - `fix(dashboard): exclude unpaid loans from current balance aggregation`
3. **Automated VPS Deployment**:
   - Merges to `main` automatically trigger GitHub Actions (`.github/workflows/deploy.yml`) to rebuild and redeploy the container on Oracle VPS.
   - For database schema changes, the user manually executes `docker compose exec api npx prisma db push` on the VPS to preserve all data.
4. **Never Self-Merge**: Open a PR for human review.

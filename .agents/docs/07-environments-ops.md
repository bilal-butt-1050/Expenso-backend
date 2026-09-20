# Environments & Operations — Expenso Backend

## Hosting Architecture
- **Host**: Oracle Cloud VPS (Ubuntu Linux).
- **Runtime**: Docker Compose orchestrating the Node.js API container and reverse proxy.

## Deployment Workflow
1. Developer pushes feature branch to origin and opens a PR.
2. User reviews and merges PR into `main`.
3. GitHub Actions (`.github/workflows/deploy.yml`) triggers automatically:
   - SSH connects to Oracle VPS.
   - Pulls latest `main` branch.
   - Rebuilds and relaunches container:
     ```bash
     cd ~/expenso-backend
     git pull origin main
     docker compose up -d --build
     docker image prune -f
     ```

## Database Migrations (Manual VPS Step)
When modifying `prisma/schema.prisma`:
1. SSH into Oracle VPS.
2. Run safe differential schema push:
   ```bash
   cd ~/expenso-backend
   docker compose exec api npx prisma db push
   ```
- *Why*: `prisma db push` safely applies schema differences without deleting existing user data.

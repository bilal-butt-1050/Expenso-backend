# Architecture

Expenso backend is built using a vertical slice architecture grouped by feature modules in the `src/modules` directory.

## Core Flow
- **Routes (`*.routes.ts`)**: Defines Express endpoints and schema validation using Zod.
- **Service (`*.service.ts`)**: Contains core business logic and direct Prisma ORM interactions.
- **Database**: PostgreSQL hosted externally, managed by Prisma.

## Key Boundaries
- `auth`: JWT and Google OAuth logic.
- `dashboard`: Aggregation logic spanning multiple models.
- `expenses`, `income`, `budgets`, `categories`: CRUD for core financial objects.

## Security
- Helmet for HTTP headers.
- CORS restricted to allowed origin.
- JWT for stateful authentication on endpoints.

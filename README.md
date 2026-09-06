# Expenso API

The core backend service for the **Expenso** personal finance management platform. Built with **Node.js**, **Express**, **TypeScript**, and **PostgreSQL** powered by **Prisma ORM**.

---

## Features

- **JWT Authentication:** Secure user registration, password hashing with bcrypt, and token-based session management.
- **Expense Tracking:** Granular expense recording with categories, payment methods, Need/Want classifications, and Paid/Unpaid status toggling.
- **Budgeting Engine:** Monthly spending caps per category with progress monitoring.
- **Income Management:** Monthly income tracking supporting salary, bonuses, and miscellaneous income sources.
- **Consolidated Dashboard:** Single-request aggregated analytics for monthly spending, budget utilization, and historical 6-month trends.
- **Type-Safe Data Layer:** Full end-to-end type safety using Prisma ORM and Zod request validation.

---

## Project Structure

The project follows a modular, feature-based architecture. Each domain within `src/modules/` is self-contained with route validation and business service logic:

```text
backend/
├── prisma/
│   ├── schema.prisma      # Database models & relationships
│   └── seed.ts            # Development database seed script
├── src/
│   ├── config/            # Environment variable validation & loading
│   ├── lib/               # Shared singleton instances (Prisma client)
│   ├── middleware/        # Authentication guard & centralized error handler
│   ├── modules/           # Feature modules (routes + service)
│   │   ├── auth/          # Authentication & user profile
│   │   ├── budgets/       # Monthly category budgets
│   │   ├── categories/    # Custom & default expense categories
│   │   ├── dashboard/     # Aggregation & financial summary metrics
│   │   ├── expenses/      # Expense CRUD & status toggle
│   │   └── income/        # Monthly income tracking
│   ├── utils/             # JWT, password hashing, async handler, date helpers
│   ├── app.ts             # Express application assembly
│   └── server.ts          # Server entry point
├── .env.example           # Environment variable template
├── Dockerfile             # Multi-stage production container image
├── docker-compose.yml     # Local database and API container orchestration
├── package.json           # Dependencies and scripts
└── tsconfig.json          # TypeScript compiler configuration
```

---

## Prerequisites

- **Node.js** (v18 or higher)
- **npm** (v9 or higher)
- **PostgreSQL** (v14 or higher) or **Docker**

---

## Getting Started

### Method 1: Local Development (Recommended)

1. **Clone the repository:**
   ```bash
   git clone https://github.com/bilal-butt-1050/Expenso-backend.git
   cd Expenso-backend
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment variables:**
   Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
   Open `.env` and configure your local PostgreSQL connection string:
   ```env
   PORT=4000
   NODE_ENV=development
   DATABASE_URL="postgresql://postgres:your_password@localhost:5432/expenso?schema=public"
   JWT_SECRET="your-secure-random-jwt-secret"
   JWT_EXPIRES_IN="30d"
   CORS_ORIGIN="*"
   ```

4. **Create the database & run migrations:**
   Ensure PostgreSQL is running and your target database (`expenso`) is created, then run:
   ```bash
   npm run prisma:migrate
   ```

5. **(Optional) Seed initial demo account:**
   ```bash
   npm run seed
   ```
   *Creates test account:* `demo@expenso.app` / `password123`

6. **Start the development server:**
   ```bash
   npm run dev
   ```
   The API will be available at `http://localhost:4000`.

7. **(Optional) Open Prisma Studio:**
   Browse and manage database records visually in your browser:
   ```bash
   npm run prisma:studio
   ```

---

### Method 2: Docker Compose

To start both PostgreSQL and the API inside isolated containers:

```bash
docker compose up --build
```

The API will listen on `http://localhost:4000` and the PostgreSQL database on port `5432`.

---

## Environment Variables

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | No | `development` | Environment mode (`development`, `production`, `test`) |
| `PORT` | No | `4000` | Port for the HTTP server |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection URI |
| `JWT_SECRET` | **Yes** | — | Secret key used to sign and verify JWT tokens |
| `JWT_EXPIRES_IN`| No | `30d` | Lifetime duration for issued JWT tokens |
| `CORS_ORIGIN` | No | `*` | Allowed CORS origin header |

---

## API Reference

All endpoints except `/health`, `/auth/register`, and `/auth/login` require an `Authorization: Bearer <token>` header.

### Health Check
- `GET /health` — Check service health status.

### Authentication (`/auth`)
- `POST /auth/register` — Register a new account (automatically seeds default categories).
- `POST /auth/login` — Authenticate credentials and receive a JWT.
- `GET /auth/me` — Retrieve the profile of the currently signed-in user.

### Categories (`/categories`)
- `GET /categories` — List all user categories.
- `POST /categories` — Create a custom category.
- `PUT /categories/:id` — Update category details (name, icon, color).
- `DELETE /categories/:id` — Delete a category (reassigns linked expenses to "Other").

### Expenses (`/expenses`)
- `GET /expenses` — List expenses (supports query filters: `?month=YYYY-MM`, `?categoryId=`, `?status=`).
- `POST /expenses` — Record a new expense.
- `PUT /expenses/:id` — Edit an existing expense.
- `DELETE /expenses/:id` — Delete an expense.
- `PATCH /expenses/:id/toggle-status` — Toggle payment status (`Paid` ⇄ `Unpaid`).

### Income (`/income`)
- `GET /income` — Retrieve all monthly income records.
- `PUT /income` — Upsert an income record for a specified month (`salary`, `bonus`, `otherIncome`).

### Budgets (`/budgets`)
- `GET /budgets` — List all active category monthly budgets.
- `PUT /budgets` — Upsert a standing monthly budget for a category.

### Dashboard (`/dashboard`)
- `GET /dashboard/summary?month=YYYY-MM` — Aggregated monthly overview including income, spending breakdown, budget adherence, and 6-month historical trends.

---

## Available Scripts

| Script | Command | Description |
| :--- | :--- | :--- |
| `npm run dev` | `tsx watch src/server.ts` | Runs the API with live hot-reloading |
| `npm run build` | `tsc -p tsconfig.json` | Compiles TypeScript to JavaScript in `dist/` |
| `npm start` | `node dist/server.js` | Runs the compiled production build |
| `npm run typecheck`| `tsc --noEmit` | Validates TypeScript types across the codebase |
| `npm run prisma:migrate` | `prisma migrate dev` | Applies database migrations in development |
| `npm run prisma:studio` | `prisma studio` | Launches the interactive visual database browser |
| `npm run seed` | `tsx prisma/seed.ts` | Populates the database with initial test data |

---

## License

This project is licensed under the MIT License.

# API Contracts — Expenso Backend

Base URL: `http://localhost:4000` (Local) / VPS API Domain
Protected routes require header: `Authorization: Bearer <token>`

## Endpoints

### `/auth`
- `POST /auth/register` — `{ email, password, name? }` -> `201 { token, user }`
- `POST /auth/login` — `{ email, password }` -> `200 { token, user }`
- `POST /auth/google` — `{ idToken }` -> `200 { token, user }`
- `POST /auth/send-otp` — `{ email }` -> `200 { message }`
- `POST /auth/verify-otp` — `{ email, otp }` -> `200 { message }`
- `GET /auth/me` — Authenticated -> `200 { user }`

### `/categories`
- `GET /categories` -> `200 Category[]`
- `POST /categories` — `{ name, icon, color }` -> `201 Category`
- `PUT /categories/:id` — `{ name?, icon?, color? }` -> `200 Category`
- `DELETE /categories/:id` -> `200 { message }`

### `/expenses`
- `GET /expenses?month=YYYY-MM&status=Paid|Unpaid&categoryId=...` -> `200 Expense[]`
- `POST /expenses` — `{ categoryId, amount, date, description?, paymentMethod?, needWant?, status? }` -> `201 Expense`
- `PUT /expenses/:id` — Updated fields -> `200 Expense`
- `PATCH /expenses/:id/toggle-status` -> `200 Expense` (toggled status)
- `DELETE /expenses/:id` -> `200 { message }`

### `/income`
- `GET /income?month=YYYY-MM` -> `200 Income[]`
- `POST /income` — `{ source, amount, date, description?, paymentMethod? }` -> `201 Income`
- `DELETE /income/:id` -> `200 { message }`

### `/budgets`
- `GET /budgets?month=YYYY-MM` -> `200 BudgetWithSpent[]`
- `POST /budgets` — `{ categoryId, amount, month }` -> `201 Budget`
- `DELETE /budgets/:id` -> `200 { message }`

### `/loans`
- `GET /loans?type=LENT|BORROWED&status=...` -> `200 Loan[]`
- `POST /loans` — `{ type, personName, amount, dueDate?, notes? }` -> `201 Loan`
- `PATCH /loans/:id/settle` — `{ amount }` -> `200 Loan`
- `DELETE /loans/:id` -> `200 { message }`

### `/dashboard`
- `GET /dashboard?month=YYYY-MM` -> `200 DashboardData`:
  `{ totalIncome, totalExpenses, paidExpenses, unpaidExpenses, currentBalance, projectedBalance, categoryBreakdown, monthlyTrend }`

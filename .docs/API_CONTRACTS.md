# API Contracts

All API payloads are validated using Zod at the route level. The following are high-level domains.

## Endpoints

- **`POST /auth/register`**: Register a new user.
- **`POST /auth/login`**: Authenticate and receive a JWT.
- **`GET /dashboard/summary?month=YYYY-MM`**: Fetch aggregated stats, expenses, budgets, and trend data.
- **`GET /expenses`**: Query and filter paginated expenses.
- **`GET /income`**: Query and filter incomes.
- **`GET /categories`**: Fetch user categories.
- **`GET /budgets`**: Fetch monthly budgets.

## Standard Responses
Success:
```json
{
  // payload data directly
}
```

Error:
```json
{
  "message": "Error description",
  "errors": [{ "path": "field", "message": "validation error" }]
}
```

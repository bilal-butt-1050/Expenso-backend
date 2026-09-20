# Data Model — Expenso Backend

Defined in `prisma/schema.prisma`. Every user-owned entity links to `User` via `userId` with `onDelete: Cascade`.

## Models
1. **`User` (`users`)**:
   - `id`: UUID (PK)
   - `email`: String (Unique)
   - `passwordHash`: String?
   - `googleId`: String? (Unique)
   - `name`: String?, `avatarUrl`: String?, `currency`: String (Default: "PKR")
   - Relations: `categories`, `expenses`, `incomes`, `budgets`, `loans`

2. **`Category` (`categories`)**:
   - `id`: UUID, `userId`: UUID (FK)
   - `name`: String, `icon`: String, `color`: String, `isDefault`: Boolean
   - Unique: `[userId, name]`

3. **`Expense` (`expenses`)**:
   - `id`: UUID, `userId`: UUID (FK), `categoryId`: UUID (FK)
   - `date`: DateTime, `month`: String ("YYYY-MM")
   - `description`: String?, `amount`: Float, `paymentMethod`: String, `needWant`: String ("Need" | "Want"), `status`: String ("Paid" | "Unpaid")
   - Indexes: `[userId, month]`, `[userId, categoryId]`, `[userId, status, month]`

4. **`Income` (`incomes`)**:
   - `id`: UUID, `userId`: UUID (FK)
   - `date`: DateTime, `month`: String ("YYYY-MM"), `source`: String, `sourceIcon`: String, `sourceColor`: String, `amount`: Float, `paymentMethod`: String

5. **`Budget` (`budgets`)**:
   - `id`: UUID, `userId`: UUID (FK), `categoryId`: UUID (FK), `amount`: Float, `month`: String
   - Unique: `[userId, categoryId, month]`

6. **`Loan` (`loans`)**:
   - `id`: UUID, `userId`: UUID (FK), `type`: `LoanType` (`LENT` | `BORROWED`), `personName`: String, `amount`: Float, `settledAmount`: Float (0), `dueDate`: DateTime?, `status`: `LoanStatus` (`PENDING` | `PARTIAL` | `SETTLED`), `notes`: String?

7. **`OtpVerification` (`otp_verifications`)**:
   - `id`: UUID, `email`: String (Unique), `otp`: String, `expiresAt`: DateTime

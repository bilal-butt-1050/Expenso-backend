import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import { rateLimit } from "express-rate-limit";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { authRouter } from "./modules/auth/auth.routes";
import { categoriesRouter } from "./modules/categories/categories.routes";
import { expensesRouter } from "./modules/expenses/expenses.routes";
import { incomeRouter } from "./modules/income/income.routes";
import { budgetsRouter } from "./modules/budgets/budgets.routes";
import { dashboardRouter } from "./modules/dashboard/dashboard.routes";
import { loansRouter } from "./modules/loans/loans.routes";
import { transactionsRouter } from "./modules/transactions/transactions.routes";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigin }));
  app.use(express.json());
  
  app.use(compression());

  // General rate limiter for standard app interactions (500 req / 15 min)
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 500,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    })
  );

  // Strict rate limiter for sensitive authentication endpoints
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many authentication attempts. Please try again later." },
  });

  if (env.nodeEnv !== "test") {
    app.use(morgan(env.nodeEnv === "production" ? "combined" : "dev"));
  }

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/auth", authLimiter, authRouter);
  app.use("/categories", categoriesRouter);
  app.use("/expenses", expensesRouter);
  app.use("/income", incomeRouter);
  app.use("/budgets", budgetsRouter);
  app.use("/dashboard", dashboardRouter);
  app.use("/loans", loansRouter);
  app.use("/transactions", transactionsRouter);


  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

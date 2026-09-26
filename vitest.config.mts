import { config } from "dotenv";
import { defineConfig } from "vitest/config";

// The test database URL lives in the untracked .env.test (see .env.test.example), not in
// package.json, where it used to be committed. Variables already set, as in CI, win.
config({ path: ".env.test" });

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Every test shares one Postgres database, so they must not run concurrently — a parallel
    // truncate would pull rows out from under another test.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 20_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts", "src/**/*.d.ts"],
    },
  },
});

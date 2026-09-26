// Lint gate for the backend (R-11). Narrow on purpose: rules that catch real defects, not style.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", "eslint.config.mjs"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // backend/CLAUDE.md: no `any`.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  }
);

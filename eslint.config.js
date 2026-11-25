import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", ".wrangler/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // The sanitizer's patterns name the control characters they remove.
    files: ["src/content/sanitize.ts"],
    rules: { "no-control-regex": "off" },
  },
  {
    // Tests read recorded request bodies and schema internals freely.
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);

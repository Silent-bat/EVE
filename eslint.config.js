import js from "@eslint/js";
import tseslint from "typescript-eslint";
import nPlugin from "eslint-plugin-n";
import promisePlugin from "eslint-plugin-promise";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      ".eve-data/**",
      ".expo/**",
      "dist/**",
      "build/**",
      "android/**",
      "ios/**",
      "apps/preview/**",
      "apps/mobile/plugins/**",
      "**/.pnpm/**",
    ],
  },

  // Backend (Node ESM, JSDoc-typed)
  {
    files: ["services/api-node/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node },
    },
    plugins: { n: nPlugin, promise: promisePlugin },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "warn",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "promise/no-nesting": "warn",
      "promise/no-return-wrap": "error",
    },
  },

  // Mobile (TypeScript, React)
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["apps/mobile/**/*.ts", "apps/mobile/**/*.tsx"],
    languageOptions: {
      ...config.languageOptions,
      globals: { ...globals.browser, ...globals.node },
    },
  })),
  {
    files: ["apps/mobile/**/*.ts", "apps/mobile/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];

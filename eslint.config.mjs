import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import importPlugin from "eslint-plugin-import";
import unusedImports from "eslint-plugin-unused-imports";
import tseslint from "typescript-eslint";
import { localEslintPlugin } from "./eslint/rules/no-unknown-parameter-type.mjs";

const maxFileLines = 400;

export default defineConfig(
  {
    ignores: [
      "**/.next/**",
      ".next/**",
      "**/.astro/**",
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      ".boboddy/**",
      "scripts/**",
      "eslint/rules/**",
      "eslint.config.mjs",
      "**/*.d.ts",
      "**/*.gen.ts",
      "**/*.astro",
      "**/src/generated/**",
      "**/playwright-report/**",
      "**/test-results/**",
      // Astro apps: only have minimal TS shims, no meaningful code to lint
      "apps/docs/**",
      "apps/landing/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      "import/resolver": {
        typescript: true,
      },
    },
    plugins: {
      import: importPlugin,
      "unused-imports": unusedImports,
      "@next/next": nextPlugin,
      local: localEslintPlugin,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "import/first": "error",
      "import/no-default-export": "off",
      "import/no-duplicates": "error",
      "local/no-unknown-parameter-type": "error",
      "max-lines": [
        "error",
        {
          max: maxFileLines,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
      "no-console": [
        "error",
        {
          allow: ["warn", "error"],
        },
      ],
      "unused-imports/no-unused-imports": "error",
    },
  },
  {
    files: ["apps/next/**/*.{ts,tsx}"],
    settings: {
      next: {
        rootDir: "apps/next",
      },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  {
    files: ["apps/next/**/*.{ts,tsx}"],
    ignores: [
      "apps/next/app/_lib/analytics.ts",
      "apps/next/app/_lib/errors.ts",
      "apps/next/app/_lib/posthog-test-mock.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "posthog-js",
              message:
                "Import from @/app/_lib/analytics or @/app/_lib/errors instead of posthog-js directly.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/tests/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["**/scripts/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // In packages/core, test location defines the boundary:
    // colocated src tests are unit-only, while top-level tests are infra-backed.
    files: ["packages/core/tests/**/integration/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/*/application/*", "@boboddy/*/application/*"],
              message:
                "Integration tests must exercise the public API client boundary. Move direct application-layer tests into non-integration test files.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/core/src/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "testcontainers",
              message:
                "Colocated src tests are unit tests. Keep container-backed tests under packages/core/tests.",
            },
            {
              name: "@testcontainers/postgresql",
              message:
                "Colocated src tests are unit tests. Keep container-backed tests under packages/core/tests.",
            },
          ],
          patterns: [
            {
              group: ["**/tests", "**/tests/*", "@/lib/db", "@/lib/db/*"],
              message:
                "Colocated src tests are unit tests. Do not depend on shared test infra or the real database from src tests.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "packages/core/src/pipeline-executions/step-execution/application/**/*.ts",
    ],
    ignores: [
      "packages/core/src/pipeline-executions/step-execution/application/load-status-adjusted-step-executions.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name='stepExecutionRepo'][callee.property.name='load']",
          message:
            "Use the status-adjusted loader service for step execution reads.",
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name='stepExecutionRepo'][callee.property.name='listByProjectId']",
          message:
            "Use the status-adjusted loader service for step execution reads.",
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name='stepExecutionRepo'][callee.property.name='loadClaimableByProjectId']",
          message:
            "Use the status-adjusted loader service for step execution reads.",
        },
      ],
    },
  },
  {
    // JS/MJS/CJS files don't have a tsconfig project, so type-aware rules
    // must be disabled for them to avoid "parserOptions not set" errors.
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
  },
  eslintConfigPrettier,
);

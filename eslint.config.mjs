import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "reference/**",
      "**/*.js",
      "**/*.mjs",
    ],
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts"],
  })),
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // AGENTS.md non-negotiable rule: /core must never import an IDE-specific module.
    files: ["core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "vscode",
              message:
                "core must stay IDE-agnostic (AGENTS.md). IDE-specific logic belongs in adapters/.",
            },
          ],
          patterns: [
            {
              group: ["vscode*", "@vscode/*"],
              message:
                "core must stay IDE-agnostic (AGENTS.md). IDE-specific logic belongs in adapters/.",
            },
          ],
        },
      ],
    },
  },
);

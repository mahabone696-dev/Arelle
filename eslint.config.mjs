import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: [".next/**", "node_modules/**", "src/generated/**", "next-env.d.ts", ".claude/**"],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Business logic must stay framework-agnostic so the worker can reuse it.
    files: ["src/lib/**/*.ts", "src/server/**/*.ts"],
    ignores: ["src/server/auth/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["next", "next/*", "react", "react-dom"], message: "Keep src/lib and src/server framework-agnostic." }] }],
    },
  },
];

export default config;

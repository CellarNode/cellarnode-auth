import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.{ts,tsx}"],
    projects: [
      {
        extends: false,
        test: {
          name: "node",
          include: ["__tests__/**/*.test.{ts,tsx}"],
          exclude: ["__tests__/clerk-session-source.test.tsx"],
          environment: "node",
        },
      },
      {
        extends: false,
        test: {
          name: "clerk-dom",
          include: ["__tests__/clerk-session-source.test.tsx"],
          environment: "happy-dom",
        },
      },
    ],
  },
});

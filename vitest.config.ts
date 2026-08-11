import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.{ts,tsx}"],
    environmentMatchGlobs: [["**/login-form-responsive.test.tsx", "happy-dom"]],
  },
});

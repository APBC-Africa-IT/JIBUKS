import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    coverage: {
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});

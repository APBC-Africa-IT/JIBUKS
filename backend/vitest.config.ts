import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Fetches one shared Auth0 test token per run -- see the file header.
    globalSetup: ["packages/server/test/globalSetup.ts"],
    coverage: {
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});

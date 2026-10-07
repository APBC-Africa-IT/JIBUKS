import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Server tests go through HTTP and a real database; with every file
    // running in parallel, a test that takes ~1.5s alone can pass 5s.
    testTimeout: 20_000,
    // Fetches one shared Auth0 test token per run -- see the file header.
    globalSetup: ["packages/server/test/globalSetup.ts"],
    coverage: {
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});

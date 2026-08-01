import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Include all tests by default; use --project flag to filter
    include: ["test/**/*.test.ts"],
    // Integration tests may take longer due to DB operations
    testTimeout: 30000,
    hookTimeout: 30000,
    // Pool configuration for Node ESM modules
    pool: "forks",
  },
});

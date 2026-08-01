import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E config for PHASE-003-T7.
 *
 * Topology:
 *   - Vite dev server: http://localhost:5173 (must be started before running E2E)
 *   - Backend API: http://localhost:3000 (proxied via /api by Vite)
 *   - Database: postgresql://testuser:test@localhost:55434/app_test
 *   - Storage root: (dynamic temp path set by backend when ATTACHMENT_STORAGE_ROOT is unset)
 *
 * Usage:
 *   # In one terminal: start backend
 *   cd backend && DATABASE_URL=postgresql://testuser:test@localhost:55434/app_test NODE_ENV=development npx tsx src/index.ts
 *
 *   # In another terminal: start Vite dev server
 *   cd frontend && npm run dev
 *
 *   # Then run E2E:
 *   npx playwright test
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  expect: {
    timeout: 10000,
  },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

import { defineConfig } from "vitest/config";

// Unit tests only. Live tests run under @playwright/test, which owns browser lifecycle.
export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"], exclude: ["tests/live/**"] },
});

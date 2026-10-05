import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/live",
  // One worker: live tests start a fixture server and drive a browser. Parallelism here buys
  // little and makes a flake impossible to attribute.
  globalSetup: "./tests/live/global-setup.ts",
  workers: 1,
  reporter: "list",
  use: { trace: "retain-on-failure" },
});

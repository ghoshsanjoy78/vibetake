import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { APP_VERSION } from "../src/version.js";

it("APP_VERSION is package.json's version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  expect(APP_VERSION).toBe(pkg.version);
});

import { test, expect } from "@playwright/test";
import { serveFixture } from "../../src/fixture/serve.js";

test("every site serves, and the variants differ in exactly the intended way", async ({ page }) => {
  for (const [site, expected] of [["base", "New Comic"], ["renamed", "Create"]] as const) {
    const server = await serveFixture(site);
    try {
      await page.goto(server.url);
      await expect(page.getByRole("button", { name: expected, exact: true })).toHaveCount(1);
    } finally {
      await server.close();
    }
  }
});

test("the fixture never binds port 3000", async () => {
  const server = await serveFixture("base");
  try {
    expect(new URL(server.url).port).not.toBe("3000");
  } finally {
    await server.close();
  }
});

test("base has two Book now buttons and removed-dup has one", async ({ page }) => {
  for (const [site, count] of [["base", 2], ["removed-dup", 1]] as const) {
    const server = await serveFixture(site);
    try {
      await page.goto(server.url);
      await expect(page.getByRole("button", { name: "Book now", exact: true })).toHaveCount(count);
    } finally {
      await server.close();
    }
  }
});

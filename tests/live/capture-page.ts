import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import type { Capture } from "../../extension/src/types.js";

declare global {
  // What extension/dist/capture.js installs on a page; typed here for page.evaluate callbacks.
  var __vibetakeCapture: Capture;
}

const built = (file: string): string =>
  fileURLToPath(new URL(`../../extension/dist/${file}`, import.meta.url));

// Loads the very files the extension ships into an ordinary page, so the pure DOM logic is tested
// without the extension machinery around it.
export const loadCapture = async (page: Page): Promise<void> => {
  await page.addScriptTag({ path: built("vendor/playwright-injected.js") });
  await page.addScriptTag({ path: built("capture.js") });
};

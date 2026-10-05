import { test as base, chromium, expect, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBundle, type Bundle, type BundleV2 } from "../../src/capture/bundle.js";
import type { MediaStatus, Reply, Status, TestMedia } from "../../extension/src/messages.js";

const EXTENSION = fileURLToPath(new URL("../../extension/dist/", import.meta.url));
// Every fixture page carries this title, so the display-media seam picks a tab without a picker
// whichever site a test records against.
const CAPTURE_TITLE = "VibeTake fixture";

type Fixtures = { context: BrowserContext; worker: Worker; popup: Page };

export const test = base.extend<Fixtures>({
  // A fresh profile with the built extension loaded. `channel: "chromium"` is the new headless mode;
  // the headless shell cannot load extensions. The media flags make getDisplayMedia and the
  // microphone answer without a prompt.
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const profile = mkdtempSync(join(tmpdir(), "vibetake-chrome-"));
    const context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      args: [
        `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`,
        `--auto-select-tab-capture-source-by-title=${CAPTURE_TITLE}`,
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
      ],
    });
    await use(context);
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  },
  worker: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker"));
  },
  // The popup, opened as a tab so a test can click its buttons.
  popup: async ({ context, worker }, use) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await use(popup);
  },
});
export { expect };

// Stands in for the Record button: sets the stream seam (tests cannot click the toolbar, so the
// screen comes from getDisplayMedia), sends the same message the button sends naming the fixture tab
// explicitly (opened as a tab, the popup is itself the active tab), with the recorded page brought to
// the front first: stills come from the active tab, and Chrome throttles timers in a background tab.
export const startRecording = async (
  popup: Page, page: Page, url: string, seam: TestMedia = { screen: "display", mic: "allow" },
): Promise<Reply> => {
  // In front first: stills are captured from the active tab, and the start frame is grabbed at Record.
  await page.bringToFront();
  return popup.evaluate(async ([u, s]) => {
    await chrome.storage.local.set({ test_media: s });
    const [tab] = await chrome.tabs.query({ url: `${u}*` });
    return chrome.runtime.sendMessage({ type: "start", tabId: tab?.id }) as Promise<Reply>;
  }, [url, seam] as const);
};

export const status = (popup: Page): Promise<Status> =>
  popup.evaluate(() => chrome.runtime.sendMessage({ type: "status" }) as Promise<Status>);

export const mediaStatus = (popup: Page, id: string): Promise<MediaStatus> =>
  popup.evaluate(i => chrome.runtime.sendMessage({ type: "media-status", id: i }) as Promise<MediaStatus>, id);

// Clicks the first recording's Export button and reads back the zip it downloads.
export const exportZip = async (popup: Page): Promise<{ bundle: BundleV2; entries: Record<string, Uint8Array>; file: string }> => {
  const [download] = await Promise.all([
    popup.waitForEvent("download"),
    popup.getByRole("button", { name: "Export" }).first().click(),
  ]);
  const file = await download.path();
  if (!download.suggestedFilename().endsWith(".zip")) throw new Error(`expected a zip, got ${download.suggestedFilename()}`);
  const entries = unzipSync(new Uint8Array(readFileSync(file)));
  const bundle = parseBundle(JSON.parse(strFromU8(entries["bundle.json"]!)));
  if (bundle.bundle_format !== 2) throw new Error("expected a format-2 bundle");
  return { bundle, entries, file };
};

// The bundle alone, for tests that care about steps rather than media.
export const exportFirst = async (popup: Page): Promise<Bundle> => (await exportZip(popup)).bundle;

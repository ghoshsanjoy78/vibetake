import { serveFixture } from "../../src/fixture/serve.js";
import type { Page } from "@playwright/test";
import { test, expect, exportZip, mediaStatus, startRecording, status } from "./extension-fixture.js";

const on = (site: string) => async (fn: (url: string) => Promise<void>) => {
  const server = await serveFixture(site);
  try { await fn(server.url); } finally { await server.close(); }
};

// WebM files begin with the EBML magic.
const isWebm = (bytes: Uint8Array | undefined): boolean =>
  !!bytes && bytes.length > 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;


// Chrome's answer about a device, as the popup sees it (the fake prompt flag would say "granted" for everything).
const grants = (popup: Page, g: { microphone?: "granted" | "prompt" | "denied"; camera?: "granted" | "prompt" | "denied" }) =>
  popup.evaluate(async x => {
    const have = ((await chrome.storage.local.get("test_grants")) as { test_grants?: object }).test_grants ?? {};
    await chrome.storage.local.set({ test_grants: { ...have, ...x } });
  }, g);

test("records the screen and the voice into the zip, on one clock", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    expect(await startRecording(popup, page, url)).toEqual({ ok: true });
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: "Start" }).click();
    await expect.poll(async () => (await status(popup)).recording?.steps).toBe(1);
    const before = Date.now();
    await popup.locator("#stop").click();
    const { bundle, entries } = await exportZip(popup);
    expect(bundle.media).toEqual({ screen: "recorded", voice: "recorded", camera: "not requested" });
    expect(isWebm(entries["screen.webm"]), "screen.webm is WebM").toBe(true);
    expect(isWebm(entries["voice.webm"]), "voice.webm is WebM").toBe(true);
    expect(entries["screen.webm"]!.length).toBeGreaterThan(10_000);
    // Each recorder began shortly after Record, and ran until Stop.
    for (const track of [bundle.screen!, bundle.voice!]) {
      expect(track.offset_ms).toBeGreaterThanOrEqual(0);
      expect(track.offset_ms).toBeLessThan(3000);
      const wall = Date.parse(bundle.sealed_at) - Date.parse(bundle.started_at) - track.offset_ms;
      expect(Math.abs(track.duration_ms! - wall)).toBeLessThan(1500);
    }
    expect(bundle.screen!.width).toBeGreaterThan(0);
    expect(Date.parse(bundle.sealed_at)).toBeGreaterThanOrEqual(before - 1000);
  });
});

test("a refused microphone starts the recording anyway and says so", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    expect(await startRecording(popup, page, url, { screen: "display", mic: "deny" })).toEqual({ ok: true });
    await page.getByRole("button", { name: "Start" }).click();
    await expect.poll(async () => (await status(popup)).recording?.steps).toBe(1);
    await popup.locator("#stop").click();
    const { bundle, entries } = await exportZip(popup);
    expect(bundle.media.screen).toBe("recorded");
    expect(bundle.media.voice).toMatch(/^unavailable: /);
    expect(bundle.voice).toBeNull();
    expect(entries["voice.webm"]).toBeUndefined();
    expect(isWebm(entries["screen.webm"])).toBe(true);
  });
});

test("a tab that cannot be captured refuses to start, and leaves nothing behind", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    const reply = await startRecording(popup, page, url, { screen: "fail", mic: "allow" });
    expect(reply).toEqual({ ok: false, reason: expect.stringContaining("could not capture this tab") });
    expect((await status(popup)).recording).toBeNull();
    expect((await status(popup)).bundles).toEqual([]);
    // Nothing is left recording, and nothing was written that no bundle can ever delete.
    await page.waitForTimeout(1500);
    const left = await popup.evaluate(async () => {
      const module = "./media-store.js";
      const { openMedia } = await import(module);
      const db = await openMedia();
      return new Promise<number>((ok, fail) => {
        const r = db.transaction("chunks").objectStore("chunks").count();
        r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error);
      });
    });
    expect(left).toBe(0);
  });
});

test("a recorder that dies leaves the steps and the other track intact, and says where it ended", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url);
    await page.getByRole("button", { name: "Start" }).click();
    await expect.poll(async () => (await status(popup)).recording?.steps).toBe(1);
    await page.waitForTimeout(1200);
    expect(await popup.evaluate(() => chrome.runtime.sendMessage({ type: "media-test-end", track: "voice" }))).toEqual({ ok: true });
    await page.getByRole("button", { name: "Start" }).click();
    await expect.poll(async () => (await status(popup)).recording?.steps).toBe(2);
    await popup.locator("#stop").click();
    const { bundle, entries } = await exportZip(popup);
    expect(bundle.media.voice).toMatch(/^ended at \d+: /);
    expect(bundle.media.screen).toBe("recorded");
    expect(bundle.steps).toHaveLength(2);
    expect(isWebm(entries["screen.webm"])).toBe(true);
    expect(isWebm(entries["voice.webm"]), "what was recorded before the death is kept").toBe(true);
  });
});

test("live status reports both tracks producing chunks while recording", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url);
    const id = (await status(popup)).recording!.id;
    await page.waitForTimeout(2200);
    const live = await mediaStatus(popup, id);
    expect(live.screen?.bytes).toBeGreaterThan(0);
    expect(live.voice?.bytes).toBeGreaterThan(0);
    expect(live.screen?.ms_since_chunk).toBeLessThan(2000);
    expect(live.screen?.ended).toBe(false);
    await popup.locator("#stop").click();
  });
});

test("deleting a recording removes its media from IndexedDB", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url);
    await page.getByRole("button", { name: "Start" }).click();
    await expect.poll(async () => (await status(popup)).recording?.steps).toBe(1);
    await popup.locator("#stop").click();
    await exportZip(popup);
    const id = (await status(popup)).bundles[0]!.id;
    const count = () => popup.evaluate(async i => {
      // A variable specifier: the module is the extension's, resolved against the popup page's URL.
      const module = "./media-store.js";
      const { openMedia, countChunks, zipOf } = await import(module);
      const db = await openMedia();
      return { chunks: await countChunks(db, i), zip: (await zipOf(db, i)) !== null };
    }, id);
    expect(await count()).toMatchObject({ zip: true });
    expect((await count()).chunks).toBeGreaterThan(0);
    await popup.getByRole("button", { name: "Delete" }).click();
    await expect(popup.locator("#bundles li")).toHaveCount(0);
    expect(await count()).toEqual({ chunks: 0, zip: false });
  });
});

const isJpeg = (bytes: Uint8Array | undefined): boolean => !!bytes && bytes[0] === 0xff && bytes[1] === 0xd8;

test("frames are grabbed at start, at each action, when it settles, and at stop — named by their timestamp", async ({ page, popup }) => {
  await on("base")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url);
    await page.getByRole("button", { name: "New Comic" }).click();
    await page.getByRole("textbox", { name: "Title" }).waitFor();
    await expect.poll(async () => (await status(popup)).recording?.media.frames).toBeGreaterThanOrEqual(3);   // start, action, settled
    await popup.locator("#stop").click();
    const { bundle, entries } = await exportZip(popup);
    const moments = bundle.frames.map(f => [f.step, f.moment]);
    expect(moments).toEqual([[null, "start"], [1, "action"], [1, "settled"], [null, "stop"]]);
    for (const frame of bundle.frames) {
      expect(frame.file, frame.moment).not.toBeNull();
      expect(frame.file).toBe(`frames/${String(frame.at_ms).padStart(8, "0")}-${frame.step === null ? frame.moment : `step01-${frame.moment}`}.jpg`);
      expect(isJpeg(entries[frame.file!]), frame.file!).toBe(true);
    }
    const [, action, settled] = bundle.frames;
    expect(action!.at_ms).toBeGreaterThanOrEqual(bundle.steps[0]!.at_ms);
    expect(settled!.at_ms).toBeGreaterThanOrEqual(action!.at_ms);
    expect(settled!.at_ms).toBe(bundle.steps[0]!.settled_at_ms);
  });
});

test("the popup shows each stream, and the viewport is recorded", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url);
    await expect(popup.locator("#media")).toContainText("Screen ●");
    await expect(popup.locator("#media")).toContainText("Voice ●");
    await expect(popup.locator("#media")).toContainText(/\d+ frames?/);
    const rec = (await status(popup)).recording!;
    expect(rec.media.screen).toBe("recorded");
    const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, device_pixel_ratio: devicePixelRatio }));
    await popup.locator("#stop").click();
    const { bundle } = await exportZip(popup);
    expect(bundle.viewport).toEqual(actual);
    expect(typeof bundle.window_resized).toBe("boolean");
    if (bundle.window_resized) expect(Math.abs(bundle.viewport!.width / bundle.viewport!.height - 16 / 9)).toBeLessThan(0.01);
  });
});

test("a refused microphone is shown in the popup from the first second", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url, { screen: "display", mic: "deny" });
    await expect(popup.locator("#media")).toContainText("Voice: unavailable");
    await popup.locator("#stop").click();
  });
});

test("the permission window asks for the microphone on load, reports the grant, and closes itself", async ({ popup, worker }) => {
  const id = new URL(worker.url()).host;
  const permission = await popup.context().newPage();
  await permission.goto(`chrome-extension://${id}/permission.html?device=microphone`);
  await expect(permission.locator("#done")).toBeVisible();   // toContainText alone passes on the hidden paragraph
  await expect(permission.locator("#done")).toContainText("Allowed");
  await permission.waitForEvent("close");   // the window closes itself after the grant
  expect(await popup.evaluate(() => chrome.storage.local.get("micGranted"))).toEqual({ micGranted: true });
});

test("with the voice switch off, no microphone is asked for and the bundle says so", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    expect(await startRecording(popup, page, url, { screen: "display", mic: "off" })).toEqual({ ok: true });
    await expect(popup.locator("#media")).toContainText("Screen \u25cf");
    await expect(popup.locator("#media")).not.toContainText("Voice");
    await page.getByRole("button", { name: "Start" }).click();
    await expect.poll(async () => (await status(popup)).recording?.steps).toBe(1);
    await popup.locator("#stop").click();
    const { bundle, entries } = await exportZip(popup);
    expect(bundle.media.voice).toBe("unavailable: not requested");
    expect(bundle.voice).toBeNull();
    expect(entries["voice.webm"]).toBeUndefined();
    expect(bundle.transcript.status).toBe("unavailable: the microphone was not recorded");
  });
});

test("Record opens the microphone window while Chrome still has to ask, and records once it is allowed", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await popup.bringToFront();
    await grants(popup, { microphone: "prompt" });
    const [opened] = await Promise.all([popup.context().waitForEvent("page"), popup.locator("#record").click()]);
    expect(opened.url()).toMatch(/permission\.html\?device=microphone$/);
    expect(await popup.evaluate(() => chrome.storage.local.get(["micAsked", "micGranted"]))).toEqual({ micAsked: true, micGranted: false });
    await opened.close();
    expect((await status(popup)).recording).toBeNull();
    // Closed without answering: Chrome would still ask, so the next press opens the page again rather
    // than recording without a voice the person never refused.
    const [again] = await Promise.all([popup.context().waitForEvent("page"), popup.locator("#record").click()]);
    expect(again.url()).toMatch(/permission\.html\?device=microphone$/);
    await again.waitForEvent("close");   // it asks on load; Chromium's fake prompt allows; it closes itself
    await grants(popup, { microphone: "granted" });   // what Chrome now answers
    // Granted: the next press goes to Record (the popup tab is itself the active tab here, so it is
    // refused for that reason — the point is that permission.html did not open again).
    const pages = popup.context().pages().length;
    await popup.locator("#record").click();
    await expect(popup.locator("#refusal")).toContainText("cannot record this page");
    expect(popup.context().pages().length).toBe(pages);
  });
});

test("a stale grant flag does not skip the permission window: Chrome's answer wins", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await popup.bringToFront();
    // The extension remembers a grant Chrome no longer has (a reinstalled extension, a cleared site setting).
    await popup.evaluate(() => chrome.storage.local.set({ micGranted: true, micAsked: true }));
    await grants(popup, { microphone: "prompt" });
    const [opened] = await Promise.all([popup.context().waitForEvent("page"), popup.locator("#record").click()]);
    expect(opened.url()).toMatch(/permission\.html\?device=microphone$/);
    expect((await status(popup)).recording).toBeNull();
    expect(await popup.evaluate(() => chrome.storage.local.get("micGranted"))).toEqual({ micGranted: false });
    await opened.close();
  });
});

test("a recorder that has gone shows as gone, and Stop still seals what was recorded", async ({ page, popup, worker }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url);
    await page.waitForTimeout(2200);
    await worker.evaluate(() => chrome.offscreen.closeDocument());
    await expect(popup.locator("#media")).toContainText("recorder not responding");
    // The next step's frame recreates an empty document: it answers, but has no such track.
    await page.getByRole("button", { name: "Start" }).click();
    await expect(popup.locator("#media")).toContainText("recorder lost this track");
    await popup.locator("#stop").click();
    const { bundle, entries } = await exportZip(popup);
    expect(bundle.media.screen).toMatch(/^ended at \d+: /);
    expect(bundle.media.voice).toMatch(/^ended at \d+: /);
    expect(bundle.frames.at(-1)).toMatchObject({ moment: "stop", file: null, reason: expect.any(String) });
    expect(Object.keys(entries)).toContain("bundle.json");
    expect(entries["screen.webm"]?.length ?? 0).toBeGreaterThan(0);   // the chunks recorded before the close
  });
});

test("a step that navigates settles on the new page, with exactly one settled frame", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url);
    await page.getByRole("link", { name: "Next page" }).click();
    await page.waitForURL("**/two.html");
    await page.waitForTimeout(800);   // re-injection, the await for "Arrived", and the quiet period
    await popup.locator("#stop").click();
    const { bundle } = await exportZip(popup);
    expect(bundle.steps[0]?.await).toEqual({ label: "Arrived", role: "button" });
    expect(bundle.steps[0]?.settled_at_ms).not.toBeNull();
    expect(bundle.frames.map(f => [f.step, f.moment])).toEqual([[null, "start"], [1, "action"], [1, "settled"], [null, "stop"]]);
  });
});

import { serveFixture } from "../../src/fixture/serve.js";
import type { Page } from "@playwright/test";
import { test, expect, exportZip, startRecording, status } from "./extension-fixture.js";

const on = (site: string) => async (fn: (url: string) => Promise<void>) => {
  const server = await serveFixture(site);
  try { await fn(server.url); } finally { await server.close(); }
};
const isWebm = (bytes: Uint8Array | undefined): boolean =>
  !!bytes && bytes.length > 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;


// Chrome's answer about a device, as the popup sees it (the fake prompt flag would say "granted" for everything).
const grants = (popup: Page, g: { microphone?: "granted" | "prompt" | "denied"; camera?: "granted" | "prompt" | "denied" }) =>
  popup.evaluate(async x => {
    const have = ((await chrome.storage.local.get("test_grants")) as { test_grants?: object }).test_grants ?? {};
    await chrome.storage.local.set({ test_grants: { ...have, ...x } });
  }, g);

test("with the camera on, camera.webm is recorded beside the voice, on one clock, and the popup shows it", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    expect(await startRecording(popup, page, url, { screen: "display", mic: "allow", camera: "allow" })).toEqual({ ok: true });
    await expect(popup.locator("#media")).toContainText("Camera \u25cf");
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: "Start" }).click();
    await expect.poll(async () => (await status(popup)).recording?.steps).toBe(1);
    await popup.locator("#stop").click();
    const { bundle, entries } = await exportZip(popup);
    expect(bundle.media).toEqual({ screen: "recorded", voice: "recorded", camera: "recorded" });
    expect(bundle.camera).toMatchObject({ file: "camera.webm" });
    expect(bundle.camera!.width).toBeGreaterThan(0);
    expect(bundle.camera!.height).toBeGreaterThan(0);
    expect(isWebm(entries["camera.webm"]), "camera.webm is WebM").toBe(true);
    expect(entries["camera.webm"]!.length).toBeGreaterThan(10_000);
    expect(isWebm(entries["voice.webm"]), "voice.webm still exists").toBe(true);
    // Both began shortly after Record and ran until Stop.
    for (const track of [bundle.voice!, bundle.camera!]) {
      expect(track.offset_ms).toBeGreaterThanOrEqual(0);
      expect(track.offset_ms).toBeLessThan(3000);
      const wall = Date.parse(bundle.sealed_at) - Date.parse(bundle.started_at) - track.offset_ms;
      expect(Math.abs(track.duration_ms! - wall)).toBeLessThan(1500);
    }
  });
});

test("a refused camera starts the recording anyway, keeps the voice, and says why", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    expect(await startRecording(popup, page, url, { screen: "display", mic: "allow", camera: "deny" })).toEqual({ ok: true });
    await expect(popup.locator("#media")).toContainText("Camera: unavailable");
    await page.getByRole("button", { name: "Start" }).click();
    await expect.poll(async () => (await status(popup)).recording?.steps).toBe(1);
    await popup.locator("#stop").click();
    const { bundle, entries } = await exportZip(popup);
    expect(bundle.media.camera).toMatch(/^unavailable: /);
    expect(bundle.media.voice).toBe("recorded");
    expect(bundle.camera).toBeNull();
    expect(entries["camera.webm"]).toBeUndefined();
    expect(isWebm(entries["voice.webm"])).toBe(true);
  });
});

test("with the camera off there is no camera line, no file, and the bundle says not requested", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url);
    await expect(popup.locator("#media")).toContainText("Voice \u25cf");
    await expect(popup.locator("#media")).not.toContainText("Camera");
    await popup.locator("#stop").click();
    const { bundle, entries } = await exportZip(popup);
    expect(bundle.media.camera).toBe("not requested");
    expect(bundle.camera).toBeNull();
    expect(entries["camera.webm"]).toBeUndefined();
  });
});

test("a camera that dies leaves the voice recording and marks where it ended", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url, { screen: "display", mic: "allow", camera: "allow" });
    await page.waitForTimeout(1500);
    expect(await popup.evaluate(() => chrome.runtime.sendMessage({ type: "media-test-end", track: "camera" }))).toEqual({ ok: true });
    await page.waitForTimeout(1500);
    await popup.locator("#stop").click();
    const { bundle, entries } = await exportZip(popup);
    expect(bundle.media.camera).toMatch(/^ended at \d+: /);
    expect(bundle.media.voice).toBe("recorded");
    expect(bundle.voice!.duration_ms!).toBeGreaterThan(2500);
    expect(isWebm(entries["camera.webm"]), "what was recorded before the death is kept").toBe(true);
  });
});

test("a microphone that dies leaves the camera recording", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url, { screen: "display", mic: "allow", camera: "allow" });
    await page.waitForTimeout(1500);
    expect(await popup.evaluate(() => chrome.runtime.sendMessage({ type: "media-test-end", track: "voice" }))).toEqual({ ok: true });
    await page.waitForTimeout(1500);
    await popup.locator("#stop").click();
    const { bundle } = await exportZip(popup);
    expect(bundle.media.voice).toMatch(/^ended at \d+: /);
    expect(bundle.media.camera).toBe("recorded");
    expect(bundle.camera!.duration_ms!).toBeGreaterThan(bundle.voice!.duration_ms!);
  });
});

test("a refused microphone with the camera allowed starts anyway with neither voice nor camera, and says why for each", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    expect(await startRecording(popup, page, url, { screen: "display", mic: "deny", camera: "allow" })).toEqual({ ok: true });
    await expect(popup.locator("#media")).toContainText("Voice: unavailable");
    await expect(popup.locator("#media")).toContainText("Camera: unavailable");
    await popup.locator("#stop").click();
    const { bundle, entries } = await exportZip(popup);
    expect(bundle.media.voice).toMatch(/^unavailable: .*microphone refused/);
    expect(bundle.media.camera).toMatch(/^unavailable: .*microphone refused/);
    expect(bundle.camera).toBeNull();
    expect(entries["camera.webm"]).toBeUndefined();
  });
});

test("turning the camera on opens the permission window once; the grant is recorded", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await popup.bringToFront();
    await grants(popup, { microphone: "granted", camera: "prompt" });
    const [opened] = await Promise.all([popup.context().waitForEvent("page"), popup.locator("#camera").check()]);
    expect(opened.url()).toMatch(/permission\.html\?device=camera$/);
    expect(await popup.evaluate(() => chrome.storage.local.get(["camera", "cameraAsked"]))).toEqual({ camera: true, cameraAsked: true });
    await expect(opened.locator("#done")).toBeVisible();
    await opened.waitForEvent("close");
    await grants(popup, { camera: "granted" });   // what Chrome now answers
    // The camera is asked for with its microphone while the voice switch is on: Chrome grants both.
    expect(await popup.evaluate(() => chrome.storage.local.get(["cameraGranted", "micGranted"]))).toEqual({ cameraGranted: true, micGranted: true });
    await popup.locator("#camera").uncheck();
    expect(await popup.evaluate(() => chrome.storage.local.get("camera"))).toEqual({ camera: false });
  });
});

test("Record with the camera on but not yet granted opens the permission window, and again until Chrome has an answer", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await popup.bringToFront();
    // The microphone is settled; the camera was asked about once and never answered: the user's case.
    await grants(popup, { microphone: "granted", camera: "prompt" });
    await popup.evaluate(() => chrome.storage.local.set({ micGranted: true, micAsked: true, camera: true, cameraAsked: true }));
    const [opened] = await Promise.all([popup.context().waitForEvent("page"), popup.locator("#record").click()]);
    expect(opened.url()).toMatch(/permission\.html\?device=camera$/);
    await expect(popup.locator("#refusal")).toContainText("Answer Chrome's camera prompt in the small window that just opened");
    expect((await status(popup)).recording).toBeNull();
    await opened.close();
    // Still unanswered: the next press opens it again rather than recording without the camera.
    const [again] = await Promise.all([popup.context().waitForEvent("page"), popup.locator("#record").click()]);
    expect((await status(popup)).recording).toBeNull();
    await again.waitForEvent("close");   // asks on load; the fake prompt allows; closes itself
    await grants(popup, { camera: "granted" });
    // Granted: the next press goes to Record (refused here only because the popup tab is the active one).
    const pages = popup.context().pages().length;
    await popup.locator("#record").click();
    await expect(popup.locator("#refusal")).toContainText("cannot record this page");
    expect(popup.context().pages().length).toBe(pages);
  });
});

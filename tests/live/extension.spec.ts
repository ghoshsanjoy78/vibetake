import { serveFixture } from "../../src/fixture/serve.js";
import { test, expect, exportFirst, exportZip, startRecording, status } from "./extension-fixture.js";

const on = (site: string) => async (fn: (url: string) => Promise<void>) => {
  const server = await serveFixture(site);
  try { await fn(server.url); } finally { await server.close(); }
};

test("refuses to record a page it cannot see, and says why", async ({ popup }) => {
  // Opened as a tab, the popup is the active tab, and an extension page cannot be scripted.
  await popup.evaluate(() => chrome.storage.local.set({ micAsked: true }));   // the microphone page is not what is under test
  await popup.locator("#record").click();
  await expect(popup.locator("#refusal")).toContainText("cannot record this page");
  expect((await status(popup)).recording).toBeNull();
});

test("the step count advances only when a step is captured, and the badge reads REC", async ({ page, popup, worker }) => {
  await on("capture")(async url => {
    await page.goto(url);
    expect(await startRecording(popup, page, url)).toEqual({ ok: true });
    expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe("REC");
    await page.locator("#nameless").click();
    await page.getByRole("button", { name: "Start" }).click();
    await expect.poll(async () => {
      const r = (await status(popup)).recording;
      return [r?.steps, r?.dropped.length];
    }).toEqual([1, 1]);
    await expect(popup.locator("#state")).toContainText("1 step");
    await expect(popup.locator("#dropped")).toContainText("no button, link or other control");
    // The dropped click still says where it landed, and has its own still.
    await popup.locator("#stop").click();
    const bundle = await exportFirst(popup);
    if (bundle.bundle_format !== 2) throw new Error("expected a format-2 bundle");
    expect(bundle.dropped[0]).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    const still = bundle.frames.find(f => f.moment === "dropped");
    expect(still).toBeDefined();
    expect(still!.at_ms).toBe(bundle.dropped[0]!.at_ms);
    expect(still!.file).toMatch(/^frames\/\d{8}-dropped\.jpg$/);
  });
});

test("a second Record while one is running is refused in plain words", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    expect(await startRecording(popup, page, url)).toEqual({ ok: true });
    expect(await startRecording(popup, page, url)).toEqual({ ok: false, reason: expect.stringContaining("already running") });
  });
});

test("recording continues across a navigation; the navigation is a beat, not a step", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url);
    await page.getByRole("link", { name: "Next page" }).click();
    await page.waitForURL("**/two.html");
    // Re-injection after a navigation is asynchronous. A person cannot click within half a second
    // of a page appearing; Playwright can.
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Arrived" }).click();
    await expect.poll(async () => (await status(popup)).recording?.steps).toBe(2);
    await popup.locator("#stop").click();
    const bundle = await exportFirst(popup);
    expect(bundle.steps.map(s => [s.do, s.target.label])).toEqual([["click", "Next page"], ["click", "Arrived"]]);
    // The link's await was found on the page the link led to.
    expect(bundle.steps[0]?.await).toEqual({ label: "Arrived", role: "button" });
    expect(bundle.beats).toEqual([{ kind: "navigation", at_ms: expect.any(Number), url: `${url}two.html` }]);
    expect(bundle.start_url).toBe(url);
  });
});

test("a page that cannot be recorded pauses the recording visibly, and leaving it resumes", async ({ page, popup, worker }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url);
    await page.goto("chrome://version/");
    await expect.poll(async () => (await status(popup)).recording?.paused).toContain("cannot be recorded");
    expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe("!");
    await expect(popup.locator("#paused")).toContainText("cannot be recorded");
    await page.goto(url);
    await expect.poll(async () => (await status(popup)).recording?.paused).toBeNull();
    await page.getByRole("button", { name: "Start" }).click();
    await expect.poll(async () => (await status(popup)).recording?.steps).toBe(1);
    expect((await status(popup)).recording).not.toBeNull();   // paused, never sealed
  });
});

test("a value committed in a field inside a shadow root is captured", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url);
    await page.getByRole("textbox", { name: "Nickname" }).fill("Sam");
    await page.getByRole("button", { name: "Start" }).click();
    await expect.poll(async () => (await status(popup)).recording?.steps).toBe(2);
    await popup.locator("#stop").click();
    const bundle = await exportFirst(popup);
    expect(bundle.steps[0]).toMatchObject({ do: "type", value: "Sam", target: { label: "Nickname", role: "textbox", nth: 1 } });
  });
});

test("Enter in a form with no button is shown as not captured", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url);
    await page.getByRole("searchbox", { name: "Find" }).fill("rome");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await status(popup)).recording?.dropped.map(d => d.reason))
      .toEqual([expect.stringContaining("keyboard")]);
    expect((await status(popup)).recording?.steps).toBe(1);   // the typed value itself was captured
    await expect(popup.locator("#dropped")).toContainText("keyboard");
  });
});

test("closing the recorded tab seals what was captured, marked incomplete, and keeps it", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url);
    await page.getByRole("button", { name: "Start" }).click();
    await expect.poll(async () => (await status(popup)).recording?.steps).toBe(1);
    await page.close();
    await expect.poll(async () => (await status(popup)).recording).toBeNull();
    expect((await status(popup)).bundles).toEqual([
      expect.objectContaining({ steps: 1, complete: false, incomplete_reason: expect.stringContaining("closed"), exported: false }),
    ]);
  });
});

test("when the recording cannot be saved it stops cleanly, keeps what was saved, and says so", async ({ page, popup, worker }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url);
    await page.getByRole("button", { name: "Start" }).click();
    await expect.poll(async () => (await status(popup)).recording?.steps).toBe(1);
    // From here, any write that carries a live recording fails, as a full disk or quota would make it.
    await worker.evaluate(() => {
      const real = chrome.storage.local.set.bind(chrome.storage.local);
      (chrome.storage.local as unknown as { set: (items: Record<string, unknown>) => Promise<void> }).set =
        items => items["recording"] ? Promise.reject(new Error("QUOTA_BYTES quota exceeded")) : real(items);
    });
    await page.getByRole("button", { name: "Start" }).click();
    await expect.poll(async () => (await status(popup)).recording).toBeNull();
    const s = await status(popup);
    expect(s.fault).toContain("could not save the recording");
    expect(s.bundles).toEqual([expect.objectContaining({ steps: 1, complete: false, incomplete_reason: expect.stringContaining("could not save") })]);
    expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe("ERR");
    await expect(popup.locator("#fault")).toContainText("could not save");
    // The page was told it is not being heard: further clicks change nothing.
    await page.getByRole("button", { name: "Start" }).click();
    await page.waitForTimeout(300);
    expect((await status(popup)).bundles).toHaveLength(1);
    expect((await status(popup)).recording).toBeNull();
  });
});

test("Stop seals a complete recording; Export downloads it; Delete only after that", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url);
    await page.getByRole("button", { name: "Start" }).click();
    await expect.poll(async () => (await status(popup)).recording?.steps).toBe(1);
    await popup.locator("#stop").click();
    await expect(popup.locator("#bundles li")).toHaveCount(1);
    await expect(popup.getByRole("button", { name: "Delete" })).toBeDisabled();
    // The rule lives in the worker, not in the button: a raw delete is refused too.
    const id = (await status(popup)).bundles[0]!.id;
    expect(await popup.evaluate(i => chrome.runtime.sendMessage({ type: "delete", id: i }), id))
      .toEqual({ ok: false, reason: expect.stringContaining("Export") });
    expect((await status(popup)).bundles).toHaveLength(1);
    const bundle = await exportFirst(popup);
    expect(bundle).toMatchObject({ complete: true, incomplete_reason: null, title: "VibeTake fixture" });
    expect(bundle.steps).toHaveLength(1);
    await expect(popup.locator("#bundles")).toContainText("exported");
    await expect(popup.getByRole("button", { name: "Delete" })).toBeEnabled();
    await popup.getByRole("button", { name: "Delete" }).click();
    await expect(popup.locator("#bundles li")).toHaveCount(0);
  });
});

test("an empty recording may be deleted without exporting it", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url);
    await popup.locator("#stop").click();
    await expect(popup.getByRole("button", { name: "Delete" })).toBeEnabled();
  });
});

test("recordings are listed newest first", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    for (let i = 0; i < 2; i++) {
      await startRecording(popup, page, url);
      await popup.locator("#stop").click();
      await expect(popup.locator("#bundles li")).toHaveCount(i + 1);
    }
    const ids = (await status(popup)).bundles.map(b => b.id);
    const shown = await popup.locator("#bundles li button[data-export]").evaluateAll(els => els.map(e => e.getAttribute("data-export")));
    expect(shown).toEqual([...ids].sort().reverse());
    expect(shown[0]).not.toBe(ids[0]);   // the worker keeps them in the order they were made
  });
});

test("a captured click carries where it landed; the pointer trail is on the clock and throttled", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url);
    await page.mouse.move(10, 10);
    for (let i = 1; i <= 20; i++) await page.mouse.move(10 + i * 5, 10 + i * 3);   // ~20 moves in a few ms
    await page.waitForTimeout(1200);                                               // one flush interval
    const clickedAt = await page.evaluate(() => Date.now());   // the page's clock, just before the click
    await page.getByRole("button", { name: "Start" }).click();
    await expect.poll(async () => (await status(popup)).recording?.steps).toBe(1);
    await popup.locator("#stop").click();
    const { bundle, entries } = await exportZip(popup);
    // The step is stamped on the page's clock, as the pointer trail is: the two agree.
    expect(Math.abs(bundle.steps[0]!.at_ms - (clickedAt - Date.parse(bundle.started_at)))).toBeLessThan(150);
    const click = bundle.steps[0]?.click;
    expect(click).not.toBeNull();
    expect(click!.x).toBeGreaterThanOrEqual(click!.box.x);
    expect(click!.x).toBeLessThanOrEqual(click!.box.x + click!.box.width);
    expect(click!.y).toBeGreaterThanOrEqual(click!.box.y);
    expect(click!.y).toBeLessThanOrEqual(click!.box.y + click!.box.height);
    // The trail is its own file, named by the bundle, and bundle.json carries no samples itself.
    expect(bundle.pointer_file).toBe("pointer.json");
    expect(bundle.pointer).toEqual([]);
    const pointer = JSON.parse(new TextDecoder().decode(entries["pointer.json"])) as { t: number; x: number; y: number }[];
    expect(pointer.length).toBeGreaterThan(0);
    for (let i = 1; i < pointer.length; i++) {
      expect(pointer[i]!.t).toBeGreaterThanOrEqual(pointer[i - 1]!.t);
      expect(pointer[i]!.t - pointer[i - 1]!.t).toBeGreaterThanOrEqual(45);   // ≤ 20 samples/s
    }
    expect(bundle.viewport).not.toBeNull();
  });
});

test("a click from the keyboard is recorded at the centre of the control", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url);
    await page.getByRole("button", { name: "Start" }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await status(popup)).recording?.steps).toBe(1);
    await popup.locator("#stop").click();
    const bundle = await exportFirst(popup);
    if (bundle.bundle_format !== 2) throw new Error("expected a format-2 bundle");
    const click = bundle.steps[0]?.click;
    expect(click).not.toBeNull();
    expect(click!.x).toBe(Math.round(click!.box.x + click!.box.width / 2));
    expect(click!.y).toBe(Math.round(click!.box.y + click!.box.height / 2));
    expect(click!.box.width).toBeGreaterThan(0);
  });
});

test("a step settles when the page comes to rest, and a resize is a beat", async ({ page, popup }) => {
  await on("capture")(async url => {
    await page.goto(url);
    await startRecording(popup, page, url);
    await page.getByRole("button", { name: "Start" }).click();
    await expect.poll(async () => (await status(popup)).recording?.steps).toBe(1);
    await page.setViewportSize({ width: 900, height: 600 });
    await page.waitForTimeout(800);   // the quiet period, plus the resize debounce
    await popup.locator("#stop").click();
    const bundle = await exportFirst(popup);
    if (bundle.bundle_format !== 2) throw new Error("expected a format-2 bundle");
    expect(bundle.steps[0]?.settled_at_ms).not.toBeNull();
    expect(bundle.steps[0]!.settled_at_ms!).toBeGreaterThanOrEqual(bundle.steps[0]!.at_ms);
    expect(bundle.beats).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "viewport", width: 900, height: 600 }),
    ]));
  });
});

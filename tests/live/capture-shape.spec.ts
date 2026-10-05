import { test, expect, type Page } from "@playwright/test";
import type { ShapeResult } from "../../extension/src/types.js";
import { serveFixture } from "../../src/fixture/serve.js";
import { loadCapture } from "./capture-page.js";

// Exactly the three listeners content.ts installs, minus the messaging: every result is kept so a test
// can also assert on what was ignored.
const listen = async (page: Page): Promise<void> => {
  await loadCapture(page);
  await page.evaluate(() => {
    const log: ShapeResult[] = [];
    (globalThis as unknown as { __shaped: ShapeResult[] }).__shaped = log;
    addEventListener("click", e => log.push(__vibetakeCapture.shapeClick(e.composedPath())), true);
    addEventListener("change", e => log.push(__vibetakeCapture.shapeChange(e.composedPath())), true);
    addEventListener("submit", e => log.push(__vibetakeCapture.shapeSubmit((e as SubmitEvent).submitter)), true);
  });
};
const everything = (page: Page): Promise<ShapeResult[]> =>
  page.evaluate(() => (globalThis as unknown as { __shaped: ShapeResult[] }).__shaped);
const heard = async (page: Page): Promise<ShapeResult[]> => (await everything(page)).filter(r => r.kind !== "ignored");

const click = (label: string, role = "button", nth = 1): ShapeResult =>
  ({ kind: "step", step: { do: "click", target: { label, role, nth }, value: null } });
const type = (label: string, value: string, role = "textbox"): ShapeResult =>
  ({ kind: "step", step: { do: "type", target: { label, role, nth: 1 }, value } });

test("a click that lands inside a control is captured as the control", async ({ page }) => {
  await page.setContent(`<button><span id="icon">+</span> Add row</button>`);
  await listen(page);
  await page.locator("#icon").click();
  expect(await heard(page)).toEqual([click("+ Add row")]);
});

test("a click into a text field is not a step; the value committed afterwards is", async ({ page }) => {
  await page.setContent(`<input aria-label="Title"><button>Save</button>`);
  await listen(page);
  await page.getByRole("textbox", { name: "Title" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("The Lost Treasure");
  await page.getByRole("button", { name: "Save" }).click();
  expect(await heard(page)).toEqual([type("Title", "The Lost Treasure"), click("Save")]);
  // The click into the field was heard and deliberately ignored, not dropped.
  expect((await everything(page))[0]).toEqual({ kind: "ignored" });
});

test("an emptied field records an explicit empty value", async ({ page }) => {
  await page.setContent(`<input aria-label="Title" value="Old"><button>Save</button>`);
  await listen(page);
  await page.getByRole("textbox", { name: "Title" }).fill("");
  await page.getByRole("button", { name: "Save" }).click();
  expect(await heard(page)).toEqual([type("Title", ""), click("Save")]);
});

test("a checkbox toggled through its label is one click step and nothing else", async ({ page }) => {
  await page.setContent(`<label><input type="checkbox"> Agree</label>`);
  await listen(page);
  await page.getByText("Agree").click();
  expect(await heard(page)).toEqual([click("Agree", "checkbox")]);
});

test("a switch is a click step", async ({ page }) => {
  await page.setContent(`<button role="switch" aria-checked="false">Dark mode</button>`);
  await listen(page);
  await page.getByRole("switch", { name: "Dark mode" }).click();
  expect(await heard(page)).toEqual([click("Dark mode", "switch")]);
});

test("a password field is never captured, even with a textbox role", async ({ page }) => {
  await page.setContent(`<input id="secret" type="password" role="textbox" aria-label="Secret"><button>Save</button>`);
  await listen(page);
  await page.locator("#secret").click();
  await page.locator("#secret").fill("hunter2");
  await page.getByRole("button", { name: "Save" }).click();
  expect(await heard(page)).toEqual([{ kind: "dropped", reason: expect.stringContaining("Secret") }, click("Save")]);
  expect(JSON.stringify(await everything(page))).not.toContain("hunter2");
});

test("a password revealed by a show-password toggle is still never captured", async ({ page }) => {
  await page.setContent(`<input id="pw" type="password" autocomplete="current-password" aria-label="Password">`
    + `<button id="eye" type="button" onclick="document.getElementById('pw').type='text'">Show</button><button>Save</button>`);
  await listen(page);
  await page.locator("#pw").fill("hunter2");
  await page.locator("#eye").click();
  await page.getByRole("button", { name: "Save" }).click();
  const log = await heard(page);
  // Observed: the pointer-down on the eye blurs the field, so change fires before the click on Show.
  expect(log).toEqual([{ kind: "dropped", reason: expect.stringContaining("Password") }, click("Show"), click("Save")]);
  expect(log.filter(r => r.kind === "dropped")).toHaveLength(1);
  expect(log.filter(r => r.kind === "step" && r.step.do === "type")).toEqual([]);
  expect(JSON.stringify(await everything(page))).not.toContain("hunter2");
});

test("a file chosen in a file input is explained, never captured", async ({ page }) => {
  await page.setContent(`<input type="file" aria-label="Upload">`);
  await listen(page);
  await page.locator("input").setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  expect(await heard(page)).toEqual([{ kind: "dropped", reason: expect.stringContaining("Upload") }]);
});

test("a select records the chosen option's visible text", async ({ page }) => {
  await page.setContent(`<select aria-label="Stay category"><option>Name</option><option>Price</option></select>`);
  await listen(page);
  await page.getByRole("combobox", { name: "Stay category" }).selectOption({ label: "Price" });
  expect(await heard(page)).toEqual([
    { kind: "step", step: { do: "select", target: { label: "Stay category", role: "combobox", nth: 1 }, value: "Price" } },
  ]);
});

test("a multi-select is not captured, and says so", async ({ page }) => {
  await page.setContent(`<select multiple aria-label="Tags"><option>A</option><option>B</option></select>`);
  await listen(page);
  await page.getByRole("listbox", { name: "Tags" }).selectOption({ label: "B" });
  expect(await heard(page)).toEqual([{ kind: "dropped", reason: expect.stringContaining("Tags") }]);
});

test("a real click on an option inside a select is the select's change, not a click step", async ({ page }) => {
  await page.setContent(`<select size="3" aria-label="Pick one"><option>A</option><option>B</option></select>`);
  await listen(page);
  await page.getByRole("option", { name: "B" }).click();
  expect(await heard(page)).toEqual([
    { kind: "step", step: { do: "select", target: { label: "Pick one", role: "listbox", nth: 1 }, value: "B" } },
  ]);
});

test("a click on nothing nameable is dropped with a reason, not ignored", async ({ page }) => {
  await page.setContent(`<div id="blank" style="width:80px;height:24px;background:#ddd"></div><button id="icon"><svg width="10" height="10"></svg></button>`);
  await listen(page);
  await page.locator("#blank").click();
  await page.locator("#icon").click();
  expect(await heard(page)).toEqual([
    { kind: "dropped", reason: expect.stringContaining("no button, link or other control") },
    { kind: "dropped", reason: expect.stringContaining("no accessible name") },
  ]);
});

test("a click inside an open shadow root is captured", async ({ page }) => {
  await page.setContent(`<div id="host"></div><script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<button>Inside shadow</button>';</script>`);
  await listen(page);
  await page.getByRole("button", { name: "Inside shadow" }).click();
  expect(await heard(page)).toEqual([click("Inside shadow")]);
});

test("Enter in a form with a submit button is the browser's own click on that button", async ({ page }) => {
  await page.setContent(`<form onsubmit="event.preventDefault()"><input aria-label="Title"><button>Save</button></form>`);
  await listen(page);
  await page.getByRole("textbox", { name: "Title" }).fill("Again");
  await page.keyboard.press("Enter");
  expect(await heard(page)).toEqual([type("Title", "Again"), click("Save")]);
});

test("Enter in a form with no button is listed as not captured", async ({ page }) => {
  await page.setContent(`<form onsubmit="event.preventDefault()"><input type="search" aria-label="Find"></form>`);
  await listen(page);
  await page.getByRole("searchbox", { name: "Find" }).fill("rome");
  await page.keyboard.press("Enter");
  expect(await heard(page)).toEqual([
    type("Find", "rome", "searchbox"),
    { kind: "dropped", reason: expect.stringContaining("keyboard") },
  ]);
});

test("the first control that was not there before is the step's await", async ({ page }) => {
  const server = await serveFixture("base");
  try {
    await page.goto(server.url);
    await loadCapture(page);
    const before = await page.evaluate(() => __vibetakeCapture.controlKeys());
    expect(before).toContain("button\nNew Comic");
    expect(before).not.toContain("textbox\nTitle");            // hidden until the click
    expect(await page.evaluate(b => __vibetakeCapture.firstNewControl(b), before)).toBeNull();
    await page.getByRole("button", { name: "New Comic" }).click();
    await page.getByRole("textbox", { name: "Title" }).waitFor();
    expect(await page.evaluate(b => __vibetakeCapture.firstNewControl(b), before))
      .toEqual({ label: "Title", role: "textbox" });
  } finally { await server.close(); }
});

test("click geometry is the click point and the box of the control the step is shaped from", async ({ page }) => {
  await page.setContent(`<div style="height:40px"></div><button id="b" style="position:absolute;left:100px;top:60px;width:120px;height:30px"><span id="icon">+</span> Add row</button>`);
  await loadCapture(page);
  const geometry = await page.evaluate(() => new Promise(resolve => {
    addEventListener("click", e => resolve(__vibetakeCapture.clickGeometry(e.composedPath(), (e as MouseEvent).clientX, (e as MouseEvent).clientY)), { capture: true, once: true });
    document.getElementById("icon")!.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, clientX: 110, clientY: 70 }));
  }));
  expect(geometry).toEqual({ x: 110, y: 70, box: { x: 100, y: 60, width: 120, height: 30 }, scroll: { x: 0, y: 0 } });
});

test("click geometry is null where no step would be made, and carries the scroll offset", async ({ page }) => {
  await page.setContent(`<input id="t" aria-label="Title"><div style="height:3000px"></div><button id="far">Far</button>`);
  await loadCapture(page);
  expect(await page.evaluate(() => __vibetakeCapture.clickGeometry([document.getElementById("t")!, document.body], 5, 5))).toBeNull();
  await page.evaluate(() => window.scrollTo(0, 500));
  const geometry = await page.evaluate(() => __vibetakeCapture.clickGeometry([document.getElementById("far")!, document.body], 10, 10));
  expect(geometry?.scroll).toEqual({ x: 0, y: 500 });
  expect(geometry?.box.y).toBeLessThan(3000);   // a client box, not a page box
});

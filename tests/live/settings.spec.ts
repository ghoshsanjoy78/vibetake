import { startServer, type Service } from "../../src/serve/server.js";
import { test, expect } from "./extension-fixture.js";

const SECRET = "abcdefghijklmnopqrstuvwxyz012345";
let service: Service | null = null;
test.afterEach(async () => { await service?.close(); service = null; });

test("Connect pairs with the service by itself, keeps only its address, and reports the provider", async ({ popup, worker }) => {
  service = await startServer({ env: { OPENAI_API_KEY: "sk-live" }, secret: SECRET, port: 0, version: "1.0.0" });
  const options = await popup.context().newPage();
  await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  await expect(options.getByLabel("Service URL")).toHaveValue("http://127.0.0.1:7741");
  await options.getByLabel("Service URL").fill(service.url + "/");
  await options.getByRole("button", { name: "Connect" }).click();
  await expect(options.locator("#result")).toContainText("Connected: transcription via openai (whisper-1).");
  // The code was fetched from the service (so Chrome sent the extension's origin) and is not stored.
  expect(await popup.evaluate(() => chrome.storage.local.get("settings"))).toEqual({ settings: { service_url: service!.url } });
  expect(JSON.stringify(await popup.evaluate(() => chrome.storage.local.get(null)))).not.toContain(SECRET);

  const stopped = service;
  service = null;
  await stopped.close();
  await options.getByRole("button", { name: "Connect" }).click();
  await expect(options.locator("#result")).toContainText(`Could not reach ${stopped.url}: is npm run serve running?`);
});

test("a service URL that is not on this machine is refused, not saved, and nothing is sent", async ({ popup, worker }) => {
  const options = await popup.context().newPage();
  await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  await options.getByLabel("Service URL").fill("https://transcribe.example.com");
  await options.getByRole("button", { name: "Connect" }).click();
  await expect(options.locator("#result")).toContainText("The service URL must be on this machine: http://127.0.0.1:<port> or http://localhost:<port>. Nothing was saved.");
  expect(await popup.evaluate(() => chrome.storage.local.get("settings"))).toEqual({});
});

test("the popup links to the Settings page", async ({ popup }) => {
  const [opened] = await Promise.all([popup.context().waitForEvent("page"), popup.getByRole("link", { name: "Settings" }).click()]);
  expect(opened.url()).toMatch(/options\.html$/);
});

test("a service URL with credentials is refused, and a path-dotted one is stored as its origin", async ({ popup, worker }) => {
  service = await startServer({ env: { OPENAI_API_KEY: "sk-live" }, secret: SECRET, port: 0, version: "1.0.0" });
  const options = await popup.context().newPage();
  await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  await options.getByLabel("Service URL").fill("http://user:pw@127.0.0.1:7741");
  await options.getByRole("button", { name: "Connect" }).click();
  await expect(options.locator("#result")).toContainText("Nothing was saved.");
  expect(await popup.evaluate(() => chrome.storage.local.get("settings"))).toEqual({});
  await options.getByLabel("Service URL").fill(service.url + "/..");
  await options.getByRole("button", { name: "Connect" }).click();
  await expect(options.locator("#result")).toContainText("Connected:");
  expect(await popup.evaluate(() => chrome.storage.local.get("settings"))).toEqual({ settings: { service_url: service!.url } });
});

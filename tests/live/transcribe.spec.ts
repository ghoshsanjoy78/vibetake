import { strFromU8, unzipSync } from "fflate";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/commands.js";
import { serveFixture } from "../../src/fixture/serve.js";
import { startServer, type Service } from "../../src/serve/server.js";
import { parseTranscript } from "../../src/transcribe/transcript.js";
import { startFakeStt, whisperAnswer, type FakeStt } from "../fake-stt.js";
import { test, expect, exportZip, startRecording, status } from "./extension-fixture.js";

const SECRET = "abcdefghijklmnopqrstuvwxyz012345";
const answer = () => whisperAnswer("Click Start.", [{ word: "Click", start: 0.5, end: 0.8 }, { word: "Start", start: 0.9, end: 1.2 }]);
let fake: FakeStt | null = null; let service: Service | null = null; let root: string;
test.beforeEach(() => { root = mkdtempSync(join(tmpdir(), "vibetake-live-transcribe-")); });
test.afterEach(async () => { await service?.close(); service = null; await fake?.close(); fake = null; rmSync(root, { recursive: true, force: true }); });

const up = async (): Promise<Service> => {
  fake = await startFakeStt([{ status: 200, body: answer() }]);
  service = await startServer({ env: { OPENAI_API_KEY: "sk-live", VIBETAKE_STT_BASE_URL: fake.url }, secret: SECRET, port: 0, version: "1.0.0" });
  return service;
};
// Point the extension at a service; it pairs by itself (under the seam there is no default URL).
const pair = (popup: Parameters<typeof status>[0], url: string) =>
  popup.evaluate(u => chrome.storage.local.set({ settings: { service_url: u } }), url);
const on = (site: string) => async (fn: (url: string) => Promise<void>) => {
  const server = await serveFixture(site);
  try { await fn(server.url); } finally { await server.close(); }
};
// One step, then Stop.
const record = async (page: Parameters<typeof startRecording>[1], popup: Parameters<typeof status>[0], url: string): Promise<void> => {
  await page.goto(url);
  expect(await startRecording(popup, page, url)).toEqual({ ok: true });
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Start" }).click();
  await expect.poll(async () => (await status(popup)).recording?.steps).toBe(1);
  await popup.locator("#stop").click();
};

test("Stop transcribes through the service: the zip carries the transcript, on the recording's clock", async ({ page, popup }) => {
  const { url } = await up();
  await pair(popup, url);
  await on("capture")(async site => {
    await record(page, popup, site);
    await expect(popup.locator("#bundles")).toContainText("transcript: 2 words");
    const { bundle, entries, file } = await exportZip(popup);
    expect(bundle.transcript).toEqual({ status: "written", file: "transcript.json", markdown: "transcript.md", words: 2 });
    const transcript = parseTranscript(JSON.parse(strFromU8(entries["transcript.json"]!)));
    expect(transcript.words[0]).toEqual({ word: "Click", start_ms: 500 + bundle.voice!.offset_ms, end_ms: 800 + bundle.voice!.offset_ms });
    expect(transcript.words[1]!.word).toBe("Start.");
    expect(strFromU8(entries["transcript.md"]!)).toContain("Click Start.");
    expect(fake!.requests).toHaveLength(1);   // the service called the provider once, with the voice track only
    expect(fake!.requests[0]!.body).toContain('filename="voice.webm"');
    expect(fake!.requests[0]!.body).not.toContain("screen.webm");

  });
});

test("with the service down the zip is exported without a transcript, bundle.json says why, and vibetake transcribe fills it in", async ({ page, popup }) => {
  const { url } = await up();
  await service!.close(); service = null;   // the fake provider stays up for the import step
  await pair(popup, url);
  await on("capture")(async site => {
    await record(page, popup, site);
    // The failure is its own full-width line under the recording, not a word in the row.
    await expect(popup.locator("#bundles li .problem")).toHaveText(`no transcript: the VibeTake service at ${url} could not be reached (is npm run serve running?)`);
    const { bundle, entries, file } = await exportZip(popup);
    expect(bundle.transcript).toEqual({ status: `unavailable: the VibeTake service at ${url} could not be reached (is npm run serve running?)`, file: null, markdown: null, words: 0 });
    expect(entries["transcript.json"]).toBeUndefined();
    expect(entries["transcript.md"]).toBeUndefined();
    // The CLI, with the key in its environment, writes the transcript into the zip itself.
    const copy = join(root, "recording.zip");
    copyFileSync(file, copy);
    const out: string[] = [];
    const io = { configDir: join(root, "config"), env: { OPENAI_API_KEY: "sk-live", VIBETAKE_STT_BASE_URL: fake!.url }, deps: { sleep: async () => undefined }, out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
    expect(await runCommand(["transcribe", copy], io)).toBe(0);
    expect(out).toContain(`Wrote transcript.json and transcript.md into ${copy}.`);
    const after = unzipSync(new Uint8Array(readFileSync(copy)));
    expect(parseTranscript(JSON.parse(strFromU8(after["transcript.json"]!))).words).toHaveLength(2);
    expect((JSON.parse(strFromU8(after["bundle.json"]!)) as { transcript: { status: string } }).transcript.status).toBe("written");
    expect(after["screen.webm"]!.length).toBe(entries["screen.webm"]!.length);
    // Or: start the service, press Export again. The extension tries the transcript once more and
    // the new zip carries it; the earlier failure is gone from the row.
    await fake!.close();
    fake = await startFakeStt([{ status: 200, body: answer() }]);
    service = await startServer({ env: { OPENAI_API_KEY: "sk-live", VIBETAKE_STT_BASE_URL: fake.url }, secret: SECRET, port: Number(new URL(url).port), version: "1.0.0" });
    const again = await exportZip(popup);
    expect(again.bundle.transcript).toEqual({ status: "written", file: "transcript.json", markdown: "transcript.md", words: 2 });
    expect(parseTranscript(JSON.parse(strFromU8(again.entries["transcript.json"]!))).words).toHaveLength(2);
    await expect(popup.locator("#bundles")).toContainText("transcript: 2 words");
    await expect(popup.locator("#bundles li .problem")).toHaveCount(0);
    // With the service still down, Export tries, fails the same way, and ships the zip anyway.
    await service.close(); service = null;
    const third = await exportZip(popup);
    expect(third.bundle.transcript.status).toBe("written");   // a transcript already written is kept, not re-bought
  });
});

test("without Settings the zip says the extension is not set up", async ({ page, popup }) => {
  await on("capture")(async site => {
    await record(page, popup, site);
    await expect(popup.locator("#bundles")).toContainText("no transcript: not set up: the service URL is not set");
    const { bundle } = await exportZip(popup);
    expect(bundle.transcript.status).toBe("unavailable: not set up: the service URL is not set");
  });
});

test("a recording left at transcribing by a stopped worker is settled on the next status", async ({ page, popup }) => {
  await on("capture")(async site => {
    await record(page, popup, site);
    await exportZip(popup);
    // Pretend this worker instance died mid-transcription: the stored entry says transcribing, and
    // nothing in memory is working on it.
    await popup.evaluate(async () => {
      const { bundles } = await chrome.storage.local.get("bundles") as { bundles: { transcribing: boolean; zipped: boolean }[] };
      for (const b of bundles) { b.transcribing = true; b.zipped = false; }
      await chrome.storage.local.set({ bundles });
    });
    await expect(popup.locator("#bundles")).toContainText("no transcript: the extension was stopped while transcribing");
    const { bundle, entries } = await exportZip(popup);
    expect(bundle.transcript.status).toBe("unavailable: the extension was stopped while transcribing");
    expect(entries["screen.webm"]!.length).toBeGreaterThan(0);   // the zip was sealed again from the kept chunks
  });
});

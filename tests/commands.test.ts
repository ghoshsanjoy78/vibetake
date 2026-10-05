import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type Io } from "../src/commands.js";
import { parseBundle, type BundleV2 } from "../src/capture/bundle.js";
import { parseTranscript } from "../src/transcribe/transcript.js";
import { sampleZip, sampleZipWithTranscript } from "./bundle-fixture.js";
import { startFakeStt, whisperAnswer, type FakeStt } from "./fake-stt.js";

let root: string;
let io: Io & { lines: string[]; errors: string[] };
let fake: FakeStt | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vibetake-cli-"));
  const lines: string[] = [];
  const errors: string[] = [];
  io = { configDir: join(root, "config"), env: {}, deps: { sleep: async () => undefined }, out: l => lines.push(l), err: l => errors.push(l), lines, errors };
});
afterEach(async () => {
  await fake?.close(); fake = null;
  rmSync(root, { recursive: true, force: true });
});

const zipFile = (bytes: Uint8Array, name = "recording.zip"): string => { const f = join(root, name); writeFileSync(f, bytes); return f; };
const readZip = (file: string) => unzipSync(new Uint8Array(readFileSync(file)));
// Two words in the sample's first step window (at_ms 1200\u20134600, voice offset 418).
const words = whisperAnswer("Click New.", [{ word: "Click", start: 1.0, end: 1.3 }, { word: "New", start: 1.3, end: 1.5 }]);

it("wrong arguments print the usage and exit 2", async () => {
  expect(await runCommand(["nothing"], io)).toBe(2);
  expect(io.errors.join("\n")).toContain("npm run serve");
  expect(io.errors.join("\n")).toContain("vibetake transcribe <recording.zip> [--force]");
  expect(await runCommand(["transcribe"], io)).toBe(2);
});

it("transcribe writes transcript.json and transcript.md into the zip and updates bundle.json; a second run is refused without --force", async () => {
  fake = await startFakeStt([{ status: 200, body: words }, { status: 200, body: words }]);
  io.env = { OPENAI_API_KEY: "sk-test", VIBETAKE_STT_BASE_URL: fake.url };
  const file = zipFile(sampleZip());
  expect(await runCommand(["transcribe", file], io)).toBe(0);
  expect(io.lines[0]).toMatch(/^Transcribing 1:34 of narration with openai \(whisper-1\)/);
  expect(io.lines).toContain(`Wrote transcript.json and transcript.md into ${file}.`);
  const entries = readZip(file);
  const bundle = parseBundle(JSON.parse(strFromU8(entries["bundle.json"]!))) as BundleV2;
  expect(bundle.transcript).toEqual({ status: "written", file: "transcript.json", markdown: "transcript.md", words: 2 });
  const transcript = parseTranscript(JSON.parse(strFromU8(entries["transcript.json"]!)));
  expect(transcript.words[0]).toEqual({ word: "Click", start_ms: 1418, end_ms: 1718 });
  expect(strFromU8(entries["transcript.md"]!)).toContain("Click New.");
  expect(entries["screen.webm"]).toEqual(sampleZip && readZip(zipFile(sampleZip(), "again.zip"))["screen.webm"]);   // media untouched
  expect(fake.requests).toHaveLength(1);
  expect(fake.requests[0]!.body).toContain('filename="voice.webm"');
  expect(io.lines.join("\n") + io.errors.join("\n")).not.toContain("sk-test");

  expect(await runCommand(["transcribe", file], io)).toBe(1);
  expect(io.errors.at(-1)).toBe(`Not transcribed: ${file} already carries transcript.json; pass --force to replace it.`);
  expect(fake.requests).toHaveLength(1);
  expect(await runCommand(["transcribe", file, "--force"], io)).toBe(0);
  expect(fake.requests).toHaveLength(2);
});

it("transcribe without a key says how to add one and leaves the zip alone", async () => {
  const file = zipFile(sampleZip());
  const before = readFileSync(file);
  expect(await runCommand(["transcribe", file], io)).toBe(1);
  expect(io.errors.at(-1)).toBe(`Not transcribed: add OPENAI_API_KEY or OPENROUTER_API_KEY to .env.local, then run: vibetake transcribe ${file}`);
  expect(readFileSync(file).equals(before)).toBe(true);
});

it("transcribe refuses a zip without a voice track, and a zip that already carries a transcript", async () => {
  io.env = { OPENAI_API_KEY: "sk-test" };
  const noVoice = zipFile(sampleZip(entries => {
    const bundle = JSON.parse(strFromU8(entries["bundle.json"]!)) as Record<string, unknown>;
    bundle["voice"] = null; bundle["media"] = { screen: "recorded", voice: "unavailable: microphone refused", camera: "not requested" };
    entries["bundle.json"] = new TextEncoder().encode(JSON.stringify(bundle));
    delete entries["voice.webm"];
  }), "novoice.zip");
  expect(await runCommand(["transcribe", noVoice], io)).toBe(1);
  expect(io.errors.at(-1)).toBe("Not transcribed: the microphone was not recorded (unavailable: microphone refused).");
  const carried = zipFile(sampleZipWithTranscript(), "carried.zip");
  expect(await runCommand(["transcribe", carried], io)).toBe(1);
  expect(io.errors.at(-1)).toBe(`Not transcribed: ${carried} already carries transcript.json; pass --force to replace it.`);
});

it("a provider failure is reported in plain words and leaves the zip as it was", async () => {
  fake = await startFakeStt([{ status: 401, body: { error: { message: "Incorrect API key provided" } } }]);
  io.env = { OPENAI_API_KEY: "sk-test", VIBETAKE_STT_BASE_URL: fake.url };
  const file = zipFile(sampleZip());
  const before = readFileSync(file);
  expect(await runCommand(["transcribe", file], io)).toBe(1);
  expect(io.errors.at(-1)).toBe(`Not transcribed: openai answered 401 to the transcription request (Incorrect API key provided). Run: vibetake transcribe ${file}`);
  expect(readFileSync(file).equals(before)).toBe(true);
});

it("a zip whose manifest names a pointer file must contain it", async () => {
  io.env = { OPENAI_API_KEY: "sk-test" };
  const broken = zipFile(sampleZip(entries => {
    const bundle = JSON.parse(strFromU8(entries["bundle.json"]!)) as Record<string, unknown>;
    bundle["pointer"] = []; bundle["pointer_file"] = "pointer.json";
    entries["bundle.json"] = new TextEncoder().encode(JSON.stringify(bundle));
  }), "nopointer.zip");
  expect(await runCommand(["transcribe", broken], io)).toBe(1);
  expect(io.errors.at(-1)).toBe(`${broken} is missing pointer.json, which bundle.json names. The download may be incomplete.`);
});

it("a file that is not a recording is refused, naming it", async () => {
  io.env = { OPENAI_API_KEY: "sk-test" };
  const notZip = join(root, "x.zip"); writeFileSync(notZip, "hello");
  expect(await runCommand(["transcribe", notZip], io)).toBe(1);
  expect(io.errors.at(-1)).toBe(`${notZip} is not a zip VibeTake can read.`);
  const broken = zipFile(sampleZip(entries => { delete entries["voice.webm"]; }), "broken.zip");
  expect(await runCommand(["transcribe", broken], io)).toBe(1);
  expect(io.errors.at(-1)).toBe(`${broken} is missing voice.webm, which bundle.json names. The download may be incomplete.`);
});

it("serve listens on the loopback interface, keeps the pairing code off the screen, and stops when told", async () => {
  fake = await startFakeStt([]);
  io.env = { OPENAI_API_KEY: "sk-serve", VIBETAKE_STT_BASE_URL: fake.url, VIBETAKE_PORT: "0" };
  let release!: () => void;
  io.stop = () => new Promise<void>(r => { release = r; });
  const run = runCommand(["serve"], io);
  await vi.waitFor(() => expect(io.lines.join("\n")).toMatch(/^VibeTake is listening on http:\/\/127\.0\.0\.1:\d+ \(transcription via openai, whisper-1\)\.$/m));
  const url = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(io.lines.join("\n"))![1]!;
  // The code is never printed: the extension fetches it. It is on disk, 0600, for the test to read.
  expect(io.lines.join("\n")).not.toMatch(/[A-Za-z0-9_-]{32}/);
  const code = readFileSync(join(io.configDir, "pairing-secret"), "utf8").trim();
  expect(io.lines).toContain(`The extension pairs itself when you press Stop; the pairing secret was created in ${join(io.configDir, "pairing-secret")}.`);
  expect(await (await fetch(`${url}/pair`, { method: "POST", headers: { Origin: "chrome-extension://" + "b".repeat(32) } })).json()).toEqual({ code });
  expect(io.lines).toContain("Press Ctrl-C to stop.");
  expect(await (await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${code}` } })).json()).toEqual({ version: "1.0.0", provider: "openai", model: "whisper-1" });
  expect((await fetch(`${url}/health`)).status).toBe(401);
  expect(io.lines.join("\n") + io.errors.join("\n")).not.toContain("sk-serve");
  release();
  expect(await run).toBe(0);
  expect(io.lines.at(-1)).toBe("Stopped.");
});

it("serve without a key still serves, and says what to add", async () => {
  io.env = { VIBETAKE_PORT: "0" };
  io.stop = () => Promise.resolve();
  expect(await runCommand(["serve"], io)).toBe(0);
  expect(io.lines).toContain("No transcription key: add OPENAI_API_KEY or OPENROUTER_API_KEY to .env.local and start the service again. Until then the extension exports recordings without a transcript.");
  expect(io.lines.join("\n")).toMatch(/^VibeTake is listening on http:\/\/127\.0\.0\.1:\d+\.$/m);
});

it("serve refuses port 3000 and a port in use, in plain words", async () => {
  io.env = { VIBETAKE_PORT: "3000" };
  io.stop = () => Promise.resolve();
  expect(await runCommand(["serve"], io)).toBe(1);
  expect(io.errors).toContain("VIBETAKE_PORT is 3000, which is where your own app runs; pick another port.");
  const taken = await startFakeStt([]);
  const port = new URL(taken.url).port;
  io.env = { VIBETAKE_PORT: port };
  expect(await runCommand(["serve"], io)).toBe(1);
  expect(io.errors).toContain(`Port ${port} is in use. Set VIBETAKE_PORT to another port and try again.`);
  await taken.close();
});

it("the usage names serve", async () => {
  expect(await runCommand(["nothing"], io)).toBe(2);
  expect(io.errors.join("\n")).toContain("npm run serve");
});

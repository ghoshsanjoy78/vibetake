import { request } from "node:http";
import { it, expect, afterEach } from "vitest";
import { DEFAULT_PORT, portFrom, startServer, type Service } from "../src/serve/server.js";
import { parseTranscript } from "../src/transcribe/transcript.js";
import { FormatError } from "../src/errors.js";
import { sampleBundleV2 } from "./bundle-fixture.js";
import { startFakeStt, whisperAnswer, type FakeStt } from "./fake-stt.js";

const SECRET = "abcdefghijklmnopqrstuvwxyz012345";
let fake: FakeStt | null = null; let service: Service | null = null;
afterEach(async () => { await service?.close(); service = null; await fake?.close(); fake = null; });

const up = async (responses: Parameters<typeof startFakeStt>[0], env: NodeJS.ProcessEnv | null = null): Promise<string> => {
  fake = await startFakeStt(responses);
  service = await startServer({ env: env ?? { OPENAI_API_KEY: "sk-test-key", VIBETAKE_STT_BASE_URL: fake.url }, secret: SECRET, port: 0, version: "1.0.0", deps: { sleep: async () => undefined } });
  return service.url;
};
const auth = (code = SECRET) => ({ Authorization: `Bearer ${code}` });
const form = (voice: Uint8Array = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1]), bundle: unknown = sampleBundleV2()): FormData => {
  const f = new FormData();
  f.append("voice", new Blob([voice as BlobPart], { type: "audio/webm" }), "voice.webm");
  f.append("bundle", typeof bundle === "string" ? bundle : JSON.stringify(bundle));
  return f;
};
const answer = whisperAnswer("Click New.", [{ word: "Click", start: 1.0, end: 1.3 }, { word: "New", start: 1.3, end: 1.5 }]);

it("refuses a request without the pairing code, or with the wrong one, before any provider call", async () => {
  const url = await up([{ status: 200, body: answer }]);
  for (const headers of [{}, auth("nope"), auth(SECRET.toUpperCase())]) {
    const res = await fetch(`${url}/transcribe`, { method: "POST", headers, body: form() });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { message: expect.stringMatching(/^Not paired: /) } });
  }
  expect((await fetch(`${url}/health`)).status).toBe(401);
  expect(fake!.requests).toHaveLength(0);
});

it("answers an unusual request target with 401 without the code and 404 with it, never a 500", async () => {
  const url = await up([]);
  const raw = (headers: Record<string, string>): Promise<number> => new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port: Number(new URL(url).port), path: "//", headers }, res => { res.resume(); ok(res.statusCode ?? 0); });
    req.on("error", fail); req.end();
  });
  expect(await raw({})).toBe(401);
  expect(await raw(auth())).toBe(404);
});

it("health names the version, provider and model — or no provider when there is no key", async () => {
  const url = await up([]);
  expect(await (await fetch(`${url}/health`, { headers: auth() })).json()).toEqual({ version: "1.0.0", provider: "openai", model: "whisper-1" });
  await service!.close();
  service = await startServer({ env: {}, secret: SECRET, port: 0, version: "1.0.0" });
  expect(await (await fetch(`${service.url}/health`, { headers: auth() })).json()).toEqual({ version: "1.0.0", provider: null, model: null });
});

it("transcribes: words on the recording's clock, Markdown headed by the steps' notes, and the key nowhere in the answer", async () => {
  const url = await up([{ status: 200, body: answer }]);
  const res = await fetch(`${url}/transcribe`, { method: "POST", headers: auth(), body: form() });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain("sk-test-key");
  const body = JSON.parse(text) as { transcript: unknown; markdown: string };
  const transcript = parseTranscript(body.transcript);
  expect(transcript.words).toEqual([{ word: "Click", start_ms: 1418, end_ms: 1718 }, { word: "New.", start_ms: 1718, end_ms: 1918 }]);
  expect(transcript.steps[1]!.said).toBe("Click New.");
  expect(body.markdown).toContain("## 0:01 · Step 1 — Click New Comic\nClick New.");
  expect(fake!.requests).toHaveLength(1);
  expect(fake!.requests[0]!.headers["authorization"]).toBe("Bearer sk-test-key");
  expect(fake!.requests[0]!.body).toContain('filename="voice.webm"');
});

it("a provider refusal is a 502 with the provider's words; an unreachable provider too", async () => {
  const url = await up([{ status: 401, body: { error: { message: "Incorrect API key provided" } } }]);
  const res = await fetch(`${url}/transcribe`, { method: "POST", headers: auth(), body: form() });
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: { message: "openai answered 401 to the transcription request (Incorrect API key provided)." } });
  await fake!.close();   // now nothing listens at the provider's port
  const gone = await fetch(`${url}/transcribe`, { method: "POST", headers: auth(), body: form() });
  expect(gone.status).toBe(502);
  expect(((await gone.json()) as { error: { message: string } }).error.message).toMatch(/^Could not reach 127\.0\.0\.1:\d+/);
});

it("a voice track over 25 MB is 413 before any provider call", async () => {
  const url = await up([{ status: 200, body: answer }]);
  const res = await fetch(`${url}/transcribe`, { method: "POST", headers: auth(), body: form(new Uint8Array(26 * 1024 * 1024)) });
  expect(res.status).toBe(413);
  expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/25 MB/);
  expect(fake!.requests).toHaveLength(0);
});

it("no key is 503 with the hint; a bad VIBETAKE_STT_PROVIDER is 503 with its message", async () => {
  const url = await up([], {});
  const res = await fetch(`${url}/transcribe`, { method: "POST", headers: auth(), body: form() });
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: { message: "No transcription key: add OPENAI_API_KEY or OPENROUTER_API_KEY to .env.local and start the service again." } });
  await service!.close();
  service = await startServer({ env: { VIBETAKE_STT_PROVIDER: "whisperx" }, secret: SECRET, port: 0, version: "1.0.0" });
  const bad = await fetch(`${service.url}/transcribe`, { method: "POST", headers: auth(), body: form() });
  expect(bad.status).toBe(503);
  expect(((await bad.json()) as { error: { message: string } }).error.message).toContain('VIBETAKE_STT_PROVIDER is "whisperx"');
});

it("something that is not a recording is 400, in plain words", async () => {
  const url = await up([]);
  const noVoice = await fetch(`${url}/transcribe`, { method: "POST", headers: auth(), body: form(undefined, { ...sampleBundleV2(), voice: null }) });
  expect(noVoice.status).toBe(400);
  expect(await noVoice.json()).toEqual({ error: { message: "This recording has no voice track to transcribe." } });
  const f = new FormData(); f.append("bundle", "{}");
  const noFile = await fetch(`${url}/transcribe`, { method: "POST", headers: auth(), body: f });
  expect(noFile.status).toBe(400);
  const notJson = await fetch(`${url}/transcribe`, { method: "POST", headers: auth(), body: form(undefined, "{nope") });
  expect(notJson.status).toBe(400);
  const notMultipart = await fetch(`${url}/transcribe`, { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: "{}" });
  expect(notMultipart.status).toBe(400);
  const nothing = await fetch(`${url}/nothing`, { headers: auth() });
  expect(nothing.status).toBe(404);
  expect(fake!.requests).toHaveLength(0);
});

it("sends no CORS headers, so a web page's preflight fails", async () => {
  const url = await up([]);
  const res = await fetch(`${url}/transcribe`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Headers": "authorization" } });
  expect(res.status).toBe(401);
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
});

it("the port comes from VIBETAKE_PORT, defaults to 7741, and is never 3000", () => {
  expect(portFrom({})).toBe(DEFAULT_PORT);
  expect(DEFAULT_PORT).toBe(7741);
  expect(portFrom({ VIBETAKE_PORT: "0" })).toBe(0);
  expect(portFrom({ VIBETAKE_PORT: " 8080 " })).toBe(8080);
  expect(() => portFrom({ VIBETAKE_PORT: "3000" })).toThrow(FormatError);
  expect(() => portFrom({ VIBETAKE_PORT: "3000" })).toThrow(/3000.*your own app/);
  expect(() => portFrom({ VIBETAKE_PORT: "abc" })).toThrow(/VIBETAKE_PORT is "abc"/);
  expect(() => portFrom({ VIBETAKE_PORT: "70000" })).toThrow(FormatError);
});

it("POST /pair hands the code to an extension origin only, with no code required and no CORS header", async () => {
  const url = await up([]);
  const ext = await fetch(`${url}/pair`, { method: "POST", headers: { Origin: "chrome-extension://" + "a".repeat(32) } });
  expect(ext.status).toBe(200);
  expect(await ext.json()).toEqual({ code: SECRET });
  expect(ext.headers.get("access-control-allow-origin")).toBeNull();
  for (const headers of [{}, { Origin: "https://evil.example" }, { Origin: "chrome-extension://not-an-id" }, { Origin: "http://127.0.0.1:7741" }]) {
    const res = await fetch(`${url}/pair`, { method: "POST", headers });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { message: "Pairing is only for the VibeTake extension." } });
  }
  // Only POST /pair is open: a GET there (which carries no Origin from an extension), and every other route, still needs the code.
  expect((await fetch(`${url}/pair`, { headers: { Origin: "chrome-extension://" + "a".repeat(32) } })).status).toBe(401);
  expect(fake!.requests).toHaveLength(0);
});

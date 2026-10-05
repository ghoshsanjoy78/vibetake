import { it, expect, afterEach } from "vitest";
import { MAX_AUDIO_BYTES, TranscriptionError, transcribeAudio } from "../src/transcribe/provider.js";
import type { ProviderChoice } from "../src/transcribe/env.js";
import { startFakeStt, whisperAnswer, type FakeStt } from "./fake-stt.js";

let fake: FakeStt | null = null;
afterEach(async () => { await fake?.close(); fake = null; });

const choice = (provider: "openai" | "openrouter", url: string): ProviderChoice =>
  ({ provider, key: "sk-secret-123", baseUrl: url, model: provider === "openai" ? "whisper-1" : "openai/whisper-1" });
const audio = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
const noSleep = { sleep: async () => undefined };

it("posts the voice file as multipart with the fields both providers expect, and the key only in the header", async () => {
  fake = await startFakeStt([{ status: 200, body: whisperAnswer("hi there", [{ word: " hi", start: 0.1, end: 0.3 }, { word: " there", start: 0.3, end: 0.6 }]) }]);
  const result = await transcribeAudio(choice("openai", fake.url), audio, "voice.webm", noSleep);
  expect(result).toEqual({ text: "hi there", language: "english", words: [{ word: " hi", start: 0.1, end: 0.3 }, { word: " there", start: 0.3, end: 0.6 }] });
  const [req] = fake.requests;
  expect(req!.method).toBe("POST");
  expect(req!.path).toBe("/v1/audio/transcriptions");
  expect(req!.headers["authorization"]).toBe("Bearer sk-secret-123");
  expect(req!.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
  for (const field of ['name="file"; filename="voice.webm"', 'name="model"\r\n\r\nwhisper-1', 'name="response_format"\r\n\r\nverbose_json', 'name="timestamp_granularities[]"\r\n\r\nword'])
    expect(req!.body).toContain(field);
  expect(req!.path).not.toContain("sk-secret");
  expect(req!.headers["http-referer"]).toBeUndefined();
});

it("OpenRouter gets its attribution headers and its model id", async () => {
  fake = await startFakeStt([{ status: 200, body: whisperAnswer("", []) }]);
  await transcribeAudio(choice("openrouter", fake.url), audio, "voice.webm", noSleep);
  const [req] = fake.requests;
  expect(req!.headers["x-title"]).toBe("VibeTake");
  expect(req!.headers["http-referer"]).toBe("https://github.com/vibetake/vibetake");
  expect(req!.body).toContain('name="model"\r\n\r\nopenai/whisper-1');
});

it("retries once after a 429 or a 5xx, then succeeds", async () => {
  fake = await startFakeStt([{ status: 429, body: { error: { message: "slow down" } } }, { status: 200, body: whisperAnswer("ok", [{ word: "ok", start: 0, end: 0.2 }]) }]);
  const waits: number[] = [];
  const result = await transcribeAudio(choice("openai", fake.url), audio, "voice.webm", { sleep: async ms => { waits.push(ms); } });
  expect(result.text).toBe("ok");
  expect(fake.requests).toHaveLength(2);
  expect(waits).toEqual([2000]);
});

it("gives up after the one retry, surfacing the provider's message", async () => {
  fake = await startFakeStt([{ status: 503, body: { error: { message: "overloaded" } } }, { status: 503, body: { error: { message: "still overloaded" } } }]);
  const error = await transcribeAudio(choice("openai", fake.url), audio, "voice.webm", noSleep).then(() => { throw new Error("expected a TranscriptionError"); }, (e: unknown) => e as TranscriptionError);
  expect(error).toBeInstanceOf(TranscriptionError);
  expect(error.kind).toBe("rejected");
  expect(error.message).toMatch(/openai answered 503/);
  expect(error.detail).toBe("still overloaded");
  expect(fake.requests).toHaveLength(2);
});

it("does not retry a 401, and names the problem", async () => {
  fake = await startFakeStt([{ status: 401, body: { error: { message: "Incorrect API key provided" } } }]);
  const error = await transcribeAudio(choice("openrouter", fake.url), audio, "voice.webm", noSleep).then(() => { throw new Error("expected a TranscriptionError"); }, (e: unknown) => e as TranscriptionError);
  expect(error.kind).toBe("rejected");
  expect(error.message).toMatch(/openrouter answered 401/);
  expect(error.detail).toBe("Incorrect API key provided");
  expect(fake.requests).toHaveLength(1);
});

it("refuses a file over 25 MB before making any request", async () => {
  fake = await startFakeStt([]);
  const huge = new Uint8Array(MAX_AUDIO_BYTES + 1);
  const error = await transcribeAudio(choice("openai", fake.url), huge, "voice.webm", noSleep).then(() => { throw new Error("expected a TranscriptionError"); }, (e: unknown) => e as TranscriptionError);
  expect(error.kind).toBe("too-large");
  expect(error.message).toMatch(/25\.0 MB.*25 MB/);
  expect(fake.requests).toHaveLength(0);
});

it("refuses a response without word timestamps, or with text but no words", async () => {
  fake = await startFakeStt([
    { status: 200, body: { text: "hello", language: "english" } },
    { status: 200, body: whisperAnswer("hello world", []) },
  ]);
  const a = await transcribeAudio(choice("openai", fake.url), audio, "voice.webm", noSleep).then(() => { throw new Error("expected a TranscriptionError"); }, (e: unknown) => e as TranscriptionError);
  expect(a.kind).toBe("no-words");
  expect(a.message).toMatch(/whisper-1 did not return word timestamps/);
  const b = await transcribeAudio(choice("openai", fake.url), audio, "voice.webm", noSleep).then(() => { throw new Error("expected a TranscriptionError"); }, (e: unknown) => e as TranscriptionError);
  expect(b.kind).toBe("no-words");
});

it("silence is honest: empty text and no words is a result, not an error", async () => {
  fake = await startFakeStt([{ status: 200, body: whisperAnswer("", []) }]);
  expect(await transcribeAudio(choice("openai", fake.url), audio, "voice.webm", noSleep)).toEqual({ text: "", language: "english", words: [] });
});

it("an unreachable host is named, and a slow one times out", async () => {
  const closed = await startFakeStt([]);
  const url = closed.url;
  await closed.close();
  const unreachable = await transcribeAudio(choice("openai", url), audio, "voice.webm", noSleep).then(() => { throw new Error("expected a TranscriptionError"); }, (e: unknown) => e as TranscriptionError);
  expect(unreachable.kind).toBe("unreachable");
  expect(unreachable.message).toMatch(/Could not reach 127\.0\.0\.1:\d+ \(fetch failed: ECONNREFUSED\)/);
  const never = (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_ok, fail) => {
    init?.signal?.addEventListener("abort", () => fail(new DOMException("aborted", "AbortError")));
  });
  const slow = await transcribeAudio(choice("openai", "http://127.0.0.1:1/v1"), audio, "voice.webm", { fetch: never as typeof fetch, timeoutMs: 20, ...noSleep }).then(() => { throw new Error("expected a TranscriptionError"); }, (e: unknown) => e as TranscriptionError);
  expect(slow.kind).toBe("timeout");
  expect(slow.message).toMatch(/20 ms/);
});

it("a reply that is not JSON is a bad response, named as such", async () => {
  fake = await startFakeStt([{ status: 200, body: "not json at all" }]);
  const error = await transcribeAudio(choice("openai", fake.url), audio, "voice.webm", noSleep).then(() => { throw new Error("expected a TranscriptionError"); }, (e: unknown) => e as TranscriptionError);
  expect(error.kind).toBe("bad-response");
});

it("a key with a control character is refused before any request, without echoing it", async () => {
  fake = await startFakeStt([]);
  const bad = { ...choice("openai", fake.url), key: "sk-secret\r123" };
  const error = await transcribeAudio(bad, audio, "voice.webm", noSleep).then(() => { throw new Error("expected a TranscriptionError"); }, (e: unknown) => e as TranscriptionError);
  expect(error.kind).toBe("bad-key");
  expect(error.message).not.toContain("sk-secret");
  expect(fake.requests).toHaveLength(0);
});

it("a key with a space or a smart quote is refused too", async () => {
  fake = await startFakeStt([]);
  for (const key of ["sk-a b", "sk-\u201cquoted\u201d"]) {
    const error = await transcribeAudio({ ...choice("openai", fake.url), key }, audio, "voice.webm", noSleep).then(() => { throw new Error("expected a TranscriptionError"); }, (e: unknown) => e as TranscriptionError);
    expect(error.kind).toBe("bad-key");
  }
  expect(fake.requests).toHaveLength(0);
});

it("the key appears in no error the module produces, even when the provider echoes it", async () => {
  fake = await startFakeStt([{ status: 400, body: { error: { message: "bad header: Bearer sk-secret-123" } } }]);
  const error = await transcribeAudio(choice("openai", fake.url), audio, "voice.webm", noSleep).then(() => { throw new Error("expected a TranscriptionError"); }, (e: unknown) => e as TranscriptionError);
  expect(error.kind).toBe("rejected");
  expect(`${error.message} ${error.detail}`).not.toContain("sk-secret-123");
  expect(error.detail).toContain("[key]");
});

it("a words list with malformed entries is a bad response, not a trimmed transcript", async () => {
  fake = await startFakeStt([{ status: 200, body: { text: "hello", language: "english", words: [{ word: "hello", start: "0.1", end: "0.4" }] } }]);
  const error = await transcribeAudio(choice("openai", fake.url), audio, "voice.webm", noSleep).then(() => { throw new Error("expected a TranscriptionError"); }, (e: unknown) => e as TranscriptionError);
  expect(error.kind).toBe("bad-response");
  expect(error.message).toMatch(/1 word entry that is not/);
});

it("retries once when the connection drops before any response, then succeeds", async () => {
  fake = await startFakeStt([{ drop: true }, { status: 200, body: whisperAnswer("ok", [{ word: "ok", start: 0, end: 0.2 }]) }]);
  const waits: number[] = [];
  const result = await transcribeAudio(choice("openai", fake.url), audio, "voice.webm", { sleep: async ms => { waits.push(ms); } });
  expect(result.text).toBe("ok");
  expect(fake.requests).toHaveLength(2);
  expect(waits).toEqual([2000]);
});

it("a connection that drops twice is unreachable, and the key is not in the message", async () => {
  fake = await startFakeStt([{ drop: true }, { drop: true }]);
  const error = await transcribeAudio(choice("openai", fake.url), audio, "voice.webm", noSleep).catch(e => e as TranscriptionError);
  expect(error).toBeInstanceOf(TranscriptionError);
  expect((error as TranscriptionError).kind).toBe("unreachable");
  expect((error as TranscriptionError).message).toMatch(/^Could not reach 127\.0\.0\.1:\d+ \(/);
  expect((error as TranscriptionError).message).not.toContain("sk-secret");
  expect(fake.requests).toHaveLength(2);
});

it("a drop followed by a 5xx gets no third attempt", async () => {
  fake = await startFakeStt([{ drop: true }, { status: 503, body: { error: { message: "busy" } } }, { status: 200, body: whisperAnswer("never", []) }]);
  const error = await transcribeAudio(choice("openai", fake.url), audio, "voice.webm", noSleep).catch(e => e as TranscriptionError);
  expect((error as TranscriptionError).kind).toBe("rejected");
  expect((error as TranscriptionError).detail).toBe("busy");
  expect(fake.requests).toHaveLength(2);
});

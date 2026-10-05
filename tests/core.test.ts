import { it, expect, afterEach } from "vitest";
import { parseBundle, type BundleV2 } from "../src/capture/bundle.js";
import { transcribeBundle } from "../src/transcribe/core.js";
import { TranscriptionError } from "../src/transcribe/provider.js";
import type { ProviderChoice } from "../src/transcribe/env.js";
import { sampleBundleV2 } from "./bundle-fixture.js";
import { startFakeStt, whisperAnswer, type FakeStt } from "./fake-stt.js";

let fake: FakeStt | null = null;
afterEach(async () => { await fake?.close(); fake = null; });
const choice = (url: string): ProviderChoice => ({ provider: "openai", key: "sk-test", baseUrl: url, model: "whisper-1" });
const bundle = (): BundleV2 => parseBundle(sampleBundleV2()) as BundleV2;
const audio = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1]);
const noSleep = { sleep: async () => undefined };
// Bare words, as whisper-1 really returns them; the sentences are in `text`.
const answer = whisperAnswer("Click New Comic. Type the title.",
  [{ word: "Click", start: 1.0, end: 1.3 }, { word: "New", start: 1.3, end: 1.5 }, { word: "Comic", start: 1.5, end: 1.9 },
   { word: "Type", start: 4.5, end: 4.8 }, { word: "the", start: 4.8, end: 4.9 }, { word: "title", start: 4.9, end: 5.3 }]);

it("transcribes a bundle: words on the recording's clock with their punctuation, Markdown headed by the notes, a summary", async () => {
  fake = await startFakeStt([{ status: 200, body: answer }]);
  const { transcript, markdown, summary } = await transcribeBundle(bundle(), audio, ["Click New Comic", "Type the title", "Select"], choice(fake.url), noSleep);
  expect(transcript.words[0]).toEqual({ word: "Click", start_ms: 1418, end_ms: 1718 });
  expect(transcript.words[2]!.word).toBe("Comic.");
  expect(transcript.steps.map(s => s.said)).toEqual(["", "Click New Comic.", "Type the title.", ""]);
  expect(transcript).toMatchObject({ provider: "openai", model: "whisper-1", voice_offset_ms: 418, voice_end_ms: 418 + 94180, text: "Click New Comic. Type the title." });
  expect(markdown).toContain("## 0:01 · Step 1 — Click New Comic\nClick New Comic.");
  expect(summary).toEqual(["Transcribed 1:34 of narration (openai, whisper-1): 6 words across 3 steps."]);
  expect(fake.requests[0]!.body).toContain('filename="voice.webm"');
});

it("a provider refusal is the TranscriptionError, unchanged", async () => {
  fake = await startFakeStt([{ status: 401, body: { error: { message: "Incorrect API key provided" } } }]);
  const error = await transcribeBundle(bundle(), audio, [], choice(fake.url), noSleep).catch(e => e as TranscriptionError);
  expect(error).toBeInstanceOf(TranscriptionError);
  expect((error as TranscriptionError).detail).toBe("Incorrect API key provided");
});

it("a bundle without a voice track is a programming error, not a provider call", async () => {
  fake = await startFakeStt([]);
  await expect(transcribeBundle({ ...bundle(), voice: null }, audio, [], choice(fake.url), noSleep)).rejects.toThrow(/voice track/);
  expect(fake.requests).toHaveLength(0);
});

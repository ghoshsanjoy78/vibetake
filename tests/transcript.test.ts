import { it, expect } from "vitest";
import { parseTranscript, renderMarkdown, TRANSCRIPT_FORMAT } from "../src/transcribe/transcript.js";
import { FormatError } from "../src/errors.js";

export const sampleTranscript = () => ({
  transcript_format: 1,
  provider: "openrouter" as const,
  model: "openai/whisper-1",
  language: "en",
  transcribed_at: "2026-10-05T03:20:11.000Z",
  voice_offset_ms: 626,
  voice_end_ms: 160888,
  text: "So first click New Comic. Now the title.",
  words: [{ word: "So", start_ms: 1826, end_ms: 2026 }, { word: "title.", start_ms: 8326, end_ms: 8726 }],
  steps: [
    { n: 0, from_ms: 0, to_ms: 7625, said: "So first click New Comic." },
    { n: 1, from_ms: 7625, to_ms: 20185, said: "Now the title." },
    { n: 2, from_ms: 20185, to_ms: 160888, said: "" },
  ],
  clamped: 0,
});

it("reads a transcript back unchanged", () => {
  expect(parseTranscript(sampleTranscript())).toEqual(sampleTranscript());
  expect(TRANSCRIPT_FORMAT).toBe(1);
});

it("refuses an unknown transcript format in plain words, before the shape", () => {
  expect(() => parseTranscript({ transcript_format: 2, nothing: true })).toThrow(/transcript format 2.*reads transcript format 1/);
  expect(() => parseTranscript({ transcript_format: 2 })).toThrow(FormatError);
});

it("renders one block per step, headed by the step's time and note; the introduction and silence are honest", () => {
  const md = renderMarkdown(parseTranscript(sampleTranscript()), ["Click New Comic", "Type \"The Lost Treasure\" into Title"]);
  expect(md).toContain("## 0:00 · Before the first step\nSo first click New Comic.");
  expect(md).toContain("## 0:07 · Step 1 — Click New Comic\nNow the title.");
  expect(md).toContain("## 0:20 · Step 2 — Type \"The Lost Treasure\" into Title\n_(nothing said)_");
  expect(md.startsWith("# Narration — transcribed by openrouter (openai/whisper-1)")).toBe(true);
});

it("a transcript with the right version but the wrong shape is refused, naming the field", () => {
  const raw = { ...sampleTranscript(), words: [{ word: "x", start_ms: -1, end_ms: 5 }] };
  expect(() => parseTranscript(raw)).toThrow(/This transcript cannot be read\. words\.0\.start_ms: /);
  expect(() => parseTranscript(raw)).toThrow(FormatError);
});

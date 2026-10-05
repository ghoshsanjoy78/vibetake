import { it, expect } from "vitest";
import { alignWords, joinWords } from "../src/transcribe/align.js";

// Whisper tokens as they really arrive: leading spaces, punctuation attached.
const words = [
  { word: " So", start: 1.2, end: 1.4 }, { word: " first", start: 1.4, end: 1.8 }, { word: " click", start: 1.8, end: 2.1 },
  { word: " New", start: 2.1, end: 2.3 }, { word: " Comic.", start: 2.3, end: 2.7 },
  { word: " Now", start: 7.4, end: 7.6 }, { word: " the", start: 7.6, end: 7.7 }, { word: " title.", start: 7.7, end: 8.1 },
];
const OFFSET = 626;

it("shifts every word onto the recording's clock by the voice offset", () => {
  const { words: shifted } = alignWords(words, [7625, 20185], 30000, OFFSET);
  expect(shifted[0]).toEqual({ word: "So", start_ms: 1826, end_ms: 2026 });
  expect(shifted.at(-1)).toEqual({ word: "title.", start_ms: 8326, end_ms: 8726 });
});

it("slices words into one window per step by their midpoint; words before the first step are the introduction", () => {
  const { steps } = alignWords(words, [7625, 20185], 30000, OFFSET);
  expect(steps).toEqual([
    { n: 0, from_ms: 0, to_ms: 7625, said: "So first click New Comic." },
    { n: 1, from_ms: 7625, to_ms: 20185, said: "Now the title." },
    { n: 2, from_ms: 20185, to_ms: 30000, said: "" },
  ]);
});

it("a word whose midpoint lands exactly on a step's time belongs to that step", () => {
  // midpoint = (1.0 + 1.5) / 2 s = 1250 ms, plus offset 0 → exactly at_ms of step 1.
  const { steps } = alignWords([{ word: "edge", start: 1.0, end: 1.5 }], [1250], 5000, 0);
  expect(steps.map(s => s.said)).toEqual(["", "edge"]);
});

it("words past the end of the voice track are clamped and counted", () => {
  const { words: shifted, clamped } = alignWords([{ word: "late", start: 9.9, end: 10.4 }], [1000], 10000, 0);
  expect(shifted[0]).toEqual({ word: "late", start_ms: 9900, end_ms: 10000 });
  expect(clamped).toBe(1);
});

it("the last window ends where the voice track ends, and an empty word list yields empty sayings", () => {
  const { steps, clamped } = alignWords([], [1000, 2000], 2500, 100);
  expect(steps).toEqual([
    { n: 0, from_ms: 0, to_ms: 1000, said: "" }, { n: 1, from_ms: 1000, to_ms: 2000, said: "" }, { n: 2, from_ms: 2000, to_ms: 2500, said: "" },
  ]);
  expect(clamped).toBe(0);
});

it("joins tokens into a sentence: single spaces, no leading space, punctuation kept", () => {
  expect(joinWords([" Hello,", " world.", "  Again "])).toBe("Hello, world. Again");
  expect(joinWords([])).toBe("");
});

it("a word whose midpoint lands exactly at the end of the voice track belongs to the last window", () => {
  // start 9.8 s, end 10.2 s → clamped end 10000, start 9800, midpoint 9900 < 10000; use a word that ends ON the end:
  const { steps } = alignWords([{ word: "end", start: 9.8, end: 10.2 }, { word: "mid", start: 9.9, end: 10.1 }], [5000], 10000, 0);
  expect(steps.map(s => s.said)).toEqual(["", "end mid"]);
});

it("a word whose midpoint is exactly the track end is still taken by the last window", () => {
  // start = end = 10 s after clamping → midpoint exactly 10000.
  const { steps, clamped } = alignWords([{ word: "edge", start: 10.0, end: 10.3 }], [5000], 10000, 0);
  expect(steps[1]?.said).toBe("edge");
  expect(clamped).toBe(1);
});

it("the start of a word is never placed past the end of the track", () => {
  const { words } = alignWords([{ word: "late", start: 10.4, end: 10.9 }], [1000], 10000, 0);
  expect(words[0]).toEqual({ word: "late", start_ms: 10000, end_ms: 10000 });
});

it("when the voice track ends before the last step, the last window is empty at that step's time, and voice_end is left to the caller", () => {
  // The track ended at 3000 ms but a step was captured at 4000 ms (the microphone died early).
  const { steps } = alignWords([{ word: "early", start: 2.0, end: 2.4 }], [1000, 4000], 3000, 0);
  expect(steps).toEqual([
    { n: 0, from_ms: 0, to_ms: 1000, said: "" },
    { n: 1, from_ms: 1000, to_ms: 4000, said: "early" },
    { n: 2, from_ms: 4000, to_ms: 4000, said: "" },
  ]);
});

it("with no steps at all, everything is the introduction", () => {
  const { steps } = alignWords([{ word: "only", start: 0.5, end: 0.9 }], [], 2000, 0);
  expect(steps).toEqual([{ n: 0, from_ms: 0, to_ms: 2000, said: "only" }]);
});

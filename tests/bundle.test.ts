import { it, expect } from "vitest";
import { parseBundle, isV2 } from "../src/capture/bundle.js";
import { FormatError } from "../src/errors.js";
import { sampleBundle, sampleBundleV2 } from "./bundle-fixture.js";

it("reads a bundle back unchanged", () => {
  expect(parseBundle(sampleBundle())).toEqual(sampleBundle());
});

it("refuses an unknown bundle format in plain words, before looking at the shape", () => {
  expect(() => parseBundle({ bundle_format: 3, nothing_else: true }))
    .toThrow(/bundle format 3.*bundle formats 1 and 2/);
  expect(() => parseBundle({ bundle_format: 3 })).toThrow(FormatError);
});

it("refuses an action it does not know, naming the step", () => {
  const raw = sampleBundle() as { steps: { do: string }[] };
  raw.steps[1]!.do = "scroll";
  expect(() => parseBundle(raw)).toThrow(/step 2 \(do\).*"scroll"/);
});

it("refuses a step with no target, naming the step", () => {
  const raw = sampleBundle() as { steps: unknown[] };
  raw.steps[2] = { do: "click", value: null, await: null, at_ms: 1, url: "http://127.0.0.1:4321/" };
  expect(() => parseBundle(raw)).toThrow(/step 3/);
});

it("refuses something that is not a bundle at all, as a format error", () => {
  expect(() => parseBundle("not a bundle")).toThrow(FormatError);
  expect(() => parseBundle(null)).toThrow(/cannot be read/);
});

it("reads a format-2 bundle back unchanged, and knows it is one", () => {
  const read = parseBundle(sampleBundleV2());
  expect(read).toEqual(sampleBundleV2());
  expect(isV2(read)).toBe(true);
  expect(isV2(parseBundle(sampleBundle()))).toBe(false);
});

it("refuses a format that is neither 1 nor 2, naming what it reads", () => {
  expect(() => parseBundle({ bundle_format: 3 })).toThrow(/bundle format 3.*reads bundle formats 1 and 2/);
});

it("a format-2 frame must be either a file or a reason", () => {
  const raw = sampleBundleV2() as { frames: unknown[] };
  raw.frames[1] = { ...raw.frames[1]!, file: null, reason: null };
  expect(() => parseBundle(raw)).toThrow(/frame 2/);
});

it("a format-2 bundle with no media files is still a bundle", () => {
  const raw = { ...sampleBundleV2(), screen: null, voice: null,
    media: { screen: "unavailable: tab capture refused", voice: "unavailable: microphone refused", camera: "not requested" } };
  expect(parseBundle(raw)).toEqual(raw);
});

it("a format-2 bundle without a transcript note reads as not attempted", () => {
  const { transcript: _omitted, ...legacy } = sampleBundleV2();
  const bundle = parseBundle(legacy);
  expect("transcript" in legacy).toBe(false);
  expect(isV2(bundle) && bundle.transcript).toEqual({ status: "unavailable: not attempted", file: null, markdown: null, words: 0 });
});

it("a written transcript names its files; an unavailable one names none", () => {
  const written = { ...sampleBundleV2(), transcript: { status: "written", file: "transcript.json", markdown: "transcript.md", words: 247 } };
  expect(parseBundle(written)).toMatchObject({ transcript: written.transcript });
  const unavailable = { ...sampleBundleV2(), transcript: { status: "unavailable: not paired", file: null, markdown: null, words: 0 } };
  expect(parseBundle(unavailable)).toMatchObject({ transcript: unavailable.transcript });
  expect(() => parseBundle({ ...sampleBundleV2(), transcript: { status: "written", file: null, markdown: null, words: 3 } }))
    .toThrow(/transcript.*A written transcript names its files/);
  expect(() => parseBundle({ ...sampleBundleV2(), transcript: { status: "unavailable: x", file: "transcript.json", markdown: null, words: 0 } }))
    .toThrow(/transcript.*A written transcript names its files/);
  expect(() => parseBundle({ ...sampleBundleV2(), transcript: { status: "pending", file: null, markdown: null, words: 0 } }))
    .toThrow(/transcript\.status.*written.*unavailable/);
});

it("a format-2 bundle without a camera reads as null and not requested", () => {
  const { camera: _c, ...rest } = sampleBundleV2();
  const legacy = { ...rest, media: { screen: "recorded", voice: "recorded" } };
  const bundle = parseBundle(legacy);
  expect(isV2(bundle) && bundle.camera).toBeNull();
  expect(isV2(bundle) && bundle.media.camera).toBe("not requested");
});

it("a recorded camera is a track with its size", () => {
  const raw = { ...sampleBundleV2(), camera: { file: "camera.webm", offset_ms: 418, duration_ms: 94180, width: 1280, height: 720 }, media: { screen: "recorded", voice: "recorded", camera: "recorded" } };
  const bundle = parseBundle(raw);
  expect(isV2(bundle) && bundle.camera).toEqual(raw.camera);
  expect(isV2(bundle) && bundle.media.camera).toBe("recorded");
  expect(parseBundle(JSON.parse(JSON.stringify(bundle)))).toEqual(bundle);
});

it("a dropped click may say where it landed, a frame may be for a drop, and the pointer may live in its own file", () => {
  const raw = { ...sampleBundleV2(), pointer: [], pointer_file: "pointer.json",
    dropped: [{ at_ms: 7100, reason: "nothing under it", x: 412, y: 88 }, { at_ms: 8000, reason: "a nameless field" }],
    frames: [...sampleBundleV2().frames, { step: null, moment: "dropped" as const, at_ms: 7100, file: "frames/00007100-dropped.jpg", reason: null }] };
  const bundle = parseBundle(raw);
  expect(isV2(bundle) && bundle.pointer_file).toBe("pointer.json");
  expect(isV2(bundle) && bundle.dropped).toEqual([{ at_ms: 7100, reason: "nothing under it", x: 412, y: 88 }, { at_ms: 8000, reason: "a nameless field", x: null, y: null }]);
  expect(isV2(bundle) && bundle.frames.at(-1)!.moment).toBe("dropped");
  // A bundle from before: inline samples, no file.
  const { pointer_file: _p, ...older } = sampleBundleV2();
  expect(parseBundle(older)).toMatchObject({ pointer: sampleBundleV2().pointer, pointer_file: null });
});

import { it, expect } from "vitest";
import {
  addAwait, addDropped, addNavigation, addStep, begin, pause, resume, seal, setNaming, thinPointer, BUNDLE_FORMAT,
  addFrame, addPointer, addViewportBeat, frameFile, mediaEnded, mediaStarted, mediaStopped, mediaUnavailable, setViewport, settle,
  withTranscript, NOT_ATTEMPTED,
  type Recording,
} from "../extension/src/recorder.js";
import { parseBundle, BUNDLE_FORMATS } from "../src/capture/bundle.js";
import { sampleBundleV2 } from "./bundle-fixture.js";

const t0 = new Date("2026-10-04T09:14:00.000Z");
const at = (ms: number): Date => new Date(t0.getTime() + ms);
const URL0 = "http://127.0.0.1:4321/";
const click = { do: "click" as const, target: { label: "New Comic", role: "button", nth: 1 }, value: null };
const title = { label: "Title", role: "textbox" };
const fresh = (): Recording => begin(7, URL0, "Fixture", t0);

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const inner of Object.values(value as object)) deepFreeze(inner);
  }
  return value;
};

it("begins empty, with an id that is safe in a file name", () => {
  const r = fresh();
  expect(r).toMatchObject({ tab_id: 7, start_url: URL0, title: "Fixture", started_at: t0.toISOString(),
    steps: [], beats: [], dropped: [], pending_before: null, paused: null, naming: null });
  expect(r.id).toBe("2026-10-04T09-14-00-000Z");
});

it("a step is stamped with its offset, has no await yet, and opens a window for one", () => {
  const r = addStep(fresh(), click, ["button\nHome"], URL0, at(1200));
  expect(r.steps).toEqual([{ ...click, await: null, at_ms: 1200, url: URL0, click: null, settled_at_ms: null }]);
  expect(r.pending_before).toEqual(["button\nHome"]);
});

it("an await attaches to the newest step, once, and closes the window", () => {
  let r = addStep(fresh(), click, [], URL0, at(1000));
  r = addAwait(r, title);
  expect(r.steps[0]?.await).toEqual(title);
  expect(r.pending_before).toBeNull();
  // The window is closed: a second await has nothing to attach to.
  expect(addAwait(r, { label: "Other", role: "button" })).toEqual(r);
});

it("an await attaches to the newest step, never an earlier one", () => {
  let r = addStep(fresh(), click, [], URL0, at(1000));
  r = addStep(r, click, [], URL0, at(2000));
  r = addAwait(r, title);
  expect(r.steps.map(s => s.await)).toEqual([null, title]);
});

it("an await with no step to belong to is ignored", () => {
  expect(addAwait(fresh(), title)).toEqual(fresh());
});

it("not-captured actions and navigations are kept with their offsets, outside the steps", () => {
  let r = addDropped(fresh(), "A click on something with no button under it was not captured.", at(500));
  r = addNavigation(r, "http://127.0.0.1:4321/two.html", at(900));
  expect(r.steps).toEqual([]);
  expect(r.dropped).toEqual([{ at_ms: 500, reason: "A click on something with no button under it was not captured.", x: null, y: null }]);
  const clicked = addDropped(fresh(), "nothing under it", at(700), { x: 412, y: 88 });
  expect(clicked.dropped[0]).toEqual({ at_ms: 700, reason: "nothing under it", x: 412, y: 88 });
  expect(r.beats).toEqual([{ kind: "navigation", at_ms: 900, url: "http://127.0.0.1:4321/two.html" }]);
});

it("pausing records why, and resuming clears it", () => {
  const paused = pause(fresh(), "This page cannot be recorded.");
  expect(paused.paused).toBe("This page cannot be recorded.");
  expect(resume(paused).paused).toBeNull();
});

it("sealing produces a bundle the importer reads back unchanged", () => {
  let r = setNaming(fresh(), "playwright-core@0.0.0-test");
  r = addStep(r, click, [], URL0, at(1200));
  r = addAwait(r, title);
  const bundle = seal(r, at(5000), null);
  expect(bundle).toMatchObject({ bundle_format: BUNDLE_FORMAT, id: r.id, naming: "playwright-core@0.0.0-test",
    started_at: t0.toISOString(), sealed_at: at(5000).toISOString(), start_url: URL0, title: "Fixture",
    complete: true, incomplete_reason: null });
  expect(bundle.steps[0]?.await).toEqual(title);
  expect((BUNDLE_FORMATS as readonly number[]).includes(BUNDLE_FORMAT)).toBe(true);
  // Through JSON, as it travels: the importer's schema accepts every field and strips none.
  expect(parseBundle(JSON.parse(JSON.stringify(bundle)))).toEqual(bundle);
});

it("an incomplete seal keeps the reason", () => {
  const bundle = seal(fresh(), at(100), "The recorded tab was closed before Stop was pressed.");
  expect(bundle.complete).toBe(false);
  expect(bundle.incomplete_reason).toBe("The recorded tab was closed before Stop was pressed.");
});

it("every change returns a new value and leaves its input alone", () => {
  const r = deepFreeze(addStep(fresh(), click, ["x"], URL0, at(1)));
  // Each of these would throw on a frozen object if it mutated in place.
  addStep(r, click, [], URL0, at(2));
  addAwait(r, title);
  addDropped(r, "why", at(3));
  addNavigation(r, URL0, at(4));
  pause(r, "why");
  seal(r, at(5), null);
  expect(r.steps).toHaveLength(1);
  expect(r.steps[0]?.await).toBeNull();
});

const geometry = { x: 412, y: 88, box: { x: 380, y: 72, width: 96, height: 32 }, scroll: { x: 0, y: 0 } };

it("begins with no media, no frames, no pointer, and says so", () => {
  const r = fresh();
  expect(r).toMatchObject({ viewport: null, window_resized: false, screen: null, voice: null, camera: null,
    media: { screen: "unavailable: not started", voice: "unavailable: not started", camera: "not requested" }, pointer: [], frames: [] });
});

it("a step carries where the click landed and has not settled yet", () => {
  const r = addStep(fresh(), click, [], URL0, at(1200), geometry);
  expect(r.steps[0]).toMatchObject({ click: geometry, settled_at_ms: null });
  const typed = addStep(r, { do: "type", target: { label: "Title", role: "textbox", nth: 1 }, value: "x" }, [], URL0, at(2000), null);
  expect(typed.steps[1]?.click).toBeNull();
});

it("settling stamps the newest step once; an await settles it too", () => {
  let r = addStep(fresh(), click, [], URL0, at(1000));
  r = settle(r, at(1460));
  r = settle(r, at(1900));
  expect(r.steps[0]?.settled_at_ms).toBe(1460);
  let s = addStep(fresh(), click, [], URL0, at(1000));
  s = addAwait(s, title);
  expect(s.steps[0]?.settled_at_ms).toBeNull();   // an await marks what appeared; the clock comes from settle
  expect(settle(fresh(), at(5))).toEqual(fresh());  // nothing to settle
});

it("media tracks record when they began, how they ended, and their size", () => {
  let r = mediaStarted(fresh(), "screen", 412, { width: 3200, height: 1800 });
  r = mediaStarted(r, "voice", 418, null);
  expect(r.screen).toEqual({ file: "screen.webm", offset_ms: 412, duration_ms: null, width: 3200, height: 1800 });
  expect(r.voice).toEqual({ file: "voice.webm", offset_ms: 418, duration_ms: null, width: null, height: null });
  expect(r.media).toEqual({ screen: "recorded", voice: "recorded", camera: "not requested" });
  r = mediaStopped(r, "screen", 94210);
  expect(r.screen?.duration_ms).toBe(94210);
  r = mediaEnded(r, "voice", 30000, "the microphone was disconnected");
  expect(r.media.voice).toBe("ended at 30000: the microphone was disconnected");
  expect(mediaUnavailable(fresh(), "voice", "microphone refused").media.voice).toBe("unavailable: microphone refused");
});

it("a viewport is set once and every later size is a beat", () => {
  const vp = { width: 1600, height: 900, device_pixel_ratio: 2 };
  let r = setViewport(fresh(), vp, true, t0);
  expect(r.viewport).toEqual(vp);
  expect(r.window_resized).toBe(true);
  r = addViewportBeat(r, { ...vp, width: 1200 }, at(5000));
  expect(r.beats).toEqual([{ kind: "viewport", at_ms: 5000, width: 1200, height: 900, device_pixel_ratio: 2 }]);
});

it("pointer samples append in order; frames are named by their timestamp", () => {
  let r = addPointer(fresh(), [{ t: 10, x: 1, y: 2 }]);
  r = addPointer(r, [{ t: 60, x: 3, y: 4 }]);
  expect(r.pointer).toEqual([{ t: 10, x: 1, y: 2 }, { t: 60, x: 3, y: 4 }]);
  expect(frameFile(0, null, "start")).toBe("frames/00000000-start.jpg");
  expect(frameFile(1460, 1, "settled")).toBe("frames/00001460-step01-settled.jpg");
  expect(frameFile(94210, 12, "action")).toBe("frames/00094210-step12-action.jpg");
  expect(frameFile(94210, null, "stop")).toBe("frames/00094210-stop.jpg");
  r = addFrame(r, { step: 1, moment: "action", at_ms: 1200, file: frameFile(1200, 1, "action"), reason: null });
  expect(r.frames[0]?.file).toBe("frames/00001200-step01-action.jpg");
});

it("sealing a format-2 recording produces a bundle the importer reads back unchanged", () => {
  let r = setViewport(setNaming(fresh(), "playwright-core@0.0.0-test"), { width: 1600, height: 900, device_pixel_ratio: 2 }, true, t0);
  r = mediaStarted(r, "screen", 412, { width: 3200, height: 1800 });
  r = mediaUnavailable(r, "voice", "microphone refused");
  r = addStep(r, click, [], URL0, at(1200), geometry);
  r = addFrame(r, { step: 1, moment: "action", at_ms: 1200, file: frameFile(1200, 1, "action"), reason: null });
  r = settle(r, at(1460));
  r = addPointer(r, [{ t: 1180, x: 402, y: 91 }]);
  r = mediaStopped(r, "screen", 5000);
  const bundle = seal(r, at(5000), null);
  expect(bundle.bundle_format).toBe(2);
  expect("video" in bundle).toBe(false);
  // Through JSON, as it travels: the importer's schema accepts every field and strips none.
  expect(parseBundle(JSON.parse(JSON.stringify(bundle)))).toEqual(bundle);
});

it("a sealed bundle says no transcript was attempted, and withTranscript replaces that", () => {
  const bundle = seal(fresh(), at(100), null);
  expect(bundle.transcript).toEqual(NOT_ATTEMPTED);
  const note = { status: "written", file: "transcript.json", markdown: "transcript.md", words: 12 };
  const written = withTranscript(bundle, note);
  expect(written.transcript).toEqual(note);
  expect(bundle.transcript).toEqual(NOT_ATTEMPTED);   // pure
  expect(parseBundle(JSON.parse(JSON.stringify(written)))).toMatchObject({ transcript: note });
});

it("a new recording has no camera and says it was not requested; the importer reads the sealed bundle", () => {
  const r = fresh();
  expect(r.camera).toBeNull();
  expect(r.media.camera).toBe("not requested");
  const bundle = seal(r, at(100), null);
  expect(bundle.camera).toBeNull();
  expect(parseBundle(JSON.parse(JSON.stringify(bundle)))).toMatchObject({ camera: null, media: { camera: "not requested" } });
});

it("a recorded camera is a track with its size, named camera.webm, and stops with its duration", () => {
  let r = mediaStarted(fresh(), "camera", 420, { width: 1280, height: 720 });
  expect(r.camera).toEqual({ file: "camera.webm", offset_ms: 420, duration_ms: null, width: 1280, height: 720 });
  expect(r.media.camera).toBe("recorded");
  r = mediaStopped(r, "camera", 5000);
  expect(r.camera?.duration_ms).toBe(5000);
  const refused = mediaUnavailable(fresh(), "camera", "NotFoundError: Requested device not found");
  expect(refused.camera).toBeNull();
  expect(refused.media.camera).toBe("unavailable: NotFoundError: Requested device not found");
  const ended = mediaEnded(r, "camera", 3000, "the stream ended");
  expect(ended.media.camera).toBe("ended at 3000: the stream ended");
  expect(parseBundle(JSON.parse(JSON.stringify(seal(ended, at(6000), null))))).toMatchObject({ camera: { file: "camera.webm", width: 1280 }, media: { camera: "ended at 3000: the stream ended" } });
});

it("the sealed bundle names the pointer file and carries a thinned trail; the importer reads it", () => {
  const line = Array.from({ length: 41 }, (_, i) => ({ t: i * 50, x: 100 + i * 5, y: 200 + i * 3 }));   // a straight move, 2 s
  const r = addPointer(fresh(), line);
  const bundle = seal(r, at(3000), null);
  expect(bundle.pointer_file).toBe("pointer.json");
  expect(bundle.pointer.length).toBeLessThan(line.length / 3);
  expect(bundle.pointer[0]).toEqual(line[0]);
  expect(bundle.pointer.at(-1)).toEqual(line.at(-1));
  expect(parseBundle(JSON.parse(JSON.stringify({ ...bundle, pointer: [] })))).toMatchObject({ pointer: [], pointer_file: "pointer.json" });
});

it("thinning keeps a pointer's pauses and corners, and leaves a short trail alone", () => {
  expect(thinPointer([])).toEqual([]);
  expect(thinPointer([{ t: 0, x: 1, y: 1 }, { t: 50, x: 2, y: 2 }])).toEqual([{ t: 0, x: 1, y: 1 }, { t: 50, x: 2, y: 2 }]);
  // A move right, a pause, then a move down: the pause point and the corner survive.
  const trail = [
    ...Array.from({ length: 10 }, (_, i) => ({ t: i * 50, x: i * 4, y: 0 })),          // right, 36 px
    { t: 1000, x: 36, y: 0 },                                                             // paused 550 ms
    ...Array.from({ length: 10 }, (_, i) => ({ t: 1050 + i * 50, x: 36, y: (i + 1) * 4 })),   // down
  ];
  const kept = thinPointer(trail);
  expect(kept[0]).toEqual(trail[0]);
  expect(kept.at(-1)).toEqual(trail.at(-1));
  expect(kept).toContainEqual({ t: 1000, x: 36, y: 0 });   // the pause (and the corner)
  expect(kept.length).toBeLessThan(trail.length);
  for (let i = 1; i < kept.length; i++) expect(kept[i]!.t).toBeGreaterThan(kept[i - 1]!.t);
});

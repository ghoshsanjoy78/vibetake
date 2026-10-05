// The recording as a value, and the ways it changes. Pure: no chrome.*, no clocks, no DOM, so the
// whole state machine is unit-tested in vitest while the service worker only loads, applies, saves.
import type { AwaitTarget, ClickGeometry, PointerSample, Shaped, Viewport } from "./types.js";

// The bundle format this extension writes. src/capture/bundle.ts reads it (and still reads 1); an
// unknown version is refused there. Independent of the scenario format.
export const BUNDLE_FORMAT = 2;

export type CapturedStep = Shaped & {
  await: AwaitTarget | null; at_ms: number; url: string;
  click: ClickGeometry | null; settled_at_ms: number | null;
};
export type Beat =
  | { kind: "navigation"; at_ms: number; url: string }
  | { kind: "viewport"; at_ms: number; width: number; height: number; device_pixel_ratio: number };
// Where a dropped click landed, in client pixels; null when the drop was not a click (a value typed
// into a nameless field, a form submitted from the keyboard).
export type Dropped = { at_ms: number; reason: string; x: number | null; y: number | null };
export type TrackName = "screen" | "voice" | "camera";
export type MediaTrack = {
  file: string; offset_ms: number; duration_ms: number | null; width: number | null; height: number | null;
};
export type FrameMoment = "start" | "stop" | "action" | "settled" | "dropped";
export type Frame = { step: number | null; moment: FrameMoment; at_ms: number; file: string | null; reason: string | null };

// What was done about the narration at Stop; the same shape src/capture/bundle.ts reads.
export type TranscriptNote = { status: string; file: string | null; markdown: string | null; words: number };
export const NOT_ATTEMPTED: TranscriptNote = { status: "unavailable: not attempted", file: null, markdown: null, words: 0 };

export type Recording = {
  id: string;
  tab_id: number;
  started_at: string;
  start_url: string;
  title: string;
  // Which Playwright named the steps, as the content script reports it.
  naming: string | null;
  steps: CapturedStep[];
  beats: Beat[];
  dropped: Dropped[];
  // The controls present when the newest step was captured, until that step's await is known or the
  // next step arrives. The content script needs it again after a navigation.
  pending_before: string[] | null;
  paused: string | null;
  viewport: Viewport | null;
  window_resized: boolean;
  screen: MediaTrack | null;
  voice: MediaTrack | null;
  camera: MediaTrack | null;
  // "recorded" | "unavailable: <reason>" | "ended at <offset_ms>: <reason>"
  media: { screen: string; voice: string; camera: string };
  pointer: PointerSample[];
  frames: Frame[];
};

export type Bundle = {
  bundle_format: number;
  id: string;
  naming: string | null;
  started_at: string;
  sealed_at: string;
  start_url: string;
  title: string;
  complete: boolean;
  incomplete_reason: string | null;
  viewport: Viewport | null;
  window_resized: boolean;
  screen: MediaTrack | null;
  voice: MediaTrack | null;
  camera: MediaTrack | null;
  media: { screen: string; voice: string; camera: string };
  steps: CapturedStep[];
  // The thinned trail. In the zip it travels as its own file (`pointer_file`), and bundle.json's
  // `pointer` is empty, so an AI reading the steps is not made to read the trail too.
  pointer: PointerSample[];
  pointer_file: string | null;
  frames: Frame[];
  transcript: TranscriptNote;
  beats: Beat[];
  dropped: Dropped[];
};

export const elapsedMs = (r: Recording, now: Date): number => Math.max(0, now.getTime() - Date.parse(r.started_at));

export const begin = (tabId: number, url: string, title: string, now: Date): Recording => ({
  // The same shape as a take id: sortable, and safe in a file name.
  id: now.toISOString().replace(/[:.]/g, "-"),
  tab_id: tabId, started_at: now.toISOString(), start_url: url, title,
  naming: null, steps: [], beats: [], dropped: [], pending_before: null, paused: null,
  viewport: null, window_resized: false, screen: null, voice: null, camera: null,
  media: { screen: "unavailable: not started", voice: "unavailable: not started", camera: "not requested" },
  pointer: [], frames: [],
});

export const setNaming = (r: Recording, naming: string): Recording => ({ ...r, naming });

export const addStep = (
  r: Recording, step: Shaped, before: string[], url: string, now: Date, click: ClickGeometry | null = null,
): Recording => ({
  ...r,
  steps: [...r.steps, { ...step, await: null, at_ms: elapsedMs(r, now), url, click, settled_at_ms: null }],
  pending_before: before,
});

const withNewest = (r: Recording, change: (step: CapturedStep) => CapturedStep): Recording => {
  const last = r.steps[r.steps.length - 1];
  return last ? { ...r, steps: [...r.steps.slice(0, -1), change(last)] } : r;
};

// Attaches to the newest step, once, while its window is open. An await that arrives with no window
// open belongs to nothing and is dropped: better no await than one on the wrong step.
export const addAwait = (r: Recording, target: AwaitTarget): Recording => {
  if (r.steps.length === 0 || r.pending_before === null) return r;
  return { ...withNewest(r, step => ({ ...step, await: target })), pending_before: null };
};

// The newest step's page has come to rest: the moment the viewer would see before the next action.
// Stamped once; a second settle (an await after a quiet period, or the reverse) changes nothing.
export const settle = (r: Recording, now: Date): Recording =>
  withNewest(r, step => step.settled_at_ms === null ? { ...step, settled_at_ms: elapsedMs(r, now) } : step);

export const addDropped = (r: Recording, reason: string, now: Date, point: { x: number; y: number } | null = null): Recording =>
  ({ ...r, dropped: [...r.dropped, { at_ms: elapsedMs(r, now), reason, x: point?.x ?? null, y: point?.y ?? null }] });

export const addNavigation = (r: Recording, url: string, now: Date): Recording =>
  ({ ...r, beats: [...r.beats, { kind: "navigation", at_ms: elapsedMs(r, now), url }] });

export const setViewport = (r: Recording, viewport: Viewport, resized: boolean, _now: Date): Recording =>
  ({ ...r, viewport, window_resized: resized });

export const addViewportBeat = (r: Recording, viewport: Viewport, now: Date): Recording =>
  ({ ...r, beats: [...r.beats, { kind: "viewport", at_ms: elapsedMs(r, now), ...viewport }] });

export const pause = (r: Recording, reason: string): Recording => ({ ...r, paused: reason });
export const resume = (r: Recording): Recording => ({ ...r, paused: null });

// --- media ---------------------------------------------------------------------------------------

const FILE: Record<TrackName, string> = { screen: "screen.webm", voice: "voice.webm", camera: "camera.webm" };

export const mediaStarted = (
  r: Recording, track: TrackName, offset_ms: number, size: { width: number; height: number } | null,
): Recording => ({
  ...r,
  [track]: { file: FILE[track], offset_ms, duration_ms: null, width: size?.width ?? null, height: size?.height ?? null },
  media: { ...r.media, [track]: "recorded" },
});

export const mediaUnavailable = (r: Recording, track: TrackName, reason: string): Recording =>
  ({ ...r, [track]: null, media: { ...r.media, [track]: `unavailable: ${reason}` } });

// The recorder stopped producing chunks before Stop. What was written stays; the status says where it ends.
export const mediaEnded = (r: Recording, track: TrackName, at_ms: number, reason: string): Recording =>
  ({ ...r, media: { ...r.media, [track]: `ended at ${at_ms}: ${reason}` } });

export const mediaStopped = (r: Recording, track: TrackName, duration_ms: number): Recording => {
  const current = r[track];
  return current ? { ...r, [track]: { ...current, duration_ms } } : r;
};

export const addPointer = (r: Recording, samples: PointerSample[]): Recording =>
  ({ ...r, pointer: [...r.pointer, ...samples] });

// The trail a video needs, not every sample: a point is kept when the pointer has moved far enough
// from the last kept point, paused long enough, or changed direction; the first and last always.
// A straight move keeps a few points; a wander keeps its corners. Pure, and order-preserving.
const THIN_DISTANCE_PX = 24;
const THIN_GAP_MS = 250;
const THIN_TURN_DEGREES = 20;
export const thinPointer = (samples: PointerSample[]): PointerSample[] => {
  if (samples.length <= 2) return [...samples];
  const kept: PointerSample[] = [samples[0]!];
  for (let i = 1; i < samples.length - 1; i++) {
    const last = kept[kept.length - 1]!, cur = samples[i]!, next = samples[i + 1]!;
    const dx = cur.x - last.x, dy = cur.y - last.y;
    const far = Math.hypot(dx, dy) >= THIN_DISTANCE_PX;
    const paused = cur.t - last.t >= THIN_GAP_MS;
    const a1 = Math.atan2(dy, dx), a2 = Math.atan2(next.y - cur.y, next.x - cur.x);
    let turn = Math.abs(a2 - a1) * 180 / Math.PI;
    if (turn > 180) turn = 360 - turn;
    const turned = (dx !== 0 || dy !== 0) && turn >= THIN_TURN_DEGREES;
    if (far || paused || turned) kept.push(cur);
  }
  kept.push(samples[samples.length - 1]!);
  return kept;
};

// The file name is the timestamp: sorts chronologically, reads without a lookup.
export const frameFile = (at_ms: number, step: number | null, moment: FrameMoment): string => {
  const stamp = String(Math.max(0, Math.round(at_ms))).padStart(8, "0");
  const what = step === null ? moment : `step${String(step).padStart(2, "0")}-${moment}`;
  return `frames/${stamp}-${what}.jpg`;
};

export const addFrame = (r: Recording, frame: Frame): Recording => ({ ...r, frames: [...r.frames, frame] });

export const seal = (r: Recording, now: Date, incompleteReason: string | null): Bundle => ({
  bundle_format: BUNDLE_FORMAT, id: r.id, naming: r.naming, started_at: r.started_at,
  sealed_at: now.toISOString(), start_url: r.start_url, title: r.title,
  complete: incompleteReason === null, incomplete_reason: incompleteReason,
  viewport: r.viewport, window_resized: r.window_resized, screen: r.screen, voice: r.voice, camera: r.camera, media: r.media,
  steps: r.steps, pointer: thinPointer(r.pointer), pointer_file: "pointer.json", frames: r.frames, transcript: NOT_ATTEMPTED, beats: r.beats, dropped: r.dropped,
});

export const withTranscript = (b: Bundle, note: TranscriptNote): Bundle => ({ ...b, transcript: note });

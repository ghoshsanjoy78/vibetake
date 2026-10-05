// Everything that crosses a boundary inside the extension: page → worker, popup → worker, and the
// answers. The content script is a classic script and reads these through globals.d.ts; the worker
// and popup import them.
import type { Bundle, Dropped, TrackName, TranscriptNote } from "./recorder.js";
import type { ServiceAccess } from "./settings.js";
import type { AwaitTarget, ClickGeometry, Shaped, Viewport } from "./types.js";

export type PageMessage =
  | { type: "hello"; naming: string; viewport: Viewport }
  | { type: "step"; step: Shaped; before: string[]; url: string; click: ClickGeometry | null; at: number }
  | { type: "await"; target: AwaitTarget }
  // `at` is epoch ms; `point` is where a dropped click landed, or null for a drop that was not a click.
  | { type: "dropped"; reason: string; at: number; point: { x: number; y: number } | null }
  // `at` is epoch ms; the worker puts it on the recording's clock.
  | { type: "pointer"; samples: { at: number; x: number; y: number }[] }
  | { type: "settled"; at: number }
  | { type: "viewport"; viewport: Viewport };

export type PopupMessage =
  | { type: "status" }
  | { type: "start"; tabId: number }
  | { type: "stop" }
  | { type: "bundle"; id: string }
  | { type: "exported"; id: string }
  | { type: "retranscribe"; id: string }
  | { type: "delete"; id: string }
  | { type: "mic-granted" }
  | { type: "camera-granted" };

export type Request = PageMessage | PopupMessage;

export type Reply = { ok: true } | { ok: false; reason: string };

// To the content script. `recording: false` is the instruction to stop listening. `before` is the
// open await window of the newest step, which a freshly injected script must keep watching.
export type PageReply = { recording: boolean; before?: string[] | null };

export type Status = {
  recording: {
    id: string; title: string; started_at: string; steps: number; dropped: Dropped[]; paused: string | null;
    media: { screen: string; voice: string; camera: string; frames: number };
  } | null;
  bundles: {
    id: string; steps: number; complete: boolean; incomplete_reason: string | null; exported: boolean; zipped: boolean;
    transcribing: boolean; transcript: TranscriptNote;
  }[];
  fault: string | null;
};

export type { Bundle };

// TEST SEAM. Read once at Record from chrome.storage.local "test_media". Absent in production: the
// screen comes from chrome.tabCapture and the microphone is asked for. Tests set "display" (a
// getDisplayMedia stream under Chromium's auto-select flag), "fail" (refuse) and "deny".
export type TestMedia = { screen: "tab" | "display" | "fail"; mic: "allow" | "deny" | "off"; camera?: "allow" | "deny" }; // mic "off" and camera absent: not requested, as when the switch is off.

export type TrackStart =
  | { ok: true; offset_ms: number; width: number | null; height: number | null }
  | { ok: false; reason: string };
export type MediaStartReply = { screen: TrackStart; voice: TrackStart; camera: TrackStart };
export type MediaStopReply = { screen: number | null; voice: number | null; camera: number | null };   // durations, ms
export type TrackLive = { bytes: number; ms_since_chunk: number; ended: boolean };
export type MediaStatus = { screen: TrackLive | null; voice: TrackLive | null; camera: TrackLive | null; frames: number };
export type MediaTranscribeReply =
  | { ok: true; words: number; files: { "transcript.json": string; "transcript.md": string } }
  | { ok: false; reason: string };

// Worker → offscreen (and popup → offscreen for media-status). The offscreen document answers only
// these; the worker ignores them except media-ended, which the offscreen document sends.
export type MediaMessage =
  | { type: "media-start"; id: string; started_at: string; source: { screen: TestMedia["screen"]; streamId: string | null }; mic: TestMedia["mic"]; camera: "allow" | "deny" | "off"; seam: boolean } // "off": not requested; "deny" exists only for the seam.
  // data: the still as a JPEG data URL, captured by the worker (only it can call captureVisibleTab).
  | { type: "media-frame"; id: string; file: string; data: string }
  | { type: "media-stop"; id: string }
  // files: text files sealed beside the media, deflated — the transcript
  | { type: "media-seal"; id: string; bundle: Bundle; files: Record<string, string> }
  | { type: "media-status"; id: string }
  | { type: "media-discard"; id: string }
  | { type: "media-transcribe"; id: string; bundle: Bundle; service: ServiceAccess }
  | { type: "media-test-end"; track: TrackName }
  | { type: "media-ended"; id: string; track: TrackName; at_ms: number; reason: string };

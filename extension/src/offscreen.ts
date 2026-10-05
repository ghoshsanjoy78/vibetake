// The recorder. The only MV3 context that can run MediaRecorder: acquires the streams, records both
// tracks in one-second chunks straight into IndexedDB, grabs frames, and at seal time streams
// everything into a zip. It decides nothing about what a recording means — the worker tells it what
// to do, and it answers.
import { chunksOf, discardMedia, framesOf, openMedia, putChunk, putFrame, putZip } from "./media-store.js";
import type { MediaMessage, MediaStartReply, MediaStatus, MediaStopReply, MediaTranscribeReply, TrackStart } from "./messages.js";
import type { Bundle, TrackName } from "./recorder.js";

const CHUNK_MS = 1000;
const MIME: Record<TrackName, string> = {
  screen: "video/webm;codecs=vp9", voice: "audio/webm;codecs=opus", camera: "video/webm;codecs=vp9,opus",
};

type Live = {
  recorder: MediaRecorder; stream: MediaStream; startedAt: number; seq: number;
  bytes: number; lastChunkAt: number; ended: boolean; endedAt: number | null;
};
type Session = {
  id: string; startedAt: number; tracks: Partial<Record<TrackName, Live>>;
  frames: number; seam: boolean;
};

let session: Session | null = null;
const db = openMedia();
const reason = (error: unknown): string => error instanceof Error ? `${error.name}: ${error.message}` : String(error);

// --- acquiring the streams: the seam ------------------------------------------------------------
// Production consumes a chrome.tabCapture stream id; tests ask getDisplayMedia under Chromium's
// --auto-select-tab-capture-source-by-title flag. Everything below this function is shared.
const acquireScreen = (source: { screen: "tab" | "display" | "fail"; streamId: string | null }): Promise<MediaStream> => {
  if (source.screen === "fail") return Promise.reject(new Error("tab capture refused (test seam)"));
  if (source.screen === "display") return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: source.streamId } },
  } as MediaStreamConstraints);
};
const acquireMic = (mic: "allow" | "deny" | "off"): Promise<MediaStream> =>
  mic === "deny" ? Promise.reject(new Error("microphone refused (test seam)")) : navigator.mediaDevices.getUserMedia({ audio: true });
// The camera with its own microphone: one stream, so the face and the voice share a clock and the
// transcript is the camera's audio.
// The seam honours both refusals: in production a refused microphone makes this combined request
// reject the same way a refused camera does.
const acquireCamera = (camera: "allow" | "deny", mic: "allow" | "deny" | "off"): Promise<MediaStream> => {
  if (camera === "deny") return Promise.reject(new Error("camera refused (test seam)"));
  if (mic === "deny") return Promise.reject(new Error("microphone refused (test seam)"));
  // The camera's own microphone carries the voice, unless the voice switch is off.
  return navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 }, audio: mic !== "off" });
};

// --- recording ------------------------------------------------------------------------------------
const startTrack = async (s: Session, track: TrackName, stream: MediaStream): Promise<TrackStart> => {
  const recorder = new MediaRecorder(stream, { mimeType: MIME[track] });
  const live: Live = { recorder, stream, startedAt: 0, seq: 0, bytes: 0, lastChunkAt: 0, ended: false, endedAt: null };
  s.tracks[track] = live;
  recorder.ondataavailable = e => {
    if (e.data.size === 0) return;
    live.bytes += e.data.size;
    live.lastChunkAt = Date.now();
    void db.then(d => putChunk(d, { id: s.id, track, seq: live.seq++, blob: e.data })).catch(error => died(s, track, `could not save a chunk: ${reason(error)}`));
  };
  recorder.onerror = (e: Event) => died(s, track, reason((e as ErrorEvent).error ?? "recorder error"));
  // The camera listens on its video only: its audio track is the voice's too, and the voice recorder
  // already catches the microphone's death; the camera keeps recording the face.
  const watched = track === "camera" ? stream.getVideoTracks() : stream.getTracks();
  for (const t of watched) t.addEventListener("ended", () => died(s, track, "the stream ended"));
  const started = new Promise<number>(ok => { recorder.onstart = () => ok(Date.now()); });
  recorder.start(CHUNK_MS);
  live.startedAt = await started;
  const settings = track === "voice" ? undefined : stream.getVideoTracks()[0]?.getSettings();
  return { ok: true, offset_ms: Math.max(0, live.startedAt - s.startedAt), width: settings?.width ?? null, height: settings?.height ?? null };
};

// A recorder stopped producing before Stop. Mark it, tell the worker, leave the others alone.
// Stops the recorder, and never an audio track: with the camera on, the voice recorder shares the
// camera stream's audio track and must keep going when the camera dies. A dead camera's video tracks
// are stopped so the camera light goes off before Stop.
const died = (s: Session, track: TrackName, why: string): void => {
  const live = s.tracks[track];
  if (!live || live.ended) return;
  live.ended = true;
  live.endedAt = Date.now();
  if (live.recorder.state !== "inactive") { try { live.recorder.stop(); } catch { /* already gone */ } }
  if (track === "camera") for (const t of live.stream.getVideoTracks()) t.stop();
  void chrome.runtime.sendMessage({ type: "media-ended", id: s.id, track, at_ms: Math.max(0, Date.now() - s.startedAt), reason: why } satisfies MediaMessage)
    .catch(() => undefined);
};

const stopTrack = (live: Live | undefined): Promise<number | null> => {
  if (!live) return Promise.resolve(null);
  const finished = new Promise<void>(ok => {
    if (live.recorder.state === "inactive") { ok(); return; }
    live.recorder.addEventListener("stop", () => ok(), { once: true });
    live.recorder.stop();
  });
  return finished.then(() => {
    for (const t of live.stream.getTracks()) t.stop();
    // A track that died ran until it died, not until Stop.
    return Math.max(0, (live.endedAt ?? Date.now()) - live.startedAt);
  });
};

const start = async (m: Extract<MediaMessage, { type: "media-start" }>): Promise<MediaStartReply> => {
  if (session) await stopAll(session);
  const s: Session = { id: m.id, startedAt: Date.parse(m.started_at), tracks: {}, frames: 0, seam: m.seam };
  session = s;
  // A throw while starting a track is a refusal like any other: the stream is released, nothing stays.
  const begin = async (track: TrackName, acquire: Promise<MediaStream>): Promise<TrackStart> => {
    let stream: MediaStream;
    try { stream = await acquire; } catch (error) { return { ok: false, reason: reason(error) }; }
    try { return await startTrack(s, track, stream); }
    catch (error) { for (const t of stream.getTracks()) t.stop(); delete s.tracks[track]; return { ok: false, reason: reason(error) }; }
  };
  const screen = await begin("screen", acquireScreen(m.source));
  // Without the screen there is no recording: do not touch the microphone.
  if (!screen.ok) {
    session = null;
    return { screen, voice: { ok: false, reason: "not started: the screen could not be captured" }, camera: { ok: false, reason: m.camera === "off" ? "not requested" : "not started: the screen could not be captured" } };
  }
  // A switched-off voice is not asked for: the reply says so, and no microphone is opened.
  const voiceOff: TrackStart = { ok: false, reason: "not requested" };
  const beginMic = (): Promise<TrackStart> => m.mic === "off" ? Promise.resolve(voiceOff) : begin("voice", acquireMic(m.mic));
  if (m.camera === "off") {
    const voice = await beginMic();
    return { screen, voice, camera: { ok: false, reason: "not requested" } };
  }
  // Camera on: its stream carries the microphone. camera.webm records the whole stream; voice.webm
  // records only its audio track, so transcription sees the same file it always has. If the camera
  // cannot be opened, the microphone is opened alone, as with the camera off.
  let cameraStream: MediaStream;
  try { cameraStream = await acquireCamera(m.camera, m.mic); }
  catch (error) {
    const voice = await beginMic();
    return { screen, voice, camera: { ok: false, reason: reason(error) } };
  }
  const camera = await begin("camera", Promise.resolve(cameraStream));
  if (!camera.ok) {
    // begin released the camera stream, audio track included: open the microphone alone.
    const voice = await beginMic();
    return { screen, voice, camera };
  }
  const voice = m.mic === "off" ? voiceOff : await begin("voice", Promise.resolve(new MediaStream(cameraStream.getAudioTracks())));
  return { screen, voice, camera };
};

const stopAll = async (s: Session): Promise<MediaStopReply> => {
  const [screen, voice, camera] = await Promise.all([stopTrack(s.tracks.screen), stopTrack(s.tracks.voice), stopTrack(s.tracks.camera)]);
  if (session === s) session = null;
  return { screen, voice, camera };
};

// A still the worker captured (chrome.tabs.captureVisibleTab renders the page without the pointer),
// stored beside the media. The recorder decodes and keeps it; it draws nothing itself.
const storeFrame = async (s: Session, file: string, data: string): Promise<{ ok: true } | { ok: false; reason: string }> => {
  let blob: Blob;
  try { blob = await (await fetch(data)).blob(); }
  catch (error) { return { ok: false, reason: `the frame could not be decoded (${reason(error)})` }; }
  await putFrame(await db, { id: s.id, file, blob });
  s.frames += 1;
  return { ok: true };
};

// --- transcribing -------------------------------------------------
// The voice track and the bundle go to the local service, which holds the key; the two transcript
// files come back as text for the zip. Every failure is a reason, never a thrown error: the zip is
// sealed either way.
const TRANSCRIBE_TIMEOUT_MS = 330_000;   // the service waits five minutes on its provider; a little more here

const transcribe = async (m: Extract<MediaMessage, { type: "media-transcribe" }>): Promise<MediaTranscribeReply> => {
  const chunks = await chunksOf(await db, m.id, "voice");
  if (chunks.length === 0) return { ok: false, reason: "the voice track has no data" };
  const form = new FormData();
  form.append("voice", new Blob(chunks, { type: "audio/webm" }), "voice.webm");
  form.append("bundle", JSON.stringify(m.bundle));
  let response: Response;
  try {
    response = await fetch(`${m.service.service_url}/transcribe`, {
      method: "POST", headers: { Authorization: `Bearer ${m.service.pairing_code}` }, body: form, signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
      redirect: "error",   // the voice track goes to the Settings URL and nowhere else
    });
  } catch (error) {
    return { ok: false, reason: (error as { name?: string })?.name === "TimeoutError"
      ? `the VibeTake service at ${m.service.service_url} did not answer within ${TRANSCRIBE_TIMEOUT_MS / 1000} seconds`
      : `the VibeTake service at ${m.service.service_url} could not be reached (is npm run serve running?)` };
  }
  const body = (await response.json().catch(() => null)) as { error?: { message?: unknown }; transcript?: { words?: unknown }; markdown?: unknown } | null;
  if (!response.ok) {
    const message = typeof body?.error?.message === "string" ? body.error.message : `the service answered ${response.status}`;
    return { ok: false, reason: response.status === 401 ? `not paired (${message.replace(/^Not paired: /, "").replace(/\.$/, "")})` : message.replace(/\.$/, "") };
  }
  if (!body || !Array.isArray(body.transcript?.words) || typeof body.markdown !== "string")
    return { ok: false, reason: "the service answered with something that is not a transcript" };
  return { ok: true, words: body.transcript.words.length, files: { "transcript.json": JSON.stringify(body.transcript, null, 2) + "\n", "transcript.md": body.markdown } };
};

// --- sealing ----------------------------------------------------------------------------------------
// Streams chunks, frames and bundle.json into one zip without concatenating the media first: each
// chunk is pushed through as it is read. Media is stored, not deflated — WebM and JPEG do not shrink.
const buildZip = async (id: string, bundle: Bundle, files: Record<string, string>): Promise<Blob> => {
  const d = await db;
  const parts: Blob[] = [];
  let failure: Error | null = null;
  const zip = new fflate.Zip((error, data) => { if (error) failure = error; else parts.push(new Blob([data])); });
  const add = async (name: string, blobs: Blob[], compress: boolean): Promise<void> => {
    const file = compress ? new fflate.ZipDeflate(name, { level: 6 }) : new fflate.ZipPassThrough(name);
    zip.add(file);
    for (const blob of blobs) file.push(new Uint8Array(await blob.arrayBuffer()));
    file.push(new Uint8Array(0), true);
  };
  await add("bundle.json", [new Blob([JSON.stringify(bundle, null, 2) + "\n"])], true);
  for (const [name, text] of Object.entries(files)) await add(name, [new Blob([text])], true);
  if (bundle.screen) await add(bundle.screen.file, await chunksOf(d, id, "screen"), false);
  if (bundle.voice) await add(bundle.voice.file, await chunksOf(d, id, "voice"), false);
  if (bundle.camera) await add(bundle.camera.file, await chunksOf(d, id, "camera"), false);
  for (const frame of await framesOf(d, id)) await add(frame.file, [frame.blob], false);
  zip.end();
  if (failure) throw failure;
  return new Blob(parts, { type: "application/zip" });
};

const status = async (id: string): Promise<MediaStatus> => {
  const s = session?.id === id ? session : null;
  const live = (track: TrackName) => {
    const t = s?.tracks[track];
    return t ? { bytes: t.bytes, ms_since_chunk: Date.now() - (t.lastChunkAt || t.startedAt), ended: t.ended } : null;
  };
  return { screen: live("screen"), voice: live("voice"), camera: live("camera"), frames: s?.frames ?? (await framesOf(await db, id)).length };
};

const handle = async (m: MediaMessage): Promise<unknown> => {
  switch (m.type) {
    case "media-start": return start(m);
    case "media-stop": return session?.id === m.id ? stopAll(session) : { screen: null, voice: null, camera: null } satisfies MediaStopReply;
    case "media-seal": {
      const blob = await buildZip(m.id, m.bundle, m.files);
      await putZip(await db, { id: m.id, blob });
      return { bytes: blob.size };
    }
    case "media-status": return status(m.id);
    case "media-transcribe": return transcribe(m);
    case "media-discard": await discardMedia(await db, m.id); return { ok: true };
    case "media-frame": return session?.id === m.id ? storeFrame(session, m.file, m.data) : { ok: false, reason: "no recording in progress" };
    case "media-test-end": {
      // TEST SEAM: honoured only in a seamed session, so production cannot be told to kill a track.
      if (!session?.seam) return { ok: false };
      died(session, m.track, "ended by the test seam");
      return { ok: true };
    }
    case "media-ended": return undefined;
  }
};

chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, reply) => {
  if (typeof message?.type !== "string" || !message.type.startsWith("media-") || message.type === "media-ended") return false;
  handle(message as MediaMessage).then(reply, error => reply({ media_error: reason(error) }));
  return true;
});

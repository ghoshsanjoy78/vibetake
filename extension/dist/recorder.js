// The bundle format this extension writes. src/capture/bundle.ts reads it (and still reads 1); an
// unknown version is refused there. Independent of the scenario format.
export const BUNDLE_FORMAT = 2;
export const NOT_ATTEMPTED = { status: "unavailable: not attempted", file: null, markdown: null, words: 0 };
export const elapsedMs = (r, now) => Math.max(0, now.getTime() - Date.parse(r.started_at));
export const begin = (tabId, url, title, now) => ({
    // The same shape as a take id: sortable, and safe in a file name.
    id: now.toISOString().replace(/[:.]/g, "-"),
    tab_id: tabId, started_at: now.toISOString(), start_url: url, title,
    naming: null, steps: [], beats: [], dropped: [], pending_before: null, paused: null,
    viewport: null, window_resized: false, screen: null, voice: null, camera: null,
    media: { screen: "unavailable: not started", voice: "unavailable: not started", camera: "not requested" },
    pointer: [], frames: [],
});
export const setNaming = (r, naming) => ({ ...r, naming });
export const addStep = (r, step, before, url, now, click = null) => ({
    ...r,
    steps: [...r.steps, { ...step, await: null, at_ms: elapsedMs(r, now), url, click, settled_at_ms: null }],
    pending_before: before,
});
const withNewest = (r, change) => {
    const last = r.steps[r.steps.length - 1];
    return last ? { ...r, steps: [...r.steps.slice(0, -1), change(last)] } : r;
};
// Attaches to the newest step, once, while its window is open. An await that arrives with no window
// open belongs to nothing and is dropped: better no await than one on the wrong step.
export const addAwait = (r, target) => {
    if (r.steps.length === 0 || r.pending_before === null)
        return r;
    return { ...withNewest(r, step => ({ ...step, await: target })), pending_before: null };
};
// The newest step's page has come to rest: the moment the viewer would see before the next action.
// Stamped once; a second settle (an await after a quiet period, or the reverse) changes nothing.
export const settle = (r, now) => withNewest(r, step => step.settled_at_ms === null ? { ...step, settled_at_ms: elapsedMs(r, now) } : step);
export const addDropped = (r, reason, now, point = null) => ({ ...r, dropped: [...r.dropped, { at_ms: elapsedMs(r, now), reason, x: point?.x ?? null, y: point?.y ?? null }] });
export const addNavigation = (r, url, now) => ({ ...r, beats: [...r.beats, { kind: "navigation", at_ms: elapsedMs(r, now), url }] });
export const setViewport = (r, viewport, resized, _now) => ({ ...r, viewport, window_resized: resized });
export const addViewportBeat = (r, viewport, now) => ({ ...r, beats: [...r.beats, { kind: "viewport", at_ms: elapsedMs(r, now), ...viewport }] });
export const pause = (r, reason) => ({ ...r, paused: reason });
export const resume = (r) => ({ ...r, paused: null });
// --- media ---------------------------------------------------------------------------------------
const FILE = { screen: "screen.webm", voice: "voice.webm", camera: "camera.webm" };
export const mediaStarted = (r, track, offset_ms, size) => ({
    ...r,
    [track]: { file: FILE[track], offset_ms, duration_ms: null, width: size?.width ?? null, height: size?.height ?? null },
    media: { ...r.media, [track]: "recorded" },
});
export const mediaUnavailable = (r, track, reason) => ({ ...r, [track]: null, media: { ...r.media, [track]: `unavailable: ${reason}` } });
// The recorder stopped producing chunks before Stop. What was written stays; the status says where it ends.
export const mediaEnded = (r, track, at_ms, reason) => ({ ...r, media: { ...r.media, [track]: `ended at ${at_ms}: ${reason}` } });
export const mediaStopped = (r, track, duration_ms) => {
    const current = r[track];
    return current ? { ...r, [track]: { ...current, duration_ms } } : r;
};
export const addPointer = (r, samples) => ({ ...r, pointer: [...r.pointer, ...samples] });
// The trail a video needs, not every sample: a point is kept when the pointer has moved far enough
// from the last kept point, paused long enough, or changed direction; the first and last always.
// A straight move keeps a few points; a wander keeps its corners. Pure, and order-preserving.
const THIN_DISTANCE_PX = 24;
const THIN_GAP_MS = 250;
const THIN_TURN_DEGREES = 20;
export const thinPointer = (samples) => {
    if (samples.length <= 2)
        return [...samples];
    const kept = [samples[0]];
    for (let i = 1; i < samples.length - 1; i++) {
        const last = kept[kept.length - 1], cur = samples[i], next = samples[i + 1];
        const dx = cur.x - last.x, dy = cur.y - last.y;
        const far = Math.hypot(dx, dy) >= THIN_DISTANCE_PX;
        const paused = cur.t - last.t >= THIN_GAP_MS;
        const a1 = Math.atan2(dy, dx), a2 = Math.atan2(next.y - cur.y, next.x - cur.x);
        let turn = Math.abs(a2 - a1) * 180 / Math.PI;
        if (turn > 180)
            turn = 360 - turn;
        const turned = (dx !== 0 || dy !== 0) && turn >= THIN_TURN_DEGREES;
        if (far || paused || turned)
            kept.push(cur);
    }
    kept.push(samples[samples.length - 1]);
    return kept;
};
// The file name is the timestamp: sorts chronologically, reads without a lookup.
export const frameFile = (at_ms, step, moment) => {
    const stamp = String(Math.max(0, Math.round(at_ms))).padStart(8, "0");
    const what = step === null ? moment : `step${String(step).padStart(2, "0")}-${moment}`;
    return `frames/${stamp}-${what}.jpg`;
};
export const addFrame = (r, frame) => ({ ...r, frames: [...r.frames, frame] });
export const seal = (r, now, incompleteReason) => ({
    bundle_format: BUNDLE_FORMAT, id: r.id, naming: r.naming, started_at: r.started_at,
    sealed_at: now.toISOString(), start_url: r.start_url, title: r.title,
    complete: incompleteReason === null, incomplete_reason: incompleteReason,
    viewport: r.viewport, window_resized: r.window_resized, screen: r.screen, voice: r.voice, camera: r.camera, media: r.media,
    steps: r.steps, pointer: thinPointer(r.pointer), pointer_file: "pointer.json", frames: r.frames, transcript: NOT_ATTEMPTED, beats: r.beats, dropped: r.dropped,
});
export const withTranscript = (b, note) => ({ ...b, transcript: note });

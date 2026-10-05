// The service worker owns the recording. Chrome stops an idle MV3 worker whenever it likes, so
// nothing here lives in memory between events: every event loads the state from storage, applies
// one pure change from recorder.ts, and saves it — serialized, so two events cannot interleave and
// lose a step. Media is the offscreen document's; this file only tells it what to do.
import { addAwait, addDropped, addFrame, addNavigation, addPointer, addStep, addViewportBeat, begin, elapsedMs, frameFile, mediaEnded, mediaStarted, mediaStopped, mediaUnavailable, NOT_ATTEMPTED, pause, resume, seal, setNaming, setViewport, settle, withTranscript, } from "./recorder.js";
import { NOT_SET_UP, pair, serviceUrl } from "./settings.js";
const FILES = ["vendor/playwright-injected.js", "capture.js", "content.js"];
const UNSCRIPTABLE = "VibeTake cannot record this page. Browser pages, the Chrome Web Store and "
    + "the PDF viewer do not let an extension see what you click.";
let queue = Promise.resolve();
const inflight = new Set(); // bundles this worker instance is transcribing right now
// Work that may start only once the state naming it is saved: a transcription for a bundle that was
// never stored would run twice on a retried seal, or discard the media of a recording still stored.
const afterCommit = [];
const load = async () => {
    const got = await chrome.storage.local.get(["recording", "bundles", "fault"]);
    return {
        recording: got["recording"] ?? null,
        bundles: got["bundles"] ?? [],
        fault: got["fault"] ?? null,
    };
};
// TEST SEAM: absent in production.
const testMedia = async () => {
    const got = await chrome.storage.local.get("test_media");
    const set = got["test_media"];
    return set ? { seam: true, ...set } : { seam: false, screen: "tab", mic: "allow" };
};
const paint = (state) => chrome.action.setBadgeText({
    // A fault is sticky: it stays on the badge until a new Record clears it.
    text: state.fault !== null ? "ERR" : state.recording ? (state.recording.paused ? "!" : "REC") : "",
});
const exclusive = (work) => {
    const run = queue.then(async () => {
        afterCommit.length = 0;
        const [next, result] = await work(await load());
        if (next) {
            try {
                await chrome.storage.local.set(next);
                for (const f of afterCommit.splice(0))
                    f();
            }
            catch (error) {
                afterCommit.length = 0;
                // Stop cleanly: seal what storage already holds, with the reason, in one write
                // that is no larger than the state it replaces; if even that fails, record the fault alone.
                const message = `VibeTake could not save the recording (${error instanceof Error ? error.message : String(error)}). `
                    + "The recording was stopped; steps saved before this are kept.";
                const saved = await load();
                const stopped = saved.recording ? await sealed(saved, saved.recording, message) : saved;
                try {
                    await chrome.storage.local.set({ ...stopped, fault: message });
                    for (const f of afterCommit.splice(0))
                        f();
                }
                catch {
                    afterCommit.length = 0;
                    await chrome.storage.local.set({ fault: message }).catch(() => undefined);
                }
                await chrome.action.setBadgeText({ text: "ERR" });
                throw error;
            }
            await paint(next);
        }
        return result;
    });
    queue = run.catch(() => undefined);
    return run;
};
const inject = (tabId) => chrome.scripting.executeScript({ target: { tabId }, files: FILES, injectImmediately: true });
// --- the offscreen recorder -------------------------------------------------------------------------
const ensureOffscreen = async () => {
    if (await chrome.offscreen.hasDocument())
        return;
    await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["DISPLAY_MEDIA", "USER_MEDIA", "BLOBS"],
        justification: "Record the screen and microphone of the tab being demonstrated.",
    });
};
const tellRecorder = async (message) => {
    await ensureOffscreen();
    const reply = await chrome.runtime.sendMessage(message);
    // The offscreen document reports a failure as a value; the worker turns it back into the rejection every caller already handles.
    if (reply && typeof reply === "object" && "media_error" in reply)
        throw new Error(String(reply.media_error));
    return reply;
};
// Stills come from chrome.tabs.captureVisibleTab: the page as Chrome renders it, without the pointer
// that the capture stream paints in (Chromium offers no constraint to leave it out). Chrome allows two
// calls a second; a burst (action, settled, the next action) waits for the quota, so a still can show
// the screen up to a second after the moment it is named for. The recorded tab must be in front,
// which it is whenever a person is demonstrating.
const CAPTURE_QUOTA_PER_SECOND = 2;
const captures = []; // wall-clock times of recent captures
const captureSlot = (now) => {
    while (captures.length > 0 && now - captures[0] >= 1000)
        captures.shift();
    return captures.length < CAPTURE_QUOTA_PER_SECOND ? now : captures[0] + 1050;
};
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const captureStill = async (tabId) => {
    let tab;
    try {
        tab = await chrome.tabs.get(tabId);
    }
    catch {
        return { ok: false, reason: "the recorded tab was gone" };
    }
    if (!tab.active)
        return { ok: false, reason: "the recorded tab was not in front" };
    const slot = captureSlot(Date.now());
    if (slot > Date.now())
        await sleep(slot - Date.now());
    for (let attempt = 0;; attempt++) {
        captures.push(Date.now());
        try {
            return { ok: true, data: await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 85 }) };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // The quota is counted by Chrome, not by this worker (which may have restarted): one more try.
            if (attempt === 0 && /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(message)) {
                await sleep(600);
                continue;
            }
            return { ok: false, reason: `the screen could not be captured (${message})` };
        }
    }
};
// A still at a key moment, stored by the recorder beside the media: a file, or the reason there is none.
const grab = async (r, step, moment, now) => {
    const at_ms = elapsedMs(r, now);
    const file = frameFile(at_ms, step, moment);
    const still = await captureStill(r.tab_id);
    const result = still.ok
        ? await tellRecorder({ type: "media-frame", id: r.id, file, data: still.data })
            .catch(error => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }))
        : still;
    return addFrame(r, result.ok
        ? { step, moment, at_ms, file, reason: null }
        : { step, moment, at_ms, file: null, reason: result.reason });
};
const measure = async (tabId) => {
    try {
        const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => ({ iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight, dpr: devicePixelRatio }),
        });
        return result?.result ?? null;
    }
    catch {
        return null;
    }
};
// Resize the window so the viewport is the largest 16:9 that fits the current window. Footage is then
// clean for assembly to scale to 1920x1080. Returns whether the window changed.
const shapeWindow = async (tab, before) => {
    let width = before.iw, height = Math.round(before.iw * 9 / 16);
    if (height > before.ih) {
        height = before.ih;
        width = Math.round(before.ih * 16 / 9);
    }
    if (width === before.iw && height === before.ih)
        return false;
    const chromeW = before.ow - before.iw, chromeH = before.oh - before.ih;
    try {
        await chrome.windows.update(tab.windowId, { width: width + chromeW, height: height + chromeH });
        return true;
    }
    catch {
        return false;
    }
};
const unavailable = (reason) => ({ status: `unavailable: ${reason}`, file: null, markdown: null, words: 0 });
// Hand the bundle and any text files to the recorder to zip; false when it could not (the popup then
// falls back to exporting bundle.json alone).
const zipSealed = async (bundle, files) => {
    // The pointer trail is its own file in the zip; bundle.json carries only its name.
    const trail = bundle.pointer_file ? { [bundle.pointer_file]: JSON.stringify(bundle.pointer) + "\n" } : {};
    try {
        await tellRecorder({ type: "media-seal", id: bundle.id, bundle: { ...bundle, pointer: [] }, files: { ...trail, ...files } });
        return true;
    }
    catch {
        return false;
    }
};
// After the seal: ask the recorder to transcribe, then seal the zip with the answer and update the
// listing. A bundle deleted meanwhile (one with no steps can be) gets its media discarded instead.
const transcribeAndSeal = async (id, bundle, service_url) => {
    // Pair first: the code is fetched from the service for this request and never stored.
    const paired = await pair(service_url);
    const result = !paired.ok ? { ok: false, reason: paired.reason }
        : await tellRecorder({ type: "media-transcribe", id, bundle, service: paired.access })
            .catch((error) => ({ ok: false, reason: `the recorder could not transcribe (${error instanceof Error ? error.message : String(error)})` }));
    const final = withTranscript(bundle, result.ok
        ? { status: "written", file: "transcript.json", markdown: "transcript.md", words: result.words }
        : unavailable(result.reason));
    const zipped = await zipSealed(final, result.ok ? result.files : {});
    // Still in flight until the listing is updated: a status queued before this work must not take the
    // bundle for stale and re-seal its zip without the transcript.
    await exclusive(async (state) => {
        inflight.delete(id);
        if (!state.bundles.some(b => b.bundle.id === id)) {
            // Not deleted if it is still the live recording in storage: its media stays.
            if (state.recording?.id !== id)
                await tellRecorder({ type: "media-discard", id }).catch(() => undefined);
            return [null, null];
        }
        return [{ ...state, bundles: state.bundles.map(b => b.bundle.id === id ? { ...b, bundle: final, zipped, transcribing: false } : b) }, null];
    }).finally(() => inflight.delete(id));
};
// A worker that was stopped while transcribing (Chrome ends an idle worker; a slow provider can
// outlive it) must not leave a recording at "transcribing…" forever: anything marked transcribing
// that this instance is not transcribing is finished without a transcript.
const settleStale = async (state) => {
    if (!state.bundles.some(b => b.transcribing && !inflight.has(b.bundle.id)))
        return null;
    const bundles = [];
    for (const b of state.bundles) {
        if (!b.transcribing || inflight.has(b.bundle.id)) {
            bundles.push(b);
            continue;
        }
        const final = withTranscript(b.bundle, unavailable("the extension was stopped while transcribing"));
        bundles.push({ ...b, bundle: final, zipped: await zipSealed(final, {}), transcribing: false });
    }
    return { ...state, bundles };
};
// Stop both tracks and record how long each ran; then seal and hand the bundle to the recorder to zip.
// Best effort at every step: a recorder that is already gone leaves the steps intact and the status
// honest, never a thrown error in the middle of sealing.
const sealed = async (state, recording, reason) => {
    // Unconditional: a screen that is gone becomes a frame entry with a reason, never a silently missing one.
    let r = await grab(recording, null, "stop", new Date());
    try {
        const stopped = await tellRecorder({ type: "media-stop", id: r.id });
        for (const track of ["screen", "voice", "camera"]) {
            const duration = stopped[track];
            if (duration !== null && r[track])
                r = mediaStopped(r, track, duration);
            // A recreated, empty recorder answers nulls rather than an error: the track is lost all the same.
            else if (duration === null && r.media[track] === "recorded")
                r = mediaEnded(r, track, elapsedMs(r, new Date()), "the recorder was gone when the recording ended");
        }
    }
    catch (error) {
        const why = `the recorder was gone when the recording ended (${error instanceof Error ? error.message : String(error)})`;
        const at = Math.max(0, Date.now() - Date.parse(r.started_at));
        for (const track of ["screen", "voice", "camera"])
            if (r.media[track] === "recorded")
                r = mediaEnded(r, track, at, why);
    }
    const bundle = seal(r, new Date(), reason);
    const url = await serviceUrl((await testMedia()).seam);
    if (bundle.steps.length === 0) {
        const empty = withTranscript(bundle, unavailable("nothing was recorded"));
        return { recording: null, fault: state.fault, bundles: [...state.bundles, { bundle: empty, exported_at: null, zipped: await zipSealed(empty, {}), transcribing: false }] };
    }
    if (bundle.voice && url) {
        // The narration is transcribed outside this queue (it can take a minute): the recording is listed
        // as transcribing, the zip is sealed when the service answers, and status stays answerable. It
        // starts only once that listing is saved.
        afterCommit.push(() => {
            inflight.add(bundle.id);
            void transcribeAndSeal(bundle.id, bundle, url).catch(() => undefined); // settleStale recovers the row
        });
        return { recording: null, fault: state.fault, bundles: [...state.bundles, { bundle, exported_at: null, zipped: false, transcribing: true }] };
    }
    const final = withTranscript(bundle, unavailable(bundle.voice ? NOT_SET_UP : "the microphone was not recorded"));
    return { recording: null, fault: state.fault, bundles: [...state.bundles, { bundle: final, exported_at: null, zipped: await zipSealed(final, {}), transcribing: false }] };
};
const status = (state) => ({
    recording: state.recording && {
        id: state.recording.id, title: state.recording.title, started_at: state.recording.started_at,
        steps: state.recording.steps.length, dropped: state.recording.dropped, paused: state.recording.paused,
        media: { screen: state.recording.media.screen, voice: state.recording.media.voice, camera: state.recording.media.camera, frames: state.recording.frames.filter(f => f.file !== null).length },
    },
    bundles: state.bundles.map(b => ({
        id: b.bundle.id, steps: b.bundle.steps.length, complete: b.bundle.complete,
        incomplete_reason: b.bundle.incomplete_reason, exported: b.exported_at !== null, zipped: b.zipped,
        transcribing: b.transcribing ?? false, transcript: b.bundle.transcript ?? NOT_ATTEMPTED,
    })),
    fault: state.fault,
});
const start = (tabId) => exclusive(async (state) => {
    if (state.recording)
        return [null, { ok: false, reason: "A recording is already running. Stop it before starting another." }];
    let tab;
    try {
        tab = await chrome.tabs.get(tabId);
    }
    catch {
        return [null, { ok: false, reason: "That tab is gone." }];
    }
    if (!tab.url)
        return [null, { ok: false, reason: UNSCRIPTABLE }];
    // Refuse rather than appear to listen: if the page cannot be scripted, nothing is recorded.
    try {
        await inject(tabId);
    }
    catch {
        return [null, { ok: false, reason: UNSCRIPTABLE }];
    }
    const before = await measure(tabId);
    const resized = before ? await shapeWindow(tab, before) : false;
    const after = resized ? await measure(tabId) : before;
    let recording = begin(tabId, tab.url, tab.title ?? "", new Date());
    const seam = await testMedia();
    // The checkbox decides whether the camera is asked for; the seam answers for it in tests.
    const wanted = seam.seam ? seam.camera !== undefined : (await chrome.storage.local.get("camera")).camera === true;
    const camera = !wanted ? "off" : seam.seam ? seam.camera : "allow";
    // The voice switch is on unless turned off; the seam answers for it in tests.
    const voiceWanted = seam.seam ? seam.mic !== "off" : (await chrome.storage.local.get("voice")).voice !== false;
    const mic = !voiceWanted ? "off" : seam.seam ? seam.mic : "allow";
    // Production: the toolbar click is the gesture Chrome grants tab capture to.
    let streamId = null;
    if (seam.screen === "tab") {
        try {
            streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
        }
        catch (error) {
            return [null, { ok: false, reason: `VibeTake could not capture this tab (${error instanceof Error ? error.message : String(error)}). Nothing was recorded.` }];
        }
    }
    let media;
    try {
        media = await tellRecorder({
            type: "media-start", id: recording.id, started_at: recording.started_at,
            source: { screen: seam.screen, streamId }, mic,
            camera, seam: seam.seam,
        });
    }
    catch (error) {
        return [null, { ok: false, reason: `VibeTake could not start its recorder (${error instanceof Error ? error.message : String(error)}). Nothing was recorded.` }];
    }
    if (!media.screen.ok) {
        // A recording silently without video is a surprise found an hour later: refuse, and clear up.
        await tellRecorder({ type: "media-stop", id: recording.id }).catch(() => undefined);
        await tellRecorder({ type: "media-discard", id: recording.id }).catch(() => undefined);
        return [null, { ok: false, reason: `VibeTake could not capture this tab (${media.screen.reason}). Nothing was recorded.` }];
    }
    recording = mediaStarted(recording, "screen", media.screen.offset_ms, media.screen.width && media.screen.height ? { width: media.screen.width, height: media.screen.height } : null);
    recording = media.voice.ok
        ? mediaStarted(recording, "voice", media.voice.offset_ms, null)
        : mediaUnavailable(recording, "voice", media.voice.reason);
    if (camera !== "off") {
        recording = media.camera.ok
            ? mediaStarted(recording, "camera", media.camera.offset_ms, media.camera.width && media.camera.height ? { width: media.camera.width, height: media.camera.height } : null)
            : mediaUnavailable(recording, "camera", media.camera.reason);
    }
    if (after)
        recording = setViewport(recording, { width: after.iw, height: after.ih, device_pixel_ratio: after.dpr }, resized, new Date());
    recording = await grab(recording, null, "start", new Date());
    // The content script's hello is queued behind this work, so it finds the recording in place.
    return [{ ...state, recording, fault: null }, { ok: true }];
});
const stop = () => exclusive(async (state) => {
    if (!state.recording)
        return [null, { ok: false, reason: "Nothing is being recorded." }];
    // Best effort: the page may be gone or unscriptable. The content script also stops itself the
    // next time it is told it is not being heard.
    chrome.tabs.sendMessage(state.recording.tab_id, { type: "stop" }).catch(() => undefined);
    return [await sealed(state, state.recording, null), { ok: true }];
});
const fromPage = (message, tabId) => exclusive(async (state) => {
    const recording = state.recording;
    // Only the recorded tab is heard: a content script left in another tab must not add steps.
    if (!recording || tabId === undefined || tabId !== recording.tab_id)
        return [null, { recording: false }];
    const now = new Date();
    // A step and its settling are stamped on the page's clock, never before the previous step nor Record.
    const floor = Date.parse(recording.started_at) + (recording.steps.at(-1)?.at_ms ?? 0);
    const pageTime = (at) => new Date(Math.max(at, floor));
    switch (message.type) {
        case "hello": {
            // The viewport is normally set at Record (after the resize); a hello from a page that was
            // never measured — the first page after a worker restart — fills it in.
            const greeted = resume(setNaming(recording, message.naming));
            const measured = greeted.viewport ? greeted : setViewport(greeted, message.viewport, false, now);
            return [{ ...state, recording: measured }, { recording: true, before: recording.pending_before }];
        }
        case "step": {
            const when = pageTime(message.at);
            const stepped = addStep(recording, message.step, message.before, message.url, when, message.click);
            return [{ ...state, recording: await grab(stepped, stepped.steps.length, "action", when) }, { recording: true }];
        }
        case "await":
        case "settled": {
            const changed = message.type === "await" ? addAwait(recording, message.target) : recording;
            const n = changed.steps.length;
            const already = changed.steps[n - 1]?.settled_at_ms !== null;
            const when = message.type === "settled" ? pageTime(message.at) : now;
            const settledNow = settle(changed, when);
            // One settled frame per step: the await or the quiet period, whichever came first.
            return [{ ...state, recording: already || n === 0 ? settledNow : await grab(settledNow, n, "settled", when) }, { recording: true }];
        }
        case "dropped": {
            // A dropped click still gets its still, so a video can show the moment even without a name.
            const when = pageTime(message.at);
            const dropped = addDropped(recording, message.reason, when, message.point);
            return [{ ...state, recording: message.point ? await grab(dropped, null, "dropped", when) : dropped }, { recording: true }];
        }
        case "pointer": {
            const t0 = Date.parse(recording.started_at);
            const samples = message.samples.map(s => ({ t: Math.max(0, s.at - t0), x: s.x, y: s.y }));
            return [{ ...state, recording: addPointer(recording, samples) }, { recording: true }];
        }
        case "viewport":
            return [{ ...state, recording: addViewportBeat(recording, message.viewport, now) }, { recording: true }];
    }
});
const fromRecorder = (message) => exclusive(state => {
    const recording = state.recording;
    if (!recording || recording.id !== message.id || recording.media[message.track] !== "recorded")
        return [null, null];
    return [{ ...state, recording: mediaEnded(recording, message.track, message.at_ms, message.reason) }, null];
});
const handle = (message, sender) => {
    switch (message.type) {
        case "status": return exclusive(async (state) => { const settled = await settleStale(state); return [settled, status(settled ?? state)]; });
        case "start": return start(message.tabId);
        case "stop": return stop();
        case "bundle":
            return exclusive(state => [null, state.bundles.find(b => b.bundle.id === message.id)?.bundle ?? null]);
        case "retranscribe":
            // Before an export: a recording whose transcript failed (the service was down, or not yet set
            // up) is tried again, now, so a service brought up since can still fill the zip. The popup
            // waits for the row to leave "transcribing" and then exports whatever came of it.
            return exclusive(async (state) => {
                const found = state.bundles.find(b => b.bundle.id === message.id);
                if (!found || found.transcribing || !found.bundle.voice || found.bundle.transcript.status === "written")
                    return [null, { retrying: false }];
                const url = await serviceUrl((await testMedia()).seam);
                if (!url)
                    return [null, { retrying: false }];
                const { bundle } = found;
                afterCommit.push(() => {
                    inflight.add(bundle.id);
                    void transcribeAndSeal(bundle.id, bundle, url).catch(() => undefined);
                });
                return [{ ...state, bundles: state.bundles.map(b => b === found ? { ...b, transcribing: true } : b) }, { retrying: true }];
            });
        case "exported":
            return exclusive(state => [{
                    ...state,
                    bundles: state.bundles.map(b => b.bundle.id === message.id ? { ...b, exported_at: new Date().toISOString() } : b),
                }, { ok: true }]);
        case "delete":
            return exclusive(async (state) => {
                const found = state.bundles.find(b => b.bundle.id === message.id);
                if (!found)
                    return [null, { ok: false, reason: "That recording is no longer here." }];
                // A demonstration is not repeatable: one with steps that was never exported stays.
                if (found.exported_at === null && found.bundle.steps.length > 0)
                    return [null, { ok: false, reason: "Export this recording before deleting it." }];
                // Its media goes with it; a person who records daily must not fill a disk with orphans.
                await tellRecorder({ type: "media-discard", id: message.id }).catch(() => undefined);
                return [{ ...state, bundles: state.bundles.filter(b => b !== found) }, { ok: true }];
            });
        case "camera-granted": return chrome.storage.local.set({ cameraGranted: true }).then(() => ({ ok: true }));
        case "mic-granted":
            return chrome.storage.local.set({ micGranted: true }).then(() => ({ ok: true }));
        case "media-ended": return fromRecorder(message);
        default: return fromPage(message, sender.tab?.id);
    }
};
chrome.runtime.onMessage.addListener((message, sender, reply) => {
    // The offscreen document answers media-* messages (from this worker and from the popup); the
    // worker must not answer them too, or two replies race. media-ended is the one it receives.
    if (typeof message?.type === "string" && message.type.startsWith("media-") && message.type !== "media-ended")
        return false;
    handle(message, sender).then(reply, error => {
        reply({ ok: false, recording: false, reason: error instanceof Error ? error.message : String(error) });
    });
    return true; // the reply is asynchronous
});
chrome.webNavigation.onCommitted.addListener(details => {
    if (details.frameId !== 0)
        return;
    void exclusive(async (state) => {
        const recording = state.recording;
        if (!recording || details.tabId !== recording.tab_id)
            return [null, null];
        let next = addNavigation(recording, details.url, new Date());
        try {
            await inject(details.tabId);
            next = resume(next);
        }
        catch {
            // Pause visibly rather than appear to continue.
            next = pause(next, "This page cannot be recorded. Recording continues when you return to an ordinary web page.");
        }
        return [{ ...state, recording: next }, null];
    });
});
chrome.tabs.onRemoved.addListener(tabId => {
    void exclusive(async (state) => [
        state.recording && state.recording.tab_id === tabId
            ? await sealed(state, state.recording, "The recorded tab was closed before Stop was pressed.")
            : null,
        null,
    ]);
});
// A recording cannot survive either of these: a reload orphans the page's content script, and tab
// ids do not survive a restart. Keep what was captured, marked with why it ended.
const interrupted = (reason) => () => {
    void exclusive(async (state) => [state.recording ? await sealed(state, state.recording, reason) : null, null]);
};
chrome.runtime.onInstalled.addListener(interrupted("The extension was reloaded or updated during the recording."));
chrome.runtime.onStartup.addListener(interrupted("Chrome was closed during the recording."));

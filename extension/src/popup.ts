// The popup: Record and Stop, and the honest signals — elapsed time, step count, what was not
// captured — plus the sealed recordings waiting to be exported. It holds no state: everything shown
// is asked of the service worker, twice a second while it is open.
import { discardMedia, openMedia, zipOf } from "./media-store.js";
import type { Bundle, MediaStatus, PopupMessage, Reply, Status } from "./messages.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const ask = <T>(message: PopupMessage): Promise<T> => chrome.runtime.sendMessage(message) as Promise<T>;

const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// One line per stream: a dot while chunks keep coming, a warning when they stop or never started.
const streamLine = (name: string, state: string, live: { ms_since_chunk: number; ended: boolean } | null | undefined, seconds: number): string => {
  if (state.startsWith("unavailable")) return `${name}: ${state}`;
  if (state.startsWith("ended")) return `${name} ⚠ ${state}`;
  // The recorder answered but has no such track: a recreated, empty session.
  if (live === null && state === "recorded") return `${name} ⚠ recorder lost this track`;
  if (live && (live.ended || live.ms_since_chunk > 2000)) return `${name} ⚠ no data for ${Math.round(live.ms_since_chunk / 1000)}s`;
  return `${name} ● ${clock(seconds * 1000)}`;
};

const show = (id: string, text: string | null): void => {
  const el = $(id);
  el.textContent = text ?? "";
  el.hidden = text === null;
};

const ICON_EXPORT = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';
const ICON_TRASH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

// A recording's id is its start time, sortable and safe in a file name; shown as a date and a time.
const when = (id: string): { date: string; time: string } => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(id);
  if (!m) return { date: id, time: "" };
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return { date: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }), time: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) };
};

const row = (b: Status["bundles"][number]): HTMLLIElement => {
  const li = document.createElement("li");
  const rec = el("div", "rec");
  const head = el("div", "when");
  const at = when(b.id);
  head.append(el("b", "", at.date), el("span", "", at.time));
  const meta = el("div", "meta");
  meta.append(el("span", "", `${b.steps} ${b.steps === 1 ? "step" : "steps"}`));
  // The transcript's state, in the words the tests and a person both read. A transcript that
  // failed is a problem to fix, not a detail: it gets its own line under the row, full width.
  const transcript = b.transcribing ? "transcribing\u2026"
    : b.transcript.status === "written" ? `transcript: ${b.transcript.words} ${b.transcript.words === 1 ? "word" : "words"}`
    : null;
  const problem = b.transcribing || b.transcript.status === "written" || b.transcript.status === "unavailable: not attempted"
    ? null : `no transcript: ${b.transcript.status.replace(/^unavailable: /, "")}`;
  if (transcript !== null) { meta.append(el("span", "sep", "\u00b7"), el("span", "", transcript)); }
  if (!(b.zipped || b.steps === 0 || b.transcribing)) { meta.append(el("span", "sep", "\u00b7"), el("span", "", "no video")); }
  const pill = el("span", "pill", b.exported ? "exported" : b.complete ? "draft" : "incomplete");
  if (b.exported) pill.classList.add("ok");
  if (!b.complete) { pill.classList.add("bad"); pill.title = b.incomplete_reason ?? "not stopped normally"; }
  meta.append(pill);
  rec.append(head, meta);
  const exp = el("button", "export");
  exp.innerHTML = ICON_EXPORT;
  exp.append("Export");
  exp.title = "Export";
  exp.setAttribute("data-export", b.id);
  exp.disabled = b.transcribing;
  const del = el("button", "trash");
  del.innerHTML = ICON_TRASH;
  del.setAttribute("aria-label", "Delete");
  del.title = "Delete";
  del.setAttribute("data-delete", b.id);
  // Never deletable until it has been exported, unless there is nothing in it to lose.
  del.disabled = !(b.exported || b.steps === 0);
  const line = el("div", "line");
  line.append(rec, exp, del);
  li.append(line);
  if (problem !== null) li.append(el("p", "problem", problem));
  return li;
};

// undefined: not asked (nothing recording). null: asked, and the recorder did not answer.
let latestMedia: MediaStatus | null | undefined;
let drawn = "";
// What Chrome has actually decided about a device, asked from this extension page. The *Asked and
// *Granted flags only remember what this extension did; Chrome's answer is the truth, and it changes
// in Chrome's site settings without the extension hearing of it. "unknown" (an old Chrome) falls back
// to the flags.
type Grant = "granted" | "prompt" | "denied" | "unknown";
const grantOf = async (name: "microphone" | "camera"): Promise<Grant> => {
  // TEST SEAM: Chromium's fake prompt flag grants every
  // device, so tests set "test_grants" in chrome.storage.local to stand in for Chrome's answer.
  const seam = ((await chrome.storage.local.get("test_grants")) as { test_grants?: Partial<Record<"microphone" | "camera", Grant>> }).test_grants;
  if (seam?.[name]) return seam[name]!;
  try { return (await navigator.permissions.query({ name: name as PermissionName })).state; }
  catch { return "unknown"; }
};
// Whether the permission page must be shown before the device can be used: Chrome still has to ask.
// A device Chrome has denied is not asked about again (the popup's link opens the page on request).
const needsAsking = (grant: Grant, granted: boolean | undefined, asked: boolean | undefined): boolean =>
  grant === "prompt" || (grant === "unknown" && !granted && !asked);

// Chrome shows its device prompt only for an ordinary extension page: the question is asked from a
// small window that asks on load and closes itself once Chrome has an answer.
const askFor = (device: "microphone" | "camera"): Promise<unknown> =>
  chrome.windows.create({ url: chrome.runtime.getURL(`permission.html?device=${device}`), type: "popup", width: 420, height: 180, focused: true });

const render = (status: Status): void => {
  const rec = status.recording;
  $("record").hidden = rec !== null;
  $("stop").hidden = rec === null;
  $("status").classList.toggle("live", rec !== null);
  const transcribing = status.bundles.some(b => b.transcribing);
  $("state").textContent = rec
    ? `Recording this tab \u00b7 ${rec.steps} ${rec.steps === 1 ? "step" : "steps"}`
    : transcribing ? "Stopping\u2026 transcribing the narration" : "Not recording";
  $("state").title = rec?.title ?? "";
  show("sub", rec ? null : transcribing ? "The zip is sealed once the transcript is back" : "Ready when you are");
  show("elapsed", rec ? clock(Date.now() - Date.parse(rec.started_at)) : null);
  show("paused", rec?.paused ?? null);
  if (rec) {
    const elapsed = (Date.now() - Date.parse(rec.started_at)) / 1000;
    const live = latestMedia;
    const gone = (name: string, state: string): string | null => live === null && state === "recorded" ? `${name} ⚠ recorder not responding` : null;
    show("media", [
      gone("Screen", rec.media.screen) ?? streamLine("Screen", rec.media.screen, live?.screen, elapsed),
      ...(rec.media.voice === "unavailable: not requested" ? [] : [gone("Voice", rec.media.voice) ?? streamLine("Voice", rec.media.voice, live?.voice, elapsed)]),
      ...(rec.media.camera === "not requested" ? [] : [gone("Camera", rec.media.camera) ?? streamLine("Camera", rec.media.camera, live?.camera, elapsed)]),
      `${rec.media.frames} ${rec.media.frames === 1 ? "frame" : "frames"}`,
    ].join(" · "));
  } else {
    show("media", null);
  }
  show("fault", status.fault);
  // The lists are rebuilt only when they change, so a button is never replaced under a click.
  const lists = JSON.stringify([rec?.dropped ?? [], status.bundles]);
  if (lists === drawn) return;
  drawn = lists;
  const dropped = rec?.dropped ?? [];
  $("dropped-section").hidden = dropped.length === 0;
  $("dropped").replaceChildren(...dropped.map(d => {
    const li = document.createElement("li");
    li.textContent = `${clock(d.at_ms)} — ${d.reason}`;
    return li;
  }));
  $("none").hidden = status.bundles.length > 0;
  $("count").textContent = String(status.bundles.length);
  // Newest first: a recording's id is its start time, so the ids sort.
  $("bundles").replaceChildren(...[...status.bundles].sort((a, b) => b.id.localeCompare(a.id)).map(row));
};

// The worker's error reply arrives as a resolved value with no bundles; show its reason, draw nothing.
const refresh = async (): Promise<void> => {
  const reply = await ask<Partial<Status> & { reason?: string }>({ type: "status" });
  if (!Array.isArray(reply?.bundles)) {
    show("fault", reply?.reason ?? "VibeTake Capture is not responding.");
    return;
  }
  const flags = (await chrome.storage.local.get(["voice", "camera"])) as { voice?: boolean; camera?: boolean };
  // The poll must never undo a click in progress: leave the box alone while it has focus.
  const cam = $<HTMLInputElement>("camera");
  if (document.activeElement !== cam) cam.checked = flags.camera === true;
  const mic = $<HTMLInputElement>("voice");
  if (document.activeElement !== mic) mic.checked = flags.voice !== false;
  // The liveness question goes to the recorder; silence means it is gone.
  const rec = (reply as Status).recording;
  latestMedia = rec
    ? await (chrome.runtime.sendMessage({ type: "media-status", id: rec.id }) as Promise<MediaStatus | undefined>).catch(() => undefined) ?? null
    : undefined;
  render(reply as Status);
};

$("record").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) { show("refusal", "There is no tab to record."); return; }
  const flags = await chrome.storage.local.get(["voice", "micGranted", "micAsked", "camera", "cameraGranted", "cameraAsked"]) as {
    voice?: boolean; micGranted?: boolean; micAsked?: boolean; camera?: boolean; cameraGranted?: boolean; cameraAsked?: boolean;
  };
  // Chrome, not this extension's memory, says whether a device can be used: the recorder runs in a
  // page that cannot show a prompt, so a device Chrome would still ask about is asked for first, from
  // the small window. Opening it closes this popup, so the flags go first. A device Chrome has denied
  // is not asked about again; recording goes ahead and the stream line says it is unavailable.
  if (flags.voice !== false && needsAsking(await grantOf("microphone"), flags.micGranted, flags.micAsked)) {
    await chrome.storage.local.set({ micAsked: true, micGranted: false });
    show("refusal", "Answer Chrome's microphone prompt in the small window that just opened, then press Record again.");
    await askFor("microphone");
    return;
  }
  if (flags.camera && needsAsking(await grantOf("camera"), flags.cameraGranted, flags.cameraAsked)) {
    await chrome.storage.local.set({ cameraAsked: true, cameraGranted: false });
    show("refusal", "Answer Chrome's camera prompt in the small window that just opened, then press Record again.");
    await askFor("camera");
    return;
  }
  const reply = await ask<Reply>({ type: "start", tabId: tab.id });
  show("refusal", reply.ok ? null : reply.reason);
  await refresh();
});

// A switch turned on while Chrome still has to ask opens the question at once.
$<HTMLInputElement>("voice").addEventListener("change", async e => {
  const on = (e.target as HTMLInputElement).checked;
  await chrome.storage.local.set({ voice: on });
  const flags = await chrome.storage.local.get(["micGranted", "micAsked"]) as { micGranted?: boolean; micAsked?: boolean };
  if (on && needsAsking(await grantOf("microphone"), flags.micGranted, flags.micAsked)) {
    await chrome.storage.local.set({ micAsked: true, micGranted: false });
    await askFor("microphone");
  }
});
$<HTMLInputElement>("camera").addEventListener("change", async e => {
  const on = (e.target as HTMLInputElement).checked;
  await chrome.storage.local.set({ camera: on });
  const flags = await chrome.storage.local.get(["cameraGranted", "cameraAsked"]) as { cameraGranted?: boolean; cameraAsked?: boolean };
  if (on && needsAsking(await grantOf("camera"), flags.cameraGranted, flags.cameraAsked)) {
    await chrome.storage.local.set({ cameraAsked: true, cameraGranted: false });
    await askFor("camera");
  }
});

$("settings-link").addEventListener("click", e => {
  e.preventDefault();
  void chrome.runtime.openOptionsPage();
});

$("stop").addEventListener("click", async () => {
  await ask<Reply>({ type: "stop" });
  await refresh();
});

document.addEventListener("click", async e => {
  // The click may land on the icon inside the button: read the attributes from the button itself.
  const target = (e.target as Element).closest("button[data-export], button[data-delete]");
  const exportId = target?.getAttribute("data-export") ?? null;
  const deleteId = target?.getAttribute("data-delete") ?? null;
  if (exportId) {
    // A transcript that failed earlier is tried once more, in case the service is up now; the
    // export waits for the answer (the row reads "transcribing\u2026" meanwhile) and ships either way.
    const retry = await ask<{ retrying: boolean } | undefined>({ type: "retranscribe", id: exportId });
    if (retry?.retrying) {
      await refresh();
      while ((await ask<Partial<Status>>({ type: "status" }))?.bundles?.find(b => b.id === exportId)?.transcribing)
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    // The sealed zip, when the recorder produced one; bundle.json alone when it could not.
    const zip = await zipOf(await openMedia(), exportId).catch(() => null);
    const bundle = zip ? null : await ask<Bundle | null>({ type: "bundle", id: exportId });
    if (!zip && !bundle) return;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(zip ?? new Blob([JSON.stringify(bundle, null, 2) + "\n"], { type: "application/json" }));
    link.download = `vibetake-${exportId}.${zip ? "zip" : "json"}`;
    link.click();
    // Marked on the click, since a download cannot report that it was saved. Deleting is still a
    // separate, deliberate press.
    await ask<Reply>({ type: "exported", id: exportId });
  } else if (deleteId) {
    const reply = await ask<Reply>({ type: "delete", id: deleteId });
    show("refusal", reply.ok ? null : reply.reason);
    // The worker asked the recorder to discard too; this covers a recorder that was gone.
    if (reply.ok) await openMedia().then(db => discardMedia(db, deleteId)).catch(() => undefined);
  } else {
    return;
  }
  await refresh();
});

void refresh();
setInterval(() => void refresh(), 500);

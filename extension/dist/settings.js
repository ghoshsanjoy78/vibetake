export const DEFAULT_SERVICE_URL = "http://127.0.0.1:7741";
export const NOT_SET_UP = "not set up: the service URL is not set";
export const NOT_LOCAL = "The service URL must be on this machine: http://127.0.0.1:<port> or http://localhost:<port>. Nothing was saved.";
const CHECK_TIMEOUT_MS = 5_000;
// The voice track goes only to this machine: a URL anywhere else is refused before it is saved.
export const isLoopback = (url) => {
    try {
        const u = new URL(url);
        return u.protocol === "http:" && u.username === "" && u.password === "" && (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.pathname === "/" && u.search === "" && u.hash === "";
    }
    catch {
        return false;
    }
};
// The canonical form that is stored and sent to: scheme, host and port, nothing else.
const canonical = (url) => new URL(url.replace(/\/+$/, "") + "/").origin;
export const readSettings = async () => {
    const got = await chrome.storage.local.get("settings");
    const s = got["settings"];
    if (!s || typeof s.service_url !== "string" || !isLoopback(s.service_url.replace(/\/+$/, "") + "/"))
        return null;
    return { service_url: canonical(s.service_url) };
};
export const writeSettings = (s) => chrome.storage.local.set({ settings: { service_url: canonical(s.service_url) } });
// The address to transcribe through: the stored one, else the default. Under the test seam there
// is no default, so a test can never reach a real service that happens to be running.
export const serviceUrl = async (seam) => (await readSettings())?.service_url ?? (seam ? null : DEFAULT_SERVICE_URL);
// Fetch the pairing code from the service. Chrome sends this extension's origin with a POST (not
// with a GET), which is what the service pairs with; a web page cannot forge it or read the answer.
export const pair = async (service_url) => {
    if (!isLoopback(service_url.replace(/\/+$/, "") + "/"))
        return { ok: false, reason: "the service URL is not on this machine" };
    const base = canonical(service_url);
    let response;
    try {
        response = await fetch(`${base}/pair`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    }
    catch {
        return { ok: false, reason: `the VibeTake service at ${base} could not be reached (is npm run serve running?)` };
    }
    const body = (await response.json().catch(() => null));
    if (!response.ok) {
        const message = typeof body?.error?.message === "string" ? body.error.message.replace(/\.$/, "") : `the service answered ${response.status}`;
        return { ok: false, reason: `${base} would not pair (${message})` };
    }
    if (typeof body?.code !== "string" || body.code === "")
        return { ok: false, reason: `${base} answered, but not as npm run serve would` };
    return { ok: true, access: { service_url: base, pairing_code: body.code } };
};
// One sentence about the service for the Settings page: pair, then ask /health what it can do.
export const connect = async (service_url) => {
    if (!isLoopback(service_url.replace(/\/+$/, "") + "/"))
        return { ok: false, line: NOT_LOCAL };
    const base = canonical(service_url);
    const paired = await pair(base);
    if (!paired.ok) {
        return { ok: false, line: paired.reason.startsWith("the VibeTake service at")
                ? `Could not reach ${base}: is npm run serve running?`
                : paired.reason.charAt(0).toUpperCase() + paired.reason.slice(1) + "." };
    }
    let response;
    try {
        response = await fetch(`${base}/health`, { redirect: "error", headers: { Authorization: `Bearer ${paired.access.pairing_code}` }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    }
    catch {
        return { ok: false, line: `Could not reach ${base}: is npm run serve running?` };
    }
    if (!response.ok)
        return { ok: false, line: `The service answered ${response.status}; is that really npm run serve?` };
    const body = (await response.json().catch(() => null));
    if (typeof body !== "object" || body === null || !("provider" in body))
        return { ok: false, line: `${base} answered, but not as npm run serve would.` };
    return body.provider
        ? { ok: true, line: `Connected: transcription via ${body.provider} (${body.model}).` }
        : { ok: true, line: "Connected, but the service has no transcription key: add OPENAI_API_KEY or OPENROUTER_API_KEY to .env.local and start it again." };
};

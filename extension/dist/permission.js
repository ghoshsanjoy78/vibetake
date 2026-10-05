"use strict";
// The one-time grant, asked from a small window. Neither the offscreen document nor the popup can
// show Chrome's prompt; an ordinary extension page can. The grant is per extension origin and
// persists. The page asks on load, says one line, and closes itself once Chrome has answered.
const $ = (id) => document.getElementById(id);
const device = new URLSearchParams(location.search).get("device") === "camera" ? "camera" : "microphone";
$("device").textContent = device;
const ask = async () => {
    $("refused").hidden = true;
    $("retry").hidden = true;
    // The camera is asked for with its microphone when the voice switch is on, as the recorder will.
    const voiceOn = (await chrome.storage.local.get("voice")).voice !== false;
    const constraints = device === "camera" ? { video: true, audio: voiceOn } : { audio: true };
    try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        for (const t of stream.getTracks())
            t.stop(); // asked only to be granted; nothing is recorded here
        await chrome.runtime.sendMessage({ type: device === "camera" ? "camera-granted" : "mic-granted" });
        if (device === "camera" && voiceOn)
            await chrome.runtime.sendMessage({ type: "mic-granted" }); // Chrome granted both
        $("asking").hidden = true;
        $("done").hidden = false;
        setTimeout(async () => {
            const me = await chrome.tabs.getCurrent();
            if (me?.id !== undefined)
                await chrome.tabs.remove(me.id);
        }, 800);
    }
    catch (error) {
        $("refused").textContent = `Chrome did not allow the ${device} (${error instanceof Error ? error.message : String(error)}). `
            + "Recording still works without it: turn its switch off in the popup, or ask again.";
        $("refused").hidden = false;
        $("retry").hidden = false;
    }
};
$("retry").addEventListener("click", () => void ask());
void ask();

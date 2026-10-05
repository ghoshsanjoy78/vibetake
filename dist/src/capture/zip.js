import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { FormatError } from "../errors.js";
import { isV2, parseBundle } from "./bundle.js";
const namedFiles = (bundle) => [
    ...(bundle.screen ? [bundle.screen.file] : []),
    ...(bundle.voice ? [bundle.voice.file] : []),
    ...(bundle.camera ? [bundle.camera.file] : []),
    ...(bundle.pointer_file ? [bundle.pointer_file] : []),
    ...bundle.frames.flatMap(f => f.file ? [f.file] : []),
    ...(bundle.transcript.file ? [bundle.transcript.file] : []),
    ...(bundle.transcript.markdown ? [bundle.transcript.markdown] : []),
];
export const readRecordingZip = (file, bytes) => {
    // A zip is told by its first bytes (a download may have no suffix).
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04))
        throw new FormatError(`${file} is not a zip VibeTake can read.`);
    let entries;
    try {
        entries = unzipSync(bytes);
    }
    catch {
        throw new FormatError(`${file} is not a zip VibeTake can read.`);
    }
    const manifest = entries["bundle.json"];
    if (!manifest)
        throw new FormatError(`${file} has no bundle.json, so it is not a VibeTake recording.`);
    let raw;
    try {
        raw = JSON.parse(strFromU8(manifest));
    }
    catch {
        throw new FormatError(`${file}: bundle.json is not valid JSON.`);
    }
    const bundle = parseBundle(raw);
    if (!isV2(bundle))
        throw new FormatError(`${file} is a steps-only recording (bundle format 1) with no media in it.`);
    for (const name of Object.keys(entries))
        if (name.includes("\\") || name.split("/").some(part => part === "" || part === "." || part === ".."))
            throw new FormatError(`Refusing the file name "${name}" in the recording: it could leave its directory.`);
    const missing = namedFiles(bundle).filter(name => !(name in entries));
    if (missing.length > 0)
        throw new FormatError(`${file} is missing ${missing.join(", ")}, which bundle.json names. The download may be incomplete.`);
    return { bundle, entries };
};
// The zip again, with bundle.json rewritten from the bundle. Media stays stored, text is deflated.
export const writeRecordingZip = (recording) => {
    const entries = {};
    const text = (name) => name.endsWith(".json") || name.endsWith(".md");
    for (const [name, bytes] of Object.entries(recording.entries))
        entries[name] = [bytes, { level: text(name) ? 6 : 0 }];
    entries["bundle.json"] = [strToU8(JSON.stringify(recording.bundle, null, 2) + "\n"), { level: 6 }];
    return zipSync(entries);
};

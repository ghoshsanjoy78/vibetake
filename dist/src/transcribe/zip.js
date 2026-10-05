import fs from "node:fs";
import { strToU8 } from "fflate";
import { noteFor } from "../capture/bundle.js";
import { readRecordingZip, writeRecordingZip } from "../capture/zip.js";
import { transcribeBundle } from "./core.js";
import { chooseProvider, NO_KEY_HINT } from "./env.js";
import { TranscriptionError } from "./provider.js";
import { clock } from "./transcript.js";
export const transcribeZip = async (file, opts) => {
    const skipped = (line) => ({ kind: "skipped", lines: [line] });
    const bytes = fs.readFileSync(file);
    const recording = readRecordingZip(file, new Uint8Array(bytes));
    const { bundle } = recording;
    if (!bundle.voice)
        return skipped(`Not transcribed: the microphone was not recorded (${bundle.media.voice}).`);
    if (bundle.transcript.status === "written" && !opts.force)
        return skipped(`Not transcribed: ${file} already carries ${bundle.transcript.file}; pass --force to replace it.`);
    const choice = chooseProvider(opts.env);
    if (!choice)
        return skipped(`Not transcribed: ${NO_KEY_HINT}, then run: vibetake transcribe ${file}`);
    opts.out?.(`Transcribing ${bundle.voice.duration_ms === null ? "narration of unknown length" : `${clock(bundle.voice.duration_ms)} of narration`} with ${choice.provider} (${choice.model})…`);
    let done;
    try {
        done = await transcribeBundle(bundle, recording.entries[bundle.voice.file], bundle.steps.map(noteFor), choice, opts.deps);
    }
    catch (error) {
        if (error instanceof TranscriptionError) {
            const detail = error.detail ? ` (${error.detail})` : "";
            return { kind: "failed", lines: [`Not transcribed: ${error.message.replace(/\.$/, "")}${detail}. Run: vibetake transcribe ${file}`] };
        }
        throw error;
    }
    recording.entries["transcript.json"] = strToU8(JSON.stringify(done.transcript, null, 2) + "\n");
    recording.entries["transcript.md"] = strToU8(done.markdown);
    recording.bundle = { ...bundle, transcript: { status: "written", file: "transcript.json", markdown: "transcript.md", words: done.transcript.words.length } };
    // Rewritten in place through a temporary file, so a failure mid-write never leaves half a zip.
    const tmp = `${file}.vibetake-tmp`;
    fs.writeFileSync(tmp, writeRecordingZip(recording));
    fs.renameSync(tmp, file);
    return { kind: "written", lines: [...done.summary, `Wrote transcript.json and transcript.md into ${file}.`] };
};

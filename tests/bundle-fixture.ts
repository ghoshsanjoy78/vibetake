import { strFromU8, strToU8, zipSync } from "fflate";

// One bundle, as the extension would export it after a two-step demo.
// A fresh object each call, so a test that mutates it cannot leak into the next.
export const sampleBundle = () => ({
  bundle_format: 1,
  id: "2026-10-04T09-14-00-000Z",
  naming: "playwright-core@0.0.0-test",
  started_at: "2026-10-04T09:14:00.000Z",
  sealed_at: "2026-10-04T09:15:20.000Z",
  start_url: "http://127.0.0.1:4321/",
  title: "Fixture — VibeTake",
  complete: true,
  incomplete_reason: null,
  video: null,
  steps: [
    { do: "click" as const, target: { label: "New Comic", role: "button", nth: 1 }, value: null,
      await: { label: "Title", role: "textbox" }, at_ms: 1200, url: "http://127.0.0.1:4321/" },
    { do: "type" as const, target: { label: "Title", role: "textbox", nth: 1 }, value: "The Lost Treasure",
      await: null, at_ms: 4600, url: "http://127.0.0.1:4321/" },
    { do: "select" as const, target: { label: "Stay category", role: "combobox", nth: 1 }, value: "Price",
      await: null, at_ms: 6100, url: "http://127.0.0.1:4321/" },
  ],
  beats: [{ kind: "navigation" as const, at_ms: 9800, url: "http://127.0.0.1:4321/two.html" }],
  dropped: [{ at_ms: 7100, reason: "A click on something with no button, link or other control under it was not captured.", x: null, y: null }],
});

// The same demo as a stage-2 bundle: media, frames, pointer and click geometry on one clock.
export const sampleBundleV2 = () => {
  const { video: _video, ...v1 } = sampleBundle();
  return {
    ...v1,
    bundle_format: 2,
    viewport: { width: 1600, height: 900, device_pixel_ratio: 2 },
    window_resized: true,
    screen: { file: "screen.webm", offset_ms: 412, duration_ms: 94210, width: 3200, height: 1800 },
    voice: { file: "voice.webm", offset_ms: 418, duration_ms: 94180, width: null, height: null },
    camera: null,
    media: { screen: "recorded", voice: "recorded", camera: "not requested" },
    steps: v1.steps.map((step, i) => ({
      ...step,
      click: step.do === "click"
        ? { x: 412, y: 88, box: { x: 380, y: 72, width: 96, height: 32 }, scroll: { x: 0, y: 0 } } : null,
      settled_at_ms: step.at_ms + 260 + i,
    })),
    pointer: [{ t: 1180, x: 402, y: 91 }, { t: 1230, x: 410, y: 89 }],
    pointer_file: null,
    frames: [
      { step: null, moment: "start" as const, at_ms: 0, file: "frames/00000000-start.jpg", reason: null },
      { step: 1, moment: "action" as const, at_ms: 1200, file: "frames/00001200-step01-action.jpg", reason: null },
      { step: 1, moment: "settled" as const, at_ms: 1460, file: "frames/00001460-step01-settled.jpg", reason: null },
      { step: 2, moment: "action" as const, at_ms: 4600, file: null, reason: "the screen stream had ended" },
      { step: null, moment: "stop" as const, at_ms: 94210, file: "frames/00094210-stop.jpg", reason: null },
    ],
    transcript: { status: "unavailable: not attempted", file: null, markdown: null, words: 0 },
  };
};

// The zip the extension would export for sampleBundleV2: bundle.json, both media files and every
// frame the manifest names, with just enough bytes to be recognisable. `edit` lets a test break it.
export const sampleZip = (edit: (entries: Record<string, Uint8Array>) => void = () => {}): Uint8Array => {
  const bundle = sampleBundleV2();
  const entries: Record<string, Uint8Array> = {
    "bundle.json": strToU8(JSON.stringify(bundle, null, 2) + "\n"),
    "screen.webm": new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]),
    "voice.webm": new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 9, 9, 9, 9]),
  };
  for (const frame of bundle.frames) if (frame.file) entries[frame.file] = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
  edit(entries);
  return zipSync(entries, { level: 0 });
};

// A transcript as the service writes it for sampleBundleV2: two words in step 1's window.
export const sampleTranscript = () => ({
  transcript_format: 1, provider: "openai", model: "whisper-1", language: "english", transcribed_at: "2026-10-05T04:00:00.000Z",
  voice_offset_ms: 418, voice_end_ms: 418 + 94180, text: "Click New.",
  words: [{ word: "Click", start_ms: 1418, end_ms: 1718 }, { word: "New.", start_ms: 1718, end_ms: 1918 }],
  steps: [{ n: 0, from_ms: 0, to_ms: 1200, said: "" }, { n: 1, from_ms: 1200, to_ms: 4600, said: "Click New." }, { n: 2, from_ms: 4600, to_ms: 6100, said: "" }, { n: 3, from_ms: 6100, to_ms: 94598, said: "" }],
  clamped: 0,
});

// The zip the extension exports when the service transcribed at Stop: the two files, named by the note.
export const sampleZipWithTranscript = (edit: (entries: Record<string, Uint8Array>) => void = () => {}): Uint8Array =>
  sampleZip(entries => {
    const bundle = JSON.parse(strFromU8(entries["bundle.json"]!)) as Record<string, unknown>;
    bundle["transcript"] = { status: "written", file: "transcript.json", markdown: "transcript.md", words: 2 };
    entries["bundle.json"] = strToU8(JSON.stringify(bundle, null, 2) + "\n");
    entries["transcript.json"] = strToU8(JSON.stringify(sampleTranscript(), null, 2) + "\n");
    entries["transcript.md"] = strToU8("# Narration \u2014 transcribed by openai (whisper-1)\n\n## 0:01 \u00b7 Step 1 \u2014 Click New Comic\nClick New.\n");
    edit(entries);
  });

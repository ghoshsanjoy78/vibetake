# VibeTake guide

The details the [README](README.md) leaves out: what is in a recording, the video routes step by
step, the local service, and building from source.

## What is in a recording

A recording is one zip, `vibetake-<id>.zip`, and every time in it is in milliseconds on one clock
that starts when Record was pressed.

| File | What it is |
| --- | --- |
| `bundle.json` | every click (name, role, rectangle, coordinates, when, and when the page settled), the viewport, the tracks, and the clicks that landed on nothing an AI can name (with their coordinates) |
| `pointer.json` | the pointer path, thinned to its corners and pauses; kept apart so an AI can read the clicks without it |
| `frames/<time>-step<nn>-<action\|settled>.jpg` | the page at the instant of each click and once it reacted, named by their time; no pointer. A click that landed on nothing nameable gets `frames/<time>-dropped.jpg` |
| `screen.webm` | the tab, as video |
| `voice.webm` | your narration |
| `camera.webm` | your face and voice, if the camera switch was on |
| `transcript.json`, `transcript.md` | what you said, word by word, on the recording's clock, sliced per step |

The extension asks for access to all sites; it uses it only to see what you click in the tab you
are recording. The screen video and the stills show whatever the tab showed, including a password
revealed by a show-password toggle.

## The transcript

At Stop, the extension sends the voice track to the local service, which transcribes it with your
key and seals `transcript.json` and `transcript.md` into the zip. `whisper-1` costs about $0.006 per
minute of narration.

If the service was not running at Stop, the zip has no transcript and the popup says why. Start
the service and press **Export** again: the extension tries the transcript once more and the new
zip carries it. Or add it later, into a zip you already have:

```bash
node dist/src/cli.js transcribe ~/Downloads/vibetake-<id>.zip      # --force to replace one
```

## The prompts

Two prompts come with VibeTake:

- [`prompts/demo-video-faceless.md`](prompts/demo-video-faceless.md): no one on camera. The video
  is built from the stills and the transcript, with a synthesized voice.
- [`prompts/demo-video-with-face.md`](prompts/demo-video-with-face.md): your webcam recording,
  edited. Your own voice is the soundtrack, cut tight, and your face is overlaid.

Both tell the AI how to cut dead time and hesitations, zoom on each click, outline the clicked
control in red, draw a smooth cursor, keep the framing steady across cuts, and write captions. Fill
in the bracketed lines at the top (product, audience, length) before pasting.

## With Claude Design

1. Unzip the recording.
2. Open [claude.ai/design](https://claude.ai/design) and choose the **Animate** template.
3. Paste the prompt and attach the unzipped folder: `bundle.json`, `transcript.json`, `frames/`,
   and `camera.webm` if you are using the face prompt.
4. Review the first cut and ask for changes by step number or time ("hold longer on step 4", "the
   outline is on the wrong button at 0:41"). Everything in the zip is on one clock, so those mean
   the same thing to you and to Claude.

## With HyperFrames

[HyperFrames](https://hyperframes.dev) writes videos as HTML compositions and renders them from the
command line. It has skills for Claude Code and Codex.

1. Unzip the recording and go into the folder:
   ```bash
   unzip ~/Downloads/vibetake-<id>.zip -d my-demo
   cd my-demo
   ```
2. Add the HyperFrames skills:
   ```bash
   npx skills add heygen-com/hyperframes
   ```
3. Start Claude Code or Codex in that folder.
4. Paste the prompt and add one line at the end:
   *"Build this as a HyperFrames composition in `video/` and render it to `demo.mp4`."*
5. Review the first cut and ask for changes by step number or time.

## With Remotion

[Remotion](https://www.remotion.dev) writes videos as React components. Its skills work with Claude
Code, Codex, Kimi Code and Cursor.

1. Unzip the recording and go into the folder:
   ```bash
   unzip ~/Downloads/vibetake-<id>.zip -d my-demo
   cd my-demo
   ```
2. Create a Remotion project beside the recording and add the Remotion skills:
   ```bash
   npx create-video@latest video
   cd video && npx skills add remotion-dev/skills && cd ..
   ```
3. Start Claude Code or Codex in the `my-demo` folder.
4. Paste the prompt and add one line at the end:
   *"Build this as a Remotion composition in `video/` and render it."*
5. Review the first cut and ask for changes by step number or time.

## The local service

`npm run serve` listens on `127.0.0.1:7741` (`VIBETAKE_PORT` changes it; never 3000).
It reads `.env.local` from the directory it is started in, so start it from the VibeTake folder.
It answers only requests carrying a pairing secret it mints into `config/pairing-secret` on first
start; the extension fetches that secret itself, and a web page cannot, so no site you visit can
spend your key. The Settings page behind the gear icon in the popup is only needed if the service
runs on another port: enter the address and press **Connect**.

VibeTake writes nothing outside its own directory except the zips you export.

## Building from source and running the tests

The built CLI (`dist/`) and extension (`extension/dist/`) are in the repository. To rebuild them or
run the tests:

```bash
npm install
npx playwright install chromium     # the live tests drive a real Chromium
npm run build                       # the CLI, into dist/
npm run build:extension             # the extension, into extension/dist/
npm test                            # unit tests (vitest)
npm run typecheck
npm run test:live                   # a real Chromium with the extension against a local fixture; no network
```

## Known rough edges

- Transcription is capped at 25 MB of voice, about 25 minutes; longer recordings are refused, not split.
- Stills wait for Chrome's limit of two captures a second, so after a burst of fast clicks the popup's
  step count can lag by a few seconds.
- A transcription that runs longer than Chrome keeps the extension's worker alive (roughly half a
  minute with the popup closed) is dropped; the zip is sealed without it and `transcribe` fills it in.
- There is no preview of the camera while recording.

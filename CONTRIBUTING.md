# Contributing to VibeTake

Thank you for looking under the hood. VibeTake is early and small, so the bar is low and the
feedback loop is short.

## Build and test

```bash
npm install
npx playwright install chromium      # for the live tests
npm run build                        # the CLI, into dist/
npm run build:extension              # the extension, into extension/dist/
npm test                             # unit tests (vitest); also typechecks the CLI
npm run typecheck                    # the CLI and the extension
npm run test:live                    # a real Chromium with the extension against the local fixture
```

`dist/src/` and `extension/dist/` are committed so that people can install without building. Any
change under `src/` or `extension/` must come with a rebuild of both (`npm run build && npm run
build:extension`) committed alongside it, or the shipped build drifts from the source.

The live tests build the extension themselves and need no network beyond the loopback interface;
the transcription provider is always a local fake (`tests/fake-stt.ts`). Nothing in the suite spends
money or leaves the machine.

## How the code is laid out

- `extension/src/` — the Chrome extension: `content.ts` and `capture.ts` watch the page,
  `sw.ts` owns the recording state, `offscreen.ts` records media, `popup.ts` and `options.ts` are the UI.
- `src/serve/` — the local service that holds the transcription key (`npm run serve`).
- `src/transcribe/` — the provider client and the transcript.
- `src/capture/` — the recording's format (`bundle.json`) and the zip.
- `prompts/` — the prompts that turn a recording into a video.

## Pull requests

- One change per pull request, with a test that would fail without it. The live suite is the right
  place for anything a person would notice in the browser.
- Keep messages to a person in plain words, as sentences; the existing copy is the pattern.
- Nothing may write outside the repository except `config/` and the zips a person exports, and
  nothing may send anything off the machine except the voice track to the provider the person chose.
- Commit subjects follow `type(scope): what changed`, for example `fix(extension): …`.
- Sign your commits off (`git commit -s`) to certify the Developer Certificate of Origin
  (https://developercertificate.org): you wrote the change or have the right to submit it under
  this project's licence.

## Reporting a bug

Open an issue with what you did, what you expected, what happened, and the `bundle.json` of the
recording if there is one (it holds no media and no secrets; check the `title` and `start_url` are
things you are happy to share).

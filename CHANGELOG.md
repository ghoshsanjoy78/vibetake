# Changelog

## 1.0.0 (2026-10-05)

First public release.

- A Chrome extension that records a demonstration: the steps (every click with its control's name,
  role and rectangle), the screen, the voice, optionally the camera, and a pointer-free still at
  every click and once the page has reacted; one zip on Export. A click on something that is not
  a control is recorded where it landed, with its own still. The pointer path is thinned and kept
  in its own file, `pointer.json`, so `bundle.json` stays small enough to hand to an AI whole.
- Transcription at Stop through a local service (`npm run serve`) that holds an OpenAI or
  OpenRouter key; the extension pairs with it by itself. `vibetake transcribe <recording.zip>` adds
  a transcript to a zip exported without one, and Export tries again by itself once the service is up.
- Two prompts for turning a recording into a polished video: faceless, and with the presenter's
  own voice and face.

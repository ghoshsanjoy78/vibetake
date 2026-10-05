# Prompt: a faceless demo video from a VibeTake recording

For a video with no one on camera. Give the AI `bundle.json`, `transcript.json`, the `frames/` folder and the scenario file. Not `screen.webm`, not `voice.webm`, not `camera.webm`. Fill the brackets, then paste. (For a video with your face in it, use `demo-video-with-face.md`.)

---

Build a polished product demo from stills, a step log and a transcript. There is no video to read: every scene is a still frame brought to life with camera moves, a cursor, captions and voiceover. Show only what the frames show; say only what the transcript supports.

**Product:** [ComicInk, an AI comic book creator]. **Audience:** [new users]. **Length:** [60–90 s]. **Voice:** [calm, second person]. **Output:** 1920×1080, 30 fps MP4, synthesized voiceover, burned-in captions.

## The files

All times are milliseconds on one clock starting at `bundle.json.started_at`.

- `frames/<time>-step<nn>-<action|settled>.jpg`: the screen at the instant of each click (`action`) and once the page had reacted (`settled`), plus `start` and `stop`. The file name is the time. These are your footage. They are 2× the viewport, so a 2× punch-in is still full resolution.
- `bundle.json`: `steps[]` is every action — `do`/`target` (what was clicked or typed), `at_ms`, `settled_at_ms`, `click.x`/`y` (the click) and `click.box` (the clicked control's rectangle: top-left at `box.x`,`box.y`, bottom-right at `box.x+box.width`,`box.y+box.height`), both in viewport pixels at the moment of the click; multiply by `screen.width / viewport.width` (2 here) for frame pixels, and `await` (the first new control after the action, proof it worked). `dropped[]` is clicks on things that are not controls (plain text, canvas, the page background); each has `x`/`y` where it landed and a `frames/<time>-dropped.jpg` still of that moment, but no `target` or `box`.
- `pointer.json` (optional, do not read unless you need it): the raw cursor path, `t`/`x`/`y`, thinned to its corners and pauses. Context only; see Cursor.
- `transcript.json`: `text` (the narration, punctuated), `words[]` with times, `steps[]` sliced per step (split at clicks, so take sentence boundaries from `text`).
- `../<scenario>.json`: the clean step list with a note per step; use it as the chapter list.

## Do this

1. **Script.** Rewrite `text` into a tight voiceover: cut filler, repetition and mouse narration; keep the structure and claims; ~150 words per minute, within the length. Table: scene, step, line, caption (3–8 words).
2. **Scenes.** One scene per step that the script needs, plus an opening on the `start` frame. A scene is the `action` frame, then a cut or crossfade to the `settled` frame once the "click" lands. Hold each still only as long as its line needs; a scene with no line is a 1-second beat or is dropped. Merge steps that say the same thing. The long generation wait at the end is the `stop` frame with a short time-lapse feel (a progress caption), 2–3 s.
3. **Camera and framing.** Treat every still as one layer under one continuous virtual camera. Fix the framing once: the stills are all the same size, so compute one scale and offset that makes a still cover the 1920×1080 frame (crop a little off the top and bottom; never letterbox, never black bars at the sides) and apply it to every still identically. Slow drift on every still so nothing is static. Where a line points at something, punch in 1.6–2× on `click.box` over 300–500 ms, ease in and out, hold, ease out on the `settled` frame. Not on every click. Motion blur on moves only.
4. **Continuity.** The camera never resets at a cut. The scale and position on the last frame of one still are the scale and position on the first frame of the next, whether the cut is action to settled or scene to scene; swap the image under the held camera (a hard cut, or a 150–250 ms crossfade), and only then, if the next line needs it, start the next move. Never zoom out and back in across a cut, never make a scale change smaller than 5% (it reads as a jerk, not a move), and hold at least 500 ms between moves. Before delivering, step through every cut frame by frame: the page's edges must sit in the same place on both sides of it.
5. **Cursor.** Draw a synthetic cursor; never replay the raw `pointer.json` path, which is jittery and wanders. Show the cursor only when it has a job: for each click, fade it in where it was last seen (or just off-screen), move it to `click.x`/`y` along one smooth eased curve over 400–700 ms, arrive a beat before the click, ripple, then fade it out within about half a second of the result appearing. Between clicks, and whenever the narration is about the screen rather than an action, the cursor is hidden. No hovering, hesitation, or back-and-forth. Use `pointer.json` only to decide where the cursor should come from, never as the path.
6. **Outline.** As the cursor arrives, draw a red outline (2–3 px, 4 px outside `click.box`, slightly rounded) around the clicked control on the `action` frame; hold it through the click and the cut to the `settled` frame, then fade it with the cursor. One outline at a time, only on clicks the script mentions, never on `dropped[]` clicks (they have a point and a still, but no box: show the cursor arriving there, no outline).
7. **Captions**, one at a time, lower third. **Intro** title card (2–3 s) and **outro** with the URL (3 s). Quiet music bed at most.
8. **Voiceover.** One synthesized voice; the line sets the scene's length, never the reverse; 300–500 ms between lines; −16 LUFS.
9. **Check.** No cut moves the page's edges; Every line true of the frame it plays over; every step in order; within length; blur anything private in a frame.

Deliver the script table, a scene table (scene, frames used, duration, zoom target, cursor path span, caption, line, transition), and the video.

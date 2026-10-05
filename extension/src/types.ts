// Types shared by every part of the extension. No runtime code: the classic content scripts cannot
// import, so they reach these through `import("./types.js")` in globals.d.ts.

export type Target = { label: string; role: string; nth: number };
export type AwaitTarget = { label: string; role: string };
export type Shaped = { do: "click" | "type" | "select"; target: Target; value: string | null };

// What one DOM event becomes. `ignored` is silence by design (a click into a text field, whose value
// arrives later as a change). `dropped` is an action the person performed that the scenario will be
// missing, and is shown to them.
export type ShapeResult =
  | { kind: "step"; step: Shaped }
  | { kind: "dropped"; reason: string }
  | { kind: "ignored" };

// Where a click landed, in client pixels of the recorded viewport, and the control it was shaped from.
export type ClickGeometry = {
  x: number; y: number;
  box: { x: number; y: number; width: number; height: number };
  scroll: { x: number; y: number };
};
// One pointer position; `t` is on the recording's clock.
export type PointerSample = { t: number; x: number; y: number };
export type Viewport = { width: number; height: number; device_pixel_ratio: number };

export type Capture = {
  roleSelector(role: string, label: string | null): string;
  describe(element: Element): Target | null;
  shapeClick(path: EventTarget[]): ShapeResult;
  shapeChange(path: EventTarget[]): ShapeResult;
  shapeSubmit(submitter: Element | null): ShapeResult;
  // Keys of every visible, enabled, named control on the page right now, in document order.
  controlKeys(): string[];
  // The first control (document order) whose key is not in `before`: what the last step caused.
  firstNewControl(before: string[]): AwaitTarget | null;
  // Where a click landed and the box of the control shapeClick would pick for this path; null when
  // shapeClick would not make a step of it.
  clickGeometry(path: EventTarget[], x: number, y: number): ClickGeometry | null;
};

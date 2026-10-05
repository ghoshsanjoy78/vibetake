// Ambient declarations for the content-script world. Content scripts are classic scripts: they cannot
// import, so they share these globals instead. Keep this file free of top-level import/export, or it
// stops being ambient.

type Target = import("./types.js").Target;
type AwaitTarget = import("./types.js").AwaitTarget;
type ClickGeometry = import("./types.js").ClickGeometry;
type Viewport = import("./types.js").Viewport;
type ShapeResult = import("./types.js").ShapeResult;
type Capture = import("./types.js").Capture;
type TrackName = import("./recorder.js").TrackName;
// vendor/fflate.js (UMD) installs the library on the offscreen page's global.
declare var fflate: typeof import("fflate");

// The slice of Playwright's InjectedScript the extension calls. The object is Playwright's own; only
// this description of it is ours.
interface PlaywrightInjected {
  utils: {
    getAriaRole(element: Element): string | null;
    getElementAccessibleNameText(element: Element, includeHidden: boolean): string;
    isElementVisible(element: Element): boolean;
    normalizeWhiteSpace(text: string): string;
  };
  parseSelector(selector: string): unknown;
  querySelectorAll(selector: unknown, root: Node): Element[];
}

declare var __vibetakeInjected: PlaywrightInjected;
declare var __vibetakeNaming: string;
declare var __vibetakeCapture: Capture;
declare var __vibetakeListening: boolean | undefined;

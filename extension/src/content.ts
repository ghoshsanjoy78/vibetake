// Listens in the recorded page and reports what it hears. Holds nothing that must outlive the page:
// the service worker owns the recording, so a navigation costs only a re-injection.
(() => {
  // Injected on every Record and after every navigation: one set of listeners per document.
  if (globalThis.__vibetakeListening) return;
  globalThis.__vibetakeListening = true;

  const capture = __vibetakeCapture;
  // The timeout import gives an await. Anything that appears later would fail replay anyway.
  const AWAIT_WINDOW_MS = 10000;
  const LOOK_EVERY_MS = 100;
  // "Settled": the page has been quiet this long after a step, or this much time has passed anyway.
  const SETTLE_QUIET_MS = 300;
  const SETTLE_CAP_MS = 3000;
  // The pointer trail: at most one sample per 50 ms, sent once a second.
  const POINTER_EVERY_MS = 50;
  const POINTER_FLUSH_MS = 1000;
  const RESIZE_DEBOUNCE_MS = 250;

  type Reply = { recording: boolean; before?: string[] | null } | undefined;

  let active = true;
  let reported = false;
  // Ends the current watch for an await; `true` looks one last time first.
  let endWatch: (lookFirst: boolean) => void = () => {};
  // Ends the current wait for the page to settle; `true` reports it settled now.
  let endSettle: (settleNow: boolean) => void = () => {};

  const viewport = (): Viewport =>
    ({ width: window.innerWidth, height: window.innerHeight, device_pixel_ratio: window.devicePixelRatio });

  const send = async (message: object): Promise<Reply> => {
    try { return (await chrome.runtime.sendMessage(message)) as Reply; }
    catch { return undefined; }   // the extension was reloaded or removed: nobody is listening
  };

  // Told in so many words that this tab is not being recorded: stop. An error is not that — a
  // worker that is briefly unreachable must not silence a recording that is still on.
  const heard = (reply: Reply): void => { if (reply?.recording === false) stop(); };

  const observe = (observer: MutationObserver): void =>
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

  // Watches for the first control that was not there when the step was captured: its await.
  const watch = (before: string[]): void => {
    endWatch(false);
    let timer: number | undefined;
    const look = (): void => {
      timer = undefined;
      const target = capture.firstNewControl(before);
      if (!target) return;
      end(false);
      void send({ type: "await", target }).then(heard);
    };
    // Throttled, not debounced: a page that never stops mutating must still be looked at.
    const observer = new MutationObserver(() => { timer ??= setTimeout(look, LOOK_EVERY_MS); });
    const cutoff = setTimeout(() => end(false), AWAIT_WINDOW_MS);
    const end = (lookFirst: boolean): void => {
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(cutoff);
      endWatch = () => {};
      if (lookFirst) look();
    };
    endWatch = end;
    observe(observer);
    timer = setTimeout(look, LOOK_EVERY_MS);
  };

  // Waits for the page to come to rest after a step — the frame a viewer sees before the next action.
  // Debounced on mutations, capped so a page that never rests still settles.
  const waitToSettle = (): void => {
    endSettle(false);
    let quiet: number | undefined;
    const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(() => end(true), SETTLE_QUIET_MS); });
    const cap = setTimeout(() => end(true), SETTLE_CAP_MS);
    const end = (settleNow: boolean): void => {
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(cap);
      endSettle = () => {};
      if (settleNow) void send({ type: "settled", at: Date.now() }).then(heard);
    };
    endSettle = end;
    observe(observer);
    quiet = setTimeout(() => end(true), SETTLE_QUIET_MS);
  };

  const report = (result: ShapeResult, click: ClickGeometry | null = null, point: { x: number; y: number } | null = null): void => {
    if (!active || result.kind === "ignored") return;
    const at = Date.now();   // the page's clock, before anything below takes time
    if (result.kind === "dropped") {
      // A click that no control claims is still a thing the person did at a place and a time: the
      // place goes with it, so a video can still show where, if not what.
      void send({ type: "dropped", reason: result.reason, at, point }).then(heard);
      return;
    }
    // Whatever appeared since the previous step is what that step caused: settle it before taking
    // this step's own baseline, so the await and settled messages precede the step message.
    endWatch(true);
    endSettle(true);
    reported = true;
    flushPointer();
    const before = capture.controlKeys();
    void send({ type: "step", step: result.step, before, url: location.href, click, at }).then(heard);
    watch(before);
    waitToSettle();
  };

  const onClick = (e: Event): void => {
    const path = e.composedPath();
    const result = capture.shapeClick(path);
    const mouse = e as MouseEvent;
    let click = result.kind === "step" ? capture.clickGeometry(path, Math.round(mouse.clientX), Math.round(mouse.clientY)) : null;
    // A click from the keyboard (Enter or Space; detail is 0 and the point is (0,0)) landed nowhere a
    // viewer could see: record the centre of the control instead.
    if (click && mouse.detail === 0)
      click = { ...click, x: Math.round(click.box.x + click.box.width / 2), y: Math.round(click.box.y + click.box.height / 2) };
    report(result, click, mouse.detail === 0 ? null : { x: Math.round(mouse.clientX), y: Math.round(mouse.clientY) });
  };
  const onChange = (e: Event): void => report(capture.shapeChange(e.composedPath()));
  const onSubmit = (e: Event): void => report(capture.shapeSubmit((e as SubmitEvent).submitter));

  // `change` does not cross a shadow boundary, so a field inside a web component is never heard at
  // the window. `input` does cross it: the first keystroke in such a field is the moment to listen
  // on the field itself.
  const wired = new WeakSet<EventTarget>();
  const onInput = (e: Event): void => {
    const field = e.composedPath()[0];
    if (!(field instanceof Node) || field.getRootNode() === document || wired.has(field)) return;
    wired.add(field);
    field.addEventListener("change", onChange);
  };

  // The pointer trail, in client pixels with epoch times; batched so a moving pointer costs one
  // message a second, not twenty.
  let samples: { at: number; x: number; y: number }[] = [];
  let lastSample = 0;
  const onPointerMove = (e: Event): void => {
    const now = Date.now();
    if (now - lastSample < POINTER_EVERY_MS) return;
    lastSample = now;
    const mouse = e as PointerEvent;
    samples.push({ at: now, x: Math.round(mouse.clientX), y: Math.round(mouse.clientY) });
  };
  const flushPointer = (): void => {
    if (!active || samples.length === 0) return;
    const batch = samples;
    samples = [];
    void send({ type: "pointer", samples: batch }).then(heard);
  };
  const flusher = setInterval(flushPointer, POINTER_FLUSH_MS);

  let resizeTimer: number | undefined;
  const onResize = (): void => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (active) void send({ type: "viewport", viewport: viewport() }).then(heard); }, RESIZE_DEBOUNCE_MS);
  };

  const stop = (): void => {
    if (!active) return;
    flushPointer();
    active = false;
    endWatch(false);
    endSettle(false);
    clearInterval(flusher);
    clearTimeout(resizeTimer);
    removeEventListener("click", onClick, true);
    removeEventListener("change", onChange, true);
    removeEventListener("input", onInput, true);
    removeEventListener("submit", onSubmit, true);
    removeEventListener("pointermove", onPointerMove, true);
    removeEventListener("resize", onResize);
    removeEventListener("pagehide", flushPointer);
    globalThis.__vibetakeListening = false;
  };

  addEventListener("click", onClick, true);
  addEventListener("change", onChange, true);
  addEventListener("input", onInput, true);
  addEventListener("submit", onSubmit, true);
  addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
  addEventListener("resize", onResize);
  addEventListener("pagehide", flushPointer);   // best effort before a navigation takes the page
  chrome.runtime.onMessage.addListener((message: { type?: string }) => {
    if (message?.type === "stop") stop();
  });

  // Announce, and learn whether a step on the previous page is still waiting for what it caused.
  void send({ type: "hello", naming: __vibetakeNaming, viewport: viewport() }).then(reply => {
    if (reply?.recording === false) { stop(); return; }
    if (reply?.before && !reported) { watch(reply.before); waitToSettle(); }
  });
})();

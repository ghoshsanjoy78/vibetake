"use strict";
// Turns DOM events into steps. A pure function of the DOM: no chrome.* calls, no state, so it can be
// loaded into any page and tested there. Every role, name and ordinal comes from Playwright's
// injected script (vendor/playwright-injected.js); nothing here computes one.
(() => {
    const injected = __vibetakeInjected;
    // The engine's own rule (it also strips U+200B and U+00AD), so a captured label is exactly what
    // the role engine compares against.
    const normalize = (text) => injected.utils.normalizeWhiteSpace(text);
    // The selector page.getByRole(role, { name, exact: true, disabled: false }) builds, character for
    // character (Playwright's escapeForAttributeSelector with exact = true). The live tests pin it
    // against Playwright's own. With no label it lists every enabled element of the role.
    const roleSelector = (role, label) => {
        const name = label === null ? "" : `[name="${label.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"s]`;
        return `internal:role=${role}[disabled=false]${name}`;
    };
    const query = (selector) => injected.querySelectorAll(injected.parseSelector(selector), document);
    // nth is not computed: it is the element's position in the result of the query replay will run, so
    // the two cannot disagree. 0 means the query does not return the element — it is disabled, hidden
    // from assistive technology, or nameless.
    const see = (element) => {
        const role = injected.utils.getAriaRole(element);
        if (!role)
            return { role: null, label: "", nth: 0 };
        const label = normalize(injected.utils.getElementAccessibleNameText(element, false));
        if (label === "")
            return { role, label, nth: 0 };
        return { role, label, nth: query(roleSelector(role, label)).indexOf(element) + 1 };
    };
    const describe = (element) => {
        const seen = see(element);
        return seen.role !== null && seen.nth > 0 ? { label: seen.label, role: seen.role, nth: seen.nth } : null;
    };
    // --- shaping ---------------------------------------------------------------------------------
    const IGNORED = { kind: "ignored" };
    const dropped = (reason) => ({ kind: "dropped", reason });
    const step = (verb, target, value) => ({ kind: "step", step: { do: verb, target, value } });
    // Never captured, decided on the input's type and never its role.
    const NEVER = new Set(["password", "file", "hidden"]);
    // Captured once, as the click that toggled them; their change would be a second, meaningless step.
    const TOGGLES = new Set(["checkbox", "radio"]);
    // Inputs that are buttons: clicks, never values.
    const PUSHES = new Set(["button", "submit", "reset", "image"]);
    // Roles a click is a step on. Anything else under the pointer is walked past.
    const CLICK_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem",
        "menuitemcheckbox", "menuitemradio", "option", "combobox", "treeitem"]);
    // Roles that count as "a control appeared": what an await may wait for.
    const CONTROL_ROLES = [...CLICK_ROLES, "textbox", "searchbox", "spinbutton", "slider"];
    const inputType = (element) => element.localName === "input" ? element.type : null;
    // An element whose committed value arrives as a change. A click on one is how a person starts
    // typing or opens a picker, not a step.
    const takesValue = (element) => {
        if (element.localName === "textarea" || element.localName === "select")
            return true;
        const type = inputType(element);
        return type !== null && !TOGGLES.has(type) && !PUSHES.has(type);
    };
    const elementsOf = (path) => path.filter((node) => node.nodeType === Node.ELEMENT_NODE);
    // Walks outward from the event target (composedPath crosses open shadow roots; closest() does
    // not) to the first thing a click is a step on. Stops at a value control: a click on one is how a
    // person starts typing or opens a picker, and its committed value arrives as a change.
    const walk = (path) => {
        for (const element of elementsOf(path)) {
            // An option belongs to its select, whose committed value arrives as a change; a custom
            // role="option" outside a select is not an <option> and still falls through to a step.
            if (element.localName === "option" || element.localName === "optgroup")
                return { kind: "value" };
            const type = inputType(element);
            if ((type !== null && NEVER.has(type)) || takesValue(element))
                return { kind: "value" };
            const role = injected.utils.getAriaRole(element);
            if (role !== null && CLICK_ROLES.has(role))
                return { kind: "control", element, role };
        }
        return { kind: "none" };
    };
    const shapeClick = (path) => {
        const found = walk(path);
        if (found.kind === "value")
            return IGNORED;
        if (found.kind === "none") {
            // A click on a label is followed by the browser's own click on the label's control, and that
            // one is captured; this one is silence, not a loss.
            if (elementsOf(path).some(element => element.localName === "label" && element.control !== null))
                return IGNORED;
            return dropped("A click on something with no button, link or other control under it was not captured.");
        }
        const { element, role } = found;
        const seen = see(element);
        if (seen.label === "")
            return dropped(`A click on a ${role} with no accessible name was not captured.`);
        if (seen.nth === 0)
            return dropped(`A click on the ${role} "${seen.label}" was not captured: it is disabled or hidden from assistive technology.`);
        return step("click", { label: seen.label, role, nth: seen.nth }, null);
    };
    // Where the click landed and the box of the control shapeClick picks for this path, in client
    // pixels, with the scroll offset so the control can be placed after the page scrolled.
    const clickGeometry = (path, x, y) => {
        const found = walk(path);
        if (found.kind !== "control")
            return null;
        const rect = found.element.getBoundingClientRect();
        return {
            x, y,
            box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
            scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
        };
    };
    const shapeChange = (path) => {
        const element = elementsOf(path)[0];
        if (!element)
            return IGNORED;
        const tag = element.localName;
        if (tag !== "input" && tag !== "textarea" && tag !== "select")
            return IGNORED;
        const type = inputType(element);
        if (type === "hidden")
            return IGNORED;
        // An autocomplete of *password* marks a secret whatever the type is now: a show-password toggle
        // turns type into "text" before change fires. Attributes only, never role.
        const secret = type === "password" || (tag === "input" && (element.getAttribute("autocomplete") ?? "").includes("password"));
        if (secret || type === "file") {
            const named = see(element);
            const what = secret ? "password" : "file";
            const where = named.role !== null && named.label !== "" ? `"${named.label}"` : `a ${what} field`;
            return dropped(secret
                ? `A password entered in ${where} was not captured: a scenario never holds one.`
                : `A file chosen in ${where} was not captured: a scenario cannot carry a file.`);
        }
        if (type !== null && (TOGGLES.has(type) || PUSHES.has(type)))
            return IGNORED;
        const seen = see(element);
        if (seen.role === null || seen.label === "")
            return dropped("A value entered in a field with no accessible name was not captured.");
        if (seen.nth === 0)
            return dropped(`A value entered in "${seen.label}" was not captured: the field is disabled or hidden from assistive technology.`);
        const target = { label: seen.label, role: seen.role, nth: seen.nth };
        if (tag === "select") {
            const select = element;
            if (select.multiple)
                return dropped(`A choice in the multi-select "${seen.label}" was not captured: a step holds one value.`);
            const option = select.selectedOptions[0];
            if (!option)
                return dropped(`A change to "${seen.label}" left nothing selected and was not captured.`);
            // option.label is what the person saw and what locator.selectOption({ label }) matches on.
            return step("select", target, option.label);
        }
        return step("type", target, element.value);
    };
    // Enter in a form with a submit button needs nothing here: the browser itself clicks that button,
    // and the click is captured. With no button there is nothing a step could click.
    const shapeSubmit = (submitter) => submitter !== null ? IGNORED
        : dropped("A form was submitted from the keyboard and has no button to click, so replay cannot repeat it.");
    // --- what a step caused ------------------------------------------------------------------------
    const keyOf = (role, label) => `${role}\n${label}`;
    // Every control replay's await could wait for: enabled (the query), visible (what
    // locator.waitFor({ state: "visible" }) checks), named. Document order across roles.
    const controls = () => {
        const found = [];
        for (const role of CONTROL_ROLES) {
            for (const element of query(roleSelector(role, null))) {
                if (!injected.utils.isElementVisible(element))
                    continue;
                const label = normalize(injected.utils.getElementAccessibleNameText(element, false));
                if (label !== "")
                    found.push({ element, role, label });
            }
        }
        // Queried one role at a time; put them back in document order. (Across shadow trees the order
        // is the browser's choice, which is good enough for "first".)
        found.sort((a, b) => a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
        return found.map(f => ({ key: keyOf(f.role, f.label), target: { label: f.label, role: f.role } }));
    };
    const controlKeys = () => controls().map(c => c.key);
    const firstNewControl = (before) => {
        const known = new Set(before);
        return controls().find(c => !known.has(c.key))?.target ?? null;
    };
    globalThis.__vibetakeCapture =
        { roleSelector, describe, shapeClick, shapeChange, shapeSubmit, controlKeys, firstNewControl, clickGeometry };
})();

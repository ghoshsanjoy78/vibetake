import { z } from "zod";
import { FormatError } from "../errors.js";
// The bundle formats this build reads: 1 (steps only, a .json) and 2 (with media, a .zip). The
// extension updates independently of the app, and this is the number that catches the skew.
export const BUNDLE_FORMATS = [1, 2];
// Judged before the shape, for the same reason as refuseUnknownFormat in src/store/types.ts: a
// future format may also have changed shape, and the message must say "wrong version".
export const refuseUnknownBundleFormat = (raw) => {
    if (raw === null || typeof raw !== "object" || !("bundle_format" in raw))
        return;
    const { bundle_format } = raw;
    if (typeof bundle_format === "number" && !BUNDLE_FORMATS.includes(bundle_format))
        throw new FormatError(`This recording is bundle format ${bundle_format}; this version of VibeTake reads bundle formats 1 and 2.`);
};
const VERBS = ["click", "type", "select"];
const TargetSchema = z.object({
    label: z.string().min(1), role: z.string().min(1), nth: z.number().int().min(1),
});
const StepSchema = z.object({
    do: z.enum(VERBS, {
        error: (issue) => `"${String(issue.input)}" is not an action this version of VibeTake knows `
            + `(it knows ${VERBS.join(", ")}).`,
    }),
    target: TargetSchema,
    value: z.string().nullable(),
    await: z.object({ label: z.string().min(1), role: z.string().min(1) }).nullable(),
    at_ms: z.number().min(0),
    url: z.string(),
});
const Common = {
    id: z.string().min(1),
    naming: z.string().nullable(),
    started_at: z.string(),
    sealed_at: z.string(),
    start_url: z.string().url(),
    title: z.string(),
    complete: z.boolean(),
    incomplete_reason: z.string().nullable(),
    // x/y: where a dropped click landed, in viewport pixels; null when the drop was not a click.
    dropped: z.array(z.object({ at_ms: z.number().min(0), reason: z.string(), x: z.number().nullable().default(null), y: z.number().nullable().default(null) })),
};
export const BundleV1Schema = z.object({
    ...Common,
    bundle_format: z.literal(1),
    video: z.null(),
    steps: z.array(StepSchema),
    beats: z.array(z.object({ kind: z.literal("navigation"), at_ms: z.number().min(0), url: z.string() })),
});
const BoxSchema = z.object({ x: z.number(), y: z.number(), width: z.number().min(0), height: z.number().min(0) });
const ClickSchema = z.object({ x: z.number(), y: z.number(), box: BoxSchema, scroll: z.object({ x: z.number(), y: z.number() }) });
const ViewportSchema = z.object({ width: z.number().int().min(1), height: z.number().int().min(1), device_pixel_ratio: z.number().positive() });
const TrackSchema = z.object({
    file: z.string().min(1), offset_ms: z.number().min(0), duration_ms: z.number().min(0).nullable(),
    width: z.number().int().min(1).nullable(), height: z.number().int().min(1).nullable(),
});
// A frame is either a file or a reason it is missing — never neither, never both.
const FrameSchema = z.object({
    step: z.number().int().min(1).nullable(),
    moment: z.enum(["start", "stop", "action", "settled", "dropped"]),
    at_ms: z.number().min(0),
    file: z.string().min(1).nullable(),
    reason: z.string().nullable(),
}).refine(f => (f.file === null) !== (f.reason === null), { message: "A frame needs a file or a reason, not both and not neither." });
// What the extension did about the narration at Stop. A bundle from
// a build that never attempted one reads as "not attempted".
export const TranscriptNoteSchema = z.object({
    status: z.string().regex(/^(written|unavailable: \S.*)$/, { message: 'status is "written" or "unavailable: <reason>"' }),
    file: z.string().min(1).nullable(),
    markdown: z.string().min(1).nullable(),
    words: z.number().int().min(0),
}).refine(t => (t.status === "written" && t.file !== null && t.markdown !== null) || (t.status !== "written" && t.file === null && t.markdown === null), { message: "A written transcript names its files; an unavailable one names none." });
export const NOT_ATTEMPTED = { status: "unavailable: not attempted", file: null, markdown: null, words: 0 };
export const BundleV2Schema = z.object({
    ...Common,
    bundle_format: z.literal(2),
    viewport: ViewportSchema.nullable(),
    window_resized: z.boolean(),
    screen: TrackSchema.nullable(),
    voice: TrackSchema.nullable(),
    // The camera is optional and arrived after format 2 shipped: a bundle without it reads as not requested.
    camera: TrackSchema.nullable().default(null),
    media: z.object({ screen: z.string(), voice: z.string(), camera: z.string().default("not requested") }),
    steps: z.array(StepSchema.extend({ click: ClickSchema.nullable(), settled_at_ms: z.number().min(0).nullable() })),
    // The pointer trail travels as its own file (`pointer_file`) and `pointer` is then empty; a bundle
    // from before that carries the samples inline and no file.
    pointer: z.array(z.object({ t: z.number().min(0), x: z.number(), y: z.number() })).default([]),
    pointer_file: z.string().min(1).nullable().default(null),
    frames: z.array(FrameSchema),
    transcript: TranscriptNoteSchema.default(NOT_ATTEMPTED),
    beats: z.array(z.union([
        z.object({ kind: z.literal("navigation"), at_ms: z.number().min(0), url: z.string() }),
        z.object({ kind: z.literal("viewport"), at_ms: z.number().min(0), width: z.number().int().min(1), height: z.number().int().min(1), device_pixel_ratio: z.number().positive() }),
    ])),
});
export const isV2 = (bundle) => bundle.bundle_format === 2;
// "steps.0.do" -> "step 1 (do)", "frames.1.file" -> "frame 2 (file)": a sentence about the file.
const describePath = (path) => {
    const noun = path[0] === "steps" ? "step" : path[0] === "frames" ? "frame" : null;
    if (noun && typeof path[1] === "number") {
        const rest = path.slice(2).map(String).join(".");
        return rest ? `${noun} ${path[1] + 1} (${rest})` : `${noun} ${path[1] + 1}`;
    }
    return path.map(String).join(".");
};
export const parseBundle = (raw) => {
    refuseUnknownBundleFormat(raw);
    const format = raw?.bundle_format;
    const result = format === 2 ? BundleV2Schema.safeParse(raw) : BundleV1Schema.safeParse(raw);
    if (!result.success) {
        const first = result.error.issues[0];
        const where = first.path.length ? `${describePath(first.path)}: ` : "";
        throw new FormatError(`This recording cannot be read. ${where}${first.message}`);
    }
    return result.data;
};
// A step as a person would say it: the note a transcript's Markdown heads its blocks with.
export const noteFor = (step) => {
    switch (step.do) {
        case "click": return `Click ${step.target.label}`;
        case "type": return step.value === "" ? `Clear ${step.target.label}` : `Type "${step.value}" into ${step.target.label}`;
        case "select": return `Select "${step.value}" in ${step.target.label}`;
    }
};

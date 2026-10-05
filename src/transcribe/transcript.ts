import { z } from "zod";
import { FormatError } from "../errors.js";

// The transcript's format version; checked on read, refused when unknown, like every other file here.
export const TRANSCRIPT_FORMAT = 1;

export const refuseUnknownTranscriptFormat = (raw: unknown): void => {
  if (raw === null || typeof raw !== "object" || !("transcript_format" in raw)) return;
  const { transcript_format } = raw as { transcript_format: unknown };
  if (typeof transcript_format === "number" && transcript_format !== TRANSCRIPT_FORMAT)
    throw new FormatError(`This transcript is transcript format ${transcript_format}; this version of VibeTake reads transcript format ${TRANSCRIPT_FORMAT}.`);
};

export const TranscriptSchema = z.object({
  transcript_format: z.literal(TRANSCRIPT_FORMAT),
  provider: z.enum(["openai", "openrouter"]),
  model: z.string().min(1),
  language: z.string().nullable(),
  transcribed_at: z.string(),
  voice_offset_ms: z.number().min(0),
  voice_end_ms: z.number().min(0),
  text: z.string(),
  words: z.array(z.object({ word: z.string(), start_ms: z.number().min(0), end_ms: z.number().min(0) })),
  steps: z.array(z.object({ n: z.number().int().min(0), from_ms: z.number().min(0), to_ms: z.number().min(0), said: z.string() })),
  clamped: z.number().int().min(0),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

export const parseTranscript = (raw: unknown): Transcript => {
  refuseUnknownTranscriptFormat(raw);
  const result = TranscriptSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0]!;
    const where = first.path.length ? `${first.path.map(String).join(".")}: ` : "";
    throw new FormatError(`This transcript cannot be read. ${where}${first.message}`);
  }
  return result.data;
};

export const clock = (ms: number): string => {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// The same content for a person: one block per step, headed by the step's time and note, so the
// narration can be read against the steps without a tool. `notes[i]` is step i+1's note.
export const renderMarkdown = (t: Transcript, notes: string[]): string => {
  const blocks = t.steps.map(step => {
    const heading = step.n === 0
      ? `## ${clock(step.from_ms)} · Before the first step`
      : `## ${clock(step.from_ms)} · Step ${step.n} — ${notes[step.n - 1] ?? ""}`.trimEnd();
    return `${heading}\n${step.said === "" ? "_(nothing said)_" : step.said}`;
  });
  return [`# Narration — transcribed by ${t.provider} (${t.model})`, "", ...blocks.flatMap(b => [b, ""])].join("\n");
};

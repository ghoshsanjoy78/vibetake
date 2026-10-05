import type { BundleV2 } from "../capture/bundle.js";
import { alignWords } from "./align.js";
import type { ProviderChoice } from "./env.js";
import { transcribeAudio, type ProviderDeps } from "./provider.js";
import { attachPunctuation } from "./punctuate.js";
import { clock, renderMarkdown, TRANSCRIPT_FORMAT, type Transcript } from "./transcript.js";

// The transcription itself, with no store and no process: a bundle, the voice bytes, the notes the
// Markdown heads its blocks with, one provider call. The CLI (import, transcribe) and the local
// service both run this; only they decide where the two
// files go. Throws TranscriptionError for anything the provider did or did not do.
export type Transcribed = { transcript: Transcript; markdown: string; summary: string[] };

export const transcribeBundle = async (
  bundle: BundleV2, audio: Uint8Array, notes: string[], choice: ProviderChoice, deps?: ProviderDeps,
): Promise<Transcribed> => {
  if (!bundle.voice) throw new Error("transcribeBundle needs a bundle with a voice track; check bundle.voice first.");
  const offset = bundle.voice.offset_ms;
  // The track's end on the recording's clock: its measured length, or the last word if that is unknown.
  const measuredEnd = bundle.voice.duration_ms === null ? null : offset + bundle.voice.duration_ms;
  const result = await transcribeAudio(choice, audio, bundle.voice.file, deps);
  const words = attachPunctuation(result.words, result.text);
  const lastWordEnd = Math.max(0, ...words.map(w => Math.round(w.end * 1000) + offset));
  const voiceEnd = measuredEnd ?? lastWordEnd;
  const aligned = alignWords(words, bundle.steps.map(s => s.at_ms), voiceEnd, offset);
  const transcript: Transcript = {
    transcript_format: TRANSCRIPT_FORMAT, provider: choice.provider, model: choice.model, language: result.language,
    transcribed_at: new Date().toISOString(), voice_offset_ms: offset, voice_end_ms: voiceEnd, text: result.text,
    words: aligned.words, steps: aligned.steps, clamped: aligned.clamped,
  };
  const n = aligned.words.length, s = bundle.steps.length;
  const summary = [`Transcribed ${clock(voiceEnd - offset)} of narration (${choice.provider}, ${choice.model}): ${n} ${n === 1 ? "word" : "words"} across ${s} ${s === 1 ? "step" : "steps"}.`];
  if (bundle.media.voice.startsWith("ended at") || aligned.clamped > 0) {
    const ended = bundle.media.voice.startsWith("ended at") ? `The voice track ${bundle.media.voice}` : "The voice track ended early";
    const past = aligned.clamped > 0 ? `; ${aligned.clamped} ${aligned.clamped === 1 ? "word" : "words"} ran past its end and ${aligned.clamped === 1 ? "was" : "were"} clamped` : "";
    summary.push(`${ended}${past}.`);
  }
  return { transcript, markdown: renderMarkdown(transcript, notes), summary };
};

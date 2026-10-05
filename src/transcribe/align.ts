// Words onto the recording's clock and into one window per step. Pure, and deliberately mechanical:
// a sentence that straddles two clicks is split at the click. The script stage, which has a model,
// is where judgement about which step a sentence was really about belongs; it gets the whole word
// list to re-slice.

export type ProviderWord = { word: string; start: number; end: number };   // seconds, from the voice file's start
export type Word = { word: string; start_ms: number; end_ms: number };      // the recording's clock
export type StepWindow = { n: number; from_ms: number; to_ms: number; said: string };
export type Alignment = { words: Word[]; steps: StepWindow[]; clamped: number };

// Whisper's tokens arrive with leading spaces and attached punctuation; a sentence has neither extra.
export const joinWords = (words: string[]): string => words.join(" ").replace(/\s+/g, " ").trim();

export const alignWords = (words: ProviderWord[], stepTimes: number[], voiceEndMs: number, offsetMs: number): Alignment => {
  let clamped = 0;
  const shifted: Word[] = words.map(w => {
    let start_ms = Math.round(w.start * 1000) + offsetMs;
    let end_ms = Math.round(w.end * 1000) + offsetMs;
    if (end_ms > voiceEndMs) { clamped += 1; end_ms = voiceEndMs; start_ms = Math.min(start_ms, voiceEndMs); }
    return { word: w.word.trim(), start_ms, end_ms };
  });
  // Window n runs from step n's time to step n+1's; window 0 is everything before the first step;
  // the last runs to the end of the voice track. Half-open, so a midpoint on a boundary goes to the
  // later window.
  // A track that ended before the last step leaves that step an empty window at its own time; voice_end_ms (the caller's) stays the truth about the audio.
  const bounds = [0, ...stepTimes, Math.max(voiceEndMs, stepTimes[stepTimes.length - 1] ?? 0)];
  const steps: StepWindow[] = [];
  for (let n = 0; n < bounds.length - 1; n++) {
    const from_ms = bounds[n]!, to_ms = bounds[n + 1]!;
    const inside = shifted.filter(w => {
      const mid = (w.start_ms + w.end_ms) / 2;
      return mid >= from_ms && (mid < to_ms || n === bounds.length - 2);
    });
    steps.push({ n, from_ms, to_ms, said: joinWords(inside.map(w => w.word)) });
  }
  return { words: shifted, steps, clamped };
};

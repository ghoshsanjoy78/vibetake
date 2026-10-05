import type { ProviderChoice } from "./env.js";
import type { ProviderWord } from "./align.js";

// The one module that talks to a paid service. One request shape serves OpenAI and OpenRouter: the
// multipart form their /audio/transcriptions endpoints share. Only the voice track is ever sent.

// The providers' upload cap; about 25 minutes of Opus narration. Splitting longer recordings is a
// known gap, not a silent truncation.
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
// Five minutes per attempt: a 25 MB upload plus whisper processing can take well over a minute, and
// OpenAI's own SDK waits ten. Unverified against the providers' real ceilings.
const TIMEOUT_MS = 300_000;
const RETRY_AFTER_MS = 2_000;   // one retry: on 429 or 5xx, or on a connection that drops before any response

export type ProviderResult = { text: string; language: string | null; words: ProviderWord[] };
export type ProviderDeps = { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; timeoutMs?: number };

export class TranscriptionError extends Error {
  constructor(
    readonly kind: "too-large" | "rejected" | "unreachable" | "timeout" | "no-words" | "bad-response" | "bad-key",
    message: string,
    readonly detail: string | null = null,
  ) { super(message); }
}

const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const headersFor = (choice: ProviderChoice): Record<string, string> => ({
  Authorization: `Bearer ${choice.key}`,
  // OpenRouter's optional attribution; harmless but deliberately not sent elsewhere.
  ...(choice.provider === "openrouter" ? { "HTTP-Referer": "https://github.com/vibetake/vibetake", "X-Title": "VibeTake" } : {}),
});

// The provider's error body, when it has the shape both use: { error: { message } }.
const messageOf = (body: unknown): string | null => {
  const error = (body as { error?: { message?: unknown } } | null)?.error;
  return typeof error?.message === "string" ? error.message : null;
};

export const transcribeAudio = async (
  choice: ProviderChoice, audio: Uint8Array, filename: string, deps: ProviderDeps = {},
): Promise<ProviderResult> => {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  // A provider or proxy that echoes request headers must not be able to put the key in front of the
  // person: every message and detail this module builds goes through here.
  const redact = (text: string): string => text.split(choice.key).join("[key]");
  if (/[^\x21-\x7e]/.test(choice.key))
    throw new TranscriptionError("bad-key", "The API key contains a character that cannot be sent in a header (a space, a line break, or a non-ASCII character such as a smart quote); check how it is set in .env.local or the shell.");
  if (audio.byteLength > MAX_AUDIO_BYTES)
    throw new TranscriptionError("too-large", `The voice track is ${megabytes(audio.byteLength)}; ${choice.provider} accepts at most 25 MB (about 25 minutes). Splitting a long recording is not supported yet.`);

  const url = `${choice.baseUrl}/audio/transcriptions`;
  let host: string;
  try { host = new URL(url).host; } catch { throw new TranscriptionError("rejected", "VIBETAKE_STT_BASE_URL is not a valid URL."); }
  const send = async (): Promise<Response> => {
    // A fresh form per attempt: a consumed body cannot be re-sent.
    const form = new FormData();
    form.append("file", new Blob([audio as BlobPart], { type: "audio/webm" }), filename);
    form.append("model", choice.model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    try {
      return await doFetch(url, { method: "POST", headers: headersFor(choice), body: form, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError" || (error as { name?: string })?.name === "TimeoutError")
        throw new TranscriptionError("timeout", `${choice.provider} did not answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} seconds` : `${timeoutMs} ms`}.`);
      const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
      throw new TranscriptionError("unreachable", redact(`Could not reach ${host} (${error instanceof Error ? error.message : String(error)}${typeof cause === "string" ? `: ${cause}` : ""}).`));
    }
  };

  // Two attempts at most. A connection that drops before any response and a 429/5xx each earn the one
  // retry (a reset after the upload finished may already have been billed, so the retry can bill twice); a timeout does not, since the request
  // may have completed; nor does any other 4xx.
  let attempts = 0;
  const attempt = (): Promise<Response> => { attempts += 1; return send(); };
  let response: Response;
  try {
    response = await attempt();
  } catch (error) {
    if (!(error instanceof TranscriptionError) || error.kind !== "unreachable") throw error;
    await sleep(RETRY_AFTER_MS);
    response = await attempt();
  }
  if (attempts < 2 && (response.status === 429 || response.status >= 500)) {
    await response.body?.cancel().catch(() => undefined);
    await sleep(RETRY_AFTER_MS);
    response = await attempt();
  }
  let text: string;
  try { text = await response.text(); } catch (error) {
    throw new TranscriptionError("unreachable", redact(`Could not read the answer from ${host} (${error instanceof Error ? error.message : String(error)}).`));
  }
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = undefined; }
  const redactOrNull = (t: string | null): string | null => (t === null ? null : redact(t));
  if (!response.ok) {
    throw new TranscriptionError("rejected", `${choice.provider} answered ${response.status} to the transcription request.`, redactOrNull(messageOf(body) ?? (redact(text).slice(0, 200) || null)));
  }
  if (body === null || typeof body !== "object")
    throw new TranscriptionError("bad-response", redact(`${choice.provider} answered with something that is not a transcription.`));
  const got = body as { text?: unknown; language?: unknown; words?: unknown };
  const transcriptText = typeof got.text === "string" ? got.text : "";
  const words = Array.isArray(got.words) ? got.words : null;
  if (words === null)
    throw new TranscriptionError("no-words", redact(`${choice.model} did not return word timestamps; use whisper-1 (openai/whisper-1 on OpenRouter).`));
  const clean: ProviderWord[] = words.flatMap(w => {
    const x = w as { word?: unknown; start?: unknown; end?: unknown };
    return typeof x.word === "string" && typeof x.start === "number" && typeof x.end === "number" ? [{ word: x.word, start: x.start, end: x.end }] : [];
  });
  // Never a transcript with silently dropped speech: a words list with entries that are not
  // {word, start, end} is refused outright, rather than trimmed.
  const bad = words.length - clean.length;
  if (bad !== 0)
    throw new TranscriptionError("bad-response", redact(`${choice.provider} answered with ${bad} word ${bad === 1 ? "entry that is" : "entries that are"} not {word, start, end}.`));
  // Never a transcript with invented times: text without word timestamps is refused.
  if (clean.length === 0 && transcriptText.trim() !== "")
    throw new TranscriptionError("no-words", redact(`${choice.model} did not return word timestamps; use whisper-1 (openai/whisper-1 on OpenRouter).`));
  return { text: transcriptText, language: typeof got.language === "string" ? got.language : null, words: clean };
};

import { createServer } from "node:http";

// A stand-in for OpenAI's and OpenRouter's /audio/transcriptions: records every request and answers
// from a script, in order. Multipart bodies are kept raw; tests assert on their text.
export type FakeResponse = { status: number; body: unknown } | { drop: true };
export type FakeRequest = { method: string; path: string; headers: Record<string, string>; body: string };
export type FakeStt = { url: string; requests: FakeRequest[]; close: () => Promise<void> };

export const startFakeStt = async (responses: FakeResponse[]): Promise<FakeStt> => {
  const requests: FakeRequest[] = [];
  const queue = [...responses];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(",") : (v ?? "");
      requests.push({ method: req.method ?? "", path: req.url ?? "", headers, body: Buffer.concat(chunks).toString("latin1") });
      const next = queue.shift() ?? { status: 500, body: { error: { message: "the fake ran out of scripted responses" } } };
      // A connection that dies before any response — what a transient UND_ERR_SOCKET looks like.
      if ("drop" in next) { req.socket.destroy(); return; }
      res.writeHead(next.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", () => ok()); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake has no TCP address");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((ok, fail) => { if (!server.listening) { ok(); return; } server.close(err => (err ? fail(err) : ok())); server.closeAllConnections(); }),
  };
};

// A verbose_json answer with word timestamps, as whisper-1 returns it.
export const whisperAnswer = (text: string, words: { word: string; start: number; end: number }[]): unknown =>
  ({ task: "transcribe", language: "english", duration: words.at(-1)?.end ?? 0, text, words, segments: [] });

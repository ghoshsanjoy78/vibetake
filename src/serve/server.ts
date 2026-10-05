import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isV2, noteFor, parseBundle } from "../capture/bundle.js";
import { FormatError } from "../errors.js";
import { transcribeBundle } from "../transcribe/core.js";
import { chooseProvider, NO_KEY_HINT, type ProviderChoice } from "../transcribe/env.js";
import { MAX_AUDIO_BYTES, TranscriptionError, type ProviderDeps } from "../transcribe/provider.js";
import { isPaired } from "./pairing.js";

// The local service: loopback only, two routes, the
// pairing code on every request. It holds the key the extension must never see, and sends only the
// voice track onward. No CORS headers, on purpose: a web page's preflight for the Authorization
// header fails, so a stray site cannot post audio here and spend the key.
export const DEFAULT_PORT = 7741;
const FORBIDDEN_PORT = 3000;   // the person's own app lives there
const HOST = "127.0.0.1";
// The provider's cap plus room for the bundle and the multipart framing.
const MAX_BODY_BYTES = MAX_AUDIO_BYTES + 2 * 1024 * 1024;

export type ServeOptions = {
  env: NodeJS.ProcessEnv; secret: string; port: number; version: string;
  deps?: ProviderDeps; log?: (line: string) => void;
};
export type Service = { url: string; port: number; close: () => Promise<void> };
type Answer = { status: number; body: unknown };

export const portFrom = (env: NodeJS.ProcessEnv): number => {
  const raw = env["VIBETAKE_PORT"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new FormatError(`VIBETAKE_PORT is "${raw}"; it must be a port number.`);
  if (port === FORBIDDEN_PORT) throw new FormatError(`VIBETAKE_PORT is 3000, which is where your own app runs; pick another port.`);
  return port;
};

const failure = (status: number, message: string): Answer => ({ status, body: { error: { message } } });
const tooLarge = (provider: string | null): Answer =>
  failure(413, `The voice track is over ${provider ?? "the provider"}'s 25 MB cap (about 25 minutes of narration). Splitting a long recording is not supported yet.`);

// The whole body, or null once it passes the cap. Past the cap the rest is drained, not kept, so
// the client still gets its 413 instead of a dropped connection.
const readBody = (req: IncomingMessage, cap: number): Promise<Buffer | null> => new Promise((ok, fail) => {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > cap) { req.resume(); ok(null); return; }
  const chunks: Buffer[] = []; let size = 0; let over = false;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (over) return;
    if (size > cap) { over = true; chunks.length = 0; return; }
    chunks.push(c);
  });
  req.on("end", () => ok(over ? null : Buffer.concat(chunks)));
  req.on("error", fail);
});

const providerOf = (env: NodeJS.ProcessEnv): { choice: ProviderChoice | null; problem: string | null } => {
  try { return { choice: chooseProvider(env), problem: null }; }
  catch (error) { return { choice: null, problem: error instanceof Error ? error.message : String(error) }; }
};

const transcribe = async (req: IncomingMessage, opts: ServeOptions): Promise<Answer> => {
  const { choice, problem } = providerOf(opts.env);
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("multipart/form-data")) { req.resume(); return failure(400, "Send multipart/form-data with a `voice` file and a `bundle` field (the recording's bundle.json)."); }
  const body = await readBody(req, MAX_BODY_BYTES);
  if (body === null) return tooLarge(choice?.provider ?? null);
  let form: FormData;
  try { form = await new Request(`http://${HOST}/transcribe`, { method: "POST", headers: { "content-type": type }, body: new Uint8Array(body) }).formData(); }
  catch { return failure(400, "The request body is not multipart/form-data VibeTake can read."); }
  const voice = form.get("voice"), raw = form.get("bundle");
  if (!(voice instanceof Blob) || typeof raw !== "string") return failure(400, "Send a `voice` file and a `bundle` field (the recording's bundle.json).");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return failure(400, "bundle is not valid JSON."); }
  let bundle;
  try { bundle = parseBundle(parsed); }
  catch (error) { if (error instanceof FormatError) return failure(400, error.message); throw error; }
  if (!isV2(bundle) || bundle.voice === null) return failure(400, "This recording has no voice track to transcribe.");
  if (voice.size > MAX_AUDIO_BYTES) return tooLarge(choice?.provider ?? null);
  if (problem !== null) return failure(503, `No usable transcription key: ${problem.replace(/\.$/, "")}. Fix .env.local and start the service again.`);
  if (choice === null) return failure(503, `No transcription key: ${NO_KEY_HINT} and start the service again.`);
  const audio = new Uint8Array(await voice.arrayBuffer());
  try {
    const { transcript, markdown } = await transcribeBundle(bundle, audio, bundle.steps.map(noteFor), choice, opts.deps);
    return { status: 200, body: { transcript, markdown } };
  } catch (error) {
    if (error instanceof TranscriptionError) {
      const message = `${error.message.replace(/\.$/, "")}${error.detail ? ` (${error.detail})` : ""}.`;
      return failure(error.kind === "too-large" ? 413 : error.kind === "bad-key" ? 503 : 502, message);
    }
    // Never the key: the provider module redacts what it builds; this is something else, and only
    // its class is shown to the caller.
    opts.log?.(`transcribe failed: ${(error instanceof Error ? error.message : String(error)).split(choice.key).join("[key]")}`);
    return failure(500, "VibeTake could not transcribe this recording (an unexpected error; see the service's output).");
  }
};

// Pairing is automatic: the extension asks for the code here. The
// answer goes only to an extension origin: Chrome puts the extension's origin on a POST (never on a
// GET, which is why this is one), a web page cannot forge that header and, with no CORS headers,
// cannot read the answer; another local program could read .env.local anyway. So the code never
// has to be shown to a person or pasted.
const PAIR_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const pairing = (req: IncomingMessage, opts: ServeOptions): Answer => {
  req.resume();
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !PAIR_ORIGIN.test(origin))
    return failure(403, "Pairing is only for the VibeTake extension.");
  return { status: 200, body: { code: opts.secret } };
};

const handle = async (req: IncomingMessage, opts: ServeOptions): Promise<Answer> => {
  if (req.method === "POST" && req.url === "/pair") return pairing(req, opts);
  if (!isPaired(req.headers.authorization, opts.secret)) {
    req.resume();
    return failure(401, "Not paired: the pairing code is missing or wrong. Open the extension's Settings and press Connect while `npm run serve` is running.");
  }
  let url: URL;
  try { url = new URL(req.url ?? "/", `http://${HOST}`); } catch {
    req.resume();
    return failure(404, "There is nothing at that address.");
  }
  if (req.method === "GET" && url.pathname === "/health") {
    const { choice } = providerOf(opts.env);
    return { status: 200, body: { version: opts.version, provider: choice?.provider ?? null, model: choice?.model ?? null } };
  }
  if (req.method === "POST" && url.pathname === "/transcribe") return transcribe(req, opts);
  req.resume();
  return failure(404, `There is nothing at ${req.method} ${url.pathname}.`);
};

const send = (res: ServerResponse, answer: Answer): void => {
  const text = JSON.stringify(answer.body);
  res.writeHead(answer.status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
};

export const startServer = (opts: ServeOptions): Promise<Service> => new Promise((ok, fail) => {
  const server = createServer((req, res) => {
    handle(req, opts).then(answer => send(res, answer), (error: unknown) => {
      opts.log?.(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      send(res, failure(500, "VibeTake could not handle this request (an unexpected error; see the service's output)."));
    });
  });
  server.once("error", fail);
  server.listen(opts.port, HOST, () => {
    const { port } = server.address() as AddressInfo;
    ok({
      url: `http://${HOST}:${port}`, port,
      close: () => new Promise<void>((done, failed) => { server.close(e => (e ? failed(e) : done())); server.closeAllConnections(); }),
    });
  });
});

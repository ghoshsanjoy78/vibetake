import { join } from "node:path";
import { ensurePairingSecret, PAIRING_FILE } from "./serve/pairing.js";
import { portFrom, startServer } from "./serve/server.js";
import { chooseProvider, NO_KEY_HINT } from "./transcribe/env.js";
import type { ProviderDeps } from "./transcribe/provider.js";
import { transcribeZip } from "./transcribe/zip.js";
import { APP_VERSION } from "./version.js";

// The CLI without the process: where the config lives, the environment, two sinks and a stop
// signal, so every command runs under vitest. `env` carries the keys read from .env.local by cli.ts.
export type Io = {
  configDir: string; env: NodeJS.ProcessEnv; deps?: ProviderDeps;
  out: (line: string) => void; err: (line: string) => void;
  // serve runs until this resolves: the CLI's resolves on SIGINT/SIGTERM; tests pass their own.
  stop?: () => Promise<void>;
};

const USAGE = [
  "Usage: npm run serve",
  "       vibetake transcribe <recording.zip> [--force]",
].join("\n");

export const runCommand = async (argv: string[], io: Io): Promise<number> => {
  const [command, ...args] = argv;
  try {
    if (command === "serve" && args.length === 0) return await serveCommand(io);
    if (command === "transcribe" && (args.length === 1 || (args.length === 2 && args[1] === "--force")))
      return await transcribeCommand(args[0]!, args.length === 2, io);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
  io.err(USAGE);
  return 2;
};

// For a zip exported while the service was not running: the transcript goes into the zip itself.
const transcribeCommand = async (file: string, force: boolean, io: Io): Promise<number> => {
  const outcome = await transcribeZip(file, { env: io.env, force, out: io.out, ...(io.deps ? { deps: io.deps } : {}) });
  for (const line of outcome.lines) (outcome.kind === "written" ? io.out : io.err)(line);
  return outcome.kind === "written" ? 0 : 1;
};

const serveCommand = async (io: Io): Promise<number> => {
  const port = portFrom(io.env);
  const { secret, created } = ensurePairingSecret(io.configDir);
  const choice = chooseProvider(io.env);   // a bad VIBETAKE_STT_PROVIDER is refused here, before listening
  let service;
  try {
    service = await startServer({ env: io.env, secret, port, version: APP_VERSION, log: io.err, ...(io.deps ? { deps: io.deps } : {}) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") { io.err(`Port ${port} is in use. Set VIBETAKE_PORT to another port and try again.`); return 1; }
    throw error;
  }
  io.out(`VibeTake is listening on ${service.url}${choice ? ` (transcription via ${choice.provider}, ${choice.model})` : ""}.`);
  if (!choice) io.out(`No transcription key: ${NO_KEY_HINT} and start the service again. Until then the extension exports recordings without a transcript.`);
  // The code is never printed: the extension fetches it from the service (GET /pair) by itself.
  io.out(`The extension pairs itself when you press Stop${created ? `; the pairing secret was created in ${join(io.configDir, PAIRING_FILE)}` : ""}.`);
  io.out("Press Ctrl-C to stop.");
  await (io.stop ?? (() => new Promise<void>(() => undefined)))();
  await service.close();
  io.out("Stopped.");
  return 0;
};

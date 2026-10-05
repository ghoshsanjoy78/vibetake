import fs from "node:fs";
import { join } from "node:path";
import { FormatError } from "../errors.js";

// Where a key for a cloud speech-to-text service lives: .env.local beside the project, never in the
// repository. Parsed here rather than by process.loadEnvFile so a bad line can be named.
export const readEnvFile = (path: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const lines = fs.readFileSync(path, "utf8").split("\n");
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) throw new FormatError(`${path} line ${index + 1} is not KEY=value.`);
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]!] = value;
  });
  return out;
};

// Only these reach the environment: replay launches a browser process that inherits process.env, so
// nothing else from the file goes there. Other keys are parsed (a bad line is still refused) but ignored.
const KNOWN = ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "VIBETAKE_STT_PROVIDER", "VIBETAKE_STT_MODEL", "VIBETAKE_STT_BASE_URL", "VIBETAKE_PORT"];

// Loads <dir>/.env.local into `env`. A variable already in the environment wins over the file, so a
// shell can override a project setting for one run. Returns the path loaded, or null when absent.
export const loadLocalEnv = (dir: string, env: NodeJS.ProcessEnv): string | null => {
  const path = join(dir, ".env.local");
  if (!fs.existsSync(path)) return null;
  for (const [key, value] of Object.entries(readEnvFile(path))) if (KNOWN.includes(key)) env[key] ??= value;
  return path;
};

export type Provider = "openai" | "openrouter";
export type ProviderChoice = { provider: Provider; key: string; baseUrl: string; model: string };

const DEFAULTS: Record<Provider, { baseUrl: string; model: string; keyVar: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "whisper-1", keyVar: "OPENAI_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "openai/whisper-1", keyVar: "OPENROUTER_API_KEY" },
};

export const NO_KEY_HINT = "add OPENAI_API_KEY or OPENROUTER_API_KEY to .env.local";

// The provider is whichever key is present; with both, VIBETAKE_STT_PROVIDER decides and OpenAI
// (the direct route) is the default. Null means no transcription, not an error.
export const chooseProvider = (env: NodeJS.ProcessEnv): ProviderChoice | null => {
  const asked = env["VIBETAKE_STT_PROVIDER"]?.trim().toLowerCase();
  let provider: Provider | null;
  if (asked !== undefined && asked !== "") {
    if (asked !== "openai" && asked !== "openrouter")
      throw new FormatError(`VIBETAKE_STT_PROVIDER is "${asked}"; it must be openai or openrouter.`);
    if (!env[DEFAULTS[asked].keyVar]) throw new FormatError(`VIBETAKE_STT_PROVIDER is ${asked} but ${DEFAULTS[asked].keyVar} is not set.`);
    provider = asked;
  } else {
    provider = env["OPENAI_API_KEY"] ? "openai" : env["OPENROUTER_API_KEY"] ? "openrouter" : null;
  }
  if (provider === null) return null;
  const defaults = DEFAULTS[provider];
  return {
    provider,
    key: env[defaults.keyVar]!,
    baseUrl: (env["VIBETAKE_STT_BASE_URL"] || defaults.baseUrl).replace(/\/+$/, ""),
    model: env["VIBETAKE_STT_MODEL"] || defaults.model,
  };
};

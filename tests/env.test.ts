import { it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseProvider, loadLocalEnv, readEnvFile } from "../src/transcribe/env.js";
import { FormatError } from "../src/errors.js";

const dirs: string[] = [];
const dir = (): string => { const d = mkdtempSync(join(tmpdir(), "vibetake-env-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

it("reads KEY=value lines, ignores comments and blanks, strips quotes, tolerates CRLF and export", () => {
  const d = dir();
  writeFileSync(join(d, ".env.local"), [
    "# keys for VibeTake", "", "OPENAI_API_KEY=sk-plain", 'OPENROUTER_API_KEY="sk-quoted"\r',
    "export VIBETAKE_STT_MODEL='whisper-1'", "VIBETAKE_STT_BASE_URL=http://127.0.0.1:1/v1",
  ].join("\n"));
  const env = readEnvFile(join(d, ".env.local"));
  expect(env).toEqual({
    OPENAI_API_KEY: "sk-plain", OPENROUTER_API_KEY: "sk-quoted", VIBETAKE_STT_MODEL: "whisper-1",
    VIBETAKE_STT_BASE_URL: "http://127.0.0.1:1/v1",
  });
});

it("refuses a line that is not KEY=value, naming the line", () => {
  const d = dir();
  writeFileSync(join(d, ".env.local"), "OPENAI_API_KEY=ok\nthis is not a setting\n");
  expect(() => readEnvFile(join(d, ".env.local"))).toThrow(/\.env\.local line 2 is not KEY=value/);
  expect(() => readEnvFile(join(d, ".env.local"))).toThrow(FormatError);
});

it("loads .env.local into the environment without overriding what is already set, and says which file", () => {
  const d = dir();
  writeFileSync(join(d, ".env.local"), "OPENAI_API_KEY=from-file\nVIBETAKE_STT_MODEL=from-file\n");
  const env: NodeJS.ProcessEnv = { VIBETAKE_STT_MODEL: "from-shell" };
  expect(loadLocalEnv(d, env)).toBe(join(d, ".env.local"));
  expect(env).toEqual({ OPENAI_API_KEY: "from-file", VIBETAKE_STT_MODEL: "from-shell" });
});

it("sets only the six known variables; anything else in the file is parsed but never reaches the environment", () => {
  const d = dir();
  writeFileSync(join(d, ".env.local"), "SOMETHING_ELSE=x\nOPENAI_API_KEY=from-file\nVIBETAKE_PORT=7742\n");
  const env: NodeJS.ProcessEnv = {};
  loadLocalEnv(d, env);
  expect(env).toEqual({ OPENAI_API_KEY: "from-file", VIBETAKE_PORT: "7742" });
  expect(env).not.toHaveProperty("SOMETHING_ELSE");
});

it("a missing .env.local is fine", () => {
  const env: NodeJS.ProcessEnv = {};
  expect(loadLocalEnv(dir(), env)).toBeNull();
  expect(env).toEqual({});
});

it("chooses the provider from the keys present", () => {
  expect(chooseProvider({})).toBeNull();
  expect(chooseProvider({ OPENAI_API_KEY: "a" })).toEqual({ provider: "openai", key: "a", baseUrl: "https://api.openai.com/v1", model: "whisper-1" });
  expect(chooseProvider({ OPENROUTER_API_KEY: "b" })).toEqual({ provider: "openrouter", key: "b", baseUrl: "https://openrouter.ai/api/v1", model: "openai/whisper-1" });
});

it("with both keys OpenAI wins unless VIBETAKE_STT_PROVIDER says otherwise", () => {
  const both = { OPENAI_API_KEY: "a", OPENROUTER_API_KEY: "b" };
  expect(chooseProvider(both)?.provider).toBe("openai");
  expect(chooseProvider({ ...both, VIBETAKE_STT_PROVIDER: "openrouter" })?.provider).toBe("openrouter");
  expect(chooseProvider({ ...both, VIBETAKE_STT_PROVIDER: "openai" })?.provider).toBe("openai");
});

it("model and base URL can be overridden", () => {
  expect(chooseProvider({ OPENROUTER_API_KEY: "b", VIBETAKE_STT_MODEL: "openai/whisper-large-v3", VIBETAKE_STT_BASE_URL: "http://127.0.0.1:4321/v1/" }))
    .toEqual({ provider: "openrouter", key: "b", baseUrl: "http://127.0.0.1:4321/v1", model: "openai/whisper-large-v3" });
});

it("a provider override without its key, or an unknown provider, is refused in plain words", () => {
  expect(() => chooseProvider({ OPENAI_API_KEY: "a", VIBETAKE_STT_PROVIDER: "openrouter" })).toThrow(/OPENROUTER_API_KEY is not set/);
  expect(() => chooseProvider({ OPENAI_API_KEY: "a", VIBETAKE_STT_PROVIDER: "deepgram" })).toThrow(/openai or openrouter/);
});

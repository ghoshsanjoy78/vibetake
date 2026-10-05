import { it, expect, afterEach, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Runs the built entry point, so it needs a prior `npm run build`; it skips, saying so, without one.
const cli = resolve("dist/src/cli.js");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

it.skipIf(!existsSync(cli))("a malformed .env.local is refused in plain words, with no stack trace and no line content (needs dist/: run npm run build)", () => {
  const d = mkdtempSync(join(tmpdir(), "vibetake-cli-"));
  dirs.push(d);
  writeFileSync(join(d, ".env.local"), "OPENAI_API_KEY=ok\nthis is not a setting\n");
  const run = spawnSync(process.execPath, [cli, "transcribe", "nothing.zip"], { cwd: d, encoding: "utf8" });
  expect(run.status).toBe(1);
  expect(run.stderr).toContain(".env.local line 2 is not KEY=value");
  expect(run.stderr).not.toMatch(/\bat /);
  expect(run.stderr).not.toContain("this is not a setting");
});

it.skipIf(!existsSync(cli))("serve from the built CLI: the printed URL answers with the printed code, the secret lands under VIBETAKE_HOME, Ctrl-C stops it (needs dist/)", async () => {
  const home = mkdtempSync(join(tmpdir(), "vibetake-cli-home-")); dirs.push(home);
  const cwd = mkdtempSync(join(tmpdir(), "vibetake-cli-cwd-")); dirs.push(cwd);
  writeFileSync(join(cwd, ".env.local"), "OPENAI_API_KEY=sk-cli-test\nVIBETAKE_PORT=0\n");
  // Delete, not blank: an empty variable would stop the .env.local key from loading.
  const env: NodeJS.ProcessEnv = { ...process.env, VIBETAKE_HOME: home };
  delete env["OPENAI_API_KEY"]; delete env["OPENROUTER_API_KEY"]; delete env["VIBETAKE_PORT"];
  const child = spawn(process.execPath, [cli, "serve"], { cwd, env });
  let stdout = ""; child.stdout.on("data", c => { stdout += c; });
  let stderr = ""; child.stderr.on("data", c => { stderr += c; });
  const exited = new Promise<number | null>(r => child.on("exit", r));
  try {
    await vi.waitFor(() => expect(stdout).toMatch(/Press Ctrl-C to stop\./), { timeout: 10_000 });
    const url = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)![1]!;
    expect(stdout).toContain("(transcription via openai, whisper-1)");
    const secretFile = join(home, "config", "pairing-secret");
    const code = readFileSync(secretFile, "utf8").trim();
    expect(stdout).not.toContain(code);   // never printed
    expect(await (await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${code}` } })).json()).toMatchObject({ provider: "openai" });
    if (process.platform !== "win32") expect(statSync(secretFile).mode & 0o777).toBe(0o600);
  } finally {
    child.kill("SIGINT");
  }
  expect(await exited).toBe(0);
  expect(stdout.trimEnd().endsWith("Stopped.")).toBe(true);
  expect(stdout + stderr).not.toContain("sk-cli-test");
});

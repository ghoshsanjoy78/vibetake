#!/usr/bin/env node
import { runCommand } from "./commands.js";
import { configDir, installRoot } from "./paths.js";
import { loadLocalEnv } from "./transcribe/env.js";

// Keys for paid services live in .env.local beside the project, never in the repository. A bad file
// is a sentence naming the file and line (never the line's content), not a stack trace.
try {
  loadLocalEnv(process.cwd(), process.env);
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}
if (process.exitCode !== 1)
  process.exitCode = await runCommand(process.argv.slice(2), {
    // VIBETAKE_HOME moves config/ (tests); unset, it is beside the code.
    configDir: configDir(process.env["VIBETAKE_HOME"] || installRoot()),
    env: process.env, out: console.log, err: console.error,
    stop: () => new Promise<void>(resolve => { for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolve()); }),
  });

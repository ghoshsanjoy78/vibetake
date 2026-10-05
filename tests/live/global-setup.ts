import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The live tests load the built extension and its lifted naming script. Build them fresh every run,
// so a test never passes against a stale copy of either.
export default function globalSetup(): void {
  execFileSync(process.execPath,
    [fileURLToPath(new URL("../../scripts/build-extension.mjs", import.meta.url))], { stdio: "inherit" });
}

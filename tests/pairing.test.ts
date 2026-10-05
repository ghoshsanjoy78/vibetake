import { it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePairingSecret, isPaired, PAIRING_FILE } from "../src/serve/pairing.js";
import { configDir } from "../src/paths.js";
import { FormatError } from "../src/errors.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vibetake-pairing-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("mints a secret once, 0600, and reuses it on the next start", () => {
  const first = ensurePairingSecret(join(dir, "config"));
  expect(first.created).toBe(true);
  expect(first.secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
  const path = join(dir, "config", PAIRING_FILE);
  expect(readFileSync(path, "utf8")).toBe(first.secret + "\n");
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  const again = ensurePairingSecret(join(dir, "config"));
  expect(again).toEqual({ secret: first.secret, created: false });
});

it("refuses a file that is not a secret it wrote, naming it", () => {
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", PAIRING_FILE), "hello world\n");
  expect(() => ensurePairingSecret(join(dir, "config"))).toThrow(FormatError);
  expect(() => ensurePairingSecret(join(dir, "config"))).toThrow(new RegExp(`${PAIRING_FILE} is not a pairing secret`));
});

it("pairs only the exact secret as a bearer token", () => {
  const secret = "abcdefghijklmnopqrstuvwxyz012345";
  expect(isPaired(`Bearer ${secret}`, secret)).toBe(true);
  expect(isPaired(`bearer ${secret}`, secret)).toBe(true);        // the scheme is case-insensitive in HTTP
  expect(isPaired(`Bearer  ${secret} `, secret)).toBe(true);      // whitespace around the token is not the token
  expect(isPaired(`Bearer ${secret.slice(0, 31)}`, secret)).toBe(false);
  expect(isPaired(`Bearer ${secret}x`, secret)).toBe(false);
  expect(isPaired(`Bearer ${secret.toUpperCase()}`, secret)).toBe(false);
  expect(isPaired(secret, secret)).toBe(false);                    // no scheme
  expect(isPaired(undefined, secret)).toBe(false);
  expect(isPaired("", secret)).toBe(false);
});

it("the config directory is beside the code", () => {
  expect(configDir(dir)).toBe(join(dir, "config"));
});

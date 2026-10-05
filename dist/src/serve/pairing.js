import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { join } from "node:path";
import { FormatError } from "../errors.js";
// The pairing secret: minted once into the config directory, 0600, kept across
// restarts. 32 url-safe characters, pasted once into the extension's Settings. It authorizes
// transcription only; it is not the provider key and the key is never derived from it.
export const PAIRING_FILE = "pairing-secret";
const SHAPE = /^[A-Za-z0-9_-]{32}$/;
export const ensurePairingSecret = (configDir) => {
    const path = join(configDir, PAIRING_FILE);
    if (fs.existsSync(path)) {
        const secret = fs.readFileSync(path, "utf8").trim();
        if (SHAPE.test(secret))
            return { secret, created: false };
        throw new FormatError(`${path} is not a pairing secret this version of VibeTake wrote. Delete it and start the service again; then paste the new code into the extension's Settings.`);
    }
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const secret = randomBytes(24).toString("base64url");
    fs.writeFileSync(path, secret + "\n", { mode: 0o600, flag: "wx" });
    return { secret, created: true };
};
// Exactly "Bearer <secret>", compared in constant time; the scheme is case-insensitive, the token is not.
export const isPaired = (authorization, secret) => {
    if (typeof authorization !== "string")
        return false;
    const m = /^bearer\s+(\S+)\s*$/i.exec(authorization);
    if (!m)
        return false;
    const offered = Buffer.from(m[1]), expected = Buffer.from(secret);
    return offered.length === expected.length && timingSafeEqual(offered, expected);
};

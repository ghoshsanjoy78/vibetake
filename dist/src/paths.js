import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Where VibeTake is installed: the directory holding package.json, found from this file whether it
// runs from src/ (tests) or dist/src/ (the CLI). The only thing written beside the code is config/
// (the service's pairing secret); recordings live in the zips the extension exports, nowhere else.
export const installRoot = () => {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (!fs.existsSync(join(dir, "package.json"))) {
        const up = dirname(dir);
        if (up === dir)
            throw new Error("VibeTake cannot find its own package.json above " + fileURLToPath(import.meta.url));
        dir = up;
    }
    return dir;
};
export const configDir = (root = installRoot()) => join(root, "config");

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SITES = fileURLToPath(new URL("./sites/", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/**
 * Serve one fixture site on an ephemeral port. Port 0 lets the OS pick a free port, so this can
 * never bind 3000 (the user's own app) — by construction, not by checking.
 */
export async function serveFixture(site: string): Promise<{ url: string; close: () => Promise<void> }> {
  if (!/^[a-z0-9-]+$/.test(site)) throw new Error(`Unknown fixture site name: ${site}`);
  const root = resolve(SITES, site);

  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
      if (path.includes("..") || path.includes("\0")) {
        res.writeHead(400).end("Bad path");
        return;
      }
      const file = resolve(join(root, path === "/" ? "index.html" : path));
      if (file !== root && !file.startsWith(root + sep)) {
        res.writeHead(400).end("Bad path");
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("Not found");
    }
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => ok());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fixture server has no TCP address");

  return {
    url: `http://127.0.0.1:${address.port}/`,
    // Resolves only once the listener is really gone. Idle keep-alive sockets from the browser
    // would otherwise hold close() open, so drop them.
    close: () =>
      new Promise<void>((ok, fail) => {
        server.close((err) => (err ? fail(err) : ok()));
        server.closeAllConnections();
      }),
  };
}

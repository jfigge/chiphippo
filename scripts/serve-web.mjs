/*
 * Copyright 2026 Jason Figge
 *
 * This file is part of Chip Hippo.
 *
 * Chip Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * Chip Hippo is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with Chip Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

// serve-web.mjs — serve a built web distribution locally, for trying it in a
// browser (`make web-serve`). Static files only, each revalidated on every
// request as Cloudflare's _headers ask, so a rebuild is seen on reload (the
// service worker then offers it as an update, as a deploy would be).
//
//   node scripts/serve-web.mjs [dir] [--port 8080]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const portAt = args.indexOf("--port");
const PORT = portAt >= 0 ? Number(args[portAt + 1]) : 8080;
const DIR = resolve(
  args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--port") ??
    join(ROOT, "dist", "web"),
);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".md": "text/markdown; charset=utf-8",
  ".map": "application/json",
  ".pdf": "application/pdf",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = normalize(join(DIR, rel));
    if (file !== DIR && !file.startsWith(DIR + sep))
      throw Object.assign(new Error("outside"), { code: "ENOENT" });
    if (!(await stat(file)).isFile())
      throw Object.assign(new Error("dir"), { code: "ENOENT" });
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type":
        TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(err.code === "ENOENT" ? 404 : 500, {
      "Content-Type": "text/plain",
    });
    res.end(err.code === "ENOENT" ? "Not found" : String(err.message));
  }
}).listen(PORT, () => {
  console.log(`Chip Hippo web: http://localhost:${PORT}/  (serving ${DIR})`);
});

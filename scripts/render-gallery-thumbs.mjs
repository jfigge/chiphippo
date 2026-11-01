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

// render-gallery-thumbs.mjs — photograph every gallery entry IN THE APP (the
// gallery work, features/chiphippo-gallery-plan.md → 1.3/D5): serve a built
// site (desktop/ = a web build, gallery/ = scripts/build-gallery.mjs's
// output), open each entry the way a visitor's "Open in browser" does —
// /desktop/?features=gallery&gallery=<id> — in headless Chrome, and save the
// desk as entries/<id>/thumb.png. So each thumbnail is also a smoke test: an
// entry the web app cannot open gets no picture, and is reported.
//
// Each entry gets a FRESH browser context (its own storage), so no visit sees
// another's project, and the one-tab Web Lock is never contended.
//
// Plain Node (22+: global WebSocket and fetch), no dependencies — the Chrome
// DevTools Protocol over a raw socket, like the docs' capture tooling.
//
//   node scripts/render-gallery-thumbs.mjs [--site website] [--chrome PATH]
//     [--only ID] [--force]

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const SITE = resolve(arg("site") ?? join(ROOT, "website"));
const ONLY = arg("only") ?? null;
const FORCE = args.includes("--force");
/** The desk is photographed at this CSS size, then halved. */
const VIEW = { width: 1280, height: 800 };
const SCALE = 0.5;
/** How long one entry may take to open, ms. */
const OPEN_TIMEOUT_MS = 30_000;
/** Settling time after the open: the frame, the first paint of every view. */
const SETTLE_MS = 1500;

const CHROME_PATHS = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".chiphippo": "application/json",
};

/** Serve SITE on a free port; resolves to the base URL and a closer. */
function serve() {
  const server = createServer(async (req, res) => {
    try {
      let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (rel.endsWith("/")) rel += "index.html";
      const file = normalize(join(SITE, rel));
      if (!file.startsWith(SITE + sep) || !(await stat(file)).isFile()) {
        throw Object.assign(new Error("nope"), { code: "ENOENT" });
      }
      res.writeHead(200, {
        "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end("Not found");
    }
  });
  return new Promise((ok) =>
    server.listen(
      0,
      "127.0.0.1",
      () =>
      ok({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }), // prettier-ignore
    ),
  );
}

/** A Chrome DevTools Protocol connection to the browser, flattened sessions. */
class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();

  static async open(url) {
    const cdp = new Cdp();
    cdp.#ws = new WebSocket(url);
    await new Promise((ok, fail) => {
      cdp.#ws.addEventListener("open", ok, { once: true });
      cdp.#ws.addEventListener("error", fail, { once: true });
    });
    cdp.#ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      const slot = msg.id != null && cdp.#pending.get(msg.id);
      if (slot) {
        cdp.#pending.delete(msg.id);
        if (msg.error) slot.fail(new Error(JSON.stringify(msg.error)));
        else slot.ok(msg.result);
      }
    });
    return cdp;
  }

  send(method, params = {}, sessionId = undefined) {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((ok, fail) => this.#pending.set(id, { ok, fail }));
  }

  close() {
    this.#ws.close();
  }
}

/** Launch headless Chrome; resolves to its browser socket URL and a killer. */
async function launchChrome() {
  const bin = CHROME_PATHS.concat(arg("chrome")).filter(Boolean).find(existsSync); // prettier-ignore
  if (!bin)
    throw new Error("no Chrome found — pass --chrome PATH or set CHROME");
  const profile = mkdtempSync(join(tmpdir(), "chiphippo-thumbs-"));
  const chrome = spawn(
    bin,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--window-size=${VIEW.width},${VIEW.height}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
    ],
    { stdio: "ignore" },
  );
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 200 && !existsSync(portFile); i += 1) await sleep(100);
  const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
  return {
    url: `ws://127.0.0.1:${port}${path}`,
    // Wait for Chrome to be gone before taking its profile away: it is still
    // writing to it as it exits.
    kill: async () => {
      const gone = new Promise((ok) => chrome.once("exit", ok));
      chrome.kill();
      await gone;
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); // prettier-ignore
    },
  };
}

/** Open one entry in a fresh context and photograph the desk. */
async function photograph(cdp, base, id) {
  const { browserContextId } = await cdp.send("Target.createBrowserContext");
  try {
    const { targetId } = await cdp.send("Target.createTarget", {
      url: "about:blank",
      browserContextId,
    });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }); // prettier-ignore
    const on = (method, params) => cdp.send(method, params, sessionId);
    await on("Emulation.setDeviceMetricsOverride", { ...VIEW, deviceScaleFactor: 1, mobile: false }); // prettier-ignore
    await on("Page.enable");
    await on("Page.navigate", {
      url: `${base}/desktop/?nosw&features=gallery&gallery=${encodeURIComponent(id)}`,
    });
    const evaluate = async (expression) =>
      (await on("Runtime.evaluate", { expression, returnByValue: true })).result.value; // prettier-ignore
    const deadline = Date.now() + OPEN_TIMEOUT_MS;
    let opened;
    while (Date.now() < deadline) {
      opened = await evaluate("document.documentElement.dataset.galleryOpened ?? null"); // prettier-ignore
      if (opened != null) break;
      await sleep(250);
    }
    if (opened !== id) return { ok: false, why: opened == null ? "timed out" : "the app could not open it" }; // prettier-ignore
    // The app frames the design to the desk edge to edge, and the picture's
    // aspect is not the desk's: one step out (the desk's own − button) keeps
    // a tall design's bottom row — the computers' LCD — in the frame.
    await evaluate(`document.querySelector(".desk-zoom .desk-zoom-btn")?.click()`); // prettier-ignore
    // The desk's own chrome (the tab strip, the zoom buttons, the padlock)
    // is the app's, not the design's: it stays out of the picture.
    await evaluate(`(() => {
      const style = document.createElement("style");
      style.textContent = ".project-tabs, .desk-zoom, .desk-lock { visibility: hidden !important; }";
      document.head.append(style);
    })()`);
    await sleep(SETTLE_MS);
    const rect = await evaluate(`(() => {
      const r = document.querySelector(".desk-viewport")?.getBoundingClientRect();
      return r && { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`);
    if (!rect) return { ok: false, why: "no desk on the page" };
    const shot = await on("Page.captureScreenshot", {
      format: "png",
      clip: { ...rect, scale: SCALE },
    });
    return { ok: true, png: Buffer.from(shot.data, "base64") };
  } finally {
    await cdp.send("Target.disposeBrowserContext", { browserContextId });
  }
}

const index = JSON.parse(
  readFileSync(join(SITE, "gallery/index.json"), "utf8"),
);
if (!existsSync(join(SITE, "desktop/index.html"))) {
  console.error(
    `render-gallery-thumbs: no web build at ${join(SITE, "desktop")}`,
  );
  process.exit(1);
}
const todo = index.entries
  .map((e) => e.id)
  .filter((id) => (ONLY ? id === ONLY : true))
  .filter((id) => FORCE || !existsSync(join(SITE, "gallery/entries", id, "thumb.png"))); // prettier-ignore

const server = await serve();
const chrome = await launchChrome();
const cdp = await Cdp.open(chrome.url);
let made = 0;
const failed = [];
try {
  let lost = 0; // timeouts in a row
  for (const id of todo) {
    const result = await photograph(cdp, server.base, id).catch((err) => ({ ok: false, why: err.message })); // prettier-ignore
    if (result.ok) {
      writeFileSync(join(SITE, "gallery/entries", id, "thumb.png"), result.png);
      made += 1;
      lost = 0;
    } else {
      failed.push(`${id} (${result.why})`);
      // A web build that predates gallery links opens nothing and marks
      // nothing: every entry would wait out its timeout. Two in a row with
      // none made says so, and stops.
      lost = result.why === "timed out" ? lost + 1 : 0;
      if (lost >= 2 && made === 0) {
        failed.push("…stopped: this web build does not open gallery links");
        break;
      }
    }
  }
} finally {
  cdp.close();
  await chrome.kill();
  server.close();
}
console.log(`gallery thumbnails: ${made} made, ${index.entries.length - todo.length} already there`); // prettier-ignore
for (const f of failed)
  console.error(`gallery thumbnails: no picture for ${f}`);
process.exit(failed.length && args.includes("--strict") ? 1 : 0);

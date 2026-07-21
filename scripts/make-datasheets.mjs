/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Regenerate the datasheet connection-diagram + function-table crops shown in
// the pin-assignments window (web/pinout.html). One committed PNG per catalog
// chip that has a datasheet, cropped from the manufacturer PDF's diagram block.
//
// RUNS UNDER ELECTRON (`make datasheets` → `npx electron scripts/make-datasheets.mjs`),
// like `make icons`: it renders each source PDF page at high DPI (216 DPI) with
// pdfjs-dist inside a hidden Chromium window, then crops to the per-chip
// rectangle from scripts/datasheet-crops.mjs. Electron is required because the
// diagrams are JBIG2-encoded bitmaps — pdfjs decodes those through a WASM module
// and a same-origin worker, both of which need a real file:// page + Chromium.
//
// The source PDFs are NOT in the repo (they live in the user's datasheet
// folder); only the cropped PNGs are committed. Point at a different folder with
// the DATASHEETS_DIR env var. Chips whose crop is still `null`, or whose PDF is
// missing, are skipped with a note — the pinout window shows no diagram for them.
//
// Outputs (committed): src/web/datasheets/<catalog-id>.png
import { app, BrowserWindow, nativeImage } from "electron";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DATASHEET_CROPS } from "./datasheet-crops.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SRC = path.join(repoRoot, "src");
const PDFJS = path.join(SRC, "node_modules/pdfjs-dist");
const OUT_DIR = path.join(SRC, "web/datasheets");
const DATASHEETS_DIR =
  process.env.DATASHEETS_DIR || "/Users/jason/Documents/data-sheets";

// 3× the PDF's native 72 DPI → 216 DPI: crisp truth-table text, modest files.
const SCALE = 3;

const rel = (p) => path.relative(repoRoot, p);

/** Case-insensitively resolve a datasheet basename to its PDF path, or null. */
function resolvePdf(base) {
  const want = base.toLowerCase();
  for (const name of readdirSync(DATASHEETS_DIR)) {
    const parsed = path.parse(name);
    if (parsed.ext.toLowerCase() === ".pdf" && parsed.name.toLowerCase() === want)
      return path.join(DATASHEETS_DIR, name);
  }
  return null;
}

// A real file:// harness page so pdfjs' module worker is same-origin (a null
// origin — about:blank/data: — makes Chromium refuse the cross-origin worker,
// silently falling back to a main-thread worker that can't decode the images).
function harnessHtml() {
  const base = pathToFileURL(PDFJS + "/").href; // trailing slash: pdfjs appends
  const pdfMjs = pathToFileURL(path.join(PDFJS, "build/pdf.mjs")).href;
  return `<!doctype html><meta charset="utf-8"><body><script type="module">
    import * as pdfjsLib from ${JSON.stringify(pdfMjs)};
    const BASE = ${JSON.stringify(base)};
    pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + "build/pdf.worker.mjs";
    window.renderPage = async (b64, pageNum, scale) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const doc = await pdfjsLib.getDocument({
        data,
        wasmUrl: BASE + "wasm/",            // JBIG2/JPX bitmap decoders
        standardFontDataUrl: BASE + "standard_fonts/",
        cMapUrl: BASE + "cmaps/",
        cMapPacked: true,
      }).promise;
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      const cv = document.createElement("canvas");
      cv.width = Math.ceil(viewport.width);
      cv.height = Math.ceil(viewport.height);
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      return { dataUrl: cv.toDataURL("image/png"), width: cv.width, height: cv.height, pages: doc.numPages };
    };
    window.__ready = true;
  </script></body>`;
}

async function makeHarnessWindow() {
  const harnessPath = path.join(app.getPath("temp"), "chiphippo-ds-harness.html");
  writeFileSync(harnessPath, harnessHtml());
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: false, contextIsolation: false, webSecurity: false },
  });
  await win.loadFile(harnessPath);
  for (let i = 0; i < 200; i++) {
    if (await win.webContents.executeJavaScript("!!window.__ready")) return win;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("harness failed to initialise pdfjs");
}

/** Crop a rendered-page data URL to the fractional rectangle → PNG buffer. */
function cropToPng(dataUrl, w, h, crop) {
  const img = nativeImage.createFromDataURL(dataUrl);
  const x = Math.max(0, Math.round(crop.x * w));
  const y = Math.max(0, Math.round(crop.y * h));
  const width = Math.min(w - x, Math.round(crop.w * w));
  const height = Math.min(h - y, Math.round(crop.h * h));
  return img.crop({ x, y, width, height }).toPNG();
}

app.whenReady().then(async () => {
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    const win = await makeHarnessWindow();
    win.webContents.on("console-message", (e) => {
      const msg = e?.message ?? "";
      if (/error|fail/i.test(msg) && !/Security Warning/i.test(msg))
        console.warn("  pdfjs:", msg);
    });

    const ids = Object.keys(DATASHEET_CROPS);
    let wrote = 0;
    const skipped = [];
    for (const id of ids) {
      const entry = DATASHEET_CROPS[id];
      if (!entry.crop) {
        skipped.push(`${id} (no crop yet)`);
        continue;
      }
      const pdf = resolvePdf(entry.file);
      if (!pdf) {
        skipped.push(`${id} (${entry.file}.pdf not found)`);
        continue;
      }
      const b64 = readFileSync(pdf).toString("base64");
      const res = await win.webContents.executeJavaScript(
        `window.renderPage(${JSON.stringify(b64)}, ${entry.page}, ${SCALE})`,
        true,
      );
      const png = cropToPng(res.dataUrl, res.width, res.height, entry.crop);
      const out = path.join(OUT_DIR, `${id}.png`);
      writeFileSync(out, png);
      wrote++;
      console.log(`  ${id.padEnd(8)} ${entry.file} p${entry.page} → ${rel(out)}`);
    }

    console.log(`\nWrote ${wrote} crop(s) to ${rel(OUT_DIR)}/`);
    if (skipped.length) console.log(`Skipped ${skipped.length}: ${skipped.join(", ")}`);
    app.exit(0);
  } catch (err) {
    console.error("make-datasheets failed:", err && err.stack ? err.stack : err);
    app.exit(1);
  }
});

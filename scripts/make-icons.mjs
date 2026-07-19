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

// Regenerate every application-icon raster from the two vector sources.
//
// RUNS UNDER ELECTRON (`make icons` → `npx electron scripts/make-icons.mjs`),
// not plain node: macOS' QuickLook (`qlmanage`) flattens SVG transparency onto
// a WHITE background, which ruins the macOS safe-area border and the rounded
// corners. So we rasterise in a transparent offscreen Electron window (Chromium)
// and downscale with `nativeImage`, preserving the alpha channel end to end.
//
// Two sources, because macOS is special:
//   • src/web/chiphippo-icon.svg      — edge-to-edge logo (fills its canvas).
//     → Windows .ico, the Linux icon set, and the Linux runtime logo.
//   • src/web/chiphippo-mac-icon.svg  — the SAME art inside the macOS "safe
//     area": a rounded square filling ~80% of the canvas with a TRANSPARENT
//     border on every side, so the dock/tray renders it at native visual weight.
//     → chiphippo-mac-icon.png (electron-builder's mac/mas icon + the dock icon).
//
// Outputs (committed to the repo, consumed at build time + runtime):
//   src/web/chiphippo-mac-icon.png   — 1024², macOS (electron-builder → .icns)
//   src/web/chiphippo-icon.ico       — Windows, PNG-encoded entries 16…256
//   src/web/chiphippo-logo.png       — 512², Linux runtime dock/window icon
//   src/web/icons/<N>x<N>.png        — Linux icon set (16…1024)
import { app, BrowserWindow } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const WEB = path.join(repoRoot, "src/web");
const FULL_SVG = path.join(WEB, "chiphippo-icon.svg");
const MAC_SVG = path.join(WEB, "chiphippo-mac-icon.svg");
const MAC_PNG_OUT = path.join(WEB, "chiphippo-mac-icon.png");
const ICO_OUT = path.join(WEB, "chiphippo-icon.ico");
const LOGO_OUT = path.join(WEB, "chiphippo-logo.png");
const LINUX_DIR = path.join(WEB, "icons");

const MASTER = 1024;
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16];
const LOGO_SIZE = 512;

// One shared hidden window rasterises everything (creating/destroying a window
// per render races the file loader). Canvas 2D preserves the SVG's own
// transparency exactly — unlike qlmanage (flattens to white) and offscreen
// capturePage (dropped alpha). The SVG rides in as a data-URL Image, so there's
// no per-render file load; each size is drawn straight from the vector (crisp).
let sharedWin = null;
async function rasterWindow() {
  if (sharedWin) return sharedWin;
  sharedWin = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: false, contextIsolation: false },
  });
  await sharedWin.loadURL("about:blank");
  return sharedWin;
}

async function renderSvg(svgText, size) {
  const win = await rasterWindow();
  const b64 = Buffer.from(svgText, "utf8").toString("base64");
  const dataUrl = await win.webContents.executeJavaScript(
    `new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement("canvas");
        cv.width = ${size}; cv.height = ${size};
        const c = cv.getContext("2d");
        c.clearRect(0, 0, ${size}, ${size});
        c.drawImage(img, 0, 0, ${size}, ${size});
        res(cv.toDataURL("image/png"));
      };
      img.onerror = () => rej(new Error("svg decode failed"));
      img.src = "data:image/svg+xml;base64,${b64}";
    })`,
    true,
  );
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

// Vista-style ICO with PNG-encoded entries: 6-byte ICONDIR header, one 16-byte
// ICONDIRENTRY per image, then the raw PNG blobs.
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  const blobs = [];
  let offset = 6 + 16 * entries.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 0); // width  (0 ⇒ 256)
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1); // height (0 ⇒ 256)
    dir.writeUInt8(0, o + 2); // palette colours (0 = none)
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(e.png.length, o + 8); // size of image data
    dir.writeUInt32LE(offset, o + 12); // offset of image data
    offset += e.png.length;
    blobs.push(e.png);
  });
  return Buffer.concat([header, dir, ...blobs]);
}

const rel = (p) => path.relative(repoRoot, p);

app.whenReady().then(async () => {
  try {
    // macOS: render the padded (safe-area) source straight to 1024².
    console.log(`Rendering macOS icon from ${rel(MAC_SVG)}…`);
    const macSvg = readFileSync(MAC_SVG, "utf8");
    writeFileSync(MAC_PNG_OUT, await renderSvg(macSvg, MASTER));
    console.log(`  → ${rel(MAC_PNG_OUT)} (${MASTER}²)`);

    // Edge-to-edge master → Windows + Linux. Render each needed size straight
    // from the vector once and cache it (the Linux ladder covers ico + logo).
    console.log(`Rendering Windows + Linux rasters from ${rel(FULL_SVG)}…`);
    const fullSvg = readFileSync(FULL_SVG, "utf8");
    const cache = new Map();
    const at = async (size) => {
      if (!cache.has(size)) cache.set(size, await renderSvg(fullSvg, size));
      return cache.get(size);
    };

    mkdirSync(LINUX_DIR, { recursive: true });
    for (const size of LINUX_SIZES) {
      writeFileSync(path.join(LINUX_DIR, `${size}x${size}.png`), await at(size));
      console.log(`  linux  ${size}²`);
    }
    writeFileSync(LOGO_OUT, await at(LOGO_SIZE));
    console.log(`  → ${rel(LOGO_OUT)} (${LOGO_SIZE}²)`);

    const icoEntries = [];
    for (const size of ICO_SIZES) icoEntries.push({ size, png: await at(size) });
    writeFileSync(ICO_OUT, buildIco(icoEntries));
    console.log(`  → ${rel(ICO_OUT)} (${ICO_SIZES.join(", ")})`);

    console.log(`\nWrote ${rel(LINUX_DIR)}/ (${LINUX_SIZES.length} sizes)`);
    app.exit(0);
  } catch (err) {
    console.error("make-icons failed:", err.message);
    app.exit(1);
  }
});

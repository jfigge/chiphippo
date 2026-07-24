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

// build-pdf.mjs — build a single, self-contained PDF of the user guide. It
// renders the same src/web/docs/*.md that drive DocsViewer and the hosted
// guide — reusing PAGES + renderBody from build-docs.mjs so the PDF can never
// drift — stitches them into one print-styled HTML document (cover + contents
// + one section per page), then prints it through Chromium's printToPDF via a
// hidden Electron window. No extra dependencies: Electron + marked are
// already in src/.
//
// Must run UNDER Electron (it needs BrowserWindow), not plain node:
//   cd src && PDF_OUT=... npx electron ../scripts/build-pdf.mjs   # or: make pdf
//
// Output: $PDF_OUT (default docs/chip-hippo-user-guide.pdf). On Linux/CI this
// needs a display server (xvfb-run); on macOS the hidden window is enough.
import { app, BrowserWindow } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PAGES, SRC, renderBody, LOGO_SVG } from "./build-docs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT =
  process.env.PDF_OUT || resolve(ROOT, "docs/chip-hippo-user-guide.pdf");

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, "src/package.json"), "utf8"))
      .version;
  } catch {
    return "";
  }
})();

// Images are referenced Markdown-relative ("images/foo.png"). Absolutize them
// to file:// URLs so they load from the temp HTML wherever it lives on disk.
const IMAGES_BASE = pathToFileURL(resolve(SRC, "images")).href;

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSection(p) {
  const mdPath = resolve(SRC, `${p.file ?? p.slug}.md`);
  const body = renderBody(readFileSync(mdPath, "utf8")).replace(
    /src="(?:\.\/)?images\//g,
    `src="${IMAGES_BASE}/`,
  );
  return `<section class="doc-page">\n${body}\n</section>`;
}

// Print-oriented light theme (the website/DocsViewer theme is dark — wrong for
// paper). Mirrors that theme's structure but on white, with fragmentation
// hints so tables/images/code don't split awkwardly across pages.
const STYLE = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#1c1c1c;line-height:1.6;font-size:11pt}
code{font-family:"SFMono-Regular",Menlo,"Cascadia Code","JetBrains Mono",monospace;font-size:.85em;background:#f2f2f4;padding:1px 5px;border-radius:4px}
pre{background:#f7f7f9;border:1px solid #e3e3e8;border-radius:8px;padding:12px 14px;margin:14px 0;white-space:pre-wrap;word-break:break-word;break-inside:avoid}
pre code{background:none;padding:0}
kbd{font-family:inherit;font-size:.82em;background:#f2f2f4;border:1px solid #d5d5db;border-bottom-width:2px;border-radius:5px;padding:1px 6px}
a{color:#1e7e34;text-decoration:none}
h1{font-size:22pt;font-weight:800;letter-spacing:-.5px;line-height:1.2;margin:0 0 16px}
h2{font-size:15pt;font-weight:700;margin:26px 0 10px;padding-top:10px;border-top:1px solid #e3e3e8;break-after:avoid}
h3{font-size:12.5pt;font-weight:700;margin:20px 0 8px;break-after:avoid}
h4{font-size:11pt;font-weight:700;margin:16px 0 6px;break-after:avoid}
p,ul,ol,blockquote,table{margin:0 0 12px}
ul,ol{padding-left:22px}
li{margin:3px 0}
img{max-width:100%;height:auto;border:1px solid #e3e3e8;border-radius:8px;margin:8px 0;break-inside:avoid}
blockquote{border-left:3px solid #1e7e34;background:#f7f7f9;padding:8px 14px;border-radius:0 6px 6px 0;color:#555}
blockquote p:last-child{margin:0}
table{border-collapse:collapse;width:100%;font-size:.9em;break-inside:avoid}
th,td{border:1px solid #dcdce2;padding:6px 10px;text-align:left;vertical-align:top}
th{background:#f2f2f4}
tr{break-inside:avoid}
hr{border:none;border-top:1px solid #e3e3e8;margin:22px 0}
.cover{height:9.2in;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.cover-logo svg{width:96px;height:96px}
.cover-title{font-size:40pt;font-weight:800;letter-spacing:-1px;margin:22px 0 0}
.cover-sub{font-size:18pt;color:#555;font-weight:600;margin:4px 0 0}
.cover-meta{font-size:11pt;color:#888;margin-top:28px}
.toc{break-before:page;page-break-before:always}
.toc-list{list-style:none;padding:0;margin-top:18px;font-size:12pt}
.toc-list li{padding:7px 0;border-bottom:1px solid #eee;display:flex;gap:12px}
.toc-n{color:#1e7e34;font-weight:700;min-width:1.6em;text-align:right}
.doc-page{break-before:page;page-break-before:always}
`;

const dateStr = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
}).format(new Date());

const toc = PAGES.map(
  (p, i) =>
    `<li><span class="toc-n">${i + 1}</span><span>${esc(p.title)}</span></li>`,
).join("\n");

const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><style>${STYLE}</style></head>
<body>
  <section class="cover">
    <div class="cover-logo">${LOGO_SVG.replace(/width="24" height="24"/, "")}</div>
    <div class="cover-title">Chip Hippo</div>
    <div class="cover-sub">User Guide</div>
    <div class="cover-meta">${VERSION ? `Version ${esc(VERSION)} · ` : ""}${esc(dateStr)}</div>
  </section>
  <section class="toc">
    <h1>Contents</h1>
    <ol class="toc-list">${toc}</ol>
  </section>
  ${PAGES.map(renderSection).join("\n")}
</body>
</html>`;

const FOOTER = `<div style="font-size:8px;color:#999;width:100%;padding:0 0.6in;display:flex;justify-content:space-between;">
  <span>Chip Hippo — User Guide${VERSION ? ` v${VERSION}` : ""}</span>
  <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
</div>`;

app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 1400,
      webPreferences: { webSecurity: false, offscreen: false },
    });

    const tmp = resolve(app.getPath("temp"), "chip-hippo-user-guide.html");
    writeFileSync(tmp, html);
    await win.loadFile(tmp);

    // Make sure fonts and every image have actually settled before printing —
    // loadFile resolves early enough that images can otherwise be missing.
    await win.webContents.executeJavaScript(`(async () => {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      await Promise.all([...document.images]
        .filter((i) => !i.complete)
        .map((i) => new Promise((r) => { i.onload = i.onerror = r; })));
    })()`);

    const pdf = await win.webContents.printToPDF({
      pageSize: "Letter",
      printBackground: true,
      margins: { top: 0.6, bottom: 0.7, left: 0.6, right: 0.6 },
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: FOOTER,
    });

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, pdf);
    console.log(
      `Wrote ${OUT} (${(pdf.length / 1024).toFixed(0)} KB, ${PAGES.length} guide pages)`,
    );

    win.destroy();
    app.quit();
  })
  .catch((err) => {
    console.error("PDF build failed:", err);
    app.exit(1);
  });

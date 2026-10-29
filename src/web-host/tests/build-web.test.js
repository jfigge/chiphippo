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

// build-web.test.js — scripts/build-web.mjs, the web distribution's build:
// every page made a web page, and every bundle BUILDS. The second is the one
// that matters over time — main's code is bundled unchanged, so the day main
// requires a Node module the web host has no stand-in for, this fails here
// rather than in a visitor's browser.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  bundleOptions,
  loadEsbuild,
  rendererEntries,
  transformHtml,
} from "../../../scripts/build-web.mjs";

const WEB = fileURLToPath(new URL("../../web/", import.meta.url));
const pages = readdirSync(WEB).filter((n) => n.endsWith(".html"));

test("every page loads the preload ahead of its own modules", () => {
  assert.ok(pages.includes("index.html") && pages.length >= 8, pages.join(","));
  for (const name of pages) {
    const html = transformHtml(readFileSync(`${WEB}${name}`, "utf8"), {
      isIndex: name === "index.html",
    });
    const preload = html.indexOf('<script src="web-host/preload.js"></script>');
    assert.ok(preload > 0, `${name}: the preload`);
    assert.ok(
      html.includes("web-host/web-host.css"),
      `${name}: the host's styles`,
    );
    const firstModule = html.indexOf('type="module"');
    assert.ok(
      firstModule < 0 || firstModule > preload,
      `${name}: preload first`,
    );
    assert.match(
      html,
      /connect-src 'self' https:/,
      `${name}: the AI builder may reach its provider`,
    );
    if (name === "index.html") {
      assert.ok(
        html.includes('src="web-host/host.js"'),
        "the host starts in the app's tab",
      );
      assert.ok(html.includes('rel="manifest"'), "installable");
    } else {
      assert.ok(
        !html.includes("web-host/host.js"),
        `${name}: a popup's host is its opener's`,
      );
    }
  }
});

test("main and the preload bundle with no Node module left unresolved", async () => {
  const esbuild = loadEsbuild();
  const { host, preload } = bundleOptions({ minify: false });
  for (const [name, opts] of [
    ["host", host],
    ["preload", preload],
  ]) {
    const result = await esbuild.build({
      ...opts,
      write: false,
      sourcemap: false,
      logLevel: "silent",
      metafile: true,
    });
    assert.deepEqual(result.errors, [], name);
    const inputs = Object.keys(result.metafile.inputs);
    if (name === "host") {
      assert.ok(
        inputs.some((p) => p.endsWith("app/main.js")),
        "main.js is in it",
      );
      assert.ok(
        !inputs.some((p) => p.endsWith("app/updater.js")),
        "electron-updater's wrapper is not",
      );
      assert.ok(
        inputs.some((p) => p.endsWith("web-host/updater.js")),
        "the service-worker updater is",
      );
    } else {
      assert.ok(
        inputs.some((p) => p.endsWith("app/preload.js")),
        "preload.js is in it",
      );
    }
  }
});

test("the renderer bundles: one file per page and Worker, in its own place", async () => {
  const entries = rendererEntries();
  for (const name of pages) {
    const html = readFileSync(`${WEB}${name}`, "utf8");
    const src = html.match(/<script\s+type="module"\s+src="([^"]+)"/)?.[1];
    if (src) assert.ok(entries.includes(src), `${name}: ${src}`);
  }
  assert.ok(entries.includes("scripts/components/sim-worker.js"), "the Worker");
  const esbuild = loadEsbuild();
  const { renderer } = bundleOptions({ minify: false, outDir: "/out" });
  const result = await esbuild.build({
    ...renderer,
    write: false,
    sourcemap: false,
    logLevel: "silent",
    metafile: true,
  });
  assert.deepEqual(result.errors, []);
  const outs = Object.keys(result.metafile.outputs).sort();
  assert.deepEqual(
    outs.map((p) => p.replace(/^.*?out\//, "")),
    [...entries].sort(),
    "each entry written over its own copy, no chunks",
  );
  const app = result.outputFiles.find((f) =>
    f.path.endsWith("/scripts/app.js"),
  );
  assert.ok(
    app.text.includes('new URL("./components/sim-worker.js", import.meta.url)'),
    "the Worker's URL is relative to the page bundle in scripts/",
  );
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.some((p) => p.endsWith("components/desk-controller.js")));
  assert.ok(!inputs.some((p) => /\/tests\//.test(p)), "no test is bundled");
  for (const f of result.outputFiles)
    assert.match(
      f.text,
      /^\/\*! Chip Hippo .*Copyright .*GPL-3\.0-or-later/,
      f.path,
    );
});

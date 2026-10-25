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

// web-boot.test.js — the web build's main process, booted end to end under
// `node --test`: the real bundle scripts/build-web.mjs makes (main.js and all
// it requires, on the browser stand-ins), in a jsdom "tab", over a fake
// IndexedDB. A renderer connects as the preload does and drives main over the
// same channels the app uses — which is the proof that main's own code runs
// here unchanged: a boot, a save that reaches storage, a reload that finds it,
// an example read from the site, main's Help menu under the header's book.

import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { bundleOptions, loadEsbuild } from "../../../scripts/build-web.mjs";
import { fakeIndexedDB } from "./fake-indexeddb.js";

const WEB = fileURLToPath(new URL("../../web/", import.meta.url));
const SITE = "http://chiphippo.test/";

/** What the site would serve: the shipped files, the manifest, the version. */
function siteFetch() {
  const files = [];
  for (const dir of ["locales", "demos"]) {
    for (const name of readdirSync(join(WEB, dir))) {
      files.push([`${dir}/${name}`, statSync(join(WEB, dir, name)).size]);
    }
  }
  return async (input) => {
    const url = new URL(String(input?.url ?? input), SITE);
    const rel = decodeURIComponent(url.pathname.slice(1));
    const body =
      rel === "version.json"
        ? JSON.stringify({ version: "9.9.9", stamp: "test" })
        : rel === "web-host/files.json"
          ? JSON.stringify({ files })
          : (() => {
              try {
                return readFileSync(join(WEB, rel));
              } catch {
                return null;
              }
            })();
    if (body == null) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200 });
  };
}

let outDir = null;

async function buildBundle() {
  outDir = mkdtempSync(join(tmpdir(), "chiphippo-web-"));
  const { host } = bundleOptions({ outDir, minify: false });
  await loadEsbuild().build({ ...host, sourcemap: false, logLevel: "error" });
}

let generation = 0;
const tabs = [];

/** Boot main in a fresh tab over `databases`; resolve the renderer's link. */
async function bootTab(databases) {
  const dom = new JSDOM(
    '<!doctype html><html><head><title>Chip Hippo</title></head><body><div id="app"></div></body></html>',
    // jsdom says "not implemented" for window.focus(); nothing else to hear.
    { url: SITE, virtualConsole: new VirtualConsole() },
  );
  const { window } = dom;
  tabs.push(window);
  const set = (name, value) =>
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  set("window", window);
  set("document", window.document);
  set("location", window.location);
  set("navigator", window.navigator);
  set("Event", window.Event);
  set("CustomEvent", window.CustomEvent);
  set("indexedDB", fakeIndexedDB(databases));
  set("fetch", siteFetch());
  set("isSecureContext", false);
  // Each tab evaluates the bundle afresh, as a reload does: its own copy.
  const copy = join(outDir, `web-host/host-${++generation}.js`);
  copyFileSync(join(outDir, "web-host/host.js"), copy);
  await import(pathToFileURL(copy).href);
  const host = await new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () =>
        reject(
          new Error(
            "the host never came up: " +
              window.document.body.textContent.slice(0, 300),
          ),
        ),
      20_000,
    );
    const check = () => {
      if (window.__chiphippoHost) {
        clearTimeout(deadline);
        resolve(window.__chiphippoHost);
      } else setTimeout(check, 10);
    };
    check();
  });
  const pushes = [];
  const link = host.attach(window, {
    deliver: (channel, args) => pushes.push([channel, args]),
  });
  return { window, link, pushes };
}

test.before(buildBundle);
test.after(() => {
  for (const w of tabs) w.close();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

test("main boots in a tab, saves to storage, and finds it again after a reload", async () => {
  const databases = new Map();
  const first = await bootTab(databases);
  const { link } = first;

  const info = await link.invoke("app:info:get", []);
  assert.equal(info.distribution, "web");

  const i18n = await link.invoke("i18n:load", []);
  assert.equal(
    i18n.fallback.common.ok,
    "OK",
    "the catalogs came from the site",
  );

  const project = await link.invoke("project:boot", []);
  assert.ok(
    Array.isArray(project.tabs) && project.tabs.length === 1,
    "a new project",
  );

  // An example circuit, read from the site by path.
  const demo = await link.invoke("demo:read", ["74LS00"]);
  assert.ok(demo && (demo.doc || demo.desktops), "the 74LS00 example");

  // Save the untitled project into the working slot.
  project.name = "";
  project.tabs[0].name = "Bench";
  const saved = await link.invoke("project:save", [project, null]);
  assert.equal(saved.ok, true);
  const files = databases.get("chiphippo").stores.get("files");
  assert.ok(
    files.has("/userData/saves/default.chiphippo"),
    "the slot reached storage",
  );

  // A path no dialog established is refused, as on the desktop.
  await assert.rejects(
    link.invoke("project:save", [project, "/etc/passwd"]),
    /not established/,
  );

  // No menu bar: main's Help menu hangs from the header's book button, which
  // asks for it with `chiphippo:web-help-menu` (a second ask shuts it).
  const doc = first.window.document;
  assert.equal(doc.querySelector(".webhost-menubar"), null, "no menu bar");
  const book = doc.createElement("button");
  doc.body.append(book);
  const ask = () =>
    first.window.dispatchEvent(
      new first.window.CustomEvent("chiphippo:web-help-menu", {
        detail: { anchor: book },
      }),
    );
  ask();
  const card = doc.querySelector(".webhost-menu");
  assert.ok(card, "the Help menu opened");
  const items = [...card.querySelectorAll(".popup-menu-label")].map(
    (n) => n.textContent,
  );
  for (const want of [
    "Chip Hippo User Guide",
    "Keyboard Shortcuts",
    "About Chip Hippo",
  ]) {
    assert.ok(items.includes(want), `${want} in ${items.join(", ")}`);
  }
  assert.ok(!items.includes("Save"), "only Help's items");
  assert.equal(book.getAttribute("aria-expanded"), "true");
  ask();
  assert.equal(
    doc.querySelector(".webhost-menu"),
    null,
    "a second ask shuts it",
  );
  assert.equal(book.getAttribute("aria-expanded"), "false");

  // A reload: a new tab over the same storage.
  const second = await bootTab(databases);
  const again = await second.link.invoke("project:boot", []);
  assert.equal(again.tabs[0].name, "Bench", "the saved project came back");
});

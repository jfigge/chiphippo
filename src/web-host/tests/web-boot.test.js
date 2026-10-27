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

/** Every URL the site was asked for, in order (the boot-path test). */
const fetched = [];

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
    fetched.push(rel);
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

/** Boot main in a fresh tab over `databases`; resolve the renderer's link.
    `beforeImport(window)` dresses the tab first (a picker stand-in). */
async function bootTab(databases, { beforeImport } = {}) {
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
  beforeImport?.(window);
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

/**
 * A File System Access handle on a fake disk; `fail` makes its writes throw.
 * The fake IndexedDB stores records by structuredClone, which a real handle
 * survives and this one would not — `cloneable` lets it through for a test.
 */
function fakeHandle(name, { fail = null, delayMs = 0 } = {}) {
  const disk = { bytes: new Uint8Array(0), lastModified: 1 };
  const handle = {
    kind: "file",
    name,
    disk,
    queryPermission: async () => "granted",
    requestPermission: async () => "granted",
    isSameEntry: async (other) => other === handle,
    getFile: async () =>
      Object.assign(new Blob([disk.bytes]), {
        lastModified: disk.lastModified,
      }),
    createWritable: async () => ({
      write: async (bytes) => {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (fail) throw Object.assign(new Error(fail), { name: "Locked" });
        disk.bytes = new Uint8Array(bytes);
        disk.lastModified += 1;
      },
      close: async () => {},
    }),
  };
  return handle;
}

async function cloneable(fn) {
  const real = globalThis.structuredClone;
  globalThis.structuredClone = (v) => {
    try {
      return real(v);
    } catch {
      return v;
    }
  };
  try {
    return await fn();
  } finally {
    globalThis.structuredClone = real;
  }
}

test("a Save As the visitor's disk refuses keeps the working slot", () =>
  cloneable(async () => {
    const databases = new Map();
    const handle = fakeHandle("Bench.chiphippo", { fail: "locked" });
    const { link } = await bootTab(databases, {
      beforeImport: (w) => {
        w.showSaveFilePicker = async () => handle;
        w.showOpenFilePicker = async () => [handle];
      },
    });
    const project = await link.invoke("project:boot", []);
    project.tabs[0].name = "Bench";
    assert.equal((await link.invoke("project:save", [project, null])).ok, true);
    const files = databases.get("chiphippo").stores.get("files");
    const SLOT = "/userData/saves/default.chiphippo";
    assert.ok(files.has(SLOT), "the slot reached storage");

    const target = await link.invoke("project:choose-path", [
      "project",
      "Bench",
      null,
    ]);
    await assert.rejects(
      link.invoke("project:save", [{ ...project, name: "Bench" }, target]),
      /locked/,
      "the save is answered as the refusal it was",
    );
    assert.ok(files.has(SLOT), "the slot is still in storage");
    assert.ok(
      !(await link.invoke("project:recent:list", [])).includes(target),
      "nor is the file it never reached in Open Recent",
    );

    // …and a reload still finds the work.
    const second = await bootTab(databases, {
      beforeImport: (w) => {
        w.showSaveFilePicker = async () => handle;
        w.showOpenFilePicker = async () => [handle];
      },
    });
    const again = await second.link.invoke("project:boot", []);
    assert.equal(again.tabs[0].name, "Bench");
  }));

test("a refused Save As puts back the recent a full list pushed off", () =>
  cloneable(async () => {
    const databases = new Map();
    let next = null;
    const { link } = await bootTab(databases, {
      beforeImport: (w) => {
        w.showSaveFilePicker = async () => next;
        w.showOpenFilePicker = async () => [next];
      },
    });
    const project = await link.invoke("project:boot", []);
    const saveAs = async (name, opts) => {
      next = fakeHandle(`${name}.chiphippo`, opts);
      const target = await link.invoke("project:choose-path", [
        "project",
        name,
        null,
      ]);
      return link.invoke("project:save", [{ ...project, name }, target]);
    };
    for (let i = 1; i <= 10; i++)
      assert.equal((await saveAs(`P${i}`)).ok, true);
    const before = await link.invoke("project:recent:list", []);
    assert.equal(before.length, 10, "the list is full");

    await assert.rejects(saveAs("Locked", { fail: "locked" }), /locked/);
    assert.deepEqual(
      await link.invoke("project:recent:list", []),
      before,
      "Open Recent is exactly what it was, its tenth entry included",
    );
  }));

test("a visit that re-read a newer file leaves storage holding it", () =>
  cloneable(async () => {
    const databases = new Map();
    const handle = fakeHandle("Bench.chiphippo");
    let permission = "granted";
    handle.queryPermission = async () => permission;
    const pickers = (w) => {
      w.showSaveFilePicker = async () => handle;
      w.showOpenFilePicker = async () => [handle];
    };
    // Saved from the web…
    const first = await bootTab(databases, { beforeImport: pickers });
    const project = await first.link.invoke("project:boot", []);
    const target = await first.link.invoke("project:choose-path", [
      "project",
      "Bench",
      null,
    ]);
    project.tabs[0].name = "v2 (from the web)";
    await first.link.invoke("project:save", [
      { ...project, name: "Bench" },
      target,
    ]);
    // …then newer from the desktop app.
    const onDisk = JSON.parse(new TextDecoder().decode(handle.disk.bytes));
    onDisk.tabs[0].name = "v3 (newer, on disk)";
    handle.disk.bytes = new TextEncoder().encode(JSON.stringify(onDisk));
    handle.disk.lastModified += 1000;
    // A visit the browser lets read it, saving nothing…
    const second = await bootTab(databases, { beforeImport: pickers });
    const read = await second.link.invoke("project:boot", []);
    assert.equal(read.tabs[0].name, "v3 (newer, on disk)");
    // …and one it does not: storage's copy is the one the time is for.
    permission = "prompt";
    const third = await bootTab(databases, { beforeImport: pickers });
    const booted = await third.link.invoke("project:boot", []);
    assert.equal(booted.tabs[0].name, "v3 (newer, on disk)");
  }));

test("a refused write-back is answered to the save, not a call beside it", () =>
  cloneable(async () => {
    const handle = fakeHandle("Bench.chiphippo", {
      fail: "disk full",
      delayMs: 20,
    });
    const { link } = await bootTab(new Map(), {
      beforeImport: (w) => {
        w.showSaveFilePicker = async () => handle;
        w.showOpenFilePicker = async () => [handle];
      },
    });
    const project = await link.invoke("project:boot", []);
    const target = await link.invoke("project:choose-path", [
      "project",
      "Bench",
      null,
    ]);
    const meta = { ...project, name: "Bench" };
    const outcome = (p) =>
      p.then(
        () => "ok",
        (e) => e.message,
      );
    // The autosave's stash goes out just before ⌘S, and a reader beside both.
    const [stash, save, read] = await Promise.all([
      outcome(link.invoke("project:recovery:write", [meta, target])),
      outcome(link.invoke("project:save", [meta, target])),
      outcome(link.invoke("settings:get", [])),
    ]);
    assert.equal(stash, "ok");
    assert.match(save, /disk full/);
    assert.equal(read, "ok");
  }));

test("the boot waits on no version.json, and on two catalogs only", async () => {
  fetched.length = 0;
  const { link } = await bootTab(new Map());
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const info = await link.invoke("app:info:get", []);
  assert.equal(info.version, pkg.version, "compiled in");
  assert.ok(!fetched.includes("version.json"), fetched.join(", "));
  // English and the start language come first; the rest follow the boot.
  const locales = fetched.filter((r) => r.startsWith("locales/"));
  assert.ok(locales.slice(0, 2).includes("locales/en.json"), locales.join());
});

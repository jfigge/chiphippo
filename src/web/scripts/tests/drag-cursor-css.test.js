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

// The drag cursor (styles/app.css): while anything on the desk is grabbed the
// viewport carries `desk-viewport--dragging` (or `--wire-dragging`) and the
// closed hand shows over everything. It used to say so with `cursor` on the
// viewport and `.desk-viewport--dragging *`; `cursor` inherits, so that
// restyled EVERY element on the desk on the press and again on the drop
// (busy64: 62 ms each, most of a drag's remaining latency). One overlay
// pseudo-element says it now — pinned here so the cost cannot creep back.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs
  .readFileSync(path.join(here, "../../styles/app.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** Every `selector { body }` rule, comments stripped (no nesting in app.css). */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1].replace(/\s+/g, " ").trim(),
  body: m[2],
}));

const DRAG = /desk-viewport--(wire-)?dragging/;

test("the drag cursor is one overlay over the viewport", () => {
  for (const cls of ["dragging", "wire-dragging"]) {
    const overlay = rules.find((r) =>
      r.selector
        .split(",")
        .some((s) => s.trim() === `.desk-viewport--${cls}::after`),
    );
    assert.ok(overlay, `an ::after overlay for desk-viewport--${cls}`);
    assert.match(overlay.body, /cursor:\s*grabbing/);
    assert.match(overlay.body, /inset:\s*0/);
  }
});

test("the drag classes never change a cursor the desk inherits", () => {
  for (const r of rules) {
    if (!DRAG.test(r.selector) || !/cursor:/.test(r.body)) continue;
    for (const part of r.selector.split(",")) {
      if (!DRAG.test(part)) continue;
      assert.ok(
        part.trim().endsWith("::after"),
        `the drag class restyles the desk's cursor: ${part.trim()}`,
      );
    }
  }
});

// The same for the other cursors that are the whole viewport's — Space held,
// a pan, the rubber band — and for pin mode, which is toggled on every
// Option press: none restyles the desk (runtime review N1's leftovers,
// 2026-10-27).
const OVERLAID = ["pan-ready", "panning", "selecting"];

test("Space's open hand, a pan's closed hand and the band's crosshair are overlays too", () => {
  const want = { "pan-ready": "grab", panning: "grabbing", selecting: "crosshair" }; // prettier-ignore
  for (const cls of OVERLAID) {
    const own = rules.filter((r) =>
      r.selector
        .split(",")
        .some((s) => s.trim() === `.desk-viewport--${cls}::after`),
    );
    assert.ok(own.some((r) => /inset:\s*0/.test(r.body)), `an overlay for --${cls}`); // prettier-ignore
    // The last rule naming it alone says its cursor.
    const last = own.filter((r) => /cursor:/.test(r.body)).at(-1);
    assert.match(last.body, new RegExp(`cursor:\\s*${want[cls]}\\b`), cls);
  }
});

test("neither those classes nor pin mode restyle every element: no `*`, no cursor on the viewport itself", () => {
  const CLS = /desk-viewport--(pan-ready|panning|selecting|pin-mode)\b/;
  for (const r of rules) {
    if (!/cursor:/.test(r.body)) continue;
    for (const part of r.selector.split(",").map((s) => s.trim())) {
      if (!CLS.test(part)) continue;
      assert.ok(!/\*/.test(part), `a universal selector: ${part}`);
      assert.ok(
        part.endsWith("::after") || / /.test(part),
        `the viewport's own cursor: ${part}`,
      );
    }
  }
});

// The TOOL cursors (placing, probing, wiring, Cut Track, the bus tool, and the
// run's arrow): a tool needs the real element under the pointer, so no
// overlay — the bare desk is a `::before` under every layer and the item the
// pointer is over takes the cursor by `:hover`. Never `cursor` on the viewport
// itself or on `*`, which restyled every element on the desk at each arm and
// disarm (busy64 ~60 ms; Jason accepted ~0.6 ms a board crossing while a tool
// is armed, 2026-10-27).
const TOOLS = { placing: "crosshair", probing: "pointer", wiring: "crosshair", cutting: "crosshair", bus: "crosshair", running: "default" }; // prettier-ignore

test("each tool's cursor is on the bare desk's ::before and on the item hovered", () => {
  for (const [cls, cursor] of Object.entries(TOOLS)) {
    const with_ = (want) =>
      rules.filter(
        (r) =>
          r.selector.split(",").some((s) => s.trim() === want) &&
          new RegExp(`cursor:\\s*${cursor}\\b`).test(r.body),
      );
    assert.ok(with_(`.desk-viewport--${cls}::before`).length, `--${cls}'s ::before says ${cursor}`); // prettier-ignore
    for (const item of ["board", "part", "wire"]) {
      const sel = `:where(.${item}:is(.desk-viewport--${cls} .${item}):hover)`;
      assert.ok(with_(sel).length, `a hovered ${item} under --${cls} says ${cursor}`); // prettier-ignore
    }
  }
});

test("no tool class sets a cursor the whole desk inherits", () => {
  const CLS = new RegExp(`desk-viewport--(${Object.keys(TOOLS).join("|")})\\b`);
  for (const r of rules) {
    if (!/cursor:/.test(r.body)) continue;
    for (const part of r.selector.split(",").map((s) => s.trim())) {
      if (!CLS.test(part)) continue;
      assert.ok(!/\*/.test(part), `a universal selector: ${part}`);
      assert.ok(
        part.endsWith("::before") ||
          part.endsWith("::after") ||
          / |>/.test(part),
        `the viewport's own cursor: ${part}`,
      );
    }
  }
});

// ── What the tool lists must name ───────────────────────────────────────────
// The lists above are kept by hand, and a tool cursor goes missing silently: a
// new kind of layer item, or a new piece of the viewport's chrome, shows the
// bare desk's arrow under an armed tool until it joins all six. So the lists
// are held to what the desk REALLY mounts — the chrome read off app.js's own
// boot (the viewport's children but the surface), the item roots off a
// controller holding one of everything (each layer's children, by their first
// class) — and each tool must name exactly those, no fewer and no more.

/** The `.desk-viewport`'s children after a real boot of app.js — the bridge
    stubbed to the shape app-boot.test.js answers with. */
async function bootedChrome() {
  const { resetDom } = await import("./jsdom-setup.js");
  const { emptyDocument } = await import("../model/desk-doc.js");
  const EN = JSON.parse(
    fs.readFileSync(path.join(here, "../../locales/en.json"), "utf8"),
  );
  const ok = async () => ({ ok: true });
  const win = resetDom();
  win.chiphippo = {
    platform: "darwin",
    i18n: { load: async () => ({ active: "en", lang: "en", messages: EN, fallback: EN, locales: [{ code: "en", nativeName: "English" }] }) }, // prettier-ignore
    closeReply: ok,
    getAppInfo: async () => ({ version: "0.0.0-test", distribution: "direct" }),
    settings: { get: async () => ({}), set: ok },
    ai: { providers: async () => [], key: { status: async () => ({ configured: false }) } }, // prettier-ignore
    project: { boot: async () => ({ version: 5, name: "", activeTab: "t1", nextIndex: 2, tabs: [{ id: "t1", name: "Desktop 1", doc: emptyDocument() }] }) }, // prettier-ignore
    mem: { create: ok, delete: ok },
    menu: { setEditState: ok, setDesktopState: ok },
    openPinout: ok,
  };
  globalThis.window.chiphippo = win.chiphippo;
  document.body.innerHTML = '<div id="app"></div>';
  const { booted } = await import("../app.js");
  await booted;
  const viewport = document.querySelector(".desk-viewport");
  return [...viewport.children]
    .map((c) => c.classList[0])
    .filter((c) => c !== "desk-surface");
}

/** The roots of every item the desk's layers hold, with one of everything on
    the desk: each layer's children by their first class — through the wire
    layer's one svg, which every wire and band is drawn into — but the
    overlay's, which never takes the pointer. */
async function itemRoots() {
  const { resetDom } = await import("./jsdom-setup.js");
  const { DeskDoc } = await import("../model/desk-doc.js");
  const { DeskController } = await import("../components/desk-controller.js");
  resetDom();
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0);
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb2", anchor: "e5" });
  doc.addComponent({ kind: "discrete", ref: "led", board: "bb2", anchor: "a40", params: { color: "red" } }); // prettier-ignore
  const psu = doc.addBrick("psu", -40, 0, {});
  doc.addBrick("clock", -40, 20, {});
  const w1 = doc.addWire({ from: "bb2.a2", to: "bb2.a30", color: "red" });
  const w2 = doc.addWire({ from: "bb2.b2", to: "bb2.b30", color: "red" });
  doc.addWire({ from: `${psu.id}.+`, to: "bb2.c3", color: "red" });
  const w4 = doc.addWire({ from: "bb2.c10", to: "bb2.c33", color: "red" });
  doc.setWireRoute(w4.id, [{ x: 20, y: -5 }]);
  doc.addBus("D", [w1.id, w2.id]);
  const sig = doc.addSignal({ name: "RST" });
  doc.plantSignalFlag(sig.id, "bb2.i3");
  const out = doc.addIntegration({ kind: "output", width: 1 });
  doc.plantIntegrationTag(out.id, "1", "bb2.i9");
  doc.addAnnotation("label", 10, -8, "hello");
  const viewport = document.createElement("section");
  viewport.className = "desk-viewport";
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const deskView = { surface, camera: { cx: 0, cy: 0, zoom: 1 }, worldFromEvent: () => ({ x: 0, y: 0 }) }; // prettier-ignore
  const controller = new DeskController({ viewport, deskView, deskDoc: doc });
  controller.loadDocument(doc.toJSON());
  // The meter mounted after the load, as the toolbar adds one.
  const meter = controller.addBrickAt("meter", 120, 0, {});
  assert.ok(meter, "a meter on the desk");
  const roots = new Set();
  for (const layer of surface.children) {
    if (layer.classList.contains("layer-overlay")) continue;
    const items = [...layer.children].flatMap((c) =>
      c.classList.contains("wire-svg") ? [...c.children] : [c],
    );
    assert.ok(items.length, `the fixture puts something in ${layer.className}`); // prettier-ignore
    for (const item of items) roots.add(item.getAttribute("class").split(/\s+/)[0]); // prettier-ignore
  }
  return [...roots];
}

test("each tool names every layer item root and every piece of the viewport's chrome", async () => {
  const chrome = await bootedChrome();
  const items = await itemRoots();
  // The counts the lists carried when this test was written — a change is a
  // new kind of item or chrome, which every tool's list has to take.
  assert.equal(items.length, 9, `item roots: ${items.join(", ")}`);
  assert.equal(chrome.length, 6, `chrome: ${chrome.join(", ")}`);
  for (const [cls, cursor] of Object.entries(TOOLS)) {
    const named = rules
      .filter((r) => new RegExp(`cursor:\\s*${cursor}\\b`).test(r.body))
      .flatMap((r) => r.selector.split(",").map((s) => s.trim()));
    const listedItems = named
      .map(
        (s) =>
          s.match(
            new RegExp(
              `^:where\\(\\.([\\w-]+):is\\(\\.desk-viewport--${cls} \\.\\1\\):hover\\)$`,
            ),
          )?.[1],
      ) // prettier-ignore
      .filter(Boolean);
    const listedChrome = named
      .map(
        (s) =>
          s.match(
            new RegExp(`^:where\\(\\.desk-viewport--${cls} > \\.([\\w-]+)\\)$`),
          )?.[1],
      ) // prettier-ignore
      .filter(Boolean);
    assert.deepEqual([...listedItems].sort(), [...items].sort(), `--${cls}'s hovered items`); // prettier-ignore
    assert.deepEqual([...listedChrome].sort(), [...chrome].sort(), `--${cls}'s chrome`); // prettier-ignore
  }
  // And the overlay the item roots leave out really never takes the pointer.
  const overlay = rules.filter((r) => r.selector === ".layer-overlay");
  assert.ok(overlay.some((r) => /pointer-events:\s*none/.test(r.body)), ".layer-overlay is pointer-inert"); // prettier-ignore
});

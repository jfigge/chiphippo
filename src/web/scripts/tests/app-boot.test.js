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

// app-boot.test.js — app.js's init() mounted for real, once.
//
// THIS FILE EXISTS BECAUSE app.js WAS MOUNTED BY NO TEST AT ALL. It is the
// renderer's composition root: one function wiring the header, both toolbar
// pills, every docked panel, the desk, the schematic, the transport, the
// workspace and every application-menu push — the widest blast radius in the
// app and the only module with nothing under it. A step wired in the wrong
// order, a button appended to a pill that does not exist yet, a panel handed a
// controller that is still null: every one of those is a blank window at
// launch, and none of them is visible from any other test.
//
// It is deliberately a SMOKE test, not a behavioural one. What it pins is that
// the boot RUNS TO COMPLETION and leaves the shell standing — the header, both
// pills with their full segment counts, the desk, the tab strip, a titled
// window — plus the handful of orderings that are load-bearing and silent when
// broken (the transport's collapsed segments, the AI segment disabled with no
// key, the always-answer menu items registered before anything that can fail).
// Each panel's own behaviour is its own test's business.
//
// Importing app.js IS running it — the module self-invokes and exports the
// promise — so this file mounts the app exactly once and every test awaits the
// same boot.

import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resetDom } from "./jsdom-setup.js";
import { emptyDocument } from "../model/desk-doc.js";
import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";

// app.js awaits `i18n.init()` before anything renders, and that REPLACES
// whatever catalog was installed with main's payload — so the stub has to
// serve the real one, or every label on the shell reads as its dotted key.
const EN = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../locales/en.json",
    ),
    "utf8",
  ),
);

// ── The bridge, stubbed ─────────────────────────────────────────────────────
// Everything init() reaches for on `window.chiphippo`. Each answers the
// SHAPE the real preload returns and nothing more; a missing key surfaces as a
// boot that throws, which is exactly what this file is here to catch.
const calls = { settingsSet: [] };

function stubBridge() {
  const ok = async () => ({ ok: true });
  return {
    platform: "darwin",
    i18n: {
      load: async () => ({
        active: "en",
        lang: "en",
        messages: EN,
        fallback: EN,
        locales: [{ code: "en", nativeName: "English" }],
      }),
    },
    closeReply: async () => ({ ok: true }),
    getAppInfo: async () => ({ version: "0.0.0-test", distribution: "direct" }),
    settings: {
      get: async () => ({}),
      set: async (patch) => {
        calls.settingsSet.push(patch);
        return { ok: true };
      },
    },
    // No API key configured — the state a fresh install boots into, and the
    // one that decides whether the AI segment is offered at all.
    ai: {
      providers: async () => [{ id: "anthropic", label: "Anthropic" }],
      key: { status: async () => ({ configured: false }) },
    },
    project: {
      // One empty desktop: what `project:boot` always answers with.
      boot: async () => ({
        version: 5,
        name: "",
        activeTab: "t1",
        nextIndex: 2,
        tabs: [{ id: "t1", name: "Desktop 1", doc: emptyDocument() }],
      }),
    },
    mem: { create: ok, delete: ok },
    menu: { setEditState: ok, setDesktopState: ok },
    openPinout: ok,
  };
}

const win = resetDom();
win.chiphippo = stubBridge();
globalThis.window.chiphippo = win.chiphippo;
// index.html carries no markup but this one node; the whole shell is built
// into it.
document.body.innerHTML = '<div id="app"></div>';

// ONE import, ONE boot — awaited by every test below.
const { booted } = await import("../app.js");
await booted;

const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];

test("the boot runs to completion and leaves the shell standing", () => {
  assert.ok(q(".app-header"), "header");
  assert.ok(q("#app-toolbar"), "toolbar slot");
  assert.ok(q(".app-main"), "main row");
  assert.ok(q(".app-stage"), "stage");
  assert.ok(q(".desk-viewport"), "desk");
  assert.ok(q(".schematic-viewport"), "schematic surface");
  assert.ok(q(".project-tabs"), "desktop tab strip");
  assert.ok(q(".palette-panel, .palette"), "parts palette");
});

test("the toolbar carries exactly the three pills, in order", () => {
  // Order IS the layout — the toolbar has no CSS ordering of its own.
  const pills = qa("#app-toolbar .toolbar-pill");
  assert.equal(pills.length, 3, "File · desk tools · transport");
  assert.ok(
    pills[2].classList.contains("toolbar-pill--transport"),
    "the transport pill is last",
  );
});

test("the File pill offers New / Open / Save / Save As, each its own segment", () => {
  // Four peers behind no ▾ — the shape the redesign settled on.
  const file = qa("#app-toolbar .toolbar-pill")[0];
  const segments = file.querySelectorAll(".toolbar-pill-btn");
  assert.equal(segments.length, 4);
  for (const btn of segments) {
    assert.ok(btn.getAttribute("aria-label"), "each names itself for a reader");
    assert.ok(btn.title, "and carries its accelerator in the tooltip");
  }
});

test("the desk-tool pill is built in full; AI and Generate are the disabled ones", () => {
  const tools = qa("#app-toolbar .toolbar-pill")[1];
  const segments = [...tools.querySelectorAll(".toolbar-pill-btn")];
  // Wire · Bus · Auto-route · Fade · Probe · Analyzer · Fit · BOM · Schematic ·
  // 3D view · AI · Generate.
  assert.equal(segments.length, 12);
  // The 3D view's segment is built, but HIDDEN until Settings ▸ Appearance ▸
  // 3D enabled is On (Off by default), and the app opens on the breadboard:
  // the segment offers the 3D view, it is not showing it.
  const view3d = segments.find(
    (b) => b.getAttribute("aria-label") === t("toolbar.view3d.show"),
  );
  assert.ok(view3d, "the 3D view segment exists");
  assert.equal(view3d.hidden, true, "hidden while 3D is not enabled");
  assert.equal(view3d.disabled, false);
  assert.equal(view3d.getAttribute("aria-pressed"), "false");
  assert.ok(q(".desk3d-viewport").hidden, "the 3D view starts hidden");
  const disabled = segments.filter((b) => b.disabled);
  // AI has no connection to ask; Generate has no Output or Input on an empty
  // desk to write a header for. Nothing else starts disabled.
  assert.deepEqual(disabled, segments.slice(-2), "the pill's last two");
  const [ai, generate] = disabled;
  assert.equal(ai.getAttribute("aria-label"), t("toolbar.ai.label"));
  // With no key it must say WHY, since the tooltip is the only explanation a
  // disabled button gets — the description would be no explanation at all.
  assert.ok(ai.title, "a disabled AI segment explains itself");
  assert.notEqual(ai.title, t("toolbar.ai.title"));
  assert.equal(
    generate.getAttribute("aria-label"),
    t("toolbar.generate.label"),
  );
  assert.equal(
    generate.title,
    t("toolbar.generate.none"),
    "and so does Generate",
  );
});

test("3D enabled shows the 3D segment; switching it off hides it and leaves the 3D view", () => {
  const segment = () =>
    qa("#app-toolbar .toolbar-pill-btn").find(
      (b) =>
        b.getAttribute("aria-label") === t("toolbar.view3d.show") ||
        b.getAttribute("aria-label") === t("toolbar.view3d.hide"),
    );
  const setting = (view3dEnabled) =>
    window.dispatchEvent(
      new CustomEvent("chiphippo:settings-changed", {
        detail: { view3dEnabled },
      }),
    );
  assert.equal(segment().hidden, true, "Off by default");

  setting(true);
  assert.equal(segment().hidden, false, "On shows it");
  segment().click();
  assert.equal(segment().getAttribute("aria-pressed"), "true");
  assert.ok(q(".desk-viewport").hidden, "the 3D view is showing");

  // Off while the 3D view is up: the segment goes, and so does the view —
  // the segment was the way back to the breadboard.
  setting(false);
  assert.equal(segment().hidden, true, "Off hides it");
  assert.equal(segment().getAttribute("aria-pressed"), "false");
  assert.equal(q(".desk-viewport").hidden, false, "back on the breadboard");
  assert.ok(q(".desk3d-viewport").hidden);
});

test("the Wire and Bus segments carry their readouts", () => {
  // Each is a <span> INSIDE the one <button> — a nested <button> is invalid
  // HTML, and re-splitting the segment is what the redesign removed.
  const dot = q(".wire-swatch-dot");
  const badge = q(".bus-width-badge");
  assert.ok(dot && badge);
  assert.equal(dot.tagName, "SPAN");
  assert.equal(badge.tagName, "SPAN");
  assert.equal(
    dot.closest("button")?.className.includes("toolbar-pill-btn"),
    true,
  );
  assert.equal(
    badge.closest("button")?.className.includes("toolbar-pill-btn"),
    true,
  );
});

test("stopped, the transport offers Run alone", () => {
  // The one pill whose segment count changes: Pause / Step / speed are hidden
  // until the circuit runs, so it never offers a control that does not apply.
  const transport = q(".toolbar-pill--transport");
  const segments = [...transport.querySelectorAll(".toolbar-pill-btn")];
  assert.equal(segments.length, 4);
  assert.equal(segments.filter((b) => !b.hidden).length, 1);
  assert.ok(segments[0].textContent.includes("Run"));
});

test("the window is titled from the booted project", () => {
  // The workspace is built late in init(); a title still reading "Chip Hippo"
  // means the boot never reached it.
  assert.match(document.title, /Desktop 1/);
  assert.match(document.title, /Chip Hippo/);
  assert.doesNotMatch(
    document.title,
    /^• /,
    "a freshly booted project is clean",
  );
});

// ── Order matters below here ────────────────────────────────────────────────
// Every test in this file shares ONE boot — the module self-invokes, so there
// is one app and one project for the file. The read-only checks above are in
// any order; these two are not. The close guard is asked FIRST, while the
// booted project is still pristine, because the menu test after it genuinely
// adds a desktop — and an app with unsaved work answers the guard with a
// question instead of a reply, which is right, and would look exactly like a
// guard that never answered.

test("the close guard answers, and answers TRUE for an untouched project", () => {
  // Main latches until this replies, so anything less than an answer is an app
  // that can never be closed again.
  let replied = null;
  window.chiphippo.closeReply = async (ok) => {
    replied = ok;
    return { ok: true };
  };
  window.dispatchEvent(new CustomEvent("chiphippo:confirm-close"));
  // The handler is async and the answer crosses several awaits, so poll rather
  // than guess a tick count — a slow answer must read as slow, not as none.
  return new Promise((resolve, reject) => {
    let tries = 0;
    const poll = () => {
      if (replied !== null) {
        assert.equal(replied, true, "a pristine project closes silently");
        return resolve();
      }
      if (++tries > 200) {
        return reject(new Error("the close guard never answered"));
      }
      setTimeout(poll, 1);
    };
    poll();
  });
});

test("the application menu's pushes are live and reach the workspace", async () => {
  // The menu is main's; every item is a one-way push the renderer answers, and
  // a push nothing listens for is a menu item that silently does nothing. The
  // read-only ones only have to not throw.
  for (const event of [
    "chiphippo:show-about",
    "chiphippo:keyboard-shortcuts",
    "chiphippo:build-guide",
    "chiphippo:edit-undo",
    "chiphippo:edit-redo",
    "chiphippo:edit-select-all",
  ]) {
    assert.doesNotThrow(
      () => window.dispatchEvent(new CustomEvent(event)),
      event,
    );
  }
  PopupManager.close(); // About / Shortcuts leave a card up

  // Desktop ▸ New Desktop actually reaches ProjectWorkspace — the half a
  // doesNotThrow cannot see, since an unwired event throws nothing either.
  const before = document.querySelectorAll(".project-tab").length;
  assert.ok(before >= 1, "the strip is always on screen");
  window.dispatchEvent(new CustomEvent("chiphippo:desktop-add"));
  // app.js fires these as `void run()` — addTab is async, so let it land.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(
    document.querySelectorAll(".project-tab").length,
    before + 1,
    "New Desktop adds one",
  );
  // …and that edit marks the project unsaved, which is what puts the • in the
  // title the close guard then asks about.
  assert.match(document.title, /^• /);
});

test("a language change relabels the chrome in place, without reloading", async () => {
  // Chip Hippo NEVER reloads the window — an unsaved project lives only in
  // memory, so a reload would throw the user's work away to change a label.
  // Everything transient speaks the new language for free (it is built when it
  // opens); what needs walking is the persistent chrome, and a relabel that
  // MISSES a control is silent — the old word simply stays on screen.
  //
  // A marked catalog rather than a shipped translation: this asserts the KEY is
  // consulted, without tying the test to anyone's choice of German.
  const marked = JSON.parse(JSON.stringify(EN));
  marked.toolbar.wire.label = "«wire»";
  marked.toolbar.bom.label = "«bom»";
  marked.toolbar.file.new = "«new»";
  marked.app.deskHint = "«hint»";
  marked.toolbar.transport.step = "«step»";
  marked.toolbar.route.label = "«route»";
  window.chiphippo.i18n.load = async () => ({
    active: "de",
    lang: "de",
    messages: marked,
    fallback: EN,
    locales: [{ code: "en", nativeName: "English" }],
  });

  const relabelled = new Promise((resolve) =>
    window.addEventListener("chiphippo:locale-changed", resolve, {
      once: true,
    }),
  );
  window.dispatchEvent(
    new CustomEvent("chiphippo:settings-changed", { detail: { locale: "de" } }),
  );
  await relabelled;

  const tools = qa("#app-toolbar .toolbar-pill")[1];
  const segments = [...tools.querySelectorAll(".toolbar-pill-btn")];
  // A label inside a segment (the Wire tool's, beside its colour dot)…
  assert.equal(
    segments[0].querySelector("span:not(.wire-swatch-dot)").textContent,
    "«wire»",
  );
  // …an aria-label on an icon-only one…
  assert.ok(
    segments.some((b) => b.getAttribute("aria-label") === "«bom»"),
    "the BOM segment relabelled",
  );
  // …the Auto-route action, once missing from the relabel list…
  assert.ok(
    segments.some((b) => b.getAttribute("aria-label") === "«route»"),
    "the Auto-route segment relabelled",
  );
  // …the File pill, which is a different builder…
  const file = qa("#app-toolbar .toolbar-pill")[0];
  assert.equal(
    file.querySelector(".toolbar-pill-btn").getAttribute("aria-label"),
    "«new»",
  );
  // …and every tooltip's placeholders filled — the Open button's relabel once
  // left a literal "{recent}" in it.
  const tips = [...file.querySelectorAll(".toolbar-pill-btn")].map((b) => b.title); // prettier-ignore
  assert.ok(
    tips.every((tip) => !/\{\w+\}/.test(tip)),
    tips.join(" | "),
  );
  // …the transport, whose text carries an untranslated glyph in front of it…
  assert.match(q(".toolbar-pill--transport").textContent, /⇥ «step»/);
  // …and the desk itself, which is not in any pill.
  assert.equal(q(".desk-hint").textContent, "«hint»");
});

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

// The chip designer window's view (components/chip-designer-view.js). Its
// left half is the package drawing, which stays at the top, and the form under
// a rule, which scrolls on its own. Every edit, and every echo of one, redraws
// both wholesale, and the panes must stay where the reader had them. The
// browser's scroll anchoring is what threw them (its anchor is a node the
// redraw replaced), so it is switched off on them in app.css — and the view
// puts the offsets back itself.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { resetDom } from "./jsdom-setup.js";
import { newCustomChip, setPorts, setUnitCount } from "../model/custom-chip.js";

const { ChipDesignerView } =
  await import("../components/chip-designer-view.js");

function mount({ layout, onLayout } = {}) {
  resetDom();
  const root = document.createElement("div");
  document.body.append(root);
  const sent = [];
  const view = new ChipDesignerView(root, {
    send: (msg) => sent.push(msg),
    layout,
    onLayout,
  });
  const a = newCustomChip([]);
  const b = newCustomChip([a]);
  const state = ({
    focus = a.id,
    designs = [a, b],
    tokens = {},
    debug = null,
  } = {}) => ({
    kind: "state",
    mode: "design",
    designs,
    open: [a.id, b.id],
    focus,
    uses: {},
    tokens,
    notice: null,
    debug,
  });
  view.receive(state());
  return {
    root,
    view,
    sent,
    a,
    b,
    state,
    pkg: root.querySelector(".cd-package"),
    pane: root.querySelector(".cd-form-pane"),
    problems: root.querySelector(".cd-problems"),
  };
}

/** Lose `pane`'s offset whenever one of `hosts` has its content swapped —
    what scroll anchoring did to the real window on every redraw. */
function loseOffsetOnRedraw(pane, ...hosts) {
  for (const host of hosts) {
    const swap = host.replaceChildren.bind(host);
    host.replaceChildren = (...nodes) => {
      pane.scrollTop = 0;
      swap(...nodes);
    };
  }
}

/** app.css as `[selectors, declarations]` pairs, comments stripped. Flat
    rules only — which is all the designer uses. */
function cssRules() {
  const css = fs
    .readFileSync(new URL("../../styles/app.css", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => [
    sel.split(",").map((s) => s.trim()),
    body,
  ]);
}

/** The declarations of the rule whose selector is exactly `selector`. */
const ruleOf = (selector) =>
  cssRules().find(([sels]) => sels.length === 1 && sels[0] === selector)?.[1] ??
  "";

test("the package stays at the top; the form scrolls under the rule", () => {
  const { root, pkg, pane } = mount();
  const left = root.querySelector(".cd-left");
  assert.deepEqual(
    [...left.children].map((n) => n.className),
    ["cd-package", "cd-rule", "cd-form-pane"],
  );
  assert.ok(pane.contains(root.querySelector(".cd-form")));
  assert.ok(!pane.contains(pkg), "the drawing is not in the scrolled pane");
  const labels = [...pane.querySelectorAll(".cd-label")].map((l) => l.textContent); // prettier-ignore
  assert.deepEqual(labels.slice(0, 2), ["Part number", "Description"]);
  assert.equal(pane.querySelector("hr"), null, "the form draws no rule of its own"); // prettier-ignore

  assert.match(ruleOf(".cd-left"), /overflow:\s*hidden/);
  assert.match(ruleOf(".cd-form-pane"), /overflow:\s*auto/);
  assert.match(ruleOf(".cd-package"), /overflow:\s*auto/, "a package too tall for its share scrolls itself"); // prettier-ignore
});

test("debugging shows the package alone — no rule, no form", () => {
  const { root, view, a } = mount();
  const tab = {
    compId: "c1",
    ref: a.id,
    label: "U1",
    state: "idle",
    armed: { pin: false, settled: false },
    pinLevels: [],
    watch: [],
    unit: 0,
  };
  view.receive({
    kind: "state",
    mode: "debug",
    designs: [a],
    open: [a.id],
    focus: a.id,
    uses: {},
    tokens: {},
    notice: null,
    debug: { running: true, tabs: [tab], focus: "c1", settled: true },
  });
  assert.equal(root.querySelector(".cd-package").hidden, false);
  assert.equal(root.querySelector(".cd-rule").hidden, true);
  assert.equal(root.querySelector(".cd-form-pane").hidden, true);
});

test("an edit and its echo leave the form pane where it was", () => {
  const { root, view, sent, a, state, pkg, pane } = mount();
  pane.scrollTop = 240;
  pkg.scrollTop = 20;
  loseOffsetOnRedraw(pane, root.querySelector(".cd-form"));
  loseOffsetOnRedraw(pkg, pkg);

  const select = root.querySelector(`.cd-ports select[data-field^="map-"]`);
  select.value = [...select.options].find((o) => o.value !== select.value).value; // prettier-ignore
  select.dispatchEvent(new Event("change"));
  assert.equal(pane.scrollTop, 240, "the edit's own redraw");
  assert.equal(pkg.scrollTop, 20);

  const { chip, token } = sent.findLast((m) => m.kind === "update");
  assert.notDeepEqual(chip.units, a.units, "the pick was an edit");
  view.receive(state({ designs: [chip], tokens: { [chip.id]: token } }));
  assert.equal(pane.scrollTop, 240, "the host's echo");
  assert.equal(pkg.scrollTop, 20);
});

test("typing leaves the package and the problems list where they were", () => {
  const { root, pkg, problems } = mount();
  pkg.scrollTop = 20;
  problems.scrollTop = 30;
  loseOffsetOnRedraw(pkg, pkg);
  loseOffsetOnRedraw(problems, problems);

  const input = root.querySelector(".hdl-editor-input");
  input.value = "assign Y = A & B\n"; // a missing `;` — the problems change too
  input.dispatchEvent(new Event("input"));
  assert.equal(pkg.scrollTop, 20);
  assert.equal(problems.scrollTop, 30);
});

test("another design is not given the last one's offset", () => {
  const { root, view, b, state, pane } = mount();
  pane.scrollTop = 240;
  loseOffsetOnRedraw(pane, root.querySelector(".cd-form"));
  view.receive(state({ focus: b.id }));
  assert.equal(pane.scrollTop, 0);
});

test("every pane the designer redraws wholesale opts out of scroll anchoring", () => {
  const optedOut = new Set();
  for (const [sels, body] of cssRules()) {
    if (/overflow-anchor\s*:\s*none/.test(body)) for (const s of sels) optedOut.add(s); // prettier-ignore
  }
  for (const pane of [
    ".cd-tabs",
    ".cd-package",
    ".cd-form-pane",
    ".cd-problems",
    ".cd-watch-scroll",
  ]) {
    assert.ok(optedOut.has(pane), `${pane} must set overflow-anchor: none`);
  }
});

// ── The ports table carries the pin map ─────────────────────────────────────
//
// Each port's row ends in its pins — one column per unit — and a bus lists a
// row per bit under it. The pin columns scroll sideways on their own when the
// pane is too narrow, and a redraw leaves that scroller where it was.

test("each port's row carries its pins; a bus lists its bits under it", () => {
  const { root, view, a, state } = mount();
  const rows = () => [...root.querySelectorAll(".cd-port-row:not(.cd-port-row--head)")]; // prettier-ignore
  const pinsIn = (row) => row.querySelectorAll('select[data-field^="map-"]').length; // prettier-ignore
  // The fresh design's A, B, Y: one row each, one pin each.
  assert.deepEqual(rows().map(pinsIn), [1, 1, 1]);
  const head = root.querySelector(".cd-port-row--head");
  assert.deepEqual(
    [...head.querySelectorAll(".cd-port-unit")].map((n) => n.textContent),
    ["Pin"],
  );
  // Two units and a 4-bit bus: the bus row has no pins of its own, its four
  // bits have one per unit, and every column is a unit.
  const wide = setUnitCount(
    setPorts(a, [...a.ports, { name: "D", dir: "input", width: 4 }]),
    2,
  );
  view.receive(state({ designs: [wide] }));
  assert.deepEqual(rows().map(pinsIn), [2, 2, 2, 0, 2, 2, 2, 2]);
  assert.deepEqual(
    [...root.querySelectorAll(".cd-port-row--bit .cd-map-port")].map((n) => n.textContent), // prettier-ignore
    ["D0", "D1", "D2", "D3"],
  );
  assert.deepEqual(
    [...root.querySelectorAll(".cd-port-row--head .cd-port-unit")].map((n) => n.textContent), // prettier-ignore
    ["Unit 1", "Unit 2"],
  );
  assert.equal(root.querySelector(".cd-pin-map, .cd-map"), null, "no separate pin map"); // prettier-ignore
});

test("the pin columns scroll sideways, and an edit leaves them where they were", () => {
  const { root, sent } = mount();
  const scroller = () => root.querySelector(".cd-ports");
  assert.match(ruleOf(".cd-ports"), /overflow-x:\s*auto/);
  assert.match(ruleOf(".cd-port-cell--port"), /position:\s*sticky/);
  assert.match(ruleOf(".cd-port-cell--remove"), /position:\s*sticky/);
  scroller().scrollLeft = 80;
  const select = root.querySelector('.cd-ports select[data-field^="map-"]');
  select.value = [...select.options].find((o) => o.value !== select.value).value; // prettier-ignore
  select.dispatchEvent(new Event("change"));
  assert.ok(
    sent.some((m) => m.kind === "update"),
    "the pick was an edit",
  );
  assert.equal(scroller().scrollLeft, 80);
});

// ── The dividers ────────────────────────────────────────────────────────────

test("the dividers start where they were left, and a double-click puts them back", () => {
  const reported = [];
  const { root } = mount({
    layout: { leftWidth: 520, headerHeight: 90 },
    onLayout: (patch) => reported.push(patch),
  });
  const main = root.querySelector(".cd-main");
  const header = root.querySelector(".cd-code-header");
  assert.equal(main.style.getPropertyValue("--cd-left-width"), "520px");
  assert.equal(header.style.flexBasis, "90px");
  assert.equal(header.style.maxHeight, "none", "a height the user chose lifts the cap"); // prettier-ignore
  // The left divider sits between the halves; the header's under it.
  assert.deepEqual(
    [...main.children].map((n) => n.className),
    ["cd-left", "cd-split", "cd-right"],
  );
  assert.ok(header.nextElementSibling.classList.contains("cd-code-split"));
  root
    .querySelector(".cd-split")
    .dispatchEvent(new window.MouseEvent("dblclick"));
  root.querySelector(".cd-code-split").dispatchEvent(new window.MouseEvent("dblclick")); // prettier-ignore
  assert.equal(main.style.getPropertyValue("--cd-left-width"), "");
  assert.equal(header.style.flexBasis, "");
  assert.equal(header.style.maxHeight, "");
  assert.deepEqual(reported, [
    { chipDesignerLeftWidth: null },
    { chipDesignerHeaderHeight: null },
  ]);
  // The header scrolls when the code is short of room, rather than the code.
  assert.match(ruleOf(".cd-code-header"), /overflow-y:\s*auto/);
});

// ── Breakpoints in the gutter ───────────────────────────────────────────────

test("a line number clicked asks for a breakpoint; one is drawn solid or hollow", () => {
  const { root, view, a, sent, state } = mount();
  const code = "// a NAND\nassign Y = ~(A & B);\n";
  const chip = { ...a, code };
  view.receive(state({ designs: [chip] }));
  const row = (n) => root.querySelector(`.hdl-editor-lineno[data-line="${n}"]`); // prettier-ignore
  row(2).click();
  assert.deepEqual(sent.at(-1), {
    kind: "breakpoint",
    ref: a.id,
    line: 2,
    compId: null,
  });
  // The host's answer: line 2 runs, line 1 is a comment.
  view.receive(
    state({ designs: [chip], debug: { running: false, breakpoints: { [a.id]: [1, 2] } } }), // prettier-ignore
  );
  assert.ok(row(2).classList.contains("hdl-editor-lineno--break"));
  assert.ok(row(1).classList.contains("hdl-editor-lineno--break-idle"));
  assert.ok(!row(3).className.includes("--break"));
  // F9 asks for the caret's line.
  const input = root.querySelector(".hdl-editor-input");
  input.setSelectionRange(
    code.indexOf("assign") + 3,
    code.indexOf("assign") + 3,
  );
  input.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "F9", bubbles: true }),
  );
  assert.equal(sent.at(-1).line, 2);
});

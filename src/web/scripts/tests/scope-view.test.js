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

// jsdom smoke tests for ScopeView (Feature 210): recording the sim-state stream
// into waveforms, the empty state, and the Run-resets-the-trace behavior. The
// pure recording/decoding is covered by scope-recorder.test.js; this exercises
// the DOM/render pipeline (gutter rows + SVG lane building) end to end.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { ScopeView } = await import("../components/scope-view.js");
const { DeskDoc } = await import("../model/desk-doc.js");

/** A sim-state broadcast where one address carries `level`. */
/** One tick's broadcast (`sim-tick`, what the analyzer records) — or, for
    `stopped`, the sim-state that ends a run. */
function simEvent(mode, address, netId, level) {
  const type =
    mode === "stopped" ? "chiphippo:sim-state" : "chiphippo:sim-tick";
  return new window.CustomEvent(type, {
    detail: {
      mode,
      running: mode !== "stopped",
      netLevels: level == null ? new Map() : new Map([[netId, level]]),
      netlist: { netOfPoint: new Map([[address, netId]]) },
    },
  });
}

function makeView() {
  const doc = new DeskDoc(null);
  const netlist = {
    netOf: (a) => (a === "bb1.f12" ? "net1" : null),
    // The name AT a point (NetlistCache.nameAt) — what a channel's label reads.
    nameAt: (a) => (a === "bb1.f12" ? "CLK" : null),
  };
  const view = new ScopeView(document.body, {
    deskDoc: doc,
    netlist,
    onAddChannel: (kind, ref) => doc.addScopeChannel(kind, ref),
    onRemoveChannel: (id) => doc.removeScopeChannel(id),
    onMoveChannel: (id, i) => doc.moveScopeChannel(id, i),
  });
  return { doc, view };
}

test("empty state shows until a channel exists", () => {
  resetDom();
  const { view } = makeView();
  view.setVisible(true);
  assert.equal(view.element.querySelector(".scope-empty").hidden, false);
  assert.equal(view.element.querySelector(".scope-body").hidden, true);
});

test("records a net channel into a stepped waveform", () => {
  resetDom();
  const { doc, view } = makeView();
  view.setVisible(true);
  view.addNetChannel("bb1.f12"); // routed through onAddChannel → doc
  assert.equal(doc.scopeChannels.length, 1);

  // Feed four running ticks: L, H, H, L.
  for (const lvl of ["L", "H", "H", "L"]) {
    window.dispatchEvent(simEvent("running", "bb1.f12", "net1", lvl));
  }
  view.setVisible(true); // force a synchronous render

  const svg = view.element.querySelector(".scope-svg");
  // One column per tick × 10px.
  assert.equal(svg.getAttribute("width"), "40", "four ticks recorded");
  const path = svg.querySelector("path");
  assert.ok(path, "a waveform path was drawn");
  // The step path visits both the high and low rails (a transition happened).
  assert.ok(path.getAttribute("d").split("L").length > 3, "multi-segment step");

  // The gutter shows the net's Feature-120 name.
  assert.equal(
    view.element.querySelector(".scope-chan-name").textContent,
    "CLK",
  );
});

test("a fresh Run resets the recorded trace", () => {
  resetDom();
  const { view } = makeView();
  view.setVisible(true);
  view.addNetChannel("bb1.f12");

  window.dispatchEvent(simEvent("running", "bb1.f12", "net1", "H"));
  window.dispatchEvent(simEvent("running", "bb1.f12", "net1", "L"));
  window.dispatchEvent(simEvent("stopped", "bb1.f12", "net1", null)); // keeps trace
  view.setVisible(true);
  assert.equal(
    view.element.querySelector(".scope-svg").getAttribute("width"),
    "20",
    "trace retained after Stop",
  );

  // Next Run starts over (transition stopped → running resets the ring).
  window.dispatchEvent(simEvent("running", "bb1.f12", "net1", "H"));
  view.setVisible(true);
  assert.equal(
    view.element.querySelector(".scope-svg").getAttribute("width"),
    "10",
    "one fresh column after re-Run",
  );
});

// ── Reordering by dragging a gutter row ─────────────────────────────────────
// jsdom lays nothing out, so the gutter's top is 0 and a client Y IS a distance
// down the channel list: row n spans [46n, 46n + 46).

const LANE_H = 46;

/** A visible view holding three net channels, sc1…sc3. */
function makeListView() {
  const { doc, view } = makeView();
  for (const ref of ["bb1.a1", "bb1.a2", "bb1.a3"]) {
    doc.addScopeChannel("net", ref);
  }
  view.setVisible(true);
  return { doc, view };
}

/** Dispatch a pointer event; move/up are heard on the window, so any target. */
function fire(target, type, y, { id = 1 } = {}) {
  target.dispatchEvent(
    new window.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: id,
      clientY: y,
    }),
  );
}

const rowNames = (view) =>
  [...view.element.querySelectorAll(".scope-chan-name")].map(
    (n) => n.textContent,
  );
const docOrder = (doc) => doc.scopeChannels.map((c) => c.id);
const nameSpan = (view, i) =>
  view.element.querySelectorAll(".scope-chan-name")[i];

test("dragging a row previews the new order, then the drop applies it", () => {
  resetDom();
  const { doc, view } = makeListView();
  fire(nameSpan(view, 0), "pointerdown", 20);
  fire(document.body, "pointermove", 30);
  fire(document.body, "pointermove", 20 + 2 * LANE_H);

  // In flight: the document is untouched, the panel draws where it would land.
  assert.deepEqual(docOrder(doc), ["sc1", "sc2", "sc3"]);
  assert.deepEqual(rowNames(view), ["bb1.a2", "bb1.a3", "bb1.a1"]);
  const held = view.element.querySelector(".scope-chan--dragging");
  assert.equal(held?.dataset.channel, "sc1", "the held row is lifted");
  assert.ok(view.element.classList.contains("scope-panel--reordering"));
  const lift = view.element.querySelector(".scope-lane-lift");
  assert.equal(lift?.getAttribute("y"), String(2 * LANE_H), "its lane shaded");

  fire(document.body, "pointerup", 20 + 2 * LANE_H);
  assert.deepEqual(docOrder(doc), ["sc2", "sc3", "sc1"]);
  assert.deepEqual(rowNames(view), ["bb1.a2", "bb1.a3", "bb1.a1"]);
  assert.equal(view.element.querySelector(".scope-chan--dragging"), null);
  assert.equal(view.element.querySelector(".scope-lane-lift"), null);
  assert.equal(
    view.element.classList.contains("scope-panel--reordering"),
    false,
  );
});

test("a held row lands in the row its middle is over, and stays on the list", () => {
  resetDom();
  const { doc, view } = makeListView();
  // Taken 40px down row 2: a row's travel past half a lane is a new place.
  fire(nameSpan(view, 2), "pointerdown", 2 * LANE_H + 40);
  fire(document.body, "pointermove", 2 * LANE_H + 40 - 22); // under half: stays
  assert.deepEqual(rowNames(view), ["bb1.a1", "bb1.a2", "bb1.a3"]);
  fire(document.body, "pointermove", 2 * LANE_H + 40 - 24); // over half: row 1
  assert.deepEqual(rowNames(view), ["bb1.a1", "bb1.a3", "bb1.a2"]);
  const held = view.element.querySelector(".scope-chan--dragging");
  assert.equal(
    held.style.transform,
    "translateY(22px)",
    "floats under the pointer",
  );
  fire(document.body, "pointermove", -500); // far above the list: the top
  assert.deepEqual(rowNames(view), ["bb1.a3", "bb1.a1", "bb1.a2"]);
  assert.equal(
    view.element.querySelector(".scope-chan--dragging").style.transform,
    "translateY(0px)",
    "pinned to the first row, not dragged off the list",
  );
  fire(document.body, "pointerup", -500);
  assert.deepEqual(docOrder(doc), ["sc3", "sc1", "sc2"]);
});

test("the drop lands where the button comes up, not at the last move", () => {
  resetDom();
  const { doc, view } = makeListView();
  fire(nameSpan(view, 0), "pointerdown", 20);
  fire(document.body, "pointermove", 20 + 2 * LANE_H); // last seen: row 2
  fire(document.body, "pointerup", 20 + LANE_H); // released over row 1
  assert.deepEqual(docOrder(doc), ["sc2", "sc1", "sc3"]);
});

test("a press that never travels, or one on a row's buttons, moves nothing", () => {
  resetDom();
  const { doc, view } = makeListView();
  let moved = 0;
  doc.moveScopeChannel = () => moved++;

  fire(nameSpan(view, 0), "pointerdown", 20);
  fire(document.body, "pointermove", 23); // under the threshold
  fire(document.body, "pointerup", 23);
  assert.equal(view.element.querySelector(".scope-chan--dragging"), null);

  const del = view.element.querySelector(".scope-mini--del");
  fire(del, "pointerdown", 20);
  fire(document.body, "pointermove", 20 + 2 * LANE_H);
  fire(document.body, "pointerup", 20 + 2 * LANE_H);
  assert.equal(moved, 0);
  assert.deepEqual(docOrder(doc), ["sc1", "sc2", "sc3"]);
});

test("Escape puts the held row back and the release then does nothing", () => {
  resetDom();
  const { doc, view } = makeListView();
  fire(nameSpan(view, 0), "pointerdown", 20);
  fire(document.body, "pointermove", 20 + 2 * LANE_H);
  const esc = new window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  let reachedApp = false;
  window.addEventListener("keydown", () => (reachedApp = true));
  document.body.dispatchEvent(esc);
  assert.ok(esc.defaultPrevented, "the drag took the key");
  assert.equal(reachedApp, false, "and nothing behind it saw it");
  assert.deepEqual(rowNames(view), ["bb1.a1", "bb1.a2", "bb1.a3"]);
  fire(document.body, "pointerup", 20 + 2 * LANE_H);
  assert.deepEqual(docOrder(doc), ["sc1", "sc2", "sc3"]);
});

test("a running circuit's ticks redraw the preview, not the document's order", () => {
  resetDom();
  const { doc, view } = makeListView();
  fire(nameSpan(view, 0), "pointerdown", 20);
  fire(document.body, "pointermove", 20 + 2 * LANE_H);
  // Each tick rebuilds every gutter row — the drag must survive that.
  window.dispatchEvent(simEvent("running", "bb1.a1", "n1", "H"));
  window.dispatchEvent(simEvent("running", "bb1.a1", "n1", "L"));
  assert.deepEqual(rowNames(view), ["bb1.a2", "bb1.a3", "bb1.a1"]);
  assert.ok(view.element.querySelector(".scope-chan--dragging"));
  fire(document.body, "pointerup", 20 + 2 * LANE_H);
  assert.deepEqual(docOrder(doc), ["sc2", "sc3", "sc1"]);
});

test("a channel dropped from under the drag ends it", () => {
  resetDom();
  const { doc, view } = makeListView();
  fire(nameSpan(view, 0), "pointerdown", 20);
  fire(document.body, "pointermove", 20 + 2 * LANE_H);
  doc.removeScopeChannel("sc1"); // an undo, say
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));
  assert.equal(view.element.querySelector(".scope-chan--dragging"), null);
  assert.equal(
    view.element.classList.contains("scope-panel--reordering"),
    false,
  );
  fire(document.body, "pointerup", 20);
  assert.deepEqual(docOrder(doc), ["sc2", "sc3"]);
});

test("a channel keeps its color wherever it is moved", () => {
  resetDom();
  const { doc, view } = makeListView();
  const dotOf = () =>
    Object.fromEntries(
      [...view.element.querySelectorAll(".scope-chan")].map((row) => [
        row.dataset.channel,
        row.querySelector(".scope-chan-dot").style.background,
      ]),
    );
  const before = dotOf();
  assert.equal(new Set(Object.values(before)).size, 3, "three distinct colors");
  doc.moveScopeChannel("sc1", 2);
  view.setVisible(true);
  assert.deepEqual(dotOf(), before);
});

test("a channel's own color is drawn through its theme token", () => {
  resetDom();
  const { doc, view } = makeView();
  // What a signal flag's "Add to analyzer" stores: its color TOKEN.
  doc.addScopeChannel("net", "bb1.a1", { color: "red" });
  doc.addScopeChannel("net", "bb1.a2", { color: "chartreuse" }); // not a token
  view.setVisible(true);
  window.dispatchEvent(simEvent("running", "bb1.a1", "n1", "H"));
  view.setVisible(true);

  const [own, junk] = view.element.querySelectorAll(".scope-chan-dot");
  assert.equal(own.style.background, "var(--color-wire-red)");
  assert.equal(
    junk.style.background,
    "var(--color-wire-green)",
    "a value the app never stores takes the palette's color for sc2",
  );
  const lane = view.element.querySelector(".scope-svg > path");
  assert.equal(lane.style.stroke, "var(--color-wire-red)");
});

// ── A voltage lane (Spice Lite) ────────────────────────────────────────────

/** A running tick where net1 sits at `volts` with level `level`. */
function voltsEvent(volts, level) {
  return new window.CustomEvent("chiphippo:sim-tick", {
    detail: {
      mode: "running",
      running: true,
      netLevels: new Map([["net1", level]]),
      nodeVolts: new Map([["net1", volts]]),
      supplies: new Map([["psu1", { set: 5, volts: 5 }]]),
      netlist: { netOfPoint: new Map([["bb1.f12", "net1"]]) },
    },
  });
}

/** The y coordinates a path's points visit, in order. */
const pathYs = (d) =>
  [...d.matchAll(/[ML] [\d.]+ ([\d.]+)/g)].map((m) => +m[1]);

test("a net whose voltage is known draws its curve, not a step", () => {
  resetDom();
  const { view } = makeView();
  view.setVisible(true);
  view.addNetChannel("bb1.f12");

  // A 1.5 s RC charging toward 5 V, sampled at the 1/30 s display frames.
  const samples = [];
  for (let k = 0; k <= 60; k += 1) {
    const v = 5 * (1 - Math.exp(-k / 30 / 1.5));
    samples.push(v);
    window.dispatchEvent(voltsEvent(v, v >= 2.5 ? "H" : "L"));
  }
  view.setVisible(true);

  const path = view.element.querySelector(".scope-svg path:last-of-type");
  const ys = pathYs(path.getAttribute("d"));
  // Lane 0: the rails are at 10 (5 V) and 36 (0 V).
  assert.equal(ys[0], 36, "starts on the 0 V rail");
  const between = ys.filter((y) => y > 10 && y < 36);
  assert.ok(between.length > 50, `it passes through the levels between (${between.length})`); // prettier-ignore
  for (let i = 1; i < ys.length; i += 1) {
    assert.ok(ys[i] <= ys[i - 1], "and only ever climbs");
  }
  // Each step up is smaller than the last: the curve bends over.
  const rise = (i) => ys[i - 1] - ys[i];
  assert.ok(rise(2) > rise(40), "steep at first, flattening later");

  // The gutter reads the voltage, to two places.
  assert.equal(
    view.element.querySelector(".scope-chan-value").textContent,
    `${samples.at(-1).toFixed(2)} V`,
  );
});

test("a flat voltage adds no points, and the trace steps where volts stop", () => {
  resetDom();
  const { view } = makeView();
  view.setVisible(true);
  view.addNetChannel("bb1.f12");
  for (let k = 0; k < 40; k += 1) window.dispatchEvent(voltsEvent(5, "H"));
  window.dispatchEvent(voltsEvent(2.5, "H"));
  window.dispatchEvent(voltsEvent(2.5, "H"));
  window.dispatchEvent(simEvent("running", "bb1.f12", "net1", "L"));
  window.dispatchEvent(simEvent("running", "bb1.f12", "net1", "L"));
  view.setVisible(true);

  const d = view.element
    .querySelector(".scope-svg path:last-of-type")
    .getAttribute("d");
  // 5 V across 40 columns is two points; the line leaves the last for 2.5 V
  // (y 23), held across its column where the volts stop; then the L run.
  assert.equal(d, "M 0 10 L 390 10 L 400 23 L 420 23 L 420 36 L 440 36");
  assert.equal(
    view.element.querySelector(".scope-chan-value").textContent,
    "L",
  );
});

// ── Unknown levels: hatched on the digital engine, not under Spice Lite ────

test("an X stretch is hatched on the digital engine and not under Spice Lite", () => {
  const hatches = (spice) => {
    resetDom();
    const { view } = makeView();
    view.setVisible(true);
    view.addNetChannel("bb1.f12");
    for (const level of ["L", "X", "X", "H"]) {
      const e = simEvent("running", "bb1.f12", "net1", level);
      if (spice) e.detail.lamps = new Map();
      window.dispatchEvent(e);
    }
    view.setVisible(true);
    return view.element.querySelectorAll('.scope-svg rect[fill="url(#scope-hatch)"]').length; // prettier-ignore
  };
  assert.equal(hatches(false), 1, "digital: the X run is hatched");
  assert.equal(hatches(true), 0, "Spice Lite: its trace says where it stands");
});

test("a voltage lane shades its range, 0 V to the full scale; a level lane does not", () => {
  resetDom();
  const { view } = makeView();
  view.setVisible(true);
  view.addNetChannel("bb1.f12");
  window.dispatchEvent(simEvent("running", "bb1.f12", "net1", "H"));
  view.setVisible(true);
  assert.equal(view.element.querySelector(".scope-volts-range"), null);

  window.dispatchEvent(voltsEvent(2.2, "X"));
  view.setVisible(true);
  const band = view.element.querySelector(".scope-volts-range");
  assert.ok(band, "the range is drawn");
  // Lane 0: the full-scale rail at 10, the 0 V rail at 36.
  assert.equal(band.getAttribute("y"), "10");
  assert.equal(band.getAttribute("height"), "26");
  const svgEl = view.element.querySelector(".scope-svg");
  assert.equal(svgEl.querySelector("path:last-of-type") !== null, true);
  assert.ok(
    [...svgEl.children].indexOf(band) <
      [...svgEl.children].indexOf(svgEl.querySelector("path:last-of-type")),
    "behind the trace",
  );
});

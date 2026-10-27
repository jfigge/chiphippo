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

/** `chiphippo:sim-ticks` carrying ONE tick, `detail` — which is also the
    event's detail (its `ticks` the tick itself), so a test may still set
    `e.detail.at` and the like before dispatching it. */
function ticksEvent(detail) {
  detail.ticks = [detail];
  return new window.CustomEvent("chiphippo:sim-ticks", { detail });
}

/** One tick's broadcast (a sim-tick, what the analyzer records) — or, for
    `stopped`, the sim-state that ends a run. */
function simEvent(mode, address, netId, level, at = undefined) {
  const detail = {
    mode,
    at,
    running: mode !== "stopped",
    netLevels: level == null ? new Map() : new Map([[netId, level]]),
    netlist: { netOfPoint: new Map([[address, netId]]) },
  };
  if (mode !== "stopped") return ticksEvent(detail);
  return new window.CustomEvent("chiphippo:sim-state", { detail });
}

function makeView(opts = {}) {
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
    ...opts,
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

  // Four running ticks a millisecond apart: L, H, H, L.
  ["L", "H", "H", "L"].forEach((lvl, k) => {
    window.dispatchEvent(simEvent("running", "bb1.f12", "net1", lvl, k / 1000)); // prettier-ignore
  });
  view.setVisible(true); // force a synchronous render

  // Timing: 3 ms fitted to the (unlaid-out) 800 px is 500 µs a 100 px
  // division, so a millisecond is 200 px and each level holds from its own
  // sample to the next.
  assert.equal(view.axisMode, "timing");
  const svg = view.element.querySelector(".scope-svg");
  assert.equal(svg.getAttribute("width"), "600");
  assert.equal(
    svg.querySelector("path:last-of-type").getAttribute("d"),
    "M 0 36 L 200 36 L 200 10 L 600 10 L 600 36 L 600 36",
  );
  assert.equal(
    view.element.querySelector(".scope-per-div").textContent,
    "500 µs/div",
  );

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
  view.setAxisMode("transitions"); // a slice a change: width counts them
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

test("another desk on the desk drops the trace the last one's run left", () => {
  resetDom();
  const { view } = makeView();
  view.setVisible(true);
  view.setAxisMode("transitions");
  view.addNetChannel("bb1.f12");
  window.dispatchEvent(simEvent("running", "bb1.f12", "net1", "H"));
  window.dispatchEvent(simEvent("running", "bb1.f12", "net1", "L"));
  window.dispatchEvent(simEvent("stopped", "bb1.f12", "net1", null));
  view.setVisible(true);
  const width = () =>
    view.element.querySelector(".scope-svg").getAttribute("width");
  assert.equal(width(), "20", "kept after Stop");
  // A desktop switch: the next desk's sc1 is another channel altogether.
  window.dispatchEvent(new window.CustomEvent("chiphippo:desk-loaded"));
  view.setVisible(true);
  assert.notEqual(width(), "20", "the old trace is gone");
  assert.equal(
    view.element.querySelectorAll(".scope-svg path[d*='L']").length,
    0,
    "nothing drawn from it",
  );
});

test("the exported SVG stands alone: no var(--…) left in it, fonts included", async () => {
  resetDom();
  const { doc, view } = makeView();
  view.setVisible(true);
  view.addNetChannel("bb1.f12");
  doc.addBoard("pins-full", 0, 0);
  const D = doc.addWire({ from: "bb1.a1", to: "bb1.a9" });
  doc.addBus("D[0]", [D.id]);
  doc.addScopeChannel("bus", doc.buses[0].id);
  for (const lvl of ["L", "H", "H", "L"]) {
    window.dispatchEvent(simEvent("running", "bb1.f12", "net1", lvl));
  }
  window.dispatchEvent(simEvent("stopped", "bb1.f12", "net1", null));
  let blob = null;
  const { createObjectURL, revokeObjectURL } = globalThis.URL;
  globalThis.URL.createObjectURL = (b) => ((blob = b), "blob:timing");
  globalThis.URL.revokeObjectURL = () => {};
  globalThis.XMLSerializer ??= window.XMLSerializer;
  try {
    [...view.element.querySelectorAll(".scope-btn")]
      .find((b) => b.textContent === "SVG")
      .click();
  } finally {
    globalThis.URL.createObjectURL = createObjectURL;
    globalThis.URL.revokeObjectURL = revokeObjectURL;
  }
  assert.ok(blob, "a file was offered");
  const xml = await blob.text();
  assert.match(xml, /<text/);
  assert.doesNotMatch(xml, /var\(--/);
});

test("a render keeps the gutter scrolled with the lanes, and room under it for their scrollbar", () => {
  resetDom();
  const { doc, view } = makeView();
  for (let i = 1; i <= 6; i++) doc.addScopeChannel("net", `bb1.a${i}`);
  const lanes = view.element.querySelector(".scope-lanes");
  const gutter = view.element.querySelector(".scope-gutter");
  // jsdom lays nothing out: a lanes viewport scrolled down two rows, with a
  // 12 px horizontal scrollbar.
  Object.defineProperty(lanes, "scrollTop", { value: 92, configurable: true });
  Object.defineProperty(lanes, "offsetHeight", { value: 112, configurable: true }); // prettier-ignore
  Object.defineProperty(lanes, "clientHeight", { value: 100, configurable: true }); // prettier-ignore
  let gutterTop = 0;
  Object.defineProperty(gutter, "scrollTop", {
    get: () => gutterTop,
    set: (v) => {
      gutterTop = v;
    },
    configurable: true,
  });
  view.setVisible(true);
  assert.equal(gutterTop, 92, "level with the lanes after the rebuild");
  assert.equal(
    gutter.querySelector(".scope-gutter-foot")?.style.height,
    "12px",
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
  return ticksEvent({
    mode: "running",
    running: true,
    netLevels: new Map([["net1", level]]),
    nodeVolts: new Map([["net1", volts]]),
    supplies: new Map([["psu1", { set: 5, volts: 5 }]]),
    netlist: { netOfPoint: new Map([["bb1.f12", "net1"]]) },
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
  // A millisecond apart: 5 V for 40 ms, 2.5 V for two, then a level.
  const tick = (e, k) => {
    e.detail.at = k / 1000;
    window.dispatchEvent(e);
  };
  for (let k = 0; k < 40; k += 1) tick(voltsEvent(5, "H"), k);
  tick(voltsEvent(2.5, "H"), 40);
  tick(voltsEvent(2.5, "H"), 41);
  tick(simEvent("running", "bb1.f12", "net1", "L"), 42);
  tick(simEvent("running", "bb1.f12", "net1", "L"), 43);
  view.setVisible(true);

  const d = view.element
    .querySelector(".scope-svg path:last-of-type")
    .getAttribute("d");
  // 43 ms fitted is 10 ms/div, 10 px a ms: the 5 V run is its two ends, held
  // to the tick at 40 ms and stepped there (a tick is an event), 2.5 V held
  // to where the volts stop at 42 ms, then the L run to the trace's end.
  const pts = [...d.matchAll(/[ML] ([\d.]+) ([\d.]+)/g)].map((m) => `${Math.round(+m[1])},${m[2]}`); // prettier-ignore
  assert.deepEqual(pts, ["0,10", "400,10", "400,23", "420,23", "420,36", "430,36"]); // prettier-ignore
  assert.equal(
    view.element.querySelector(".scope-chan-value").textContent,
    "L",
  );
});

// ── Unknown levels: hatched on the digital engine, not under Spice Lite ────

test("an X stretch is hatched, but not where Timing draws its voltage", () => {
  const hatches = ({ spice = false, volts = false, axisMode = "timing" }) => {
    resetDom();
    const { view } = makeView({ axisMode });
    view.setVisible(true);
    view.addNetChannel("bb1.f12");
    for (const level of ["L", "X", "X", "H"]) {
      const e = volts
        ? voltsEvent({ L: 0.2, X: 2.2, H: 4.4 }[level], level)
        : simEvent("running", "bb1.f12", "net1", level);
      if (spice) e.detail.lamps = new Map();
      window.dispatchEvent(e);
    }
    view.setVisible(true);
    return view.element.querySelectorAll('.scope-svg rect[fill="url(#scope-hatch)"]').length; // prettier-ignore
  };
  assert.equal(hatches({}), 1, "digital: the X run is hatched");
  assert.equal(hatches({ spice: true, volts: true }), 0, "Spice Lite in Timing: its trace says where it stands"); // prettier-ignore
  assert.equal(hatches({ spice: true }), 1, "Spice Lite, no voltage known: an X is an X"); // prettier-ignore
  assert.equal(hatches({ spice: true, volts: true, axisMode: "transitions" }), 1, "Transitions is the logic view"); // prettier-ignore
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

// ── The x axis: Timing and Transitions (model/scope-axis.js) ───────────────

/** Feed `levels` a `dt` apart from 0 s. */
function feed(levels, dt) {
  levels.forEach((lvl, k) => {
    window.dispatchEvent(simEvent("running", "bb1.f12", "net1", lvl, k * dt));
  });
}

const trackWidth = (view) =>
  view.element.querySelector(".scope-track").style.width;
const perDiv = (view) =>
  view.element.querySelector(".scope-per-div").textContent;
const button = (view, title) =>
  [...view.element.querySelectorAll(".scope-zoom button")].find(
    (b) => b.title === title,
  );

test("Timing zooms a 1-2-5 step at a time, and Fit puts the whole trace back", () => {
  resetDom();
  const { view } = makeView();
  view.setVisible(true);
  view.addNetChannel("bb1.f12");
  feed(["L", "H", "L", "H", "L"], 0.01); // 40 ms
  view.setVisible(true);
  assert.equal(perDiv(view), "5 ms/div", "fitted: 40 ms in 8 divisions");
  assert.equal(trackWidth(view), "800px");
  const fit = button(view, "Fit the whole trace in the panel");
  assert.equal(fit.getAttribute("aria-pressed"), "true");

  button(view, "Zoom in (less time per division)").click();
  assert.equal(perDiv(view), "2 ms/div");
  assert.equal(trackWidth(view), "2000px", "the same 40 ms, wider");
  assert.equal(fit.getAttribute("aria-pressed"), "false");
  button(view, "Zoom in (less time per division)").click();
  assert.equal(perDiv(view), "1 ms/div");
  button(view, "Zoom out (more time per division)").click();
  assert.equal(perDiv(view), "2 ms/div");

  fit.click();
  assert.equal(perDiv(view), "5 ms/div");
  assert.equal(trackWidth(view), "800px");
});

test("Timing draws a division line at every multiple of the scale", () => {
  resetDom();
  const { view } = makeView();
  view.setVisible(true);
  view.addNetChannel("bb1.f12");
  feed(["L", "H", "L", "H", "L"], 0.01);
  view.setVisible(true);
  const xs = [...view.element.querySelectorAll(".scope-grid")].map((l) =>
    Number(l.getAttribute("x1")),
  );
  assert.deepEqual(xs, [0, 100, 200, 300, 400, 500, 600, 700, 800]);
  view.setAxisMode("transitions");
  assert.equal(view.element.querySelectorAll(".scope-grid").length, 0);
  assert.equal(
    view.element.querySelector(".scope-zoom").hidden,
    true,
    "the scale's controls are Timing's",
  );
});

test("Timing reaches the moment the run was last shown at, not just its last tick", () => {
  resetDom();
  const { view } = makeView();
  view.setVisible(true);
  view.addNetChannel("bb1.f12");
  feed(["L", "H"], 0.01); // ticks at 0 and 10 ms
  window.dispatchEvent(
    new window.CustomEvent("chiphippo:sim-state", {
      detail: { mode: "running", at: 0.04 },
    }),
  );
  view.setVisible(true);
  // 40 ms fitted is 5 ms/div: the H held from 10 ms runs on to 40 ms.
  assert.equal(perDiv(view), "5 ms/div");
  const d = view.element
    .querySelector(".scope-svg path:last-of-type")
    .getAttribute("d");
  assert.equal(d, "M 0 36 L 200 36 L 200 10 L 800 10");
});

test("Transitions gives each change a slice and folds a steady run into a titled break", () => {
  resetDom();
  const { view } = makeView();
  view.setVisible(true);
  view.setAxisMode("transitions");
  view.addNetChannel("bb1.f12");
  // L, then a long H (five ticks over 40 ms), then L.
  ["L", "H", "H", "H", "H", "H", "L"].forEach((lvl, k) => {
    const at = [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06][k];
    window.dispatchEvent(simEvent("running", "bb1.f12", "net1", lvl, at));
  });
  view.setVisible(true);
  // Slices at 0, 10 and the fold 20–24, then the final L at 24–34.
  assert.equal(trackWidth(view), "34px");
  const breaks = view.element.querySelectorAll(".scope-break");
  assert.equal(breaks.length, 1);
  assert.equal(
    breaks[0].querySelector("title").textContent,
    "50 ms with no change, folded",
    "the time from the H's edge to the L's",
  );
});

test("Transitions draws a Spice Lite net's level, never its voltage", () => {
  resetDom();
  const { view } = makeView({ axisMode: "transitions" });
  view.setVisible(true);
  view.addNetChannel("bb1.f12");
  // A node creeping up from 1 V to 4.8 V, read X across the middle.
  const levels = ["L", "L", "L", "X", "X", "X", "H", "H", "H", "H"];
  levels.forEach((lvl, k) => {
    const e = voltsEvent(1 + 0.4 * k, lvl);
    e.detail.at = k * 0.001;
    window.dispatchEvent(e);
  });
  view.setVisible(true);
  // Three levels, three slices: the creep within each folds away.
  assert.equal(trackWidth(view), "30px");
  assert.equal(view.element.querySelector(".scope-volts-range"), null, "no volts band"); // prettier-ignore
  const d = view.element
    .querySelector(".scope-svg path:last-of-type")
    .getAttribute("d");
  assert.deepEqual([...new Set(pathYs(d))], [36, 23, 10], "L, X at the middle, H"); // prettier-ignore
  assert.equal(
    view.element.querySelector(".scope-chan-value").textContent,
    "H",
    "the gutter reads the level too",
  );
});

test("the axis mode is the header's picker, and a change is handed on to be kept", () => {
  resetDom();
  const kept = [];
  const { view } = makeView({
    axisMode: "transitions",
    onAxisModeChange: (mode) => kept.push(mode),
  });
  view.setVisible(true);
  assert.equal(view.axisMode, "transitions");
  const options = view.element.querySelectorAll(
    ".scope-axis .segmented-option",
  );
  assert.deepEqual(
    [...options].map((o) => o.textContent),
    ["Timing", "Transitions"],
  );
  options[0].click();
  assert.equal(view.axisMode, "timing");
  assert.deepEqual(kept, ["timing"]);
  assert.equal(
    makeView({ axisMode: "sideways" }).view.axisMode,
    "timing",
    "anything else is the default",
  );
});

test("a cursor lands on the column under it in either mode", () => {
  resetDom();
  const { view } = makeView();
  view.setVisible(true);
  view.addNetChannel("bb1.f12");
  feed(["L", "H", "L", "H", "L"], 0.01); // 5 ms/div fitted: 10 ms is 200 px
  view.setVisible(true);
  const svgEl = view.element.querySelector(".scope-svg");
  const press = (offsetX) => {
    const e = new window.PointerEvent("pointerdown", { bubbles: true });
    Object.defineProperty(e, "offsetX", { value: offsetX });
    svgEl.dispatchEvent(e);
    svgEl.dispatchEvent(
      new window.PointerEvent("pointerup", { bubbles: true }),
    );
  };
  press(450); // between 400 (tick 2) and 600 (tick 3)
  assert.equal(view.element.querySelector(".scope-delta").textContent, "t=2");
  view.setAxisMode("transitions");
  press(35); // slices of 10: the fourth column
  assert.equal(view.element.querySelector(".scope-delta").textContent, "t=3");
});

test("Timing joins a voltage's curve samples, but holds to a tick and steps there", () => {
  resetDom();
  const { view } = makeView();
  view.setVisible(true);
  view.addNetChannel("bb1.f12");
  const at = (volts, t, sample = false) => {
    const e = voltsEvent(volts, "H");
    e.detail.at = t;
    if (sample) e.detail.sample = true;
    window.dispatchEvent(e);
  };
  at(0, 0); // a quiet node at 0 V…
  at(5, 1); // …a switch thrown a second later (a tick)…
  at(4, 1 + 1 / 30, true); // …and a node moving, read off its curve
  at(3, 1 + 2 / 30, true);
  view.setVisible(true);
  // 1.067 s fitted to 800 px is 200 ms/div: 500 px a second.
  const d = view.element
    .querySelector(".scope-svg path:last-of-type")
    .getAttribute("d");
  const pts = [...d.matchAll(/[ML] ([\d.]+) ([\d.]+)/g)].map((m) => [
    Math.round(+m[1]),
    Math.round(+m[2]),
  ]);
  assert.deepEqual(pts, [
    [0, 36], // 0 V…
    [500, 36], // …held for the whole second…
    [500, 10], // …then the step to 5 V
    [517, 15], // the curve samples joined straight: 4 V
    [533, 20], // 3 V, held to the trace's end
    [533, 20],
  ]);
});

test("a running trace is drawn thinned to the pixel, a paused one whole — the recording keeps every sample", () => {
  resetDom();
  const { view } = makeView();
  view.setVisible(true);
  view.addNetChannel("bb1.f12");
  // A 60 Hz sine read 20 000 times a second for 0.2 s: 4000 samples into
  // an 800 px lane.
  for (let k = 0; k < 4000; k++) {
    const t = k / 20000;
    const e = voltsEvent(2.5 + 2.5 * Math.sin(2 * Math.PI * 60 * t), "H");
    e.detail.at = t;
    e.detail.sample = k > 0;
    window.dispatchEvent(e);
  }
  const shown = () => {
    view.setVisible(true);
    const d = view.element.querySelector(".scope-svg path:last-of-type").getAttribute("d"); // prettier-ignore
    const ys = pathYs(d);
    return { n: ys.length, lo: Math.min(...ys), hi: Math.max(...ys) };
  };
  const state = (mode) =>
    window.dispatchEvent(new window.CustomEvent("chiphippo:sim-state", { detail: { mode, at: 0.2 } })); // prettier-ignore
  state("running");
  const live = shown();
  state("paused");
  const whole = shown();
  assert.ok(whole.n >= 4000, `paused, every sample: ${whole.n}`);
  assert.ok(live.n <= 4 * 801, `running, at most four points a pixel: ${live.n}`); // prettier-ignore
  assert.deepEqual([live.lo, live.hi], [whole.lo, whole.hi], "the same crests and troughs"); // prettier-ignore
});

test("running, the lanes are redrawn once a desk frame (each sim-state), not at every tick", () => {
  resetDom();
  const { view } = makeView({ axisMode: "transitions" });
  view.setVisible(true);
  view.addNetChannel("bb1.f12");
  const tick = (lvl, at) =>
    window.dispatchEvent(simEvent("running", "bb1.f12", "net1", lvl, at));
  const frame = (mode, at) =>
    window.dispatchEvent(new window.CustomEvent("chiphippo:sim-state", { detail: { mode, at } })); // prettier-ignore
  tick("L", 0);
  frame("running", 0);
  assert.equal(trackWidth(view), "10px", "the desk frame drew the first column"); // prettier-ignore
  tick("H", 0.01);
  tick("L", 0.02);
  assert.equal(trackWidth(view), "10px", "ticks wait for the next desk frame"); // prettier-ignore
  frame("running", 0.02);
  assert.equal(trackWidth(view), "30px", "drawn with the desk");
  tick("H", 0.03);
  frame("paused", 0.03);
  assert.equal(trackWidth(view), "40px", "paused: drawn at once, whole");
  tick("L", 0.04); // a Step while paused
  assert.equal(trackWidth(view), "50px");
});

// ── A cycle drawn slowed on the desk, drawn true here ───────────────────────

/** A true cycle of 200 µs (5 kHz): HIGH 4 V for 120 µs, then LOW 0.2 V. */
const TRUE_CYCLE = [
  { u: 0, cell: "H", volts: 4, curve: false },
  { u: 120e-6, cell: "L", volts: 0.2, curve: false },
];
/** Shown on the desk at 1 ms a cycle from Run: the slowed picture's
    columns, 50 µs apart for 3 ms, each naming the cycle and its template. */
function feedDrawnCycle() {
  const cycle = { id: 0, start: 0, shown: 1e-3, period: 200e-6, nets: ["net1"], templates: new Map([["net1", TRUE_CYCLE]]) }; // prettier-ignore
  for (let k = 0; k <= 60; k++) {
    const at = k * 50e-6;
    const high = (at % 1e-3) / 1e-3 < 0.6;
    const e = voltsEvent(high ? 4 : 0.2, high ? "H" : "L");
    Object.assign(e.detail, { at, lamps: new Map(), cycles: [cycle] });
    window.dispatchEvent(e);
  }
}

/** The x of each rising step of the lane's path. */
const risesOf = (view) => {
  const d = view.element.querySelector(".scope-svg path:last-of-type").getAttribute("d"); // prettier-ignore
  const pts = [...d.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map((m) => [+m[1], +m[2]]); // prettier-ignore
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i - 1][1] > 30 && pts[i][1] < 20 && pts[i][0] === pts[i - 1][0]) out.push(pts[i][0]); // prettier-ignore
  }
  return out;
};

test("a cycle the desk shows slowed is drawn at its TRUE period in Timing, a band when too fine to see", () => {
  resetDom();
  const { view } = makeView();
  view.setVisible(true);
  view.addNetChannel("bb1.f12");
  feedDrawnCycle();
  view.setVisible(true);
  assert.equal(perDiv(view), "500 µs/div", "3 ms fitted");
  // 50 µs a division: 2 px a µs — a rise every 200 µs is 400 px apart, where
  // the slowed picture rose every 1 ms.
  for (let i = 0; i < 3; i++) button(view, "Zoom in (less time per division)").click(); // prettier-ignore
  assert.equal(perDiv(view), "50 µs/div");
  const rises = risesOf(view);
  assert.ok(rises.length >= 5, `${rises.length} rises`);
  for (let i = 1; i < rises.length; i++) assert.ok(Math.abs(rises[i] - rises[i - 1] - 400) < 1e-6, `${rises}`); // prettier-ignore
  assert.equal(view.element.querySelectorAll(".scope-cycle-band").length, 0);
  // 20 ms a division: a period is a pixel — the band between its extremes.
  for (let i = 0; i < 8; i++) button(view, "Zoom out (more time per division)").click(); // prettier-ignore
  assert.equal(perDiv(view), "20 ms/div");
  assert.equal(view.element.querySelectorAll(".scope-cycle-band").length, 1);
});

test("a cycle drawn true is said so: its true rate in the gutter, one block in Transitions, its period at a cursor", () => {
  resetDom();
  const { view } = makeView();
  view.setVisible(true);
  view.addNetChannel("bb1.f12");
  feedDrawnCycle();
  view.setVisible(true);
  const rate = view.element.querySelector(".scope-chan-rate");
  assert.equal(rate.textContent, "5 kHz");
  assert.match(rate.title, /drawn at 1 kHz/);
  const svgEl = view.element.querySelector(".scope-svg");
  for (const [x, shiftKey] of [
    [300, false],
    [500, true],
  ]) {
    const e = new window.PointerEvent("pointerdown", { bubbles: true, shiftKey }); // prettier-ignore
    Object.defineProperty(e, "offsetX", { value: x });
    svgEl.dispatchEvent(e);
    svgEl.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true })); // prettier-ignore
  }
  assert.match(view.element.querySelector(".scope-delta").textContent, /true period 200 µs/); // prettier-ignore
  view.setAxisMode("transitions");
  const block = view.element.querySelector(".scope-cycle-block");
  assert.ok(block, "one block");
  assert.equal(block.querySelector("text").textContent, "5 kHz");
  assert.equal(view.element.querySelectorAll(".scope-cycle-block").length, 1);
  assert.equal(view.element.querySelectorAll(".scope-break").length, 0, "no fold marked inside it"); // prettier-ignore
});

test("a channel taking an undone channel's id never inherits its recorded trace", () => {
  resetDom();
  const { doc, view } = makeView();
  const changed = () =>
    window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));
  view.setVisible(true);
  view.setAxisMode("transitions");
  const before = doc.snapshot();
  view.addNetChannel("bb1.f12"); // sc1
  changed();
  for (const lvl of ["H", "L", "H", "L", "H"]) {
    window.dispatchEvent(simEvent("running", "bb1.f12", "net1", lvl));
  }
  window.dispatchEvent(simEvent("stopped", "bb1.f12", "net1", null));
  view.setVisible(true);
  const lane = () =>
    [...view.element.querySelectorAll(".scope-svg path")]
      .map((p) => p.getAttribute("d"))
      .filter(Boolean)
      .at(-1);
  assert.ok(lane().split(" L ").length > 4, "sc1 recorded its toggling");
  // Undo the add — the id counter rewinds — and add a channel elsewhere.
  doc.restore(before);
  changed();
  view.addNetChannel("bb1.f40");
  changed();
  assert.equal(doc.scopeChannels[0].id, "sc1", "the same id, a new channel");
  view.setVisible(true);
  assert.ok(lane().split(" L ").length <= 2, "and none of sc1's old run");
});

// ── Runtime review R6: the analyzer's frame ─────────────────────────────────
// Running, the panel is drawn 25 times a second. Its gutter rows are KEPT and
// updated in place, its layout is read once before anything is written, its
// runs are encoded as the recording grows, and only the drawn window's runs
// and columns are walked.

/** A running tick at `at` where every address in `levels` carries its level. */
function multiTick(at, levels, volts = new Map()) {
  return ticksEvent({
    mode: "running",
    running: true,
    at,
    netLevels: new Map([...levels].map(([a, lv]) => [`n:${a}`, lv])),
    nodeVolts: new Map([...volts].map(([a, v]) => [`n:${a}`, v])),
    supplies: new Map([["psu1", { set: 5, volts: 5 }]]),
    netlist: {
      netOfPoint: new Map([...levels.keys()].map((a) => [a, `n:${a}`])),
    },
  });
}
const running = (at) =>
  window.dispatchEvent(
    new window.CustomEvent("chiphippo:sim-state", {
      detail: { mode: "running", running: true, at },
    }),
  );

test("the gutter's rows are kept and updated in place, their buttons acting on where the row is now", () => {
  resetDom();
  const { doc, view } = makeView();
  for (const ref of ["bb1.a1", "bb1.a2", "bb1.a3"]) {
    doc.addScopeChannel("net", ref);
  }
  view.setVisible(true);
  const rows = () => [...view.element.querySelectorAll(".scope-chan")];
  const before = rows();
  const levels = new Map([
    ["bb1.a1", "H"],
    ["bb1.a2", "L"],
    ["bb1.a3", "Z"],
  ]);
  window.dispatchEvent(multiTick(0, levels));
  view.setVisible(true);
  const same = (a, b) => a.length === b.length && a.every((r, i) => r === b[i]);
  assert.ok(same(rows(), before), "the same three elements");
  const values = () =>
    rows().map((r) => r.querySelector(".scope-chan-value").textContent);
  assert.deepEqual(values(), ["H", "L", "Z"]);
  levels.set("bb1.a1", "L");
  window.dispatchEvent(multiTick(1e-3, levels));
  view.setVisible(true);
  assert.deepEqual(values(), ["L", "L", "Z"], "a value follows the trace");
  // Moved, the row keeps its element and its ↑ now moves it from its NEW place.
  doc.moveScopeChannel("sc3", 0);
  view.setVisible(true);
  assert.ok(same(rows(), [before[2], before[0], before[1]]), "moved, not made");
  const [up] = rows()[1].querySelectorAll(".scope-mini");
  assert.equal(up.disabled, false);
  assert.equal(rows()[0].querySelector(".scope-mini").disabled, true);
  up.click(); // sc1, second now, goes first
  view.setVisible(true);
  assert.deepEqual(
    doc.scopeChannels.map((c) => c.id),
    ["sc1", "sc3", "sc2"],
  );
  doc.removeScopeChannel("sc3");
  view.setVisible(true);
  assert.equal(rows().length, 2, "a removed channel's row goes");
  assert.ok(!before[2].isConnected);
});

test("a render reads the lanes' layout before it writes anything, once", () => {
  resetDom();
  const { doc, view } = makeView();
  doc.addScopeChannel("net", "bb1.a1");
  const lanes = view.element.querySelector(".scope-lanes");
  const value = () =>
    view.element.querySelector(".scope-chan-value")?.textContent;
  const seen = [];
  for (const prop of [
    "clientWidth",
    "clientHeight",
    "offsetHeight",
    "scrollLeft",
    "scrollTop",
  ]) {
    Object.defineProperty(lanes, prop, {
      get: () => {
        seen.push([prop, value()]);
        return prop === "clientWidth" ? 400 : 0;
      },
      set: () => {},
      configurable: true,
    });
  }
  view.setVisible(true);
  running(0); // live: a tick records, the frame draws
  window.dispatchEvent(multiTick(0, new Map([["bb1.a1", "H"]])));
  view.setVisible(true);
  seen.length = 0;
  window.dispatchEvent(multiTick(1e-3, new Map([["bb1.a1", "L"]])));
  view.setVisible(true); // one render: the value goes H → L
  assert.equal(value(), "L");
  assert.deepEqual(
    seen.map(([prop]) => prop).sort(),
    ["clientHeight", "clientWidth", "offsetHeight", "scrollLeft", "scrollTop"],
    "each figure read once",
  );
  assert.ok(
    seen.every(([, v]) => v === "H"),
    "and all of them before the gutter was touched",
  );
});

test("a long recording draws the same whether its runs were kept frame by frame or encoded at once", () => {
  resetDom();
  const { doc, view } = makeView();
  doc.addScopeChannel("net", "bb1.a1");
  doc.addScopeChannel("net", "bb1.a2");
  // A second panel on the same desk, hidden until the end: its encoding is
  // done in one go, from whatever the ring then holds.
  const { view: fresh } = makeView({ deskDoc: doc });
  view.setVisible(true);
  running(0);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const levels = new Map([
    ["bb1.a1", "L"],
    ["bb1.a2", "H"],
  ]);
  // Past the ring's 8000 columns, so runs fall off the front as it goes.
  for (let k = 0; k < 8600; k++) {
    if (rnd() < 0.2) levels.set("bb1.a1", rnd() < 0.5 ? "H" : "L");
    if (rnd() < 0.05) levels.set("bb1.a2", ["H", "L", "Z", "X"][k % 4]);
    window.dispatchEvent(multiTick(k * 1e-4, levels));
    if (k % 700 === 0) running(k * 1e-4); // a live frame: kept runs advance
  }
  window.dispatchEvent(
    new window.CustomEvent("chiphippo:sim-state", { detail: { mode: "paused" } }), // prettier-ignore
  );
  fresh.setVisible(true);
  view.setVisible(true);
  const drawing = (v) => v.element.querySelector(".scope-svg").innerHTML;
  assert.ok(drawing(view).length > 1000);
  assert.equal(drawing(view), drawing(fresh));
});

test("zoomed into a long trace, only the drawn window is walked — and drawn as the whole would be", () => {
  resetDom();
  const { doc, view } = makeView();
  doc.addScopeChannel("net", "bb1.a1");
  const lanes = view.element.querySelector(".scope-lanes");
  let left = 0;
  const track = view.element.querySelector(".scope-track");
  Object.defineProperty(lanes, "clientWidth", { get: () => 400, configurable: true }); // prettier-ignore
  Object.defineProperty(lanes, "scrollLeft", {
    get: () => left,
    set: (v) => {
      left = Math.max(0, Math.min(v, parseFloat(track.style.width) - 400));
    },
    configurable: true,
  });
  view.setVisible(true);
  // 4000 ticks a millisecond apart, toggling every one — then held HIGH for
  // the last 1000, so the window's left edge sits in a long flat run.
  for (let k = 0; k < 5000; k++) {
    const lv = k < 4000 ? (k % 2 ? "H" : "L") : "H";
    window.dispatchEvent(multiTick(k * 1e-3, new Map([["bb1.a1", lv]])));
  }
  window.dispatchEvent(
    new window.CustomEvent("chiphippo:sim-state", { detail: { mode: "paused" } }), // prettier-ignore
  );
  for (let i = 0; i < 8; i++) button(view, "Zoom in (less time per division)").click(); // prettier-ignore
  assert.equal(perDiv(view), "5 ms/div"); // 20 px a tick
  lanes.scrollLeft = 4500 * 20; // deep into the flat HIGH stretch
  lanes.dispatchEvent(new window.Event("scroll"));
  view.setVisible(true);
  const svgEl = view.element.querySelector(".scope-svg");
  const [x0, , w] = svgEl.getAttribute("viewBox").split(" ").map(Number);
  const d = svgEl.querySelector("path:last-of-type").getAttribute("d");
  const pts = [...d.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map((m) => [+m[1], +m[2]]); // prettier-ignore
  assert.ok(pts.length < 20, `${pts.length} points, not one a column`);
  // HIGH (y 10) across the whole window, entering at its left edge (the
  // stretch before it collapsed onto the edge, outside the viewBox).
  assert.ok(
    pts[0][0] <= x0 && pts.at(-1)[0] >= Math.min(x0 + w, 5000 * 20 - 1),
  );
  assert.ok(
    pts.filter(([x]) => x > x0).every(([, y]) => y === 10),
    d,
  );
  // Back where it toggles: one run a tick, each step at its tick.
  lanes.scrollLeft = 2000 * 20;
  lanes.dispatchEvent(new window.Event("scroll"));
  view.setVisible(true);
  const d2 = view.element.querySelector(".scope-svg path:last-of-type").getAttribute("d"); // prettier-ignore
  const ys = pathYs(d2);
  assert.ok(ys.length < 300, `${ys.length} points for a 1200 px window`);
  assert.ok(ys.includes(10) && ys.includes(36), "both levels drawn");
});

test("a batch of ticks in one sim-ticks event records what one event a tick does, channels and buses read once (scope batch)", () => {
  const draw = (batched) => {
    resetDom();
    const { doc, view } = makeView();
    view.setVisible(true);
    view.addNetChannel("bb1.f12");
    const tick = (k) => ({
      mode: "running",
      running: true,
      at: k / 1000,
      sample: k % 3 === 1,
      netLevels: new Map([["net1", k % 2 ? "H" : "L"]]),
      nodeVolts: new Map([["net1", (k % 5) * 0.9]]),
      supplies: new Map([["psu1", { set: 5, volts: 5 }]]),
      lamps: new Map(),
      netlist: { netOfPoint: new Map([["bb1.f12", "net1"]]) },
    });
    const ticks = Array.from({ length: 40 }, (_, k) => tick(k));
    if (batched) {
      for (let i = 0; i < ticks.length; i += 16) {
        window.dispatchEvent(new window.CustomEvent("chiphippo:sim-ticks", { detail: { ticks: ticks.slice(i, i + 16) } })); // prettier-ignore
      }
    } else for (const t of ticks) window.dispatchEvent(ticksEvent(t));
    window.dispatchEvent(simEvent("stopped", "bb1.f12", "net1", null));
    view.setVisible(true);
    assert.equal(doc.scopeChannels.length, 1);
    return [...view.element.querySelectorAll(".scope-svg path")].map((p) => p.getAttribute("d")); // prettier-ignore
  };
  const one = draw(false);
  assert.ok(
    one.some((d) => d.split("L").length > 20),
    "a trace was drawn",
  );
  assert.deepEqual(draw(true), one);
});

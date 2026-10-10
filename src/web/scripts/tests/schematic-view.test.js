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

// jsdom tests for the schematic view (Feature 150): the pure SVG builders and
// the live overlays (sim tint, chip status, shared probe highlight), plus the
// class wiring — re-render on doc change, and symbol-drag → schematicPos.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { layout } from "../model/schematic-layout.js";

const {
  buildSchematicSvg,
  applyLevels,
  applyStatus,
  applyHighlight,
  SchematicView,
} = await import("../components/schematic-view.js");

const pin = (componentId, p, role) => ({ componentId, pin: p, role });
function netlistOf(nets, names = new Map()) {
  return {
    nets: new Map(nets.map((n) => [n.id, n])),
    names,
    netOfPoint: new Map(),
  };
}
function twoChipDoc() {
  return {
    components: [
      { id: "c1", ref: "74LS00", board: "bb1" },
      { id: "c2", ref: "74LS00", board: "bb1" },
    ],
  };
}
/** c1 out → c2 in on net n1, plus a VCC net. */
function twoChipNetlist() {
  return netlistOf([
    {
      id: "n1",
      pins: [pin("c1", 3, "output"), pin("c2", 1, "input")],
      terminals: [],
      rails: [],
    },
    {
      id: "vcc",
      pins: [pin("c1", 14, "vcc")],
      terminals: ["psu1.+"],
      rails: [],
    },
  ]);
}

test("buildSchematicSvg draws a node, edge, and power symbol per layout item", () => {
  resetDom();
  const result = layout(twoChipDoc(), twoChipNetlist());
  const svg = buildSchematicSvg(result);

  assert.equal(
    svg.querySelectorAll(".schematic-node").length,
    result.nodes.length,
  );
  assert.equal(
    svg.querySelectorAll(".schematic-edge").length,
    result.edges.length,
  );
  assert.equal(
    svg.querySelectorAll(".schematic-power").length,
    result.powerStubs.length,
  );
  // The signal edge carries its net id so overlays can find it.
  const edge = svg.querySelector(".schematic-edge");
  assert.equal(edge.getAttribute("data-nets"), "n1");
  // Each symbol shows its part number.
  assert.ok(
    [...svg.querySelectorAll(".schematic-label")].some(
      (t) => t.textContent === "74LS00",
    ),
  );
});

test("applyLevels tints by net level only while running", () => {
  resetDom();
  const svg = buildSchematicSvg(layout(twoChipDoc(), twoChipNetlist()));
  const edge = svg.querySelector('.schematic-edge[data-nets="n1"]');

  applyLevels(svg, new Map([["n1", "H"]]), true);
  assert.equal(edge.dataset.level, "H");

  applyLevels(svg, new Map([["n1", "H"]]), false); // stopped clears the tint
  assert.equal(edge.dataset.level, undefined);
});

test("applyStatus marks a chip's health on its node", () => {
  resetDom();
  const svg = buildSchematicSvg(layout(twoChipDoc(), twoChipNetlist()));
  applyStatus(svg, new Map([["c1", { status: "damaged" }]]), true);
  const c1 = svg.querySelector('.schematic-node[data-id="c1"]');
  assert.ok(c1.classList.contains("schematic-node--damaged"));
  applyStatus(svg, new Map(), false); // stopped clears
  assert.ok(!c1.classList.contains("schematic-node--damaged"));
});

test("applyHighlight lights only the probed net", () => {
  resetDom();
  const svg = buildSchematicSvg(layout(twoChipDoc(), twoChipNetlist()));
  const edge = svg.querySelector('.schematic-edge[data-nets="n1"]');
  applyHighlight(svg, "n1");
  assert.ok(edge.classList.contains("schematic--highlight"));
  applyHighlight(svg, null);
  assert.ok(!edge.classList.contains("schematic--highlight"));
});

test("SchematicView renders and re-renders on doc change", () => {
  resetDom();
  const viewport = document.createElement("div");
  document.body.append(viewport);

  let components = twoChipDoc().components;
  const doc = { toJSON: () => ({ components }) };
  const view = new SchematicView(viewport, {
    doc,
    onSetSchematicPos() {},
    netlist: { get: () => twoChipNetlist() },
  });

  assert.equal(viewport.querySelectorAll(".schematic-node").length, 2);

  // A doc change drops a chip and re-renders.
  components = [components[0]];
  window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  assert.equal(viewport.querySelectorAll(".schematic-node").length, 1);

  view.dispose();
});

test("SchematicView tints and highlights from the shared events", () => {
  resetDom();
  const viewport = document.createElement("div");
  document.body.append(viewport);
  const doc = { toJSON: () => twoChipDoc() };
  const view = new SchematicView(viewport, {
    doc,
    onSetSchematicPos() {},
    netlist: { get: () => twoChipNetlist() },
  });

  window.dispatchEvent(
    new CustomEvent("chiphippo:sim-state", {
      detail: {
        running: true,
        netLevels: new Map([["n1", "L"]]),
        chipStatus: new Map(),
      },
    }),
  );
  assert.equal(
    viewport.querySelector('.schematic-edge[data-nets="n1"]').dataset.level,
    "L",
  );

  window.dispatchEvent(
    new CustomEvent("chiphippo:net-probed", { detail: { netId: "n1" } }),
  );
  assert.ok(
    viewport
      .querySelector('.schematic-edge[data-nets="n1"]')
      .classList.contains("schematic--highlight"),
  );

  view.dispose();
});

test("a hidden schematic remembers the live levels and paints them when shown", () => {
  resetDom();
  const viewport = document.createElement("div");
  viewport.hidden = true;
  document.body.append(viewport);
  const doc = { toJSON: () => twoChipDoc() };
  const view = new SchematicView(viewport, {
    doc,
    onSetSchematicPos() {},
    netlist: { get: () => twoChipNetlist() },
  });
  const edge = () => viewport.querySelector('.schematic-edge[data-nets="n1"]');
  const before = edge().dataset.level;
  window.dispatchEvent(
    new CustomEvent("chiphippo:sim-state", {
      detail: { running: true, netLevels: new Map([["n1", "L"]]), chipStatus: new Map() }, // prettier-ignore
    }),
  );
  assert.equal(edge().dataset.level, before, "nothing painted while hidden");
  view.setVisible(true);
  assert.equal(edge().dataset.level, "L", "the last board, painted on show");
  view.dispose();
});

test("the schematic carries the desk's zoom cluster, wired to its own camera", () => {
  resetDom();
  const viewport = document.createElement("div");
  document.body.append(viewport);
  const doc = { toJSON: () => twoChipDoc() };
  const view = new SchematicView(viewport, {
    doc,
    onSetSchematicPos() {},
    netlist: { get: () => twoChipNetlist() },
  });

  // Same cluster, same classes — one CSS block serves both viewports.
  const readout = viewport.querySelector(".desk-zoom .desk-zoom-readout");
  const [outBtn, inBtn] = viewport.querySelectorAll(".desk-zoom-btn");
  assert.ok(readout && outBtn && inBtn, "−/readout/+ mounted in the viewport");
  assert.equal(readout.textContent, "90%", "mirrors the initial camera");

  inBtn.click();
  const zoomed = readout.textContent;
  assert.notEqual(zoomed, "90%", "+ zooms the schematic camera");

  readout.click();
  assert.equal(readout.textContent, "100%", "the readout resets the zoom");

  view.dispose();
});

test("dragging a symbol commits a schematicPos nudge", () => {
  resetDom();
  const viewport = document.createElement("div");
  document.body.append(viewport);
  const doc = { toJSON: () => twoChipDoc() };
  const calls = [];
  const view = new SchematicView(viewport, {
    doc,
    onSetSchematicPos: (id, x, y) => calls.push({ id, x, y }),
    netlist: { get: () => twoChipNetlist() },
  });

  const nodeEl = viewport.querySelector('.schematic-node[data-id="c2"]');
  const down = new window.MouseEvent("pointerdown", {
    bubbles: true,
    button: 0,
    clientX: 10,
    clientY: 10,
  });
  nodeEl.dispatchEvent(down);
  viewport.dispatchEvent(
    new window.MouseEvent("pointermove", {
      bubbles: true,
      clientX: 60,
      clientY: 40,
    }),
  );
  viewport.dispatchEvent(
    new window.MouseEvent("pointerup", {
      bubbles: true,
      clientX: 60,
      clientY: 40,
    }),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "c2");
  assert.ok(Number.isFinite(calls[0].x) && Number.isFinite(calls[0].y));

  view.dispose();
});

test("a symbol drag ends with the window's focus — and with an undo — committing nothing", () => {
  for (const interrupt of [
    () => window.dispatchEvent(new window.Event("blur")),
    () => window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed", { detail: { replaced: true } })), // prettier-ignore
  ]) {
    resetDom();
    const viewport = document.createElement("div");
    document.body.append(viewport);
    const calls = [];
    const view = new SchematicView(viewport, {
      doc: { toJSON: () => twoChipDoc() },
      onSetSchematicPos: (id, x, y) => calls.push({ id, x, y }),
      netlist: { get: () => twoChipNetlist() },
    });
    const at = (type, target, x, y) =>
      target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y })); // prettier-ignore
    at("pointerdown", viewport.querySelector('.schematic-node[data-id="c2"]'), 10, 10); // prettier-ignore
    at("pointermove", viewport, 60, 40);
    interrupt(); // ⌘-Tab away, or ⌘Z replaces the document
    // The next click anywhere must not drop the symbol there.
    at("pointerup", viewport, 90, 90);
    at("pointerdown", viewport, 90, 90);
    at("pointerup", viewport, 90, 90);
    assert.deepEqual(calls, []);
    view.dispose();
  }
});

test("a symbol drag outlives a document change that replaces nothing (a chip the run burnt)", () => {
  resetDom();
  const viewport = document.createElement("div");
  document.body.append(viewport);
  const calls = [];
  const view = new SchematicView(viewport, {
    doc: { toJSON: () => twoChipDoc() },
    onSetSchematicPos: (id, x, y) => calls.push({ id, x, y }),
    netlist: { get: () => twoChipNetlist() },
  });
  const at = (type, target, x, y) =>
    target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y })); // prettier-ignore
  at("pointerdown", viewport.querySelector('.schematic-node[data-id="c2"]'), 10, 10); // prettier-ignore
  at("pointermove", viewport, 60, 40);
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed")); // a damage latch
  at("pointerup", viewport, 60, 40);
  assert.equal(calls.length, 1, "the drop still lands");
  assert.equal(calls[0].id, "c2");
  view.dispose();
});

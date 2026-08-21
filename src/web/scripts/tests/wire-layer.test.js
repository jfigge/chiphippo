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

// jsdom tests for the wire overlay (components/wire-layer.js).

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { holePosition } from "../model/breadboard.js";

const { WireLayer } = await import("../components/wire-layer.js");

function deskWithWire() {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // bb1
  doc.addBoard("pins-tiny", 100, 0); // bb2
  doc.addWire({ from: "bb1.a1", to: "bb1.a5", color: "green" });
  return doc;
}

test("renders one .wire group per wire with color + geometry", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire();
  doc.addWire({ from: "bb1.j1", to: "bb2.a1", color: "red" }); // cross-board

  new WireLayer(layer, doc, {});
  const groups = layer.querySelectorAll(".wire");
  assert.equal(groups.length, 2);

  const [w1] = groups;
  assert.equal(w1.dataset.wireId, "w1");
  assert.equal(
    w1.style.getPropertyValue("--wire-color"),
    "var(--color-wire-green)",
  );
  // Path endpoints land exactly on the hole centers (world px).
  const a = holePosition("pins-full", "a1");
  const d = w1.querySelector(".wire-core").getAttribute("d");
  assert.ok(d.startsWith(`M ${a.x * PX_PER_UNIT} ${a.y * PX_PER_UNIT} `), d);
  // Hit + outline + core + two caps per wire.
  assert.equal(w1.querySelectorAll("path").length, 3);
  assert.equal(w1.querySelectorAll(".wire-cap").length, 2);
});

test("re-renders on chiphippo:doc-changed (add + recolor)", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire();
  new WireLayer(layer, doc, {});
  assert.equal(layer.querySelectorAll(".wire").length, 1);

  doc.addWire({ from: "bb1.b1", to: "bb1.b5", color: "blue" });
  doc.recolorWire("w1", "purple");
  window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));

  const groups = layer.querySelectorAll(".wire");
  assert.equal(groups.length, 2);
  assert.equal(
    groups[0].style.getPropertyValue("--wire-color"),
    "var(--color-wire-purple)",
  );
});

test("selection class survives a re-render; click reports the id", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire();
  const clicks = [];
  const wires = new WireLayer(layer, doc, {
    onSelect: (id) => clicks.push(id),
  });

  wires.setSelected("w1");
  assert.ok(layer.querySelector(".wire").classList.contains("wire--selected"));
  window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  assert.ok(layer.querySelector(".wire").classList.contains("wire--selected"));
  wires.setSelected(null);
  assert.ok(!layer.querySelector(".wire").classList.contains("wire--selected"));

  layer
    .querySelector(".wire")
    .dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.deepEqual(clicks, ["w1"]);
});

test("board-drag overrides shift wire endpoints live", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire();
  const wires = new WireLayer(layer, doc, {});

  const a = holePosition("pins-full", "a1");
  wires.render(new Map([["bb1", { x: 50, y: 7 }]]));
  const d = layer.querySelector(".wire-core").getAttribute("d");
  assert.ok(
    d.startsWith(`M ${(50 + a.x) * PX_PER_UNIT} ${(7 + a.y) * PX_PER_UNIT} `),
    d,
  );
});

test("setEndpointDrag pins one end to a cursor point; null restores the doc", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire(); // w1: bb1.a1 → bb1.a5
  const wires = new WireLayer(layer, doc, {});

  // Drag the `to` end to an arbitrary world-px point over an illegal spot.
  wires.setEndpointDrag({
    wireId: "w1",
    end: "to",
    world: { x: 999, y: 0 },
    legal: false,
  });
  const group = layer.querySelector(".wire");
  const d = group.querySelector(".wire-core").getAttribute("d");
  assert.ok(d.endsWith("999 0"), d); // the bezier ends at the dragged point
  assert.ok(group.classList.contains("wire--dragging"));
  assert.ok(group.classList.contains("wire-preview--illegal"));
  // The dragged end's cap follows too.
  const caps = group.querySelectorAll(".wire-cap");
  assert.equal(caps[1].getAttribute("cx"), "999");

  // Clearing the drag redraws from the document (back on hole a5).
  wires.setEndpointDrag(null);
  const a5 = holePosition("pins-full", "a5");
  const restored = layer.querySelector(".wire-core").getAttribute("d");
  assert.ok(
    restored.endsWith(`${a5.x * PX_PER_UNIT} ${a5.y * PX_PER_UNIT}`),
    restored,
  );
  assert.ok(!layer.querySelector(".wire").classList.contains("wire--dragging"));
});

test("setWholeDrag overrides BOTH endpoints; null restores the doc", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire(); // w1: bb1.a1 → bb1.a5
  const wires = new WireLayer(layer, doc, {});

  // Translate the whole wire: both caps ride the supplied world-px points.
  wires.setWholeDrag({
    wireId: "w1",
    from: { x: 100, y: 200 },
    to: { x: 300, y: 200 },
    legal: false,
  });
  const group = layer.querySelector(".wire");
  const d = group.querySelector(".wire-core").getAttribute("d");
  assert.ok(d.startsWith("M 100 200"), d); // starts at the dragged `from`
  assert.ok(d.endsWith("300 200"), d); // ends at the dragged `to`
  assert.ok(group.classList.contains("wire--dragging"));
  assert.ok(group.classList.contains("wire-preview--illegal"));
  const caps = group.querySelectorAll(".wire-cap");
  assert.equal(caps[0].getAttribute("cx"), "100");
  assert.equal(caps[1].getAttribute("cx"), "300");

  // Clearing redraws from the document (back on holes a1 → a5).
  wires.setWholeDrag(null);
  const a1 = holePosition("pins-full", "a1");
  const restored = layer.querySelector(".wire-core").getAttribute("d");
  assert.ok(
    restored.startsWith(`M ${a1.x * PX_PER_UNIT} ${a1.y * PX_PER_UNIT}`),
    restored,
  );
  assert.ok(!layer.querySelector(".wire").classList.contains("wire--dragging"));
});

test("setPartDrag previews MANY riding wires, by the address each lands on", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire(); // w1: bb1.a1 → bb1.a5
  doc.addWire({ from: "bb1.j1", to: "bb1.j5" }); // w2 — not riding
  const wires = new WireLayer(layer, doc, {});

  // Unlike the single-wire channels above, a part carries a SET — and each end
  // is an ADDRESS, not a cursor point, because a riding end always lands in a
  // hole, so the preview resolves it exactly as the committed wire will.
  wires.setPartDrag({
    shifts: new Map([["w1", { from: "bb1.a3", to: "bb1.a7" }]]),
    legal: true,
  });
  const [w1, w2] = layer.querySelectorAll(".wire");
  const a3 = holePosition("pins-full", "a3");
  assert.ok(
    w1
      .querySelector(".wire-core")
      .getAttribute("d")
      .startsWith(`M ${a3.x * PX_PER_UNIT} ${a3.y * PX_PER_UNIT}`),
  );
  assert.ok(w1.classList.contains("wire--dragging"));
  assert.ok(!w1.classList.contains("wire-preview--illegal"));
  assert.ok(!w2.classList.contains("wire--dragging"), "w2 is uninvolved");

  // One `legal` covers the lot — the drop is all-or-nothing, so every rider
  // tints with the same red the dragged part shows. An entry with no addresses
  // is the refused plan: the wire is still drawn where it is, but marked.
  wires.setPartDrag({ shifts: new Map([["w1", {}]]), legal: false });
  const tinted = layer.querySelector(".wire");
  const home = holePosition("pins-full", "a1");
  assert.ok(tinted.classList.contains("wire-preview--illegal"));
  assert.ok(
    tinted
      .querySelector(".wire-core")
      .getAttribute("d")
      .startsWith(`M ${home.x * PX_PER_UNIT} ${home.y * PX_PER_UNIT}`),
  );

  wires.setPartDrag(null);
  assert.ok(!layer.querySelector(".wire").classList.contains("wire--dragging"));
});

test("a ROUTED rider's bend previews translated, in desk units", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addWire({
    from: "bb1.a1",
    to: "bb1.a5",
    layout: "routed",
    points: [{ x: 10, y: 20 }],
  });
  const wires = new WireLayer(layer, doc, {});

  wires.setPartDrag({
    shifts: new Map([
      ["w1", { from: "bb1.a3", to: "bb1.a7", points: { dx: 2, dy: 0 } }],
    ]),
    legal: true,
  });
  // The waypoint knob sits at the SHIFTED point — a both-ends rider translates
  // rigidly, bend and all, and the shift is in the same units the doc stores.
  const knob = layer.querySelector(".wire-point");
  assert.equal(Number(knob.getAttribute("cx")), 12 * PX_PER_UNIT);
  assert.equal(Number(knob.getAttribute("cy")), 20 * PX_PER_UNIT);

  wires.setPartDrag(null);
  assert.equal(
    Number(layer.querySelector(".wire-point").getAttribute("cx")),
    10 * PX_PER_UNIT,
  );
});

test("a riding BUS MEMBER carries the ribbon with it", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const members = [];
  for (let i = 0; i < 4; i++) {
    members.push(
      doc.addWire({ from: `bb1.a${1 + i}`, to: `bb1.j${20 + i}` }).id,
    );
  }
  doc.addBus("D[3:0]", members);
  const wires = new WireLayer(layer, doc, {});
  const band = () => layer.querySelector(".bus-band").innerHTML;
  const before = band();

  // A ribbon's collars are the centroid of its members' endpoints, so shifting
  // every near end shifts the body too — with no bus code at all. That is the
  // whole reason #wireEnds is shared with #busGeometry rather than inlined in
  // the wire loop: otherwise the leads would move and the ribbon would not.
  wires.setPartDrag({
    shifts: new Map(
      members.map((id, i) => [
        id,
        { from: `bb1.a${9 + i}`, to: `bb1.j${20 + i}` },
      ]),
    ),
    legal: true,
  });
  assert.notEqual(band(), before, "the ribbon followed its leads");

  wires.setPartDrag(null);
  assert.equal(band(), before);
});

test("setPreview shows, retints, and hides the rubber band", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const wires = new WireLayer(layer, new DeskDoc(null), {});

  wires.setPreview({
    from: { x: 0, y: 0 },
    to: { x: 100, y: 0 },
    color: "red",
    legal: true,
  });
  const preview = layer.querySelector(".wire-preview");
  assert.ok(preview);
  assert.ok(!preview.classList.contains("wire-preview--illegal"));

  wires.setPreview({
    from: { x: 0, y: 0 },
    to: { x: 50, y: 0 },
    color: "red",
    legal: false,
  });
  assert.ok(preview.classList.contains("wire-preview--illegal"));

  wires.setPreview(null);
  assert.equal(layer.querySelector(".wire-preview"), null);
});

test("resolves PSU terminal endpoints (and drag overrides)", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = new DeskDoc(null);
  // A whole kit: bb1 top rail, bb2 pin-board, bb3 bottom rail.
  doc.addKit("full", 0, 0);
  doc.addPsu(80, 10);
  doc.addWire({ from: "psu1.+", to: "bb1.+1", color: "red" });

  const wires = new WireLayer(layer, doc, {});
  // psu1.+ terminal sits at (80+2, 10+4) pitch units.
  let d = layer.querySelector(".wire-core").getAttribute("d");
  assert.ok(d.startsWith(`M ${82 * PX_PER_UNIT} ${14 * PX_PER_UNIT} `), d);

  wires.render(new Map([["psu1", { x: 100, y: 10 }]]));
  d = layer.querySelector(".wire-core").getAttribute("d");
  assert.ok(d.startsWith(`M ${102 * PX_PER_UNIT} ${14 * PX_PER_UNIT} `), d);
});

test("a highlighted wire renders last; releasing restores document order", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    ids.push(
      doc.addWire({
        from: `bb1.a${10 + i}`,
        to: `bb1.a${30 + i}`,
        color: "blue",
      }).id,
    );
  }
  const loose = doc.addWire({ from: "bb1.j1", to: "bb1.j5", color: "red" }).id;
  doc.addBus("D[3:0]", ids, { color: "blue" });
  const wires = new WireLayer(layer, doc, {});

  // The SVG's own child order IS the paint order (SVG has no z-index).
  const kindOf = (el) =>
    el.dataset.wireId
      ? `wire:${el.dataset.wireId}`
      : el.classList.contains("bus-end-handle")
        ? "handle"
        : el.querySelector(".bus-band-hit")
          ? "bandhit"
          : "cover";
  const order = () =>
    [...layer.querySelector(".wire-svg").children].map(kindOf);

  const before = order();
  assert.ok(before.includes("cover"), "the ribbon body rendered");
  assert.ok(
    before.indexOf(`wire:${ids[1]}`) < before.indexOf("cover"),
    "unselected, a lead sits UNDER the body that paints over it",
  );

  wires.setSelected(ids[1]);
  const sel = order();
  assert.ok(
    sel.indexOf(`wire:${ids[1]}`) > sel.indexOf("cover"),
    "selected, it is lifted over the body",
  );
  assert.ok(
    sel.indexOf(`wire:${ids[1]}`) < sel.indexOf("handle"),
    "but stays under the end handles (they keep hit-test priority)",
  );
  assert.ok(
    layer
      .querySelector(`.wire[data-wire-id="${ids[1]}"]`)
      .classList.contains("wire--selected"),
  );
  // Every other wire keeps its document-order slot.
  assert.deepEqual(
    sel.filter((k) => k.startsWith("wire:") && k !== `wire:${ids[1]}`),
    [ids[0], ids[2], ids[3], loose].map((id) => `wire:${id}`),
  );

  wires.setSelected(null);
  assert.deepEqual(order(), before, "releasing drops it back into place");

  // A LOOSE wire is lifted by the same rule — highlighting one is how you
  // trace it, and a run crossing under six others is exactly the run worth
  // pointing at, ribbon or no ribbon.
  wires.setSelected(loose);
  const one = order();
  assert.equal(
    one.filter((k) => k.startsWith("wire:")).at(-1),
    `wire:${loose}`,
    "the highlighted wire draws after every other wire",
  );
  assert.ok(
    one.indexOf(`wire:${loose}`) > one.indexOf("cover"),
    "and over the ribbon body it would otherwise pass under",
  );
  assert.ok(
    one.indexOf(`wire:${loose}`) < one.indexOf("handle"),
    "but still under the end handles",
  );
  assert.ok(
    layer
      .querySelector(`.wire[data-wire-id="${loose}"]`)
      .classList.contains("wire--selected"),
  );
  wires.setSelected(null);
  assert.deepEqual(order(), before, "and drops back into document order");

  // A MARQUEE lifts every member, keeping their document order among
  // themselves — the raise is derived per render, not a stack of appends.
  wires.setSelectedMany([ids[0], loose]);
  const many = order();
  assert.deepEqual(many.filter((k) => k.startsWith("wire:")).slice(-2), [
    `wire:${ids[0]}`,
    `wire:${loose}`,
  ]);
  wires.setSelectedMany([]);
  assert.deepEqual(order(), before, "clearing restores every slot");
});

test("setFaded cuts each wire back to two masked stubs, and back", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addWire({ from: "bb1.a1", to: "bb1.a40", color: "green" }); // w1, a long run
  const wires = new WireLayer(layer, doc, {});
  const group = () => layer.querySelector('.wire[data-wire-id="w1"]');
  const coreD = () => group().querySelector(".wire-core").getAttribute("d");
  const whole = coreD();

  wires.setFaded(true);
  assert.equal(wires.faded, true);
  assert.equal(group().getAttribute("mask"), "url(#wire-fade-w1)");
  // Two subpaths (one stub per end) instead of one run…
  assert.equal(coreD().match(/M /g).length, 2, coreD());
  // …and the HIT stroke is cut back with them, so the vanished middle can't
  // swallow a click meant for whatever is underneath it.
  assert.equal(group().querySelector(".wire-hit").getAttribute("d"), coreD());
  // The mask itself: one falloff circle per end, centred on its own hole.
  const circles = [...layer.querySelectorAll("defs mask circle")];
  assert.equal(circles.length, 2);
  const a1 = holePosition("pins-full", "a1");
  assert.equal(Number(circles[0].getAttribute("cx")), a1.x * PX_PER_UNIT);
  assert.equal(Number(circles[0].getAttribute("cy")), a1.y * PX_PER_UNIT);
  assert.ok(Number(circles[0].getAttribute("r")) > 0);
  // …painted with the ONE shared gradient, opaque then ramping to clear.
  assert.equal(
    circles[0].getAttribute("fill"),
    "url(#wire-fade-falloff)",
    "every circle shares one gradient",
  );
  const stops = [...layer.querySelectorAll("defs stop")];
  assert.equal(stops.length, 3);
  assert.deepEqual(
    stops.map((s) => s.getAttribute("stop-opacity")),
    [null, null, "0"],
  );
  assert.equal(layer.querySelectorAll("defs mask").length, 1);

  wires.setFaded(false);
  assert.equal(group().getAttribute("mask"), null);
  assert.equal(coreD(), whole);
  assert.equal(layer.querySelectorAll("defs").length, 0);
});

test("a faded wire comes back whole while selected", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire();
  doc.addWire({ from: "bb1.j1", to: "bb1.j9", color: "red" }); // w2
  const wires = new WireLayer(layer, doc, {});
  const group = (id) => layer.querySelector(`.wire[data-wire-id="${id}"]`);
  wires.setFaded(true);
  const stub = group("w1").querySelector(".wire-core").getAttribute("d");

  wires.setSelectedMany(["w1"]);
  assert.equal(group("w1").getAttribute("mask"), null, "no fade while picked");
  assert.equal(
    group("w1").querySelector(".wire-core").getAttribute("d").match(/M /g)
      .length,
    1,
    "the whole run is drawn again",
  );
  assert.ok(group("w1").classList.contains("wire--selected"));
  // Its neighbour is untouched by the selection.
  assert.equal(group("w2").getAttribute("mask"), "url(#wire-fade-w2)");

  wires.setSelectedMany([]);
  assert.equal(group("w1").getAttribute("mask"), "url(#wire-fade-w1)");
  assert.equal(group("w1").querySelector(".wire-core").getAttribute("d"), stub);
});

test("fading puts the ribbon away but keeps its members' leads aimed at it", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    ids.push(doc.addWire({ from: `bb1.a${10 + i}`, to: `bb1.a${30 + i}` }).id);
  }
  const loose = doc.addWire({ from: "bb1.j1", to: "bb1.j9" }).id;
  doc.addBus("D[3:0]", ids, { color: "blue" });

  const wires = new WireLayer(layer, doc, {});
  const group = (id) => layer.querySelector(`.wire[data-wire-id="${id}"]`);
  const coreD = (id) => group(id).querySelector(".wire-core").getAttribute("d");
  const leads = coreD(ids[0]); // its two leads off the ribbon's collars
  assert.ok(layer.querySelector(".bus-band-fill"), "the ribbon body is drawn");

  wires.setFaded(true);
  assert.equal(layer.querySelectorAll(".bus-band").length, 0, "no band");
  assert.equal(
    layer.querySelectorAll(".bus-end-handle").length,
    0,
    "no handle",
  );
  for (const id of ids) {
    assert.equal(
      group(id).getAttribute("mask"),
      `url(#wire-fade-${id})`,
      `${id} fades`,
    );
  }
  // The lead geometry is UNTOUCHED — the wire still leaves its hole pointing
  // at the collar the (now hidden) ribbon runs through; only the mask changed.
  assert.equal(coreD(ids[0]), leads);
  // And it fades from the HOLE outward, over no more than the lead itself, so
  // the lead vanishes before its collar end rather than stopping dead there.
  const [, cx, cy, , , ax, ay] = /^M (\S+) (\S+) Q (\S+) (\S+) (\S+) (\S+)/
    .exec(leads)
    .map(Number);
  const circle = layer.querySelector(`mask[id="wire-fade-${ids[0]}"] circle`);
  assert.equal(Number(circle.getAttribute("cx")), ax, "centred on the hole");
  assert.equal(Number(circle.getAttribute("cy")), ay);
  const lead = Math.hypot(ax - cx, ay - cy);
  assert.ok(Number(circle.getAttribute("r")) < lead, `r vs lead ${lead}`);
  assert.ok(layer.querySelector(`mask[id="wire-fade-${loose}"]`));

  // Turning it back off restores the ribbon; the leads never moved.
  wires.setFaded(false);
  assert.ok(layer.querySelector(".bus-band-fill"));
  assert.equal(layer.querySelectorAll(".bus-end-handle").length, 2);
  assert.equal(group(ids[0]).getAttribute("mask"), null);
  assert.equal(coreD(ids[0]), leads);
});

// ── Routed wires (the "Layout Method" property) ─────────────────────────────

test("a routed wire draws as a polyline through its waypoints, with knobs", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire(); // w1: bb1.a1 → bb1.a5
  doc.setWireLayout("w1", "routed");
  doc.addWirePoint("w1", 0, { x: 3, y: 20 });
  doc.addWirePoint("w1", 1, { x: 7, y: 24 });

  new WireLayer(layer, doc, {});
  const group = layer.querySelector(".wire");
  assert.ok(group.classList.contains("wire--routed"));

  const a = holePosition("pins-full", "a1");
  const b = holePosition("pins-full", "a5");
  assert.equal(
    group.querySelector(".wire-core").getAttribute("d"),
    `M ${a.x * PX_PER_UNIT} ${a.y * PX_PER_UNIT} L 30 200 L 70 240 ` +
      `L ${b.x * PX_PER_UNIT} ${b.y * PX_PER_UNIT}`,
    "straight segments, no sag, in world px",
  );
  // One knob per WAYPOINT — never on the endpoints, which have caps already.
  assert.deepEqual(
    [...group.querySelectorAll(".wire-point")].map((c) => [
      Number(c.getAttribute("cx")),
      Number(c.getAttribute("cy")),
    ]),
    [
      [30, 200],
      [70, 240],
    ],
  );
});

test("a routed wire's in-flight bend previews without touching the document", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire();
  doc.setWireLayout("w1", "routed");
  const wires = new WireLayer(layer, doc, {});

  // An INSERT drag: the point that would be added shows in the run…
  wires.setPointDrag({
    wireId: "w1",
    index: 0,
    insert: true,
    world: { x: 44, y: 210 },
    merge: false,
  });
  let group = layer.querySelector(".wire");
  assert.match(group.querySelector(".wire-core").getAttribute("d"), /L 44 210/);
  assert.equal(group.querySelectorAll(".wire-point").length, 1);
  assert.ok(
    group.querySelector(".wire-point").classList.contains("wire-point--active"),
  );
  assert.equal(doc.getWire("w1").points, undefined, "…but is not committed");

  // A merge shows on the dragged knob — releasing there takes the bend out.
  wires.setPointDrag({
    wireId: "w1",
    index: 0,
    insert: true,
    world: { x: 10, y: 120 },
    merge: true,
  });
  assert.ok(
    layer
      .querySelector(".wire-point")
      .classList.contains("wire-point--merging"),
  );

  // Dropping the preview redraws from the document — a straight run again.
  wires.setPointDrag(null);
  group = layer.querySelector(".wire");
  assert.equal(group.querySelectorAll(".wire-point").length, 0);
  assert.doesNotMatch(
    group.querySelector(".wire-core").getAttribute("d"),
    /L 44 210/,
  );
});

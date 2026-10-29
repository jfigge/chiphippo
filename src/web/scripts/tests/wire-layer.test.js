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

// jsdom tests for the wire overlay (components/wire-layer.js).

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { holePosition } from "../model/breadboard.js";
import { worldOfAddress } from "../model/occupancy.js";

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
  // The whole wire rides bb1: its resting path, translated by the board's
  // offset — so its first end lands where the moved hole is.
  const g = layer.querySelector(".wire");
  const d = g.querySelector(".wire-core").getAttribute("d");
  const [, x0, y0] = /^M (\S+) (\S+) /.exec(d);
  // Every wire on the desk rides the one move, so the svg itself carries the
  // translation (one CSS transform, not one per group).
  assert.equal(g.hasAttribute("transform"), false);
  const svg = layer.querySelector(".wire-svg");
  const [, tx, ty] = /translate\((\S+)px, (\S+)px\)/.exec(svg.style.transform); // prettier-ignore
  assert.ok(Math.abs(+x0 + +tx - (50 + a.x) * PX_PER_UNIT) < 1e-9);
  assert.ok(Math.abs(+y0 + +ty - (7 + a.y) * PX_PER_UNIT) < 1e-9);
  // Put down, the svg is back where it stands.
  wires.render();
  assert.equal(svg.style.transform, "");
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
  // Both ends ride one shift, so the wire is its resting drawing translated
  // (the group's transform) — where its first end is drawn is the sum.
  const [, x0, y0] = /^M (\S+) (\S+) /.exec(
    w1.querySelector(".wire-core").getAttribute("d"),
  );
  const [, tx = 0, ty = 0] =
    /translate\((\S+) (\S+)\)/.exec(w1.getAttribute("transform") ?? "") ?? [];
  assert.ok(Math.abs(+x0 + +tx - a3.x * PX_PER_UNIT) < 1e-9);
  assert.ok(Math.abs(+y0 + +ty - a3.y * PX_PER_UNIT) < 1e-9);
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
  // (Where it is DRAWN: its own centre, its group's transform and the svg's —
  // the rider keeps its resting group, translated.)
  const svg = layer.querySelector(".wire-svg");
  const drawn = (knob) => {
    const g = knob.closest("g.wire");
    const [, gx = 0, gy = 0] = /translate\((\S+) (\S+)\)/.exec(g.getAttribute("transform") ?? "") ?? []; // prettier-ignore
    const [, sx = 0, sy = 0] = /translate\((\S+)px, (\S+)px\)/.exec(svg.style.transform) ?? []; // prettier-ignore
    return {
      x: Number(knob.getAttribute("cx")) + +gx + +sx,
      y: Number(knob.getAttribute("cy")) + +gy + +sy,
    };
  };
  const knob = layer.querySelector(".wire-point");
  assert.ok(Math.abs(drawn(knob).x - 12 * PX_PER_UNIT) < 1e-6);
  assert.ok(Math.abs(drawn(knob).y - 20 * PX_PER_UNIT) < 1e-6);

  wires.setPartDrag(null);
  const back = drawn(layer.querySelector(".wire-point"));
  assert.ok(Math.abs(back.x - 10 * PX_PER_UNIT) < 1e-6);
  assert.ok(Math.abs(back.y - 20 * PX_PER_UNIT) < 1e-6);
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
  // Straight runs joined by ROUNDED corners (Feature 360) — a real lead cannot
  // be folded to a point. The run still starts and ends exactly on its holes,
  // and there is no sag: a routed wire goes where it was put.
  const d = group.querySelector(".wire-core").getAttribute("d");
  assert.match(d, new RegExp(`^M ${a.x * PX_PER_UNIT} ${a.y * PX_PER_UNIT} L`));
  assert.match(d, new RegExp(`L ${b.x * PX_PER_UNIT} ${b.y * PX_PER_UNIT}$`));
  assert.equal((d.match(/ A /g) ?? []).length, 2, "one arc per waypoint");
  assert.doesNotMatch(d, / Q /, "no sag on a routed wire");
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
  // This bend is a 26° spike off a short run, which is sharper than a real lead
  // can be folded — so it is drawn SQUARE and the run passes through the point
  // itself (desk/wire-path.js's deviation limit). A gentler corner gets an arc.
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

// ── Kept groups: a render redraws only what changed ────────────────────────

test("a render keeps every unchanged wire's group and redraws only the moved one", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire(); // w1 on bb1
  doc.addWire({ from: "bb2.a1", to: "bb2.a5", color: "red" }); // w2 on bb2
  const wires = new WireLayer(layer, doc, {});
  const group = (id) => layer.querySelector(`.wire[data-wire-id="${id}"]`);
  const [g1, g2] = [group("w1"), group("w2")];
  const core = (g) => g.querySelector(".wire-core").getAttribute("d");
  const [d1, d2] = [core(g1), core(g2)];
  wires.render();
  assert.equal(group("w1"), g1, "nothing changed: the same nodes");
  assert.equal(group("w2"), g2);
  // One wire's end dragged: only that wire is redrawn — in its own group
  // (review 2026-10-26: a new group a frame per rider was most of a drag).
  wires.setEndpointDrag({ wireId: "w2", end: "to", world: { x: 999, y: 0 }, legal: true }); // prettier-ignore
  assert.equal(group("w1"), g1, "the untouched wire is kept");
  assert.equal(core(g1), d1, "and not redrawn");
  assert.equal(group("w2"), g2, "the dragged one keeps its group…");
  assert.notEqual(core(g2), d2, "…redrawn");
  assert.equal(
    layer.querySelectorAll(".wire").length,
    2,
    "and nothing piles up",
  );
});

test("selecting lifts the wire over the rest without redrawing anything", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire();
  doc.addWire({ from: "bb1.b1", to: "bb1.b5", color: "red" });
  const wires = new WireLayer(layer, doc, {});
  const order = () => [...layer.querySelectorAll(".wire")].map((g) => g.dataset.wireId); // prettier-ignore
  const g1 = layer.querySelector('.wire[data-wire-id="w1"]');
  assert.deepEqual(order(), ["w1", "w2"]);
  wires.setSelected("w1");
  assert.deepEqual(order(), ["w2", "w1"], "the pick draws last");
  assert.equal(
    layer.querySelector('.wire[data-wire-id="w1"]'),
    g1,
    "the same group, moved",
  );
  assert.ok(g1.classList.contains("wire--selected"));
  wires.setSelected(null);
  assert.deepEqual(order(), ["w1", "w2"], "and back into document order");
  assert.ok(!g1.classList.contains("wire--selected"));
});

test("a wire's click, menu and hover reach the layer's callbacks from the one svg", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire();
  const seen = [];
  new WireLayer(layer, doc, {
    onSelect: (id) => seen.push(["select", id]),
    onContextMenu: (id) => seen.push(["menu", id]),
    onHover: (id) => seen.push(["hover", id]),
  });
  const hit = layer.querySelector('.wire[data-wire-id="w1"] .wire-hit');
  const cap = layer.querySelector('.wire[data-wire-id="w1"] .wire-cap');
  hit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  hit.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true }));
  hit.dispatchEvent(new window.PointerEvent("pointerover", { bubbles: true, relatedTarget: layer })); // prettier-ignore
  // Hit stroke → cap is inside the one wire: no leave, no second enter.
  hit.dispatchEvent(new window.PointerEvent("pointerout", { bubbles: true, relatedTarget: cap })); // prettier-ignore
  cap.dispatchEvent(new window.PointerEvent("pointerover", { bubbles: true, relatedTarget: hit })); // prettier-ignore
  cap.dispatchEvent(new window.PointerEvent("pointerout", { bubbles: true, relatedTarget: layer })); // prettier-ignore
  assert.deepEqual(seen, [
    ["select", "w1"],
    ["menu", "w1"],
    ["hover", "w1"],
    ["hover", null],
  ]);
});

test("a wire whose board is dragged is its resting drawing, translated — not redrawn", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire();
  doc.addWire({ from: "bb1.j1", to: "bb2.a1", color: "red" }); // across both
  const wires = new WireLayer(layer, doc, {});
  const group = (id) => layer.querySelector(`.wire[data-wire-id="${id}"]`);
  const g1 = group("w1");
  const g2 = group("w2");
  const core = (g) => g.querySelector(".wire-core").getAttribute("d");
  const [d1, d2] = [core(g1), core(g2)];
  wires.render(new Map([["bb1", { x: 3, y: 2 }]]));
  assert.equal(group("w1"), g1, "kept");
  assert.equal(core(g1), d1, "not redrawn");
  assert.equal(g1.getAttribute("transform"), `translate(${3 * PX_PER_UNIT} ${2 * PX_PER_UNIT})`); // prettier-ignore
  assert.notEqual(core(g2), d2, "a wire stretched between a moving and a still board is redrawn"); // prettier-ignore
  assert.equal(group("w2").hasAttribute("transform"), false);
  // Dropped (the doc unchanged, the drag over): back at rest, same group.
  wires.render();
  assert.equal(group("w1"), g1);
  assert.equal(g1.hasAttribute("transform"), false);
});

test("a board drag carrying MOST wires moves the svg once and holds the rest still", () => {
  // busy64's kit drag: 3493 wires ride the kit, 5 stretch to the bricks — a
  // transform a frame on each riding group restyled and repainted the lot
  // (pointermove p95 ~130 ms in the app). Here 4 ride, 1 stretches, 1 stays.
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire(); // w1 on bb1
  doc.addWire({ from: "bb1.a10", to: "bb1.a14", color: "red" }); // w2 rides
  doc.addWire({ from: "bb1.j1", to: "bb2.a1", color: "blue" }); // w3 stretches
  doc.addWire({ from: "bb1.b20", to: "bb1.b24", color: "red" }); // w4 rides
  doc.addWire({ from: "bb2.b1", to: "bb2.b4", color: "red" }); // w5 stays
  doc.addWire({ from: "bb1.c30", to: "bb1.c34", color: "red" }); // w6 rides
  const wires = new WireLayer(layer, doc, {});
  const svg = layer.querySelector(".wire-svg");
  const group = (id) => layer.querySelector(`.wire[data-wire-id="${id}"]`);
  const ids = ["w1", "w2", "w3", "w4", "w5", "w6"];
  const before = ids.map(group);
  const order = () => [...svg.children].map((g) => g.dataset.wireId);
  const at = (g) => {
    // Where a group's first point is DRAWN: its path, its own transform and
    // the svg's.
    const [, x, y] = /^M (\S+) (\S+) /.exec(g.querySelector(".wire-core").getAttribute("d")); // prettier-ignore
    const [, gx = 0, gy = 0] = /translate\((\S+) (\S+)\)/.exec(g.getAttribute("transform") ?? "") ?? []; // prettier-ignore
    const [, sx = 0, sy = 0] = /translate\((\S+)px, (\S+)px\)/.exec(svg.style.transform) ?? []; // prettier-ignore
    return { x: +x + +gx + +sx, y: +y + +gy + +sy };
  };
  const near = (p, q) =>
    Math.abs(p.x - q.x) < 1e-9 && Math.abs(p.y - q.y) < 1e-9;
  const rest = Object.fromEntries(ids.map((id) => [id, at(group(id))]));
  const [dx, dy] = [3, 2];
  wires.render(new Map([["bb1", { x: dx, y: dy }]]));
  const [px, py] = [dx * PX_PER_UNIT, dy * PX_PER_UNIT];
  assert.equal(svg.style.transform, `translate(${px}px, ${py}px)`);
  assert.equal(svg.style.willChange, "transform", "its own layer while it slides"); // prettier-ignore
  for (const id of ["w1", "w2", "w4", "w6"]) {
    assert.equal(group(id).hasAttribute("transform"), false, `${id} untouched`);
    assert.ok(near(at(group(id)), { x: rest[id].x + px, y: rest[id].y + py }));
  }
  // The one that stays is held where it was; the stretched one starts on
  // the moved hole (and ends on the still one).
  assert.equal(group("w5").getAttribute("transform"), `translate(${-px} ${-py})`); // prettier-ignore
  assert.ok(near(at(group("w5")), rest.w5));
  assert.ok(near(at(group("w3")), { x: rest.w3.x + px, y: rest.w3.y + py }));
  assert.deepEqual(order(), ids, "every wire keeps its paint slot");
  assert.deepEqual(ids.map(group), before, "and its group");
  // Dropped (the doc unchanged): nothing left translated, nothing moved.
  wires.render();
  assert.equal(svg.style.transform, "");
  assert.equal(svg.style.willChange, "");
  for (const id of ids) assert.equal(group(id).hasAttribute("transform"), false); // prettier-ignore
  for (const id of ids) assert.ok(near(at(group(id)), rest[id]), id);
  assert.deepEqual(order(), ids);
  assert.deepEqual(ids.map(group), before);
});

test("selecting the FIRST of many wires moves only that one node (and back)", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const ids = [];
  for (let c = 1; c <= 40; c++) {
    ids.push(doc.addWire({ from: `bb1.a${c}`, to: `bb1.j${c}` }).id);
  }
  const layer = document.createElement("div");
  document.body.append(layer);
  const wires = new WireLayer(layer, doc);
  wires.render();
  const svg = layer.querySelector(".wire-svg");
  const order = () =>
    [...svg.children].map((el) => el.dataset.wireId).filter(Boolean);
  let moved = 0;
  const mo = new window.MutationObserver((ms) => {
    for (const m of ms) moved += m.addedNodes.length;
  });
  mo.observe(svg, { childList: true });
  wires.setSelected(ids[0]);
  mo.takeRecords().forEach((m) => (moved += m.addedNodes.length));
  assert.deepEqual(order(), [...ids.slice(1), ids[0]], "lifted to the top");
  assert.equal(moved, 1, "one node re-inserted, not the 39 after it");
  moved = 0;
  wires.setSelected(null);
  mo.takeRecords().forEach((m) => (moved += m.addedNodes.length));
  assert.deepEqual(order(), ids, "back in document order");
  assert.equal(moved, 1);
  mo.disconnect();
});

// ── A gesture's sets stay frozen (wire-layer.js, #renderFrame's shortcut) ───
// A live drag keeps a wire that touches nothing moving as last frame drew it,
// unexamined — so a wire has to be drawn at REST in every frame it is not
// touched. That holds because a gesture's moving set (the strips and bricks
// in `overrides`), its riders (setPartDrag's `shifts`) and its carried bends
// (`pointRide` — the frozen `ridingPoints`, less a rider the plan takes whole)
// are read once at the press and never lose a wire before the drag ends in a
// rest render. The layer cannot see a set change; these hold the controller
// to it, and the layer to drawing everything back on the rest render.

test("a rest render puts every wire back, whatever the drag frames before it moved", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire(); // w1 on bb1
  doc.addBoard("pins-tiny", 0, 40); // bb3
  doc.addWire({ from: "bb1.j1", to: "bb3.a1", color: "red" }); // bb1 ↔ bb3
  doc.addWire({ from: "bb2.a1", to: "bb3.a5", color: "blue" }); // bb2 ↔ bb3
  const w4 = doc.addWire({ from: "bb3.a10", to: "bb3.a14", color: "green" });
  doc.setWireLayout(w4.id, "routed");
  doc.setWireRoute(w4.id, [{ x: 20, y: 30 }]);
  const wires = new WireLayer(layer, doc, {});
  const draw = () =>
    [...layer.querySelectorAll("g.wire")].map((g) => [g.dataset.wireId, g.querySelector(".wire-core").getAttribute("d"), g.getAttribute("transform")]); // prettier-ignore
  const svg = layer.querySelector(".wire-svg");
  const rest = draw();
  // Frames whose sets differ — which no gesture sends — then the rest render.
  wires.render(new Map([["bb1", { x: 3, y: 2 }]]));
  wires.render(new Map([["bb2", { x: 103, y: 2 }]]));
  wires.render(new Map([["bb3", { x: 1, y: 44 }]]), { points: new Map([[w4.id, [0]]]), dx: 1, dy: 4 }); // prettier-ignore
  wires.render(
    new Map([
      ["bb1", { x: 3, y: 2 }],
      ["bb2", { x: 103, y: 2 }],
    ]),
  );
  wires.render();
  assert.deepEqual(draw(), rest);
  assert.equal(svg.style.transform, "");
});

test("the desk never changes a gesture's moving set, riders or carried bends before its rest render", async (t) => {
  resetDom();
  const { DeskController } = await import("../components/desk-controller.js");
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const deskView = { surface, camera: { cx: 0, cy: 0, zoom: 1 }, worldFromEvent: () => ({ x: world.x, y: world.y }) }; // prettier-ignore
  const controller = new DeskController({ viewport, deskView, deskDoc: doc });
  controller.addKitAt("full", 0, 0); // bb1 · bb2 · bb3
  controller.addKitAt("half", 0, 40); // bb4 · bb5 · bb6
  const chip = controller.addComponentAt("74LS00", "bb2", "e5");
  const psu = controller.addBrickAt("psu", -40, 0, {});
  doc.addWire({ from: "bb2.a5", to: "bb2.a20", color: "red" }); // rides the chip
  doc.addWire({ from: "bb2.j6", to: "bb5.a6", color: "blue" }); // stretches to the half kit
  doc.addWire({ from: `${psu.id}.+`, to: "bb2.c3", color: "red" }); // to the brick
  doc.addWire({ from: "bb5.j1", to: "bb5.j9", color: "green" }); // stays
  const routed = doc.addWire({ from: "bb2.b30", to: "bb2.b40", color: "red" });
  doc.setWireLayout(routed.id, "routed");
  doc.setWireRoute(routed.id, [{ x: 34, y: 5 }]); // a bend over bb2
  const across = doc.addWire({ from: "bb5.b20", to: "bb5.b28", color: "red" });
  doc.setWireLayout(across.id, "routed");
  doc.setWireRoute(across.id, [{ x: 34, y: 10 }]); // a bend over bb2, ends on bb5
  controller.loadDocument(doc.toJSON());

  // Every render the layer is asked for, as the sets it was handed.
  const proto = WireLayer.prototype;
  const { render, setPartDrag } = proto;
  t.after(() => Object.assign(proto, { render, setPartDrag }));
  let riders = null;
  const frames = [];
  proto.setPartDrag = function (spec, ...rest) {
    riders = spec ? [...spec.shifts.keys()].sort() : null;
    return setPartDrag.call(this, spec, ...rest);
  };
  const owner = (address) => address.slice(0, address.indexOf("."));
  proto.render = function (overrides, pointRide) {
    const moving = overrides ? [...overrides.keys()].sort() : null;
    const bends = pointRide ? [...pointRide.points.keys()] : [];
    // Every wire the frame touches: an end on what moves, a bend carried, a
    // rider. The bends alone may trade a wire with the riders (a plan taking
    // it whole) — never lose it.
    const touched = new Set([...bends, ...(riders ?? [])]);
    for (const w of doc.wires) {
      if (overrides?.has(owner(w.from)) || overrides?.has(owner(w.to))) touched.add(w.id); // prettier-ignore
    }
    const rest = !moving && !pointRide && !riders;
    frames.push(rest ? null : JSON.stringify({ moving, riders, touched: [...touched].sort() })); // prettier-ignore
    return render.call(this, overrides, pointRide);
  };

  const fire = (el, type, client) =>
    el.dispatchEvent(new window.PointerEvent(type, { bubbles: true, button: 0, pointerId: 5, clientX: client, clientY: client })); // prettier-ignore
  /** Press `el` at `from`, travel through `path` (world points — legal and
      refused drops both), let go at the last. */
  const gesture = (name, el, from, path) => {
    frames.length = 0;
    riders = null;
    world.x = from.x;
    world.y = from.y;
    fire(el, "pointerdown", 0);
    path.forEach((p, i) => {
      world.x = p.x;
      world.y = p.y;
      fire(viewport, "pointermove", 10 * (i + 1));
    });
    fire(document.body, "pointerup", 10 * path.length);
    const drag = frames.filter(Boolean);
    assert.ok(drag.length >= path.length, `${name}: the layer drew the drag`);
    // Between rest renders, one set throughout.
    let run = null;
    for (const f of frames) {
      if (f === null) run = null;
      else if (run === null) run = f;
      else assert.equal(f, run, `${name}: a set changed mid-drag`);
    }
    assert.equal(frames.at(-1), null, `${name}: the drag ends in a rest render`); // prettier-ignore
  };

  const at = (id) => doc.getBoard(id);
  // The chip alone: its wires ride it.
  const chipEl = surface.querySelector(`[data-component-id="${chip.id}"]`);
  const pin = worldOfAddress(doc.boards, `${at("bb2").id}.e5`);
  gesture("part drag", chipEl, pin, [
    { x: pin.x + 4, y: pin.y },
    { x: pin.x + 4, y: pin.y + 40 },
    { x: pin.x + 9, y: pin.y }, // prettier-ignore
  ]);
  // The brick: its wire follows it.
  const psuEl = surface.querySelector(`[data-component-id="${psu.id}"]`);
  const b = doc.getComponent(psu.id);
  gesture("brick drag", psuEl, { x: b.x + 1, y: b.y + 1 }, [
    { x: b.x - 6, y: b.y + 1 },
    { x: b.x + 30, y: b.y + 10 },
    { x: b.x - 12, y: b.y + 4 }, // prettier-ignore
  ]);
  // A kit, selected (a press on an unselected strip's holes is the band):
  // its strips, the chip and its riders, the bend over it.
  for (const id of ["bb1", "bb2", "bb3"]) controller.toggleBoardSelection(id);
  const kit = surface.querySelector('[data-board-id="bb2"]');
  gesture("kit drag", kit, { x: 30, y: 8 }, [
    { x: 34, y: 8 },
    { x: 34, y: 30 },
    { x: 34, y: 48 },
    { x: 31, y: 20 }, // prettier-ignore
  ]);
  assert.ok(at("bb2"), "the kit is still on the desk");
});

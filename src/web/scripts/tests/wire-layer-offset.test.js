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

// The wire layer's kept offset (wire-layer.js #offset / #place): a drop
// leaves the svg translated and the moved wires' groups as they were drawn,
// so a group's `d` is no longer the document's — only what is DRAWN is. These
// hold the layer to drawing exactly what a fresh layer would draw from the
// same document, after any sequence of drags, drops, refusals, edits,
// selections and fades: every node in the same order, the same classes and
// colour, and every point of every path, cap, knob and fade mask at the same
// place on the desk (within the 0.001 px the routed and faded paths round to).

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";

const { WireLayer } = await import("../components/wire-layer.js");

/** The numbers of a path that are POINTS (an arc's radii, rotation and flags
    are not), as [x, y] pairs. */
function pathPoints(d) {
  const out = [];
  const tokens = d.match(/[MLQCAZ]|-?[\d.]+(?:e-?\d+)?/gi) ?? [];
  let cmd = null;
  let nums = [];
  const flush = () => {
    if (cmd === "A") {
      for (let i = 0; i + 7 <= nums.length; i += 7) out.push([nums[i + 5], nums[i + 6]]); // prettier-ignore
    } else for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]); // prettier-ignore
    nums = [];
  };
  for (const tk of tokens) {
    if (/^[A-Z]$/i.test(tk)) {
      flush();
      cmd = tk.toUpperCase();
    } else nums.push(Number(tk));
  }
  flush();
  return out;
}

const translateOf = (value, re) => {
  const m = re.exec(value ?? "");
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};

/** What the layer DRAWS: per svg child, its kind, classes and every point in
    desk px (its geometry plus its own transform plus the svg's). */
function picture(layer) {
  const svg = layer.querySelector(".wire-svg");
  const [sx, sy] = translateOf(svg.style.transform, /translate\((\S+)px, (\S+)px\)/); // prettier-ignore
  const masks = new Map(
    [...svg.querySelectorAll("mask")].map((m) => [m.id, m]),
  );
  const nodes = [];
  for (const node of svg.children) {
    if (node.tagName.toLowerCase() === "defs") continue;
    const [gx, gy] = translateOf(node.getAttribute("transform"), /translate\((\S+) (\S+)\)/); // prettier-ignore
    const ox = gx + sx;
    const oy = gy + sy;
    const pts = [];
    for (const el of node.querySelectorAll("*")) {
      const tag = el.tagName.toLowerCase();
      if (tag === "path") {
        for (const [x, y] of pathPoints(el.getAttribute("d") ?? "")) pts.push([x + ox, y + oy]); // prettier-ignore
      } else if (tag === "circle") {
        pts.push([Number(el.getAttribute("cx")) + ox, Number(el.getAttribute("cy")) + oy]); // prettier-ignore
      } else if (tag === "text") {
        pts.push([Number(el.getAttribute("x")) + ox, Number(el.getAttribute("y")) + oy]); // prettier-ignore
      }
    }
    const maskId = /url\(#(.+)\)/.exec(node.getAttribute("mask") ?? "")?.[1];
    const mask = maskId ? masks.get(maskId) : null;
    if (mask) {
      // In the group's own user space, so its transform moves it too.
      for (const c of mask.querySelectorAll("circle")) {
        pts.push([Number(c.getAttribute("cx")) + ox, Number(c.getAttribute("cy")) + oy, Number(c.getAttribute("r"))]); // prettier-ignore
      }
    }
    nodes.push({
      id: node.dataset.wireId ?? node.dataset.busId ?? null,
      cls: node.getAttribute("class"),
      color: node.style?.getPropertyValue("--wire-color") ?? "",
      kids: [...node.children].map((k) => k.getAttribute("class")).join(" "),
      pts,
    });
  }
  return nodes;
}

/** `overrides` (a drag frame): the oracle is the document with the strips
    and bricks where the frame draws them, drawn from scratch at rest. */
function assertSamePicture(
  layer,
  doc,
  selected,
  faded,
  where,
  overrides = null,
) {
  const fresh = document.createElement("div");
  document.body.append(fresh);
  const json = doc.toJSON();
  for (const item of [...json.boards, ...json.components]) {
    const at = overrides?.get(item.id);
    if (at) Object.assign(item, at);
  }
  const twin = new WireLayer(fresh, new DeskDoc(json), {});
  twin.setFaded(faded);
  twin.setSelectedMany(selected);
  // The oracle draws from scratch: no offset, no group translated.
  assert.equal(fresh.querySelector(".wire-svg").style.transform, "", where);
  assert.equal(fresh.querySelectorAll(".wire-svg > [transform]").length, 0, where); // prettier-ignore
  const want = picture(fresh);
  const got = picture(layer);
  fresh.remove();
  assert.equal(got.length, want.length, `${where}: node count`);
  for (let i = 0; i < want.length; i += 1) {
    const [g, w] = [got[i], want[i]];
    const at = `${where}: node ${i} (${w.id})`;
    assert.equal(g.id, w.id, at);
    assert.equal(g.cls, w.cls, at);
    assert.equal(g.color, w.color, at);
    assert.equal(g.kids, w.kids, at);
    assert.equal(g.pts.length, w.pts.length, `${at}: points`);
    g.pts.forEach((p, k) => {
      for (let c = 0; c < p.length; c += 1) {
        assert.ok(Math.abs(p[c] - w.pts[k][c]) < 2e-3, `${at}: point ${k} ${p} vs ${w.pts[k]}`); // prettier-ignore
      }
    });
  }
}

/** A small deterministic generator (the tests must replay). */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function busyDesk() {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // bb1
  doc.addBoard("pins-full", 0, 30); // bb2
  doc.addBoard("pins-half", 80, 0); // bb3
  doc.addBoard("pins-tiny", 80, 30); // bb4
  const psu = doc.addPsu(-20, 10);
  for (let c = 1; c <= 20; c += 1) {
    doc.addWire({ from: `bb1.a${c}`, to: `bb1.j${c + 3}`, color: "red" });
    doc.addWire({ from: `bb2.b${c}`, to: `bb2.h${c + 1}`, color: "blue" });
  }
  for (let c = 1; c <= 8; c += 1) {
    doc.addWire({ from: `bb1.c${c + 30}`, to: `bb3.c${c}`, color: "green" });
    doc.addWire({ from: `bb2.d${c + 30}`, to: `bb4.d${c}`, color: "yellow" });
  }
  doc.addWire({ from: `${psu.id}.+`, to: "bb1.f40", color: "red" });
  doc.addWire({ from: `${psu.id}.-`, to: "bb2.f40", color: "black" });
  const routed = doc.addWire({
    from: "bb1.g50",
    to: "bb2.g50",
    color: "orange",
  });
  doc.setWireLayout(routed.id, "routed");
  doc.setWireRoute(routed.id, [
    { x: 55, y: 20 },
    { x: 60, y: 22 },
  ]);
  const local = doc.addWire({ from: "bb3.a20", to: "bb3.j25", color: "white" });
  doc.setWireLayout(local.id, "routed");
  doc.setWireRoute(local.id, [{ x: 100, y: 5 }]);
  const members = [];
  for (let c = 1; c <= 4; c += 1) {
    members.push(
      doc.addWire({ from: `bb1.e${c + 55}`, to: `bb3.e${c + 20}` }).id,
    );
  }
  doc.addBus("D[3:0]", members);
  return doc;
}

test("after any drags and drops, the layer draws what a fresh one draws", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = busyDesk();
  const wires = new WireLayer(layer, doc, {});
  const boardIds = doc.boards.map((b) => b.id);
  const brickIds = doc.components.filter((c) => c.board == null).map((c) => c.id); // prettier-ignore
  let selected = [];
  let faded = false;
  let drops = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const rand = rng(seed);
    for (let step = 0; step < 14; step += 1) {
      // A drag: some strips (often all of them) and maybe the brick, by one
      // delta, over a few frames — the moving set frozen, as a gesture's is.
      const all = rand() < 0.5;
      const moving = all ? boardIds : boardIds.filter(() => rand() < 0.5);
      const bricks = rand() < 0.3 ? brickIds : [];
      const frames = 1 + Math.floor(rand() * 3);
      let dx = 0;
      let dy = 0;
      for (let f = 0; f < frames; f += 1) {
        dx = Math.round((rand() - 0.5) * 20);
        dy = Math.round((rand() - 0.5) * 2000) / 100;
        const overrides = new Map();
        for (const id of moving) {
          const b = doc.getBoard(id);
          overrides.set(id, { x: b.x + dx, y: b.y + dy });
        }
        for (const id of bricks) {
          const c = doc.getComponent(id);
          overrides.set(id, { x: c.x + dx, y: c.y + dy });
        }
        wires.setPartDrag(null, overrides.size ? overrides : null);
        if (overrides.size && doc.canMoveBoardsBy(moving, dx, dy)) {
          // Mid-drag, too, what is drawn is what a fresh layer draws for it.
          assertSamePicture(layer, doc, selected, faded, `seed ${seed} step ${step} frame ${f}`, overrides); // prettier-ignore
        }
      }
      // …dropped (the document moves) or refused (it doesn't).
      if (
        rand() < 0.7 &&
        moving.length &&
        doc.canMoveBoardsBy(moving, dx, dy)
      ) {
        doc.moveBoardsBy(moving, dx, dy);
        drops += 1;
        for (const id of bricks) {
          const c = doc.getComponent(id);
          try {
            doc.moveBrick(id, c.x + dx, c.y + dy);
          } catch {
            // landing on a strip: it stays (a refused brick drop)
          }
        }
      }
      // Now and then an edit, a selection, the fade toggle.
      const r = rand();
      if (r < 0.15) {
        const w = doc.wires[Math.floor(rand() * doc.wires.length)];
        doc.recolorWire(w.id, rand() < 0.5 ? "purple" : "green");
      } else if (r < 0.3) {
        selected = rand() < 0.5 ? [] : [doc.wires[Math.floor(rand() * doc.wires.length)].id]; // prettier-ignore
        wires.setSelectedMany(selected);
      } else if (r < 0.38) {
        faded = !faded;
        wires.setFaded(faded);
      } else if (r < 0.5) {
        // A wire's layout or its bends change: a new shape, never a slide.
        const w = doc.wires[Math.floor(rand() * 60)];
        if (w.layout === "routed") doc.setWireLayout(w.id, "direct");
        else {
          doc.setWireLayout(w.id, "routed");
          const [x, y] = [Math.round(rand() * 100), Math.round(rand() * 50)];
          doc.setWireRoute(w.id, [{ x, y }]);
        }
      }
      wires.render();
      assertSamePicture(layer, doc, selected, faded, `seed ${seed} step ${step}`); // prettier-ignore
    }
  }
  assert.ok(drops >= 20, `${drops} drops committed`);
});

test("a whole-desk drop keeps the moved wires' groups untouched and the svg where the drag left it", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = busyDesk();
  const wires = new WireLayer(layer, doc, {});
  const svg = layer.querySelector(".wire-svg");
  const ids = doc.boards.map((b) => b.id);
  const overrides = new Map(
    doc.boards.map((b) => [b.id, { x: b.x + 4, y: b.y + 3.5 }]),
  );
  wires.setPartDrag(null, overrides);
  let writes = 0;
  const mo = new window.MutationObserver((ms) => (writes += ms.length));
  mo.observe(svg, { subtree: true, attributes: true, attributeFilter: ["d", "cx", "cy", "transform"] }); // prettier-ignore
  doc.moveBoardsBy(ids, 4, 3.5);
  wires.render();
  writes += mo.takeRecords().length;
  mo.disconnect();
  // Only the two wires to the brick (stretched, held against the svg's
  // offset) and the bus (redrawn with its ribbon) are touched.
  assert.ok(writes < 40, `${writes} geometry writes`);
  assert.notEqual(svg.style.transform, "", "the svg keeps the drag's offset");
  assert.equal(svg.style.willChange, "", "but is no layer of its own at rest");
  assertSamePicture(layer, doc, [], false, "after the drop");
});

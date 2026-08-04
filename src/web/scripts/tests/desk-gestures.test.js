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

// CHARACTERIZATION tests for the pointer-drag gestures (board drag, part drag,
// brick drag). These pin the CURRENT observable behaviour of the gesture state
// machines so the planned split of desk-controller.js into collaborator objects
// can be proven behaviour-preserving — they assert what the code does today,
// not what it ideally should. Everything is driven through real PointerEvents
// on the mounted board/part elements, exactly as the browser drives it.
//
// The DeskView stub reads a live `world` object for worldFromEvent(), so a test
// sets `world` to move the "cursor" in world space; the event's clientX/clientY
// is separate and only feeds the ~4px click-vs-drag threshold.

import test from "node:test";
import assert from "node:assert/strict";

import { spec } from "../model/breadboard.js";
import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";

const { DeskController } = await import("../components/desk-controller.js");

function makeDesk(deskDoc, world = { x: 0, y: 0 }) {
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const deskView = {
    surface,
    camera: { cx: 0, cy: 0, zoom: 1 },
    worldFromEvent: () => ({ x: world.x, y: world.y }),
  };
  const controller = new DeskController({ viewport, deskView, deskDoc });
  return { viewport, surface, controller, world };
}

const boardEl = (surface, id) =>
  surface.querySelector(`[data-board-id="${id}"]`);
const partEl = (surface, id) =>
  surface.querySelector(`[data-component-id="${id}"]`);

/** Dispatch one pointer event of `type` on `el`, at client point + modifiers. */
function fire(el, type, { id = 3, client = [0, 0], mods = {} } = {}) {
  el.dispatchEvent(
    new window.PointerEvent(type, {
      bubbles: true,
      button: 0,
      pointerId: id,
      clientX: client[0],
      clientY: client[1],
      ...mods,
    }),
  );
}

/**
 * A full press → travel → release gesture on `el`. The cursor starts in world
 * `from` and ends in world `to`; `clientTravel` is how far the pointer moves in
 * client px (0 stays under the 4px threshold → a click, not a drag).
 */
function drag(
  el,
  world,
  from,
  to,
  { id = 3, mods = {}, clientTravel = 40 } = {},
) {
  world.x = from.x;
  world.y = from.y;
  fire(el, "pointerdown", { id, client: [0, 0], mods });
  world.x = to.x;
  world.y = to.y;
  const client = [clientTravel, clientTravel];
  fire(el, "pointermove", { id, client, mods });
  fire(el, "pointerup", { id, client, mods });
}

// ── Board drag ──────────────────────────────────────────────────────────────

// Grid rows moved when the vertical geometry became MEASURED (board-types.js):
// a pin-board's plastic is 35.6 mm, so its rows sit 1.51 pitch below the top
// edge rather than 1, and row a is at 12.51. Fixtures name the row instead of
// its old integer y, so a re-measurement moves them all at once.
const ROW = spec("pins-full").rowY;

test("board drag: the whole snapped group moves together and commits once", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const strips = controller.addKitAt("full", 0, 0); // bb1·bb2·bb3
  const startYs = Object.fromEntries(strips.map((s) => [s.id, s.y]));

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  // Grab the centre pin-board; travel +10 x, +40 y (clear of everything).
  drag(boardEl(surface, "bb2"), world, { x: 5, y: ROW.e }, { x: 15, y: ROW.e + 40 }); // prettier-ignore

  for (const id of ["bb1", "bb2", "bb3"]) {
    assert.equal(doc.getBoard(id).x, 10, `${id} x`);
    // Rounded: a strip's y is fractional and the document stores it on the
    // 0.01 grid, so the expectation has to land on that grid too.
    const want = Math.round((startYs[id] + 40) * 100) / 100;
    assert.equal(doc.getBoard(id).y, want, `${id} y`);
  }
  assert.equal(changes, 1, "one batched doc-changed for the whole set");
});

test("board drag: a press that never crosses the threshold is a click, not a move", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-tiny", 0, 0);

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  // Move the world a long way, but keep the client pointer still (travel 0).
  drag(
    boardEl(surface, "bb1"),
    world,
    { x: 5, y: ROW.f },
    { x: 40, y: 40 },
    {
      clientTravel: 0,
    },
  );

  assert.deepEqual([doc.getBoard("bb1").x, doc.getBoard("bb1").y], [0, 0]);
  assert.equal(changes, 0, "a click commits nothing");
  assert.equal(controller.selectedId, "bb1", "but it does select");
});

test("board drag: an illegal drop (onto another board) reverts, doc untouched", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-tiny", 0, 0); // bb1
  controller.addBoardAt("pins-tiny", 40, 0); // bb2, clear to the right

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  // Drag bb1 right so it would land squarely on top of bb2.
  drag(boardEl(surface, "bb1"), world, { x: 2, y: ROW.i }, { x: 42, y: ROW.i });

  assert.deepEqual([doc.getBoard("bb1").x, doc.getBoard("bb1").y], [0, 0]);
  assert.equal(changes, 0, "an illegal drop writes nothing");
});

test("board drag: Option tears the forward chain off and re-groups both halves", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addKitAt("full", 0, 0); // bb1 rail@0 · bb2 pins@3.70 · bb3 @17.72
  const g0 = doc.getBoard("bb2").group;

  // Option-grab the pin-board: the forward chain (down/right) is bb2 + bb3;
  // bb1 (above) stays behind. Drag them 40 down.
  drag(
    boardEl(surface, "bb2"),
    world,
    { x: 5, y: ROW.e },
    { x: 5, y: ROW.e + 40 },
    {
      mods: { altKey: true },
    },
  );

  // bb1 left where it was and now loose; bb2+bb3 travelled as a fresh group.
  assert.equal(doc.getBoard("bb1").y, 0);
  assert.equal(doc.getBoard("bb1").group, null);
  const q = (n) => Math.round(n * 100) / 100;
  assert.equal(doc.getBoard("bb2").y, q(spec("rail-full").height + 40));
  assert.equal(
    doc.getBoard("bb3").y,
    q(spec("rail-full").height + spec("pins-full").height + 40),
  );
  const g = doc.getBoard("bb2").group;
  assert.ok(g != null && g !== g0, "torn-off pair minted a fresh group id");
  assert.equal(doc.getBoard("bb3").group, g);
});

test("board drag: a routed bend over the board rides it, live and on the drop", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addKitAt("full", 0, 0); // bb1 rail@0 · bb2 pins y3..16 · bb3 rail@16
  const wire = doc.addWire({
    from: "bb2.a1",
    to: "bb2.a5",
    layout: "routed",
    points: [
      { x: 20, y: ROW.e }, // drawn over the pin-board
      { x: 100, y: ROW.e }, // out on the bare desk, past the kit's right edge
    ],
  });
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));
  const el = boardEl(surface, "bb2");

  world.x = 5;
  world.y = ROW.e;
  fire(el, "pointerdown", { client: [0, 0] });
  world.x = 5;
  world.y = ROW.e + 40;
  fire(el, "pointermove", { client: [40, 40] });

  // Mid-drag the knobs preview the ride — the one over the board has followed
  // it 40 down, the one over the bare desk has not — with the document itself
  // still untouched.
  assert.deepEqual(
    [...surface.querySelectorAll(".wire-point")].map((k) =>
      Number(k.getAttribute("cy")),
    ),
    [(ROW.e + 40) * PX_PER_UNIT, ROW.e * PX_PER_UNIT],
  );
  assert.deepEqual(doc.getWire(wire.id).points, [
    { x: 20, y: ROW.e },
    { x: 100, y: ROW.e },
  ]);

  fire(el, "pointerup", { client: [40, 40] });
  assert.deepEqual(doc.getWire(wire.id).points, [
    { x: 20, y: ROW.e + 40 }, // rode the board
    { x: 100, y: ROW.e }, // stayed on the bare desk
  ]);
});

test("board drag: an illegal drop leaves the routing exactly where it was", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-tiny", 0, 0); // bb1
  controller.addBoardAt("pins-tiny", 0, 20); // bb2, clear below it
  const wire = doc.addWire({
    from: "bb1.a1",
    to: "bb1.a5",
    layout: "routed",
    points: [{ x: 5, y: ROW.f }],
  });
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));

  // Drop bb1 straight on top of bb2 — refused, so nothing moves, bends least
  // of all.
  drag(boardEl(surface, "bb1"), world, { x: 2, y: ROW.i }, { x: 2, y: 22 });

  assert.equal(doc.getBoard("bb1").y, 0);
  assert.deepEqual(doc.getWire(wire.id).points, [{ x: 5, y: ROW.f }]);
});

test("board drag: the view tracks the pointer live, before the drop commits", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-tiny", 0, 0);
  const el = boardEl(surface, "bb1");

  world.x = 2;
  world.y = ROW.i;
  fire(el, "pointerdown", { client: [0, 0] });
  world.x = 12;
  world.y = 22;
  fire(el, "pointermove", { client: [40, 40] });

  // Mid-drag: the element has moved but the document has NOT yet.
  assert.notEqual(el.style.left, "0px", "the view followed the pointer");
  assert.equal(
    doc.getBoard("bb1").x,
    0,
    "the document is untouched until drop",
  );

  fire(el, "pointerup", { client: [40, 40] });
  assert.equal(doc.getBoard("bb1").x, 10, "drop commits the delta");
});

// ── Part drag ─────────────────────────────────────────────────────────────

test("part drag: a chip re-seats to the anchor under the pointer, once", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5"); // cols 5–11

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  // Grab at column 8 (offset −3 from the e5 anchor) so it is a true drag, not
  // the recentre-on-grab special case; release five columns right.
  drag(partEl(surface, chip.id), world, { x: 8, y: 6.5 }, { x: 13, y: 6.5 });

  assert.equal(doc.getComponent(chip.id).anchor, "e10");
  assert.equal(changes, 1);
});

test("part drag: a sub-threshold press selects the chip but does not move it", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  controller.deselect();

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  drag(
    partEl(surface, chip.id),
    world,
    { x: 8, y: 6.5 },
    { x: 13, y: 6.5 },
    {
      clientTravel: 0,
    },
  );

  assert.equal(doc.getComponent(chip.id).anchor, "e5", "no move");
  assert.equal(changes, 0);
  assert.equal(controller.selectedId, chip.id, "but selected");
});

test("part drag: an illegal drop (onto another chip) springs back to the origin", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5"); // cols 5–11
  controller.addComponentAt("74LS00", "bb1", "e12"); // cols 12–18, blocks e10

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  // Aim chip1 at e10 (cols 10–16) — overlaps the blocker at e12.
  drag(partEl(surface, chip.id), world, { x: 8, y: 6.5 }, { x: 13, y: 6.5 });

  assert.equal(doc.getComponent(chip.id).anchor, "e5", "reverted");
  assert.equal(changes, 0);
});

test("brick drag: a PSU moves to the dropped position and commits once", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const psu = controller.addBrickAt("psu", 0, 0);
  const { x: x0, y: y0 } = doc.getComponent(psu.id);

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  drag(partEl(surface, psu.id), world, { x: 1, y: ROW.j }, { x: 21, y: ROW.b });

  const moved = doc.getComponent(psu.id);
  assert.equal(moved.x, x0 + 20);
  assert.equal(moved.y, y0 + 10);
  assert.equal(changes, 1);
});

test("resistor BODY drag: Option carries its wiring, same as any other part", () => {
  // A rotatable part takes the two-free-ends gesture rather than the footprint
  // reseat, so without this it was the one part that carried its wiring as a
  // member of a selection but not when dragged on its own.
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const res = controller.addComponentAt("resistor", "bb1", "a20"); // a20 … a23
  const wire = doc.addWire({ from: "bb1.c20", to: "bb1.c50" }); // rides leg 1

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  // Grab the BODY — midway between the legs, clear of both grab radii — and
  // slide it five columns right.
  drag(
    partEl(surface, res.id),
    world,
    { x: 21.5, y: ROW.a },
    { x: 26.5, y: ROW.a },
    { mods: { altKey: true } },
  );

  assert.equal(doc.getComponent(res.id).anchor, "a25");
  assert.equal(doc.getWire(wire.id).from, "bb1.c25", "the wire came along");
  assert.equal(doc.getWire(wire.id).to, "bb1.c50", "the far end stayed put");
  assert.equal(changes, 1, "the part and its wire were never two edits");
  // The release RE-RESOLVES through the same tracker, which is what previews
  // the riders during the drag — so it must not preview here, or the committed
  // wire is left drawn as a drag that has ended.
  assert.equal(
    surface.querySelectorAll(".wire-svg g.wire--dragging").length,
    0,
    "and the drag preview was put away",
  );
});

test("resistor BODY drag: a rider with nowhere to land falls back to where it IS", () => {
  // This part is drawn at the raw cursor whatever the position — unlike a
  // footprint drag, which stops at its last good seat — so a stale plan left
  // the riders frozen at a hole the part had long since left. Dragging an LED
  // over the GAP between two boards was where it showed: the wiring simply
  // stopped following it, then caught up on the far side.
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  controller.addBoardAt("pins-full", 80, 0);
  const led = controller.addComponentAt("led", "bb1", "a10", {
    rot: 90,
    end: { dx: 0, dy: -4 }, // a10 up to e10, so it has a body to grab
    color: "red",
  });
  doc.addWire({ from: "bb1.c10", to: "bb1.c40" });

  const el = partEl(surface, led.id);
  const caps = () =>
    [...surface.querySelectorAll(".wire-svg g.wire circle")].map((c) =>
      Math.round(Number(c.getAttribute("cx"))),
    );
  const at = (x) => {
    world.x = x;
    world.y = ROW.a - 2; // the middle of the span
    fire(el, "pointermove", { client: [x, 40], mods: { altKey: true } });
    return caps();
  };

  world.x = 10;
  world.y = ROW.a - 2;
  fire(el, "pointerdown", { mods: { altKey: true } });

  assert.deepEqual(at(30), [300, 400], "on the board, the rider follows");
  // Over the gap there is no hole for the LED, so nothing can move: the rider
  // goes back to the hole it is really in (c10 → 100) rather than sticking at
  // the last one it was offered.
  assert.deepEqual(at(70), [100, 400], "in the gap, back where it is");
  const wire = surface.querySelector(".wire-svg g.wire");
  assert.ok(wire.classList.contains("wire-preview--illegal"), "…and refused");
  assert.deepEqual(at(90), [900, 400], "on the far board, following again");

  fire(el, "pointerup", { client: [90, 40], mods: { altKey: true } });
  assert.equal(doc.getComponent(led.id).board, "bb2");
  assert.equal(doc.getWire("w1").from, "bb2.c10", "and it lands there");
});

test("resistor BODY drag crosses to the next board of a SPANNED run", () => {
  // There is no vertical lattice: a spanned run puts the next pin-board 17.52
  // pitch below this one (the heights are MEASURED, not typed), so rounding the
  // travel to whole pitches lands pin 1 0.48 off the hole it aimed at — past
  // holeAt's 0.45 radius. The resistor could not be dropped on the other board
  // at all, so its wires never went either.
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addKitAt("full", 0, 0); // bb1 rail@0 · bb2 pins@3.5 · bb3 rail@17.52
  controller.addBoardAt("pins-full", 0, 21.02); // bb4 — shares bb3 with bb2
  controller.addBoardAt("rail-full", 0, 35.04); // bb5
  const res = controller.addComponentAt("resistor", "bb2", "a5", {});
  // Row a is the bottom row, so both pins face the rail strip BELOW.
  const w1 = doc.addWire({ from: "bb2.b5", to: "bb3.+5" });
  const w2 = doc.addWire({ from: "bb2.b8", to: "bb3.-8" });

  const upper = 3.5 + ROW.a; // 16.01
  const lower = 21.02 + ROW.a; // 33.53
  drag(
    partEl(surface, res.id),
    world,
    { x: 6.5, y: upper }, // the body, between the two leads
    { x: 6.5, y: lower },
    { mods: { altKey: true } },
  );

  const comp = doc.getComponent(res.id);
  assert.equal(comp.board, "bb4", "the resistor crossed");
  assert.equal(comp.anchor, "a5");
  assert.equal(doc.getWire(w1.id).from, "bb4.b5", "and its wiring came too");
  assert.equal(doc.getWire(w2.id).from, "bb4.b8");
  assert.equal(doc.getWire(w1.id).to, "bb3.+5", "the rail ends stayed put");
  assert.equal(doc.getWire(w2.id).to, "bb3.-8");
});

test("resistor END drag deliberately carries nothing — there is no column delta", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const res = controller.addComponentAt("resistor", "bb1", "a20");
  const wire = doc.addWire({ from: "bb1.c20", to: "bb1.c50" });

  // Grab leg 1 itself and take it somewhere of its own: that lead can land at
  // any hole, at any angle, on any strip, so a rider has nothing to follow.
  drag(
    partEl(surface, res.id),
    world,
    { x: 20, y: ROW.a },
    { x: 25, y: ROW.h },
    { mods: { altKey: true } },
  );

  assert.equal(doc.getComponent(res.id).anchor, "h25", "the lead moved");
  assert.equal(doc.getWire(wire.id).from, "bb1.c20", "and the wire did not");
});

// ── Cluster drag (a multi-selection moved as one) ───────────────────────────

/** ⌘/Ctrl-click each id in turn, which is what builds a multi-selection.
    Starts from nothing, since placing a part leaves it selected and a toggle
    would then take it back OUT of the set. */
function selectMany(controller, ids) {
  controller.deselect();
  for (const id of ids) controller.toggleComponentSelection(id);
}

test("cluster drag: every selected part moves, and commits ONCE", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5"); // cols 5–11
  const btn = controller.addComponentAt("sw-push", "bb1", "a30");
  selectMany(controller, [chip.id, btn.id]);

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  drag(
    partEl(surface, chip.id),
    world,
    { x: 8, y: ROW.e },
    { x: 13, y: ROW.e },
  );

  assert.equal(doc.getComponent(chip.id).anchor, "e10");
  assert.equal(doc.getComponent(btn.id).anchor, "a35", "and it came too");
  assert.equal(changes, 1, "one batched doc-changed for the whole set");
});

test("cluster drag: Option carries every member's wiring", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  const btn = controller.addComponentAt("sw-push", "bb1", "a30");
  // One wire joining the two (rides by BOTH ends) and one to a fixed far end.
  const join = doc.addWire({ from: "bb1.a5", to: "bb1.b30" });
  const out = doc.addWire({ from: "bb1.b32", to: "bb1.b50" });
  selectMany(controller, [chip.id, btn.id]);

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  drag(
    partEl(surface, chip.id),
    world,
    { x: 8, y: ROW.e },
    { x: 13, y: ROW.e },
    { mods: { altKey: true } },
  );

  assert.equal(doc.getComponent(chip.id).anchor, "e10");
  assert.equal(doc.getComponent(btn.id).anchor, "a35");
  assert.equal(doc.getWire(join.id).from, "bb1.a10");
  assert.equal(doc.getWire(join.id).to, "bb1.b35", "both ends travelled");
  assert.equal(doc.getWire(out.id).from, "bb1.b37");
  assert.equal(doc.getWire(out.id).to, "bb1.b50", "the far end stayed put");
  assert.equal(changes, 1, "parts and wiring were never two edits");
});

test("cluster drag: WITHOUT Option the wires stay exactly where they are", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  const btn = controller.addComponentAt("sw-push", "bb1", "a30");
  const join = doc.addWire({ from: "bb1.a5", to: "bb1.b30" });
  selectMany(controller, [chip.id, btn.id]);

  drag(
    partEl(surface, chip.id),
    world,
    { x: 8, y: ROW.e },
    { x: 13, y: ROW.e },
  );

  assert.equal(doc.getComponent(chip.id).anchor, "e10");
  assert.equal(doc.getWire(join.id).from, "bb1.a5");
  assert.equal(doc.getWire(join.id).to, "bb1.b30");
});

test("cluster drag: ONE member with nowhere to land reverts the WHOLE drop", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  const btn = controller.addComponentAt("sw-push", "bb1", "a30");
  controller.addComponentAt("sw-push", "bb1", "a35"); // squarely in the way
  selectMany(controller, [chip.id, btn.id]);

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  drag(
    partEl(surface, chip.id),
    world,
    { x: 8, y: ROW.e },
    { x: 13, y: ROW.e },
  );

  assert.equal(doc.getComponent(chip.id).anchor, "e5", "the chip could have");
  assert.equal(
    doc.getComponent(btn.id).anchor,
    "a30",
    "but the button could not",
  );
  assert.equal(changes, 0);
});

test("cluster drag: a BRICK travels, and its terminal wires with it", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  const psu = controller.addBrickAt("psu", 80, 0);
  const lead = doc.addWire({ from: "bb1.a5", to: `${psu.id}.+` });
  const { x: x0, y: y0 } = doc.getComponent(psu.id);
  selectMany(controller, [chip.id, psu.id]);

  drag(
    partEl(surface, chip.id),
    world,
    { x: 8, y: ROW.e },
    { x: 11, y: ROW.e },
    { mods: { altKey: true } },
  );

  assert.equal(doc.getComponent(chip.id).anchor, "e8");
  assert.equal(doc.getComponent(psu.id).x, x0 + 3, "the brick rode the delta");
  assert.equal(doc.getComponent(psu.id).y, y0);
  assert.equal(doc.getWire(lead.id).from, "bb1.a8");
  assert.equal(
    doc.getWire(lead.id).to,
    `${psu.id}.+`,
    "a terminal address rides its brick — there is nothing to re-address",
  );
});

test("cluster drag: a BOARD in the selection refuses the press outright", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  const btn = controller.addComponentAt("sw-push", "bb1", "a30");
  selectMany(controller, [chip.id, btn.id]);
  controller.toggleBoardSelection("bb1");

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  drag(
    partEl(surface, chip.id),
    world,
    { x: 8, y: ROW.e },
    { x: 13, y: ROW.e },
  );

  assert.equal(doc.getComponent(chip.id).anchor, "e5", "nothing moved");
  assert.equal(doc.getComponent(btn.id).anchor, "a30");
  assert.equal(changes, 0);
  // …and the selection it declined to drag is still there to act on.
  assert.deepEqual(
    controller.multiSelectedIds.sort(),
    [chip.id, btn.id].sort(),
  );
  assert.deepEqual(controller.multiSelectedBoardIds, ["bb1"]);
});

test("cluster drag: Option bends a resistor plugged into a member", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  const led = controller.addComponentAt("led", "bb1", "a20");
  // A resistor standing in the LED's second column-half, reaching up to row g.
  const res = controller.addComponentAt("resistor", "bb1", "b21", {
    rot: 90,
    end: { dx: 0, dy: -8 },
    ohms: 220,
  });
  selectMany(controller, [chip.id, led.id]);

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  drag(
    partEl(surface, chip.id),
    world,
    { x: 8, y: ROW.e },
    { x: 11, y: ROW.e },
    { mods: { altKey: true } },
  );

  assert.equal(doc.getComponent(chip.id).anchor, "e8");
  assert.equal(doc.getComponent(led.id).anchor, "a23");
  assert.equal(doc.getComponent(res.id).anchor, "b24", "the leg followed");
  // The far leg never moved, so the body just leans three columns further.
  assert.deepEqual(doc.getComponent(res.id).params.end, { dx: -3, dy: -8 });
  assert.equal(changes, 1, "parts and the leg were never two edits");
});

test("cluster drag: the bottom half to the top half, wiring and all", () => {
  // The two halves of a column are separate nodes, so a rider that only kept
  // its row was stranded the moment its pin crossed and the drop reddened over
  // a top half with plenty of room in it.
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const one = controller.addComponentAt("sw-push", "bb1", "a10");
  const two = controller.addComponentAt("sw-push", "bb1", "a20");
  const wire = doc.addWire({ from: "bb1.c10", to: "bb1.c40" });
  selectMany(controller, [one.id, two.id]);

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  drag(
    partEl(surface, one.id),
    world,
    { x: 12, y: ROW.a },
    { x: 12, y: ROW.g },
    { mods: { altKey: true } },
  );

  assert.equal(doc.getComponent(one.id).anchor, "g10");
  assert.equal(doc.getComponent(two.id).anchor, "g20");
  // The wire was two holes from the part's row and still is: a to g is six
  // rows, and c travels the same six to i.
  assert.equal(doc.getWire(wire.id).from, "bb1.i10", "the wire crossed too");
  assert.equal(doc.getWire(wire.id).to, "bb1.c40", "the far end did not");
  assert.equal(changes, 1);
});

test("cluster drag: ACROSS BOARDS, wiring and all", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  controller.addBoardAt("pins-full", 80, 0);
  const one = controller.addComponentAt("sw-push", "bb1", "a10");
  const two = controller.addComponentAt("sw-push", "bb1", "a20");
  const near = doc.addWire({ from: "bb1.c10", to: "bb1.c40" }); // rides one end
  selectMany(controller, [one.id, two.id]);

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  drag(
    partEl(surface, one.id),
    world,
    { x: 11, y: ROW.a },
    { x: 91, y: ROW.a },
    { mods: { altKey: true } },
  );

  assert.equal(doc.getComponent(one.id).board, "bb2");
  assert.equal(doc.getComponent(one.id).anchor, "a10");
  assert.equal(doc.getComponent(two.id).board, "bb2");
  assert.equal(doc.getComponent(two.id).anchor, "a20");
  assert.equal(doc.getWire(near.id).from, "bb2.c10", "the rider re-addressed");
  assert.equal(doc.getWire(near.id).to, "bb1.c40", "the far end stayed behind");
  assert.equal(changes, 1);
});

test("cluster drag: grabbing the BRICK still crosses between MATED kits", () => {
  // A brick has no holes of its own, so its drag rounds to whole desk units —
  // but two mated kits are 21.02 apart, which no whole number reaches. The
  // delta has to come off the board's lattice, through a seated member.
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addKitAt("full", 0, 0); // bb1 rail · bb2 pins · bb3 rail
  const kit = spec("rail-full").height * 2 + spec("pins-full").height;
  controller.addKitAt("full", 0, kit); // bb4 · bb5 · bb6
  const gap = doc.getBoard("bb5").y - doc.getBoard("bb2").y;
  const part = controller.addComponentAt("sw-push", "bb5", "a10");
  const wire = doc.addWire({ from: "bb5.c10", to: "bb5.c40" });
  const psu = controller.addBrickAt("psu", 80, 30);
  selectMany(controller, [part.id, psu.id]);

  drag(
    partEl(surface, psu.id),
    world,
    { x: 81, y: 31 },
    { x: 81, y: 31 - gap },
    { mods: { altKey: true } },
  );

  assert.equal(doc.getComponent(part.id).board, "bb2", "up one kit");
  assert.equal(doc.getComponent(part.id).anchor, "a10");
  assert.equal(doc.getWire(wire.id).from, "bb2.c10", "and its wire with it");
  assert.equal(doc.getComponent(psu.id).y, Math.round(30 - gap), "brick too");
});

test("cluster drag: an illegal target reddens EVERY member, and its wires", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  const btn = controller.addComponentAt("sw-push", "bb1", "a30");
  controller.addComponentAt("sw-push", "bb1", "a35"); // in the button's way
  doc.addWire({ from: "bb1.a5", to: "bb1.b30" });
  selectMany(controller, [chip.id, btn.id]);

  // Press and travel, but do NOT release: this is the live preview.
  const el = partEl(surface, chip.id);
  world.x = 8;
  world.y = ROW.e;
  fire(el, "pointerdown", { mods: { altKey: true } });
  world.x = 13;
  fire(el, "pointermove", { client: [40, 40], mods: { altKey: true } });

  for (const id of [chip.id, btn.id]) {
    const view = partEl(surface, id);
    assert.ok(view.classList.contains("part--dragging"), `${id} is in flight`);
    assert.ok(view.classList.contains("part--illegal"), `${id} is refused`);
  }
  const wire = surface.querySelector(".wire-svg g.wire");
  assert.ok(wire.classList.contains("wire--dragging"), "the rider previews");
  assert.ok(wire.classList.contains("wire-preview--illegal"), "…in red");

  // And the release puts every one of them back.
  fire(el, "pointerup", { client: [40, 40] });
  for (const id of [chip.id, btn.id]) {
    assert.ok(!partEl(surface, id).classList.contains("part--illegal"));
    assert.ok(!partEl(surface, id).classList.contains("part--dragging"));
  }
});

test("cluster drag: a sub-threshold click COLLAPSES to the part pressed", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  const btn = controller.addComponentAt("sw-push", "bb1", "a30");
  selectMany(controller, [chip.id, btn.id]);

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  drag(
    partEl(surface, chip.id),
    world,
    { x: 8, y: ROW.e },
    { x: 13, y: ROW.e },
    { clientTravel: 0 },
  );

  assert.equal(doc.getComponent(chip.id).anchor, "e5", "no move");
  assert.equal(changes, 0);
  assert.equal(controller.selectedId, chip.id);
  assert.deepEqual(controller.multiSelectedIds, [], "the group is let go");
});

// ── Wire drag ───────────────────────────────────────────────────────────────

const wireSvg = (surface) => surface.querySelector(".wire-svg");

/** Add a wire straight into the doc and let WireLayer render it. */
function seedWire(doc, from, to) {
  const wire = doc.addWire({ from, to });
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));
  return wire;
}

test("wire-endpoint drag: re-ends a grabbed cap onto a new free hole", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const wire = seedWire(doc, "bb1.a1", "bb1.a20"); // (1,12) … (20,12)

  // Grab the 'from' cap: viewport pointerdown at world (1,12).
  world.x = 1;
  world.y = ROW.a;
  fire(viewport, "pointerdown", { id: 9, client: [0, 0] });
  // Drag it to the free hole b1 (1,11); move/up ride the persistent wire SVG.
  world.x = 1;
  world.y = ROW.b;
  fire(wireSvg(surface), "pointermove", { id: 9, client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { id: 9, client: [40, 40] });

  assert.equal(doc.getWire(wire.id).from, "bb1.b1");
  assert.equal(
    doc.getWire(wire.id).to,
    "bb1.a20",
    "the other end is untouched",
  );
});

test("wire-endpoint drag: a near-miss onto an occupied hole snaps to the nearest free one", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const wire = seedWire(doc, "bb1.a1", "bb1.a20");
  // Drag 'to' (20,12) onto a1 (1,12) — the wire's own other end, so the
  // exact spot is illegal. The nearest free hole to a1 (SNAP_RADIUS
  // recovery, wire-tools.js) is b1, one pitch unit up.
  world.x = 20;
  world.y = ROW.a;
  fire(viewport, "pointerdown", { id: 9, client: [0, 0] });
  world.x = 1;
  world.y = ROW.a;
  fire(wireSvg(surface), "pointermove", { id: 9, client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { id: 9, client: [40, 40] });

  assert.equal(
    doc.getWire(wire.id).to,
    "bb1.b1",
    "snapped to the nearest free hole",
  );
});

test("wire-endpoint drag: a release well beyond SNAP_RADIUS still finds the nearest hole", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const wire = seedWire(doc, "bb1.a1", "bb1.a20");
  // Release well off the board's right edge (col 63 is its last column) —
  // 37 pitch units past SNAP_RADIUS (2), the bound the LIVE per-move
  // preview searches, but well within the one-time unbounded search
  // #onEndpointUp falls back to when the release point itself isn't legal.
  // A single move+up (no intermediate moves) exercises exactly that
  // fallback, not just the cheap live-preview path.
  world.x = 20;
  world.y = ROW.a;
  fire(viewport, "pointerdown", { id: 9, client: [0, 0] });
  world.x = 100;
  world.y = ROW.a;
  fire(wireSvg(surface), "pointermove", { id: 9, client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { id: 9, client: [40, 40] });

  assert.equal(
    doc.getWire(wire.id).to,
    "bb1.a63",
    "found the nearest hole far beyond the live-preview's own search bound",
  );
});

test("wire-endpoint drag: a target with nothing legal anywhere nearby reverts", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const wire = seedWire(doc, "bb1.a1", "bb1.a20");
  // Drag 'to' off the board entirely — a target well beyond even the
  // endpoint drag's unbounded search's DEFAULT_SEARCH_RADIUS from every
  // hole on the board, so there's genuinely nothing to recover onto.
  world.x = 20;
  world.y = ROW.a;
  fire(viewport, "pointerdown", { id: 9, client: [0, 0] });
  world.x = 1000;
  world.y = 1000;
  fire(wireSvg(surface), "pointermove", { id: 9, client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { id: 9, client: [40, 40] });

  assert.equal(doc.getWire(wire.id).to, "bb1.a20", "reverted");
});

test("whole-wire drag: both ends translate rigidly onto new holes", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const wire = seedWire(doc, "bb1.a1", "bb1.a5"); // (1,12) … (5,12)
  const body = surface.querySelector(`.wire[data-wire-id="${wire.id}"]`);

  // Grab the body at its midpoint (3,12) — clear of both caps — and shift it
  // three rows up: a(y12) → d(y9), so a1→d1 and a5→d5.
  world.x = 3;
  world.y = ROW.a;
  fire(body, "pointerdown", { id: 9, client: [0, 0] });
  world.x = 3;
  world.y = ROW.d;
  fire(wireSvg(surface), "pointermove", { id: 9, client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { id: 9, client: [40, 40] });

  assert.deepEqual(
    { from: doc.getWire(wire.id).from, to: doc.getWire(wire.id).to },
    { from: "bb1.d1", to: "bb1.d5" },
  );
});

// ── Routed wires: the body drag BENDS instead of translating ────────────────

/** A routed wire, rendered — its body drag lays waypoints rather than moving
    the whole run (see wire-tools.js). */
function seedRoutedWire(doc, from, to) {
  const wire = doc.addWire({ from, to });
  doc.setWireLayout(wire.id, "routed");
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));
  return wire;
}

test("routed wire: dragging the body inserts a waypoint where it was grabbed", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const wire = seedRoutedWire(doc, "bb1.a1", "bb1.a5"); // (1,12) … (5,12)
  const body = surface.querySelector(`.wire[data-wire-id="${wire.id}"]`);

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  // Grab the middle of the run and pull it clear of the board.
  world.x = 3;
  world.y = ROW.a;
  fire(body, "pointerdown", { id: 9, client: [0, 0] });
  world.x = 3;
  world.y = 22;
  fire(wireSvg(surface), "pointermove", { id: 9, client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { id: 9, client: [40, 40] });

  const bent = doc.getWire(wire.id);
  assert.deepEqual(bent.points, [{ x: 3, y: 22 }]);
  assert.deepEqual(
    { from: bent.from, to: bent.to },
    { from: "bb1.a1", to: "bb1.a5" },
    "the ends stay exactly where they were — a bend is not a move",
  );
  assert.equal(changes, 1, "one commit for the gesture");
  assert.equal(controller.selectedId, wire.id);
});

test("routed wire: a sub-threshold press selects it and lays no bend", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const wire = seedRoutedWire(doc, "bb1.a1", "bb1.a5");
  const body = surface.querySelector(`.wire[data-wire-id="${wire.id}"]`);

  drag(body, world, { x: 3, y: ROW.a }, { x: 3, y: 22 }, { id: 9, clientTravel: 0 }); // prettier-ignore
  assert.equal(doc.getWire(wire.id).points, undefined);
  assert.equal(controller.selectedId, wire.id);
});

test("routed wire: an existing waypoint moves, and merges away onto a neighbour", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const wire = seedRoutedWire(doc, "bb1.a1", "bb1.a20"); // (1,12) … (20,12)
  doc.addWirePoint(wire.id, 0, { x: 10, y: 22 });
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));

  // Grab the knob (a waypoint is found by geometry, so the press can land on
  // the bare viewport) and drop it further out.
  world.x = 10;
  world.y = 22;
  fire(viewport, "pointerdown", { id: 9, client: [0, 0] });
  world.x = 14;
  world.y = 30;
  fire(wireSvg(surface), "pointermove", { id: 9, client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { id: 9, client: [40, 40] });
  assert.deepEqual(doc.getWire(wire.id).points, [{ x: 14, y: 30 }]);

  // Now drop it onto the wire's own 'from' end: merged away, bend undone.
  world.x = 14;
  world.y = 30;
  fire(viewport, "pointerdown", { id: 9, client: [0, 0] });
  world.x = 1.2;
  world.y = ROW.a;
  fire(wireSvg(surface), "pointermove", { id: 9, client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { id: 9, client: [40, 40] });
  assert.equal(doc.getWire(wire.id).points, undefined, "the bend is gone");
  assert.equal(doc.getWire(wire.id).layout, "routed", "the layout is not");
});

test("routed wire: an END dropped on a waypoint absorbs it", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const wire = seedRoutedWire(doc, "bb1.a1", "bb1.a20"); // (1,12) … (20,12)
  doc.addWirePoint(wire.id, 0, { x: 1, y: ROW.b }); // right over hole b1
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));

  // Drag the 'from' cap onto that waypoint: the wire now REACHES where the
  // bend was, so the bend has nothing left to do.
  world.x = 1;
  world.y = ROW.a;
  fire(viewport, "pointerdown", { id: 9, client: [0, 0] });
  world.x = 1;
  world.y = ROW.b;
  fire(wireSvg(surface), "pointermove", { id: 9, client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { id: 9, client: [40, 40] });

  const moved = doc.getWire(wire.id);
  assert.equal(moved.from, "bb1.b1");
  assert.equal(moved.points, undefined);
});

test("wire-endpoint grab beats the board: a press on a cap that sits on a hole drags the wire end", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const wire = seedWire(doc, "bb1.a1", "bb1.a20"); // (1,12) … (20,12)
  const boardY0 = doc.getBoard("bb1").y;

  // The 'from' cap sits ON hole a1, so a press there lands on the BOARD SVG,
  // not the wire — the exact case the fix guards. Grab it via the board element.
  world.x = 1;
  world.y = ROW.a;
  fire(boardEl(surface, "bb1"), "pointerdown", { id: 9, client: [0, 0] });
  // The endpoint drag rides the persistent wire SVG; re-end onto b1 (1,11).
  world.x = 1;
  world.y = ROW.b;
  fire(wireSvg(surface), "pointermove", { id: 9, client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { id: 9, client: [40, 40] });

  assert.equal(controller.selectedId, wire.id, "the wire is selected");
  assert.equal(
    doc.getWire(wire.id).from,
    "bb1.b1",
    "the grabbed end re-routed",
  );
  assert.equal(doc.getBoard("bb1").y, boardY0, "the board did not move");
});

// ── Placement (arm → click to commit) ───────────────────────────────────────

/** Arm a tool, then click at world `at` to commit — a placement gesture. */
function placeClick(viewport, world, at) {
  world.x = at.x;
  world.y = at.y;
  // pointerdown records the click origin (so the click isn't taken for a pan),
  // then the click commits at the armed ghost's seat.
  fire(viewport, "pointerdown", { id: 11, client: [5, 5] });
  viewport.dispatchEvent(
    new window.MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }),
  );
}

test("placement: arming a kit and clicking drops it at the cursor", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);

  controller.armPlacement("full");
  assert.ok(controller.placementArmed);
  placeClick(viewport, world, { x: 20, y: 20 });

  assert.equal(doc.boards.length, 3, "the full kit's three strips landed");
  assert.ok(
    !controller.placementArmed,
    "and placement disarmed after the drop",
  );
});

test("placement: arming a part and clicking seats it on the board", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);

  controller.armChipPlacement("74LS00");
  // Click over the trench around column 8 (trench centre y 6.5).
  placeClick(viewport, world, { x: 8, y: 6.5 });

  assert.equal(doc.components.length, 1);
  assert.equal(doc.components[0].ref, "74LS00");
  assert.equal(doc.components[0].kind, "chip");
});

// ── Wire tool (click-click) ─────────────────────────────────────────────────

test("wire tool: the colour STAYS put across a chain of wires", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);

  controller.armWireTool();
  const color = controller.wireColor;
  // Two wires, anchor-then-commit each; the tool stays armed for chaining.
  placeClick(viewport, world, { x: 1, y: ROW.a }); // anchor bb1.a1
  placeClick(viewport, world, { x: 5, y: ROW.a }); // commit  bb1.a1 → a5
  placeClick(viewport, world, { x: 1, y: ROW.b }); // anchor bb1.b1
  placeClick(viewport, world, { x: 5, y: ROW.b }); // commit  bb1.b1 → b5

  const wires = doc.wires;
  assert.equal(wires.length, 2);
  assert.equal(wires[0].color, color);
  assert.equal(
    wires[1].color,
    color,
    "the second wire kept the first's colour",
  );
  assert.equal(
    controller.wireColor,
    color,
    "and the toolbar colour is unchanged",
  );
  assert.equal(wires[0].layout, undefined, "direct unless the setting says so");
});

test("wire tool: a NEW wire takes the app-default layout, nothing else does", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const before = doc.addWire({ from: "bb1.j1", to: "bb1.j5" });

  controller.setDefaultWireLayout("routed");
  controller.armWireTool();
  placeClick(viewport, world, { x: 1, y: ROW.a }); // anchor bb1.a1
  placeClick(viewport, world, { x: 5, y: ROW.a }); // commit  bb1.a1 → a5

  assert.equal(doc.getWire("w2").layout, "routed");
  assert.equal(
    doc.getWire(before.id).layout,
    undefined,
    "a wire already on the desk keeps the layout it has",
  );

  // Junk (or an older settings file with no such key) falls back to direct.
  controller.setDefaultWireLayout(undefined);
  placeClick(viewport, world, { x: 1, y: ROW.b });
  placeClick(viewport, world, { x: 5, y: ROW.b });
  assert.equal(doc.getWire("w3").layout, undefined);
});

// ── Annotations (Feature 120) ─────────────────────────────────────────────────

test("annotation placement: arming a label and clicking drops it at the cursor", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);

  controller.armAnnotationPlacement("label");
  assert.ok(controller.placementArmed);
  placeClick(viewport, world, { x: 4, y: ROW.f });

  assert.equal(doc.annotations.length, 1);
  const [ann] = doc.annotations;
  assert.equal(ann.kind, "label");
  assert.deepEqual({ x: ann.x, y: ann.y }, { x: 4, y: ROW.f });
  assert.equal(ann.anchor, undefined); // dropped over empty desk
  assert.ok(!controller.placementArmed);
});

test("annotation placement over a part anchors it to that part", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5"); // cols 5–11

  controller.armAnnotationPlacement("note");
  placeClick(viewport, world, { x: 8, y: ROW.e }); // over the chip body
  const [ann] = doc.annotations;
  assert.equal(ann.anchor, chip.id);
});

test("selecting an annotation and pressing Delete removes it", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { controller } = makeDesk(doc);
  const ann = doc.addAnnotation("label", 2, 2, "x");
  window.dispatchEvent(new CustomEvent("chiphippo:doc-changed")); // mount it
  controller.selectAnnotation(ann.id);

  const consumed = controller.handleKeyDown({ key: "Delete", target: {} });
  assert.equal(consumed, true);
  assert.equal(doc.annotations.length, 0);
});

test("an anchored label rides a committed chip drag", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5"); // cols 5–11
  const label = doc.addAnnotation("label", 3, 6, "U1", { anchor: chip.id });
  window.dispatchEvent(new CustomEvent("chiphippo:doc-changed")); // mount label

  // Same drag as the chip-reseat test: e5 → e10 (five columns right).
  drag(partEl(surface, chip.id), world, { x: 8, y: 6.5 }, { x: 13, y: 6.5 });

  assert.equal(doc.getComponent(chip.id).anchor, "e10");
  const moved = doc.getAnnotation(label.id);
  assert.equal(moved.x, 8, "label x shifted by the chip's +5 columns");
  assert.equal(moved.y, 6, "label y unchanged");
});

test("an anchored label springs back when the chip's drop is illegal", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5"); // cols 5–11
  controller.addComponentAt("74LS00", "bb1", "e12"); // blocks e10
  const label = doc.addAnnotation("label", 3, 6, "U1", { anchor: chip.id });
  window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));

  drag(partEl(surface, chip.id), world, { x: 8, y: 6.5 }, { x: 13, y: 6.5 });

  assert.equal(doc.getComponent(chip.id).anchor, "e5", "chip reverted");
  const still = doc.getAnnotation(label.id);
  assert.deepEqual({ x: still.x, y: still.y }, { x: 3, y: 6 }, "label unmoved");
});

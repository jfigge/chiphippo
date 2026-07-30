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

// jsdom tests for ABANDONING a wire gesture — the two ways a drag has to die
// without committing, both of which the wire tools used to survive.
//
// The wire/bus drags live in their own modules (WireTools/BusTools) but share
// DeskController's `#mode`, so the controller is what decides whether a drag is
// in flight at all. That answer was a hand-kept LIST of mode kinds, and it fell
// silently behind when routed wires added `drag-wire-point`: a bend drag was
// invisible to it, so Escape stopped cancelling one, `#rebuildScene` stopped
// killing one (an undo or a tab switch mid-bend left the gesture alive, with
// window-scoped listeners, to commit into the document that replaced it), and
// the mid-drag shortcut guard stopped applying. It is derived from the kind's
// NAME now, so a future drag kind is covered the day it is written.
//
// The second is the run lock. Space and ⌘R reach the transport while a drag is
// in flight — app.js only declines them for an armed TOOL, and a drag is not
// one — so a gesture begun while editing was allowed can be released into a
// RUNNING circuit. Every DeskController drag has always treated that as a
// cancel; the wire and bus drags did not, and quietly committed a topology edit
// with the simulation live.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";

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

/** Dispatch one pointer event of `type` on `el` at a client point. */
function fire(el, type, { id = 7, client = [0, 0] } = {}) {
  el.dispatchEvent(
    new window.PointerEvent(type, {
      bubbles: true,
      button: 0,
      pointerId: id,
      clientX: client[0],
      clientY: client[1],
    }),
  );
}

const wireSvg = (surface) => surface.querySelector(".wire-svg");
const wireBody = (surface, id) =>
  surface.querySelector(`.wire[data-wire-id="${id}"]`);

/**
 * A board with ONE routed wire along row a (a10 → a20). Row a sits at world
 * y = 12 on a `pins-full` strip placed at the origin, and column N at x = N.
 */
function routedScene() {
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const desk = makeDesk(doc, world);
  desk.controller.addBoardAt("pins-full", 0, 0);
  doc.addWire({ from: "bb1.a10", to: "bb1.a20", layout: "routed" });
  desk.controller.loadDocument(doc.toJSON()); // remount so the wire is drawn
  return { doc, ...desk };
}

/** Press on the wire's body at (15, 12) and drag out to (15, 9) — WITHOUT
    releasing, so a caller can interrupt it. */
function beginBend({ doc, surface, world }) {
  const before = doc.getWire("w1").points?.length ?? 0;
  world.x = 15;
  world.y = 12;
  fire(wireBody(surface, "w1"), "pointerdown");
  world.x = 15;
  world.y = 9;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });
  return before;
}

const release = (surface) =>
  fire(wireSvg(surface), "pointerup", { client: [40, 40] });

const bends = (doc) => doc.getWire("w1")?.points?.length ?? 0;

// ── The gesture is a real one (so the negatives below mean something) ────────

test("bending a routed wire: press, drag, release adds ONE waypoint", () => {
  resetDom();
  const scene = routedScene();
  beginBend(scene);
  release(scene.surface);
  assert.equal(bends(scene.doc), 1, "the bend committed");
});

// ── Escape ──────────────────────────────────────────────────────────────────

test("Escape mid-bend abandons it — the release commits nothing", () => {
  resetDom();
  const scene = routedScene();
  beginBend(scene);

  scene.controller.handleKeyDown({ key: "Escape", target: document.body });
  release(scene.surface);

  assert.equal(bends(scene.doc), 0, "no waypoint was written");
});

// ── A scene rebuilt under the gesture (undo/redo, a tab switch) ──────────────

test("a scene rebuilt mid-bend kills the gesture rather than letting it land", () => {
  resetDom();
  const scene = routedScene();
  beginBend(scene);

  // What a tab switch and an undo/redo restore both do: tear the scene down and
  // remount it. The gesture's listeners live on `window`, so they SURVIVE that
  // — the release would otherwise commit against the document that replaced it.
  scene.controller.loadDocument(scene.doc.toJSON());
  release(scene.surface);

  assert.equal(bends(scene.doc), 0, "no waypoint was written");
});

// ── The run lock ────────────────────────────────────────────────────────────

test("a bend released into a RUNNING circuit reverts instead of committing", () => {
  resetDom();
  const scene = routedScene();
  beginBend(scene);

  scene.controller.setEditingLocked(true); // Space/⌘R reached the transport
  release(scene.surface);

  assert.equal(bends(scene.doc), 0, "topology is frozen while running");
});

test("an ENDPOINT drag released into a running circuit reverts too", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  doc.addWire({ from: "bb1.a10", to: "bb1.a20" });
  controller.loadDocument(doc.toJSON());

  // Grab the 'from' cap, which sits on hole a10, and drag it up one row.
  world.x = 10;
  world.y = 12;
  fire(wireBody(surface, "w1"), "pointerdown");
  world.x = 10;
  world.y = 11;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });

  controller.setEditingLocked(true);
  fire(wireSvg(surface), "pointerup", { client: [40, 40] });

  assert.equal(doc.getWire("w1").from, "bb1.a10", "the end did not re-route");
});

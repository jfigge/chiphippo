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

// The target registry: ids → live elements → window rectangles, with null
// as an answer (absent, hidden, detached) and several elements as a union.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import {
  clearTargets,
  registerTarget,
  registeredTargets,
  resolveTarget,
  targetRect,
} from "../tutorials/targets.js";

/** An attached element laid out at `rect` (jsdom lays nothing out). */
function box(rect) {
  const node = document.createElement("div");
  node.getBoundingClientRect = () => ({ ...rect });
  document.body.append(node);
  return node;
}

test("an element, a getter, and a getter with nothing to offer", () => {
  resetDom();
  clearTargets();
  const a = box({ left: 10, top: 20, width: 30, height: 40 });
  registerTarget("a", a);
  let shownNow = null;
  registerTarget("b", () => shownNow);
  assert.equal(resolveTarget("a"), a);
  assert.deepEqual(targetRect("a"), {
    left: 10,
    top: 20,
    width: 30,
    height: 40,
  });
  assert.equal(resolveTarget("b"), null, "the getter's null is an answer");
  shownNow = a;
  assert.equal(resolveTarget("b"), a);
  assert.equal(resolveTarget("never"), null);
  assert.deepEqual(registeredTargets().sort(), ["a", "b"]);
});

test("hidden, detached and zero-size targets cannot be pointed at", () => {
  resetDom();
  clearTargets();
  const parent = document.createElement("section");
  document.body.append(parent);
  const inside = box({ left: 0, top: 0, width: 5, height: 5 });
  parent.append(inside);
  registerTarget("inside", inside);
  parent.hidden = true;
  assert.equal(resolveTarget("inside"), null, "a hidden ancestor hides it");
  parent.hidden = false;
  inside.remove();
  assert.equal(resolveTarget("inside"), null, "detached");
  registerTarget("flat", box({ left: 0, top: 0, width: 0, height: 0 }));
  assert.equal(targetRect("flat"), null, "laid out to nothing");
});

test("several elements answer as their union; a later registration wins", () => {
  resetDom();
  clearTargets();
  const strips = [
    box({ left: 100, top: 100, width: 400, height: 30 }),
    box({ left: 100, top: 130, width: 400, height: 140 }),
    box({ left: 100, top: 270, width: 400, height: 30 }),
  ];
  registerTarget("kit", () => strips);
  assert.equal(resolveTarget("kit"), strips[0]);
  assert.deepEqual(targetRect("kit"), { left: 100, top: 100, width: 400, height: 200 }); // prettier-ignore

  const off = registerTarget("x", strips[0]);
  registerTarget("x", strips[1]);
  off(); // the first registration's deregister leaves the second alone
  assert.equal(resolveTarget("x"), strips[1]);
});

test("a clipped target is cut to what can be seen through its clip", () => {
  resetDom();
  clearTargets();
  const desk = box({ left: 200, top: 50, width: 600, height: 400 });
  const board = box({ left: 100, top: 100, width: 400, height: 200 });
  registerTarget("board", board, { clip: desk });
  assert.deepEqual(targetRect("board"), { left: 200, top: 100, width: 300, height: 200 }); // prettier-ignore
  registerTarget("gone", box({ left: 0, top: 0, width: 50, height: 50 }), { clip: desk }); // prettier-ignore
  assert.equal(targetRect("gone"), null, "wholly out of sight");
});

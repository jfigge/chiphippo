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

// Unit tests for model/selection-toggle.js — the pure half of the additive
// selection gesture. The platform branch is the reason this file exists: the
// app only ever runs one side of it, so nothing else can hold both.

import test from "node:test";
import assert from "node:assert/strict";

import {
  isToggleSelectEvent,
  singlePick,
  toggleSelection,
} from "../model/selection-toggle.js";

test("the chord is ⌘ on macOS and Ctrl everywhere else", () => {
  const cmd = { metaKey: true };
  const ctrl = { ctrlKey: true };

  assert.equal(isToggleSelectEvent(cmd, true), true);
  assert.equal(isToggleSelectEvent(ctrl, false), true);

  // Ctrl on a Mac is the SECONDARY CLICK — answering to it there would cost
  // the desk's context menus, since one press cannot both toggle the
  // selection and open a menu over the top of it.
  assert.equal(isToggleSelectEvent(ctrl, true), false);
  // And the Windows key is not an accelerator off a Mac.
  assert.equal(isToggleSelectEvent(cmd, false), false);
});

test("only the PRIMARY button — Ctrl+right-click stays a right-click", () => {
  assert.equal(isToggleSelectEvent({ ctrlKey: true, button: 0 }, false), true);
  assert.equal(isToggleSelectEvent({ ctrlKey: true, button: 2 }, false), false);
  assert.equal(isToggleSelectEvent({ metaKey: true, button: 2 }, true), false);
  assert.equal(isToggleSelectEvent({ metaKey: true, button: 1 }, true), false);
});

test("Shift and Option are excluded — each belongs to another gesture", () => {
  // Shift-drag rubber-bands the marquee; Option-drag carries a part's wiring
  // (or tears a board run off its group).
  assert.equal(
    isToggleSelectEvent({ ctrlKey: true, shiftKey: true }, false),
    false,
  );
  assert.equal(
    isToggleSelectEvent({ ctrlKey: true, altKey: true }, false),
    false,
  );
  assert.equal(
    isToggleSelectEvent({ metaKey: true, shiftKey: true }, true),
    false,
  );
  assert.equal(
    isToggleSelectEvent({ metaKey: true, altKey: true }, true),
    false,
  );
});

test("a bare click, and a missing event, are not the chord", () => {
  assert.equal(isToggleSelectEvent({}, true), false);
  assert.equal(isToggleSelectEvent(null, false), false);
});

test("toggleSelection adds what is absent and removes what is present", () => {
  const empty = { parts: [], wires: [], boards: [] };

  const one = toggleSelection(empty, "parts", ["c1"]);
  assert.deepEqual(one, { parts: ["c1"], wires: [], boards: [] });

  const two = toggleSelection(one, "parts", ["c2"]);
  assert.deepEqual(two.parts, ["c1", "c2"]);

  assert.deepEqual(toggleSelection(two, "parts", ["c1"]).parts, ["c2"]);
});

test("the other two sets are carried through untouched", () => {
  const next = toggleSelection(
    { parts: ["c1"], wires: ["w1"], boards: ["bb1"] },
    "wires",
    ["w2"],
  );
  assert.deepEqual(next, {
    parts: ["c1"],
    wires: ["w1", "w2"],
    boards: ["bb1"],
  });
});

test("a set of ids toggles ALL-OR-NOTHING, so a partial group completes", () => {
  const kit = ["bb1", "bb2", "bb3"];
  // Every member present → the whole group leaves.
  assert.deepEqual(toggleSelection({ boards: kit }, "boards", kit).boards, []);
  // Only some present → the rest join, rather than the click half-clearing it.
  // That is an answer the NEXT click can undo; a half-clear is not.
  assert.deepEqual(toggleSelection({ boards: ["bb2"] }, "boards", kit).boards, [
    "bb2",
    "bb1",
    "bb3",
  ]);
});

test("an empty id list and an unknown kind change nothing", () => {
  const cur = { parts: ["c1"], wires: [], boards: [] };
  assert.deepEqual(toggleSelection(cur, "parts", []), cur);
  assert.deepEqual(toggleSelection(cur, "annotations", ["a1"]), cur);
});

test("singlePick names the one item, and only when there is exactly one", () => {
  assert.deepEqual(singlePick({ parts: ["c1"], wires: [], boards: [] }), {
    kind: "part",
    id: "c1",
  });
  assert.deepEqual(singlePick({ parts: [], wires: ["w1"], boards: [] }), {
    kind: "wire",
    id: "w1",
  });
  assert.deepEqual(singlePick({ parts: [], wires: [], boards: ["bb1"] }), {
    kind: "board",
    id: "bb1",
  });
  assert.equal(singlePick({ parts: [], wires: [], boards: [] }), null);
  assert.equal(singlePick({ parts: ["c1"], wires: ["w1"], boards: [] }), null);
  assert.equal(singlePick({ parts: [], wires: [], boards: ["a", "b"] }), null);
});

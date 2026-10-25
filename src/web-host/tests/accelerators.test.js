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

// accelerators.test.js — the web menu's reading of Electron accelerators: the
// label beside an item and whether a keydown is its chord. Every accelerator
// main's application menu declares must parse, or its item would show no
// shortcut and answer no key.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  acceleratorLabel,
  matchesAccelerator,
  parseAccelerator,
} from "../accelerators.js";

const key = (k, mods = {}) => ({
  key: k,
  code: /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

test("CmdOrCtrl is ⌘ on a Mac and Ctrl elsewhere", () => {
  const save = "CmdOrCtrl+S";
  assert.ok(
    matchesAccelerator(
      parseAccelerator(save, true),
      key("s", { metaKey: true }),
    ),
  );
  assert.ok(
    !matchesAccelerator(
      parseAccelerator(save, true),
      key("s", { ctrlKey: true }),
    ),
  );
  assert.ok(
    matchesAccelerator(
      parseAccelerator(save, false),
      key("s", { ctrlKey: true }),
    ),
  );
  assert.equal(acceleratorLabel(save, true), "⌘S");
  assert.equal(acceleratorLabel(save, false), "Ctrl+S");
});

test("modifiers must match exactly", () => {
  const redo = parseAccelerator("Shift+CmdOrCtrl+Z", true);
  assert.ok(
    matchesAccelerator(redo, key("Z", { metaKey: true, shiftKey: true })),
  );
  assert.ok(!matchesAccelerator(redo, key("z", { metaKey: true })));
  const undo = parseAccelerator("CmdOrCtrl+Z", true);
  assert.ok(
    !matchesAccelerator(undo, key("Z", { metaKey: true, shiftKey: true })),
  );
  assert.equal(acceleratorLabel("Shift+CmdOrCtrl+Z", true), "⇧⌘Z");
});

test("a letter matches by physical key on a non-Latin layout", () => {
  const chord = parseAccelerator("CmdOrCtrl+S", false);
  assert.ok(
    matchesAccelerator(chord, { key: "ы", code: "KeyS", ctrlKey: true }),
  );
});

test("punctuation chords: settings (,) and the guide (/)", () => {
  assert.ok(
    matchesAccelerator(
      parseAccelerator("CmdOrCtrl+,", true),
      key(",", { metaKey: true }),
    ),
  );
  assert.ok(
    matchesAccelerator(
      parseAccelerator("CmdOrCtrl+/", true),
      key("/", { metaKey: true }),
    ),
  );
  assert.equal(parseAccelerator("", true), null);
});

test("every accelerator main's menu declares parses", () => {
  const main = readFileSync(
    new URL("../../app/main.js", import.meta.url),
    "utf8",
  );
  const accels = [...main.matchAll(/accelerator:\s*"([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(accels.length >= 10, "the menu's accelerators were found");
  for (const a of accels) {
    assert.ok(parseAccelerator(a, true), a);
    assert.ok(parseAccelerator(a, false), a);
  }
});

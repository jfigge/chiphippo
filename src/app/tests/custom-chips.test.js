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

// The machine's library of designed chips (store/custom-chips.js): one JSON
// file in userData, every chip held to its shape on the way in, adds and
// replacements by id, and a damaged file that costs the library rather than
// the app.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ChipLibraryStore,
  MAX_CUSTOM_CHIPS,
  sanitizeCustomChips,
} = require("../store/custom-chips");

/** Run `fn` against a throwaway userData dir, cleaning up either way. */
function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-chips-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const chip = (id, extra = {}) => ({
  id,
  name: "MYNAND",
  description: "",
  family: "74LS",
  pinsPerSide: 7,
  wide: false,
  ports: [
    { name: "A", dir: "input", width: 1 },
    { name: "Y", dir: "output", width: 1 },
  ],
  units: [{ A: [1], Y: [3] }],
  vcc: 14,
  gnd: 7,
  code: "assign Y = ~A;\n",
  ...extra,
});

test("an empty library reads as no chips, and writes nothing until asked", () => {
  withDir((dir) => {
    const store = new ChipLibraryStore(dir);
    assert.deepEqual(store.list(), []);
    assert.equal(fs.existsSync(path.join(dir, "custom-chips.json")), false);
  });
});

test("put adds a chip, then replaces it by id; the file outlives the store", () => {
  withDir((dir) => {
    const store = new ChipLibraryStore(dir);
    store.put([chip("custom-0000aaaa"), chip("custom-0000bbbb")]);
    store.put([chip("custom-0000aaaa", { name: "RENAMED" })]);
    const again = new ChipLibraryStore(dir).list();
    assert.deepEqual(
      again.map((c) => [c.id, c.name]),
      [
        ["custom-0000aaaa", "RENAMED"],
        ["custom-0000bbbb", "MYNAND"],
      ],
      "replaced in place, order kept",
    );
  });
});

test("remove drops one chip; an unknown id is a no-op", () => {
  withDir((dir) => {
    const store = new ChipLibraryStore(dir);
    store.put([chip("custom-0000aaaa"), chip("custom-0000bbbb")]);
    store.remove("custom-0000aaaa");
    store.remove("custom-00000000");
    assert.deepEqual(
      new ChipLibraryStore(dir).list().map((c) => c.id),
      ["custom-0000bbbb"],
    );
  });
});

test("what goes in is held to the shape — junk and bad ids never reach the file", () => {
  withDir((dir) => {
    const store = new ChipLibraryStore(dir);
    store.put([
      chip("custom-0000aaaa", { family: "ECL", pinsPerSide: 99 }),
      chip("../escape"),
      "junk",
      null,
    ]);
    const [kept, ...rest] = new ChipLibraryStore(dir).list();
    assert.deepEqual(rest, []);
    assert.equal(kept.family, "74LS");
    assert.equal(kept.pinsPerSide, 7);
  });
});

test("the library stops growing at its limit", () => {
  withDir((dir) => {
    const store = new ChipLibraryStore(dir);
    const many = Array.from({ length: MAX_CUSTOM_CHIPS + 3 }, (_v, i) =>
      chip(`custom-${i.toString(16).padStart(8, "0")}`),
    );
    const res = store.put(many);
    assert.equal(res.count, MAX_CUSTOM_CHIPS);
  });
});

test("a damaged library file is set aside and reads as empty", () => {
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, "custom-chips.json"), "{ not json");
    const store = new ChipLibraryStore(dir);
    assert.deepEqual(store.list(), []);
    store.put([chip("custom-0000aaaa")]);
    assert.deepEqual(
      new ChipLibraryStore(dir).list().map((c) => c.id),
      ["custom-0000aaaa"],
    );
  });
});

test("the shape is the one project files are held to", () => {
  const [one] = sanitizeCustomChips([chip("custom-0000aaaa", { extra: 1 })]);
  assert.equal("extra" in one, false);
});

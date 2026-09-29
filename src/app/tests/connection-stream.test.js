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

/**
 * tests/connection-stream.test.js — one connection's stream, the list its
 * connection window shows: log text cut into lines, any other entry ending a
 * partial line where it is (not losing it), a run starting it afresh with its
 * own clock, Clear, and the 2,000-entry cap.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ConnectionStream,
  MAX_ENTRIES,
} = require("../serial/connection-stream");

test("log text is cut into lines; the rest waits as the partial", () => {
  const s = new ConnectionStream();
  s.beginRun(1000);
  assert.deepEqual(s.text("temp=2", 1001), []);
  assert.equal(s.partial, "temp=2");
  assert.deepEqual(s.text("1\r\nhum", 1005), [
    { kind: "text", t: 1001, text: "temp=21" },
  ]);
  assert.equal(s.partial, "hum", "a CR is dropped");
  assert.deepEqual(s.text("id\nA\nB", 1009), [
    { kind: "text", t: 1005, text: "humid" },
    { kind: "text", t: 1009, text: "A" },
  ]);
  assert.equal(s.partial, "B");
});

test("a line is stamped with when its first character arrived", () => {
  const s = new ConnectionStream();
  s.text("ab", 10);
  s.text("cd", 20);
  const [line] = s.text("\n", 30);
  assert.deepEqual(line, { kind: "text", t: 10, text: "abcd" });
});

test("any other entry ends a partial line where it is — the line is kept", () => {
  const s = new ConnectionStream();
  s.text("half a li", 5);
  const added = s.add({ kind: "data", dir: "out", t: 7, seq: 1 });
  assert.deepEqual(added, [
    { kind: "text", t: 5, text: "half a li" },
    { kind: "data", dir: "out", t: 7, seq: 1 },
  ]);
  assert.equal(s.partial, "");
  s.text("ne\n", 9);
  assert.deepEqual(
    s.snapshot().entries.map((e) => e.text ?? e.kind),
    ["half a li", "data", "ne"],
  );
});

test("an entry is stamped now unless it says when", () => {
  const s = new ConnectionStream();
  const before = Date.now();
  const [e] = s.add({ kind: "proto", event: "close" });
  assert.ok(e.t >= before);
});

test("a run starts it afresh and sets the clock; Clear empties it and keeps the clock", () => {
  const s = new ConnectionStream();
  assert.equal(s.t0, null);
  s.add({ kind: "proto", event: "open" });
  s.text("x", 1);
  s.beginRun(5000);
  assert.deepEqual(s.snapshot(), { t0: 5000, entries: [], partial: "" });
  s.add({ kind: "proto", event: "open" });
  s.clear();
  assert.deepEqual(s.snapshot(), { t0: 5000, entries: [], partial: "" });
});

test("it keeps the last MAX_ENTRIES entries", () => {
  const s = new ConnectionStream();
  assert.equal(MAX_ENTRIES, 2000);
  for (let i = 0; i < MAX_ENTRIES + 5; i++) s.add({ kind: "proto", n: i });
  const { entries } = s.snapshot();
  assert.equal(entries.length, MAX_ENTRIES);
  assert.equal(entries[0].n, 5, "the oldest dropped off the top");
});

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

// Tests for model/integration-runtime.js — the settle-boundary rules of the
// Arduino serial integration: when an Output fires and what it samples (on an
// edge, and on Auto), how an Input's value is buffered and when it is released
// (live on Auto vs triggered), atomic application, and the levels the engine
// is handed.

import test from "node:test";
import assert from "node:assert/strict";

import { IntegrationRuntime, isLive } from "../model/integration-runtime.js";

const tag = (anchor) => ({ anchor, rot: 0 });

const output = (extra = {}) => ({
  id: "out1",
  kind: "output",
  connection: "nano",
  triggerEdge: "rising",
  triggerInit: "low",
  fields: [
    { type: "bit", name: "a" },
    { type: "bit", name: "b" },
  ],
  tags: { 1: tag("bb1.a1"), 2: tag("bb1.a2"), T: tag("bb1.a9") },
  ...extra,
});

const input = (extra = {}) => ({
  id: "in1",
  kind: "input",
  connection: "nano",
  triggerEdge: "auto",
  triggerInit: "low",
  fields: [
    { type: "bit", name: "a" },
    { type: "bit", name: "b" },
  ],
  tags: { 1: tag("bb1.a11"), 2: tag("bb1.a12") },
  ...extra,
});

/** A settled board as a plain address → level table. */
const board = (levels) => (address) => levels[address];

test("an Output fires on its edge, sampling its pins at the same boundary", () => {
  const rt = new IntegrationRuntime();
  const els = [output()];
  rt.begin(els);
  let r = rt.boundary(els, board({ "bb1.a9": "L", "bb1.a1": "H" }));
  assert.equal(r.sends.length, 0, "low → low is no edge");
  r = rt.boundary(els, board({ "bb1.a9": "H", "bb1.a1": "H", "bb1.a2": "L" }));
  assert.equal(r.sends.length, 1);
  assert.deepEqual(
    {
      index: r.sends[0].index,
      width: r.sends[0].width,
      value: r.sends[0].value,
    },
    { index: 0, width: 2, value: 0b01 },
  );
  r = rt.boundary(els, board({ "bb1.a9": "H" }));
  assert.equal(r.sends.length, 0, "staying high does not fire again");
});

test("the trigger's initial state stands in for the first 'previous'", () => {
  const rt = new IntegrationRuntime();
  const low = [output({ triggerInit: "low" })];
  rt.begin(low);
  assert.equal(rt.boundary(low, board({ "bb1.a9": "H" })).sends.length, 1);
  const high = [output({ triggerInit: "high" })];
  rt.begin(high);
  assert.equal(
    rt.boundary(high, board({ "bb1.a9": "H" })).sends.length,
    0,
    "already high: no rising edge at the first settle",
  );
});

test("falling and either fire on the right transitions", () => {
  const rt = new IntegrationRuntime();
  const falling = [output({ triggerEdge: "falling", triggerInit: "high" })];
  rt.begin(falling);
  assert.equal(rt.boundary(falling, board({ "bb1.a9": "L" })).sends.length, 1);
  assert.equal(rt.boundary(falling, board({ "bb1.a9": "H" })).sends.length, 0);
  const either = [output({ triggerEdge: "either" })];
  rt.begin(either);
  assert.equal(rt.boundary(either, board({ "bb1.a9": "H" })).sends.length, 1);
  assert.equal(rt.boundary(either, board({ "bb1.a9": "L" })).sends.length, 1);
});

test("a floating trigger is LOW; an unplanted or floating pin reads 0", () => {
  const rt = new IntegrationRuntime();
  const els = [output({ tags: { 1: tag("bb1.a1"), T: tag("bb1.a9") } })];
  rt.begin(els);
  assert.equal(rt.boundary(els, board({ "bb1.a9": "Z" })).sends.length, 0);
  const r = rt.boundary(els, board({ "bb1.a9": "H", "bb1.a1": "Z" }));
  assert.equal(r.sends[0].value, 0);
});

test("an Output with no trigger tag, or no connection, never sends", () => {
  const rt = new IntegrationRuntime();
  const noTrigger = [output({ tags: { 1: tag("bb1.a1") } })];
  rt.begin(noTrigger);
  assert.equal(rt.boundary(noTrigger, () => "H").sends.length, 0);
  const noConn = [output({ connection: null })];
  rt.begin(noConn);
  assert.equal(rt.boundary(noConn, board({ "bb1.a9": "H" })).sends.length, 0);
});

test("an Output on AUTO sends where the run starts, then only on a change", () => {
  const rt = new IntegrationRuntime();
  // The fixture's trigger tag stays in its record: on Auto it means nothing.
  const els = [output({ triggerEdge: "auto" })];
  rt.begin(els);
  let r = rt.boundary(els, board({}));
  assert.deepEqual(
    r.sends.map((s) => [s.index, s.width, s.value]),
    [[0, 2, 0]],
    "the first boundary sends the starting value, even 0",
  );
  assert.equal(rt.boundary(els, board({})).sends.length, 0, "unchanged");
  r = rt.boundary(els, board({ "bb1.a1": "H" }));
  assert.deepEqual(
    r.sends.map((s) => s.value),
    [0b01],
  );
  assert.equal(
    rt.boundary(els, board({ "bb1.a1": "H", "bb1.a9": "H" })).sends.length,
    0,
    "a line where a trigger could be moves nothing",
  );
  r = rt.boundary(els, board({ "bb1.a2": "H" }));
  assert.deepEqual(
    r.sends.map((s) => s.value),
    [0b10],
  );
  rt.begin(els);
  assert.equal(
    rt.boundary(els, board({ "bb1.a2": "H" })).sends.length,
    1,
    "a new run starts over, and says where it is",
  );
});

test("an Output on AUTO with no connection never sends", () => {
  const rt = new IntegrationRuntime();
  const els = [output({ triggerEdge: "auto", connection: null })];
  rt.begin(els);
  assert.equal(rt.boundary(els, board({ "bb1.a1": "H" })).sends.length, 0);
});

test("several Outputs index by connection and kind", () => {
  const rt = new IntegrationRuntime();
  const els = [
    output({ id: "out1" }),
    output({ id: "out2", connection: "uno" }),
    output({ id: "out3" }),
  ];
  rt.begin(els);
  const r = rt.boundary(els, board({ "bb1.a9": "H" }));
  assert.deepEqual(
    r.sends.map((s) => [s.element.id, s.index]),
    [
      ["out1", 0],
      ["out2", 0],
      ["out3", 1],
    ],
  );
});

test("a LIVE Input applies its value at the next boundary, latest wins", () => {
  const rt = new IntegrationRuntime();
  const els = [input()];
  assert.equal(isLive(els[0]), true);
  rt.begin(els);
  assert.equal(rt.levels(els).size, 0, "no value yet: nothing driven");
  rt.receive(els, els[0], 2, 0b01);
  rt.receive(els, els[0], 2, 0b10); // superseded before any boundary
  assert.equal(rt.hasLivePending(els), true);
  assert.equal(rt.apply(els), true);
  assert.deepEqual(
    [...rt.levels(els)],
    [
      ["in1:1", "L"],
      ["in1:2", "H"],
    ],
  );
  assert.equal(rt.hasLivePending(els), false);
  assert.equal(rt.apply(els), false, "nothing new");
});

test("an Input waiting for an edge with no trigger tag is not live — it never applies", () => {
  const rt = new IntegrationRuntime();
  const els = [input({ triggerEdge: "rising" })];
  assert.equal(isLive(els[0]), false);
  rt.begin(els);
  rt.receive(els, els[0], 2, 3);
  assert.equal(rt.hasLivePending(els), false);
  const r = rt.boundary(els, () => "H");
  assert.equal(rt.apply(els, r.released), false);
});

test("the same value again changes nothing on the board", () => {
  const rt = new IntegrationRuntime();
  const els = [input()];
  rt.begin(els);
  rt.receive(els, els[0], 2, 3);
  assert.equal(rt.apply(els), true);
  rt.receive(els, els[0], 2, 3);
  assert.equal(rt.apply(els), false);
});

test("a TRIGGERED Input holds its value until the edge — then releases it", () => {
  const rt = new IntegrationRuntime();
  const trig = input({
    triggerEdge: "rising",
    tags: { 1: tag("bb1.a11"), 2: tag("bb1.a12"), T: tag("bb1.a19") },
  });
  const els = [trig];
  assert.equal(isLive(trig), false);
  rt.begin(els);
  rt.receive(els, trig, 2, 0b11);
  assert.equal(rt.hasLivePending(els), false, "not live: waits for the edge");
  let r = rt.boundary(els, board({ "bb1.a19": "L" }));
  assert.equal(rt.apply(els, r.released), false, "no edge: still held");
  r = rt.boundary(els, board({ "bb1.a19": "H" }));
  assert.deepEqual([...r.released], ["in1"]);
  assert.equal(rt.apply(els, r.released), true);
  assert.equal(rt.levels(els).get("in1:1"), "H");
});

test("an edge with nothing buffered releases nothing — the value waits for the next", () => {
  const rt = new IntegrationRuntime();
  const trig = input({
    triggerEdge: "rising",
    tags: { 1: tag("bb1.a11"), T: tag("bb1.a19") },
  });
  const els = [trig];
  rt.begin(els);
  let r = rt.boundary(els, board({ "bb1.a19": "H" }));
  assert.equal(rt.apply(els, r.released), false);
  rt.receive(els, trig, 2, 1);
  r = rt.boundary(els, board({ "bb1.a19": "H" }));
  assert.equal(rt.apply(els, r.released), false, "still high — no new edge");
  rt.boundary(els, board({ "bb1.a19": "L" }));
  r = rt.boundary(els, board({ "bb1.a19": "H" }));
  assert.equal(rt.apply(els, r.released), true);
});

test("every eligible Input is applied at once", () => {
  const rt = new IntegrationRuntime();
  const a = input({ id: "in1" });
  const b = input({
    id: "in2",
    triggerEdge: "rising",
    tags: { 1: tag("bb1.a21"), T: tag("bb1.a29") },
  });
  const els = [a, b];
  rt.begin(els);
  rt.receive(els, a, 2, 1);
  rt.receive(els, b, 2, 1);
  const r = rt.boundary(els, board({ "bb1.a29": "H" }));
  assert.equal(rt.apply(els, r.released), true);
  assert.equal(rt.levels(els).get("in1:1"), "H");
  assert.equal(rt.levels(els).get("in2:1"), "H");
});

test("only PLANTED pins drive, and never past the width received", () => {
  const rt = new IntegrationRuntime();
  const wide = input({
    fields: [{ type: "byte", name: "v" }],
    tags: { 1: tag("bb1.a1"), 3: tag("bb1.a3"), 8: tag("bb1.a8") },
  });
  const els = [wide];
  rt.begin(els);
  rt.receive(els, wide, 4, 0b1111); // a stale header sent 4 bits
  rt.apply(els);
  assert.deepEqual(
    [...rt.levels(els).keys()].sort(),
    ["in1:1", "in1:3"],
    "pin 8 is past the 4 bits sent; pin 2 is not planted",
  );
});

test("receive ignores an element it was not given; end forgets everything", () => {
  const rt = new IntegrationRuntime();
  const els = [input()];
  rt.begin(els);
  assert.equal(rt.receive(els, { id: "in9" }, 1, 1), false);
  rt.receive(els, els[0], 2, 1);
  rt.apply(els);
  rt.end();
  assert.equal(rt.levels(els).size, 0);
  assert.equal(rt.appliedValue("in1"), null);
});

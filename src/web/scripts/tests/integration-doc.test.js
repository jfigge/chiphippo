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

// Tests for the Output / Input elements in the desk document: the loader
// (THE RULE for a homeless tag, one hole one lead, colour repair, the cap and
// the counters), the element API, tag planting, and the engine driving an
// Input's pin tags — while an Output's, and every trigger, only listen.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DeskDoc,
  emptyDocument,
  isEmptyDocument,
  normalizeDocument,
} from "../model/desk-doc.js";
import { MAX_ELEMENTS } from "../model/integration.js";
import { buildOccupancy } from "../model/occupancy.js";
import { buildNetlist } from "../sim/netlist.js";
import { settle } from "../sim/engine.js";
import { H, L, Z } from "../sim/levels.js";

const board = { id: "bb1", type: "pins-full", x: 0, y: 0, rot: 0, group: null };

function withBoard() {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  return doc;
}

test("an empty document carries the list and both counters", () => {
  const doc = emptyDocument();
  assert.deepEqual(doc.integrations, []);
  assert.equal(doc.nextOutputId, 1);
  assert.equal(doc.nextInputId, 1);
});

test("an element makes a desk non-empty — it is content, like a signal", () => {
  const doc = emptyDocument();
  doc.integrations.push({ id: "out1" });
  assert.equal(isEmptyDocument(doc), false);
});

test("addIntegration mints per-kind ids from the width preset", () => {
  const doc = withBoard();
  const out = doc.addIntegration({ kind: "output", width: 8 });
  const inp = doc.addIntegration({ kind: "input", width: 4, connection: "c1" });
  const out2 = doc.addIntegration({ kind: "output" });
  assert.equal(out.id, "out1");
  assert.equal(inp.id, "in1");
  assert.equal(out2.id, "out2");
  assert.deepEqual(out.fields, [{ type: "byte", name: "value" }]);
  assert.equal(inp.fields.length, 4);
  assert.equal(inp.connection, "c1");
  assert.equal(out.triggerEdge, "rising");
  assert.equal(out.triggerInit, "low");
  assert.notEqual(out.color, inp.color, "colours cycle across elements");
  assert.throws(() => doc.addIntegration({ kind: "sideways" }), {
    code: "INVALID_ARG",
  });
});

test("elements share the colour cycle with signals", () => {
  const doc = withBoard();
  const sig = doc.addSignal({});
  const out = doc.addIntegration({ kind: "output" });
  assert.notEqual(out.color, sig.color);
});

test("the cap refuses one element past MAX_ELEMENTS", () => {
  const doc = withBoard();
  for (let i = 0; i < MAX_ELEMENTS; i++) doc.addIntegration({ kind: "input" });
  assert.throws(() => doc.addIntegration({ kind: "output" }), {
    code: "INTEGRATIONS_FULL",
  });
});

test("tags plant, move, rotate and unplug; one hole, one lead", () => {
  const doc = withBoard();
  const out = doc.addIntegration({ kind: "output", width: 2 });
  doc.plantIntegrationTag(out.id, "1", "bb1.a10", 90);
  assert.deepEqual(doc.getIntegration(out.id).tags, {
    1: { anchor: "bb1.a10", rot: 90 },
  });
  assert.deepEqual(buildOccupancy(doc.toJSON()).get("bb1.a10"), {
    kind: "tag",
    elementId: out.id,
    key: "1",
  });
  assert.equal(doc.canPlaceWire("bb1.a10", "bb1.a20"), false);
  // The tag may slide off its own hole; nobody else may land on it.
  assert.equal(doc.canPlaceIntegrationTag(out.id, "1", "bb1.a10"), true);
  assert.equal(doc.canPlaceIntegrationTag(out.id, "2", "bb1.a10"), false);
  assert.throws(() => doc.plantIntegrationTag(out.id, "2", "bb1.a10"), {
    code: "HOLE_TAKEN",
  });
  // A key the element does not have is refused.
  assert.throws(() => doc.plantIntegrationTag(out.id, "3", "bb1.a11"), {
    code: "NOT_FOUND",
  });
  doc.plantIntegrationTag(out.id, "T", "bb1.a11");
  doc.rotateIntegrationTag(out.id, "T");
  assert.equal(doc.getIntegration(out.id).tags.T.rot, 90);
  doc.unplantIntegrationTag(out.id, "1");
  assert.deepEqual(Object.keys(doc.getIntegration(out.id).tags), ["T"]);
  doc.unplantIntegrationTags(out.id);
  assert.equal(doc.getIntegration(out.id).tags, undefined);
});

test("a tag refuses a component terminal and a hole a signal flag holds", () => {
  const doc = withBoard();
  doc.addPsu(0, 30);
  const out = doc.addIntegration({ kind: "output" });
  assert.equal(doc.canPlaceIntegrationTag(out.id, "1", "psu1.+"), false);
  const sig = doc.addSignal({});
  doc.plantSignalFlag(sig.id, "bb1.a5");
  assert.equal(doc.canPlaceIntegrationTag(out.id, "1", "bb1.a5"), false);
  doc.plantIntegrationTag(out.id, "1", "bb1.a6");
  assert.equal(doc.canPlaceSignalFlag(sig.id, "bb1.a6"), false);
});

test("re-shaping the pins keeps tags by NUMBER and unplugs the ones past the end", () => {
  const doc = withBoard();
  const e = doc.addIntegration({ kind: "input", width: 4 });
  doc.plantIntegrationTag(e.id, "1", "bb1.a1");
  doc.plantIntegrationTag(e.id, "4", "bb1.a4");
  doc.plantIntegrationTag(e.id, "T", "bb1.a9");
  doc.setIntegrationFields(e.id, [
    { type: "bit", name: "a" },
    { type: "bit", name: "b" },
  ]);
  assert.deepEqual(Object.keys(doc.getIntegration(e.id).tags).sort(), [
    "1",
    "T",
  ]);
  doc.setIntegrationFields(e.id, [{ type: "byte", name: "data" }]);
  assert.equal(doc.getIntegration(e.id).tags["1"].anchor, "bb1.a1");
});

test("updateIntegration validates, and meta follows the component shape", () => {
  const doc = withBoard();
  const e = doc.addIntegration({ kind: "output" });
  doc.updateIntegration(e.id, {
    color: "green",
    connection: "nano",
    triggerEdge: "falling",
    triggerInit: "high",
  });
  const got = doc.getIntegration(e.id);
  assert.equal(got.color, "green");
  assert.equal(got.connection, "nano");
  assert.equal(got.triggerEdge, "falling");
  assert.equal(got.triggerInit, "high");
  assert.throws(() => doc.updateIntegration(e.id, { color: "black" }), {
    code: "INVALID_ARG",
  });
  assert.throws(() => doc.updateIntegration(e.id, { triggerEdge: "up" }), {
    code: "INVALID_ARG",
  });
  doc.updateIntegration(e.id, { connection: null });
  assert.equal(doc.getIntegration(e.id).connection, null);
  doc.setIntegrationMeta(e.id, { name: "Bus out", description: "" });
  assert.equal(doc.getIntegration(e.id).name, "Bus out");
  assert.ok(!("description" in doc.getIntegration(e.id)));
});

test("removing the board under a tag detaches it — the element stays", () => {
  const doc = withBoard();
  const e = doc.addIntegration({ kind: "output" });
  doc.plantIntegrationTag(e.id, "1", "bb1.a3");
  doc.removeBoard("bb1");
  assert.ok(doc.getIntegration(e.id));
  assert.equal(doc.getIntegration(e.id).tags, undefined);
});

test("copies are deep: mutating one never reaches the document", () => {
  const doc = withBoard();
  const e = doc.addIntegration({ kind: "output", width: 2 });
  doc.plantIntegrationTag(e.id, "1", "bb1.a3");
  const copy = doc.getIntegration(e.id);
  copy.fields[0].name = "hacked";
  copy.tags["1"].anchor = "bb1.a9";
  assert.equal(doc.getIntegration(e.id).fields[0].name, "bit0");
  assert.equal(doc.getIntegration(e.id).tags["1"].anchor, "bb1.a3");
});

test("the loader: kind from the id, THE RULE for a homeless tag, first wins", () => {
  const doc = normalizeDocument({
    boards: [board],
    components: [],
    wires: [{ id: "w1", from: "bb1.a1", to: "bb1.a30", color: "red" }],
    signals: [{ id: "sig1", color: "red", flag: { anchor: "bb1.a2", rot: 0 } }],
    integrations: [
      {
        id: "out4",
        kind: "input", // lies — the id says output
        color: "black", // repaired
        fields: [{ type: "bit", name: "go" }, { type: "bit" }],
        tags: {
          1: { anchor: "bb1.a1", rot: 0 }, // a wire end holds it
          2: { anchor: "bb1.a3", rot: 270 },
          T: { anchor: "bb9.a1", rot: 0 }, // no such board
          9: { anchor: "bb1.a4", rot: 0 }, // no such pin
        },
      },
      { id: "in2", tags: { 1: { anchor: "bb1.a2", rot: 0 } } }, // flag holds it
      { id: "out4" }, // duplicate id
      { id: "banana" },
    ],
    nextOutputId: 2,
  });
  assert.deepEqual(
    doc.integrations.map((e) => e.id),
    ["out4", "in2"],
  );
  const [out, inp] = doc.integrations;
  assert.equal(out.kind, "output");
  assert.notEqual(out.color, "black");
  assert.deepEqual(out.tags, { 2: { anchor: "bb1.a3", rot: 270 } });
  assert.equal(inp.kind, "input");
  assert.equal(inp.tags, undefined);
  assert.equal(doc.nextOutputId, 5, "counters run past every id kept");
  assert.equal(doc.nextInputId, 3);
});

// ── The engine ─────────────────────────────────────────────────────────────

function solve(integrations, signalLevels) {
  const doc = {
    boards: [board],
    components: [],
    wires: [],
    signals: [],
    integrations,
  };
  const netlist = buildNetlist(doc);
  const result = settle({ document: doc, netlist, signalLevels });
  return (address) => result.netLevels.get(netlist.netOfPoint.get(address));
}

test("an Input's pin tags drive their nets from `<element>:<pin>` levels", () => {
  const at = solve(
    [
      {
        id: "in1",
        kind: "input",
        fields: [{ type: "bit" }, { type: "bit" }],
        tags: {
          1: { anchor: "bb1.a5", rot: 0 },
          2: { anchor: "bb1.a6", rot: 0 },
        },
      },
    ],
    new Map([
      ["in1:1", H],
      ["in1:2", L],
    ]),
  );
  assert.equal(at("bb1.e5"), H, "the whole column-half");
  assert.equal(at("bb1.a6"), L);
});

test("an Input with no value yet drives nothing — the net floats", () => {
  const at = solve(
    [
      {
        id: "in1",
        kind: "input",
        fields: [{ type: "bit" }],
        tags: { 1: { anchor: "bb1.a5", rot: 0 } },
      },
    ],
    new Map(),
  );
  assert.equal(at("bb1.a5"), Z);
});

test("an Output's tags and every trigger tag only listen", () => {
  const at = solve(
    [
      {
        id: "out1",
        kind: "output",
        fields: [{ type: "bit" }],
        tags: {
          1: { anchor: "bb1.a5", rot: 0 },
          T: { anchor: "bb1.a7", rot: 0 },
        },
      },
      {
        id: "in1",
        kind: "input",
        fields: [{ type: "bit" }],
        tags: { T: { anchor: "bb1.a8", rot: 0 } },
      },
    ],
    new Map([
      ["out1:1", H],
      ["out1:T", H],
      ["in1:T", H],
    ]),
  );
  assert.equal(at("bb1.a5"), Z);
  assert.equal(at("bb1.a7"), Z);
  assert.equal(at("bb1.a8"), Z);
});

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
  assert.equal(out.triggerEdge, "rising", "an Output waits for a strobe");
  assert.equal(inp.triggerEdge, "auto", "an Input takes values as they come");
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

test("a bus drag, a cluster drag and an Option-drag cannot land on a tag or a flag", () => {
  // Each prepares its own occupancy with the movers lifted out — and a planted
  // tag or flag, which never travels with them, must still read as taken.
  const doc = withBoard();
  const wire = doc.addWire({ from: "bb1.a1", to: "bb1.a30", color: "red" });
  const chip = doc.addComponent({
    kind: "chip",
    ref: "74LS00",
    board: "bb1",
    anchor: "e5",
  });
  const inp = doc.addIntegration({ kind: "input" });
  doc.plantIntegrationTag(inp.id, "1", "bb1.e20");
  const sig = doc.addSignal({});
  doc.plantSignalFlag(sig.id, "bb1.b3");
  const batch = (from) => [{ id: wire.id, from, to: "bb1.a30" }];
  assert.equal(doc.canMoveWiresBatch(batch("bb1.b3")), false, "a flag's hole");
  assert.equal(doc.canMoveWiresBatch(batch("bb1.e20")), false, "a tag's hole");
  assert.equal(doc.canMoveWiresBatch(batch("bb1.b4")), true, "a free one");
  const cluster = doc.prepareClusterMove({ componentIds: [chip.id] });
  // At e20 the chip's pin 1 lands on the tag.
  assert.equal(cluster([{ id: chip.id, board: "bb1", anchor: "e20" }]), false);
  assert.equal(cluster([{ id: chip.id, board: "bb1", anchor: "e40" }]), true);
  assert.throws(
    () => doc.moveComponentWithWires(chip.id, "bb1", "e20", { moves: [] }),
    { code: "ILLEGAL_PLACEMENT" },
  );
  assert.equal(doc.getIntegration(inp.id).tags["1"].anchor, "bb1.e20");
});

test("re-shaping the pins keeps tags by NUMBER and unplugs the ones past the end", () => {
  const doc = withBoard();
  const e = doc.addIntegration({ kind: "output", width: 4 });
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

// ── Auto: no trigger tag, and a parked one remembered ─────────────────────

test("an element on Auto has no trigger tag to plant", () => {
  const doc = withBoard();
  const inp = doc.addIntegration({ kind: "input", width: 2 });
  assert.throws(() => doc.plantIntegrationTag(inp.id, "T", "bb1.a9"), {
    code: "NOT_FOUND",
  });
  doc.updateIntegration(inp.id, { triggerEdge: "rising" });
  doc.plantIntegrationTag(inp.id, "T", "bb1.a9");
  assert.equal(doc.getIntegration(inp.id).tags.T.anchor, "bb1.a9");
});

test("switching to Auto parks the trigger; switching back puts it where it was", () => {
  const doc = withBoard();
  const out = doc.addIntegration({ kind: "output" });
  doc.plantIntegrationTag(out.id, "1", "bb1.a3");
  doc.plantIntegrationTag(out.id, "T", "bb1.a9", 90);
  doc.updateIntegration(out.id, { triggerEdge: "auto" });
  let got = doc.getIntegration(out.id);
  assert.deepEqual(Object.keys(got.tags), ["1"], "off the board");
  assert.deepEqual(got.parkedTrigger, { anchor: "bb1.a9", rot: 90 });
  assert.equal(
    buildOccupancy(doc.toJSON()).get("bb1.a9"),
    undefined,
    "a parked trigger claims nothing",
  );
  doc.updateIntegration(out.id, { triggerEdge: "falling" });
  got = doc.getIntegration(out.id);
  assert.deepEqual(
    got.tags.T,
    { anchor: "bb1.a9", rot: 90 },
    "back, as it was",
  );
  assert.equal(got.parkedTrigger, undefined);
});

test("switching between edges leaves the trigger alone; Auto to Auto is nothing", () => {
  const doc = withBoard();
  const out = doc.addIntegration({ kind: "output" });
  doc.plantIntegrationTag(out.id, "T", "bb1.a9");
  doc.updateIntegration(out.id, { triggerEdge: "either" });
  assert.equal(doc.getIntegration(out.id).tags.T.anchor, "bb1.a9");
  doc.updateIntegration(out.id, { triggerEdge: "auto" });
  doc.updateIntegration(out.id, { triggerEdge: "auto", triggerInit: "high" });
  assert.equal(doc.getIntegration(out.id).parkedTrigger.anchor, "bb1.a9");
});

test("a parked trigger whose hole was taken meanwhile waits on the card", () => {
  const doc = withBoard();
  const out = doc.addIntegration({ kind: "output" });
  doc.plantIntegrationTag(out.id, "T", "bb1.a9");
  doc.updateIntegration(out.id, { triggerEdge: "auto" });
  doc.addWire({ from: "bb1.a9", to: "bb1.a20" }); // the freed hole, reused
  doc.updateIntegration(out.id, { triggerEdge: "rising" });
  const got = doc.getIntegration(out.id);
  assert.equal(got.tags, undefined, "not planted over the wire");
  assert.equal(got.parkedTrigger, undefined, "and not remembered twice");
});

test("a parked trigger goes with the board under it, and with Remove All Tags", () => {
  const doc = withBoard();
  const out = doc.addIntegration({ kind: "output" });
  doc.plantIntegrationTag(out.id, "T", "bb1.a9");
  doc.updateIntegration(out.id, { triggerEdge: "auto" });
  doc.removeBoard("bb1");
  assert.equal(doc.getIntegration(out.id).parkedTrigger, undefined);

  const doc2 = withBoard();
  const out2 = doc2.addIntegration({ kind: "output" });
  doc2.plantIntegrationTag(out2.id, "T", "bb1.a9");
  doc2.updateIntegration(out2.id, { triggerEdge: "auto" });
  doc2.unplantIntegrationTags(out2.id);
  doc2.updateIntegration(out2.id, { triggerEdge: "rising" });
  assert.equal(doc2.getIntegration(out2.id).tags, undefined);
});

test("the loader: a parked trigger survives on Auto only, and never claims its hole", () => {
  const doc = normalizeDocument({
    boards: [board],
    components: [],
    wires: [{ id: "w1", from: "bb1.a9", to: "bb1.a30", color: "red" }],
    integrations: [
      // Parked under a wire end: kept, since a memory claims nothing.
      { id: "out1", triggerEdge: "auto", parkedTrigger: { anchor: "bb1.a9", rot: 180 } }, // prettier-ignore
      // A trigger PLANTED on an Auto element (never written) is parked.
      { id: "out2", triggerEdge: "auto", tags: { T: { anchor: "bb1.a5", rot: 0 } } }, // prettier-ignore
      // A park on an edge is meaningless and goes; so does one on no board.
      { id: "out3", triggerEdge: "rising", parkedTrigger: { anchor: "bb1.a6", rot: 0 } }, // prettier-ignore
      { id: "out4", triggerEdge: "auto", parkedTrigger: { anchor: "bb9.a6", rot: 0 } }, // prettier-ignore
      // No trigger stored: each kind's default.
      { id: "out5" },
      { id: "in1" },
    ],
  });
  const byId = Object.fromEntries(doc.integrations.map((e) => [e.id, e]));
  assert.deepEqual(byId.out1.parkedTrigger, { anchor: "bb1.a9", rot: 180 });
  assert.equal(byId.out1.tags, undefined);
  assert.deepEqual(byId.out2.parkedTrigger, { anchor: "bb1.a5", rot: 0 });
  assert.equal(byId.out2.tags, undefined);
  assert.equal(byId.out3.parkedTrigger, undefined);
  assert.equal(byId.out4.parkedTrigger, undefined);
  assert.equal(byId.out5.triggerEdge, "rising");
  assert.equal(byId.in1.triggerEdge, "auto");
  assert.deepEqual(buildOccupancy(doc).get("bb1.a5"), undefined);
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

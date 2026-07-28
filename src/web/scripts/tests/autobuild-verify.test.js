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

// Verifying the verifier. A gate that has only ever seen good circuits is not
// a gate, so every abort-class rung gets a deliberately broken build — and the
// breakages chosen are the ones that produce documents which load clean and
// simulate perfectly. That is the whole point: these failures are invisible to
// counting, to the loader, and to the engine.

import test from "node:test";
import assert from "node:assert/strict";

import { compileNetlist } from "../model/autobuild.js";
import {
  verifyBuild,
  verifySteps,
  runFunctionalTests,
} from "../model/autobuild-verify.js";
import { normalizeDocument } from "../model/desk-doc.js";
import { partPinAddresses } from "../model/occupancy.js";
import { buildNetlist } from "../sim/netlist.js";

// ── Specs ───────────────────────────────────────────────────────────────────

const ADDER = {
  title: "8-bit adder",
  parts: [
    { id: "U1", ref: "74LS283" },
    { id: "U2", ref: "74LS283" },
    { id: "SWA", ref: "sw-dip8" },
    { id: "SWB", ref: "sw-dip8" },
    { id: "RNA", ref: "rnet9" },
    { id: "RNB", ref: "rnet9" },
  ],
  nets: [
    { name: "CIN", members: ["U1.C0", "GND"] },
    { name: "CARRY", members: ["U1.C4", "U2.C0"] },
    ...["A", "B"].flatMap((side) => {
      const sw = side === "A" ? "SWA" : "SWB";
      const rn = side === "A" ? "RNA" : "RNB";
      const nets = [
        {
          name: `${side}_SRC`,
          members: [...Array(8)].map((_, i) => `${sw}.${i + 1}B`).concat("VCC"),
        },
        { name: `${side}_PD`, members: [`${rn}.COM`, "GND"] },
      ];
      for (let i = 0; i < 8; i++) {
        nets.push({
          name: `${side}${i}`,
          members: [
            `${sw}.${i + 1}A`,
            `${rn}.${i + 1}`,
            `U${i < 4 ? 1 : 2}.${side}${(i % 4) + 1}`,
          ],
        });
      }
      return nets;
    }),
  ],
  tests: [
    {
      name: "0 + 0 = 0",
      set: { SWA: 0, SWB: 0 },
      expect: { "U1.S1": "L", "U2.S4": "L", "U2.C4": "L" },
    },
    {
      name: "181 + 78 = 259 (sum 3, carry out)",
      set: { SWA: 181, SWB: 78 },
      expect: { "U1.S1": "H", "U1.S2": "H", "U1.S3": "L", "U2.C4": "H" },
    },
    {
      name: "255 + 255 = 510",
      set: { SWA: 255, SWB: 255 },
      expect: { "U1.S1": "L", "U2.S4": "H", "U2.C4": "H" },
    },
  ],
};

const COUNTER = {
  title: "counter on a bar",
  parts: [
    { id: "CTR", ref: "74LS161" },
    { id: "BAR", ref: "bar8" },
    { id: "CLK", ref: "clock" },
  ],
  nets: [
    {
      name: "RUN",
      members: ["CTR.CLR", "CTR.LOAD", "CTR.ENP", "CTR.ENT", "VCC"],
    },
    { name: "CLOCK", members: ["CLK.out", "CTR.CLK"] },
    { name: "CLKGND", members: ["CLK.gnd", "GND"] },
    { name: "Q0", members: ["CTR.QA", "BAR.1"] },
    { name: "Q1", members: ["CTR.QB", "BAR.2"] },
    { name: "Q2", members: ["CTR.QC", "BAR.3"] },
    { name: "Q3", members: ["CTR.QD", "BAR.4"] },
    { name: "BARGND", members: ["BAR.K", "GND"] },
  ],
  tests: [
    { name: "cleared", edges: 0, expect: { BAR: "00000000" } },
    {
      name: "after 3 edges the bar reads 3",
      edges: 3,
      expect: { BAR: "11000000" },
    },
    {
      name: "after 5 edges the bar reads 5",
      edges: 5,
      expect: { BAR: "10100000" },
    },
  ],
};

const compile = (spec) => {
  const out = compileNetlist(spec);
  assert.equal(out.ok, true, out.ok ? "" : JSON.stringify(out.errors));
  return out;
};

// ── The happy path ──────────────────────────────────────────────────────────

test("a good adder passes every gate, tests included", () => {
  const v = verifyBuild(compile(ADDER), ADDER);
  assert.deepEqual(v.faults, [], "no faults");
  assert.equal(v.ok, true);
  assert.equal(v.results.length, 3, "all three tests ran");
  assert.ok(
    v.results.every((r) => r.ok),
    JSON.stringify(v.results),
  );
});

test("a good counter passes, and its display is read through the burn rule", () => {
  const v = verifyBuild(compile(COUNTER), COUNTER);
  assert.deepEqual(v.faults, []);
  assert.ok(
    v.results.every((r) => r.ok),
    JSON.stringify(v.results),
  );
});

// ── L7 catches what nothing else can: a correct circuit, wrong intent ───────

test("a wrong expectation fails as REPAIR, naming actual vs expected", () => {
  const spec = {
    ...ADDER,
    tests: [
      // 181 + 78 = 259 → sum byte 3 → S1 high. Claiming L is the LSB-inversion
      // mistake this gate exists for: the circuit is right, the spec is wrong.
      {
        name: "bad claim",
        set: { SWA: 181, SWB: 78 },
        expect: { "U1.S1": "L" },
      },
    ],
  };
  const v = verifyBuild(compile(spec), spec);
  assert.equal(v.ok, false);
  const f = v.faults.find((x) => x.gate === "L7");
  assert.ok(f, "an L7 fault");
  assert.equal(f.kind, "repair", "the spec's mistake, not ours");
  assert.match(f.message, /U1\.S1 is H, expected L/);
});

test("a display expectation is checked on LIT, not merely conducting", () => {
  const spec = {
    ...COUNTER,
    tests: [{ name: "wrong", edges: 1, expect: { BAR: "00000000" } }],
  };
  const v = verifyBuild(compile(spec), spec);
  assert.equal(v.ok, false);
  const f = v.faults.find((x) => x.gate === "L7");
  assert.match(f.message, /reads 10000000, expected 00000000/);
});

test("bit ordering is stated, not inferred", () => {
  // A number and its 0/1 string must mean the same thing, or an LSB flips.
  const spec = {
    ...ADDER,
    tests: [
      {
        name: "as a number",
        set: { SWA: 5, SWB: 0 },
        expect: { "U1.S1": "H", "U1.S3": "H" },
      },
      {
        name: "as a string",
        set: { SWA: "10100000", SWB: "00000000" },
        expect: { "U1.S1": "H", "U1.S3": "H" },
      },
    ],
  };
  const v = verifyBuild(compile(spec), spec);
  assert.deepEqual(v.faults, [], JSON.stringify(v.results));
});

test("a test naming something absent is reported, not skipped", () => {
  const spec = {
    ...ADDER,
    tests: [{ name: "typo", set: { NOPE: 1 }, expect: {} }],
  };
  const v = verifyBuild(compile(spec), spec);
  assert.equal(v.ok, false);
  assert.match(
    v.faults.find((f) => f.gate === "L7").message,
    /not in the circuit/,
  );
});

test("no tests block is not a failure — it is just no L7 coverage", () => {
  const { tests, ...noTests } = ADDER;
  void tests;
  const v = verifyBuild(compile(noTests), noTests);
  assert.equal(v.ok, true);
  assert.deepEqual(v.results, []);
});

// ── Abort-class: circuits that load clean and simulate perfectly ────────────

test("L4 catches a SEVERED net — a wire quietly missing", () => {
  const out = compile(ADDER);
  // Cut the ripple-carry wire. Nothing else notices: the document still loads
  // with matching counts, both chips still power up, and the circuit still
  // settles without a warning. It just adds wrong above four bits.
  const doc = normalizeDocument(out.document);
  const netlist = buildNetlist(doc);
  const carryNetId = netlist.netOfPoint.get(
    addressOfMember(doc, out, out.nets.find((n) => n.name === "CARRY").pins[0]),
  );
  assert.ok(carryNetId != null, "the carry net exists");

  const before = out.document.wires.length;
  out.document.wires = out.document.wires.filter(
    (w) =>
      !(
        netlist.netOfPoint.get(w.from) === carryNetId &&
        netlist.netOfPoint.get(w.to) === carryNetId
      ),
  );
  assert.equal(out.document.wires.length, before - 1, "exactly one wire cut");

  const v = verifyBuild(out, null);
  assert.equal(v.ok, false);
  const f = v.faults.find((x) => x.code === "NET_SEVERED");
  assert.ok(
    f,
    `expected NET_SEVERED, got ${v.faults.map((x) => x.code).join(", ")}`,
  );
  assert.equal(f.kind, "abort", "our bug, not the spec's");
  assert.match(f.message, /CARRY/);
});

/** Desk address of a compiled net member. */
function addressOfMember(doc, out, member) {
  const comp = doc.components.find(
    (c) => c.id === out.partMap.get(member.partId),
  );
  return partPinAddresses(doc, comp)?.find((p) => p.pin === member.pin)
    ?.address;
}

test("L3b catches a part that does not seat", () => {
  const out = compile(COUNTER);
  // Shove a chip off the end of its board. Counts still match; the loader is
  // the only other thing that would notice, and it drops the part rather than
  // reporting it — so without L3b this is a silent disappearance.
  const chip = out.document.components.find((c) => c.ref === "74LS161");
  chip.anchor = "e62";
  const v = verifyBuild(out, null);
  assert.equal(v.ok, false);
  assert.ok(
    v.faults.some((f) => f.gate === "L3a" || f.gate === "L3b"),
    `expected a seating fault, got ${v.faults.map((f) => f.code).join(", ")}`,
  );
  assert.equal(v.faults[0].kind, "abort");
});

test("L5 reports an unpowered chip as a repairable spec mistake", () => {
  // A chip with no VCC/GND in the spec still compiles — the compiler derives
  // power — so to test L5 we remove the power wires after the fact.
  const out = compile(COUNTER);
  out.document.wires = out.document.wires.filter((w) => w.color !== "red");
  const v = verifyBuild(out, null);
  assert.equal(v.ok, false);
  assert.ok(
    v.faults.some((f) => f.gate === "L5" || f.gate === "L4"),
    `expected L4/L5, got ${v.faults.map((f) => `${f.gate}:${f.code}`).join(", ")}`,
  );
});

// ── The runner in isolation ─────────────────────────────────────────────────

test("runFunctionalTests reports per-test rather than throwing", () => {
  const out = compile(ADDER);
  const doc = normalizeDocument(out.document);
  const results = runFunctionalTests({
    doc,
    netlist: buildNetlist(doc),
    partMap: out.partMap,
    tests: [
      { name: "fine", set: { SWA: 1, SWB: 1 }, expect: { "U1.S2": "H" } },
      { name: "broken", set: { GHOST: 1 }, expect: {} },
      { name: "also fine", set: { SWA: 0, SWB: 0 }, expect: { "U1.S1": "L" } },
    ],
  });
  assert.equal(results.length, 3, "one bad test does not abort the rest");
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, false, true],
  );
});

// ── Stepping ────────────────────────────────────────────────────────────────
//
// The ladder is a generator so the panel can paint a label between gates (a
// callback could not: it all runs in one task, so nothing repaints until the
// end). `verifyBuild` drains that same generator, and these tests exist to
// keep the two from ever meaning different things.

/** Run a generator to completion, collecting what it yielded on the way. */
function collect(iterator) {
  const steps = [];
  let step = iterator.next();
  while (!step.done) {
    steps.push(step.value);
    step = iterator.next();
  }
  return { steps, value: step.value };
}

test("stepping and draining are the same verification", () => {
  // The load-bearing test of the whole refactor: if a stepped run could differ
  // from a drained one, every synchronous caller and the panel would be
  // checking different things, and only one of them would be tested.
  for (const [name, spec] of [
    ["adder", ADDER],
    ["counter", COUNTER],
  ]) {
    const sync = verifyBuild(compile(spec), spec);
    const { value: stepped } = collect(verifySteps(compile(spec), spec));
    assert.equal(stepped.ok, sync.ok, `${name}: same verdict`);
    assert.deepEqual(stepped.faults, sync.faults, `${name}: same faults`);
    assert.deepEqual(
      stepped.results?.map((r) => [r.name, r.ok]),
      sync.results?.map((r) => [r.name, r.ok]),
      `${name}: same test results`,
    );
  }
});

test("a failing build steps and drains alike, faults in the same order", () => {
  const wrong = {
    ...ADDER,
    tests: [
      { name: "backwards", set: { SWA: 1, SWB: 0 }, expect: { "U1.S1": "L" } },
    ],
  };
  const sync = verifyBuild(compile(wrong), wrong);
  const { value: stepped } = collect(verifySteps(compile(wrong), wrong));
  assert.equal(sync.ok, false, "the fixture really does fail");
  assert.deepEqual(
    stepped.faults.map((f) => `${f.gate}/${f.code}`),
    sync.faults.map((f) => `${f.gate}/${f.code}`),
  );
});

test("every gate reports itself, and L7 reports each test by name", () => {
  const { steps } = collect(verifySteps(compile(ADDER), ADDER));
  const gates = steps.map((s) => s.gate);
  assert.deepEqual(
    [...new Set(gates)],
    ["L3", "L4", "L5", "L6", "L7"],
    "in ladder order, each announced once before it runs",
  );
  const l7 = steps.filter((s) => s.gate === "L7");
  assert.equal(l7.length, ADDER.tests.length, "one step per acceptance test");
  assert.match(l7[0].label, /Running test 1 of 3/);
  assert.equal(l7[1].index, 1);
  assert.equal(l7[1].total, ADDER.tests.length);
  assert.ok(
    steps.every((s) => typeof s.label === "string" && s.label),
    "every step carries something showable",
  );
});

test("a spec with no tests yields no L7 steps at all", () => {
  const noTests = { ...ADDER, tests: undefined };
  const { steps, value } = collect(verifySteps(compile(noTests), noTests));
  assert.equal(value.ok, true);
  assert.equal(
    steps.filter((s) => s.gate === "L7").length,
    0,
    "no work to narrate, so no label for an empty pause",
  );
});

test("an early abort stops the ladder rather than narrating the rest", () => {
  // L4 catches a severed net and returns immediately. The steps are what the
  // user would SEE, so a run that abandoned the ladder must not have claimed
  // to be simulating — the gate labels have to track the real control flow.
  const out = compile(ADDER);
  out.document.wires = out.document.wires.filter(
    (w) => !/^bb\d+\.[a-j]/.test(w.from) || !/^bb\d+\.[a-j]/.test(w.to),
  );
  const { steps, value } = collect(verifySteps(out, ADDER));
  assert.equal(value.ok, false);
  assert.ok(
    value.faults.some((f) => f.gate === "L4"),
    JSON.stringify(value.faults.map((f) => f.code)),
  );
  assert.deepEqual(
    steps.map((s) => s.gate),
    ["L3", "L4"],
    "it never announced L5/L6/L7 it was not going to run",
  );
});

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

// Verifying the verifier. A gate that has only ever seen good circuits is not
// a gate, so every abort-class rung gets a deliberately broken build — and the
// breakages chosen are the ones that produce documents which load clean and
// simulate perfectly. That is the whole point: these failures are invisible to
// counting, to the loader, and to the engine.

import test from "node:test";
import assert from "node:assert/strict";

import { applyCatalog } from "../i18n.js";
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
            // The array's elements are pins 2–9; pin 1 is COM, tied to GND by
            // the `_PD` net above.
            `${rn}.${i + 2}`,
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
    // The parallel-load inputs are unused while LOAD is held HIGH, but an
    // unused TTL input is still TIED rather than left to float.
    { name: "DATA", members: ["CTR.A", "CTR.B", "CTR.C", "CTR.D", "GND"] },
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

test("a FALLING-edge part sees as many edges as it is asked for", () => {
  // A 74LS76 wired to toggle: each clock pulse flips 1Q on its falling edge.
  // One `edge` used to be L then H from a LOW start — every rising edge but
  // one falling edge short — so this design failed its own first test.
  const spec = {
    title: "toggle",
    parts: [
      { id: "FF", ref: "74LS76" },
      { id: "CLK", ref: "clock" },
    ],
    nets: [
      {
        name: "HOLD",
        members: ["FF.1J", "FF.1K", "FF.1PRE", "FF.1CLR", "VCC"],
      },
      { name: "CLOCK", members: ["CLK.out", "FF.1CLK"] },
      { name: "CLKGND", members: ["CLK.gnd", "GND"] },
    ],
    tests: [
      { name: "one pulse sets it", edges: 1, expect: { "FF.1Q": "H" } },
      { name: "two pulses clear it", edges: 2, expect: { "FF.1Q": "L" } },
      { name: "three set it again", edges: 3, expect: { "FF.1Q": "H" } },
    ],
  };
  const v = verifyBuild(compile(spec), spec);
  assert.deepEqual(v.faults, [], "no faults");
  assert.equal(v.results.length, 3, "all three tests ran");
  assert.deepEqual(
    v.results.filter((r) => !r.ok),
    [],
    "every test passes",
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
    tests: [{ name: "typo", set: { NOPE: 1 }, expect: { "U1.S1": "L" } }],
  };
  const v = verifyBuild(compile(spec), spec);
  assert.equal(v.ok, false);
  const l7 = v.faults.find((f) => f.gate === "L7");
  assert.match(l7.message, /not in the circuit/);
  assert.equal(l7.code, "TEST_INVALID", "the TEST is wrong, not the circuit");
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

test("a switch thrown to a rail is the switch WORKING, not a short", () => {
  // The regression the demo corpus found on its first run. An SPDT resting on
  // +5 V is the ordinary way to source a logic input — every one of the 52
  // bench demos does it — and it makes the conducting netlist report the signal
  // net AS the rail, which is true. L4 compared that against the declared
  // topology and called it NET_SHORTED_TO_RAIL, so EVERY slide-switch design
  // aborted as a compiler fault: `abort` class, so no repair round, and nothing
  // the model could have written differently.
  const spec = {
    parts: [
      { id: "U1", ref: "74LS04" },
      { id: "SW", ref: "sw-slide" },
    ],
    nets: [
      { name: "SRC", members: ["SW.1", "VCC"] },
      { name: "A", members: ["SW.C", "U1.1A"] },
    ],
  };
  const out = compileNetlist(spec);
  assert.equal(out.ok, true);
  const v = verifyBuild(out, spec);
  assert.equal(
    v.ok,
    true,
    v.faults.map((f) => `${f.code}: ${f.message}`).join("; "),
  );

  // …and the check it was doing is still done: a REAL short still aborts.
  const shorted = {
    parts: [{ id: "U1", ref: "74LS04" }],
    nets: [
      { name: "A", members: ["U1.1A", "U1.2A"] },
      { name: "B", members: ["U1.3A", "U1.4A"] },
    ],
  };
  const s = compileNetlist(shorted);
  assert.equal(s.ok, true);
  // Drop every wire: two declared nets now collapse onto their own pins alone,
  // which is a SEVERED net — the other half of the same comparison.
  s.document.wires = [];
  const sv = verifyBuild(s, shorted);
  assert.equal(sv.ok, false);
  assert.ok(
    sv.faults.some((f) => f.code === "NET_SEVERED" && f.kind === "abort"),
    `expected NET_SEVERED, got ${sv.faults.map((f) => f.code).join(", ")}`,
  );
});

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

test("every gate label goes through the catalog, L7 included", (t) => {
  // L7 was the one that did not: L3–L6 have been `tf("ai.gate.l…")` since the
  // ladder was written, while L7 built its label with a template literal — and
  // the file-level exclusion in tests/no-hardcoded-strings.test.js, whose own
  // reason says "the ladder's own progress labels ARE localized", is what kept
  // that invisible. The FAULT messages stay English by decision (they are the
  // model's repair instruction), which is what that exclusion is really for.
  applyCatalog({
    active: "xx",
    lang: "xx",
    messages: {
      ai: {
        gate: {
          l3: "[l3]",
          l4: "[l4]",
          l5: "[l5]",
          l6: "[l6]",
          l7: "[l7 {index}/{total} {name}]",
        },
      },
    },
  });
  t.after(() => applyCatalog({}));

  const { steps } = collect(verifySteps(compile(ADDER), ADDER));
  assert.deepEqual(
    steps.filter((s) => s.gate !== "L7").map((s) => s.label),
    ["[l3]", "[l4]", "[l5]", "[l6]"],
  );
  const l7 = steps.filter((s) => s.gate === "L7");
  assert.equal(l7[0].label, `[l7 1/${ADDER.tests.length} ${ADDER.tests[0].name}]`); // prettier-ignore
  assert.match(
    l7[1].label,
    /^\[l7 2\//,
    "the label counts from 1 while `index` stays 0-based for the caller",
  );
  assert.equal(l7[1].index, 1);
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

// ── The gaps the AI audit found ─────────────────────────────────────────────
//
// Each of these was a circuit that verified clean while doing something other
// than what its spec said, or a fault the repair round could not act on
// (docs/ai-generation-audit.md).

/** One inverter from a switch to a lamp — the smallest honest build. */
const INVERTER = {
  parts: [
    { id: "U1", ref: "74LS04" },
    { id: "SW", ref: "sw-dip1" },
    { id: "D", ref: "bar8" },
  ],
  nets: [
    { name: "A", members: ["U1.1A", "SW.1B"] },
    { name: "A_SRC", members: ["SW.1A", "VCC"] },
    { name: "Y", members: ["U1.1Y", "D.1"] },
    { name: "K", members: ["D.K", "GND"] },
  ],
};

test("an input the spec never connects is named, in the spec's own terms", () => {
  // A 74LS138 with its active-low enables left out reads them HIGH, so the
  // decoder is off and every output sits HIGH — which settles perfectly.
  const spec = {
    parts: [
      { id: "DEC", ref: "74LS138" },
      { id: "D", ref: "bar8" },
    ],
    nets: [
      { name: "SEL", members: ["DEC.A", "DEC.B", "DEC.C", "GND"] },
      { name: "G1", members: ["DEC.G1", "VCC"] },
      { name: "Y0", members: ["DEC.Y0", "D.1"] },
      { name: "K", members: ["D.K", "GND"] },
    ],
  };
  const v = verifyBuild(compile(spec), spec);
  const f = v.faults.find((x) => x.code === "INPUT_FLOATING");
  assert.ok(f, JSON.stringify(v.faults));
  assert.match(
    f.message,
    /^DEC \(74LS138\) leaves inputs G2A \(pin 4\), G2B \(pin 5\)/,
  );
  assert.equal(f.kind, "repair");
});

test("faults name the SPEC's part ids, never the document's", () => {
  // A '244 with its enables left out: the fault used to say "c2 (74LS244)",
  // an id the model never wrote and cannot find.
  const spec = {
    parts: [
      { id: "BUF", ref: "74LS244" },
      { id: "D", ref: "bar8" },
    ],
    nets: [
      { name: "IN", members: ["BUF.1A1", "VCC"] },
      { name: "OUT", members: ["BUF.1Y1", "D.1"] },
      { name: "K", members: ["D.K", "GND"] },
    ],
  };
  const v = verifyBuild(compile(spec), spec);
  const off = v.faults.find((x) => x.code === "OUTPUTS_DISABLED");
  assert.match(off.message, /BUF \(74LS244\)'s outputs are switched off/);
  assert.ok(!/\bc\d+\b/.test(off.message), off.message);
});

test("an oscillation says WHERE, and an X net is not called undriven", () => {
  const spec = {
    parts: [
      { id: "U1", ref: "74LS04" },
      { id: "D", ref: "bar8" },
    ],
    nets: [
      { name: "LOOP", members: ["U1.1Y", "U1.1A", "D.1"] },
      { name: "K", members: ["D.K", "GND"] },
    ],
  };
  const v = verifyBuild(compile(spec), spec);
  const osc = v.faults.find((x) => x.code === "SIM_OSCILLATION");
  assert.match(osc.message, /"LOOP" never settles/);
  assert.ok(!v.faults.some((x) => x.code === "NET_NOT_DRIVEN"));
  assert.ok(v.faults.some((x) => x.code === "NET_UNRESOLVED"));
});

test("a lamp between two outputs burns, and says so", () => {
  // Neither leg is on a rail, so no resistor can be interposed — and a burnt
  // junction is physics, not an engine warning, so nothing used to report it.
  const spec = {
    parts: [
      { id: "U1", ref: "74LS04" },
      { id: "L1", ref: "led" },
    ],
    nets: [
      { name: "HI_IN", members: ["U1.1A", "GND"] },
      { name: "LO_IN", members: ["U1.2A", "VCC"] },
      { name: "ANODE", members: ["U1.1Y", "L1.A"] },
      { name: "CATHODE", members: ["U1.2Y", "L1.K"] },
    ],
  };
  const v = verifyBuild(compile(spec), spec);
  const burn = v.faults.find((x) => x.code === "LED_BURNS");
  assert.match(burn?.message ?? "", /^L1 \(led\) burns/);
});

test("a test that cannot be run as written is INVALID, not failed", () => {
  const cases = [
    // A short pattern used to leave the missing positions open without a word.
    [
      { set: { SW: "10" }, expect: { D: "10000000" } },
      /has 1 position, and "10" gives 2/,
    ],
    // Edges with no clock used to settle and compare against power-on state.
    [{ edges: 2, expect: { D: "00000000" } }, /no clock source/],
    // A test that expects nothing can never fail.
    [{ set: { SW: 1 } }, /expects nothing/],
    // A display read with the wrong number of segments.
    [{ set: { SW: 1 }, expect: { D: "1" } }, /8 positions, and "1" gives 1/],
  ];
  for (const [t, why] of cases) {
    const spec = { ...INVERTER, tests: [{ name: "t", ...t }] };
    const v = verifyBuild(compile(spec), spec);
    const f = v.faults.find((x) => x.gate === "L7");
    assert.equal(f?.code, "TEST_INVALID", JSON.stringify(t));
    assert.match(f.message, why);
  }
  // The same pin grammar a net member has: a test may say `U1.1y` or `#2`.
  const spec = {
    ...INVERTER,
    tests: [
      { name: "open", set: { SW: 0 }, expect: { "U1.1y": "H" } },
      { name: "closed", set: { SW: 1 }, expect: { "U1.#2": "L" } },
    ],
  };
  assert.equal(verifyBuild(compile(spec), spec).ok, true);
});

test("every test starts from the circuit as built, not the last test's switches", () => {
  // The second test sets nothing, so it must see the switch at rest — not
  // closed, which is where the first test left it.
  const spec = {
    ...INVERTER,
    tests: [
      { name: "closed", set: { SW: 1 }, expect: { "U1.1Y": "L" } },
      { name: "at rest", expect: { "U1.1Y": "H" } },
    ],
  };
  const v = verifyBuild(compile(spec), spec);
  assert.equal(v.ok, true, JSON.stringify(v.faults));
});

test("a fight that only a TEST reaches is reported by that test", () => {
  // Two tri-state drivers on one bus, each enabled by its own switch (a
  // GND-side contact, so the compiler pulls each enable UP: both off at rest).
  // Closing both puts H and L on the bus at once — a state no default settle
  // visits, so only the test can find it.
  const spec = {
    parts: [
      { id: "U1", ref: "74LS125" },
      { id: "SW", ref: "sw-dip2" },
      { id: "D", ref: "bar8" },
    ],
    nets: [
      { name: "HI", members: ["U1.1A", "VCC"] },
      { name: "LO", members: ["U1.2A", "GND"] },
      { name: "BUS", members: ["U1.1Y", "U1.2Y", "D.1"] },
      { name: "K", members: ["D.K", "GND"] },
      { name: "EN1", members: ["U1.1G", "SW.1A"] },
      { name: "EN2", members: ["U1.2G", "SW.2A"] },
      { name: "SW_GND", members: ["SW.1B", "SW.2B", "GND"] },
    ],
  };
  const out = compile(spec);
  const doc = normalizeDocument(out.document);
  const results = runFunctionalTests({
    doc,
    netlist: buildNetlist(doc),
    partMap: out.partMap,
    tests: [
      { name: "one on", set: { SW: "10" }, expect: { D: "10000000" } },
      { name: "both on", set: { SW: "11" }, expect: { D: "10000000" } },
    ],
  });
  assert.equal(results[0].ok, true, results[0].detail);
  assert.equal(results[1].ok, false);
  assert.match(results[1].detail, /opposite levels/);
  // And the default state — every enable off — is the bus message, not "tie
  // it to GND", which on a bus would start the very fight above.
  const v = verifyBuild(out, { ...spec, tests: null });
  const off = v.faults.find((x) => x.code === "OUTPUTS_DISABLED");
  assert.match(off.message, /every output on it is switched off/);
});

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

// The compiler's acceptance test: a coordinate-free spec in, a circuit that
// the real engine agrees works out.
//
// The two specs here describe exactly the circuits engine-adder.test.js and
// engine-counter-display.test.js build BY HAND. Those fixtures prove the
// circuits are sound; this proves the compiler can derive them from a
// description with no geometry in it — which is the whole bet the AI feature
// rests on. The hand-built layouts are deliberately NOT the target: what must
// match is the behaviour, not the hole assignments.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L } from "../sim/levels.js";
import { settle, tick as engineTick } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { isLit, junctionState } from "../sim/junction.js";
import { normalizeDocument } from "../model/desk-doc.js";
import { partPinAddresses } from "../model/occupancy.js";
import { compileNetlist } from "../model/autobuild.js";

// ── Specs ───────────────────────────────────────────────────────────────────

/** Eight bits of operand, switch-selected and pulled down when open. */
function operandNets(sw, rn, prefix, pinOf) {
  const nets = [
    // Every position's B side is tied high; a CLOSED switch then pulls its A
    // side high, and the resistor network holds an OPEN one low.
    {
      name: `${prefix}_SRC`,
      members: [...Array(8)].map((_, i) => `${sw}.${i + 1}B`).concat("VCC"),
    },
    { name: `${prefix}_PULLDOWN`, members: [`${rn}.COM`, "GND"] },
  ];
  for (let i = 0; i < 8; i++) {
    nets.push({
      name: `${prefix}${i}`,
      members: [`${sw}.${i + 1}A`, `${rn}.${i + 1}`, pinOf(i)],
    });
  }
  return nets;
}

const ADDER_SPEC = {
  title: "8-bit adder with carry",
  parts: [
    { id: "U1", ref: "74LS283", label: "low nibble" },
    { id: "U2", ref: "74LS283", label: "high nibble" },
    { id: "SWA", ref: "sw-dip8" },
    { id: "SWB", ref: "sw-dip8" },
    { id: "RNA", ref: "rnet9" },
    { id: "RNB", ref: "rnet9" },
  ],
  nets: [
    { name: "CIN", members: ["U1.C0", "GND"] },
    { name: "CARRY", members: ["U1.C4", "U2.C0"] },
    ...operandNets(
      "SWA",
      "RNA",
      "A",
      (i) => `U${i < 4 ? 1 : 2}.A${(i % 4) + 1}`,
    ),
    ...operandNets(
      "SWB",
      "RNB",
      "B",
      (i) => `U${i < 4 ? 1 : 2}.B${(i % 4) + 1}`,
    ),
  ],
};

const COUNTER_SPEC = {
  title: "4-bit counter on an LED bar",
  parts: [
    { id: "CTR", ref: "74LS161" },
    { id: "BAR", ref: "bar8" },
    { id: "CLK", ref: "clock" },
  ],
  nets: [
    // Active-low clear and load held inactive; both count enables asserted.
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
    // Straight to ground in the SPEC — the compiler is what must notice this
    // needs a series resistor and interpose one.
    { name: "BARGND", members: ["BAR.K", "GND"] },
  ],
};

// ── Harness ─────────────────────────────────────────────────────────────────

/** Compile, load, and assert the loader kept everything the compiler emitted. */
function build(spec) {
  const out = compileNetlist(spec);
  assert.equal(
    out.ok,
    true,
    out.ok ? "" : out.errors?.map((e) => `${e.code}: ${e.message}`).join("; "),
  );
  const doc = normalizeDocument(out.document);
  assert.equal(doc.boards.length, out.document.boards.length, "boards kept");
  assert.equal(
    doc.components.length,
    out.document.components.length,
    "components kept",
  );
  assert.equal(doc.wires.length, out.document.wires.length, "wires kept");
  return { out, doc, netlist: buildNetlist(doc) };
}

/** Address of a compiled part's pin, via the document's own geometry. */
function pinAddress(doc, compId, pin) {
  const comp = doc.components.find((c) => c.id === compId);
  const pins = partPinAddresses(doc, comp);
  return pins?.find((p) => p.pin === pin)?.address ?? null;
}

// ── The adder ───────────────────────────────────────────────────────────────

test("the adder spec compiles into a circuit that settles clean", () => {
  const { out, doc, netlist } = build(ADDER_SPEC);
  const r = settle({ document: doc, netlist });
  assert.equal(r.settled, true);
  assert.deepEqual(r.warnings, [], "no shorts, conflicts or oscillation");
  for (const id of [out.partMap.get("U1"), out.partMap.get("U2")]) {
    assert.equal(r.chipStatus.get(id)?.status, "ok", `${id} powered`);
  }
});

test("the compiled adder computes A + B with carry", () => {
  const S = [4, 1, 13, 10]; // 74LS283 S1..S4, LSB first
  const C4 = 9;

  for (const [a, b] of [
    [0, 0],
    [1, 1],
    [15, 1],
    [181, 78],
    [200, 100],
    [255, 255],
  ]) {
    const { out, doc, netlist } = build(ADDER_SPEC);
    // Set the operands on the compiled switch banks — the spec never mentions
    // switch STATE, so this is the caller driving inputs, exactly as the L7
    // functional-test runner will.
    for (const [specId, value] of [
      ["SWA", a],
      ["SWB", b],
    ]) {
      const comp = doc.components.find((c) => c.id === out.partMap.get(specId));
      comp.params.states = [...Array(8)].map(
        (_, i) => ((value >> i) & 1) === 1,
      );
    }
    const live = buildNetlist(doc);
    const r = settle({ document: doc, netlist: live });
    const level = (addr) => r.netLevels.get(live.netOfPoint.get(addr));

    let sum = 0;
    for (let i = 0; i < 8; i++) {
      const compId = out.partMap.get(i < 4 ? "U1" : "U2");
      const addr = pinAddress(doc, compId, S[i % 4]);
      const lv = level(addr);
      assert.ok(lv === H || lv === L, `S${i} driven for ${a}+${b}`);
      if (lv === H) sum |= 1 << i;
    }
    assert.equal(sum, (a + b) & 0xff, `${a} + ${b}`);
    assert.equal(
      level(pinAddress(doc, out.partMap.get("U2"), C4)) === H,
      a + b > 0xff,
      `${a} + ${b} carry`,
    );
    void netlist;
  }
});

// ── The counter, and the resistor the compiler had to add ───────────────────

test("the counter spec compiles and the compiler interposes a resistor", () => {
  const { out, doc } = build(COUNTER_SPEC);
  assert.equal(
    out.interposed.length,
    1,
    "one resistor, for the bar's common leg",
  );
  assert.ok(
    out.warnings.some((w) => w.code === "RESISTOR_INSERTED"),
    "and it says so",
  );
  // It is a real part in the document, not just a warning.
  const resistors = doc.components.filter((c) => c.ref === "resistor");
  assert.equal(resistors.length, 1);
});

test("the compiled counter counts, and its bars LIGHT rather than burn", () => {
  const { out, doc, netlist } = build(COUNTER_SPEC);
  const ctr = out.partMap.get("CTR");
  const bar = out.partMap.get("BAR");
  const clk = out.partMap.get("CLK");

  const state = { warm: new Map(), st: new Map(), prev: new Map() };
  const phase = new Map([[clk, L]]);
  let last;
  const step = () => {
    last = engineTick({
      document: doc,
      netlist,
      warmStart: state.warm,
      state: state.st,
      prevPinLevels: state.prev,
      clockPhase: phase,
    });
    state.warm = last.netLevels;
    state.st = last.state;
    state.prev = last.pinLevels;
  };
  const rise = () => {
    phase.set(clk, L);
    step();
    phase.set(clk, H);
    step();
  };
  step();

  const level = (a) => last.netLevels.get(netlist.netOfPoint.get(a));
  const strong = (a) => last.strongLevels.get(netlist.netOfPoint.get(a));
  const segment = (i) => {
    const anode = pinAddress(doc, bar, i);
    const cathode = pinAddress(doc, bar, 9);
    return junctionState({
      anode: level(anode),
      cathode: level(cathode),
      anodeStrong: strong(anode),
      cathodeStrong: strong(cathode),
    });
  };
  const Q = [14, 13, 12, 11];
  const count = () =>
    Q.reduce(
      (n, p, i) => n | (level(pinAddress(doc, ctr, p)) === H ? 1 << i : 0),
      0,
    );

  assert.equal(last.settled, true);
  assert.deepEqual(last.warnings, []);
  assert.equal(count(), 0, "starts cleared");

  for (let n = 1; n <= 16; n++) {
    rise();
    assert.equal(count(), n % 16, `after rise ${n}`);
    for (let i = 0; i < 4; i++) {
      const shouldLight = ((n % 16) >> i) & 1;
      const seg = segment(i + 1);
      assert.equal(
        isLit(seg),
        Boolean(shouldLight),
        `count ${n % 16}: bar ${i + 1}`,
      );
      assert.equal(seg.unlimited, false, `bar ${i + 1} is current-limited`);
    }
  }
});

// ── Fail-closed: the spec's own mistakes ────────────────────────────────────

const fails = (spec, code) => {
  const out = compileNetlist(spec);
  assert.equal(out.ok, false, `expected ${code}`);
  assert.ok(
    out.errors.some((e) => e.code === code),
    `expected ${code}, got ${out.errors.map((e) => e.code).join(", ")}`,
  );
  return out.errors;
};

test("an unknown part or pin is reported against its spec path", () => {
  const errs = fails(
    {
      parts: [{ id: "U1", ref: "74LS999" }],
      nets: [{ name: "N", members: ["U1.A", "GND"] }],
    },
    "UNKNOWN_REF",
  );
  assert.equal(errs[0].path, "parts[0]");

  fails(
    {
      parts: [{ id: "U1", ref: "74LS283" }],
      nets: [{ name: "N", members: ["U1.S0", "GND"] }],
    },
    "UNKNOWN_PIN",
  );
  fails(
    {
      parts: [{ id: "U1", ref: "74LS283" }],
      nets: [{ name: "N", members: ["U9.S1", "GND"] }],
    },
    "UNKNOWN_PART",
  );
});

test("a pin in two nets is a modelling mistake, not a merge", () => {
  fails(
    {
      parts: [{ id: "U1", ref: "74LS283" }],
      nets: [
        { name: "N1", members: ["U1.A1", "GND"] },
        { name: "N2", members: ["U1.A1", "VCC"] },
      ],
    },
    "PIN_IN_TWO_NETS",
  );
});

test("two outputs on one net is caught before the engine sees it", () => {
  fails(
    {
      parts: [
        { id: "U1", ref: "74LS283" },
        { id: "U2", ref: "74LS283" },
      ],
      nets: [{ name: "CLASH", members: ["U1.S1", "U2.S1"] }],
    },
    "MULTIPLE_DRIVERS",
  );
});

test("a net joining the rails, or with one member, is rejected", () => {
  fails(
    {
      parts: [{ id: "U1", ref: "74LS283" }],
      nets: [{ name: "SHORT", members: ["VCC", "GND", "U1.A1"] }],
    },
    "NET_SHORTS_RAILS",
  );
  fails(
    {
      parts: [{ id: "U1", ref: "74LS283" }],
      nets: [{ name: "LONELY", members: ["U1.A1"] }],
    },
    "NET_TOO_SMALL",
  );
});

test("a design too big for the boards fails loudly rather than half-built", () => {
  // Far more DIP-40s than any number of kits the planner will mint.
  const parts = [...Array(40)].map((_, i) => ({ id: `U${i}`, ref: "w65c02" }));
  const out = compileNetlist({
    parts,
    nets: [{ name: "N", members: ["U0.RDY", "U1.RDY"] }],
  });
  // Either it fits (more kits) or it says it cannot — never a partial document.
  if (!out.ok) {
    assert.ok(out.errors.some((e) => e.code === "NO_ROOM"));
  } else {
    assert.equal(
      out.document.components.filter((c) => c.kind === "chip").length,
      40,
    );
  }
});

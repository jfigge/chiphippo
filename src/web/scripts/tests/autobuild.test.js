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
import { holePosition, nodeOf, parseAddress } from "../model/breadboard.js";
import { partDef } from "../catalog/index.js";
import { wireCrossings } from "../model/wire-crossing.js";
import { compileNetlist, designClipOf, wrapText } from "../model/autobuild.js";

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

const DECODER_SPEC = {
  title: "3-to-8 decoder, switched in, LEDs out",
  parts: [
    { id: "U1", ref: "74LS138" },
    { id: "SW", ref: "sw-dip4" },
    ...[...Array(8)].map((_, i) => ({ id: `D${i + 1}`, ref: "led" })),
  ],
  nets: [
    {
      name: "SRC",
      members: [...Array(4)].map((_, i) => `SW.${i + 1}B`).concat("VCC"),
    },
    { name: "A", members: ["SW.1A", "U1.A"] },
    { name: "B", members: ["SW.2A", "U1.B"] },
    { name: "C", members: ["SW.3A", "U1.C"] },
    { name: "G1", members: ["U1.G1", "VCC"] },
    { name: "G2", members: ["U1.G2A", "U1.G2B", "GND"] },
    // Active-low outputs, so each LED hangs from VCC down to its pin.
    ...[...Array(8)].map((_, i) => ({
      name: `LA${i}`,
      members: [`D${i + 1}.A`, "VCC"],
    })),
    ...[...Array(8)].map((_, i) => ({
      name: `LK${i}`,
      members: [`D${i + 1}.K`, `U1.Y${i}`],
    })),
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

// ── Supplies ────────────────────────────────────────────────────────────────
//
// The system prompt offers TWO ways to say "this net is the supply" — the
// reserved net NAME and the member token — and a model reaches for the name.
// Honouring only the token used to fail two ways, and the quiet one was worse:
// a wide power net was refused outright, while a narrow one compiled into an
// island of pins wired to each other and to no supply, which loads, settles and
// passes the declared-vs-derived gate while doing nothing at all.

/** The net id every one of `points` must share, asserted to be exactly one. */
function oneNetAcross(netlist, points) {
  const ids = new Set(points.map((p) => netlist.netOfPoint.get(p)));
  assert.equal(ids.size, 1, `expected one net, got ${[...ids].join(", ")}`);
  return [...ids][0];
}

for (const [form, netName, extra] of [
  ["as a net NAME", "VCC", []],
  ["as a member token", "A_SRC", ["VCC"]],
]) {
  test(`a supply reaches the rail ${form}`, () => {
    const bits = ["1B", "2B", "3B", "4B", "5B", "6B", "7B", "8B"];
    const { out, doc, netlist } = build({
      parts: [
        { id: "U1", ref: "74LS283" },
        { id: "SW", ref: "sw-dip8" },
      ],
      nets: [
        {
          name: netName,
          members: [...bits.map((b) => `SW.${b}`), ...extra],
        },
      ],
    });
    // Every switch pin must land on the SAME net as the PSU's + terminal —
    // not merely on the same net as each other.
    const sw = out.partMap.get("SW");
    const points = bits.map((_, i) => pinAddress(doc, sw, 16 - i));
    assert.ok(
      points.every(Boolean),
      "every switch B pin has a resolved address",
    );
    const net = oneNetAcross(netlist, [...points, "psu1.+"]);
    assert.ok(net, "the switch commons share the PSU's net");

    // …and it is really at +5 V, not just joined up.
    const r = settle({ document: doc, netlist });
    assert.equal(r.settled, true);
    assert.equal(r.netLevels.get(net), H, "the supply net is HIGH");
  });
}

test("the supply spans every bridged rail strip, not just the first", () => {
  // Three switch banks want 24 taps on +5 V. One rail strip's line holds 25
  // holes, and by then the PSU and the bridges have taken some — so drawing
  // every tap from the FIRST strip ran dry with an identical, already-bridged
  // 25 sitting empty on the strip below. It used to fail as NO_FREE_HOLE.
  const A = ["1A", "2A", "3A", "4A", "5A", "6A", "7A", "8A"];
  const { doc, netlist } = build({
    parts: [
      { id: "S1", ref: "sw-dip8" },
      { id: "S2", ref: "sw-dip8" },
      { id: "S3", ref: "sw-dip8" },
    ],
    nets: [
      {
        name: "VCC",
        members: ["S1", "S2", "S3"].flatMap((s) => A.map((p) => `${s}.${p}`)),
      },
    ],
  });

  // It really did spill onto a second strip…
  const strips = new Set();
  for (const w of doc.wires) {
    for (const a of [w.from, w.to]) {
      const m = /^(bb\d+)\.\+/.exec(a);
      if (m) strips.add(m[1]);
    }
  }
  assert.ok(strips.size > 1, `+ taps landed on one strip only: ${[...strips]}`);

  // …and the bridges mean that is still ONE supply, at +5 V. A rail the
  // compiler forgot to bridge would show up right here as a second net.
  const taps = [];
  for (const c of doc.components.filter((x) => x.ref === "sw-dip8")) {
    for (const p of partPinAddresses(doc, c)) {
      if (p.pin <= 8) taps.push(p.address);
    }
  }
  assert.equal(taps.length, 24);
  const net = oneNetAcross(netlist, [...taps, "psu1.+"]);
  const r = settle({ document: doc, netlist });
  assert.equal(r.settled, true);
  assert.equal(r.netLevels.get(net), H, "the pooled supply is HIGH");
});

test("a net named for one rail cannot also carry the other", () => {
  fails(
    {
      parts: [{ id: "U1", ref: "74LS283" }],
      nets: [{ name: "VCC", members: ["U1.A1", "GND"] }],
    },
    "NET_SHORTS_RAILS",
  );
});

test("listing a power pin is refused, not silently wired twice", () => {
  const errs = fails(
    {
      parts: [{ id: "U1", ref: "74LS283" }],
      nets: [{ name: "PWR", members: ["U1.VCC", "VCC"] }],
    },
    "POWER_PIN_LISTED",
  );
  assert.equal(errs[0].path, "nets[0].members[0]");
  assert.equal(errs[0].kind, "repair", "the spec's own mistake to fix");

  // 74LS83 puts VCC on 5 and GND on 12 — the check is by ROLE, so a chip with
  // non-standard power pins is caught with no special-casing.
  fails(
    {
      parts: [{ id: "U1", ref: "74LS83" }],
      nets: [{ name: "PWR", members: ["U1.#12", "GND"] }],
    },
    "POWER_PIN_LISTED",
  );

  // A BRICK's `gnd` is a terminal, not a role-bearing pin, and stays listable:
  // nothing powers a clock source but the netlist.
  const out = compileNetlist({
    parts: [
      { id: "CTR", ref: "74LS161" },
      { id: "CLK", ref: "clock" },
    ],
    nets: [
      { name: "CLOCK", members: ["CLK.out", "CTR.CLK"] },
      { name: "CLKGND", members: ["CLK.gnd", "GND"] },
    ],
  });
  assert.equal(out.ok, true);
});

// ── Fan-out ─────────────────────────────────────────────────────────────────

test("a net wider than one node's spare holes chains instead of refusing", () => {
  // One clock line to eight counters. A column-half holds five holes, one spent
  // on the pin itself, so a star from any of them tops out at four spokes —
  // this net has eight, and no rail to hang them on.
  const parts = [{ id: "CLK", ref: "clock" }];
  const members = ["CLK.out"];
  for (let i = 1; i <= 8; i++) {
    parts.push({ id: `U${i}`, ref: "74LS161" });
    members.push(`U${i}.CLK`);
  }
  const { out, doc, netlist } = build({
    parts,
    nets: [
      { name: "CLOCK", members },
      { name: "CLKGND", members: ["CLK.gnd", "GND"] },
    ],
  });

  const clkPins = [...Array(8)].map((_, i) =>
    pinAddress(doc, out.partMap.get(`U${i + 1}`), 2),
  );
  oneNetAcross(netlist, [...clkPins, `${out.partMap.get("CLK")}.out`]);
});

test("points that hold one lead each cannot all be joined, and it aborts", () => {
  // Three clock sources on one net: a brick terminal is exactly one point, so
  // there is nothing with room to hop through. The model has no lever on that —
  // it never chose a hole — so this must not go back to it as a repair.
  const out = compileNetlist({
    parts: [
      { id: "C1", ref: "clock" },
      { id: "C2", ref: "clock" },
      { id: "C3", ref: "clock" },
    ],
    nets: [{ name: "N", members: ["C1.gnd", "C2.gnd", "C3.gnd"] }],
  });
  assert.equal(out.ok, false);
  assert.equal(out.errors[0].code, "FANOUT_TOO_WIDE");
  assert.equal(out.errors[0].kind, "abort");
});

test("a geometry refusal aborts; a spec mistake goes back for repair", () => {
  // The split the panel's retry loop reads. Getting it wrong is not cosmetic:
  // a geometry fault sent back as a repair burns every remaining round on an
  // answer the model cannot change, then gives up.
  const spec = (nets, parts) => compileNetlist({ parts, nets });

  const repairs = [
    [
      [{ name: "N", members: ["U1.S0", "GND"] }],
      [{ id: "U1", ref: "74LS283" }],
    ],
    [
      [{ name: "N", members: ["U1.S1", "U2.S1"] }],
      [
        { id: "U1", ref: "74LS283" },
        { id: "U2", ref: "74LS283" },
      ],
    ],
    [[{ name: "N", members: ["U1.A1"] }], [{ id: "U1", ref: "74LS283" }]],
  ];
  for (const [nets, parts] of repairs) {
    const out = spec(nets, parts);
    assert.equal(out.ok, false);
    for (const e of out.errors) {
      assert.equal(e.kind, "repair", `${e.code} is the spec's to fix`);
    }
  }

  const big = [...Array(40)].map((_, i) => ({ id: `U${i}`, ref: "w65c02" }));
  const out = spec([{ name: "N", members: ["U0.RDY", "U1.RDY"] }], big);
  if (!out.ok) {
    for (const e of out.errors) assert.equal(e.kind, "abort");
  }
});

// ── The pull rule ───────────────────────────────────────────────────────────
//
// A switch is a CONTACT, not a source. The failure this guards against is the
// quiet one: a design that compiles, seats, settles, and then does nothing when
// you flip a switch, because the input it feeds was floating half the time and
// a floating TTL input already reads HIGH.

// 74LS04 input pin NUMBERS, in order: its pins alternate input/output, so a
// reader that walked 1..4 would sample three outputs and call the circuit
// broken. The netlist below names them (`1A`…`4A`); only address lookups,
// which are by number, need this.
const INV_IN = [1, 3, 5, 9];

/** One `sw-dip4` position per gate input, tied to `rail` on its far side. */
function switchedInputs(rail, count = 4) {
  const nets = [
    {
      name: "SRC",
      members: [...Array(count)].map((_, i) => `SW.${i + 1}B`).concat(rail),
    },
  ];
  for (let i = 0; i < count; i++) {
    nets.push({ name: `IN${i}`, members: [`SW.${i + 1}A`, `U1.${i + 1}A`] });
  }
  return {
    parts: [
      { id: "U1", ref: "74LS04" },
      { id: "SW", ref: "sw-dip4" },
    ],
    nets,
  };
}

test("a switched input is pulled to the far rail's opposite, so it is never floating", () => {
  const { out, doc, netlist } = build(switchedInputs("VCC"));
  assert.ok(
    out.warnings.some((w) => w.code === "PULL_INSERTED"),
    "the insertion is reported, not silent",
  );
  // Four pulls to one rail come as ONE bussed pack, the way a person builds it.
  const added = doc.components.filter((c) => c.ref === "rnet9");
  assert.equal(added.length, 1, "one resistor network, not four resistors");

  const r = settle({ document: doc, netlist });
  assert.deepEqual(r.warnings, [], "the pull never fights the supply");
  for (let i = 0; i < 4; i++) {
    const a = pinAddress(doc, out.partMap.get("U1"), INV_IN[i]);
    assert.equal(
      r.netLevels.get(netlist.netOfPoint.get(a)),
      L,
      `input ${i} is held LOW while its switch is open`,
    );
  }
});

test("closing a pulled switch still wins — a supply beats a resistor", () => {
  const { out, doc } = build(switchedInputs("VCC"));
  const sw = doc.components.find((c) => c.id === out.partMap.get("SW"));
  sw.params = { ...sw.params, states: [true, false, true, false] };
  const netlist = buildNetlist(doc);
  const r = settle({ document: doc, netlist });
  const level = (i) =>
    r.netLevels.get(
      netlist.netOfPoint.get(pinAddress(doc, out.partMap.get("U1"), INV_IN[i])),
    );
  assert.deepEqual([level(0), level(1), level(2), level(3)], [H, L, H, L]);
});

test("a GND-side switch gets a pull-UP, because the rail is read not assumed", () => {
  // The whole reason the far side is inspected: guessing "pull-down" here would
  // hold every input LOW and the switch would do nothing.
  const { out, doc, netlist } = build(switchedInputs("GND"));
  assert.equal(doc.components.filter((c) => c.ref === "rnet9").length, 1);
  const r = settle({ document: doc, netlist });
  for (let i = 0; i < 4; i++) {
    const a = pinAddress(doc, out.partMap.get("U1"), INV_IN[i]);
    assert.equal(r.netLevels.get(netlist.netOfPoint.get(a)), H, `input ${i}`);
  }
});

test("a lone pull is a resistor, not nine columns of resistor network", () => {
  const { doc } = build(switchedInputs("VCC", 1));
  assert.equal(doc.components.filter((c) => c.ref === "rnet9").length, 0);
  assert.equal(doc.components.filter((c) => c.ref === "resistor").length, 1);
});

test("a spec that brought its own pull-downs does not get a second set", () => {
  // ADDER_SPEC wires two rnet9 packs itself. Adding parallel pulls would be
  // harmless electrically and wrong in every other way — extra parts, extra
  // columns, and a circuit that no longer matches what was asked for.
  const { out, doc } = build(ADDER_SPEC);
  assert.equal(
    doc.components.filter((c) => c.ref === "rnet9").length,
    2,
    "the two the spec declared, and no more",
  );
  assert.ok(!out.warnings.some((w) => w.code === "PULL_INSERTED"));
});

test("a driven net is never pulled — a switch is not the only thing on a wire", () => {
  const out = compileNetlist({
    parts: [
      { id: "U1", ref: "74LS04" },
      { id: "SW", ref: "sw-dip1" },
    ],
    nets: [
      { name: "SRC", members: ["SW.1B", "VCC"] },
      // U1.1Y drives this net; the switch merely joins it to the supply, which
      // is a bad idea but the SPEC's bad idea, and L5 reports it as a short.
      { name: "OUT", members: ["SW.1A", "U1.1Y", "U1.2A"] },
    ],
  });
  assert.equal(out.ok, true);
  assert.ok(!out.warnings.some((w) => w.code === "PULL_INSERTED"));
});

test("a switch reaching no rail is left alone, for L6 to report", () => {
  // Two switches in series reach a supply through nothing the compiler can see.
  // Guessing a rail here would invent an intent the spec never stated.
  const out = compileNetlist({
    parts: [
      { id: "U1", ref: "74LS04" },
      { id: "SW", ref: "sw-dip2" },
    ],
    nets: [
      { name: "MID", members: ["SW.1A", "SW.2B"] },
      { name: "IN", members: ["SW.2A", "U1.1A"] },
    ],
  });
  assert.equal(out.ok, true);
  assert.ok(!out.warnings.some((w) => w.code === "PULL_INSERTED"));
});

// ── Placement ───────────────────────────────────────────────────────────────
//
// The layout used to follow whatever order the spec listed parts in, with the
// compiler's own interposed resistors appended last — so a pull-down array
// serving one switch bank was seated as far from that bank as the board
// allowed, and once a board filled, onto the NEXT board entirely. The 8-bit
// adder came out on two breadboards with fifteen wires crossing between them.
// Nothing was wrong with it; nobody had thought about it.

/** Eight switched inputs into one chip — the shape every bench demo has. */
const SWITCHED_BANK = {
  title: "a switch bank feeding a buffer",
  parts: [
    { id: "U1", ref: "74LS244" },
    { id: "SW", ref: "sw-dip8" },
  ],
  nets: [
    {
      name: "SRC",
      members: [...Array(8)].map((_, i) => `SW.${i + 1}B`).concat("VCC"),
    },
    { name: "OE", members: ["U1.1G", "U1.2G", "GND"] },
    ...[2, 4, 6, 8, 11, 13, 15, 17].map((pin, i) => ({
      name: `A${i}`,
      members: [`SW.${i + 1}A`, `U1.#${pin}`],
    })),
  ],
};

test("a pull pack seats UNDER the switch it pulls, sharing its columns", () => {
  const { doc, netlist } = build(SWITCHED_BANK);
  const sw = doc.components.find((c) => c.ref === "sw-dip8");
  const rn = doc.components.find((c) => c.ref === "rnet9");
  assert.ok(rn, "the compiler put a bussed pull-down in");
  assert.equal(rn.board, sw.board, "on the same board");
  assert.equal(
    rn.anchor.slice(1),
    sw.anchor.slice(1),
    "and in the very same columns",
  );
  assert.match(
    rn.anchor,
    /^a/,
    "in the bottom row, clear of the switch's pins",
  );

  // The claim that makes it legal: pin for pin, the board already joins them,
  // so the eight pull-downs cost zero wires. Node sharing is normally the
  // exact disaster column-allocator.js exists to prevent, which is why this is
  // asserted rather than assumed.
  for (let k = 1; k <= 8; k++) {
    assert.equal(
      netlist.netOfPoint.get(pinAddress(doc, rn.id, k)),
      netlist.netOfPoint.get(pinAddress(doc, sw.id, k)),
      `pack pin ${k} IS switch pin ${k}'s node`,
    );
  }
});

test("the whole 8-bit adder now fits on ONE breadboard", () => {
  // The user-visible outcome: two kits and fifteen cross-board wires became
  // one kit. Twenty columns come back from the two pull packs, which is the
  // difference between not fitting and fitting with room to spare.
  const { doc } = build(ADDER_SPEC);
  const pinBoards = doc.boards.filter((b) => b.type.startsWith("pins"));
  assert.equal(pinBoards.length, 1, "one pin-board");
  assert.ok(
    doc.boards.every((b) => b.y < 22),
    "and one kit — nothing spilled onto a second",
  );
});

test("a net's parts land next to each other, not in the order they were listed", () => {
  // Connectivity ordering. The spec below lists the two halves interleaved on
  // purpose; a compiler seating in spec order would alternate them across the
  // board and wire every net the long way round.
  const spec = {
    parts: [
      { id: "A1", ref: "74LS04" },
      { id: "B1", ref: "74LS08" },
      { id: "A2", ref: "74LS04" },
      { id: "B2", ref: "74LS08" },
    ],
    nets: [
      { name: "A", members: ["A1.1Y", "A2.1A"] },
      { name: "B", members: ["B1.1Y", "B2.1A"] },
      { name: "A_", members: ["A1.2Y", "A2.2A"] },
      { name: "B_", members: ["B1.2Y", "B2.2A"] },
    ],
  };
  const { doc } = build(spec);
  const col = (ref, nth) => {
    const comp = doc.components.filter((c) => c.ref === ref)[nth];
    return Number(comp.anchor.replace(/^\D+/, ""));
  };
  // The two '04s share two nets, as do the two '08s. Each pair should be
  // adjacent — so one pair sits entirely left of the other.
  const inv = [col("74LS04", 0), col("74LS04", 1)].sort((a, b) => a - b);
  const and = [col("74LS08", 0), col("74LS08", 1)].sort((a, b) => a - b);
  assert.ok(
    inv[1] < and[0] || and[1] < inv[0],
    `pairs are interleaved: '04 at ${inv}, '08 at ${and}`,
  );
});

test("the PSU taps the near end of the rail, not the far one", () => {
  // A rail is one node end to end, so which hole the brick reaches for is free
  // to choose — and reaching for hole 1 ran both supply leads the full width
  // of the desk, which is the longest wire in most builds.
  const { doc } = build(SWITCHED_BANK);
  const psu = doc.components.find((c) => c.kind === "psu");
  const leads = doc.wires.filter((w) => w.from.startsWith(`${psu.id}.`));
  assert.equal(leads.length, 2, "+ and −");
  // Stated as "further along than anything else on that rail" rather than as a
  // hole number: a half kit's rail is 25 holes and a full one's is 50, so any
  // constant here would only be right for one board size.
  const index = (address) => Number(address.replace(/^.*[+-]/, ""));
  for (const lead of leads) {
    const [, rail, polarity] = /^(.*)\.([+-])/.exec(lead.to);
    const others = doc.wires
      .filter((w) => w !== lead)
      .flatMap((w) => [w.from, w.to])
      .filter((a) => a.startsWith(`${rail}.${polarity}`))
      .map(index);
    assert.ok(
      others.every((n) => n < index(lead.to)),
      `${lead.to} sits past every other tap on that line (${others})`,
    );
  }
});

// ── Not crossing things ─────────────────────────────────────────────────────

/** Every wire that runs over a part it does not terminate on. */
function crossingsOf(doc) {
  const boards = new Map(doc.boards.map((b) => [b.id, b]));
  const comps = new Map(doc.components.map((c) => [c.id, c]));
  const world = (address) => {
    const p = parseAddress(address);
    if (!p) return null;
    const b = boards.get(p.boardId);
    if (b) {
      const h = holePosition(b.type, p.hole, b.rot ?? 0);
      return h && { x: b.x + h.x, y: b.y + h.y };
    }
    const c = comps.get(p.boardId);
    const t = partDef(c?.ref)?.terminals?.find((q) => q.id === p.hole);
    return t && { x: c.x + t.dx, y: c.y + t.dy };
  };
  // Which part owns the NODE an address sits on — a lead leaving a part from
  // the row above its pins is attached to it, not flying over it.
  const owner = new Map();
  for (const c of doc.components) {
    if (!c.board) continue;
    const type = boards.get(c.board).type;
    for (const p of partPinAddresses(doc, c) ?? []) {
      if (!p.address) continue;
      const node = nodeOf(type, parseAddress(p.address).hole);
      if (node) owner.set(`${c.board}:${node}`, c.id);
    }
  }
  const ownerOf = (address) => {
    const p = parseAddress(address);
    const b = p && boards.get(p.boardId);
    if (!b) return null;
    const node = nodeOf(b.type, p.hole);
    return node ? (owner.get(`${p.boardId}:${node}`) ?? null) : null;
  };
  return wireCrossings(doc, world, (c) => partPinAddresses(doc, c), ownerOf);
}

test("wires stay OUT of the row the discretes sit in", () => {
  // The class the hole choice exists to fix. Every footprint part the compiler
  // seats — resistor networks, LED bars, single LEDs — lies along row a, and
  // "take the first free hole" took row a every time, so signal wires ran the
  // length of the board straight through them. Rows b, c and d are empty and
  // cost at most three pitch more.
  const { doc } = build(DECODER_SPEC);
  const inRowA = new Set(
    doc.components.filter((c) => c.anchor?.startsWith("a")).map((c) => c.id),
  );
  assert.ok(inRowA.size >= 8, "the bench really does have discretes on row a");
  const over = crossingsOf(doc).filter((c) => inRowA.has(c.part));
  assert.deepEqual(over, [], "nothing flies over a part seated on row a");
});

test("a supply lead takes the rail on its OWN side of the trench", () => {
  // A kit has a rail strip above the board and one below, bridged, so either
  // works electrically — and taking the first free hole on the first strip sent
  // every chip's ground lead up and over the chip to reach the far rail.
  const { out, doc } = build(DECODER_SPEC);
  const boards = new Map(doc.boards.map((b) => [b.id, b]));
  const yOf = (address) => {
    const p = parseAddress(address);
    const b = boards.get(p.boardId);
    return b.y + holePosition(b.type, p.hole, b.rot ?? 0).y;
  };
  const chip = doc.components.find((c) => c.id === out.partMap.get("U1"));
  const def = partDef(chip.ref);
  const rails = doc.boards.filter((b) => b.type.startsWith("rail"));
  assert.equal(rails.length, 2, "one strip above the board and one below");

  for (const role of ["vcc", "gnd"]) {
    const pin = def.pins.find((q) => q.role === role);
    const pinY = yOf(pinAddress(doc, chip.id, pin.n));
    const lead = doc.wires.find(
      (w) =>
        [w.from, w.to].some((a) => parseAddress(a).boardId === chip.board) &&
        [w.from, w.to].some((a) =>
          rails.some((r) => parseAddress(a).boardId === r.id),
        ) &&
        Math.abs(yOf(w.from) - pinY) < 5,
    );
    assert.ok(lead, `${role} is wired to a rail`);
    const railEnd = rails.some((r) => parseAddress(lead.from).boardId === r.id)
      ? lead.from
      : lead.to;
    const chosen = Math.abs(yOf(railEnd) - pinY);
    const other = rails.map((r) => Math.abs(r.y - pinY)).sort((a, b) => a - b);
    assert.ok(
      chosen <= other[1],
      `${role} reached the nearer rail (${chosen.toFixed(1)} vs ${other})`,
    );
  }
});

test("what could NOT be routed clear is reported, not hidden", () => {
  // A net joining a pin below the trench to one above has to get across, and
  // where both ends sit under a chip there is no clear column to cross in. A
  // straight run between two holes cannot go around the end of a chip the way
  // a hand would, so the honest thing is to say how many did not make it.
  const { out, doc } = build(ADDER_SPEC);
  const crossings = crossingsOf(doc);
  const warned = out.warnings.find((w) => w.code === "WIRES_CROSS_PARTS");
  if (crossings.length) {
    assert.ok(warned, "a residual crossing is warned about");
    assert.match(warned.message, /run over a part/);
  } else {
    assert.equal(warned, undefined, "and a clean layout says nothing");
  }
});

test("a board nothing landed on is given back, not shipped empty", () => {
  // How many kits a design needs cannot be known before it is placed: the
  // budget has to assume a pull pack costs nine columns, and companion seating
  // then costs it none. This adder — the AI-generated shape, where the compiler
  // inserts the pull-downs rather than the spec declaring them — was handed two
  // breadboards and used one, and the spare shipped empty with bridge wires
  // stitched across it.
  const bits = (sw) => [...Array(8)].map((_, i) => `${sw}.${i + 1}B`);
  const aPin = (i) => (i < 4 ? `U1.A${i + 1}` : `U2.A${i - 3}`);
  const bPin = (i) => (i < 4 ? `U1.B${i + 1}` : `U2.B${i - 3}`);
  const { doc } = build({
    title: "8-bit adder, switches in, LED bar out",
    parts: [
      { id: "U1", ref: "74LS283" },
      { id: "U2", ref: "74LS283" },
      { id: "SWA", ref: "sw-dip8" },
      { id: "SWB", ref: "sw-dip8" },
      { id: "D1", ref: "bar8" },
    ],
    nets: [
      { name: "VCCA", members: [...bits("SWA"), "VCC"] },
      { name: "VCCB", members: [...bits("SWB"), "VCC"] },
      { name: "CIN", members: ["U1.C0", "GND"] },
      { name: "CARRY", members: ["U1.C4", "U2.C0"] },
      ...[...Array(8)].map((_, i) => ({
        name: `A${i}`,
        members: [`SWA.${i + 1}A`, aPin(i)],
      })),
      ...[...Array(8)].map((_, i) => ({
        name: `B${i}`,
        members: [`SWB.${i + 1}A`, bPin(i)],
      })),
      ...[...Array(8)].map((_, i) => ({
        name: `S${i}`,
        members: [i < 4 ? `U1.S${i + 1}` : `U2.S${i - 3}`, `D1.${i + 1}`],
      })),
      { name: "BARK", members: ["D1.K", "GND"] },
    ],
  });
  const pinBoards = doc.boards.filter((b) => b.type.startsWith("pins"));
  assert.equal(pinBoards.length, 1, "one breadboard, not two");
  for (const board of pinBoards) {
    assert.ok(
      doc.components.some((c) => c.board === board.id),
      `${board.id} has something on it`,
    );
  }
  // And no wire may lead to a board that is no longer there.
  const ids = new Set(doc.boards.map((b) => b.id));
  for (const w of doc.wires) {
    for (const end of [w.from, w.to]) {
      const owner = parseAddress(end).boardId;
      assert.ok(
        ids.has(owner) || doc.components.some((c) => c.id === owner),
        `${end} points at something real`,
      );
    }
  }
});

// ── The design's own note ───────────────────────────────────────────────────

test("wrapText breaks a paragraph to the caption width", () => {
  // A label is `white-space: nowrap`, so what is written is what is drawn — a
  // paragraph handed over whole runs off the desk in a single line.
  const lines = wrapText("the quick brown fox jumps over the lazy dog", 12);
  assert.deepEqual(lines, [
    "the quick",
    "brown fox",
    "jumps over",
    "the lazy dog",
  ]);
  for (const line of lines) assert.ok(line.length <= 12, line);
  assert.deepEqual(wrapText("", 12), [], "nothing to wrap");
  assert.deepEqual(wrapText(null, 12), []);
  assert.deepEqual(wrapText("  spaced   out  ", 20), ["spaced out"]);
  // A word longer than the width overflows rather than being cut in half: a
  // part number split down the middle is worse than a ragged edge.
  assert.deepEqual(wrapText("a 74LS283ABCDEFGH b", 8), [
    "a",
    "74LS283ABCDEFGH",
    "b",
  ]);
});

test("a spec's notes become a caption above the circuit", () => {
  const notes =
    "A 74LS161 free-runs from the clock brick with clear, load and both " +
    "count enables tied high, so it counts continuously.";
  const { doc } = build({ ...COUNTER_SPEC, notes });
  const caption = doc.annotations;
  assert.ok(caption.length > 1, "a title line and a wrapped body");
  assert.equal(caption[0].text, COUNTER_SPEC.title, "the title leads");
  assert.equal(caption[0].color, undefined, "in the desk's own colour");
  assert.ok(
    caption.slice(1).every((a) => a.color),
    "the body is muted, so the block reads as a caption",
  );
  // Reassembling the body must give the paragraph back — a caption that drops
  // or reorders a line is worse than no caption.
  assert.equal(
    caption
      .slice(1)
      .map((a) => a.text)
      .join(" "),
    notes,
  );
  // Above the boards, and in reading order down the page.
  const ys = caption.map((a) => a.y);
  assert.ok(
    ys.every((y) => y < Math.min(...doc.boards.map((b) => b.y))),
    "clear of the top rail",
  );
  assert.deepEqual(
    ys,
    [...ys].sort((a, b) => a - b),
    "top to bottom",
  );
});

test("the note is ANCHORED, which is the only way it rides the design", () => {
  // `captureDesign` carries only anchored labels — a free-floating one belongs
  // to the desk it was written on, not to the design. A note explaining THIS
  // circuit is the design's, so it has to be pinned to a part of it.
  const { out, doc } = build({ ...COUNTER_SPEC, notes: "Counts up." });
  const seated = new Set(
    doc.components.filter((c) => c.board).map((c) => c.id),
  );
  assert.ok(doc.annotations.length, "there is a caption at all");
  for (const a of doc.annotations) {
    assert.ok(seated.has(a.anchor), `${a.id} is pinned to a seated part`);
  }
  const clip = designClipOf(doc);
  assert.equal(
    clip.annotations.length,
    doc.annotations.length,
    "and the whole caption rides the clip onto the desk",
  );
  void out;
});

test("a title alone still names the circuit; nothing at all says nothing", () => {
  const titled = build(COUNTER_SPEC).doc.annotations;
  assert.equal(titled.length, 1, "just the heading");
  assert.equal(titled[0].text, COUNTER_SPEC.title);

  const { title, ...untitled } = COUNTER_SPEC;
  void title;
  assert.deepEqual(
    build(untitled).doc.annotations,
    [],
    "a spec with neither gets no caption rather than an empty one",
  );

  // The prompt asks for one paragraph. If it gets an essay, the caption is
  // capped rather than covering the circuit it is meant to explain.
  const essay = "word ".repeat(600);
  const { doc } = build({ ...COUNTER_SPEC, notes: essay });
  assert.ok(doc.annotations.length <= 30, `${doc.annotations.length} lines`);
  // And the trim SAYS SO — a caption that stops mid-clause reads as a note
  // written badly rather than one that was cut.
  assert.ok(
    doc.annotations.at(-1).text.endsWith("…"),
    "the cap marks what it dropped",
  );
});

test("a full-length note is not truncated", () => {
  // The regression this guards: the caption used to fit ~500 characters, so a
  // note of the length the prompt asks for was cut off mid-sentence, silently.
  const notes =
    "This is a holding port for one byte: the eight input lines IN0-IN7 " +
    "come from DIP switch SW1, each closed position pulling its line HIGH " +
    "while the compiler's pull-downs hold the open ones LOW, and they are " +
    "shown on the INBAR lamp row so you can see what is presently on the " +
    "incoming bus. U1, a 74LS273 octal D flip-flop, watches those eight " +
    "lines continuously but only stores them on a rising clock edge, and " +
    "that edge is gated by U4, a 74LS11 3-input AND whose other two inputs " +
    "are the write-enable and the chip-select, so nothing is captured until " +
    "the byte is actually addressed. The stored byte drives the OUTBAR row " +
    "through U2 and U3, a pair of 74LS08 buffers, so the captured value " +
    "stays visible after the switches have moved on. CLR is tied HIGH " +
    "because a reset line left floating would read HIGH anyway, and a tie " +
    "says so deliberately.";
  assert.ok(notes.length > 800, `${notes.length} characters`);
  const { doc } = build({ ...COUNTER_SPEC, notes });
  const caption = doc.annotations;
  assert.equal(caption[0].text, COUNTER_SPEC.title, "the title still leads");
  assert.equal(
    caption
      .slice(1)
      .map((a) => a.text)
      .join(" "),
    notes,
    "every word of it reaches the desk",
  );
});

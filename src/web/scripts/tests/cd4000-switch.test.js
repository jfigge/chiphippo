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

// The analog switches (Feature 410, phase 2b): the CD4066B and the
// CD4051B/52B/53B — and the CD4007UB, whose six MOSFETs are channels too —
// through the WHOLE engine: a channel joins two nets, so the thing under test
// is never the part alone but the circuit around it.
//
//   · an ON channel passes a level BOTH ways (a 4051 is a multiplexer and a
//     demultiplexer), an OFF one leaves each side to its own drivers (Z if it
//     has none), and an unpowered switch conducts nothing;
//   · every row of each part's datasheet table (SCHS051J, SCHS047O Table 7-1);
//   · a floating control or select might be either, so only what both
//     readings agree on stays known;
//   · a rail crossing a switch arrives at output strength — it fights an
//     output on the far side, and two rails joined through one are a short;
//   · VEE is a supply pin: the 405x runs only with it tied to VSS.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, Z, X } from "../sim/levels.js";
import { settle } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { chipDef } from "../catalog/index.js";
import { partPinHoles } from "../model/occupancy.js";
import { holesOfNode, nodeOf } from "../model/breadboard.js";

// ── A bench built in code ────────────────────────────────────────────────────

const boards = [
  { id: "bb2", type: "rail-full", x: 0, y: 0 },
  { id: "bb1", type: "pins-full", x: 0, y: 4 },
  { id: "bb3", type: "rail-full", x: 0, y: 18 },
];
let seq = 0;
const wire = (from, to) => ({ id: `w${++seq}`, from, to, color: "black" });
const psu = (id = "psu1") => ({
  id,
  kind: "psu",
  ref: "psu",
  x: 80,
  y: 30,
  params: { volts: 5 },
});
const chip = (id, ref, anchor) => ({
  id,
  kind: "chip",
  ref,
  board: "bb1",
  anchor,
  params: {},
});
const resistor = (id, anchor) => ({
  id,
  kind: "discrete",
  ref: "resistor",
  board: "bb1",
  anchor,
  params: {},
});
const holesOf = (ref, anchor) =>
  new Map(partPinHoles(ref, anchor).map(({ pin, hole }) => [pin, hole]));
/** The i-th free hole sharing `hole`'s column-half. */
const mate = (hole, i = 0) =>
  holesOfNode("pins-full", nodeOf("pins-full", hole)).filter((h) => h !== hole)[
    i
  ];

/**
 * One switch chip on the bench, and a helper per thing a test does to it:
 * `power` (every supply pin — VEE included unless told otherwise), `tie` a
 * pin to a rail, `at` read a pin's net. Each pin's node offers four free
 * holes, handed out in turn so no two leads collide.
 */
function bench(ref, anchor = "e10", id = "c1") {
  const def = chipDef(ref);
  const holes = holesOf(ref, anchor);
  const used = new Map(); // pin → holes handed out so far
  const free = (pin) => {
    const i = used.get(pin) ?? 0;
    used.set(pin, i + 1);
    return `bb1.${mate(holes.get(pin), i)}`;
  };
  return {
    comp: chip(id, ref, anchor),
    def,
    free,
    hole: (pin) => `bb1.${holes.get(pin)}`,
    power({ vee = "-" } = {}) {
      const wires = [];
      for (const p of def.pins) {
        if (p.role === "vcc") wires.push(wire("psu1.+", free(p.n)));
        if (p.role !== "gnd") continue;
        if (p.name === "VEE" && vee === null) continue;
        wires.push(wire(`psu1.${p.name === "VEE" ? vee : "-"}`, free(p.n)));
      }
      return wires;
    },
    tie: (pin, rail) => wire(`psu1.${rail}`, free(pin)),
  };
}

function run(doc) {
  const netlist = buildNetlist(doc);
  const result = settle({ document: doc, netlist });
  return {
    result,
    at: (address) => result.netLevels.get(netlist.netOfPoint.get(address)),
    warnings: (type) => result.warnings.filter((w) => w.type === type),
  };
}

// ── CD4066B ─────────────────────────────────────────────────────────────────

// Switch A: 1 ↔ 2, CONTROL A 13. B: 4 ↔ 3 (5). C: 8 ↔ 9 (6). D: 11 ↔ 10 (12).

/**
 * A 4066 desk: powered, switches B–D held open, CONTROL A on `ctlA` (a rail,
 * or null to leave it floating), plus whatever `extra` wires and `comps` the
 * test adds. `sw` is the test's own bench, so its holes are handed out fresh.
 */
function quad(sw, ctlA, extra = [], comps = []) {
  const wires = [...sw.power(), ...[5, 6, 12].map((p) => sw.tie(p, "-"))];
  if (ctlA) wires.push(sw.tie(13, ctlA));
  return {
    boards,
    components: [psu(), sw.comp, ...comps],
    wires: [...wires, ...extra],
  };
}

/** A CD4069UB inverter at e30 whose gate 1 (1 → 2) drives `level`'s opposite. */
function inverter(input) {
  const inv = bench("CD4069UB", "e30", "c2");
  const wires = [
    ...inv.power(),
    inv.tie(1, input),
    ...[3, 5, 9, 11, 13].map((p) => inv.tie(p, "-")),
  ];
  return { inv, wires };
}

test("CD4066B: CONTROL HIGH passes a level one way — and the other", () => {
  for (const rail of ["+", "-"]) {
    const level = rail === "+" ? H : L;
    // Driven at IN/OUT, read at OUT/IN.
    const a = bench("CD4066B");
    const forward = run(quad(a, "+", [a.tie(1, rail)]));
    assert.equal(forward.at(a.hole(2)), level, `IN/OUT ${rail} → OUT/IN`);
    // Driven at OUT/IN, read at IN/OUT: the same switch, backwards.
    const b = bench("CD4066B");
    const back = run(quad(b, "+", [b.tie(2, rail)]));
    assert.equal(back.at(b.hole(1)), level, `OUT/IN ${rail} → IN/OUT`);
  }
});

test("CD4066B: CONTROL LOW opens the switch — the far side floats", () => {
  const sw = bench("CD4066B");
  const { at } = run(quad(sw, "-", [sw.tie(1, "+")]));
  assert.equal(at(sw.hole(1)), H, "the driven side keeps its level");
  assert.equal(at(sw.hole(2)), Z, "the far side has no driver of its own");
});

test("CD4066B: a chip output passes through, both levels, both ways", () => {
  for (const [input, want] of [
    ["+", L],
    ["-", H],
  ]) {
    // The inverter drives switch A's OUT/IN; read at IN/OUT…
    const a = bench("CD4066B");
    const ia = inverter(input);
    const wires = [...ia.wires, wire(ia.inv.free(2), a.free(2))];
    assert.equal(
      run(quad(a, "+", wires, [ia.inv.comp])).at(a.hole(1)),
      want,
      `OUT/IN driven, inverter input ${input}`,
    );
    // …and drives IN/OUT, read at OUT/IN.
    const b = bench("CD4066B");
    const ib = inverter(input);
    const back = [...ib.wires, wire(ib.inv.free(2), b.free(1))];
    assert.equal(
      run(quad(b, "+", back, [ib.inv.comp])).at(b.hole(2)),
      want,
      `IN/OUT driven, inverter input ${input}`,
    );
  }
});

test("CD4066B: a pull resistor on one side holds the other through an ON switch", () => {
  // A pull-down from OUT/IN (via a40–a43) to the − rail; nothing else drives.
  const sw = bench("CD4066B");
  const pull = [wire(sw.free(2), "bb1.b40"), wire("psu1.-", "bb1.b43")];
  const { at } = run(quad(sw, "+", pull, [resistor("r1", "a40")]));
  assert.equal(at(sw.hole(1)), L, "IN/OUT pulled LOW through the switch");
});

test("CD4066B: switches in series pass a level along the chain", () => {
  // A's OUT/IN (2) wired to B's OUT/IN (3), both closed: B's IN/OUT (4) is two
  // switches from the rail on A's IN/OUT (1).
  const sw = bench("CD4066B");
  const { at } = run({
    boards,
    components: [psu(), sw.comp],
    wires: [
      ...sw.power(),
      sw.tie(13, "+"),
      sw.tie(5, "+"),
      sw.tie(6, "-"),
      sw.tie(12, "-"),
      sw.tie(1, "+"),
      wire(sw.free(2), sw.free(3)),
    ],
  });
  assert.equal(at(sw.hole(4)), H);
});

test("CD4066B: a floating CONTROL might be closed — the far side is unknown", () => {
  const sw = bench("CD4066B");
  const { at, warnings } = run(quad(sw, null, [sw.tie(1, "+")]));
  assert.equal(at(sw.hole(2)), X, "H if closed, floating if open");
  const [w] = warnings("floating-input");
  assert.deepEqual(w.pins, [13], "and the open control is reported");
});

test("CD4066B: an unpowered switch conducts nothing", () => {
  const sw = bench("CD4066B");
  const { result, at } = run({
    boards,
    components: [psu(), sw.comp],
    wires: [sw.tie(13, "+"), sw.tie(1, "+")],
  });
  assert.equal(result.chipStatus.get("c1").status, "unpowered");
  assert.equal(at(sw.hole(2)), Z);
});

test("CD4066B: a rail through a switch fights an output on the far side", () => {
  // The switch carries the + rail onto an inverter output driving LOW. Wired
  // straight on, the rail would simply win; through a switch, it is a fight.
  const sw = bench("CD4066B");
  const { inv, wires } = inverter("+");
  const extra = [...wires, wire(inv.free(2), sw.free(2)), sw.tie(1, "+")];
  const { at, warnings } = run(quad(sw, "+", extra, [inv.comp]));
  assert.equal(at(sw.hole(1)), H, "the rail's own net keeps the rail");
  assert.equal(at(sw.hole(2)), X, "the output's net is fought over");
  assert.equal(warnings("conflict").length, 1, "one fight, said once");
});

test("CD4066B: a switch joining + to − is a short", () => {
  const sw = bench("CD4066B");
  const { at, warnings } = run(quad(sw, "+", [sw.tie(1, "+"), sw.tie(2, "-")]));
  assert.equal(at(sw.hole(1)), H);
  assert.equal(at(sw.hole(2)), L);
  const [short] = warnings("short");
  assert.equal(short.via, "switch", "said as a short THROUGH the switch");
  assert.equal(warnings("short").length, 1);
  // Open the switch and the short goes with it.
  const open = bench("CD4066B");
  const quiet = run(quad(open, "-", [open.tie(1, "+"), open.tie(2, "-")]));
  assert.deepEqual(quiet.warnings("short"), []);
});

// ── CD4051B ─────────────────────────────────────────────────────────────────

// COM 3; channels 0–7 on 13 14 15 12 1 5 2 4; INH 6; A 11, B 10, C 9.
const CH51 = [13, 14, 15, 12, 1, 5, 2, 4];
const selectTies = (b, pins, value) =>
  pins.map((p, i) => b.tie(p, (value >> i) & 1 ? "+" : "-"));

test("CD4051B: Table 7-1 — C B A picks the channel joined to COM", () => {
  for (let k = 0; k < 8; k++) {
    const MUX = bench("CD4051B");
    const { at } = run({
      boards,
      components: [psu(), MUX.comp],
      wires: [
        ...MUX.power(),
        MUX.tie(6, "-"),
        ...selectTies(MUX, [11, 10, 9], k),
        MUX.tie(3, "+"), // COM driven: the demultiplexer direction
      ],
    });
    assert.deepEqual(
      CH51.map((p) => at(MUX.hole(p))),
      CH51.map((_, i) => (i === k ? H : Z)),
      `address ${k}`,
    );
  }
});

test("CD4051B: as a multiplexer, COM reads the selected channel", () => {
  // Channel 5 tied LOW, every other channel HIGH: COM is LOW only at 5.
  for (let k = 0; k < 8; k++) {
    const MUX = bench("CD4051B");
    const { at } = run({
      boards,
      components: [psu(), MUX.comp],
      wires: [
        ...MUX.power(),
        MUX.tie(6, "-"),
        ...selectTies(MUX, [11, 10, 9], k),
        ...CH51.map((p, i) => MUX.tie(p, i === 5 ? "-" : "+")),
      ],
    });
    assert.equal(at(MUX.hole(3)), k === 5 ? L : H, `address ${k}`);
  }
});

test("CD4051B: INHIBIT HIGH disconnects every channel", () => {
  const MUX = bench("CD4051B");
  const { at } = run({
    boards,
    components: [psu(), MUX.comp],
    wires: [
      ...MUX.power(),
      MUX.tie(6, "+"),
      ...selectTies(MUX, [11, 10, 9], 3),
      MUX.tie(3, "+"),
    ],
  });
  assert.deepEqual(
    CH51.map((p) => at(MUX.hole(p))),
    Array(8).fill(Z),
  );
});

test("CD4051B: a floating select bit leaves only its two channels in doubt", () => {
  // A floating, B = C = LOW: channel 0 or 1.
  const MUX = bench("CD4051B");
  const { at } = run({
    boards,
    components: [psu(), MUX.comp],
    wires: [
      ...MUX.power(),
      MUX.tie(6, "-"),
      MUX.tie(10, "-"),
      MUX.tie(9, "-"),
      MUX.tie(3, "+"),
    ],
  });
  assert.deepEqual(
    CH51.map((p) => at(MUX.hole(p))),
    [X, X, Z, Z, Z, Z, Z, Z],
  );
});

test("CD4051B: a floating select is read each way in turn — never every channel at once", () => {
  // A floating, B = C = LOW: channel 0 OR channel 1 meets COM, never both.
  // Channel 0 is on +, so COM is H or nothing — unknown; channel 1 only ever
  // meets COM, which nothing else drives, so it floats either way.
  const MUX = bench("CD4051B");
  const { at } = run({
    boards,
    components: [psu(), MUX.comp],
    wires: [
      ...MUX.power(),
      MUX.tie(6, "-"),
      MUX.tie(10, "-"),
      MUX.tie(9, "-"),
      MUX.tie(13, "+"),
    ],
  });
  assert.equal(at(MUX.hole(3)), X, "COM");
  assert.equal(at(MUX.hole(13)), H, "channel 0 is the rail's");
  assert.equal(at(MUX.hole(14)), Z, "channel 1");
});

test("CD4053B: a floating select never joins x to y through COM", () => {
  // Section c, C floating: cx on −, cy driven HIGH by an inverter. Either
  // way the switch is set, cy keeps its own HIGH.
  const TRIPLE = bench("CD4053B");
  const { inv, wires } = inverter("-");
  const { at, warnings } = run({
    boards,
    components: [psu(), TRIPLE.comp, inv.comp],
    wires: [
      ...TRIPLE.power(),
      TRIPLE.tie(6, "-"),
      TRIPLE.tie(11, "-"),
      TRIPLE.tie(10, "-"),
      TRIPLE.tie(5, "-"),
      ...wires,
      wire(inv.free(2), TRIPLE.free(3)),
    ],
  });
  assert.equal(at(TRIPLE.hole(3)), H, "cy");
  assert.equal(at(TRIPLE.hole(4)), X, "COM c: L or H");
  assert.deepEqual(warnings("conflict"), []);
});

test("CD4051B: VEE is a supply pin — the part runs only with it on VSS", () => {
  const desk = (vee) => {
    const mux = bench("CD4051B");
    const doc = {
      boards,
      components: [psu(), mux.comp],
      wires: [
        ...mux.power({ vee }),
        mux.tie(6, "-"),
        ...selectTies(mux, [11, 10, 9], 0),
        mux.tie(3, "+"),
      ],
    };
    return { ...run(doc), mux };
  };
  const tied = desk("-");
  assert.equal(tied.result.chipStatus.get("c1").status, "ok");
  assert.equal(tied.at(tied.mux.hole(13)), H);
  for (const vee of [null, "+"]) {
    const off = desk(vee);
    assert.equal(
      off.result.chipStatus.get("c1").status,
      "unpowered",
      `VEE ${vee ?? "floating"}`,
    );
    assert.equal(
      off.at(off.mux.hole(13)),
      Z,
      "and an unpowered switch is open",
    );
  }
});

// ── CD4052B ─────────────────────────────────────────────────────────────────

// X: COM 13, channels 0–3 on 12 14 15 11. Y: COM 3, channels 1 5 2 4.
// INH 6; A 10, B 9.

test("CD4052B: Table 7-1 — B A picks the same channel in both sections", () => {
  for (let k = 0; k < 4; k++) {
    const DUAL = bench("CD4052B");
    const { at } = run({
      boards,
      components: [psu(), DUAL.comp],
      wires: [
        ...DUAL.power(),
        DUAL.tie(6, "-"),
        ...selectTies(DUAL, [10, 9], k),
        DUAL.tie(13, "+"), // X COM HIGH
        DUAL.tie(3, "-"), // Y COM LOW
      ],
    });
    const want = (level) => [0, 1, 2, 3].map((i) => (i === k ? level : Z));
    assert.deepEqual(
      [12, 14, 15, 11].map((p) => at(DUAL.hole(p))),
      want(H),
      `X at ${k}`,
    );
    assert.deepEqual(
      [1, 5, 2, 4].map((p) => at(DUAL.hole(p))),
      want(L),
      `Y at ${k}`,
    );
  }
});

// ── CD4053B ─────────────────────────────────────────────────────────────────

// a: COM 14, x 12, y 13 (A 11). b: COM 15, x 2, y 1 (B 10).
// c: COM 4, x 5, y 3 (C 9). INH 6.

test("CD4053B: Table 7-1 — each section follows its OWN select", () => {
  for (let v = 0; v < 8; v++) {
    const TRIPLE = bench("CD4053B");
    const { at } = run({
      boards,
      components: [psu(), TRIPLE.comp],
      wires: [
        ...TRIPLE.power(),
        TRIPLE.tie(6, "-"),
        ...selectTies(TRIPLE, [11, 10, 9], v),
        TRIPLE.tie(14, "+"),
        TRIPLE.tie(15, "+"),
        TRIPLE.tie(4, "+"),
      ],
    });
    for (const [bit, x, y] of [
      [0, 12, 13],
      [1, 2, 1],
      [2, 5, 3],
    ]) {
      const toY = ((v >> bit) & 1) === 1;
      assert.equal(at(TRIPLE.hole(x)), toY ? Z : H, `select ${v}, x of ${bit}`);
      assert.equal(at(TRIPLE.hole(y)), toY ? H : Z, `select ${v}, y of ${bit}`);
    }
  }
  // INH HIGH: nothing joined anywhere.
  const T2 = bench("CD4053B");
  const off = run({
    boards,
    components: [psu(), T2.comp],
    wires: [
      ...T2.power(),
      T2.tie(6, "+"),
      ...selectTies(T2, [11, 10, 9], 0),
      T2.tie(14, "+"),
    ],
  });
  assert.equal(off.at(T2.hole(12)), Z);
});

// ── CD4007UB ────────────────────────────────────────────────────────────────

// SCHS018C: Q1 P 14 ↔ 13, Q1 N 8 ↔ 7, gates 6. Q2 P 2 ↔ 1, Q2 N 4 ↔ 5, gates 3.
// Q3 P 11 ↔ 12, Q3 N 12 ↔ 9, gates 10. 14 is VDD and 7 VSS.

/** A powered 4007 with each named gate on a rail (or left open: null) and
    the test's own wires. */
function fets(sw, gates, extra = []) {
  const wires = [...sw.power(), ...extra];
  for (const [pin, rail] of Object.entries(gates)) {
    if (rail) wires.push(sw.tie(Number(pin), rail));
  }
  return { boards, components: [psu(), sw.comp], wires };
}

test("CD4007UB: Q3 inverts once 11 is on VDD and 9 on VSS", () => {
  for (const [rail, want] of [
    ["+", L],
    ["-", H],
  ]) {
    const sw = bench("CD4007UB");
    const doc = fets(sw, { 10: rail, 6: "-", 3: "-" }, [
      sw.tie(11, "+"),
      sw.tie(9, "-"),
    ]);
    const { at, warnings } = run(doc);
    assert.equal(at(sw.hole(12)), want, `gate ${rail}`);
    assert.deepEqual(warnings("short"), []);
  }
});

test("CD4007UB: Q1's P is on VDD and its N on VSS inside — 13 to 8 is an inverter", () => {
  for (const [rail, want] of [
    ["+", L],
    ["-", H],
  ]) {
    const sw = bench("CD4007UB");
    const doc = fets(sw, { 6: rail, 3: "-", 10: "-" }, [
      wire(sw.free(13), sw.free(8)),
    ]);
    assert.equal(run(doc).at(sw.hole(13)), want, `gate ${rail}`);
  }
});

test("CD4007UB: one MOSFET is a switch — Q2's P passes a level both ways while its gate is LOW", () => {
  const sw = bench("CD4007UB");
  const on = run(fets(sw, { 3: "-", 6: "-", 10: "-" }, [sw.tie(2, "+")]));
  assert.equal(on.at(sw.hole(1)), H, "2 → 1");
  const back = bench("CD4007UB");
  const rev = run(fets(back, { 3: "-", 6: "-", 10: "-" }, [back.tie(1, "-")]));
  assert.equal(rev.at(back.hole(2)), L, "1 → 2");
  // Gate HIGH: the P is off, so 1 has nothing (its N partner joins 4 to 5,
  // which hold nothing either).
  const off = bench("CD4007UB");
  const open = run(fets(off, { 3: "+", 6: "-", 10: "-" }, [off.tie(2, "+")]));
  assert.equal(open.at(off.hole(1)), Z);
});

test("CD4007UB: a floating gate leaves its inverter unknown, and is reported", () => {
  const sw = bench("CD4007UB");
  const doc = fets(sw, { 10: null, 6: "-", 3: "-" }, [
    sw.tie(11, "+"),
    sw.tie(9, "-"),
  ]);
  const { at, warnings } = run(doc);
  assert.equal(at(sw.hole(12)), X);
  const [w] = warnings("floating-input");
  assert.deepEqual(w.pins, [10]);
});

test("CD4007UB: a MOSFET joining + to − is a short through a transistor", () => {
  // Q1's P joins VDD to 13 while its gate is LOW; 13 is wired to GND.
  const sw = bench("CD4007UB");
  const { warnings } = run(
    fets(sw, { 6: "-", 3: "-", 10: "-" }, [sw.tie(13, "-")]),
  );
  const [short] = warnings("short");
  assert.equal(short?.via, "transistor");
  // Gate HIGH turns that P off — and the short goes with it.
  const off = bench("CD4007UB");
  const quiet = run(fets(off, { 6: "+", 3: "-", 10: "-" }, [off.tie(13, "-")]));
  assert.deepEqual(quiet.warnings("short"), []);
});

test("CD4007UB: a fight on one net stays there, though a rail reaches another through a channel too", () => {
  // Q1's P puts VDD on 13 (gate 6 LOW); Q3's P puts VDD on 12 (gate 10
  // LOW, 11 on +), where an inverter's output fights it. The rail is stiff:
  // 13 hears none of 12's fight.
  const sw = bench("CD4007UB");
  const { inv, wires } = inverter("+");
  const { at, warnings } = run({
    boards,
    components: [psu(), sw.comp, inv.comp],
    wires: [
      ...sw.power(),
      sw.tie(6, "-"),
      sw.tie(3, "-"),
      sw.tie(10, "-"),
      sw.tie(11, "+"),
      ...wires,
      wire(inv.free(2), sw.free(12)),
    ],
  });
  assert.equal(at(sw.hole(12)), X, "the fight");
  assert.equal(at(sw.hole(13)), H, "Q1's output");
  assert.equal(warnings("conflict").length, 1);
});

test("a short through a SWITCH is said to be a switch's, whatever transistors sit elsewhere", () => {
  // A 4066 joining + to −, and an idle CD4007UB (whose terminals 14 and 7
  // are on the rails) beside it.
  const sw = bench("CD4066B");
  const fet = bench("CD4007UB", "e30", "c2");
  const { warnings } = run(
    quad(
      sw,
      "+",
      [
        sw.tie(1, "+"),
        sw.tie(2, "-"),
        ...fet.power(),
        fet.tie(6, "+"),
        fet.tie(3, "+"),
        fet.tie(10, "+"),
      ],
      [fet.comp],
    ),
  );
  const shorts = warnings("short");
  assert.equal(shorts.length, 1);
  assert.equal(shorts[0].via, "switch");
});

test("CD4007UB: a gate built from it is held to the family boundaries like any output", () => {
  // Q1 as an inverter (13 to 8) into three 74LS04 inputs: one B-series sink
  // holds one LS load, as a CD4069UB's does.
  const sw = bench("CD4007UB");
  const ls = bench("74LS04", "e30", "c2");
  const fan = run({
    boards,
    components: [psu(), sw.comp, ls.comp],
    wires: [
      ...sw.power(),
      ...ls.power(),
      sw.tie(6, "+"),
      sw.tie(3, "-"),
      sw.tie(10, "-"),
      wire(sw.free(13), sw.free(8)),
      ...[1, 3, 5].map((p) => wire(sw.free(8), ls.free(p))),
    ],
  });
  const [over] = fan.warnings("ls-fanout");
  assert.equal(over?.chip, "c1");
  assert.equal(over?.loads, 3);
  // …and its HIGH, from a 12 V supply, into a 74LS04 on 5 V is two supplies
  // on one net.
  const hi = bench("CD4007UB");
  const ls5 = bench("74LS04", "e30", "c2");
  const twelve = { ...psu("psu1"), params: { volts: 12 } };
  const five = { ...psu("psu2"), x: 90, params: { volts: 5 } };
  const mixed = run({
    boards,
    components: [twelve, five, hi.comp, ls5.comp],
    wires: [
      ...hi.power(),
      hi.tie(6, "-"),
      hi.tie(3, "-"),
      hi.tie(10, "-"),
      wire(hi.free(13), hi.free(8)),
      wire("psu2.+", ls5.free(14)),
      wire("psu2.-", ls5.free(7)),
      wire("psu2.-", "psu1.-"),
      wire(hi.free(13), ls5.free(1)),
    ],
  });
  const [w] = mixed.warnings("mixed-supply");
  assert.deepEqual(w?.volts, [5, 12]);
});

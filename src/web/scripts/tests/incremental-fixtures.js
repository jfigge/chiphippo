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

// incremental-fixtures.js — the differential harness behind
// engine-incremental.test.js, and the circuits it runs.
//
// `compareRuns` ticks ONE document through the engine twice over — once with
// `mode: "full"` (today's full-pass loop, the reference) and once with the
// incremental settle — each run threading its own warm start, state, sampled
// pins, Spice Lite analog state and memory images exactly as SimController
// does, and asserts that every tick's result is the same in every field,
// down to the order of the level maps' keys, whether the strong map IS the
// level map, and — with a chip watched — everything the chip debugger's
// recorder heard.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildNetlist } from "../sim/netlist.js";
import { ENGINES } from "../sim/engines.js";
import { prepareCircuit } from "../sim/engine.js";
import { H, L } from "../sim/levels.js";
import { isOscillator, isVolatileMemory } from "../sim/chip-eval.js";
import { partDef } from "../catalog/index.js";
import { recorder } from "../model/chip-debug.js";
import { normalizeDocument } from "../model/desk-doc.js";
import { parseIntelHex } from "../model/hex-format.js";
import { compileNetlist } from "../model/autobuild.js";
import { bench } from "./timing-fixtures.js";

/** Every field of a digital result. */
const DIGITAL = [
  "netLevels",
  "strongLevels",
  "chipStatus",
  "warnings",
  "iterations",
  "settled",
  "state",
  "pinLevels",
  "memWrites",
  "timing",
  "channels",
  "wakeAt",
];

/** …and the fields Spice Lite adds. */
const SPICE = ["analog", "nodeVolts", "supplies", "loads", "sag", "lamps", "currents"]; // prettier-ignore

/** Simulated seconds between ticks. */
export const STEP_S = 0.005;

/**
 * The stimulus most desks want: every clock brick and oscillator can toggled
 * each tick (as engine-parity.test.js does), every planted signal held at
 * its rest level and then flipped every few ticks, and time advancing.
 */
export function defaultStimulus(doc) {
  const clocks = (doc.components ?? []).filter(
    (c) => c.kind === "clock" || isOscillator(partDef(c.ref)),
  );
  const signals = (doc.signals ?? []).filter((s) => s?.flag?.anchor);
  return (i) => {
    const level = i % 2 === 0 ? H : L;
    return {
      clockPhase: new Map(clocks.map((c) => [c.id, level])),
      signalLevels: new Map(
        signals.map((s, k) => {
          const rest = s.rest === "high" ? H : L;
          const flip = ((i >> 2) + k) % 2 === 1;
          return [s.id, flip ? (rest === H ? L : H) : rest];
        }),
      ),
      now: i * STEP_S,
    };
  };
}

/** One run of a desk through one engine in one mode. */
function thread(doc, netlist, { engine, spice, mode, context, images }) {
  const { tick } = ENGINES[engine];
  const own = new Map([...images].map(([id, img]) => [id, img.slice()]));
  const writable = new Set(
    (doc.components ?? [])
      .filter((c) => own.has(c.id) && isVolatileMemory(partDef(c.ref)))
      .map((c) => c.id),
  );
  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  let analog = null;
  const prepared = context ? prepareCircuit(doc, netlist) : null;
  return {
    images: own,
    step(stim, observer, stats) {
      const r = tick({
        document: doc,
        netlist,
        warmStart: warm,
        state,
        prevPinLevels: prev,
        clockPhase: stim.clockPhase ?? new Map(),
        signalLevels: stim.signalLevels ?? new Map(),
        images: own,
        now: stim.now ?? 0,
        observer,
        mode,
        stats,
        context: prepared,
        ...(engine === "spice"
          ? { spice: { config: { enabled: true, ...spice }, analog } }
          : {}),
      });
      warm = r.netLevels;
      state = r.state;
      prev = r.pinLevels;
      analog = r.analog ?? null;
      for (const w of r.memWrites ?? []) {
        const img = own.get(w.compId);
        if (writable.has(w.compId) && img && w.addr >= 0 && w.addr < img.length) img[w.addr] = w.value; // prettier-ignore
      }
      return r;
    },
  };
}

/** The shape of a recorder's rounds that identity decides: which level maps
    are the very same object as their strong map. */
const aliasing = (rounds) => rounds.map((r) => r.levels === r.strong);

/**
 * Tick `doc` in full and incremental mode side by side and assert every
 * tick's result identical. Returns the incremental runs' `stats` (pass kinds
 * and fallbacks — the engine's own counters) and the last full result.
 *
 * @param {string} label
 * @param {object} doc
 * @param {object} [opts]
 * @param {number} [opts.ticks]
 * @param {(i: number) => object} [opts.stimulus] - per tick `{clockPhase,
 *   signalLevels, now}`
 * @param {Map<string, Uint8Array>} [opts.images]
 * @param {"digital"|"spice"} [opts.engine]
 * @param {object} [opts.spice] - Spice Lite config overrides
 * @param {Set<string>} [opts.watch] - chips the debugger's recorder watches
 * @param {boolean} [opts.bothContexts] - also run incremental with no
 *   prepared context (the index built afresh every tick)
 * @param {(i: number, r: object) => void} [opts.check] - told of every tick
 */
export function compareRuns(label, doc, opts = {}) {
  const {
    ticks = 16,
    stimulus = defaultStimulus(doc),
    images = new Map(),
    engine = "digital",
    spice = null,
    watch = null,
    bothContexts = false,
    check = null,
  } = opts;
  const netlist = buildNetlist(doc);
  const base = { engine, spice, images };
  const full = thread(doc, netlist, { ...base, mode: "full", context: false });
  const runs = [
    { name: "incremental", t: thread(doc, netlist, { ...base, mode: "incremental", context: true }) }, // prettier-ignore
  ];
  if (bothContexts) {
    runs.push({ name: "incremental, fresh context", t: thread(doc, netlist, { ...base, mode: "incremental", context: false }) }); // prettier-ignore
  }
  const fields = engine === "spice" ? [...DIGITAL, ...SPICE] : DIGITAL;
  const stats = {};
  let last = null;
  for (let i = 0; i < ticks; i++) {
    const stim = stimulus(i);
    const fullObs = watch ? recorder(watch) : null;
    const want = full.step(stim, fullObs, null);
    for (const { name, t } of runs) {
      const obs = watch ? recorder(watch) : null;
      const got = t.step(stim, obs, stats);
      const at = `${label} — ${name}, tick ${i}`;
      for (const f of fields) {
        assert.deepStrictEqual(got[f], want[f], `${at}: ${f}`);
      }
      for (const f of ["netLevels", "strongLevels"]) {
        assert.deepStrictEqual([...got[f].keys()], [...want[f].keys()], `${at}: ${f} key order`); // prettier-ignore
      }
      assert.equal(got.strongLevels === got.netLevels, want.strongLevels === want.netLevels, `${at}: strong IS levels`); // prettier-ignore
      if (watch) {
        assert.deepStrictEqual(obs.rounds, fullObs.rounds, `${at}: observer record`); // prettier-ignore
        assert.deepStrictEqual(aliasing(obs.rounds), aliasing(fullObs.rounds), `${at}: observer aliasing`); // prettier-ignore
      }
      assert.deepStrictEqual(t.images, full.images, `${at}: memory images`);
    }
    check?.(i, want);
    last = want;
  }
  return { stats, last };
}

// ── Desks ──────────────────────────────────────────────────────────────────

const DEMO_DIR = fileURLToPath(new URL("../../../../demos/", import.meta.url));

/**
 * A breadboard computer from demos/ with its ROM programmed from the `.hex`
 * beside it (and, for Ben Eater's, an empty 32K SRAM) — as demos.test.js
 * loads them.
 */
export function loadComputer(
  base,
  { romRef = "rom-8k", romSize = 8192, ram = null } = {},
) {
  // prettier-ignore
  const doc = JSON.parse(readFileSync(`${DEMO_DIR}${base}.chiphippo`, "utf8"));
  const norm = normalizeDocument(doc);
  assert.equal(norm.components.length, doc.components.length, `${base} loads whole`); // prettier-ignore
  const parsed = parseIntelHex(readFileSync(`${DEMO_DIR}${base}.hex`, "utf8"));
  const image = new Uint8Array(romSize);
  image.set(parsed.subarray(0, image.length));
  const rom = doc.components.find((c) => c.ref === romRef);
  const images = new Map([[rom.id, image]]);
  if (ram) {
    const chip = doc.components.find((c) => c.ref === ram.ref);
    images.set(chip.id, new Uint8Array(ram.size));
  }
  return { doc, images };
}

/** The desktops of a project file in demos/ (the hand-built NE555). */
export function projectDesktops(file) {
  const project = JSON.parse(readFileSync(`${DEMO_DIR}${file}`, "utf8"));
  return project.tabs.map((tab) => ({ name: tab.name, doc: tab.doc }));
}

/** A powered 14-pin package at `anchor` (VCC/VDD 14, GND/VSS 7). */
export function powered(b, id, ref, anchor) {
  const u = b.seat(id, ref, anchor);
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  return u;
}

/** A CD4051B whose select bit C floats — its channels read every way the
    bit could be (the multi-reading fallback). A selects, signal-driven;
    the channels sit on alternating rails; COM feeds a CD4069UB. */
export function floatingMux() {
  const b = bench();
  const m = b.seat("u1", "CD4051B", "e10");
  b.vcc(m.get(16));
  b.gnd(m.get(8));
  b.gnd(m.get(7));
  b.gnd(m.get(6)); // INH
  b.gnd(m.get(10)); // B
  b.signal("sa", m.get(11), "low"); // A
  // C (pin 9) left floating.
  [13, 14, 15, 12, 1, 5, 2, 4].forEach((pin, ch) =>
    (ch % 3 === 0 ? b.vcc : b.gnd)(m.get(pin)),
  );
  const u = powered(b, "u2", "CD4069UB", "e30");
  b.link(m.get(3), u.get(1));
  return b.doc;
}

/** A diode chain: a signal through two diodes in series, a pull-down at
    the end, read by an inverter. */
export function diodeChain() {
  const b = bench();
  const u = powered(b, "u1", "74LS04", "e10");
  const d1 = b.seat("d1", "diode", "a25");
  const d2 = b.seat("d2", "diode", "a35");
  const r = b.seat("r1", "resistor", "a45", { ohms: 10e3 });
  b.signal("s1", d1.get(1), "low");
  b.link(d1.get(2), d2.get(1));
  b.link(d2.get(2), r.get(1));
  b.gnd(r.get(2));
  b.link(d2.get(2), u.get(1));
  return b.doc;
}

/** A diode whose anode two signals fight over (X — the uncertain
    fallback), its cathode pulled down and read. */
export function foughtAnode() {
  const b = bench();
  const u = powered(b, "u1", "74LS04", "e10");
  const d = b.seat("d1", "diode", "a25");
  const r = b.seat("r1", "resistor", "a35", { ohms: 10e3 });
  b.signal("s1", d.get(1), "low");
  b.signal("s2", d.get(1), "high");
  b.link(d.get(2), r.get(1));
  b.gnd(r.get(2));
  b.link(d.get(2), u.get(1));
  return b.doc;
}

/** The fought anode again, one of its fighters a toggling 74LS74's Q: a
    settle that ends on the uncertain fallback (its disagreeing readings
    leave the cathode X), then a step that ends the fight and a re-solve in
    which the cathode's certain level is the one it was cached with. */
export function flopFight() {
  const b = bench();
  const u = powered(b, "u1", "74LS04", "e10");
  const f = powered(b, "u2", "74LS74", "e25");
  const d = b.seat("d1", "diode", "a40");
  const r = b.seat("r1", "resistor", "a50", { ohms: 10e3 });
  b.signal("clk", f.get(3), "low");
  b.link(f.get(6), f.get(2)); // 1Q̄ → 1D: a toggle
  b.link(f.get(5), d.get(1)); // 1Q → the anode…
  b.signal("s2", d.get(1), "low"); // …which a held-LOW lead fights
  b.link(d.get(2), r.get(1));
  b.gnd(r.get(2));
  b.link(d.get(2), u.get(1));
  return b.doc;
}

/** VCC–R–A–R–B–R–GND: a pull relaxation that never converges (A and B
    alternate between H/L and X/X), each node read by an inverter. */
export function dividerChain() {
  const b = bench();
  const u = powered(b, "u1", "74LS04", "e10");
  const r1 = b.seat("r1", "resistor", "a25", { ohms: 1e3 });
  const r2 = b.seat("r2", "resistor", "a35", { ohms: 1e3 });
  const r3 = b.seat("r3", "resistor", "a45", { ohms: 1e3 });
  b.vcc(r1.get(1));
  b.link(r1.get(2), r2.get(1));
  b.link(r2.get(2), r3.get(1));
  b.gnd(r3.get(2));
  b.link(r1.get(2), u.get(1));
  b.link(r2.get(2), u.get(3));
  return b.doc;
}

/** A resistor chain that DOES converge: a signal through three resistors in
    series (two middle nets), read at the far end. */
export function resistorChain() {
  const b = bench();
  const u = powered(b, "u1", "74LS04", "e10");
  const r1 = b.seat("r1", "resistor", "a25", { ohms: 1e3 });
  const r2 = b.seat("r2", "resistor", "a35", { ohms: 1e3 });
  const r3 = b.seat("r3", "resistor", "a45", { ohms: 1e3 });
  b.signal("s1", r1.get(1), "low");
  b.link(r1.get(2), r2.get(1));
  b.link(r2.get(2), r3.get(1));
  b.link(r3.get(2), u.get(1));
  return b.doc;
}

/** Three 74LS04 inverters in a ring — and nothing else: no resistor, diode
    or LED-limiting part, so a pass's strong levels ARE its level map. */
export function inverterRing() {
  const b = bench();
  const u = powered(b, "u1", "74LS04", "e10");
  b.link(u.get(2), u.get(3));
  b.link(u.get(4), u.get(5));
  b.link(u.get(6), u.get(1));
  return b.doc;
}

/** A ring (a 74LS00 gate and two 74LS04 inverters) that a signal enables,
    the same signal clocking a toggling 74LS74: on each rising edge the
    pre-settle runs to its cap (the ring's nets marked X) and then, within
    the same tick, the step re-solves around the flop's new state. A LOW
    enable forces the ring to a level again before the next edge. */
export function ringAndFlop() {
  const b = bench();
  const g = powered(b, "u1", "74LS00", "e10");
  const u = powered(b, "u2", "74LS04", "e20");
  const f = powered(b, "u3", "74LS74", "e30");
  b.signal("en", g.get(1), "low"); // 1A: the enable
  b.link(g.get(3), u.get(1)); // 1Y → inverter
  b.link(u.get(2), u.get(3)); // → inverter
  b.link(u.get(4), g.get(2)); // → 1B: the ring
  b.link(g.get(1), f.get(3)); // the enable clocks the flop
  b.link(f.get(6), f.get(2)); // 1Q̄ → 1D: a toggle
  b.link(f.get(5), u.get(5)); // 1Q → a third inverter
  return b.doc;
}

/** A two-stage ripple counter (74LS74, each half a toggle: Q̄ → D, the
    first clocked by a signal, the second by the first's Q̄): a rising signal
    re-solves the tick once per stage, the incremental work carried across
    the re-solves. Nothing else on the desk, as in the ring. */
export function rippleCounter() {
  const b = bench();
  const u = powered(b, "u1", "74LS74", "e10");
  b.signal("clk", u.get(3), "low"); // 1CLK
  b.link(u.get(6), u.get(2)); // 1Q̄ → 1D
  b.link(u.get(6), u.get(11)); // 1Q̄ → 2CLK
  b.link(u.get(8), u.get(12)); // 2Q̄ → 2D
  return b.doc;
}

/** CD4069UB and 74LS04 outputs straight onto LEDs, no resistor — the LED
    rule's own resolution (the CMOS output limits its current at 5 V, the
    TTL one burns its LED). */
export function bareLeds() {
  const b = bench();
  const c = powered(b, "u1", "CD4069UB", "e10");
  const t = powered(b, "u2", "74LS04", "e25");
  const d1 = b.seat("d1", "led", "a40", { color: "red" });
  const d2 = b.seat("d2", "led", "a45", { color: "green" });
  b.signal("s1", c.get(1), "low");
  b.link(c.get(1), t.get(1));
  b.link(c.get(2), d1.get(1));
  b.gnd(d1.get(2));
  b.link(t.get(2), d2.get(1));
  b.gnd(d2.get(2));
  return b.doc;
}

/** An N-channel MOSFET across the rails, its gate on a signal: ON, it
    shorts them through a transistor; let go (Z), it holds. */
export function railMosfet() {
  const b = bench();
  const q = b.seat("q1", "nmos", "a40");
  b.gnd(q.get(1));
  b.vcc(q.get(3));
  b.signal("g", q.get(2), "low");
  const u = powered(b, "u1", "74LS04", "e10");
  b.link(q.get(2), u.get(1));
  return b.doc;
}

/** Two 74LS04 outputs at opposite levels, joined through a CD4066B channel
    a signal switches — one fight across a group, said once — with a
    pull-up on one side and a 74LS125 on the other whose enable is a second
    signal: a conflict warning on a net a resistor couples (a scoped
    resolve's), coming and going. */
export function switchedFight() {
  const b = bench();
  const inv = powered(b, "u1", "74LS04", "e10");
  const sw = powered(b, "u2", "CD4066B", "e20");
  const buf = powered(b, "u3", "74LS125", "e30");
  b.gnd(inv.get(1)); // 1Y HIGH
  b.vcc(inv.get(3)); // 2Y LOW
  b.link(inv.get(2), sw.get(1));
  b.link(inv.get(4), sw.get(2));
  b.signal("ctl", sw.get(13), "low");
  for (const pin of [5, 6, 12]) b.gnd(sw.get(pin)); // the spare controls
  const r = b.seat("r1", "resistor", "a45", { ohms: 4.7e3 });
  b.vcc(r.get(1));
  b.link(r.get(2), inv.get(2));
  b.signal("oe", buf.get(1), "high");
  b.gnd(buf.get(2)); // 1A LOW
  b.link(buf.get(3), inv.get(2)); // …onto the pulled-up side
  return b.doc;
}

/** Two 74LS125 buffers on one bus, each enabled by its own signal — and a
    third signal on the bus itself, so a net's drivers mix a chip's output
    with a bench lead's. */
export function triStateBus() {
  const b = bench();
  const u = powered(b, "u1", "74LS125", "e10");
  const v = powered(b, "u2", "74LS04", "e25");
  b.signal("g1", u.get(1), "high");
  b.signal("g2", u.get(4), "high");
  b.signal("bus", u.get(3), "low");
  b.vcc(u.get(2)); // 1A high
  b.gnd(u.get(5)); // 2A low
  b.link(u.get(3), u.get(6)); // the bus
  b.link(u.get(3), v.get(1));
  return b.doc;
}

/** A signal into a CD4069UB, its output into a 74LS04: the CMOS gate holds
    its output for its delay under Spice Lite (`outputs` + `busy`). */
export function mixedFamilies() {
  const b = bench();
  const cmos = powered(b, "u1", "CD4069UB", "e10");
  const ls = powered(b, "u2", "74LS04", "e25");
  b.link(cmos.get(2), ls.get(1));
  b.link(ls.get(2), cmos.get(3));
  b.signal("in", cmos.get(1), "low");
  return b.doc;
}

/** R from VCC into a node, C from it to GND, the node read by a 74LS04 AND
    a CD4069UB — two thresholds on one RC (`input`, `levels`). A signal on
    the far side of a second resistor discharges it. */
export function sharedRcNode({ r = 10e3, c = 1e-6 } = {}) {
  const b = bench();
  const ls = powered(b, "u1", "74LS04", "e10");
  const cmos = powered(b, "u2", "CD4069UB", "e25");
  const res = b.seat("r1", "resistor", "a40", { ohms: r });
  const cap = b.seat("c1", "cap-electrolytic", "a50", { farads: c });
  b.vcc(res.get(1));
  b.link(res.get(2), ls.get(1));
  b.link(res.get(2), cmos.get(1));
  b.link(cap.get(1), ls.get(1));
  b.gnd(cap.get(2));
  return b.doc;
}

/** An RC relaxation oscillator round a Schmitt inverter: 1Y → R → 1A, C from
    1A to GND. */
export function relaxation(ref = "CD40106B", { r = 10e3, c = 1e-6 } = {}) {
  const b = bench();
  const u = powered(b, "u1", ref, "e10");
  const res = b.seat("r1", "resistor", "a30", { ohms: r });
  b.link(res.get(1), u.get(1));
  b.link(res.get(2), u.get(2));
  const cap = b.seat("c1", "cap-electrolytic", "a40", { farads: c });
  b.link(cap.get(1), u.get(1));
  b.gnd(cap.get(2));
  return b.doc;
}

/** A 74LS04 on a supply loaded with `n` 100 Ω resistors across the rails,
    past its current limit (`psuVolts`). */
export function loadedSupply(n = 6, limit = 0.2) {
  const b = bench();
  const u = powered(b, "u1", "74LS04", "e10");
  b.signal("s1", u.get(1), "low");
  for (let i = 0; i < n; i++) {
    const r = b.seat(`r${i}`, "resistor", `a${30 + i * 5}`, { ohms: 100 });
    b.vcc(r.get(1));
    b.gnd(r.get(2));
  }
  b.doc.components[0].params.currentLimit = limit;
  return b.doc;
}

/** Two 74LS04s, the second fed THROUGH the first's VCC node, a 2 Ω load on
    the far end (`chipDrop`), one signal between them. */
export function longSupplyWire() {
  const b = bench();
  const u1 = b.seat("u1", "74LS04", "e10");
  const u2 = b.seat("u2", "74LS04", "e40");
  b.vcc(u1.get(14));
  b.link(u1.get(14), u2.get(14));
  b.gnd(u1.get(7));
  b.gnd(u2.get(7));
  const r = b.seat("r1", "resistor", "a55", { ohms: 2 });
  b.link(r.get(1), u2.get(14));
  b.gnd(r.get(2));
  b.doc.components[0].params.currentLimit = 5;
  b.link(u1.get(2), u2.get(1));
  b.signal("s1", u1.get(1), "low");
  return b.doc;
}

/** A `color` LED from + to − through `ohms` (none: straight across). */
export function railLamp({ ohms = 330, color = "red" } = {}) {
  const b = bench();
  const d = b.seat("d1", "led", "a30", { color });
  if (ohms) {
    const r = b.seat("r1", "resistor", "a20", { ohms });
    b.vcc(r.get(1));
    b.link(r.get(2), d.get(1));
  } else {
    b.vcc(d.get(1));
  }
  b.gnd(d.get(2));
  return b.doc;
}

/** A 74LS04's 1Y lighting an LED through a resistor, the input on a
    signal — an LED network a chip output drives. */
export function drivenLamp(ref = "74LS04", { ohms = 220 } = {}) {
  const b = bench();
  const u = powered(b, "u1", ref, "e10");
  b.signal("s1", u.get(1), "low");
  const r = b.seat("r1", "resistor", "a25", { ohms });
  const d = b.seat("d1", "led", "a35", { color: "red" });
  b.link(u.get(2), r.get(1));
  b.link(r.get(2), d.get(1));
  b.gnd(d.get(2));
  return b.doc;
}

/** A desk the compiler builds, as the app would load it: a clock into a
    CD4069UB, its output into a 74LS04 and an LED, the 74LS04 lighting a
    second (the compiler adds their resistors). */
export function compiledMixedDesk() {
  const out = compileNetlist({
    title: "Mixed families",
    parts: [
      { id: "CLK1", ref: "clock" },
      { id: "U1", ref: "CD4069UB" },
      { id: "U2", ref: "74LS04" },
      { id: "L1", ref: "led" },
      { id: "L2", ref: "led" },
    ],
    nets: [
      { name: "CLKGND", members: ["CLK1.gnd", "GND"] },
      { name: "CLOCK", members: ["CLK1.out", "U1.A"] },
      { name: "MID", members: ["U1.G", "U2.1A", "L2.A"] },
      { name: "OUT", members: ["U2.1Y", "L1.A"] },
      { name: "K", members: ["L1.K", "L2.K", "GND"] },
    ],
  });
  assert.ok(out.ok, JSON.stringify(out.errors));
  return out.document;
}

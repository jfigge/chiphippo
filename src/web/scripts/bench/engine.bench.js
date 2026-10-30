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

// engine.bench.js — the simulation engine, timed and counted, headless.
//
//   make bench                        (BENCH_SLICES=16 BENCH_EDGES=1000 make bench)
//
// Runs the busy fixture (bench/busy-circuit.js) through `tick` exactly as
// SimController does on every clock edge — warm start, state, previous pins
// carried tick to tick, one document snapshot and its prepared context
// (`prepareCircuit`) reused while nothing changes — and reports three things:
//
//   1. TIME per tick, from a run with no observer at all (the number a user
//      feels), against the demand: a 100 Hz clock is 200 ticks a second at ×1.
//   2. WHERE a tick goes: building the context (everything before the first
//      settle pass), the settle passes, the step passes, and assembling the
//      result — read off the observer's `round` calls, a second run.
//   3. WORK: settle passes and step passes per tick, and per chip how often
//      it was evaluated and how many of those evaluations saw an input that
//      had changed since its last one — every other evaluation recomputed an
//      answer it already had (`observer.evaluated`, a third run) — and the
//      chip evaluations and net resolutions each settle mode PERFORMED per
//      pass, with every fallback the incremental one took (`stats`) — and,
//      under Spice Lite, the voltage clusters each mode solved per tick and
//      booked at the supplies' set voltage (spice/voltages.js).
//
// Every time is taken twice: in the default, incremental settle and in
// `mode: "full"` (every chip, every net, every pass — the reference; under
// Spice Lite every voltage cluster at every tick's start, too), and once more
// for each under Spice Lite (sim/spice/engine.js, which runs the same settle
// through its hooks).
//
// And a second test: the W65C02 and Z80A example computers (src/web/demos/),
// each alone and with three copies of its breadboards beside it with nothing
// on them, timed per clock edge as SimController runs them (`inPlace`) — the
// desks issue #12 measured, and what features/digital-event-tick.md made of
// them (44.7 µs an edge at v1.5.3; the time no longer grows with idle nets).
//
// Not part of `make test` (it lives outside tests/): it asserts only that the
// fixture COUNTS correctly, so a number is never reported off a broken run.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildNetlist } from "../sim/netlist.js";
import { prepareCircuit, tick } from "../sim/engine.js";
import { ENGINES } from "../sim/engines.js";
import { voltageTopology } from "../sim/spice/voltages.js";
import { H, L } from "../sim/levels.js";
import { partPinAddresses } from "../model/occupancy.js";
import { busyDocument } from "./busy-circuit.js";
import { partDef } from "../catalog/index.js";

const SLICES = Number(process.env.BENCH_SLICES ?? 8);
const EDGES = Number(process.env.BENCH_EDGES ?? 400);
const NO_WATCH = new Set();

const ms = (n) => n.toFixed(3);
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

/**
 * Drive `edges` clock edges through the engine (plus the Run tick before
 * them), calling `hooks.before(edge)` / `hooks.after(edge, result)` around
 * each tick and handing `hooks.observer?.(edge)` to it — in settle mode
 * `hooks.mode`, counting into `hooks.stats`, on the digital engine or, with
 * `hooks.spice`, on Spice Lite.
 */
function drive(doc, netlist, edges, hooks = {}) {
  const { tick } = hooks.spice ? ENGINES.spice : ENGINES.digital;
  let analog = null;
  const clockId = doc.components.find((c) => c.kind === "clock").id;
  const clockPhase = new Map([[clockId, L]]);
  let warm = new Map();
  let state = new Map();
  let prevPins = new Map();
  let result = null;
  // The logic engine's last tick's work, carried as SimController carries it
  // (`warm`) — so the bench times a tick the way the app runs one.
  let carry = null;
  // Prepared once, as SimController keeps it — unless `fresh` asks for the
  // engine to build its context every tick (the reference it is compared to).
  const context = hooks.fresh ? null : prepareCircuit(doc, netlist);
  for (let e = 0; e <= edges; e++) {
    if (e > 0) clockPhase.set(clockId, clockPhase.get(clockId) === H ? L : H);
    const observer = hooks.observer?.(e) ?? null;
    hooks.before?.(e);
    result = tick({
      document: doc,
      netlist,
      warmStart: warm,
      state,
      prevPinLevels: prevPins,
      clockPhase,
      observer,
      context,
      mode: hooks.mode,
      stats: hooks.stats,
      ...(hooks.spice
        ? { spice: { config: { enabled: true }, analog } }
        : { warm: carry }),
    });
    hooks.after?.(e, result);
    warm = result.netLevels;
    state = result.state;
    prevPins = result.pinLevels;
    analog = result.analog ?? null;
    carry = result.warm ?? null;
  }
  return result;
}

/**
 * The busy fixture with two multimeters on it (catalog/meter.js): one on DC
 * volts across the clock's output, one on the 10 A range IN SERIES with the
 * supply — the wire from its + to the rail taken out and the meter's probes
 * put in its place — so every tick solves both meters' elements.
 */
function meteredDocument(doc) {
  const out = structuredClone(doc);
  const feed = out.wires.find((w) => w.from === "psu1.+" && /^bb\d+\.\+/.test(w.to)); // prettier-ignore
  out.wires = out.wires.filter((w) => w !== feed);
  // (The clock brick off the supply itself: past the meter it is fed through
  // the shunt, and the logic engine powers no clock off the rails.)
  for (const w of out.wires) if (w.to === "clk1.vcc") w.from = "psu1.+";
  const clockOut = out.wires.find((w) => w.to === "clk1.out").from;
  const meter = (id, x, params) => ({ id, kind: "meter", ref: "meter", x, y: -70, params: partDef("meter").normalizeParams(params) }); // prettier-ignore
  out.components.push(
    meter("dmm1", 0, { dial: "v", red: { at: clockOut }, black: { at: "psu1.-" } }), // prettier-ignore
    meter("dmm2", 40, { dial: "ma", jack: "a", red: { at: "psu1.+" }, black: { at: feed.to } }), // prettier-ignore
  );
  out.nextMeterId = 3;
  return out;
}

/** The counter's value off the settled board: each slice's QD…QA. */
function countOf(doc, netlist, levels) {
  let value = 0;
  const counters = doc.components
    .filter((c) => c.ref === "74LS161")
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  // The compiler names nothing after the spec, so order the slices by the
  // carry chain: the first is the one whose ENT is tied high.
  const pinNet = (comp, n) => {
    const addr = partPinAddresses(doc, comp).find((p) => p.pin === n).address;
    return netlist.netOfPoint.get(addr);
  };
  const byRco = new Map(counters.map((c) => [pinNet(c, 15), c]));
  let cur = counters.find((c) => !byRco.has(pinNet(c, 10)));
  const chain = [];
  while (cur) {
    chain.push(cur);
    const rco = pinNet(cur, 15);
    cur = counters.find((c) => c !== cur && pinNet(c, 10) === rco);
  }
  assert.equal(chain.length, counters.length, "one carry chain through every slice"); // prettier-ignore
  chain.forEach((c, s) => {
    // QA pin 14, QB 13, QC 12, QD 11.
    [14, 13, 12, 11].forEach((pin, bit) => {
      if (levels.get(pinNet(c, pin)) === H) value += 2 ** (4 * s + bit);
    });
  });
  return value;
}

function bench(slices, edges) {
  const built = performance.now();
  const doc = busyDocument(slices);
  const netlist = buildNetlist(doc);
  const buildMs = performance.now() - built;
  const chips = doc.components.filter((c) => c.kind === "chip");
  const lines = [];
  const say = (s = "") => lines.push(s);

  // ── 1. Time, with nothing watching ──────────────────────────────────────
  let t0 = 0;
  const rising = Math.ceil(edges / 2);
  /** Ms per clock-edge tick, in one settle mode, after checking it counted. */
  const timed = (opts) => {
    const times = [];
    const last = drive(doc, netlist, edges, {
      ...opts,
      before: () => (t0 = performance.now()),
      after: (e, r) => {
        if (e > 0) times.push(performance.now() - t0);
        assert.equal(r.settled, true, `tick ${e} settled`);
      },
    });
    assert.equal(
      countOf(doc, netlist, last.netLevels),
      rising % 16 ** slices,
      "the counter counted every rising edge",
    );
    return times;
  };
  // Each mode twice over, alternating, and the second of each kept: the
  // first run of anything pays the JIT's warm-up.
  timed({ mode: "full" });
  timed({});
  const fullTimes = timed({ mode: "full" });
  const times = timed({});
  const tickMs = mean(times);
  const fullMs = mean(fullTimes);
  timed({ spice: true, mode: "full" });
  timed({ spice: true });
  const spiceFullMs = mean(timed({ spice: true, mode: "full" }));
  const spiceMs = mean(timed({ spice: true }));
  // …and with two multimeters reading it (Spice Lite's own netlist: a
  // meter's shunt is a branch there), against the same desk without them.
  const metered = meteredDocument(doc);
  const meteredNet = buildNetlist(metered, new Map(), { inductors: "branch" });
  const timeOn = (d, n) => {
    const out = [];
    const last = drive(d, n, edges, { spice: true, before: () => (t0 = performance.now()), after: (e) => e > 0 && out.push(performance.now() - t0) }); // prettier-ignore
    assert.equal(countOf(d, n, last.netLevels), rising % 16 ** slices, "the metered board counted every rising edge"); // prettier-ignore
    return out;
  };
  timeOn(metered, meteredNet);
  timeOn(doc, netlist);
  const meteredMs = mean(timeOn(metered, meteredNet));
  const plainMs = mean(timeOn(doc, netlist));
  const meterLast = drive(metered, meteredNet, 4, { spice: true });
  const meterVolts = meterLast.bench.get("dmm1")?.volts;
  // (The series one its shunt in the lead, read off the solve as any.)
  const meterAmps = meterLast.bench.get("dmm2").amps;
  // The same with a context built every tick — what a tick cost before the
  // context was kept, and what it costs a caller that does not keep one.
  const freshTimes = [];
  drive(doc, netlist, edges, {
    fresh: true,
    mode: "incremental",
    before: () => (t0 = performance.now()),
    after: (e) => e > 0 && freshTimes.push(performance.now() - t0),
  });
  const prepStart = performance.now();
  prepareCircuit(doc, netlist);
  const prepMs = performance.now() - prepStart;

  // ── 3b. Work each settle mode performs (no observer: an observer makes
  //        the incremental settle hand out fresh maps every pass) ─────────
  const work = {};
  const spiceWork = {};
  for (const mode of ["full", "incremental"]) {
    work[mode] = {};
    drive(doc, netlist, edges, { mode, stats: work[mode] });
    spiceWork[mode] = {};
    drive(doc, netlist, edges, { mode, spice: true, stats: spiceWork[mode] });
  }
  const clusters = voltageTopology(doc, netlist, prepareCircuit(doc, netlist)).clusters.length; // prettier-ignore

  // ── 2. Where a tick goes ────────────────────────────────────────────────
  const split = { context: 0, settle: 0, step: 0, assemble: 0 };
  let mark = 0;
  let phase = null;
  const lap = (into) => {
    const now = performance.now();
    if (into) split[into] += now - mark;
    mark = now;
  };
  drive(doc, netlist, edges, {
    before: () => {
      phase = null;
      mark = performance.now();
    },
    observer: () => ({
      watch: NO_WATCH,
      round(kind) {
        lap(phase ?? "context");
        phase = kind;
      },
      chip() {},
    }),
    after: () => lap(phase === "step" ? "assemble" : phase),
  });

  // ── 3. Work: passes, and every chip evaluation ──────────────────────────
  const perTick = [];
  const perChip = new Map(); // compId → {ref, evals, fresh, changed}
  const lastIn = new Map();
  const lastOut = new Map();
  let current = null;
  drive(doc, netlist, edges, {
    observer: (e) => {
      current = { e, settle: 0, step: 0, solves: 0, evals: 0, fresh: 0 };
      perTick.push(current);
      let phase = null;
      return {
        watch: NO_WATCH,
        round(kind) {
          if (kind === "settle") {
            if (phase !== "settle") current.solves++;
            current.settle++;
          } else current.step++;
          phase = kind;
        },
        chip() {},
        evaluated(id, pins, outs) {
          const ins = [...pins.values()].join("");
          const out = [...outs.values()].join("");
          let c = perChip.get(id);
          if (!c) {
            const comp = doc.components.find((x) => x.id === id);
            c = { ref: comp.ref, evals: 0, fresh: 0, changed: 0 };
            perChip.set(id, c);
          }
          c.evals++;
          current.evals++;
          if (lastIn.get(id) !== ins) {
            c.fresh++;
            current.fresh++;
          }
          if (lastOut.get(id) !== out) c.changed++;
          lastIn.set(id, ins);
          lastOut.set(id, out);
        },
      };
    },
  });
  const edgesOnly = perTick.slice(1); // the Run tick is a cold start

  // ── Report ──────────────────────────────────────────────────────────────
  say(`Busy circuit, ${slices} slices: ${chips.length} chips, ${doc.components.length} components, ${netlist.nets.size} nets, ${doc.wires.length} wires (built + netlisted in ${buildMs.toFixed(0)} ms)`); // prettier-ignore
  say(`${edges} clock edges after the Run tick`);
  say();
  say("TIME PER TICK (no observer)");
  say(`  incremental  mean ${ms(tickMs)} ms   p50 ${ms(quantile(times, 0.5))}   p95 ${ms(quantile(times, 0.95))}   max ${ms(Math.max(...times))}`); // prettier-ignore
  say(`  mode "full"  mean ${ms(fullMs)} ms   p50 ${ms(quantile(fullTimes, 0.5))}   p95 ${ms(quantile(fullTimes, 0.95))}   max ${ms(Math.max(...fullTimes))}`); // prettier-ignore
  say(`  → incremental is ${(fullMs / tickMs).toFixed(2)}× faster per tick`);
  say(`  → at most ${Math.floor(1000 / tickMs)} ticks/s on this machine; a 100 Hz clock at ×1 asks for 200`); // prettier-ignore
  say(`  context prepared once in ${ms(prepMs)} ms; built afresh every tick instead: mean ${ms(mean(freshTimes))} ms`); // prettier-ignore
  say();
  say("TIME PER TICK UNDER SPICE LITE (no observer)");
  say(`  incremental  mean ${ms(spiceMs)} ms`);
  say(`  mode "full"  mean ${ms(spiceFullMs)} ms`);
  say(`  → incremental is ${(spiceFullMs / spiceMs).toFixed(2)}× faster per tick`); // prettier-ignore
  say(`  with two multimeters (DC volts on the clock, 10 A in series with the supply): mean ${ms(meteredMs)} ms against ${ms(plainMs)} ms without (${((100 * (meteredMs - plainMs)) / plainMs).toFixed(1)}%)`); // prettier-ignore
  say(`    they read ${meterVolts?.toFixed(3)} V and ${(meterAmps * 1000).toFixed(1)} mA (the supply delivers ${(meterLast.supplies.get("psu1").amps * 1000).toFixed(1)} mA)`); // prettier-ignore
  say();
  say("WORK PERFORMED PER SETTLE PASS (clock edges and the Run tick)");
  for (const mode of ["full", "incremental"]) {
    const w = work[mode];
    say(`  ${mode.padEnd(11)}  ${(w.evaluations / w.passes).toFixed(2).padStart(6)} chip evaluations   ${(w.resolutions / w.passes).toFixed(1).padStart(6)} net resolutions   (${w.passes} passes, ${w.solves} solves)`); // prettier-ignore
  }
  const inc = work.incremental;
  say(`  incremental passes: ${inc.coldPasses ?? 0} cold (a tick's first — nothing cached), ${inc.incrementalPasses ?? 0} piecewise`); // prettier-ignore
  say(`  fallbacks: scoped readings ${inc.scopedReadings ?? 0}   uncertain readings ${inc.uncertainReadings ?? 0}   capped solves ${inc.cappedSolves ?? 0}`); // prettier-ignore
  say();
  say(`VOLTAGE SIDE PER TICK UNDER SPICE LITE (${clusters} clusters)`);
  for (const mode of ["full", "incremental"]) {
    const w = spiceWork[mode];
    say(`  ${mode.padEnd(11)}  ${((w.clusterSolves ?? 0) / (edges + 1)).toFixed(1).padStart(6)} clusters solved   ${((w.bookings ?? 0) / (edges + 1)).toFixed(1).padStart(6)} booked at set voltage`); // prettier-ignore
  }
  say();
  const total = Object.values(split).reduce((a, b) => a + b, 0);
  say("WHERE A TICK GOES (observer timing rounds only — incremental, with fresh maps per pass for the observer)"); // prettier-ignore
  for (const [k, v] of Object.entries(split)) {
    say(`  ${k.padEnd(9)} ${ms(v / (edges + 1))} ms/tick  ${pct(v, total).padStart(6)}`); // prettier-ignore
  }
  say();
  say("PASSES PER TICK (clock edges)");
  for (const key of ["settle", "step", "solves"]) {
    const xs = edgesOnly.map((t) => t[key]);
    say(`  ${key.padEnd(7)} mean ${mean(xs).toFixed(2)}   max ${Math.max(...xs)}   [Run tick: ${perTick[0][key]}]`); // prettier-ignore
  }
  const hist = new Map();
  for (const t of edgesOnly) hist.set(t.settle, (hist.get(t.settle) ?? 0) + 1);
  say(`  settle passes → ticks: ${[...hist].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join("  ")}`); // prettier-ignore
  say();
  const evals = edgesOnly.reduce((a, t) => a + t.evals, 0);
  const fresh = edgesOnly.reduce((a, t) => a + t.fresh, 0);
  say("CHIP EVALUATIONS PERFORMED (incremental settle passes, clock edges)");
  say(`  ${evals} evaluations, ${(evals / edges).toFixed(1)} per tick; ${fresh} saw a changed input (${pct(fresh, evals)}) — the rest recomputed an answer the chip already had`); // prettier-ignore
  say();
  const byRef = new Map();
  for (const c of perChip.values()) {
    const g = byRef.get(c.ref) ?? { n: 0, evals: 0, fresh: 0, changed: 0 };
    g.n++;
    g.evals += c.evals;
    g.fresh += c.fresh;
    g.changed += c.changed;
    byRef.set(c.ref, g);
  }
  say(
    "  per part type          chips   evals/chip/tick   input changed   output changed",
  );
  for (const [ref, g] of [...byRef].sort((a, b) => b[1].evals - a[1].evals)) {
    say(`  ${ref.padEnd(22)} ${String(g.n).padStart(5)}   ${(g.evals / g.n / (edges + 1)).toFixed(2).padStart(15)}   ${pct(g.fresh, g.evals).padStart(13)}   ${pct(g.changed, g.evals).padStart(14)}`); // prettier-ignore
  }
  say();
  say("  per chip (busiest and quietest by changed input)");
  const ranked = [...perChip].sort((a, b) => b[1].fresh - a[1].fresh);
  const row = ([id, c]) =>
    `    ${id.padEnd(5)} ${c.ref.padEnd(9)} evals ${String(c.evals).padStart(6)}   input changed ${String(c.fresh).padStart(5)} (${pct(c.fresh, c.evals)})   output changed ${String(c.changed).padStart(5)}`; // prettier-ignore
  for (const r of ranked.slice(0, 4)) say(row(r));
  say("    …");
  for (const r of ranked.slice(-4)) say(row(r));
  return { lines, tickMs };
}

test(`engine bench — busy circuit, ${SLICES} slices, ${EDGES} edges`, () => {
  const { lines } = bench(SLICES, EDGES);
  console.log(`\n${lines.join("\n")}\n`);
});

/** Each CPU computer's desk, alone and with `copies` idle board sets beside it. */
function cpuDesk(ref, copies) {
  const url = new URL(`../../demos/${ref}.json`, import.meta.url);
  const demo = JSON.parse(readFileSync(url, "utf8"));
  const doc = structuredClone(demo.doc);
  let id = 100;
  for (let c = 1; c <= copies; c++) {
    for (const b of demo.doc.boards) doc.boards.push({ ...b, id: `bb${id++}`, x: b.x + 200 * c, group: `gx${c}` }); // prettier-ignore
  }
  const images = new Map();
  for (const comp of doc.components) {
    const guid = comp.params?.storage?.guid;
    if (guid && demo.images?.[guid]) images.set(comp.id, new Uint8Array(Buffer.from(demo.images[guid], "base64"))); // prettier-ignore
  }
  return { doc, images };
}

/** Mean µs a clock edge over `edges`, after a warm-up of as many. */
function cpuEdgeUs(doc, images, edges) {
  const netlist = buildNetlist(doc);
  const clockId = doc.components.find((c) => c.kind === "clock").id;
  const run = (n) => {
    const context = prepareCircuit(doc, netlist);
    const phase = new Map();
    let warm = new Map();
    let state = new Map();
    let prev = new Map();
    let carry = null;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      phase.set(clockId, i % 2 === 0 ? H : L);
      const r = tick({ document: doc, netlist, warmStart: warm, state, prevPinLevels: prev, clockPhase: phase, images, context, warm: carry, inPlace: true }); // prettier-ignore
      warm = r.liveLevels ?? r.netLevels;
      state = r.state;
      prev = r.pinLevels;
      carry = r.warm ?? null;
      for (const w of r.memWrites) {
        const img = images.get(w.compId);
        if (img && w.addr < img.length) img[w.addr] = w.value;
      }
    }
    return ((performance.now() - t0) / n) * 1000;
  };
  run(edges);
  return { nets: netlist.nets.size, us: run(edges) };
}

test("engine bench — the CPU example computers (issue #12)", () => {
  const edges = Number(process.env.BENCH_CPU_EDGES ?? 20000);
  const lines = [
    "CPU EXAMPLES — µs per clock edge (inPlace, as SimController)",
  ];
  for (const ref of ["W65C02", "Z80A"]) {
    for (const copies of [0, 3]) {
      const { doc, images } = cpuDesk(ref, copies);
      const { nets, us } = cpuEdgeUs(doc, images, edges);
      assert.ok(Number.isFinite(us) && us > 0);
      lines.push(`  ${ref.padEnd(7)} ${String(nets).padStart(5)} nets   ${us.toFixed(1).padStart(6)} µs   ${Math.round(1e6 / us / 2)} Hz clock`); // prettier-ignore
    }
  }
  console.log(`\n${lines.join("\n")}\n`);
});

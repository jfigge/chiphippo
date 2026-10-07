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
//      answer it already had (`observer.evaluated`, a third run).
//
// Not part of `make test` (it lives outside tests/): it asserts only that the
// fixture COUNTS correctly, so a number is never reported off a broken run.

import test from "node:test";
import assert from "node:assert/strict";

import { buildNetlist } from "../sim/netlist.js";
import { prepareCircuit, tick } from "../sim/engine.js";
import { H, L } from "../sim/levels.js";
import { partPinAddresses } from "../model/occupancy.js";
import { busyDocument } from "./busy-circuit.js";

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
 * each tick and handing `hooks.observer?.(edge)` to it.
 */
function drive(doc, netlist, edges, hooks = {}) {
  const clockId = doc.components.find((c) => c.kind === "clock").id;
  const clockPhase = new Map([[clockId, L]]);
  let warm = new Map();
  let state = new Map();
  let prevPins = new Map();
  let result = null;
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
    });
    hooks.after?.(e, result);
    warm = result.netLevels;
    state = result.state;
    prevPins = result.pinLevels;
  }
  return result;
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
  const times = [];
  let t0 = 0;
  const last = drive(doc, netlist, edges, {
    before: () => (t0 = performance.now()),
    after: (e, r) => {
      if (e > 0) times.push(performance.now() - t0);
      assert.equal(r.settled, true, `tick ${e} settled`);
    },
  });
  const rising = Math.ceil(edges / 2);
  assert.equal(
    countOf(doc, netlist, last.netLevels),
    rising % 16 ** slices,
    "the counter counted every rising edge",
  );
  const tickMs = mean(times);
  // The same with a context built every tick — what a tick cost before the
  // context was kept, and what it costs a caller that does not keep one.
  const freshTimes = [];
  drive(doc, netlist, edges, {
    fresh: true,
    before: () => (t0 = performance.now()),
    after: (e) => e > 0 && freshTimes.push(performance.now() - t0),
  });
  const prepStart = performance.now();
  prepareCircuit(doc, netlist);
  const prepMs = performance.now() - prepStart;

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
  say(`  mean ${ms(tickMs)} ms   p50 ${ms(quantile(times, 0.5))}   p95 ${ms(quantile(times, 0.95))}   max ${ms(Math.max(...times))}`); // prettier-ignore
  say(`  → at most ${Math.floor(1000 / tickMs)} ticks/s on this machine; a 100 Hz clock at ×1 asks for 200`); // prettier-ignore
  say(`  context prepared once in ${ms(prepMs)} ms; built afresh every tick instead: mean ${ms(mean(freshTimes))} ms`); // prettier-ignore
  say();
  const total = Object.values(split).reduce((a, b) => a + b, 0);
  say("WHERE A TICK GOES (observer timing rounds only)");
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
  say("CHIP EVALUATIONS (settle passes, clock edges)");
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

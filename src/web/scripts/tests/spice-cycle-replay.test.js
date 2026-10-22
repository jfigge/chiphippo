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

// A drawn cycle replayed from its record (features/02-cycle-replay.md): once
// an oscillation faster than the desk is drawn by its schedule
// (spice/cycles.js) and has shown that settling each of its segments does
// exactly what it did a cycle before, the segments are put back from that
// record instead of settled; and, with nothing recording the desk, it is
// woken a display frame at a time rather than a segment at a time. Each case
// here is run both ways — replayed, and with `spice.replay: false`, which
// settles every segment as the engine always did — and must end the same.

import test from "node:test";
import assert from "node:assert/strict";
import { H, L } from "../sim/levels.js";
import { driveSpice } from "../bench/drive-spice.js";
import { astable555, bench } from "./timing-fixtures.js";
import { FAST } from "./test-depth.js";

/** Run `doc` to `seconds` (ticked at that moment too) both ways. */
function bothWays(doc, seconds, opts = {}) {
  const run = (replay) => {
    const stats = {};
    const r = driveSpice(doc, { seconds, end: true, stats, spice: { replay }, ...opts }); // prettier-ignore
    return { ...r, stats };
  };
  return { replayed: run(true), settled: run(false) };
}

/** The digital board, exactly: levels, every part's state and read pins. */
function sameBoard(a, b, what) {
  assert.deepStrictEqual(a.result.netLevels, b.result.netLevels, `${what}: levels`); // prettier-ignore
  assert.deepStrictEqual(a.result.state, b.result.state, `${what}: state`);
  assert.deepStrictEqual(a.result.pinLevels, b.result.pinLevels, `${what}: pins`); // prettier-ignore
}

test("a steady 555 nothing reads is replayed, a frame at a time — and ends where settling every segment ends", () => {
  const { doc } = astable555({ ra: 1e3, rb: 10e3, c: 10e-9 });
  const { replayed, settled } = bothWays(doc, 0.5);
  assert.ok(replayed.result.analog.cycle, "drawn by its schedule");
  assert.equal(settled.stats.replays ?? 0, 0, "the reference settles every segment"); // prettier-ignore
  assert.ok(replayed.stats.replays > 0, "replayed");
  assert.ok(replayed.stats.settles * 20 < settled.stats.settles, `settles ${replayed.stats.settles} vs ${settled.stats.settles}`); // prettier-ignore
  assert.ok(replayed.ticks * 10 < settled.ticks, `ticks ${replayed.ticks} vs ${settled.ticks}`); // prettier-ignore
  sameBoard(replayed, settled, "at 0.5 s");
  // Its readout: the true period, measured off the segments it walked.
  const period = (r) => r.result.timing.get("u1").sections[0].period;
  assert.ok(Math.abs(period(replayed) - period(settled)) <= 1e-12 * period(settled), `${period(replayed)} vs ${period(settled)}`); // prettier-ignore
  assert.equal(replayed.result.analog.cycle.period, settled.result.analog.cycle.period); // prettier-ignore
});

test("while something records the desk, a drawn cycle is still woken segment by segment", () => {
  const { doc } = astable555({ ra: 1e3, rb: 10e3, c: 10e-9 });
  const { replayed, settled } = bothWays(doc, 0.05, { scope: true });
  assert.equal(replayed.ticks, settled.ticks, "the same wakes");
  assert.ok(replayed.stats.replays > 0, "its segments still replayed");
  sameBoard(replayed, settled, "at 50 ms");
});

/** A 74LS161 counting a fast 555's output: a CONSUMER of the cycle. */
function counterOn555(c) {
  const { doc, b, u } = astable555({ ra: 1e3, rb: 10e3, c });
  const k = b.seat("u2", "74LS161", "e55");
  b.vcc(k.get(16));
  b.gnd(k.get(8));
  for (const pin of [1, 7, 9, 10]) b.vcc(k.get(pin)); // CLR, ENP, LOAD, ENT
  for (const pin of [3, 4, 5, 6]) b.gnd(k.get(pin)); // A–D
  b.link(u.get(3), k.get(2)); // OUT → CLK
  return doc;
}

// (Ten seconds of each, both ways, ran green once — 30 s of wall time, too
// long to keep in every run: features/spice-perf/RESULTS.md, step 02.)
for (const c of [4.7e-9, 10e-9, 22e-9]) {
  const seconds = FAST ? 0.5 : 2;
  test(`a counter on a drawn 555 (C ${c * 1e9} nF) counts the same over ${seconds} s — every segment settled`, () => {
    const { replayed, settled } = bothWays(counterOn555(c), seconds);
    assert.ok(replayed.result.analog.cycle, "drawn by its schedule");
    assert.equal(replayed.stats.replays ?? 0, 0, "a counter in the scope: its state is new every cycle, never replayed"); // prettier-ignore
    assert.equal(replayed.ticks, settled.ticks);
    assert.deepStrictEqual(replayed.result.state.get("u2"), settled.result.state.get("u2")); // prettier-ignore
    sameBoard(replayed, settled, `at ${seconds} s`);
  });
}

test("a 555 switching a MOSFET is replayed, and ends where settling every segment ends", () => {
  // A chip reading the cycle (the MOSFET's gate) kept it from ever being
  // replayed: every segment woke the desk (the regrade, 2026-10-22). It is
  // taken into the cycle's scope now, with what it drives.
  const { doc, b, u } = astable555({ ra: 1e3, rb: 10e3, c: 10e-9 });
  const m = b.seat("m1", "nmos", "a58", { case: "TO-92", grade: "logic" });
  const rl = b.seat("rl", "resistor", "f58", { ohms: 470 });
  b.link(u.get(3), m.get(2));
  b.gnd(m.get(1));
  b.link(m.get(3), rl.get(1));
  b.vcc(rl.get(2));
  const { replayed, settled } = bothWays(doc, 0.5);
  assert.ok(replayed.stats.replays > 0, "replayed");
  assert.ok(replayed.ticks * 10 < settled.ticks, `ticks ${replayed.ticks} vs ${settled.ticks}`); // prettier-ignore
  sameBoard(replayed, settled, "at 0.5 s");
});

test("a drawn 555 whose wire drop comes and goes with its phase stays drawn", () => {
  // 120 mA into 22 Ω in one phase: its supply wire's drop read 1.17 mV,
  // then none, at alternate ticks, and each read ended the schedule.
  const { doc, b, u } = astable555({ ra: 1e3, rb: 10e3, c: 10e-9 });
  const r = b.seat("rr", "resistor", "a55", { ohms: 22 });
  b.link(r.get(1), u.get(3));
  b.gnd(r.get(2));
  const { ticks } = driveSpice(doc, { seconds: 0.2 });
  assert.ok(ticks < 40, `${ticks} ticks in 0.2 s`);
});

test("a supply's real move beside a drawn 555 is no phase of its cycle", () => {
  // A load switched on and off by a flag beside a drawn 555, on a supply
  // limited to 250 mA: back off, the supply returned to a value the cycle
  // had been seen at, and was held at its loaded volts for good.
  const { doc, b } = astable555({ ra: 1e3, rb: 10e3, c: 10e-9, capRef: "cap-ceramic" }); // prettier-ignore
  doc.components[0].params.currentLimit = 0.25;
  const q = b.seat("q1", "nmos", "a58", { case: "TO-220", grade: "logic" });
  const rl = b.seat("rl", "resistor", "f55", { ohms: 17 });
  b.signal("s1", q.get(2).replace(/^a/, "c"), "low");
  b.gnd(q.get(1));
  b.vcc(rl.get(1));
  b.link(rl.get(2), q.get(3));
  const on = (t) => t >= 0.1 && t < 0.2;
  const rails = [];
  driveSpice(doc, {
    seconds: 0.3,
    end: true,
    at: [0.1, 0.15, 0.2, 0.25],
    signals: (t) => new Map([["s1", on(t) ? "H" : "L"]]),
    onTick(now, res, inp) {
      if ([0.15, 0.25].some((p) => Math.abs(now - p) < 1e-9)) rails.push(res.nodeVolts.get(inp.netlist.netOfPoint.get("psu1.+"))); // prettier-ignore
    },
  });
  assert.ok(rails[0] < 4.9, `on: ${rails[0]} V`);
  assert.ok(rails[1] > 4.99, `off again: ${rails[1]} V`);
});

test("an LED behind a drawn 555 shows its brightness over the cycle, not one phase", () => {
  // Woken a frame at a time, its lamp was the phase each tick ended in —
  // 1.11, 1.03, 0.08 by turns at 6.8 kHz, a flicker for a dimmed LED.
  const { doc, b, u } = astable555({ ra: 1e3, rb: 10e3, c: 10e-9, capRef: "cap-ceramic" }); // prettier-ignore
  const rc = b.seat("rc", "resistor", "f55", { ohms: 220 });
  const d = b.seat("d1", "led", "f60", {});
  const q = b.seat("q1", "nmos", "a58", { case: "TO-92", grade: "logic" });
  b.link(u.get(3), q.get(2));
  b.gnd(q.get(1));
  b.link(d.get(2), q.get(3));
  b.vcc(rc.get(1));
  b.link(rc.get(2), d.get(1));
  const levels = [];
  driveSpice(doc, {
    seconds: 0.4,
    onTick(now, res) {
      if (now > 0.1 && res.analog.cycle) levels.push(res.lamps.get("d1").level);
    },
  });
  assert.ok(levels.length > 3, `${levels.length} drawn ticks`);
  const lo = Math.min(...levels);
  const hi = Math.max(...levels);
  assert.ok(hi - lo < 0.02, `${lo}…${hi}`);
  assert.ok(lo > 0.3 && hi < 0.8, `${lo}…${hi}`);
});

test("a 4060 counting its own oscillation is settled — its state is no cycle's", () => {
  const b = bench();
  const u = b.seat("u1", "CD4060B", "e10");
  b.vcc(u.get(16));
  b.gnd(u.get(8));
  b.gnd(u.get(12));
  const cap = b.seat("c1", "cap-ceramic", "a30", { farads: 100e-9 });
  b.link(cap.get(1), u.get(9));
  const r1 = b.seat("r1", "resistor", "a36", { ohms: 1e3 });
  b.link(r1.get(1), u.get(10));
  b.link(r1.get(2), cap.get(2));
  const r2 = b.seat("r2", "resistor", "a44", { ohms: 2.2e3 });
  b.link(r2.get(1), u.get(11));
  b.link(r2.get(2), cap.get(2));
  const { replayed, settled } = bothWays(b.doc, 0.3);
  assert.ok(replayed.result.analog.cycle, "drawn by its schedule");
  assert.equal(replayed.ticks, settled.ticks, "never steady: woken as before");
  sameBoard(replayed, settled, "at 0.3 s");
  assert.ok(replayed.result.state.get("u1").count > 900, "and it counted");
});

test("RESET pulled on a replayed cycle ends it at the same moment as settling every segment", () => {
  const { doc, b, u } = astable555({ ra: 1e3, rb: 10e3, c: 10e-9, reset: false }); // prettier-ignore
  b.signal("rst", u.get(4), "high");
  const signals = (t) => new Map([["rst", t >= 0.3 && t < 0.4 ? L : H]]);
  const ends = (replay) => {
    const seen = [];
    driveSpice(doc, { seconds: 0.5, end: true, signals, at: [0.3, 0.4], spice: { replay }, onTick: (now, r) => seen.push([now, r.analog.cycle != null]) }); // prettier-ignore
    return seen;
  };
  const a = ends(true);
  const s = ends(false);
  const endOf = (seen) => seen.find(([t, drawn]) => t >= 0.25 && !drawn)?.[0];
  assert.equal(endOf(a), 0.3, "replayed: it stops at the RESET");
  assert.equal(endOf(s), 0.3, "settled: likewise");
  assert.ok(a.at(-1)[1] && s.at(-1)[1], "and both are drawn again after it");
});

test("a memory chip anywhere on the desk: every segment settled", () => {
  const { doc, b } = astable555({ ra: 1e3, rb: 10e3, c: 10e-9 });
  const ram = b.seat("u3", "HM62256", "e40");
  b.vcc(ram.get(28));
  b.gnd(ram.get(14));
  const { replayed, settled } = bothWays(doc, 0.05);
  assert.equal(replayed.stats.replays ?? 0, 0);
  assert.equal(replayed.ticks, settled.ticks);
  sameBoard(replayed, settled, "at 50 ms");
});

test("a busy counter board beside a replayed 555 ends exactly where settling every segment ends", async () => {
  // Islands (features/00-bench-islands.md): the 555 on its own board and
  // supply. The counter board's own clock edges land between the cycle's
  // frames; its settles never read the 555.
  const { islandFixtures } = await import("../bench/islands-fixtures.js");
  const { doc } = islandFixtures().find((f) => f.name === "busy+555-fast");
  const { replayed, settled } = bothWays(doc, 0.1);
  assert.ok(replayed.stats.replays > 0, "replayed");
  assert.ok(replayed.stats.settles * 4 < settled.stats.settles, `settles ${replayed.stats.settles} vs ${settled.stats.settles}`); // prettier-ignore
  sameBoard(replayed, settled, "at 0.1 s");
});

test("a drawn cycle ends when a bench source on its timing network moves", () => {
  // A 555 astable with a flag driving THR/TRIG through 30 kΩ: raising the
  // flag shortens the charge, so the period after must be the HIGH flag's
  // period — not the LOW one's schedule drawn on past the change.
  const run = (sw) => {
    const { b, u, doc } = astable555({ ra: 1e3, rb: 10e3, c: 10e-9 });
    const r3 = b.seat("r3", "resistor", "a55", { ohms: 30e3 });
    b.link(r3.get(1), u.get(6));
    b.signal("s1", r3.get(2).replace(/^a/, "c"), "low");
    let period = null;
    driveSpice(doc, {
      seconds: 0.1,
      end: true,
      at: [0.05],
      signals: (now) => new Map([["s1", now >= sw ? H : L]]),
      onTick(now, res) {
        period = res.timing?.get("u1")?.sections?.[0]?.period ?? period;
      },
    });
    return period;
  };
  const high = run(-1);
  const low = run(1);
  assert.ok(Math.abs(high - low) / low > 0.03, "the flag moves the period");
  assert.ok(Math.abs(run(0.05) - high) / high < 0.01, "after the switch: the HIGH period"); // prettier-ignore
});

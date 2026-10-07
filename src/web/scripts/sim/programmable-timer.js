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

// programmable-timer.js — the CD4541B (SCHS085E): a 16-stage binary counter
// with its own RC oscillator in front and a latching output stage behind.
// Pure and DOM-free.
//
// The oscillator (Fig. 2) is RS (3) inverted and gated by the reset: that is
// the counter's clock, which "increments on positive-edge clock transitions"
// — so an external clock on RS counts on its FALLING edges, as a 4060's φI
// does. CTC (2) drives the clock out and RTC (1) its complement, which is
// what the RC network hangs off: Ctc from CTC to a junction, Rtc from RTC to
// it, Rs (≈ 2·Rtc, ≥ 10 kΩ) from RS to it; f = 1/(2.3·Rtc·Ctc). In that mode
// the part keeps the time itself and ignores the level its RS net settles at.
// With nothing on CTC or RTC, RS is an ordinary clock input.
//
// The output is the counter's stage N, picked by A and B (the Frequency
// Selection Table: 13, 10, 8 or 16 stages), through Fig. 1's output stage:
//   · MODE HIGH (recycle) passes the stage straight on, a square wave of
//     f/2^N;
//   · MODE LOW (single transition) latches it: the output changes after
//     2^(N−1) counts and stays until a MASTER RESET, or until MODE goes HIGH;
//   · Q/Q̄ SELECT inverts the result, so the output is LOW after a reset with
//     it LOW and HIGH with it HIGH (the Truth Table, pin 9).
// MASTER RESET HIGH clears the counter, stops the oscillator (its clock held
// LOW) and resets the latch. At power-up AUTO RESET LOW resets the part as it
// powers up and it counts at once; AUTO RESET HIGH leaves it waiting, not
// counting, until a MASTER RESET pulse has come and gone — "counting will not
// start until after a positive MASTER RESET pulse is applied and returns to a
// low level". The sheet asks for VDD above 5 V for a RELIABLE power-on reset;
// here it is always reliable.
//
// Above the cap (sim/timing.js) the oscillator is drawn at the cap's rate, as
// is a recycling output too fast to show; the counter keeps the TRUE count.

import { H, L, X, inv, xor } from "./levels.js";
import {
  capSchedule,
  scheduleAt,
  rebaseCount,
  TIMING_CAP_HZ,
  earliest,
  EPS,
} from "./timing.js";

/** SCHS085E: f = 1/(2.3·Rtc·Ctc). */
export const CD4541_K = 2.3;

/** The 4541's pins (SCHS085E pinout). */
const PIN = Object.freeze({
  RTC: 1,
  CTC: 2,
  RS: 3,
  AR: 5,
  MR: 6,
  OUT: 8,
  QSEL: 9,
  MODE: 10,
  A: 12,
  B: 13,
});

const defined = (level) => level === H || level === L;

/** The Frequency Selection Table: A, B → the number of stages N. */
export function cd4541Stages(a, b) {
  if (!defined(a) || !defined(b)) return null;
  if (a === L) return b === L ? 13 : 10;
  return b === L ? 8 : 16;
}

/** Read a 4541's oscillator network off the wiring (see the header). */
function analyze4541(probe) {
  const rtc = probe.net(PIN.RTC);
  const ctc = probe.net(PIN.CTC);
  const rs = probe.net(PIN.RS);
  const caps = probe.capacitors(ctc).filter((l) => l.far && l.far !== ctc);
  for (const junction of new Set(caps.map((l) => l.far))) {
    const rt = rtc && rtc !== junction ? probe.resistance(rtc, junction) : null;
    const rS = rs && rs !== junction ? probe.resistance(rs, junction) : null;
    if (rt == null || rS == null) continue;
    const c = probe.capacitance(ctc, junction);
    const period = CD4541_K * rt * c;
    return {
      sections: [
        { mode: "oscillator", r: rt, rs: rS, c, period, frequency: 1 / period },
      ],
      problems: [],
    };
  }
  if (!caps.length && !probe.resistors(rtc).length) {
    return { sections: [{ mode: "external", pin: "RS (3)" }], problems: [] };
  }
  return {
    sections: [{ mode: null }],
    problems: [{ code: "cd4541Incomplete" }],
  };
}

/** Did stage `n` read HIGH at any count from `c0` to `c1`? */
function everHigh(c0, c1, n) {
  const half = 2 ** (n - 1);
  const into = c0 % (2 * half);
  if (into >= half) return true;
  return c0 - into + half <= c1;
}

/** Stage `n`'s level at count `c`. */
const stageAt = (c, n) => (Math.floor(c / 2 ** (n - 1)) % 2 === 1 ? H : L);

/** When the `c`-th count (1, 2, …) of an oscillator started at `t0` lands:
    the clock starts LOW (a reset holds it there), so its first rising edge
    is half a period in. */
const countTime = (t0, period, c) => t0 + period / 2 + (c - 1) * period;

/** Counts an oscillator started at `t0` has made by `now`. */
const countsBy = (t0, period, now) =>
  Math.max(0, Math.floor((now - t0 + EPS) / period - 0.5) + 1);

/** The cap's own square wave — what a too-fast recycling output is drawn as. */
const CAP_WAVE = Object.freeze({
  cycle: [1 / (2 * TIMING_CAP_HZ), 1 / (2 * TIMING_CAP_HZ)],
  lead: [],
});

/**
 * The latch's next level (Fig. 1's cross-coupled pair), from the counts made
 * since the last step: recycle passes the stage, single transition holds a
 * HIGH it has seen. An unknown MODE keeps what both readings agree on.
 */
function nextLatch(latch, mode, n, c0, c1, unknownCount) {
  if (n == null || unknownCount) return latch === H && mode === L ? H : X;
  const recycle = stageAt(c1, n);
  const single = latch === H || everHigh(c0, c1, n) ? H : latch;
  if (mode === H) return recycle;
  if (mode === L) return single;
  return recycle === single ? recycle : X;
}

/** When the output of an RC-clocked run next changes on its own: the next
    flip of stage N while recycling (or of the cap's wave, when that is what
    is drawn), the one transition a single-transition run has still to make,
    or never. */
function nextChange({ t0, count, latch }, now, period, n, mode) {
  if (n == null) return null;
  const half = 2 ** (n - 1);
  if (mode !== L) {
    if (period * 2 ** n < 1 / TIMING_CAP_HZ) {
      return scheduleAt(CAP_WAVE, t0, now).next;
    }
    return countTime(t0, period, (Math.floor(count / half) + 1) * half);
  }
  if (latch === H) return null; // single transition: done
  return countTime(t0, period, count - (count % (2 * half)) + half);
}

const START = Object.freeze({ phase: "start" });

/** One tick of a 4541 (see the header). */
function step(state, ins, prev, env) {
  const a = env?.timing?.sections?.[0];
  const now = env?.now ?? 0;
  if (!a?.mode) return { phase: "idle" };
  const mr = ins.get(PIN.MR);
  let phase = state?.phase ?? "start";
  if (phase === "idle") phase = "start";

  if (phase === "start") {
    // Power-up: AUTO RESET LOW resets the part as it powers up, and it counts
    // from then on; HIGH leaves it waiting for a MASTER RESET pulse.
    const ar = ins.get(PIN.AR);
    if (!defined(ar)) return { phase: "unknown" };
    phase = ar === L ? "release" : "await";
  }
  if (!defined(mr)) return { phase: "unknown" };
  // MASTER RESET HIGH clears the counter and the latch and stops the
  // oscillator; its fall starts counting from nothing.
  if (mr === H) return { phase: "reset" };
  if (phase === "reset") phase = "release";
  if (phase === "unknown" || phase === "await") return { phase };

  const n = cd4541Stages(ins.get(PIN.A), ins.get(PIN.B));
  const mode = defined(ins.get(PIN.MODE)) ? ins.get(PIN.MODE) : X;
  const fresh = phase === "release";
  const latch = fresh ? L : state.latch;

  if (a.mode === "oscillator") {
    // A value changed while it runs (a pot turned) carries the count on at
    // the new rate rather than recounting from the reset (`rebaseCount`).
    let t0 = now;
    if (!fresh) {
      t0 =
        state.period === a.period
          ? state.t0
          : rebaseCount(state.period, a.period, state.t0, now);
    }
    const c0 = fresh ? 0 : state.count;
    const count = countsBy(t0, a.period, now);
    let level = nextLatch(latch, mode, n, c0, count, false);
    // A recycling output faster than the desk shows is drawn at the cap.
    if (mode === H && n != null && a.period * 2 ** n < 1 / TIMING_CAP_HZ) {
      level = scheduleAt(CAP_WAVE, t0, now).index % 2 === 0 ? H : L;
    }
    // The clock on CTC/RTC: LOW, then rising half a period in.
    const clock = scheduleAt(capSchedule([a.period / 2, a.period / 2]), t0, now); // prettier-ignore
    const next = { phase: "run", t0, period: a.period, count, latch: level };
    return {
      ...next,
      clock: clock.index % 2 === 0 ? L : H,
      wake: earliest(clock.next, nextChange(next, now, a.period, n, mode)),
    };
  }

  // External clock: the counter's clock is RS inverted, so it counts RS's
  // falling edges.
  const rs = ins.get(PIN.RS);
  const was = prev ? prev.get(PIN.RS) : rs;
  let count = fresh ? 0 : state.count;
  let unknown = fresh ? false : state.unknown;
  const c0 = count;
  if (was === H && rs === L) count += 1;
  else if (was !== rs && (was === X || rs === X)) unknown = true;
  return {
    phase: "run",
    count,
    unknown,
    latch: nextLatch(latch, mode, n, c0, count, unknown),
    // CTC/RTC follow RS live in this mode — see `outputs`.
    clock: null,
    wake: null,
  };
}

// ── The silicon (Spice Lite) ────────────────────────────────────────────────
//
// SCHS085E Figs. 1 and 2, as drawn: RS (3) read by an inverter, gated by the
// internal reset, into the counter's clock and out to CTC (2) and RTC (1);
// the counter, the stage selector, the latch and Q/Q̄ SELECT behind it,
// exactly as the digital part's — counting RS's falling edges. The RC
// network is the user's: Ctc from CTC and Rtc from RTC meeting at a junction,
// Rs from there to RS, the junction stepping past a rail as CTC switches
// (spice/coupling.js) and RS reading it behind Rs.
//
// Running, CTC is in phase with RS and RTC its complement. That is the only
// way round Fig. 2's network oscillates — Rtc must pull the junction AWAY
// from RS's level, Ctc must kick it further past — and so it is taken as the
// figure's meaning, though its bubbles read literally would put RTC in phase
// with RS, which latches. Stopped (a reset, or waiting for one), CTC is LOW
// and RTC HIGH, as the digital part shows it.

/** One tick of the 4541 as its silicon (see above): the digital part's
    external-clock counting, always — an RS oscillating faster than the desk
    shows counting `env.fast`'s true cycles from where it stood when that
    schedule began (spice/cycles.js; as the 4060's). */
function siliconStep(state, ins, prev, env) {
  const mr = ins.get(PIN.MR);
  let phase = state?.phase ?? "start";
  if (phase === "start") {
    const ar = ins.get(PIN.AR);
    if (!defined(ar)) return { phase: "unknown" };
    phase = ar === L ? "release" : "await";
  }
  if (!defined(mr)) return state?.phase === "unknown" ? state : { phase: "unknown" }; // prettier-ignore
  if (mr === H) return state?.phase === "reset" ? state : { phase: "reset" };
  if (phase === "reset") phase = "release";
  if (phase === "unknown" || phase === "await") {
    return state?.phase === phase ? state : { phase };
  }
  const n = cd4541Stages(ins.get(PIN.A), ins.get(PIN.B));
  const mode = defined(ins.get(PIN.MODE)) ? ins.get(PIN.MODE) : X;
  const fresh = phase === "release";
  const latch = fresh ? L : state.latch;
  const fast = env?.fast?.get(PIN.RS) ?? null;
  const rs = ins.get(PIN.RS);
  const was = prev ? prev.get(PIN.RS) : rs;
  let count = fresh ? 0 : state.count;
  let unknown = fresh ? false : state.unknown;
  const c0 = count;
  let base = null;
  if (fast) {
    const k = Math.floor(fast.cycles);
    base = !fresh && state?.fastId === fast.id ? state.base : count;
    count = base + k;
  } else if (was === H && rs === L) count += 1;
  else if (was !== rs && (was === X || rs === X)) unknown = true;
  const next = {
    phase: "run",
    count,
    unknown,
    latch: nextLatch(latch, mode, n, c0, count, unknown),
    period: fast?.period ?? null,
    fastId: base == null ? null : fast.id,
    base,
  };
  if (
    state?.phase === "run" &&
    next.count === state.count &&
    next.unknown === state.unknown &&
    next.latch === state.latch &&
    next.period === state.period &&
    next.fastId === state.fastId &&
    next.base === state.base
  ) {
    // prettier-ignore
    return state;
  }
  return next;
}

/** The 4541's silicon (spice/silicon.js): what Spice Lite evaluates in place
    of `cd4541Logic`. A recycling output too fast to show (its RS fast — its
    true `period`) is drawn as the clock itself, shown at the cap. */
export function cd4541Silicon() {
  return Object.freeze({
    state0: () => START,
    step: siliconStep,
    outputs(state, ins) {
      const phase = state?.phase;
      const running = phase === "run";
      const rs = ins?.get(PIN.RS) ?? X;
      let latch = running ? state.latch : phase === "unknown" ? X : L;
      const n = running ? cd4541Stages(ins.get(PIN.A), ins.get(PIN.B)) : null;
      if (
        running &&
        ins.get(PIN.MODE) === H &&
        n != null &&
        state.period != null &&
        state.period * 2 ** n < 1 / TIMING_CAP_HZ
      ) {
        // prettier-ignore
        latch = inv(rs);
      }
      const ctc = running ? rs : phase === "unknown" ? X : L;
      return new Map([
        [PIN.OUT, xor(latch, ins?.get(PIN.QSEL) ?? X)],
        [PIN.CTC, ctc],
        [PIN.RTC, inv(ctc)],
      ]);
    },
    // RTC and CTC are already output pins; RS an input — which Fig. 2's
    // junction reaches past a rail, Rs between them.
    overRail: [PIN.RS],
    readout: [{ pin: PIN.CTC, section: 0 }],
  });
}

/** The CD4541B's `logic` block. */
export function cd4541Logic() {
  return Object.freeze({
    state0: () => START,
    step,
    outputs(state, ins) {
      // Fig. 1: the latch, forced LOW by a reset, then Q/Q̄ SELECT's XOR —
      // so a part not counting shows the level a reset leaves. Fig. 2: CTC is
      // the clock and RTC its complement; a part not running holds its clock
      // LOW.
      const phase = state?.phase;
      const running = phase === "run";
      const latch = running ? state.latch : phase === "unknown" ? X : L;
      const clock = !running
        ? phase === "unknown"
          ? X
          : L
        : (state.clock ?? inv(ins.get(PIN.RS) ?? X));
      return new Map([
        [PIN.OUT, xor(latch, ins.get(PIN.QSEL) ?? X)],
        [PIN.CTC, clock],
        [PIN.RTC, inv(clock)],
      ]);
    },
    timing: analyze4541,
    wakeAt: (state) => state?.wake ?? null,
  });
}

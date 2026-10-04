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

// ripple-oscillator.js — the CD4060B: a 14-stage ripple counter with its own
// oscillator in front of it (SCHS049C). Pure and DOM-free.
//
// The counter advances on each NEGATIVE transition of φI (pin 11) — "and φO"
// — and a HIGH on RESET clears every stage and disables the oscillator. φ̄O
// (pin 10) is φI inverted, φO (pin 9) inverted again (Fig. 1). Two ways in:
//
//   RC oscillator  the Fig. 12 network: Cx from φO to a junction, Rx from φ̄O
//                  to it, Rs (2–10·Rx, for current limiting) from φI to it.
//                  T = 2.2·Rx·Cx. The part keeps the time itself and ignores
//                  the level its φI net happens to settle at.
//   external clock nothing on φO or φ̄O but what reads them: φI is an ordinary
//                  input, counted on its falling edges.
//
// A crystal (Fig. 13) is out of scope — the desk has no crystal to put there.
// A partial RC network is reported, not guessed at.
//
// Only Q4–Q10 and Q12–Q14 are brought out. Above the cap (sim/timing.js) the
// oscillator is shown at the cap's rate and every stage still too fast to show
// is drawn oscillating at it too; every slower stage reads the TRUE count, so a
// 32 kHz-ish oscillator still divides down to a correctly-timed Q14.

import { H, L, X, inv } from "./levels.js";
import {
  capSchedule,
  scheduleAt,
  rebaseCount,
  TIMING_CAP_HZ,
  earliest,
  EPS,
} from "./timing.js";

/** SCHS049C Fig. 12: T = 2.2·Rx·Cx. */
export const CD4060_K = 2.2;

/** The 4060's pins (SCHS049C functional diagram). */
const PIN = Object.freeze({ PHI_O: 9, PHI_ON: 10, PHI_I: 11, RESET: 12 });

/** Stage number → pin, for the stages that have one. */
export const STAGE_PINS = Object.freeze([
  [4, 7],
  [5, 5],
  [6, 4],
  [7, 6],
  [8, 14],
  [9, 13],
  [10, 15],
  [12, 1],
  [13, 2],
  [14, 3],
]);

const STAGES = 14;
const MODULO = 2 ** STAGES;

/** Read a 4060's oscillator network off the wiring (see the header). */
function analyze4060(probe) {
  const phiO = probe.net(PIN.PHI_O);
  const phiOn = probe.net(PIN.PHI_ON);
  const phiI = probe.net(PIN.PHI_I);
  const caps = probe.capacitors(phiO).filter((l) => l.far && l.far !== phiO);
  for (const junction of new Set(caps.map((l) => l.far))) {
    const rx =
      phiOn && phiOn !== junction ? probe.resistance(phiOn, junction) : null;
    const rs =
      phiI && phiI !== junction ? probe.resistance(phiI, junction) : null;
    if (rx == null || rs == null) continue;
    const c = probe.capacitance(phiO, junction);
    const period = CD4060_K * rx * c;
    return {
      sections: [
        { mode: "oscillator", rx, rs, c, period, frequency: 1 / period },
      ],
      problems: [],
    };
  }
  if (!caps.length && !probe.resistors(phiOn).length) {
    return { sections: [{ mode: "external", pin: "φI (11)" }], problems: [] };
  }
  return {
    sections: [{ mode: null }],
    problems: [{ code: "cd4060Incomplete" }],
  };
}

/** Every stage pin at one level (the cleared counter, an unknown one). */
const allStages = (level) => STAGE_PINS.map(() => level);

/**
 * The RC oscillator's outputs at `now`, for an oscillation that began at `t0`
 * with true period `period`: the φ level, each brought-out stage, and when
 * the next of them changes.
 */
function oscillatorAt(period, t0, now) {
  // φI starts HIGH, so its first falling edge — the first count — is half a
  // period in.
  const phi = scheduleAt(capSchedule([period / 2, period / 2]), t0, now);
  const phiLevel = phi.index % 2 === 0 ? H : L;
  const edges = Math.max(0, Math.floor((now - t0 + EPS) / period - 0.5) + 1);
  const count = edges % MODULO;
  const capWave = scheduleAt(
    { cycle: [1 / (2 * TIMING_CAP_HZ), 1 / (2 * TIMING_CAP_HZ)], lead: [] },
    t0,
    now,
  );
  const stages = [];
  const wakes = [phi.next];
  for (const [n] of STAGE_PINS) {
    // Stage n completes a cycle every 2^n periods: too fast to show, and it
    // is drawn oscillating at the cap; slow enough, and it reads the count.
    if (period * 2 ** n < 1 / TIMING_CAP_HZ) {
      stages.push(capWave.index % 2 === 0 ? H : L);
      wakes.push(capWave.next);
      continue;
    }
    const bit = (count >> (n - 1)) & 1;
    stages.push(bit ? H : L);
    // The next edge count at which this bit flips, and when that edge falls.
    const step = 2 ** (n - 1);
    const nextEdge = (Math.floor(edges / step) + 1) * step;
    wakes.push(t0 + period / 2 + (nextEdge - 1) * period);
  }
  return { phi: phiLevel, stages, wake: earliest(...wakes) };
}

/** One tick of a 4060 (see the header). */
function step(state, ins, prev, env) {
  const a = env?.timing?.sections?.[0];
  const now = env?.now ?? 0;
  const reset = ins.get(PIN.RESET);
  if (!a?.mode) {
    return { mode: "idle", stages: allStages(L), phi: L, wake: null };
  }
  if (reset === X) {
    return { mode: "unknown", stages: allStages(X), phi: X, wake: null };
  }

  if (a.mode === "oscillator") {
    // RESET HIGH clears the stages and stops the oscillator; the sheet does not
    // say where it stops, so φO is shown LOW (φ̄O HIGH) until it is released.
    if (reset === H) {
      return { mode: "held", stages: allStages(L), phi: L, wake: null };
    }
    // A value changed while it runs (a pot turned) carries the count on at the
    // new rate rather than recounting from Run (sim/timing.js `rebaseCount`).
    let t0 = now;
    if (state?.mode === "osc") {
      t0 =
        state.period === a.period
          ? state.t0
          : rebaseCount(state.period, a.period, state.t0, now);
    }
    const { phi, stages, wake } = oscillatorAt(a.period, t0, now);
    return { mode: "osc", t0, period: a.period, stages, phi, wake };
  }

  // External clock: an ordinary ripple counter on φI's falling edges.
  const phiI = ins.get(PIN.PHI_I);
  const was = prev ? prev.get(PIN.PHI_I) : phiI;
  let count = state?.mode === "ext" ? state.count : 0;
  let unknown = state?.mode === "ext" ? state.unknown : false;
  if (reset === H) {
    count = 0;
    unknown = false;
  } else if (was === H && phiI === L) {
    count = (count + 1) % MODULO;
  } else if (was !== phiI && (was === X || phiI === X)) {
    unknown = true; // a count that might have happened
  }
  return {
    mode: "ext",
    count,
    unknown,
    stages: STAGE_PINS.map(([n]) =>
      unknown ? X : (count >> (n - 1)) & 1 ? H : L,
    ),
    // φO/φ̄O follow φI live in this mode — see `outputs`.
    phi: null,
    wake: null,
  };
}

/** The CD4060B's `logic` block. */
export function cd4060Logic() {
  return Object.freeze({
    state0: () => ({ mode: "idle", stages: allStages(L), phi: L, wake: null }),
    step,
    outputs(state, ins) {
      const out = new Map();
      STAGE_PINS.forEach(([, pin], i) => out.set(pin, state?.stages?.[i] ?? L));
      // In the RC mode the part's own oscillator is φI; with an external clock
      // the buffers simply pass the pin along.
      const phi = state?.phi ?? ins?.get(PIN.PHI_I) ?? X;
      out.set(PIN.PHI_O, phi);
      out.set(PIN.PHI_ON, inv(phi));
      return out;
    },
    timing: analyze4060,
    wakeAt: (state) => state?.wake ?? null,
  });
}

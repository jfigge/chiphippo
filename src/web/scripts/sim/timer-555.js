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

// timer-555.js — the 555's behaviour: how it reads its own configuration off
// the wiring, and what its output does in time. Pure and DOM-free. Pinout and
// every formula are TI's NE555 datasheet (SLFS022K): §4 pin functions, §6.3.1
// monostable (tw ≅ 1.1·RA·C), §6.3.2 astable (tH ≅ 0.693·(RA+RB)·C, tL ≅
// 0.693·RB·C — equations 1 and 2), §6.4 the function table.
//
// THERE IS NO MODE SWITCH, because the real part has none. It works out what
// it is from where its pins go, as the silicon does:
//
//   astable     TRIG (2) and THRES (6) on ONE net with a capacitor from it to
//               GND; DISCH (7) on a net of its own, with RB from DISCH to that
//               capacitor net and RA from DISCH to VCC (Figure 6-5);
//   monostable  THRES (6) and DISCH (7) on one net with a capacitor to GND and
//               RA to VCC, TRIG (2) driven from outside (Figure 6-2);
//   bistable    THRES (6) tied to GND, TRIG (2) driven from outside: a set/
//               reset latch, read straight off the §6.4 function table — a
//               THRES held low never reaches ⅔ VCC, so TRIG LOW sets the
//               output HIGH (row 2), RESET LOW clears it (row 1) and otherwise
//               it stays as previously established (row 4). There is no
//               capacitor and nothing to time, and DISCH (7) plays no part:
//               grounded, open or pulled up, it changes nothing here;
//   anything else is NOT GUESSED: the part reports what is missing, and its
//               output stays LOW.
//
// RESET (4) LOW forces the output LOW and abandons the cycle, as §6.4 says;
// releasing it restarts an astable from the top, lets a monostable trigger
// again and leaves a bistable LOW. CONT (5) is not modelled — the thresholds
// are the standard ⅓/⅔ VCC whatever is on it (a bypass capacitor to GND is
// the usual and harmless thing). DISCH is a timing terminal here rather than
// an output: the discharge transistor's work is the timing, which the part
// keeps itself.

import { H, L, X } from "./levels.js";
import { capSchedule, scheduleAt, shownPulse, EPS } from "./timing.js";

/** The 555's pins (DIP-8, SLFS022K Table 4-1). */
export const PIN = Object.freeze({
  GND: 1,
  TRIG: 2,
  OUT: 3,
  RESET: 4,
  CONT: 5,
  THRES: 6,
  DISCH: 7,
  VCC: 8,
});

/** SLFS022K equations 1–2 (astable) and §6.3.1 (monostable). */
export const ASTABLE_K = 0.693;
export const MONOSTABLE_K = 1.1;

/** How a pin is named in a sentence: its silkscreen name and number. */
const PIN_LABEL = Object.freeze({
  2: "TRIG (2)",
  6: "THRES (6)",
  7: "DISCH (7)",
});

/**
 * Read a 555's configuration off its wiring.
 * @param {object} probe - sim/rc-trace.js `timingProbe` for this chip.
 * @returns {{sections: object[], problems: object[]}}
 */
export function analyze555(probe) {
  const trig = probe.net(PIN.TRIG);
  const thres = probe.net(PIN.THRES);
  const disch = probe.net(PIN.DISCH);
  const toGnd = probe.toRail("-");
  const toVcc = probe.toRail("+");
  const refuse = (...problems) => ({ sections: [{ mode: null }], problems });

  if (!thres) {
    return refuse({ code: "notConnected", pin: PIN_LABEL[6] });
  }

  if (probe.rail(thres) === "-") {
    // Bistable: THRES on GND can never reach ⅔ VCC, so only TRIG sets and
    // only RESET clears. Asked FIRST, because the usual way to wire one also
    // grounds DISCH, which puts THRES and DISCH on one net and would read as
    // a monostable missing its capacitor and RA.
    if (!trig || !probe.connected(trig)) {
      return refuse({ code: "notConnected", pin: PIN_LABEL[2] });
    }
    return { sections: [{ mode: "bistable" }], problems: [] };
  }
  const c = probe.capacitance(thres, toGnd);

  if (trig && trig === thres) {
    // Astable (Figure 6-5): the capacitor net is TRIG+THRES, DISCH sits
    // between RA (to VCC) and RB (to the capacitor).
    const problems = [];
    if (!c) {
      problems.push({ code: "noCapacitor", from: "TRIG/THRES (2, 6)", to: "GND" }); // prettier-ignore
    }
    const separate = disch && disch !== thres;
    const rb = separate ? probe.resistance(disch, thres) : null;
    const ra = separate ? probe.resistance(disch, toVcc) : null;
    if (!rb) {
      problems.push({ code: "noResistor", from: PIN_LABEL[7], to: "TRIG/THRES (2, 6)" }); // prettier-ignore
    }
    if (!ra) {
      problems.push({ code: "noResistor", from: PIN_LABEL[7], to: "VCC" });
    }
    if (problems.length) return refuse(...problems);
    const high = ASTABLE_K * (ra + rb) * c;
    const low = ASTABLE_K * rb * c;
    return {
      sections: [
        {
          mode: "astable",
          ra,
          rb,
          c,
          high,
          low,
          period: high + low,
          frequency: 1 / (high + low),
          duty: high / (high + low),
        },
      ],
      problems: [],
    };
  }

  if (disch && disch === thres) {
    // Monostable (Figure 6-2): THRES+DISCH is the capacitor net, charged
    // through RA from VCC; TRIG comes from outside.
    const problems = [];
    if (!c) {
      problems.push({ code: "noCapacitor", from: "THRES/DISCH (6, 7)", to: "GND" }); // prettier-ignore
    }
    const ra = probe.resistance(thres, toVcc);
    if (!ra) {
      problems.push({ code: "noResistor", from: "THRES/DISCH (6, 7)", to: "VCC" }); // prettier-ignore
    }
    if (!trig || !probe.connected(trig)) {
      problems.push({ code: "notConnected", pin: PIN_LABEL[2] });
    }
    if (problems.length) return refuse(...problems);
    return {
      sections: [{ mode: "monostable", ra, c, width: MONOSTABLE_K * ra * c }],
      problems: [],
    };
  }

  return refuse({ code: "ne555Unrecognised" });
}

/** The state of a 555 with nothing to do: output LOW. */
const IDLE = Object.freeze({ kind: null, out: L, wake: null });

/** The states whose output a bistable keeps when nothing sets or clears it —
    its own, and the two RESET leaves behind. Anything else (power-up, or what
    another mode left when the wiring changed) starts it LOW. */
const LATCHED = new Set(["bistable", "reset", "unknown"]);

/**
 * One tick of a 555. `env.timing` is its analysis (above), `env.now` the
 * simulated time; the output is a function of the two plus the moment the
 * current cycle or pulse began, so a repeated call at one `now` returns the
 * same state (the engine's step fixpoint depends on it).
 */
function step(state, ins, _prev, env) {
  const section = env?.timing?.sections?.[0];
  const now = env?.now ?? 0;
  if (!section?.mode) return IDLE;
  const reset = ins.get(PIN.RESET);
  if (reset === L) return { kind: "reset", out: L, wake: null };
  if (reset === X) return { kind: "unknown", out: X, wake: null };

  if (section.mode === "bistable") {
    // §6.4 row 2: TRIG below ⅓ VCC sets the output HIGH; row 4: otherwise it
    // holds (RESET LOW, row 1, was answered above and is remembered as LOW).
    // A TRIG that may or may not be low can only set, so it spoils a LOW and
    // leaves a HIGH alone.
    const held = LATCHED.has(state?.kind) ? state.out : L;
    const trig = ins.get(PIN.TRIG);
    const out = trig === L ? H : trig === X ? (held === H ? H : X) : held;
    return { kind: "bistable", out, wake: null };
  }

  if (section.mode === "astable") {
    // The cycle starts HIGH: a discharged capacitor sits below the trigger
    // level, which sets the flip-flop (§6.4, row 2).
    const schedule = capSchedule([section.high, section.low]);
    const t0 = state?.kind === "astable" ? state.t0 : now;
    const { index, next } = scheduleAt(schedule, t0, now);
    return { kind: "astable", t0, out: index % 2 === 0 ? H : L, wake: next };
  }

  // Monostable. TRIG below its threshold SETS the output (§6.4, row 2) — so a
  // falling edge starts a pulse, and a TRIG still held low when the time is up
  // holds the output high until it lets go (§6.3.1: "the sequence ends only
  // if TRIG is high … before the end of the timing interval"). A trigger
  // during the pulse changes nothing: the capacitor is already charging.
  const trig = ins.get(PIN.TRIG);
  if (trig === X) return { kind: "unknown", out: X, wake: null };
  const pulsing = state?.kind === "monostable" && state.until != null;
  if (trig === L) {
    const since = pulsing ? state.since : now;
    const until = pulsing ? state.until : now + shownPulse(section.width).width;
    return {
      kind: "monostable",
      since,
      until,
      out: H,
      wake: until > now + EPS ? until : null,
    };
  }
  if (pulsing && now < state.until - EPS) {
    return { ...state, out: H, wake: state.until };
  }
  return { kind: "monostable", since: null, until: null, out: L, wake: null };
}

/**
 * The 555's `logic` block: the standard sequential contract plus `timing`
 * (read its wiring) and `wakeAt` (when it next moves by itself).
 */
export function ne555Logic() {
  return Object.freeze({
    state0: () => IDLE,
    step,
    outputs: (state) => new Map([[PIN.OUT, state?.out ?? L]]),
    timing: analyze555,
    wakeAt: (state) => state?.wake ?? null,
  });
}

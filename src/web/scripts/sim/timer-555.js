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
//
// SPICE LITE (features/spice-lite.md §4). Handed `probe.curves`, the part
// times by its capacitor's REAL curve instead of the datasheet's rounded
// constants: ⅓→⅔ VCC charging toward VCC is τ·ln 2 (the sheet's 0.693), and
// 0→⅔ is τ·ln 3 (its 1.1) — the same numbers, from the physics. One thing
// the constants hide comes back: the capacitor starts EMPTY, so an astable's
// first HIGH charges it from 0 V and is ln 3 / ln 2 ≈ 1.58 × the others
// (`first`, a lead segment). And the capacitor's voltage is there to be
// probed (`nodeVolts`). The capacitor is no Spice Lite node (it is the
// part's), so it asks for the nodes' display frames itself while it moves
// (`curveMoving`) — waking only at its thresholds, it was drawn as straight
// lines from ⅓ to ⅔ VCC and back.

import { H, L, X } from "./levels.js";
import { capSchedule, scheduleAt, shownPulse, rebase, EPS } from "./timing.js";
import { timeToReach, valueAt } from "./spice/rc-curve.js";

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

/** The same constants read off the curve (Spice Lite): a unit-τ capacitor
    charging toward 1 from ⅓ to ⅔ (ln 2), discharging from ⅔ to ⅓ toward 0
    (ln 2), and charging from empty to ⅔ (ln 3). */
export const CURVE_K = Object.freeze({
  charge: timeToReach(1 / 3, 1, 1, 2 / 3),
  discharge: timeToReach(2 / 3, 0, 1, 1 / 3),
  first: timeToReach(0, 1, 1, 2 / 3),
});

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
    const curves = probe.curves === true;
    const high = (curves ? CURVE_K.charge : ASTABLE_K) * (ra + rb) * c;
    const low = (curves ? CURVE_K.discharge : ASTABLE_K) * rb * c;
    return {
      sections: [
        {
          mode: "astable",
          ra,
          rb,
          c,
          high,
          low,
          // The first HIGH from an empty capacitor (Spice Lite only).
          ...(curves ? { first: CURVE_K.first * (ra + rb) * c } : {}),
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
    const k = probe.curves === true ? CURVE_K.first : MONOSTABLE_K;
    return {
      sections: [{ mode: "monostable", ra, c, width: k * ra * c }],
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
    // level, which sets the flip-flop (§6.4, row 2). A value changed while it
    // runs (a pot turned) carries the cycle on at the new rate from where it
    // is, rather than replaying it from the start (sim/timing.js `rebase`).
    const { high, low, first = null } = section;
    const schedule = astableSchedule(high, low, first);
    let t0 = now;
    if (state?.kind === "astable") {
      const prevFirst = state.first ?? null;
      t0 =
        state.high === high && state.low === low && prevFirst === first
          ? state.t0
          : rebase(astableSchedule(state.high, state.low, prevFirst), schedule, state.t0, now); // prettier-ignore
    }
    const { index, next } = scheduleAt(schedule, t0, now);
    return {
      kind: "astable",
      t0,
      high,
      low,
      ...(first != null ? { first } : {}),
      out: astableHigh(index, first) ? H : L,
      wake: next,
    };
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

/** An astable's schedule: HIGH, LOW, HIGH… — or, from an empty capacitor
    (Spice Lite's `first`), the long first HIGH as a lead and then LOW,
    HIGH, LOW…. */
function astableSchedule(high, low, first) {
  return first != null ? capSchedule([low, high], [first]) : capSchedule([high, low]); // prettier-ignore
}

/** Whether schedule segment `index` is a HIGH one. */
function astableHigh(index, first) {
  if (first == null) return index % 2 === 0;
  return index === 0 || index % 2 === 0;
}

/**
 * The capacitor's voltage (Spice Lite): pin → volts at `now`, for the pin
 * whose net holds it (THRES), or null when there is nothing to show. The
 * schedule may be SHOWN slower than it runs (the cap), so a segment's shown
 * progress is mapped back onto its true length before the curve is read.
 * @param {object} timing - the 555's analysis
 * @param {object} state
 * @param {number} now
 * @param {number|null} vcc
 * @returns {Map<number, number>|null}
 */
function nodeVolts(timing, state, now, vcc) {
  const section = timing?.sections?.[0];
  if (!(vcc > 0) || !section?.mode) return null;
  if (section.mode === "astable" && state?.kind === "astable") {
    const { high, low, first = null, ra, rb, c } = section;
    const schedule = astableSchedule(high, low, first);
    const { index, next } = scheduleAt(schedule, state.t0, now);
    const lead = schedule.lead.length;
    const trueLength =
      index < lead ? first : [first != null ? low : high, first != null ? high : low][(index - lead) % 2]; // prettier-ignore
    const shownLength =
      index < lead ? schedule.lead[index] : schedule.cycle[(index - lead) % 2];
    const elapsed =
      Math.min(1, Math.max(0, 1 - (next - now) / shownLength)) * trueLength;
    const charge = (ra + rb) * c;
    const curve =
      index < lead
        ? { t0: 0, v0: 0, vInf: vcc, tau: charge }
        : astableHigh(index, first)
          ? { t0: 0, v0: vcc / 3, vInf: vcc, tau: charge }
          : { t0: 0, v0: (2 * vcc) / 3, vInf: 0, tau: rb * c };
    return new Map([[PIN.THRES, valueAt(curve, elapsed)]]);
  }
  if (section.mode === "monostable") {
    // Held empty by DISCH between pulses; charging through RA during one.
    const pulsing = state?.kind === "monostable" && state.until != null;
    if (!pulsing || now >= state.until) return new Map([[PIN.THRES, 0]]);
    const shown = state.until - state.since;
    const elapsed = ((now - state.since) / shown) * section.width;
    const curve = { t0: 0, v0: 0, vInf: vcc, tau: section.ra * section.c };
    return new Map([[PIN.THRES, valueAt(curve, elapsed)]]);
  }
  return null;
}

/**
 * Whether the capacitor's voltage is moving at `now` (Spice Lite): always,
 * while an astable runs; during a monostable's pulse. Held empty, or with no
 * capacitor to time, it is not.
 * @param {object} state
 * @param {number} now
 * @returns {boolean}
 */
function curveMoving(state, now) {
  if (state?.kind === "astable") return true;
  return (
    state?.kind === "monostable" &&
    state.until != null &&
    now < state.until - EPS
  );
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
    nodeVolts,
    curveMoving,
  });
}

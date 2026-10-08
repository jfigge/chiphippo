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
// THAT IS THE DIGITAL 555 (`logic`). Under Spice Lite the part is its silicon
// instead (`ne555Silicon`, below; spice/silicon.js): Figure 6-1's comparators,
// divider, latch, discharge transistor and output, reading the voltages on
// its pins — and astable, monostable or bistable is only what they do with
// what is wired to them.

import { H, L, X, Z } from "./levels.js";
import { capSchedule, scheduleAt, shownPulse, rebase, EPS } from "./timing.js";
import { openDrain } from "./spice/silicon.js";

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
    // level, which sets the flip-flop (§6.4, row 2). A value changed while it
    // runs (a pot turned) carries the cycle on at the new rate from where it
    // is, rather than replaying it from the start (sim/timing.js `rebase`).
    const { high, low } = section;
    const schedule = capSchedule([high, low]);
    let t0 = now;
    if (state?.kind === "astable") {
      t0 =
        state.high === high && state.low === low
          ? state.t0
          : rebase(capSchedule([state.high, state.low]), schedule, state.t0, now); // prettier-ignore
    }
    const { index, next } = scheduleAt(schedule, t0, now);
    return {
      kind: "astable",
      t0,
      high,
      low,
      out: index % 2 === 0 ? H : L,
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

// ── The silicon (Spice Lite) ────────────────────────────────────────────────
//
// SLFS022K Figure 6-1, as drawn: a divider of three equal resistors from VCC
// to GND, CONT (5) at its upper tap; a THRESHOLD comparator resetting the
// latch while THRES (6) is above CONT, and a TRIGGER comparator setting it
// while TRIG (2) is below the lower tap; RESET (4) clearing it while LOW, and
// winning ("RESET can override TRIG, which can override THRES"); the latch's
// output driving OUT through its bipolar stage (the def's `outputStage`) and,
// reset, turning on the open-collector discharge transistor on DISCH (7).
// Every number is the sheet's §5.5 typical, at the pin:

/** Figure 6-1 draws the divider as three EQUAL resistors (the ⅓ and ⅔ VCC
    levels of §5.5); their value, 5 kΩ each, is the classic NE555
    schematic's — SLFS022K does not print it. */
export const DIVIDER_OHMS = 5000;

/** RESET voltage level, 0.7 V typ (0.3–1 V). */
export const RESET_VOLTS = 0.7;

/** DISCH switch on-state voltage, 0.15 V typ at IO = 8 mA (VCC 5 V): the
    discharge transistor as 18.75 Ω to GND. */
export const DISCH_OHMS = 0.15 / 8e-3;

/** THRES current 30 nA typ, and TRIG current 0.5 µA typ (TRIG at 0 V): the
    comparators' INPUT BIAS currents, drawn only while each comparator's own
    input side conducts (`thresInput`, `trigInput`). §5.5 note 1 ties the
    THRES current to the most RA + RB may be (≅ 3.4 MΩ at VCC 5 V): it is the
    current the capacitor must still carry AT the trip point. Drawn for the
    whole cycle, as they once were, they aimed the capacitor 1.06 V short of
    VCC at RA = RB = 1 MΩ and stretched the period 54 %
    (features/spice-lite-3-plan.md, D2). */
export const THRES_AMPS = 30e-9;
export const TRIG_AMPS = 0.5e-6;

/** How far from its trip point a comparator's input turns its bias current
    on, volts — and as far past it, all of it flows; half of it at the trip
    point itself. A differential pair hands its tail current from one side to
    the other over about four thermal voltages (~0.1 V across, the TRIG
    pair's); the THRES comparator's Darlington inputs take twice that. */
export const TRIG_RAMP_V = 0.05;
export const THRES_RAMP_V = 0.1;

/** THRES's bias: an NPN (Darlington) base, its current INTO the pin — none
    while THRES sits more than `THRES_RAMP_V` under the upper tap, all of it
    as far past. The ramp is placed at the divider's own ⅔ VCC: a voltage
    forced onto CONT moves the trip point but not where this turns on (a
    30 nA difference). */
function thresInput(vcc) {
  return [
    {
      volts: (2 * vcc) / 3 - THRES_RAMP_V,
      ohms: (2 * THRES_RAMP_V) / THRES_AMPS,
      limit: THRES_AMPS,
      sources: false,
    },
  ];
}

/** TRIG's bias: the trigger comparator senses down to 0 V, so its inputs
    are PNPs, and the base current flows OUT of the pin — all of it below the
    lower tap less `TRIG_RAMP_V` (the sheet's "TRIG at 0 V"), none above it
    plus as much. At the divider's ⅓ VCC, as THRES's is at ⅔. */
function trigInput(vcc) {
  return [
    {
      volts: vcc / 3 + TRIG_RAMP_V,
      ohms: (2 * TRIG_RAMP_V) / TRIG_AMPS,
      limit: TRIG_AMPS,
      sources: true,
    },
  ];
}

/** RESET current: −0.4 mA (out of the pin) at 0 V, +0.1 mA (in) at VCC — a
    straight line through the two: 0.8·VCC behind VCC / 0.5 mA. */
const RESET_SOURCE_MA = 0.4;
const RESET_SINK_MA = 0.1;

/** Supply current, no load: 2 mA output HIGH, 3 mA LOW at VCC 5 V; 9 and
    10 mA at 15 V — their mean, along a straight line in VCC, less what the
    divider carries (the solve books that itself). */
function iccMa(vcc) {
  const mean = 2.5 + ((vcc - 5) * (9.5 - 2.5)) / (15 - 5);
  return Math.max(0, mean - vcc / (3 * DIVIDER_OHMS) * 1000); // prettier-ignore
}

/** The latch as power-up leaves it: reset (OUT LOW). */
const LATCH0 = Object.freeze({ q: L });

/**
 * The latch, from what the comparators read: RESET (above its 0.7 V, H)
 * LOW clears it and wins; TRIG below the lower tap (L) sets it, and wins over
 * THRES; THRES above CONT (H) clears it; otherwise it holds. A reading that
 * might be either spoils only what it could change.
 */
function latchStep(state, ins) {
  const q = state?.q ?? L;
  const reset = ins.get(PIN.RESET);
  const trig = ins.get(PIN.TRIG);
  const thres = ins.get(PIN.THRES);
  let next;
  if (reset === L) next = L;
  else if (reset === X) next = q === L ? L : X;
  else if (trig === L) next = H;
  else if (trig === X) next = q === H ? H : X;
  else if (thres === H) next = L;
  else if (thres === X) next = q === L ? L : X;
  else next = q;
  return next === q ? state : { q: next };
}

/**
 * The 555 as its silicon (spice/silicon.js): what Spice Lite evaluates in
 * place of `ne555Logic`. No timing is computed anywhere in it.
 */
export function ne555Silicon() {
  return Object.freeze({
    state0: () => LATCH0,
    step: latchStep,
    outputs(state) {
      const q = state?.q ?? L;
      return new Map([
        [PIN.OUT, q],
        // Reset, the discharge transistor is on; set, it is off.
        [PIN.DISCH, q === L ? L : q === H ? Z : X],
      ]);
    },
    sense: {
      [PIN.THRES]: { ref: PIN.CONT },
      [PIN.TRIG]: { ref: "tap" },
      [PIN.RESET]: { up: () => RESET_VOLTS },
    },
    drives: [PIN.DISCH],
    stages: { [PIN.DISCH]: openDrain(DISCH_OHMS) },
    inputs: {
      [PIN.THRES]: thresInput,
      [PIN.TRIG]: trigInput,
      [PIN.RESET]: (vcc) => {
        const ohms = vcc / ((RESET_SOURCE_MA + RESET_SINK_MA) / 1000);
        const volts = (RESET_SOURCE_MA / (RESET_SOURCE_MA + RESET_SINK_MA)) * vcc; // prettier-ignore
        return [
          { volts, ohms, limit: Number.POSITIVE_INFINITY, sources: true },
          { volts, ohms, limit: Number.POSITIVE_INFINITY, sources: false },
        ];
      },
    },
    internals: {
      nets: ["tap"],
      resistors: [
        { a: PIN.VCC, b: PIN.CONT, ohms: DIVIDER_OHMS },
        { a: PIN.CONT, b: "tap", ohms: DIVIDER_OHMS },
        { a: "tap", b: PIN.GND, ohms: DIVIDER_OHMS },
      ],
    },
    iccMa,
    // §5.3 recommended output current ±200 mA warns; §5.1's absolute
    // maximum ±225 mA, the sheet's only current figure, smokes — on OUT and
    // on DISCH alike.
    limits: {
      [PIN.OUT]: { warnMa: 200, smokeMa: 225 },
      [PIN.DISCH]: { warnMa: 200, smokeMa: 225 },
    },
    readout: [{ pin: PIN.OUT, section: 0 }],
  });
}

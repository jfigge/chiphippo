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

// monostable.js — the CD4000 multivibrators: the CD4047B (monostable or
// astable) and the dual retriggerable monostables (CD4098B, CD4538B). Pure
// and DOM-free; each part reads its own R and C off the wiring through the
// shared trace (sim/rc-trace.js) and turns them into time by ITS OWN
// datasheet, cited at each builder. The timing contract — `env.now`,
// `wakeAt`, the cap — is sim/timing.js's.
//
// A part whose timing components are missing reports which, and holds its
// outputs at the level the datasheet gives for "no pulse" (Q LOW, Q̄ HIGH).
// Unknown CMOS inputs follow the family's rule (catalog/families.js): a
// trigger or reset that might be either leaves the output unknown until a
// clean reset or trigger settles it.

import { H, L, X, and, or, inv } from "./levels.js";
import {
  capSchedule,
  scheduleAt,
  shownPulse,
  earliest,
  EPS,
} from "./timing.js";

// ── The dual monostables: CD4098B, CD4538B ───────────────────────────────────

/**
 * Read one dual monostable's timing components, section by section. A
 * section's capacitor sits between RX CX and CX — which the part ties to VSS
 * inside ("terminals 1, 8, 15 are electrically connected internally"), so a
 * capacitor from RX CX to GND is the same capacitor — and its resistor runs
 * from RX CX to VDD (the functional diagram). A section with neither and no
 * output in use is simply unused (Table I's "unused section" ties), and says
 * nothing.
 */
function analyzeDual(probe, k, sections) {
  const toVdd = probe.toRail("+");
  const toGnd = probe.toRail("-");
  const out = { sections: [], problems: [] };
  sections.forEach((s, i) => {
    const section = i + 1;
    const rxcx = probe.net(s.rxcx);
    const cx = probe.net(s.cx);
    const c = rxcx
      ? probe.capacitance(rxcx, (far) => (cx != null && far === cx) || toGnd(far)) // prettier-ignore
      : 0;
    const r = rxcx ? probe.resistance(rxcx, toVdd) : null;
    const used =
      c > 0 ||
      r != null ||
      probe.connected(probe.net(s.q)) ||
      probe.connected(probe.net(s.qn));
    if (!used) {
      out.sections.push({ section, mode: "unused" });
      return;
    }
    if (!c) {
      out.problems.push({
        code: "noCapacitor",
        section,
        from: `RX CX (${s.rxcx})`,
        to: `CX (${s.cx}) / GND`,
      });
    }
    if (r == null) {
      out.problems.push({
        code: "noResistor",
        section,
        from: `RX CX (${s.rxcx})`,
        to: "VDD",
      });
    }
    out.sections.push(
      c && r != null
        ? { section, mode: "monostable", r, c, width: k * r * c }
        : { section, mode: null },
    );
  });
  return out;
}

/**
 * The trigger a 4098/4538 section fires on: +TR OR NOT −TR, on its RISING
 * edge. That is what Table I's four connections require — leading-edge with
 * −TR at VDD (so +TR's rise fires it), trailing-edge with +TR at VSS (so −TR's
 * fall fires it) — and what makes its non-retriggerable hookups work: Q̄ fed
 * back to −TR, or Q to +TR, holds this HIGH for the whole pulse, so no new
 * rising edge can arrive until it ends.
 */
const dualTrigger = (ins, s) => or(ins.get(s.plus), inv(ins.get(s.minus)));

/** One section's next state (see dualMonostableLogic). */
function stepSection(prior, s, ins, prev, analysis, now) {
  if (analysis?.mode !== "monostable") return { until: null, unknown: false };
  const reset = ins.get(s.reset);
  // RESET is active LOW and immediate: it ends a pulse and holds Q LOW, and no
  // trigger is taken while it is held.
  if (reset === L) return { until: null, unknown: false };
  if (reset === X) return { until: null, unknown: true };
  let until = prior?.until ?? null;
  let unknown = prior?.unknown === true;
  if (until != null && now >= until - EPS) until = null; // the period is up
  const trig = dualTrigger(ins, s);
  const was = prev ? dualTrigger(prev, s) : trig;
  if (was === L && trig === H) {
    // RETRIGGERABLE: each trigger extends the pulse to one full period after
    // it (Table I note 1) — a fresh pulse and a restarted one are the same.
    until = now + shownPulse(analysis.width).width;
    unknown = false;
  } else if (trig !== was && (trig === X || was === X) && until == null) {
    unknown = true; // a trigger that might have happened
  }
  return { until, unknown };
}

/**
 * A dual retriggerable, resettable monostable (the CD4098B and the CD4538B
 * share one pinout, Table I and trigger logic; they differ only in how a
 * period follows from Rx and Cx — `k` in T = k·Rx·Cx).
 * @param {{k: number, sections: Array<{cx:number, rxcx:number, reset:number,
 *   plus:number, minus:number, q:number, qn:number}>}} cfg
 */
export function dualMonostableLogic({ k, sections }) {
  const idle = Object.freeze({
    sections: sections.map(() => ({ until: null, unknown: false })),
    wake: null,
  });
  return Object.freeze({
    state0: () => idle,
    step(state, ins, prev, env) {
      const now = env?.now ?? 0;
      const next = sections.map((s, i) =>
        stepSection(
          state?.sections?.[i],
          s,
          ins,
          prev,
          env?.timing?.sections?.[i],
          now,
        ),
      );
      return {
        sections: next,
        wake: earliest(...next.map((n) => n.until)),
      };
    },
    outputs(state) {
      const out = new Map();
      sections.forEach((s, i) => {
        const sec = state?.sections?.[i];
        const q = sec?.unknown ? X : sec?.until != null ? H : L;
        out.set(s.q, q);
        out.set(s.qn, inv(q));
      });
      return out;
    },
    timing: (probe) => analyzeDual(probe, k, sections),
    wakeAt: (state) => state?.wake ?? null,
  });
}

// ── The CD4047B ──────────────────────────────────────────────────────────────

/** SCHS044C's typical constants, in units of RC: Q/Q̄ period tA = 4.40 RC,
    OSC OUT period 2.20 RC (t1 = t2 = 1.1 RC), one-shot tM = 2.48 RC, whose
    first oscillator half-cycle t1' is 1.38 RC. */
export const CD4047 = Object.freeze({
  tA: 4.4,
  t1: 1.1,
  t2: 1.1,
  t1First: 1.38,
  tM: 2.48,
});

/** The 4047's pins (SCHS044C terminal diagram). */
const P4047 = Object.freeze({
  C: 1,
  R: 2,
  RC: 3,
  ASTABLE_N: 4,
  ASTABLE: 5,
  TRIG_N: 6,
  TRIG_P: 8,
  RESET: 9,
  Q: 10,
  QN: 11,
  RETRIGGER: 12,
  OSC: 13,
});

/** Read a 4047's R (terminals 2–3) and C (terminals 1–3) off the wiring. */
function analyze4047(probe) {
  const rc = probe.net(P4047.RC);
  const rNet = probe.net(P4047.R);
  const cNet = probe.net(P4047.C);
  const r = rc && rNet && rNet !== rc ? probe.resistance(rNet, rc) : null;
  const c = rc && cNet && cNet !== rc ? probe.capacitance(cNet, rc) : 0;
  const problems = [];
  if (r == null) {
    problems.push({ code: "noResistor", from: "R (2)", to: "RC COMMON (3)" });
  }
  if (!c) {
    problems.push({ code: "noCapacitor", from: "C (1)", to: "RC COMMON (3)" });
  }
  if (problems.length) return { sections: [{ mode: null }], problems };
  const rcs = r * c;
  return {
    sections: [
      {
        mode: "multivibrator",
        r,
        c,
        period: CD4047.tA * rcs,
        frequency: 1 / (CD4047.tA * rcs),
        oscPeriod: (CD4047.t1 + CD4047.t2) * rcs,
        width: CD4047.tM * rcs,
      },
    ],
    problems: [],
  };
}

const IDLE_4047 = Object.freeze({
  mode: "idle",
  q: L,
  osc: L,
  wake: null,
});

/**
 * One tick of a 4047 (SCHS044C). ASTABLE HIGH or ASTABLĒ LOW gates the
 * oscillator on: Q/Q̄ then square-wave at tA = 4.40 RC — the first positive
 * half-cycle tM, every one after it tA/2 — and OSC OUT runs at twice that.
 * Otherwise it is a one-shot: +TRIGGER rising while −TRIGGER is LOW (or −TRIGGER
 * falling while +TRIGGER is HIGH) starts a tM = 2.48 RC pulse, not
 * retriggered by another trigger; a rising RETRIGGER during the pulse restarts
 * it. EXTERNAL RESET HIGH holds Q LOW (and ends a pulse).
 */
function step4047(state, ins, prev, env) {
  const a = env?.timing?.sections?.[0];
  const now = env?.now ?? 0;
  if (a?.mode !== "multivibrator") return IDLE_4047;
  const reset = ins.get(P4047.RESET);
  const astable = or(ins.get(P4047.ASTABLE), inv(ins.get(P4047.ASTABLE_N)));
  if (astable === X || reset === X) {
    return { mode: "unknown", q: X, osc: X, wake: null };
  }
  const rc = a.r * a.c;

  if (astable === H) {
    // The oscillator: t1' + t2 first (that first positive half of Q is tM),
    // then t1 + t2 per cycle; Q toggles once per oscillator cycle.
    const schedule = capSchedule(
      [CD4047.t1 * rc, CD4047.t2 * rc],
      [CD4047.t1First * rc, CD4047.t2 * rc],
    );
    const t0 = state?.mode === "astable" ? state.t0 : now;
    const { index, next } = scheduleAt(schedule, t0, now);
    const osc = index % 2 === 0 ? H : L;
    const q = reset === H ? L : Math.floor(index / 2) % 2 === 0 ? H : L;
    return { mode: "astable", t0, q, osc, wake: next };
  }

  // Monostable.
  const trig = and(ins.get(P4047.TRIG_P), inv(ins.get(P4047.TRIG_N)));
  const was = prev
    ? and(prev.get(P4047.TRIG_P), inv(prev.get(P4047.TRIG_N)))
    : trig;
  const retrig = prev
    ? prev.get(P4047.RETRIGGER) === L && ins.get(P4047.RETRIGGER) === H
    : false;
  let start = state?.mode === "mono" ? state.start : null;
  let until = state?.mode === "mono" ? state.until : null;
  if (until != null && now >= until - EPS) {
    start = null;
    until = null;
  }
  if (reset === H) return { mode: "mono", start: null, until: null, q: L, osc: L, wake: null }; // prettier-ignore
  const shown = shownPulse(a.width).width;
  if ((was === L && trig === H && until == null) || (retrig && until != null)) {
    start = now;
    until = now + shown;
  }
  if (until == null) {
    return { mode: "mono", start: null, until: null, q: L, osc: L, wake: null }; // prettier-ignore
  }
  // During the pulse the oscillator makes its one long first half-cycle (t1'
  // HIGH, then t2 LOW: Fig. 33), scaled with the pulse if it was stretched.
  const oscEnd = start + shown * (CD4047.t1First / CD4047.tM);
  const osc = now < oscEnd - EPS ? H : L;
  return {
    mode: "mono",
    start,
    until,
    q: H,
    osc,
    wake: earliest(oscEnd > now + EPS ? oscEnd : null, until),
  };
}

/** The CD4047B's `logic` block. */
export function cd4047Logic() {
  return Object.freeze({
    state0: () => IDLE_4047,
    step: step4047,
    outputs: (state) =>
      new Map([
        [P4047.Q, state?.q ?? L],
        [P4047.QN, inv(state?.q ?? L)],
        [P4047.OSC, state?.osc ?? L],
      ]),
    timing: analyze4047,
    wakeAt: (state) => state?.wake ?? null,
  });
}

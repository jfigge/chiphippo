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

// spice/speakers.js — every speaker on a desk and what it plays. Pure and
// DOM-free. A speaker is a resistor to the solve (its coil — catalog/
// speaker.js `weakBridges`); what makes it a speaker is that the voltage
// across it is timed, at every settle (spice/engine.js `noteReadouts`), into
// a pitch (spice/measure.js `noteTone`), and the pitch and the power in its
// coil come back as the tick's `tones` for components/speaker-audio.js.
//
// Its coil HEATS, as an LED's junction and a regulator's die do (2026-10-22):
// the MEAN power in it between two ticks — the voltage across it read at
// every settle and along its curves between (`noteCoil`, `coilMeanWatts`),
// v² integrated — is followed by its heat, a first-order lag
// of `SPEAKER_HEAT_TAU_S`. Past its rating (catalog/speaker.js
// `SPEAKER_RATED_W`) it warns; at twice it (`SPEAKER_SMOKE_W`) the coil
// burns OPEN, in smoke, for the rest of the run — so the power-on surge into
// the capacitor in front of it, a few watts for a millisecond, heats it not
// at all, while 5 V straight across 8 Ω (3.1 W) burns it in 0.4 s.

import { partDef } from "../../catalog/index.js";
import {
  SPEAKER_RATED_W,
  SPEAKER_SMOKE_W,
  speakerParams,
} from "../../catalog/speaker.js";
import { partPinAddresses } from "../../model/occupancy.js";
import { toneOf } from "./measure.js";
import { resistorKey } from "./supply.js";

/** A voice coil's thermal time constant, seconds: a small speaker's coil
    warms over a second or so (its magnet over minutes, left out). An
    assumption — no small speaker's sheet states one. */
export const SPEAKER_HEAT_TAU_S = 1;

/** The longest stretch a heating coil is left unread, seconds: woken this
    often to read its power again, rather than burnt on one moment's. */
export const SPEAKER_HEAT_STEP_S = 0.1;

/** …and no further apart than would book this much of its burn at the
    power of one read: 12 V into 8 Ω through a capacitor is 18 W for the
    millisecond it charges, and booked across a whole step it burnt a coil
    that never warmed. */
const HEAT_GRAIN = 0.1;

const TOPOLOGY = new WeakMap(); // netlist → its speakers

/**
 * Every speaker on a desk whose two legs are on nets: `[{id, a, b, key,
 * impedance, volume}]` — `a` its + leg's net, `b` its −, `key` its coil's
 * resistor in the solve (spice/lamps.js `lampTopology`; burnt, it is open).
 * Once per netlist.
 * @param {object} doc
 * @param {{netOfPoint: Map}} netlist
 */
export function speakerTopology(doc, netlist) {
  const cached = TOPOLOGY.get(netlist);
  if (cached) return cached;
  const out = [];
  for (const comp of doc?.components ?? []) {
    if (comp.board == null || !partDef(comp.ref)?.speaker) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const atOf = (pin) => pins.find((p) => p.pin === pin)?.address ?? null;
    const netOf = (at) => (at ? (netlist.netOfPoint.get(at) ?? null) : null);
    const a = netOf(atOf(1));
    const b = netOf(atOf(2));
    if (!a || !b || a === b) continue;
    const { impedance, volume } = speakerParams(comp.params);
    const key = resistorKey(atOf(1), atOf(2));
    out.push({ id: comp.id, a, b, key, impedance, volume });
  }
  TOPOLOGY.set(netlist, out);
  return out;
}

/** A speaker's key in the timed voltages (`analog.tones`). */
export const toneKey = (id) => `spk:${id}`;

/**
 * What every speaker is playing at `now` (shown seconds): id → `{hz, vpp,
 * watts, volume}` — the pitch in true time, the swing across it, the power
 * that swing puts in its coil (a square's: half the swing, squared, over
 * its impedance) and its Volume setting. A silent speaker is not in it.
 * @param {Array<{id: string, impedance: number, volume: number}>} speakers
 * @param {Map<string, object>} tones - the `noteTone` marks
 * @param {number} now
 */
export function speakerTones(speakers, tones, now) {
  const out = new Map();
  for (const sp of speakers) {
    const tone = toneOf(tones.get(toneKey(sp.id)), now);
    if (!tone) continue;
    const watts = (tone.vpp / 2) ** 2 / sp.impedance;
    out.set(sp.id, { ...tone, watts, volume: sp.volume });
  }
  return out;
}

/**
 * ∫v² dt, V²·s, from `v0` to `v1` across `dt` seconds of a CURVE: an
 * exponential's own (the log mean) where the voltage decays toward zero
 * between the two readings — exact for the RC kick a coupling capacitor
 * gives a coil, which a straight line from a 12 V spike to the reading after
 * it booked a hundred times over — else the trapezoid.
 */
export function squareArea(v0, v1, dt) {
  if (!(dt > 0)) return 0;
  const a = v0 * v0;
  const b = v1 * v1;
  if (v0 * v1 > 0 && b < a * (1 - 1e-12)) {
    return ((a - b) * dt) / Math.log(a / b);
  }
  return ((a + b) / 2) * dt;
}

/**
 * Book one reading of the voltage across a speaker, `volts` at `t`, into its
 * coil's energy since it was last booked (`energy`: id → `{from, t, v, e}`,
 * `e` in V²·s from `from`). `along` says the reading is one taken along its
 * nodes' curves between two settles, so the stretch to it ran on that curve
 * (`squareArea`); a reading AT a settle says what the board jumped to there,
 * so the stretch before it stood at the last reading (a square's level held
 * to its next edge, whatever its duty). A reading earlier than the last one
 * (a replay walking its history again) books nothing; one at the same moment
 * is what that moment settled to.
 */
export function noteCoil(energy, id, volts, t, along = false) {
  if (!Number.isFinite(volts)) return;
  const was = energy.get(id);
  if (!was) {
    energy.set(id, { from: t, t, v: volts, e: 0 });
    return;
  }
  if (t < was.t) return;
  const dt = t - was.t;
  const area = along ? squareArea(was.v, volts, dt) : was.v * was.v * dt;
  energy.set(id, { from: was.from, t, v: volts, e: was.e + area });
}

/**
 * The MEAN power in a speaker's coil, watts, since it was last booked, the
 * voltage across it `volts` at `now`: its readings' ∫v² dt over the time
 * they span, over its impedance — so a PWM is booked at its duty, a sine at
 * half its crest's, a capacitor's kick at its energy, not at the peak of
 * any of them. The energy starts again from `now`. `{watts, span}` — the
 * mean and the seconds it is over — or null with nothing booked across any
 * time (a speaker's first reading).
 * @param {Map<string, object>} energy - `noteCoil`'s; updated in place
 * @param {{id: string, impedance: number}} sp
 * @param {number} volts
 * @param {number} now
 */
export function coilMeanWatts(energy, sp, volts, now) {
  noteCoil(energy, sp.id, volts, now);
  const was = energy.get(sp.id);
  energy.set(sp.id, { from: now, t: now, v: volts, e: 0 });
  const span = was.t - was.from;
  return span > 0 ? { watts: was.e / span / sp.impedance, span } : null;
}

/** A coil's heat, watts, `dt` seconds on from `heat`, carrying `watts`. */
export function speakerHeatAfter(heat, watts, dt) {
  return watts + (heat - watts) * Math.exp(-dt / SPEAKER_HEAT_TAU_S);
}

/** How long, seconds, from `heat` carrying `watts`, until the coil burns
    open (`SPEAKER_SMOKE_W`) — Infinity where it never will. */
export function speakerBurnIn(heat, watts) {
  if (!(watts > SPEAKER_SMOKE_W)) return Number.POSITIVE_INFINITY;
  if (heat >= SPEAKER_SMOKE_W) return 0;
  return (
    SPEAKER_HEAT_TAU_S * Math.log((watts - heat) / (watts - SPEAKER_SMOKE_W))
  );
}

/** How soon, seconds, a coil is read again: one heading past its burn at
    the burn, or sooner (`SPEAKER_HEAT_STEP_S`, `HEAT_GRAIN`); one warming
    past its rating, and no further, where it gets there — so its warning is
    said on a desk nothing else ticks; Infinity for one that will do
    neither. */
export function speakerReadIn(heat, watts) {
  if (
    watts > SPEAKER_RATED_W &&
    heat < SPEAKER_RATED_W &&
    !(watts > SPEAKER_SMOKE_W)
  ) {
    // prettier-ignore
    return SPEAKER_HEAT_TAU_S * Math.log((watts - heat) / (watts - SPEAKER_RATED_W)); // prettier-ignore
  }
  const due = speakerBurnIn(heat, watts);
  if (!Number.isFinite(due)) return due;
  const grain = (HEAT_GRAIN * SPEAKER_HEAT_TAU_S * SPEAKER_SMOKE_W) / watts;
  return Math.min(due, SPEAKER_HEAT_STEP_S, grain);
}

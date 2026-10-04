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

// analog-switch.js — the vocabulary of the parts that DRIVE NOTHING: the
// CD4066B's bilateral switches and the CD4051B/52B/53B multiplexers (Feature
// 410, phase 2b).
//
// Every other chip computes a level and puts it on a pin. These connect. Each
// CHANNEL is two terminals and a control rule: while the rule reads HIGH the
// channel JOINS its terminals' nets, so whatever drives one side drives the
// other — either way, which is how one 4051 is a multiplexer and a
// demultiplexer — and while it reads LOW the two sides are apart, each floating
// unless something else drives it. The joining is the engine's (engine.js
// `channelGroups` and `resolveAll`); a def only states its channels, as DATA:
//
//   { a, b, inputs, on }   terminal pins, the control pins the rule reads, and
//                          a pure `on(levels)` over those levels → H | L | X.
//
// The levels arrive read through the part's family reader, so a floating CMOS
// control reads X, and X means "might be on": the engine resolves the circuit
// with and without the channel and keeps what both agree on.
//
// Digital only, as the feature asks: a channel passes LEVELS. Its on-resistance
// and the analog voltages a real one carries are out of scope — which is also
// why a level crossing a channel loses its SUPPLY strength (a rail through a
// switch fights an output on the far side, as it would on a bench). The one
// place the on-resistance shows is the LED rule: at 5 V it limits an LED's
// current as a resistor would (catalog/families.js `ledLimit`).

import { H, L, X, overUnknowns } from "./levels.js";

/** A clean LSB-first list of levels → its number. */
const valueOf = (bits) =>
  bits.reduce((n, lv, i) => n + (lv === H ? 1 << i : 0), 0);

/**
 * Bilateral switches (CD4066B): switch k joins `a` and `b` while its own
 * `control` pin is HIGH.
 * @param {Array<{a:number, b:number, control:number}>} switches
 */
export function bilateralSwitches(switches) {
  return switches.map(({ a, b, control }) => ({
    a,
    b,
    inputs: [control],
    on: ([level]) => (level === H || level === L ? level : X),
  }));
}

/**
 * One analog multiplexer section (a CD4051B is one, a CD4052B two, a CD4053B
 * three): `common` is joined to `channels[k]` while INHIBIT is LOW and the
 * select pins read k (LSB first); INHIBIT HIGH joins nothing.
 * @param {{inh:number, sel:number[], common:number, channels:number[]}} m
 */
export function muxSection({ inh, sel, common, channels }) {
  return channels.map((pin, k) => ({
    a: common,
    b: pin,
    inputs: [inh, ...sel],
    on: (levels) =>
      overUnknowns(levels, ([inhibit, ...select]) =>
        inhibit === L && valueOf(select) === k ? H : L,
      ),
  }));
}

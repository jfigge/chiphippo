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

// pin-builders.js — the shorthand builders every catalog/chips-*.js file used
// to redeclare on its own (`pin`/`input`/`output`/`io`/`nc`/`gnd`/`vcc`, plus
// the `unit`/`buf3` logic-block builders). One shared source so a chip's pin
// table and the "logic is data, not per-chip code" vocabulary stay readable
// without every file hand-copying the same handful of one-liners.

/** A pin: number, silkscreen name, and electrical role. */
export const pin = (n, name, role) => ({ n, name, role });
export const input = (n, name) => pin(n, name, "input");
export const output = (n, name) => pin(n, name, "output");
/** A bidirectional (I/O) pin — a bus line a unit both reads and drives. */
export const io = (n, name) => pin(n, name, "io");
export const nc = (n) => pin(n, "NC", "nc");
/**
 * An RC TIMING terminal — where a timer's external resistor and capacitor
 * connect (a 555's THRES, a 4047's R and C, a 4098's RX CX). Neither a logic
 * input nor an output: the engine never reads or drives it, and the part
 * reads its R and C off the wiring instead (sim/rc-trace.js). So no floating-
 * input check, no boundary warning and no AI pin mark ever treats it as logic,
 * and KiCad draws it PASSIVE.
 */
export const timing = (n, name) => pin(n, name, "timing");
/** `name` overrides the silkscreen label (e.g. VSS/VDD on a CMOS memory part). */
export const gnd = (n, name = "GND") => pin(n, name, "gnd");
export const vcc = (n, name = "VCC") => pin(n, name, "vcc");

/** A logic unit: a gate (`inputs → output`) or a tri-state buffer. */
export const unit = (fn, inputs, output) => ({ fn, inputs, output });
/** A 74125-style tri-state buffer: `data` in, active-low `enable`, `output`. */
export const buf3 = (data, enable, output) => ({
  fn: "BUF3",
  inputs: [data],
  enable,
  output,
});

/**
 * A PASSIVE terminal: a pin the logic never reads or drives and that is no
 * supply — a ULN2003A's COM (its clamp diodes' common), an optocoupler's
 * phototransistor base. It shares the timing pin's role, which every consumer
 * already treats as exactly that (KiCad draws it PASSIVE).
 */
export const passive = (n, name) => pin(n, name, "timing");

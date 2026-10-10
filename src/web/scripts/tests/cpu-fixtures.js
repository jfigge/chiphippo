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

// cpu-fixtures.js — a CPU bench built in code for the CPU monitor's tests: a
// Z80A + 8K RAM wired as engine-z80.test.js wires it (/MREQ → /CE, /RD →
// /OE, /WR → /WE, A0–A12 only, so the RAM mirrors), on a manual clock.

import { partPinHoles } from "../model/occupancy.js";
import { holesOfNode, nodeOf } from "../model/breadboard.js";
import { powerClocks } from "./clock-power.js";

/** A free hole beside `pin` of a part at `anchor` on `board` (`type`); each
    call for one pin takes the next free hole on its strip. */
export function pinHole(board, type, ref, anchor) {
  const holes = new Map(partPinHoles(ref, anchor).map(({ pin, hole }) => [pin, hole])); // prettier-ignore
  const used = new Map();
  return (pin) => {
    const hole = holes.get(pin);
    const free = holesOfNode(type, nodeOf(type, hole)).filter((h) => h !== hole); // prettier-ignore
    const n = used.get(pin) ?? 0;
    used.set(pin, n + 1);
    return `${board}.${free[n]}`;
  };
}

export const boards = [
  { id: "bb1", type: "pins-full", x: 0, y: 4 },
  { id: "bb2", type: "rail-full", x: 0, y: 0 },
  { id: "bb3", type: "rail-full", x: 0, y: 18 },
  { id: "bb4", type: "pins-half", x: 0, y: 40 },
];
export const psu = { id: "psu1", kind: "psu", ref: "psu", x: 80, y: 0, params: { volts: 5 } }; // prettier-ignore
export const clock = { id: "clk1", kind: "clock", ref: "clock", x: 90, y: 0, params: { hz: "manual" } }; // prettier-ignore
export const chip = (id, ref, board, anchor) => ({ id, kind: "chip", ref, board, anchor, params: {} }); // prettier-ignore

export const MEM_A = [1, 2, 3, 4, 5, 6, 7, 8, 21, 22, 23, 24, 25];
export const MEM_D = [9, 10, 11, 12, 13, 17, 18, 19];
const Z80_A = [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 1, 2];
const Z80_D = [14, 15, 12, 8, 7, 9, 10, 13];

/** The Z80A (`c1`) + RAM (`c2`) document. */
export function z80Doc() {
  const cpu = pinHole("bb1", "pins-full", "Z80A", "e10");
  const ramAt = pinHole("bb1", "pins-full", "ram-8k", "e35");
  const w = [];
  const push = (from, to) => w.push({ id: `w${w.length}`, from, to });
  let hi = 1;
  let lo = 1;
  const HI = () => `bb2.+${hi++}`;
  const LO = () => `bb3.-${lo++}`;
  push("psu1.+", HI());
  push("psu1.-", LO());
  push("clk1.gnd", LO());
  push(cpu(11), HI());
  push(cpu(29), LO());
  push(ramAt(28), HI());
  push(ramAt(14), LO());
  for (let i = 0; i < 13; i++) push(cpu(Z80_A[i]), ramAt(MEM_A[i]));
  for (let i = 0; i < 8; i++) push(cpu(Z80_D[i]), ramAt(MEM_D[i]));
  push(cpu(19), ramAt(26)); // /MREQ → /CE
  push(cpu(21), ramAt(27)); // /RD → /OE
  push(cpu(22), ramAt(20)); // /WR → /WE
  push(cpu(6), "clk1.out");
  for (const p of [16, 17, 24, 25, 26]) push(cpu(p), HI());
  return powerClocks({
    boards,
    components: [psu, clock, chip("c1", "Z80A", "bb1", "e10"), chip("c2", "ram-8k", "bb1", "e35")], // prettier-ignore
    wires: w,
  });
}

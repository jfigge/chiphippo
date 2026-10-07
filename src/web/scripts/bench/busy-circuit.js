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

// busy-circuit.js — a LARGE, BUSY circuit for measuring the engine and the
// desk, built the way the AI builder builds one: a coordinate-free netlist
// spec handed to the compiler (model/autobuild.js), which seats and wires it.
// One clock drives everything, so every edge moves the whole board.
//
// Per SLICE (one hex digit of a synchronous counter):
//   · a 74LS161, its count chained to the next slice's (RCO → ENT);
//   · a 74LS47 decoding that digit onto a common-anode 7-segment display;
//   · a 74LS138 decoding its low three bits onto eight LEDs, one lit;
// and per PAIR of slices a 74LS283 adding the two digits onto an 8-LED bar.
// The low digit changes on every edge and each slice above it on a carry,
// so the low slices are always busy and the high ones mostly quiet — the
// shape of a real counter, which is what an event-driven engine would win on.

import { compileNetlist } from "../model/autobuild.js";

/** The netlist spec for `slices` counter digits. */
export function busySpec(slices = 8) {
  const parts = [{ id: "CLK1", ref: "clock" }];
  const nets = [
    { name: "CLKGND", members: ["CLK1.gnd", "GND"] },
    { name: "CLOCK", members: ["CLK1.out"] },
  ];
  const vcc = [];
  const gnd = [];
  const net = (name, ...members) => nets.push({ name, members });
  for (let s = 0; s < slices; s++) {
    const cnt = `CNT${s}`;
    const dec = `SEG${s}`;
    const ds = `DS${s}`;
    const one = `ONE${s}`;
    parts.push(
      { id: cnt, ref: "74LS161" },
      { id: dec, ref: "74LS47" },
      { id: ds, ref: "seg8ca" },
      { id: one, ref: "74LS138" },
    );
    nets[1].members.push(`${cnt}.CLK`);
    // Count, never load or clear; the first digit always enabled, each
    // later one on the carry out of the digit below it.
    vcc.push(`${cnt}.CLR`, `${cnt}.LOAD`, `${cnt}.ENP`);
    gnd.push(`${cnt}.A`, `${cnt}.B`, `${cnt}.C`, `${cnt}.D`);
    if (s === 0) vcc.push(`${cnt}.ENT`);
    else net(`CARRY${s}`, `CNT${s - 1}.RCO`, `${cnt}.ENT`);
    // Q → the seven-segment decoder, and its low three bits → the 1-of-8.
    const q = ["QA", "QB", "QC", "QD"];
    const bits = q.map((b) => [`${cnt}.${b}`]);
    ["A", "B", "C", "D"].forEach((p, i) => bits[i].push(`${dec}.${p}`));
    ["A", "B", "C"].forEach((p, i) => bits[i].push(`${one}.${p}`));
    vcc.push(`${dec}.LT`, `${dec}.BI`, `${dec}.RBI`, `${one}.G1`);
    gnd.push(`${one}.G2A`, `${one}.G2B`);
    net(`${ds}_COM`, `${ds}.A`, "VCC");
    for (const seg of "abcdefg") net(`${ds}_${seg}`, `${dec}.${seg}`, `${ds}.${seg}`); // prettier-ignore
    // The 1-of-8 is active LOW: each LED's anode on the rail, cathode on Y.
    for (let y = 0; y < 8; y++) {
      const led = `L${s}_${y}`;
      parts.push({ id: led, ref: "led" });
      net(`${led}_A`, `${led}.A`, "VCC");
      net(`${led}_K`, `${led}.K`, `${one}.Y${y}`);
    }
    // Every other slice: add this digit to the one below onto a bar.
    if (s % 2 === 1) {
      const add = `ADD${s}`;
      const bar = `BAR${s}`;
      parts.push({ id: add, ref: "74LS283" }, { id: bar, ref: "bar8" });
      ["A1", "A2", "A3", "A4"].forEach((p, i) => bits[i].push(`${add}.${p}`));
      ["B1", "B2", "B3", "B4"].forEach((p, i) =>
        nets
          .find((n) => n.members.includes(`CNT${s - 1}.${q[i]}`))
          .members.push(`${add}.${p}`),
      );
      gnd.push(`${add}.C0`);
      ["S1", "S2", "S3", "S4", "C4"].forEach((p, i) => net(`${bar}_${i + 1}`, `${add}.${p}`, `${bar}.${i + 1}`)); // prettier-ignore
      net(`${bar}_K`, `${bar}.K`, "GND");
    }
    q.forEach((b, i) => net(`Q${s}${b}`, ...bits[i]));
  }
  net("TIE_HIGH", ...vcc, "VCC");
  net("TIE_LOW", ...gnd, "GND");
  return { title: `Busy circuit — ${slices} counter slices`, parts, nets };
}

/**
 * The busy circuit as a desk document, its clock set running at `hz`.
 * Throws when the compiler refuses the spec (a fixture that does not build
 * measures nothing).
 */
export function busyDocument(slices = 8, { hz = 100 } = {}) {
  const out = compileNetlist(busySpec(slices));
  if (!out.ok) {
    throw new Error(`busy fixture refused: ${JSON.stringify(out.errors).slice(0, 600)}`); // prettier-ignore
  }
  const doc = out.document;
  for (const c of doc.components) {
    if (c.kind === "clock") c.params = { ...c.params, hz };
  }
  return doc;
}

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

// two-board-circuit.js — a chip-dense circuit sized to fill exactly TWO Full
// 830 kits, for measuring the engine and the desk on a design that spans
// boards. Like busy-circuit.js it is a coordinate-free netlist spec handed to
// the compiler (model/autobuild.js), which snaps the two kits together, shares
// the rail between them and runs the wires that cross from one to the other.
// One clock drives it, and nearly every edge moves nearly all of it:
//
//   · an 8-bit counter — two 74LS161s, RCO → ENT;
//   · its Gray code — seven XORs (two 74LS86s);
//   · a 16-bit LFSR — two 74LS164s, taps 16·14·13·11 XNORed in a third '86
//     (the fourth gate, one input tied high, is the inverter), so the all-zero
//     power-up state shifts out rather than locking up;
//   · the counter COMPARED with the LFSR's low byte — two cascaded 74LS85s
//     onto three LEDs;
//   · the Gray code ADDED to the LFSR's high byte — two 74LS283s onto a bar
//     and a carry LED, its low nibble on a 74LS47 and a 7-segment display.
//     Counter → XOR → ripple carry → decoder is the deepest settle on the
//     desk, and it crosses between the boards.

import { compileNetlist } from "../model/autobuild.js";
import { normalizeDocument } from "../model/desk-doc.js";

/** The netlist spec. */
export function twoBoardSpec() {
  const parts = [{ id: "CLK1", ref: "clock" }];
  const nets = [{ name: "CLKGND", members: ["CLK1.gnd", "GND"] }];
  const vcc = [];
  const gnd = [];
  const byName = new Map();
  const net = (name, ...members) => {
    const n = { name, members };
    nets.push(n);
    byName.set(name, n);
    return n;
  };
  const join = (name, ...members) => byName.get(name).members.push(...members);
  const part = (id, ref) => parts.push({ id, ref });

  part("CNTL", "74LS161");
  part("CNTH", "74LS161");
  part("SRL", "74LS164");
  part("SRH", "74LS164");
  net("CLOCK", "CLK1.out", "CNTL.CLK", "CNTH.CLK", "SRL.CLK", "SRH.CLK");

  // ── The counter: count, never load or clear; the high digit on the carry.
  const Q = ["QA", "QB", "QC", "QD"];
  for (const c of ["CNTL", "CNTH"]) {
    vcc.push(`${c}.CLR`, `${c}.LOAD`, `${c}.ENP`);
    gnd.push(`${c}.A`, `${c}.B`, `${c}.C`, `${c}.D`);
  }
  vcc.push("CNTL.ENT");
  net("CARRY", "CNTL.RCO", "CNTH.ENT");
  for (let i = 0; i < 8; i++) net(`CNT${i}`, `${i < 4 ? "CNTL" : "CNTH"}.${Q[i % 4]}`); // prettier-ignore

  // ── The LFSR: SRL's Q7 shifts into SRH; serial input A, B held high.
  vcc.push("SRL.CLR", "SRH.CLR", "SRL.B", "SRH.B");
  for (let i = 0; i < 16; i++) net(`LFSR${i}`, `${i < 8 ? "SRL" : "SRH"}.Q${i % 8}`); // prettier-ignore
  join("LFSR7", "SRH.A");
  part("FB", "74LS86");
  join("LFSR15", "FB.1A");
  join("LFSR13", "FB.1B");
  join("LFSR12", "FB.2A");
  join("LFSR10", "FB.2B");
  net("FB_X1", "FB.1Y", "FB.3A");
  net("FB_X2", "FB.2Y", "FB.3B");
  net("FB_X3", "FB.3Y", "FB.4A");
  vcc.push("FB.4B");
  net("FEEDBACK", "FB.4Y", "SRL.A");

  // ── Gray code: g7 = b7, g(i) = b(i) ^ b(i+1) — the adder's A input.
  part("GRAYL", "74LS86");
  part("GRAYH", "74LS86");
  const gray = [];
  for (let i = 0; i < 7; i++) {
    const gate = `${i < 4 ? "GRAYL" : "GRAYH"}.${(i % 4) + 1}`;
    join(`CNT${i}`, `${gate}A`);
    join(`CNT${i + 1}`, `${gate}B`);
    gray.push(net(`GRAY${i}`, `${gate}Y`).name);
  }
  gray.push("CNT7");
  gnd.push("GRAYH.4A", "GRAYH.4B"); // the spare gate

  // ── Compare the counter (A) with the LFSR's low byte (B).
  part("CMPL", "74LS85");
  part("CMPH", "74LS85");
  for (let i = 0; i < 8; i++) {
    const cmp = i < 4 ? "CMPL" : "CMPH";
    join(`CNT${i}`, `${cmp}.A${i % 4}`);
    join(`LFSR${i}`, `${cmp}.B${i % 4}`);
  }
  vcc.push("CMPL.IA=B");
  gnd.push("CMPL.IA<B", "CMPL.IA>B");
  for (const rel of ["A<B", "A=B", "A>B"]) {
    net(`CMP_${rel}`, `CMPL.${rel}`, `CMPH.I${rel}`);
    const led = `L_${rel.replace(/[<=>]/, { "<": "LT", "=": "EQ", ">": "GT" }[rel[1]])}`; // prettier-ignore
    part(led, "led");
    net(`${led}_A`, `CMPH.${rel}`, `${led}.A`);
    net(`${led}_K`, `${led}.K`, "GND");
  }

  // ── Add the Gray code to the LFSR's HIGH byte: a bar, a carry LED, a digit.
  part("ADDL", "74LS283");
  part("ADDH", "74LS283");
  part("SUMBAR", "bar8");
  net("SUMBAR_K", "SUMBAR.K", "GND");
  for (let i = 0; i < 8; i++) {
    const add = i < 4 ? "ADDL" : "ADDH";
    join(gray[i], `${add}.A${(i % 4) + 1}`);
    join(`LFSR${i + 8}`, `${add}.B${(i % 4) + 1}`);
    net(`SUM${i}`, `${add}.S${(i % 4) + 1}`, `SUMBAR.${i + 1}`);
  }
  gnd.push("ADDL.C0");
  net("SUM_C4", "ADDL.C4", "ADDH.C0");
  part("L_CARRY", "led");
  net("L_CARRY_A", "ADDH.C4", "L_CARRY.A");
  net("L_CARRY_K", "L_CARRY.K", "GND");

  part("SEG", "74LS47");
  part("DS", "seg8ca");
  ["A", "B", "C", "D"].forEach((p, i) => join(`SUM${i}`, `SEG.${p}`));
  vcc.push("SEG.LT", "SEG.BI", "SEG.RBI");
  net("DS_COM", "DS.A", "VCC");
  for (const seg of "abcdefg") net(`DS_${seg}`, `SEG.${seg}`, `DS.${seg}`);

  net("TIE_HIGH", ...vcc, "VCC");
  net("TIE_LOW", ...gnd, "GND");
  return { title: "Two-board circuit — counter, LFSR, compare, add", parts, nets }; // prettier-ignore
}

/** The pin-boards a document's design landed on. */
export function pinBoards(doc) {
  return doc.boards.filter((b) => b.type.startsWith("pins"));
}

/**
 * The two-board circuit as a desk document, its clock running at `hz`.
 * Throws when the compiler refuses the spec, or lays it on anything but two
 * pin-boards — a fixture that is not the shape it says measures the wrong
 * thing. Normalized, as the app loads it (see busy-circuit.js).
 */
export function twoBoardDocument({ hz = 100 } = {}) {
  const out = compileNetlist(twoBoardSpec());
  if (!out.ok) {
    throw new Error(`two-board fixture refused: ${JSON.stringify(out.errors).slice(0, 600)}`); // prettier-ignore
  }
  const doc = normalizeDocument(out.document);
  const pins = pinBoards(doc).length;
  if (pins !== 2) throw new Error(`two-board fixture landed on ${pins} pin-boards`); // prettier-ignore
  for (const c of doc.components) {
    if (c.kind === "clock") c.params = { ...c.params, hz };
  }
  return doc;
}

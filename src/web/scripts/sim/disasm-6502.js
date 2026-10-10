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

// disasm-6502.js — the W65C02S disassembler the CPU monitor shows its
// instruction pipeline with. PURE and DOM-free. It reads the core's OWN opcode
// table (w65c02.js `W65C02_OPCODES`), so what it prints is what the core runs:
// an undefined opcode is the NOP of the length the core skips, BRK is two bytes
// (the core's RTI returns past the signature byte), and BBRx/BBSx are three.
//
// Memory is read through `read(addr)`, which may answer null for a byte the
// monitor cannot see (an I/O hole, an address no memory chip answers): the
// line still decodes as far as it can, and an operand it could not read shows
// as `??`.

import { W65C02_OPCODES } from "./w65c02.js";

/** Instruction length by addressing mode. */
const LENGTH = Object.freeze({
  imp: 1,
  acc: 1,
  imm: 2,
  zp: 2,
  zpx: 2,
  zpy: 2,
  izx: 2,
  izy: 2,
  izp: 2,
  rel: 2,
  abs: 3,
  abx: 3,
  aby: 3,
  ind: 3,
  indx: 3,
  zprel: 3,
});

/** The short mode label the monitor prints beside each line. */
const MODE_LABEL = Object.freeze({
  imp: "IMP",
  acc: "ACC",
  imm: "IMM",
  zp: "ZP",
  zpx: "ZPX",
  zpy: "ZPY",
  izx: "IZX",
  izy: "IZY",
  izp: "IZP",
  rel: "REL",
  abs: "ABS",
  abx: "ABX",
  aby: "ABY",
  ind: "IND",
  indx: "IAX",
  zprel: "ZPR",
});

const hex2 = (v) => (v == null ? "??" : v.toString(16).toUpperCase().padStart(2, "0")); // prettier-ignore
const hex4 = (v) => (v == null ? "????" : v.toString(16).toUpperCase().padStart(4, "0")); // prettier-ignore
const signed = (b) => (b < 0x80 ? b : b - 256);

/** The operand text of one instruction, given its operand bytes. */
function operand(mode, addr, lo, hi) {
  const word = lo == null || hi == null ? null : lo | (hi << 8);
  const branch = (base, off) =>
    off == null ? "$????" : `$${hex4((base + signed(off)) & 0xffff)}`;
  switch (mode) {
    case "imm":
      return `#$${hex2(lo)}`;
    case "zp":
      return `$${hex2(lo)}`;
    case "zpx":
      return `$${hex2(lo)},X`;
    case "zpy":
      return `$${hex2(lo)},Y`;
    case "izx":
      return `($${hex2(lo)},X)`;
    case "izy":
      return `($${hex2(lo)}),Y`;
    case "izp":
      return `($${hex2(lo)})`;
    case "abs":
      return `$${hex4(word)}`;
    case "abx":
      return `$${hex4(word)},X`;
    case "aby":
      return `$${hex4(word)},Y`;
    case "ind":
      return `($${hex4(word)})`;
    case "indx":
      return `($${hex4(word)},X)`;
    case "acc":
      return "A";
    case "rel":
      return branch(addr + 2, lo);
    case "zprel":
      return `$${hex2(lo)},${branch(addr + 3, hi)}`;
    default:
      return "";
  }
}

/**
 * Decode the instruction at `addr`.
 * @param {(addr: number) => number|null} read - one byte, or null if unknown
 * @param {number} addr
 * @returns {{addr: number, length: number, bytes: Array<number|null>,
 *   text: string, mode: string, illegal: boolean}} — `illegal` for an
 *   undefined opcode (run as a NOP)
 */
export function disassemble6502(read, addr) {
  addr &= 0xffff;
  const opcode = read(addr);
  if (opcode == null) {
    return { addr, length: 1, bytes: [null], text: "??", mode: "", illegal: false }; // prettier-ignore
  }
  const entry = W65C02_OPCODES[opcode];
  // No entry: the core runs it as a one-byte NOP.
  const m = entry?.m ?? "NOP";
  const mode = entry?.a ?? "imp";
  const length = m === "BRK" ? 2 : LENGTH[mode];
  const bytes = [opcode];
  for (let i = 1; i < length; i++) bytes.push(read((addr + i) & 0xffff));
  const undef = !entry || m === "NOPR";
  const name =
    (m === "NOPR" ? "NOP" : m) + (entry?.bit != null ? String(entry.bit) : "");
  const ops = m === "BRK" ? "" : operand(mode, addr, bytes[1], bytes[2]);
  return {
    addr,
    length,
    bytes,
    text: ops ? `${name} ${ops}` : name,
    mode: MODE_LABEL[mode],
    illegal: undef,
  };
}

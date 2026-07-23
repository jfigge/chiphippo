/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// w65c02.js — the WDC W65C02S 8-bit microprocessor as a PURE, DOM-free state
// machine behind the STANDARD sequential contract ({ state0, step, outputs }).
// This is the CPU that makes the 65xx breadboard computer actually RUN: place it
// with ROM/RAM (and a W65C22 VIA for I/O), wire the address + data buses, and
// clock PHI2 — one bus access per clock cycle, exactly like the real part, so the
// address bus advances visibly and you can single-step.
//
// ── How it stays pure PLAIN DATA (no generators) ─────────────────────────────
// The engine threads sequential state as an opaque value and calls `outputs`
// many times per settle (must be pure) and `step` once per tick. A cycle-stepped
// 6502 needs to SUSPEND mid-instruction on every memory access — so instead of a
// generator (unserialisable, mutation-spooky) the state is just registers plus a
// small `log` of the bytes already returned for THIS instruction's accesses. Each
// cycle a clean SYNCHRONOUS 6502 interpreter re-runs from the committed
// registers, replaying `log` for accesses already done and THROWING at the first
// new access — that throw's address/data is what the CPU drives next cycle. When
// the interpreter runs to completion the instruction is done: commit the new
// registers, clear the log, and begin the next op. Re-execution is fully
// deterministic and cheap (≤7 accesses per instruction).
//
// ── Bus protocol ─────────────────────────────────────────────────────────────
// The CPU drives A0–A15 + RWB from its pending access every cycle. On a READ it
// floats D0–D7 (memory drives them) and latches the byte on PHI2's FALLING edge;
// on a WRITE it drives D0–D7 with RWB low. SYNC is high during an opcode fetch.
// Reset boots from the $FFFC/$FFFD vector; IRQ ($FFFE), NMI ($FFFA), and BRK are
// serviced at instruction boundaries. The chip powers up already IN reset, so it
// boots on Run without an explicit RESB pulse (wire RESB to hold it if you want).
//
// ── Scope (all faithful to the rest of this zero-delay sim) ───────────────────
//   • BUS-access-accurate, not dummy-cycle-exact: every access (address, R/W,
//     data) is correct and in order, but the 6502's purely-internal dummy cycles
//     are omitted, so instruction cycle counts run a touch short of the datasheet.
//   • Full documented WDC 65C02 instruction set (base 6502 + BRA, STZ, PHX/PHY/
//     PLX/PLY, INC/DEC A, (zp), JMP (abs,x), TRB/TSB, BBRx/BBSx, RMBx/SMBx, WAI,
//     STP). Undefined opcodes act as 1-byte NOPs. Decimal-mode ADC/SBC is
//     implemented (binary flags exact; BCD flag corners approximate). SOB is not
//     modelled.

import { H, L, Z } from "./levels.js";

// ── Status flags ─────────────────────────────────────────────────────────────
const C = 0x01;
const ZF = 0x02;
const I = 0x04;
const D = 0x08;
const B = 0x10;
const U = 0x20;
const V = 0x40;
const N = 0x80;

const setF = (cpu, mask, on) =>
  (cpu.p = on ? cpu.p | mask : cpu.p & ~mask & 0xff);
const getF = (cpu, mask) => (cpu.p & mask) !== 0;
const setNZ = (cpu, v) => {
  v &= 0xff;
  setF(cpu, ZF, v === 0);
  setF(cpu, N, (v & 0x80) !== 0);
};
const signed = (b) => (b < 0x80 ? b : b - 256);

// ── The suspend sentinel: thrown by the bus at the first un-replayed access ───
const SUSPEND = Symbol("cpu-suspend");

/** A replay bus over `log`: served entries return; the first new access throws. */
function makeBus(log) {
  let i = 0;
  const bus = {
    pending: null,
    read(addr) {
      addr &= 0xffff;
      if (i < log.length) return log[i++];
      bus.pending = { addr, rw: "r", dout: 0 };
      throw SUSPEND;
    },
    write(addr, val) {
      addr &= 0xffff;
      if (i < log.length) {
        i++;
        return;
      }
      bus.pending = { addr, rw: "w", dout: val & 0xff };
      throw SUSPEND;
    },
  };
  return bus;
}

// ── ALU helpers ──────────────────────────────────────────────────────────────
function adc(cpu, v) {
  const carry = getF(cpu, C) ? 1 : 0;
  if (getF(cpu, D)) {
    let lo = (cpu.a & 0x0f) + (v & 0x0f) + carry;
    let hi = (cpu.a >> 4) + (v >> 4);
    if (lo > 9) {
      lo += 6;
      hi += 1;
    }
    const bin = cpu.a + v + carry;
    setF(cpu, ZF, (bin & 0xff) === 0);
    setF(cpu, V, (~(cpu.a ^ v) & (cpu.a ^ (hi << 4)) & 0x80) !== 0);
    setF(cpu, N, (hi & 0x08) !== 0);
    if (hi > 9) hi += 6;
    setF(cpu, C, hi > 15);
    cpu.a = ((hi << 4) | (lo & 0x0f)) & 0xff;
  } else {
    const sum = cpu.a + v + carry;
    setF(cpu, C, sum > 0xff);
    setF(cpu, V, (~(cpu.a ^ v) & (cpu.a ^ sum) & 0x80) !== 0);
    cpu.a = sum & 0xff;
    setNZ(cpu, cpu.a);
  }
}

function sbc(cpu, v) {
  const borrow = getF(cpu, C) ? 0 : 1;
  const bin = cpu.a - v - borrow;
  if (getF(cpu, D)) {
    let lo = (cpu.a & 0x0f) - (v & 0x0f) - borrow;
    let hi = (cpu.a >> 4) - (v >> 4);
    if (lo < 0) {
      lo -= 6;
      hi -= 1;
    }
    if (hi < 0) hi -= 6;
    setF(cpu, C, bin >= 0);
    setF(cpu, V, ((cpu.a ^ v) & (cpu.a ^ (bin & 0xff)) & 0x80) !== 0);
    setNZ(cpu, bin & 0xff);
    cpu.a = ((hi << 4) | (lo & 0x0f)) & 0xff;
  } else {
    setF(cpu, C, bin >= 0);
    setF(cpu, V, ((cpu.a ^ v) & (cpu.a ^ bin) & 0x80) !== 0);
    cpu.a = bin & 0xff;
    setNZ(cpu, cpu.a);
  }
}

function cmp(cpu, reg, v) {
  const t = reg - v;
  setF(cpu, C, reg >= v);
  setNZ(cpu, t & 0xff);
}

function bitTest(cpu, v, mode) {
  setF(cpu, ZF, (cpu.a & v) === 0);
  if (mode !== "imm") {
    setF(cpu, N, (v & 0x80) !== 0);
    setF(cpu, V, (v & 0x40) !== 0);
  }
}

/** Shift/rotate/inc/dec on a value; sets flags; returns the 8-bit result. */
function rmwValue(cpu, m, v) {
  v &= 0xff;
  let r;
  switch (m) {
    case "ASL":
      setF(cpu, C, (v & 0x80) !== 0);
      r = (v << 1) & 0xff;
      break;
    case "LSR":
      setF(cpu, C, (v & 0x01) !== 0);
      r = v >> 1;
      break;
    case "ROL":
      r = ((v << 1) | (getF(cpu, C) ? 1 : 0)) & 0xff;
      setF(cpu, C, (v & 0x80) !== 0);
      break;
    case "ROR":
      r = ((v >> 1) | (getF(cpu, C) ? 0x80 : 0)) & 0xff;
      setF(cpu, C, (v & 0x01) !== 0);
      break;
    case "INC":
      r = (v + 1) & 0xff;
      break;
    default: // DEC
      r = (v - 1) & 0xff;
      break;
  }
  setNZ(cpu, r);
  return r;
}

// ── Addressing: each returns the effective address, consuming operand bytes ───
function effectiveAddr(cpu, bus, mode) {
  const fetch = () => {
    const v = bus.read(cpu.pc);
    cpu.pc = (cpu.pc + 1) & 0xffff;
    return v;
  };
  switch (mode) {
    case "imm": {
      const a = cpu.pc;
      cpu.pc = (cpu.pc + 1) & 0xffff;
      return a;
    }
    case "zp":
      return fetch();
    case "zpx":
      return (fetch() + cpu.x) & 0xff;
    case "zpy":
      return (fetch() + cpu.y) & 0xff;
    case "abs": {
      const lo = fetch();
      return lo | (fetch() << 8);
    }
    case "abx": {
      const lo = fetch();
      return ((lo | (fetch() << 8)) + cpu.x) & 0xffff;
    }
    case "aby": {
      const lo = fetch();
      return ((lo | (fetch() << 8)) + cpu.y) & 0xffff;
    }
    case "izx": {
      const z = (fetch() + cpu.x) & 0xff;
      return bus.read(z) | (bus.read((z + 1) & 0xff) << 8);
    }
    case "izy": {
      const z = fetch();
      const base = bus.read(z) | (bus.read((z + 1) & 0xff) << 8);
      return (base + cpu.y) & 0xffff;
    }
    default: {
      // "izp" — 65C02 (zp) indirect
      const z = fetch();
      return bus.read(z) | (bus.read((z + 1) & 0xff) << 8);
    }
  }
}

function push(cpu, bus, v) {
  bus.write(0x100 + (cpu.s & 0xff), v);
  cpu.s = (cpu.s - 1) & 0xff;
}
function pull(cpu, bus) {
  cpu.s = (cpu.s + 1) & 0xff;
  return bus.read(0x100 + cpu.s);
}

/** Push PC + status and vector off — hardware IRQ/NMI or software BRK. */
function doInterrupt(cpu, bus, kind) {
  if (kind === "brk") cpu.pc = (cpu.pc + 1) & 0xffff; // BRK skips a padding byte
  push(cpu, bus, (cpu.pc >> 8) & 0xff);
  push(cpu, bus, cpu.pc & 0xff);
  push(cpu, bus, kind === "brk" ? cpu.p | B | U : (cpu.p | U) & ~B);
  setF(cpu, I, true);
  setF(cpu, D, false); // the 65C02 clears decimal on an interrupt
  const vec = kind === "nmi" ? 0xfffa : 0xfffe;
  cpu.pc = bus.read(vec) | (bus.read(vec + 1) << 8);
}

// ── Opcode table: code → { m: mnemonic, a: addressing mode, bit? } ────────────
const TABLE = new Array(256).fill(null);
const set = (code, m, a, bit) => (TABLE[code] = { m, a, bit });

// Loads / stores.
for (const [op, mode] of [
  [0xa9, "imm"],
  [0xa5, "zp"],
  [0xb5, "zpx"],
  [0xad, "abs"],
  [0xbd, "abx"],
  [0xb9, "aby"],
  [0xa1, "izx"],
  [0xb1, "izy"],
  [0xb2, "izp"],
])
  set(op, "LDA", mode);
for (const [op, mode] of [
  [0xa2, "imm"],
  [0xa6, "zp"],
  [0xb6, "zpy"],
  [0xae, "abs"],
  [0xbe, "aby"],
])
  set(op, "LDX", mode);
for (const [op, mode] of [
  [0xa0, "imm"],
  [0xa4, "zp"],
  [0xb4, "zpx"],
  [0xac, "abs"],
  [0xbc, "abx"],
])
  set(op, "LDY", mode);
for (const [op, mode] of [
  [0x85, "zp"],
  [0x95, "zpx"],
  [0x8d, "abs"],
  [0x9d, "abx"],
  [0x99, "aby"],
  [0x81, "izx"],
  [0x91, "izy"],
  [0x92, "izp"],
])
  set(op, "STA", mode);
for (const [op, mode] of [
  [0x86, "zp"],
  [0x96, "zpy"],
  [0x8e, "abs"],
])
  set(op, "STX", mode);
for (const [op, mode] of [
  [0x84, "zp"],
  [0x94, "zpx"],
  [0x8c, "abs"],
])
  set(op, "STY", mode);
for (const [op, mode] of [
  [0x64, "zp"],
  [0x74, "zpx"],
  [0x9c, "abs"],
  [0x9e, "abx"],
])
  set(op, "STZ", mode);

// ALU.
for (const [mn, list] of [
  [
    "ADC",
    [
      [0x69, "imm"],
      [0x65, "zp"],
      [0x75, "zpx"],
      [0x6d, "abs"],
      [0x7d, "abx"],
      [0x79, "aby"],
      [0x61, "izx"],
      [0x71, "izy"],
      [0x72, "izp"],
    ],
  ],
  [
    "SBC",
    [
      [0xe9, "imm"],
      [0xe5, "zp"],
      [0xf5, "zpx"],
      [0xed, "abs"],
      [0xfd, "abx"],
      [0xf9, "aby"],
      [0xe1, "izx"],
      [0xf1, "izy"],
      [0xf2, "izp"],
    ],
  ],
  [
    "AND",
    [
      [0x29, "imm"],
      [0x25, "zp"],
      [0x35, "zpx"],
      [0x2d, "abs"],
      [0x3d, "abx"],
      [0x39, "aby"],
      [0x21, "izx"],
      [0x31, "izy"],
      [0x32, "izp"],
    ],
  ],
  [
    "ORA",
    [
      [0x09, "imm"],
      [0x05, "zp"],
      [0x15, "zpx"],
      [0x0d, "abs"],
      [0x1d, "abx"],
      [0x19, "aby"],
      [0x01, "izx"],
      [0x11, "izy"],
      [0x12, "izp"],
    ],
  ],
  [
    "EOR",
    [
      [0x49, "imm"],
      [0x45, "zp"],
      [0x55, "zpx"],
      [0x4d, "abs"],
      [0x5d, "abx"],
      [0x59, "aby"],
      [0x41, "izx"],
      [0x51, "izy"],
      [0x52, "izp"],
    ],
  ],
  [
    "CMP",
    [
      [0xc9, "imm"],
      [0xc5, "zp"],
      [0xd5, "zpx"],
      [0xcd, "abs"],
      [0xdd, "abx"],
      [0xd9, "aby"],
      [0xc1, "izx"],
      [0xd1, "izy"],
      [0xd2, "izp"],
    ],
  ],
  [
    "CPX",
    [
      [0xe0, "imm"],
      [0xe4, "zp"],
      [0xec, "abs"],
    ],
  ],
  [
    "CPY",
    [
      [0xc0, "imm"],
      [0xc4, "zp"],
      [0xcc, "abs"],
    ],
  ],
  [
    "BIT",
    [
      [0x89, "imm"],
      [0x24, "zp"],
      [0x34, "zpx"],
      [0x2c, "abs"],
      [0x3c, "abx"],
    ],
  ],
]) {
  for (const [op, mode] of list) set(op, mn, mode);
}

// Read-modify-write.
for (const [mn, list] of [
  [
    "ASL",
    [
      [0x0a, "acc"],
      [0x06, "zp"],
      [0x16, "zpx"],
      [0x0e, "abs"],
      [0x1e, "abx"],
    ],
  ],
  [
    "LSR",
    [
      [0x4a, "acc"],
      [0x46, "zp"],
      [0x56, "zpx"],
      [0x4e, "abs"],
      [0x5e, "abx"],
    ],
  ],
  [
    "ROL",
    [
      [0x2a, "acc"],
      [0x26, "zp"],
      [0x36, "zpx"],
      [0x2e, "abs"],
      [0x3e, "abx"],
    ],
  ],
  [
    "ROR",
    [
      [0x6a, "acc"],
      [0x66, "zp"],
      [0x76, "zpx"],
      [0x6e, "abs"],
      [0x7e, "abx"],
    ],
  ],
  [
    "INC",
    [
      [0x1a, "acc"],
      [0xe6, "zp"],
      [0xf6, "zpx"],
      [0xee, "abs"],
      [0xfe, "abx"],
    ],
  ],
  [
    "DEC",
    [
      [0x3a, "acc"],
      [0xc6, "zp"],
      [0xd6, "zpx"],
      [0xce, "abs"],
      [0xde, "abx"],
    ],
  ],
]) {
  for (const [op, mode] of list) set(op, mn, mode);
}
for (const [op, mode] of [
  [0x14, "zp"],
  [0x1c, "abs"],
])
  set(op, "TRB", mode);
for (const [op, mode] of [
  [0x04, "zp"],
  [0x0c, "abs"],
])
  set(op, "TSB", mode);

// Register ops, transfers, flags, stack, NOP.
set(0xe8, "INX", "imp");
set(0xc8, "INY", "imp");
set(0xca, "DEX", "imp");
set(0x88, "DEY", "imp");
set(0xaa, "TAX", "imp");
set(0xa8, "TAY", "imp");
set(0x8a, "TXA", "imp");
set(0x98, "TYA", "imp");
set(0xba, "TSX", "imp");
set(0x9a, "TXS", "imp");
set(0x48, "PHA", "imp");
set(0x68, "PLA", "imp");
set(0x08, "PHP", "imp");
set(0x28, "PLP", "imp");
set(0xda, "PHX", "imp");
set(0xfa, "PLX", "imp");
set(0x5a, "PHY", "imp");
set(0x7a, "PLY", "imp");
set(0x18, "CLC", "imp");
set(0x38, "SEC", "imp");
set(0x58, "CLI", "imp");
set(0x78, "SEI", "imp");
set(0xd8, "CLD", "imp");
set(0xf8, "SED", "imp");
set(0xb8, "CLV", "imp");
set(0xea, "NOP", "imp");
set(0xcb, "WAI", "imp");
set(0xdb, "STP", "imp");

// Branches.
set(0x10, "BPL", "rel");
set(0x30, "BMI", "rel");
set(0x50, "BVC", "rel");
set(0x70, "BVS", "rel");
set(0x90, "BCC", "rel");
set(0xb0, "BCS", "rel");
set(0xd0, "BNE", "rel");
set(0xf0, "BEQ", "rel");
set(0x80, "BRA", "rel");

// Jumps / subroutine / interrupt.
set(0x4c, "JMP", "abs");
set(0x6c, "JMP", "ind");
set(0x7c, "JMP", "indx");
set(0x20, "JSR", "abs");
set(0x60, "RTS", "imp");
set(0x40, "RTI", "imp");
set(0x00, "BRK", "imp");

// Rockwell/WDC bit ops (BBRx/BBSx zp,rel; RMBx/SMBx zp).
for (let n = 0; n < 8; n++) {
  set(0x0f + n * 0x10, "BBR", "zprel", n);
  set(0x8f + n * 0x10, "BBS", "zprel", n);
  set(0x07 + n * 0x10, "RMB", "zp", n);
  set(0x87 + n * 0x10, "SMB", "zp", n);
}

/** Run one whole instruction against the (replay) bus. `out.halt` ← WAI/STP. */
function execInstruction(cpu, bus, out) {
  const fetch = () => {
    const v = bus.read(cpu.pc);
    cpu.pc = (cpu.pc + 1) & 0xffff;
    return v;
  };
  const opcode = fetch();
  const e = TABLE[opcode] ?? { m: "NOP", a: "imp" };
  const { m, a } = e;
  const ea = () => effectiveAddr(cpu, bus, a);
  const branch = (cond) => {
    const off = signed(fetch());
    if (cond) cpu.pc = (cpu.pc + off) & 0xffff;
  };

  switch (m) {
    case "LDA":
      cpu.a = bus.read(ea());
      setNZ(cpu, cpu.a);
      break;
    case "LDX":
      cpu.x = bus.read(ea());
      setNZ(cpu, cpu.x);
      break;
    case "LDY":
      cpu.y = bus.read(ea());
      setNZ(cpu, cpu.y);
      break;
    case "STA":
      bus.write(ea(), cpu.a);
      break;
    case "STX":
      bus.write(ea(), cpu.x);
      break;
    case "STY":
      bus.write(ea(), cpu.y);
      break;
    case "STZ":
      bus.write(ea(), 0);
      break;
    case "AND":
      cpu.a &= bus.read(ea());
      setNZ(cpu, cpu.a);
      break;
    case "ORA":
      cpu.a |= bus.read(ea());
      setNZ(cpu, cpu.a);
      break;
    case "EOR":
      cpu.a ^= bus.read(ea());
      setNZ(cpu, cpu.a);
      break;
    case "ADC":
      adc(cpu, bus.read(ea()));
      break;
    case "SBC":
      sbc(cpu, bus.read(ea()));
      break;
    case "CMP":
      cmp(cpu, cpu.a, bus.read(ea()));
      break;
    case "CPX":
      cmp(cpu, cpu.x, bus.read(ea()));
      break;
    case "CPY":
      cmp(cpu, cpu.y, bus.read(ea()));
      break;
    case "BIT":
      bitTest(cpu, bus.read(ea()), a);
      break;

    case "ASL":
    case "LSR":
    case "ROL":
    case "ROR":
    case "INC":
    case "DEC":
      if (a === "acc") cpu.a = rmwValue(cpu, m, cpu.a);
      else {
        const ad = ea();
        bus.write(ad, rmwValue(cpu, m, bus.read(ad)));
      }
      break;
    case "TRB":
    case "TSB": {
      const ad = ea();
      const v = bus.read(ad);
      setF(cpu, ZF, (cpu.a & v) === 0);
      bus.write(ad, m === "TSB" ? v | cpu.a : v & ~cpu.a & 0xff);
      break;
    }

    case "INX":
      cpu.x = (cpu.x + 1) & 0xff;
      setNZ(cpu, cpu.x);
      break;
    case "INY":
      cpu.y = (cpu.y + 1) & 0xff;
      setNZ(cpu, cpu.y);
      break;
    case "DEX":
      cpu.x = (cpu.x - 1) & 0xff;
      setNZ(cpu, cpu.x);
      break;
    case "DEY":
      cpu.y = (cpu.y - 1) & 0xff;
      setNZ(cpu, cpu.y);
      break;
    case "TAX":
      cpu.x = cpu.a;
      setNZ(cpu, cpu.x);
      break;
    case "TAY":
      cpu.y = cpu.a;
      setNZ(cpu, cpu.y);
      break;
    case "TXA":
      cpu.a = cpu.x;
      setNZ(cpu, cpu.a);
      break;
    case "TYA":
      cpu.a = cpu.y;
      setNZ(cpu, cpu.a);
      break;
    case "TSX":
      cpu.x = cpu.s;
      setNZ(cpu, cpu.x);
      break;
    case "TXS":
      cpu.s = cpu.x;
      break;

    case "PHA":
      push(cpu, bus, cpu.a);
      break;
    case "PHX":
      push(cpu, bus, cpu.x);
      break;
    case "PHY":
      push(cpu, bus, cpu.y);
      break;
    case "PHP":
      push(cpu, bus, cpu.p | B | U);
      break;
    case "PLA":
      cpu.a = pull(cpu, bus);
      setNZ(cpu, cpu.a);
      break;
    case "PLX":
      cpu.x = pull(cpu, bus);
      setNZ(cpu, cpu.x);
      break;
    case "PLY":
      cpu.y = pull(cpu, bus);
      setNZ(cpu, cpu.y);
      break;
    case "PLP":
      cpu.p = (pull(cpu, bus) & ~B) | U;
      break;

    case "CLC":
      setF(cpu, C, false);
      break;
    case "SEC":
      setF(cpu, C, true);
      break;
    case "CLI":
      setF(cpu, I, false);
      break;
    case "SEI":
      setF(cpu, I, true);
      break;
    case "CLD":
      setF(cpu, D, false);
      break;
    case "SED":
      setF(cpu, D, true);
      break;
    case "CLV":
      setF(cpu, V, false);
      break;

    case "BPL":
      branch(!getF(cpu, N));
      break;
    case "BMI":
      branch(getF(cpu, N));
      break;
    case "BVC":
      branch(!getF(cpu, V));
      break;
    case "BVS":
      branch(getF(cpu, V));
      break;
    case "BCC":
      branch(!getF(cpu, C));
      break;
    case "BCS":
      branch(getF(cpu, C));
      break;
    case "BNE":
      branch(!getF(cpu, ZF));
      break;
    case "BEQ":
      branch(getF(cpu, ZF));
      break;
    case "BRA":
      branch(true);
      break;

    case "JMP":
      if (a === "abs") {
        const lo = fetch();
        cpu.pc = lo | (fetch() << 8);
      } else {
        const lo = fetch();
        let ptr = lo | (fetch() << 8);
        if (a === "indx") ptr = (ptr + cpu.x) & 0xffff;
        cpu.pc = bus.read(ptr) | (bus.read((ptr + 1) & 0xffff) << 8);
      }
      break;
    case "JSR": {
      const lo = fetch(); // pc now points at the high byte
      push(cpu, bus, (cpu.pc >> 8) & 0xff);
      push(cpu, bus, cpu.pc & 0xff);
      cpu.pc = lo | (bus.read(cpu.pc) << 8);
      break;
    }
    case "RTS": {
      const lo = pull(cpu, bus);
      const hi = pull(cpu, bus);
      cpu.pc = (((hi << 8) | lo) + 1) & 0xffff;
      break;
    }
    case "RTI": {
      cpu.p = (pull(cpu, bus) & ~B) | U;
      const lo = pull(cpu, bus);
      cpu.pc = ((pull(cpu, bus) << 8) | lo) & 0xffff;
      break;
    }
    case "BRK":
      doInterrupt(cpu, bus, "brk");
      break;

    case "BBR":
    case "BBS": {
      const z = fetch();
      const v = bus.read(z);
      const off = signed(fetch());
      const bitSet = ((v >> e.bit) & 1) === 1;
      if (m === "BBR" ? !bitSet : bitSet) cpu.pc = (cpu.pc + off) & 0xffff;
      break;
    }
    case "RMB":
    case "SMB": {
      const z = fetch();
      const v = bus.read(z);
      bus.write(z, m === "RMB" ? v & ~(1 << e.bit) & 0xff : v | (1 << e.bit));
      break;
    }

    case "WAI":
      out.halt = "wai";
      break;
    case "STP":
      out.halt = "stp";
      break;
    default:
      break; // NOP
  }
}

/** Run the reset sequence: pull the $FFFC/$FFFD vector into PC. */
function runReset(cpu, bus) {
  cpu.pc = bus.read(0xfffc) | (bus.read(0xfffd) << 8);
}

function runOp(cur, cpu, bus, out) {
  if (cur === "reset") runReset(cpu, bus);
  else if (cur === "nmi") doInterrupt(cpu, bus, "nmi");
  else if (cur === "irq") doInterrupt(cpu, bus, "irq");
  else execInstruction(cpu, bus, out);
}

const regsOf = (s) => ({ a: s.a, x: s.x, y: s.y, s: s.s, pc: s.pc, p: s.p });

/** Fresh power-on state: already IN reset, pending the first vector read. */
export function initialCpu() {
  return resetHold({ a: 0, x: 0, y: 0, pc: 0 }, { nmi: false });
}

/** The held reset state — registers initialised, driving $FFFC until released. */
function resetHold(s, ctl) {
  return {
    a: s.a ?? 0,
    x: s.x ?? 0,
    y: s.y ?? 0,
    s: 0xfd,
    pc: s.pc ?? 0,
    p: I | U, // interrupts masked, decimal clear
    cur: "reset",
    log: [],
    addr: 0xfffc,
    rw: "r",
    dout: 0,
    sync: false,
    nmiPrev: Boolean(ctl.nmi),
    nmiPending: false,
  };
}

/** Begin the next operation (interrupt or instruction) → its first bus access. */
function beginNextOp(committed, base, nmiPending, ctl) {
  let cur = "instr";
  let clearNmi = false;
  if (nmiPending) {
    cur = "nmi";
    clearNmi = true;
  } else if (ctl.irq && !(committed.p & I)) {
    cur = "irq";
  }
  const cpu = regsOf(committed);
  const bus = makeBus([]);
  const out = {};
  try {
    runOp(cur, cpu, bus, out);
  } catch (ex) {
    if (ex !== SUSPEND) throw ex;
    return {
      ...cpu,
      ...base,
      nmiPending: clearNmi ? false : nmiPending,
      cur,
      log: [],
      addr: bus.pending.addr,
      rw: bus.pending.rw,
      dout: bus.pending.dout,
      sync: cur === "instr",
    };
  }
  throw new Error("w65c02: op produced no bus access");
}

/**
 * Advance the CPU one bus cycle. `busByte` is the data bus (used when the cycle
 * that just finished was a read); `ctl` carries the control-line levels
 * (`reset`/`irq`/`nmi` asserted booleans, `ready`). Pure — returns the next state.
 */
export function cpuCycle(state, busByte, ctl) {
  if (ctl.reset) return resetHold(state, ctl);

  const nmiPending = state.nmiPending || (!state.nmiPrev && Boolean(ctl.nmi));
  const base = { nmiPrev: Boolean(ctl.nmi) };

  if (ctl.ready === false) return { ...state, ...base, nmiPending }; // RDY stall
  if (state.cur === "stp") return { ...state, ...base, nmiPending }; // wait for reset
  if (state.cur === "wai") {
    const wake = nmiPending || (ctl.irq && !(state.p & I));
    if (!wake) return { ...state, ...base, nmiPending };
    return beginNextOp(state, base, nmiPending, ctl);
  }

  // Log the byte for the access that just completed, then re-run the current op.
  // `cpu` is a scratch copy the interpreter mutates during replay; the committed
  // registers (instruction start) stay in `state` and are what the NEXT cycle
  // replays from — so a mid-instruction suspend must keep state's regs, not cpu's.
  const log = [...state.log, state.rw === "r" ? busByte & 0xff : state.dout];
  const cpu = regsOf(state);
  const bus = makeBus(log);
  const out = {};
  try {
    runOp(state.cur, cpu, bus, out);
  } catch (ex) {
    if (ex !== SUSPEND) throw ex;
    return {
      ...regsOf(state), // instruction-start registers — NOT the partial `cpu`
      ...base,
      nmiPending,
      cur: state.cur,
      log,
      addr: bus.pending.addr,
      rw: bus.pending.rw,
      dout: bus.pending.dout,
      sync: false,
    };
  }
  // Instruction complete. WAI/STP halts; otherwise begin the next op.
  if (out.halt) {
    return {
      ...cpu,
      ...base,
      nmiPending,
      cur: out.halt,
      log: [],
      addr: cpu.pc,
      rw: "r",
      dout: 0,
      sync: false,
    };
  }
  return beginNextOp({ ...state, ...cpu }, base, nmiPending, ctl);
}

/**
 * The W65C02 as an engine sequential unit. Pin params are catalog pin numbers;
 * `addr` is [A0…A15] and `data` is [D0…D7], both LSB first.
 * @returns {{ state0: Function, step: Function, outputs: Function }}
 */
export function w65c02Unit(pins) {
  const {
    addr,
    data,
    rwb,
    sync,
    phi2,
    resb,
    irqb,
    nmib,
    rdy,
    be,
    vpb,
    mlb,
    phi1o,
    phi2o,
  } = pins;

  const readData = (ins) =>
    data.reduce((n, pin, i) => n | ((ins.get(pin) === H ? 1 : 0) << i), 0);

  return {
    state0: initialCpu,

    step(state, ins, prev) {
      const now = ins.get(phi2);
      const was = prev ? prev.get(phi2) : undefined;
      if (!(was === H && now === L)) return state; // advance on PHI2's falling edge
      const ctl = {
        reset: ins.get(resb) === L,
        irq: ins.get(irqb) === L,
        nmi: ins.get(nmib) === L,
        ready: ins.get(rdy) !== L,
      };
      return cpuCycle(state, readData(ins), ctl);
    },

    outputs(state, ins) {
      const out = new Map();
      const enabled = ins.get(be) !== L; // BE low tri-states the bus outputs
      addr.forEach((pin, i) =>
        out.set(pin, enabled ? ((state.addr >> i) & 1 ? H : L) : Z),
      );
      out.set(rwb, enabled ? (state.rw === "w" ? L : H) : Z);
      if (enabled && state.rw === "w") {
        data.forEach((pin, i) => out.set(pin, (state.dout >> i) & 1 ? H : L));
      } else {
        for (const pin of data) out.set(pin, Z);
      }
      out.set(sync, state.sync ? H : L);
      out.set(vpb, H); // vector-pull indicator — inactive (cosmetic)
      out.set(mlb, H); // memory-lock indicator — inactive (cosmetic)
      const clk = ins.get(phi2);
      out.set(phi2o, clk === L ? L : H);
      out.set(phi1o, clk === L ? H : L);
      return out;
    },
  };
}

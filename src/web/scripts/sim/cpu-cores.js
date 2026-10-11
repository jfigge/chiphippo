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

// cpu-cores.js — what the CPU monitor needs to know about each processor
// core, stated beside nothing else: a `cpu` descriptor per core that the
// catalog hangs on the part's `logic` (chips-cpu.js), so the monitor
// (sim/cpu-monitor.js) and its address map (sim/cpu-memory-map.js) stay
// generic and never test a ref. PURE and DOM-free, like the cores.
//
// A descriptor reads a core's plain-data state; it never changes it. It says:
//   · which pins are the address and data buses, which is the clock and on
//     which edge a bus cycle (6502) or a T-state (Z80) completes — what the
//     monitor counts, and `countUnit` what it calls them;
//   · `peekState(addr)` — a state of the core presenting a MEMORY READ of
//     `addr` on its pins, which the address map settles the circuit with to
//     see which memory chip answers (it is never stepped);
//   · `vectorOf(kind, state)` — where a reset or interrupt sequence sends
//     execution: `{vector}` to read it from, `{fixed}`, or null;
//   · `startOf(prev, state)` — on a counted edge, whether `state` begins a new
//     operation, and which (`"instr"`, `"irq"`, `"nmi"`, `"int"`, `"reset"`);
//   · `view(state, ins)` — the registers, flags, step, clock, input pins and
//     status, as the monitor prints them, and the memory access in flight;
//   · `disassemble(read, addr)` — its instruction set's disassembler, and
//     `isCall(line)` — whether a decoded line calls a subroutine (what the
//     monitor's Step Over is offered for);
//   · `spOf(state)` + `spMask` — the stack pointer as the operation in flight
//     began, and its width: Step Over's test for a call that has RETURNED
//     (back at the return address, the stack no deeper than it was);
//   · `stackOf(state)` — where the stack's top is (live), how wide an entry
//     the panel shows and how many there can be;
//   · `canEdit(state)` + `setRegister(state, name, value)` — the registers
//     may be changed only at an instruction's very start (its opcode fetch on
//     the bus, nothing of it run), where the state's committed registers ARE
//     the live ones; the new state, or null for a value the register cannot
//     hold or a moment it cannot be changed at;
//   · `ioOf(prev, state)` (the Z80's, which has an I/O space) — the IN or OUT
//     cycle a counted edge just completed: `{dir, port, value}`, or null.
//
// The registers and flags a view shows are LIVE (`liveRegisters`): the cores
// commit theirs only when an operation ends, so a run paused mid-instruction
// shows the interpreter's registers up to the access in flight — PC past the
// bytes fetched, a register loaded once its byte is in. What a core does not
// have is left out rather than invented: the cores emulate an instruction's
// RESULT, so neither has internal buses, an ALU latch, microcode — or a
// cycle-by-cycle account of an instruction worth showing as the chip's.

import { H, L, Z } from "./levels.js";
import { initialCpu, liveRegisters as live6502 } from "./w65c02.js";
import { initialZ80, liveRegisters as liveZ80 } from "./z80.js";
import { disassemble6502 } from "./disasm-6502.js";
import { disassembleZ80 } from "./disasm-z80.js";

/** A pin as the monitor shows it: its level, and whether it is asserted. */
const pinOf = (name, level, activeLow = true) => ({
  name,
  level: level ?? Z,
  active: activeLow ? level === L : level === H,
});

/** A register value typed in: a whole number no wider than `max`, or null. */
const fits = (value, max) =>
  Number.isInteger(value) && value >= 0 && value <= max ? value : null;

// ── W65C02 ───────────────────────────────────────────────────────────────────

/** P's bits that are not flags the register holds: B (4) and the unused 5. */
const P_FIXED = 0x30;
const P_UNUSED = 0x20;

/**
 * The W65C02's descriptor. `pins` is the map its unit was built from
 * (chips-cpu.js).
 */
export function w65c02Monitor(pins) {
  const { addr, data, phi2, resb, irqb, nmib, rdy, be } = pins;
  const live = (s) => s.cur !== "wai" && s.cur !== "stp";
  // An instruction's start: its opcode fetch on the bus, nothing of it run.
  const atStart = (s) => s.cur === "instr" && s.sync && s.log.length === 0;
  return {
    kind: "w65c02",
    addr,
    data,
    clock: phi2,
    // One bus access per PHI2 cycle, ended (and stepped) on its falling edge.
    countEdge: "fall",
    countUnit: "cycles",

    // Where a reset or interrupt sequence sends execution: its vector.
    vectorOf: (kind) => {
      const vector = { reset: 0xfffc, irq: 0xfffe, nmi: 0xfffa }[kind];
      return vector == null ? null : { vector };
    },

    peekState: (a) => ({
      ...initialCpu(),
      cur: "instr",
      addr: a & 0xffff,
      rw: "r",
      sync: false,
    }),

    pcOf: (s) => s.pc,

    // The stack is page 1, S the byte below its top: an 8-bit pointer.
    spOf: (s) => s.s,
    spMask: 0xff,

    // The pushed bytes, from the one S points past up to the page's end.
    stackOf(s) {
      const sp = live6502(s).s;
      return { top: 0x0100 | ((sp + 1) & 0xff), width: 1, count: 0xff - sp };
    },

    isCall: (line) => line?.bytes?.[0] === 0x20, // JSR

    canEdit: atStart,

    setRegister(s, name, value) {
      if (!atStart(s)) return null;
      const v = fits(value, name === "PC" ? 0xffff : 0xff);
      if (v == null) return null;
      switch (name) {
        case "A":
        case "X":
        case "Y":
        case "S":
          return { ...s, [name.toLowerCase()]: v };
        // B and the unused bit are not flags the register keeps (PLP's rule).
        case "P":
          return { ...s, p: (v & ~P_FIXED) | P_UNUSED };
        // The opcode fetch on the bus moves with it.
        case "PC":
          return { ...s, pc: v, addr: v };
        default:
          return null;
      }
    },

    startOf(prev, s) {
      if (s.log.length !== 0) return null;
      if (s.cur === "instr" ? !s.sync : !["irq", "nmi", "reset"].includes(s.cur)) return null; // prettier-ignore
      // An RDY stall, or a reset held, presents the very same start again.
      if (
        prev &&
        prev.log.length === 0 &&
        prev.cur === s.cur &&
        prev.pc === s.pc &&
        prev.addr === s.addr
      ) {
        return null;
      }
      return s.cur;
    },

    view(s, ins) {
      const levels = ins ?? new Map();
      const level = (pin) => levels.get(pin) ?? Z;
      const r = live6502(s);
      return {
        registers: [
          { name: "A", value: r.a, digits: 2 },
          { name: "X", value: r.x, digits: 2 },
          { name: "Y", value: r.y, digits: 2 },
          { name: "S", value: r.s, digits: 2 },
          { name: "PC", value: r.pc, digits: 4 },
        ],
        flags: {
          names: ["N", "V", "-", "B", "D", "I", "Z", "C"],
          value: r.p,
          reg: "P",
          fixed: P_FIXED,
        },
        step: { index: s.log.length + 1, label: null },
        clock: {
          name: "PHI2",
          level: level(phi2),
          label: level(phi2) === H ? "Φ2" : "Φ1",
        },
        inputs: [
          pinOf("RESB", level(resb)),
          pinOf("IRQB", level(irqb)),
          pinOf("NMIB", level(nmib)),
          pinOf("RDY", level(rdy)),
          pinOf("BE", level(be)),
        ],
        status: s.cur === "instr" ? "running" : s.cur,
        access: live(s) ? { addr: s.addr, write: s.rw === "w" } : null,
      };
    },

    disassemble: disassemble6502,
  };
}

// ── Z80 ──────────────────────────────────────────────────────────────────────

/** M-cycles that touch MEMORY (an IN/OUT is the separate I/O space). */
const MEMORY_CYCLE = new Set(["M1", "READ", "WRITE"]);

/** The registers a Z80 edit names, by the fields they are kept in: a pair
    (high, low), a 16-bit one, a byte, or a small number with its limit. */
const Z80_PAIRS = {
  AF: ["a", "f"],
  BC: ["b", "c"],
  DE: ["d", "e"],
  HL: ["h", "l"],
  "AF'": ["a2", "f2"],
  "BC'": ["b2", "c2"],
  "DE'": ["d2", "e2"],
  "HL'": ["h2", "l2"],
};
const Z80_WORDS = { IX: "ix", IY: "iy", SP: "sp", PC: "pc" };
const Z80_BYTES = { F: "f", I: "i", R: "r" };
const Z80_SMALL = { IM: ["im", 2], IFF1: ["iff1", 1], IFF2: ["iff2", 1] };

/** CALL, CALL cc and RST — the unprefixed opcodes that push a return. */
const isZ80Call = (op) =>
  op === 0xcd || (op & 0xc7) === 0xc4 || (op & 0xc7) === 0xc7;

/** The Z80's descriptor — as `w65c02Monitor`. */
export function z80Monitor(pins) {
  const { addr, data, clk } = pins;
  const off = (s) => s.mk === "RESET" || s.mk === "BUSACK";
  const pair = (hi, lo) => ((hi & 0xff) << 8) | (lo & 0xff);
  // An instruction's start: its M1 in T1, nothing of it run (a HALT's
  // repeated fetch is not one — PC is held there).
  const atStart = (s) =>
    s.cur === "instr" &&
    s.mk === "M1" &&
    s.t === 1 &&
    s.log.length === 0 &&
    !s.halted;
  return {
    kind: "z80",
    addr,
    data,
    clock: clk,
    // The state machine steps one T-state per RISING edge (z80.js).
    countEdge: "rise",
    countUnit: "tstates",

    // A Z80 has no reset vector — it starts at $0000 — and its interrupts go
    // to fixed addresses, but for mode 0 and mode 2, which take theirs off the
    // bus.
    vectorOf: (kind, s) =>
      kind === "reset"
        ? { fixed: 0 }
        : kind === "nmi"
          ? { fixed: 0x66 }
          : kind === "int" && s.im === 1
            ? { fixed: 0x38 }
            : null,

    peekState: (a) => ({ ...initialZ80(), mk: "READ", t: 2, addr: a & 0xffff }),

    pcOf: (s) => s.pc,

    spOf: (s) => s.sp,
    spMask: 0xffff,

    // Words, from SP up: the stack's top first.
    stackOf: (s) => ({ top: liveZ80(s).sp, width: 2, count: 0x8000 }),

    isCall: (line) => isZ80Call(line?.bytes?.[0]),

    canEdit: atStart,

    setRegister(s, name, value) {
      if (!atStart(s)) return null;
      let next = null;
      if (Z80_PAIRS[name]) {
        const v = fits(value, 0xffff);
        const [hi, lo] = Z80_PAIRS[name];
        if (v != null) next = { ...s, [hi]: v >> 8, [lo]: v & 0xff };
      } else if (Z80_WORDS[name]) {
        const v = fits(value, 0xffff);
        if (v != null) next = { ...s, [Z80_WORDS[name]]: v };
        // The opcode fetch on the bus moves with PC.
        if (next && name === "PC") next.addr = v;
      } else if (Z80_BYTES[name]) {
        const v = fits(value, 0xff);
        if (v != null) next = { ...s, [Z80_BYTES[name]]: v };
      } else if (Z80_SMALL[name]) {
        const [key, max] = Z80_SMALL[name];
        const v = fits(value, max);
        if (v != null) next = { ...s, [key]: v };
      }
      // The refresh address the M1 puts up is I:R.
      if (next && (name === "I" || name === "R")) {
        next.rfsh = ((next.i & 0xff) << 8) | (next.r & 0xff);
      }
      return next;
    },

    // An I/O cycle completes on the rising edge that ends its last T: the
    // byte an IN latched at T3's end, or the one an OUT drove. The port is
    // A0–A7 (what the instruction set calls it); the upper half is A or B.
    ioOf(prev, s) {
      if (!prev || (prev.mk !== "IN" && prev.mk !== "OUT")) return null;
      if (prev.t !== 4 || s.t !== 1 || s.mk === "RESET") return null;
      const dir = prev.mk === "IN" ? "in" : "out";
      return {
        dir,
        port: prev.addr & 0xff,
        value: (dir === "in" ? prev.din : prev.dout) & 0xff,
      };
    },

    startOf(prev, s) {
      if (s.mk === "RESET") return prev?.mk === "RESET" ? null : "reset";
      if (s.t !== 1 || s.log.length !== 0 || off(s)) return null;
      if (s.cur === "instr" && s.mk !== "M1") return null;
      if (prev?.mk === "BUSACK") return null; // the held cycle, resumed
      // A halted CPU fetches its NOP over and over at the one address.
      if (s.halted && prev?.halted && prev.pc === s.pc) return null;
      return s.cur;
    },

    view(s, ins) {
      const levels = ins ?? new Map();
      const level = (pin) => levels.get(pin) ?? Z;
      const r = liveZ80(s);
      return {
        registers: [
          { name: "AF", value: pair(r.a, r.f), digits: 4 },
          { name: "BC", value: pair(r.b, r.c), digits: 4 },
          { name: "DE", value: pair(r.d, r.e), digits: 4 },
          { name: "HL", value: pair(r.h, r.l), digits: 4 },
          { name: "IX", value: r.ix, digits: 4 },
          { name: "IY", value: r.iy, digits: 4 },
          { name: "SP", value: r.sp, digits: 4 },
          { name: "PC", value: r.pc, digits: 4 },
          { name: "AF'", value: pair(r.a2, r.f2), digits: 4 },
          { name: "BC'", value: pair(r.b2, r.c2), digits: 4 },
          { name: "DE'", value: pair(r.d2, r.e2), digits: 4 },
          { name: "HL'", value: pair(r.h2, r.l2), digits: 4 },
          { name: "I", value: r.i, digits: 2 },
          { name: "R", value: r.r, digits: 2 },
          { name: "IM", value: r.im, digits: 1 },
          { name: "IFF1", value: r.iff1 ? 1 : 0, digits: 1 },
          { name: "IFF2", value: r.iff2 ? 1 : 0, digits: 1 },
        ],
        flags: { names: ["S", "Z", "5", "H", "3", "P/V", "N", "C"], value: r.f, reg: "F", fixed: 0 }, // prettier-ignore
        step: { index: s.log.length + 1, label: `${s.mk} T${s.t}` },
        clock: { name: "CLK", level: level(clk), label: level(clk) === H ? "↑" : "↓" }, // prettier-ignore
        inputs: [
          pinOf("/RESET", level(pins.reset)),
          pinOf("/INT", level(pins.int)),
          pinOf("/NMI", level(pins.nmi)),
          pinOf("/WAIT", level(pins.wait)),
          pinOf("/BUSRQ", level(pins.busrq)),
        ],
        status:
          s.mk === "RESET"
            ? "reset"
            : s.mk === "BUSACK"
              ? "busack"
              : s.halted
                ? "halt"
                : s.cur === "instr"
                  ? "running"
                  : s.cur,
        access: MEMORY_CYCLE.has(s.mk)
          ? { addr: s.addr, write: s.mk === "WRITE" }
          : null,
      };
    },

    disassemble: disassembleZ80,
  };
}

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
//   · `completed(prev, state, prevIns)` — on a counted edge, the bus access
//     (6502) or M-cycle (Z80) that edge ended, as a row; and `current` the
//     one in flight;
//   · `view(state, ins)` — the registers, flags, step, clock, input pins, bus
//     and status, as the monitor prints them;
//   · `disassemble(read, addr)` — its instruction set's disassembler.
//
// What a core does not have is left out rather than invented: the 6502's
// registers are the ones the instruction STARTED with (the core commits them
// at its end), and neither core has internal buses, an ALU latch or
// microcode to show.

import { H, L, Z } from "./levels.js";
import { initialCpu } from "./w65c02.js";
import { initialZ80 } from "./z80.js";
import { disassemble6502 } from "./disasm-6502.js";
import { disassembleZ80 } from "./disasm-z80.js";

/** The byte on `pins` (LSB first) in `levels`, or null if any bit is not a
    clean H or L. */
export function byteOn(levels, pins) {
  let v = 0;
  for (let i = 0; i < pins.length; i++) {
    const l = levels?.get(pins[i]);
    if (l === H) v |= 1 << i;
    else if (l !== L) return null;
  }
  return v;
}

/** A pin as the monitor shows it: its level, and whether it is asserted. */
const pinOf = (name, level, activeLow = true) => ({
  name,
  level: level ?? Z,
  active: activeLow ? level === L : level === H,
});

// ── W65C02 ───────────────────────────────────────────────────────────────────

/**
 * The W65C02's descriptor. `pins` is the map its unit was built from
 * (chips-cpu.js), `unit` the unit itself (its `outputs` says what the pins
 * drive).
 */
export function w65c02Monitor(pins, unit) {
  const { addr, data, phi2, resb, irqb, nmib, rdy, be } = pins;
  const live = (s) => s.cur !== "wai" && s.cur !== "stp";
  const access = (s, levels) => {
    const write = s.rw === "w";
    return {
      kind: write ? "write" : s.sync ? "fetch" : "read",
      addr: s.addr,
      data: write ? s.dout : byteOn(levels, data),
    };
  };
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

    // The access the cycle ending at this falling edge made: the byte a read
    // took is the one on the bus while PHI2 was HIGH — `prevIns`, exactly as
    // the core latches it (w65c02.js `step`).
    completed: (prev, s, prevIns) =>
      live(prev) ? access(prev, prevIns) : null,

    current: (s, ins) => (live(s) ? access(s, ins) : null),

    view(s, ins) {
      const levels = ins ?? new Map();
      const outs = unit.outputs(s, levels);
      const level = (pin) => levels.get(pin) ?? Z;
      const driven = byteOn(outs, addr.slice(0, 8));
      const high = byteOn(outs, addr.slice(8));
      const write = s.rw === "w";
      return {
        registers: [
          { name: "A", value: s.a, digits: 2 },
          { name: "X", value: s.x, digits: 2 },
          { name: "Y", value: s.y, digits: 2 },
          { name: "S", value: s.s, digits: 2 },
          { name: "PC", value: s.pc, digits: 4 },
        ],
        flags: { names: ["N", "V", "-", "B", "D", "I", "Z", "C"], value: s.p },
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
        bus: {
          addr: driven == null || high == null ? null : driven | (high << 8),
          data: write ? s.dout : byteOn(levels, data),
          signals: [
            pinOf("RWB", outs.get(pins.rwb)),
            pinOf("SYNC", outs.get(pins.sync), false),
          ],
        },
        status: s.cur === "instr" ? "running" : s.cur,
        access: live(s) ? { addr: s.addr, write } : null,
      };
    },

    disassemble: disassemble6502,
  };
}

// ── Z80 ──────────────────────────────────────────────────────────────────────

/** An M-cycle kind as a row's kind. */
const Z80_KIND = Object.freeze({
  M1: "fetch",
  READ: "read",
  WRITE: "write",
  IN: "in",
  OUT: "out",
  INTACK: "intack",
  INTERNAL: "internal",
});

/** M-cycles that touch MEMORY (an IN/OUT is the separate I/O space). */
const MEMORY_CYCLE = new Set(["M1", "READ", "WRITE"]);

/** The Z80's descriptor — as `w65c02Monitor`. */
export function z80Monitor(pins, unit) {
  const { addr, data, clk } = pins;
  const off = (s) => s.mk === "RESET" || s.mk === "BUSACK";
  const pair = (hi, lo) => ((hi & 0xff) << 8) | (lo & 0xff);
  const cycle = (s, data) => ({
    kind: Z80_KIND[s.mk],
    addr: s.mk === "INTERNAL" ? null : s.addr,
    data,
  });
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

    startOf(prev, s) {
      if (s.mk === "RESET") return prev?.mk === "RESET" ? null : "reset";
      if (s.t !== 1 || s.log.length !== 0 || off(s)) return null;
      if (s.cur === "instr" && s.mk !== "M1") return null;
      if (prev?.mk === "BUSACK") return null; // the held cycle, resumed
      // A halted CPU fetches its NOP over and over at the one address.
      if (s.halted && prev?.halted && prev.pc === s.pc) return null;
      return s.cur;
    },

    // An M-cycle ends at the rising edge that opens the next one's T1. Its
    // byte is the one latched at its sampling edge (`din`), or the one it
    // drove (`dout`).
    completed(prev, s) {
      if (off(prev) || s.t !== 1) return null;
      if (
        prev.t === 1 &&
        prev.mk === s.mk &&
        prev.cur === s.cur &&
        prev.log.length === s.log.length
      ) {
        return null;
      }
      const reads = prev.mk === "M1" || prev.mk === "READ" || prev.mk === "IN" || prev.mk === "INTACK"; // prettier-ignore
      const writes = prev.mk === "WRITE" || prev.mk === "OUT";
      return cycle(prev, reads ? prev.din : writes ? prev.dout : null);
    },

    current(s, ins) {
      if (off(s)) return null;
      const writes = s.mk === "WRITE" || s.mk === "OUT";
      return cycle(s, writes ? s.dout : byteOn(ins, data));
    },

    view(s, ins) {
      const levels = ins ?? new Map();
      const outs = unit.outputs(s, levels);
      const level = (pin) => levels.get(pin) ?? Z;
      const lo = byteOn(outs, addr.slice(0, 8));
      const hi = byteOn(outs, addr.slice(8));
      const drives = s.mk === "WRITE" || s.mk === "OUT";
      return {
        registers: [
          { name: "AF", value: pair(s.a, s.f), digits: 4 },
          { name: "BC", value: pair(s.b, s.c), digits: 4 },
          { name: "DE", value: pair(s.d, s.e), digits: 4 },
          { name: "HL", value: pair(s.h, s.l), digits: 4 },
          { name: "IX", value: s.ix, digits: 4 },
          { name: "IY", value: s.iy, digits: 4 },
          { name: "SP", value: s.sp, digits: 4 },
          { name: "PC", value: s.pc, digits: 4 },
          { name: "AF'", value: pair(s.a2, s.f2), digits: 4 },
          { name: "BC'", value: pair(s.b2, s.c2), digits: 4 },
          { name: "DE'", value: pair(s.d2, s.e2), digits: 4 },
          { name: "HL'", value: pair(s.h2, s.l2), digits: 4 },
          { name: "I", value: s.i, digits: 2 },
          { name: "R", value: s.r, digits: 2 },
          { name: "IM", value: s.im, digits: 1 },
          { name: "IFF1", value: s.iff1 ? 1 : 0, digits: 1 },
          { name: "IFF2", value: s.iff2 ? 1 : 0, digits: 1 },
        ],
        flags: { names: ["S", "Z", "5", "H", "3", "P/V", "N", "C"], value: s.f }, // prettier-ignore
        step: { index: s.log.length + 1, label: `${s.mk} T${s.t}` },
        clock: { name: "CLK", level: level(clk), label: level(clk) === H ? "↑" : "↓" }, // prettier-ignore
        inputs: [
          pinOf("/RESET", level(pins.reset)),
          pinOf("/INT", level(pins.int)),
          pinOf("/NMI", level(pins.nmi)),
          pinOf("/WAIT", level(pins.wait)),
          pinOf("/BUSRQ", level(pins.busrq)),
        ],
        bus: {
          addr: lo == null || hi == null ? null : lo | (hi << 8),
          data: drives ? s.dout : byteOn(levels, data),
          signals: [
            pinOf("/M1", outs.get(pins.m1)),
            pinOf("/MREQ", outs.get(pins.mreq)),
            pinOf("/IORQ", outs.get(pins.iorq)),
            pinOf("/RD", outs.get(pins.rd)),
            pinOf("/WR", outs.get(pins.wr)),
            pinOf("/RFSH", outs.get(pins.rfsh)),
            pinOf("/HALT", outs.get(pins.halt)),
            pinOf("/BUSACK", outs.get(pins.busak)),
          ],
        },
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

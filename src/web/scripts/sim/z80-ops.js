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

// z80-ops.js — the Zilog Z80 INSTRUCTION SET as a pure interpreter over an
// abstract bus. This half knows nothing about clocks, pins, T-states or the
// engine: it is registers, flags, an ALU, and a decoder. The machine that turns
// its bus calls into real M-cycles on real pins is sim/z80.js.
//
// The split matters because the bus calls here may SUSPEND (z80.js's replay bus
// throws at the first un-replayed access, so an instruction is re-run from its
// committed registers once per M-cycle — the same trick sim/w65c02.js uses, and
// for the same reason: a cycle-stepped CPU has to stop mid-instruction, and a
// generator is neither serialisable nor plain data). Nothing in THIS file is
// aware of that; it just calls `bus.read` and gets a byte.
//
// ── Decoding ─────────────────────────────────────────────────────────────────
// The opcode map is ALGORITHMIC, not a 256-entry table: every Z80 opcode splits
// as x = bits 7-6, y = bits 5-3, z = bits 2-0 (with p = y >> 1, q = y & 1), and
// the instruction groups fall out of those fields. That is how the part is
// actually documented, and it is what keeps a complete instruction set — four
// tables' worth — readable instead of being 700 hand-written cases.
//
// The DD/FD prefixes are the same base table re-dispatched through an INDEX
// CONTEXT: `(HL)` becomes `(IX+d)` and `H`/`L` become `IXH`/`IXL`, except that
// an instruction reaching memory as `(IX+d)` uses the PLAIN `H`/`L` for its
// other operand (the classic rule — `LD H,(IX+d)` loads H, not IXH). One
// `idxHalf` test states that, once.
//
// ── Scope ────────────────────────────────────────────────────────────────────
// The complete DOCUMENTED instruction set: every base opcode, the CB rotate /
// BIT / RES / SET group, the ED group (block moves, block I/O, 16-bit
// arithmetic, RETN/RETI, IM 0/1/2, RRD/RLD), and the DD/FD index forms. The
// undocumented IXH/IXL/IYH/IYL halves and SLL come along for free with the
// algorithmic decode, and the DDCB "operate and copy to register" forms are
// implemented because they are what the hardware does and cost two lines.
//
// NOT modelled: MEMPTR/WZ, so the undocumented F3/F5 flag bits of `BIT n,(HL)`,
// `BIT n,(IX+d)`, `CPI`/`CPD` and `IN r,(C)` follow the operand rather than the
// internal pointer. F3/F5 ARE maintained for the ordinary arithmetic, logic and
// INC/DEC groups, where they are simply result bits 3 and 5.

/** Flag bits, in the datasheet's own bit order. */
export const SF = 0x80; // sign — bit 7 of the result
export const ZF = 0x40; // zero
export const F5 = 0x20; // undocumented copy of result bit 5
export const HF = 0x10; // half carry (bit 3 → 4), for DAA
export const F3 = 0x08; // undocumented copy of result bit 3
export const PV = 0x04; // parity / overflow — which one depends on the op
export const NF = 0x02; // last op was a subtract, for DAA
export const CF = 0x01; // carry

/** The undocumented pair, which every arithmetic result copies out of itself. */
const F53 = F5 | F3;

/** Even parity of a byte → PV, the flag the logic group sets. */
function parity(v) {
  let p = v ^ (v >> 4);
  p ^= p >> 2;
  p ^= p >> 1;
  return p & 1 ? 0 : PV;
}

/** S, Z and the undocumented pair, read straight off a byte result. */
const sz53 = (v) => (v & (SF | F53)) | (v === 0 ? ZF : 0);
/** …and parity too — the logic group's flag set. */
const sz53p = (v) => sz53(v) | parity(v);

/** A displacement byte read as signed (JR, and every (IX+d)). */
const signed = (b) => (b < 0x80 ? b : b - 256);

// ── Register-pair accessors ──────────────────────────────────────────────────
// The state is sixteen flat byte fields plus the four 16-bit registers, because
// the engine compares sequential state STRUCTURALLY (engine.js `sameState`) and
// so it must be plain data all the way down — no typed arrays, no accessors.

const bc = (c) => (c.b << 8) | c.c;
const de = (c) => (c.d << 8) | c.e;
const hl = (c) => (c.h << 8) | c.l;
const setBC = (c, v) => ((c.b = (v >> 8) & 0xff), (c.c = v & 0xff));
const setDE = (c, v) => ((c.d = (v >> 8) & 0xff), (c.e = v & 0xff));
const setHL = (c, v) => ((c.h = (v >> 8) & 0xff), (c.l = v & 0xff));

/** The `rp` table (BC/DE/HL/SP), honouring an index prefix on the HL slot. */
function getRP(c, p, idx) {
  if (p === 0) return bc(c);
  if (p === 1) return de(c);
  if (p === 2) return idx ? c[idx] : hl(c);
  return c.sp;
}
function setRP(c, p, v, idx) {
  v &= 0xffff;
  if (p === 0) setBC(c, v);
  else if (p === 1) setDE(c, v);
  else if (p === 2) {
    if (idx) c[idx] = v;
    else setHL(c, v);
  } else c.sp = v;
}

/** The `rp2` table — as `rp`, but the fourth slot is AF (PUSH/POP). */
function getRP2(c, p, idx) {
  return p === 3 ? (c.a << 8) | c.f : getRP(c, p, idx);
}
function setRP2(c, p, v, idx) {
  if (p === 3) {
    c.a = (v >> 8) & 0xff;
    c.f = v & 0xff;
  } else setRP(c, p, v, idx);
}

// ── ALU ──────────────────────────────────────────────────────────────────────

function add8(c, v, carry = 0) {
  const a = c.a;
  const r = a + v + carry;
  const res = r & 0xff;
  c.f =
    sz53(res) |
    (r > 0xff ? CF : 0) |
    ((a ^ v ^ r) & HF) |
    ((a ^ r) & (v ^ r) & 0x80 ? PV : 0);
  c.a = res;
}

function sub8(c, v, carry = 0) {
  const a = c.a;
  const r = a - v - carry;
  const res = r & 0xff;
  c.f =
    sz53(res) |
    NF |
    (r < 0 ? CF : 0) |
    ((a ^ v ^ r) & HF) |
    ((a ^ v) & (a ^ r) & 0x80 ? PV : 0);
  c.a = res;
}

/** CP is SUB with the result thrown away — but F3/F5 come from the OPERAND. */
function cp8(c, v) {
  const a = c.a;
  const r = a - v;
  const res = r & 0xff;
  c.f =
    (res & SF) |
    (res === 0 ? ZF : 0) |
    (v & F53) |
    NF |
    (r < 0 ? CF : 0) |
    ((a ^ v ^ r) & HF) |
    ((a ^ v) & (a ^ r) & 0x80 ? PV : 0);
}

const and8 = (c, v) => ((c.a &= v), (c.f = sz53p(c.a) | HF));
const or8 = (c, v) => ((c.a |= v), (c.f = sz53p(c.a)));
const xor8 = (c, v) => ((c.a ^= v), (c.f = sz53p(c.a)));

/** INC/DEC leave the carry alone — the one thing that makes them not ADD 1. */
function inc8(c, v) {
  const r = (v + 1) & 0xff;
  c.f =
    (c.f & CF) | sz53(r) | ((r & 0x0f) === 0 ? HF : 0) | (r === 0x80 ? PV : 0);
  return r;
}
function dec8(c, v) {
  const r = (v - 1) & 0xff;
  c.f =
    (c.f & CF) |
    sz53(r) |
    NF |
    ((r & 0x0f) === 0x0f ? HF : 0) |
    (r === 0x7f ? PV : 0);
  return r;
}

/** ADD HL,rr — S/Z/PV are untouched; F3/F5 come from the result's HIGH byte. */
function add16(c, a, v) {
  const r = a + v;
  c.f =
    (c.f & (SF | ZF | PV)) |
    (((a ^ v ^ r) >> 8) & HF) |
    ((r >> 16) & CF) |
    ((r >> 8) & F53);
  return r & 0xffff;
}

function adc16(c, a, v) {
  const carry = c.f & CF;
  const r = a + v + carry;
  const res = r & 0xffff;
  c.f =
    ((res >> 8) & (SF | F53)) |
    (res === 0 ? ZF : 0) |
    (r > 0xffff ? CF : 0) |
    (((a ^ v ^ r) >> 8) & HF) |
    ((a ^ r) & (v ^ r) & 0x8000 ? PV : 0);
  return res;
}

function sbc16(c, a, v) {
  const carry = c.f & CF;
  const r = a - v - carry;
  const res = r & 0xffff;
  c.f =
    ((res >> 8) & (SF | F53)) |
    (res === 0 ? ZF : 0) |
    NF |
    (r < 0 ? CF : 0) |
    (((a ^ v ^ r) >> 8) & HF) |
    ((a ^ v) & (a ^ r) & 0x8000 ? PV : 0);
  return res;
}

/**
 * DAA — the BCD correction, and the single most-often-wrong instruction in a
 * hobby core. The correction is chosen from the current H/N/C flags and the
 * two nibbles; N decides whether it is added or subtracted, which is the whole
 * reason the N flag exists.
 */
function daa(c) {
  let add = 0;
  let carry = c.f & CF;
  if (c.f & HF || (c.a & 0x0f) > 9) add = 6;
  if (carry || c.a > 0x99) {
    add |= 0x60;
    carry = CF;
  }
  const before = c.a;
  if (c.f & NF) c.a = (c.a - add) & 0xff;
  else c.a = (c.a + add) & 0xff;
  c.f = sz53p(c.a) | carry | (c.f & NF) | ((before ^ c.a) & HF); // H is whether the correction crossed bit 4
}

// ── Rotates and shifts (the CB group; each sets the full flag byte) ──────────

const rlc = (c, v) => {
  const carry = v >> 7;
  const r = ((v << 1) | carry) & 0xff;
  c.f = sz53p(r) | carry;
  return r;
};
const rrc = (c, v) => {
  const carry = v & 1;
  const r = ((v >> 1) | (carry << 7)) & 0xff;
  c.f = sz53p(r) | carry;
  return r;
};
const rl = (c, v) => {
  const carry = v >> 7;
  const r = ((v << 1) | (c.f & CF)) & 0xff;
  c.f = sz53p(r) | carry;
  return r;
};
const rr = (c, v) => {
  const carry = v & 1;
  const r = ((v >> 1) | ((c.f & CF) << 7)) & 0xff;
  c.f = sz53p(r) | carry;
  return r;
};
const sla = (c, v) => {
  const carry = v >> 7;
  const r = (v << 1) & 0xff;
  c.f = sz53p(r) | carry;
  return r;
};
const sra = (c, v) => {
  const carry = v & 1;
  const r = ((v >> 1) | (v & 0x80)) & 0xff;
  c.f = sz53p(r) | carry;
  return r;
};
/** SLL — undocumented, and shifts a 1 into bit 0. Free with the decode. */
const sll = (c, v) => {
  const carry = v >> 7;
  const r = ((v << 1) | 1) & 0xff;
  c.f = sz53p(r) | carry;
  return r;
};
const srl = (c, v) => {
  const carry = v & 1;
  const r = (v >> 1) & 0xff;
  c.f = sz53p(r) | carry;
  return r;
};

const ROT = [rlc, rrc, rl, rr, sla, sra, sll, srl];

/** The accumulator rotates (RLCA/RRCA/RLA/RRA) touch only H, N, C and F3/F5. */
function rotA(c, kind) {
  const a = c.a;
  let carry;
  let r;
  if (kind === 0) {
    carry = a >> 7;
    r = ((a << 1) | carry) & 0xff;
  } else if (kind === 1) {
    carry = a & 1;
    r = ((a >> 1) | (carry << 7)) & 0xff;
  } else if (kind === 2) {
    carry = a >> 7;
    r = ((a << 1) | (c.f & CF)) & 0xff;
  } else {
    carry = a & 1;
    r = ((a >> 1) | ((c.f & CF) << 7)) & 0xff;
  }
  c.a = r;
  c.f = (c.f & (SF | ZF | PV)) | (r & F53) | carry;
}

/** BIT n,v — Z (and PV) from the tested bit; S only ever from bit 7. */
function bitTest(c, n, v, f53from) {
  const set = v & (1 << n);
  c.f =
    (c.f & CF) |
    HF |
    (set ? 0 : ZF | PV) |
    (f53from & F53) |
    (n === 7 && set ? SF : 0);
}

// ── Conditions ───────────────────────────────────────────────────────────────

/** cc[y]: NZ Z NC C PO PE P M. */
function cond(c, y) {
  switch (y) {
    case 0:
      return !(c.f & ZF);
    case 1:
      return Boolean(c.f & ZF);
    case 2:
      return !(c.f & CF);
    case 3:
      return Boolean(c.f & CF);
    case 4:
      return !(c.f & PV);
    case 5:
      return Boolean(c.f & PV);
    case 6:
      return !(c.f & SF);
    default:
      return Boolean(c.f & SF);
  }
}

// ── Bus helpers ──────────────────────────────────────────────────────────────

/** An M1 opcode fetch — and the ONLY thing that increments R. */
function fetchOp(c, bus) {
  const op = bus.fetch(c.pc);
  c.pc = (c.pc + 1) & 0xffff;
  // R counts 7 bits; bit 7 is whatever LD R,A last put there and never carries.
  c.r = (c.r & 0x80) | ((c.r + 1) & 0x7f);
  return op;
}

/** An operand byte — a plain memory read, NOT an M1, so R does not move. */
function imm8(c, bus) {
  const v = bus.read(c.pc);
  c.pc = (c.pc + 1) & 0xffff;
  return v;
}
function imm16(c, bus) {
  const lo = imm8(c, bus);
  return (imm8(c, bus) << 8) | lo;
}

function push16(c, bus, v) {
  c.sp = (c.sp - 1) & 0xffff;
  bus.write(c.sp, (v >> 8) & 0xff);
  c.sp = (c.sp - 1) & 0xffff;
  bus.write(c.sp, v & 0xff);
}

function pop16(c, bus) {
  const lo = bus.read(c.sp);
  c.sp = (c.sp + 1) & 0xffff;
  const hi = bus.read(c.sp);
  c.sp = (c.sp + 1) & 0xffff;
  return (hi << 8) | lo;
}

// ── The 8-bit register slot, r[z] ────────────────────────────────────────────
// r[] is B C D E H L (HL) A. Slot 6 is memory, which under an index prefix is
// `(IX+d)` and needs its displacement read at a specific point in the
// instruction — so the caller resolves the ADDRESS first (`idxAddr`) and hands
// it in, rather than this reaching for the bus at an unpredictable moment.

const R_FIELD = ["b", "c", "d", "e", "h", "l", null, "a"];

/**
 * Which field does slot `z` name, given an index prefix? H/L become IXH/IXL
 * only when the instruction is NOT also reaching memory through the index —
 * `LD H,(IX+d)` loads the real H. `half` is that test, made once by the caller.
 */
function regField(z, idx, half) {
  if (idx && half && (z === 4 || z === 5)) {
    return (idx === "ix" ? "ix" : "iy") + (z === 4 ? "h" : "l");
  }
  return R_FIELD[z];
}

function getReg(c, bus, z, idx, half, addr) {
  if (z === 6) return bus.read(addr);
  const f = regField(z, idx, half);
  if (f === "ixh") return (c.ix >> 8) & 0xff;
  if (f === "ixl") return c.ix & 0xff;
  if (f === "iyh") return (c.iy >> 8) & 0xff;
  if (f === "iyl") return c.iy & 0xff;
  return c[f];
}

function setReg(c, bus, z, v, idx, half, addr) {
  v &= 0xff;
  if (z === 6) {
    bus.write(addr, v);
    return;
  }
  const f = regField(z, idx, half);
  if (f === "ixh") c.ix = ((v << 8) | (c.ix & 0xff)) & 0xffff;
  else if (f === "ixl") c.ix = (c.ix & 0xff00) | v;
  else if (f === "iyh") c.iy = ((v << 8) | (c.iy & 0xff)) & 0xffff;
  else if (f === "iyl") c.iy = (c.iy & 0xff00) | v;
  else c[f] = v;
}

/** The ALU column, alu[y]: ADD ADC SUB SBC AND XOR OR CP. */
function alu(c, y, v) {
  switch (y) {
    case 0:
      return add8(c, v);
    case 1:
      return add8(c, v, c.f & CF);
    case 2:
      return sub8(c, v);
    case 3:
      return sub8(c, v, c.f & CF);
    case 4:
      return and8(c, v);
    case 5:
      return xor8(c, v);
    case 6:
      return or8(c, v);
    default:
      return cp8(c, v);
  }
}

// ── The decoder ──────────────────────────────────────────────────────────────

/**
 * Execute one instruction from `c.pc`, calling `bus` for every access. Mutates
 * `c` in place. A prefix byte re-enters `dispatch` with an index context; the
 * bus calls appear in exactly the order the real part makes them.
 *
 * @param {object} c - the register scratch copy.
 * @param {object} bus - `{fetch, read, write, in, out, internal}`.
 */
export function execInstruction(c, bus) {
  // HALT keeps fetching (so /M1 and the refresh keep running) and keeps PC.
  if (c.halted) {
    bus.fetch(c.pc);
    c.r = (c.r & 0x80) | ((c.r + 1) & 0x7f);
    return;
  }
  // EI's one-instruction interrupt shadow: this clears the flag EI set last
  // instruction, so after this call it is true only if THIS was an EI.
  c.eiPending = false;
  dispatch(c, bus, fetchOp(c, bus), null);
}

function dispatch(c, bus, op, idx) {
  const x = op >> 6;
  const y = (op >> 3) & 7;
  const z = op & 7;
  const p = y >> 1;
  const q = y & 1;

  // The prefixes first — each is its own M1 fetch, so R has already moved.
  if (op === 0xdd) return dispatch(c, bus, fetchOp(c, bus), "ix");
  if (op === 0xfd) return dispatch(c, bus, fetchOp(c, bus), "iy");
  if (op === 0xcb) return execCB(c, bus, idx);
  if (op === 0xed) return execED(c, bus);

  switch (x) {
    case 0:
      return execX0(c, bus, idx, y, z, p, q);
    case 1: {
      if (z === 6 && y === 6) {
        c.halted = true;
        return;
      }
      // `half` is false when EITHER operand is memory: `LD H,(IX+d)` uses H.
      const half = z !== 6 && y !== 6;
      const addr = z === 6 || y === 6 ? idxAddr(c, bus, idx) : 0;
      return setReg(
        c,
        bus,
        y,
        getReg(c, bus, z, idx, half, addr),
        idx,
        half,
        addr,
      );
    }
    case 2: {
      const addr = z === 6 ? idxAddr(c, bus, idx) : 0;
      return alu(c, y, getReg(c, bus, z, idx, true, addr));
    }
    default:
      return execX3(c, bus, idx, y, z, p, q);
  }
}

/**
 * Resolve `(IX+d)` — reads the displacement byte and pays the 5 internal
 * T-states the real part spends adding it. Returns plain HL with no prefix,
 * where there is no displacement to read at all.
 */
function idxAddr(c, bus, idx) {
  if (!idx) return hl(c);
  const d = signed(imm8(c, bus));
  bus.internal(5);
  return (c[idx] + d) & 0xffff;
}

function execX0(c, bus, idx, y, z, p, q) {
  switch (z) {
    case 0:
      if (y === 0) return; // NOP
      if (y === 1) {
        // EX AF,AF'
        [c.a, c.a2] = [c.a2, c.a];
        [c.f, c.f2] = [c.f2, c.f];
        return;
      }
      if (y === 2) {
        // DJNZ d — the M1 is a T longer, then the branch costs 5 more.
        bus.internal(1);
        const d = signed(imm8(c, bus));
        c.b = (c.b - 1) & 0xff;
        if (c.b !== 0) {
          bus.internal(5);
          c.pc = (c.pc + d) & 0xffff;
        }
        return;
      }
      if (y === 3) {
        const d = signed(imm8(c, bus));
        bus.internal(5);
        c.pc = (c.pc + d) & 0xffff;
        return;
      }
      {
        const d = signed(imm8(c, bus));
        if (cond(c, y - 4)) {
          bus.internal(5);
          c.pc = (c.pc + d) & 0xffff;
        }
        return;
      }
    case 1:
      if (q === 0) return setRP(c, p, imm16(c, bus), idx);
      bus.internal(7);
      return setRP(c, 2, add16(c, getRP(c, 2, idx), getRP(c, p, idx)), idx);
    case 2:
      if (q === 0) {
        if (p === 0) return bus.write(bc(c), c.a);
        if (p === 1) return bus.write(de(c), c.a);
        if (p === 2) {
          const a = imm16(c, bus);
          const v = getRP(c, 2, idx);
          bus.write(a, v & 0xff);
          return bus.write((a + 1) & 0xffff, (v >> 8) & 0xff);
        }
        return bus.write(imm16(c, bus), c.a);
      }
      if (p === 0) return void (c.a = bus.read(bc(c)));
      if (p === 1) return void (c.a = bus.read(de(c)));
      if (p === 2) {
        const a = imm16(c, bus);
        const lo = bus.read(a);
        return setRP(c, 2, (bus.read((a + 1) & 0xffff) << 8) | lo, idx);
      }
      return void (c.a = bus.read(imm16(c, bus)));
    case 3:
      bus.internal(2);
      return setRP(c, p, getRP(c, p, idx) + (q === 0 ? 1 : -1), idx);
    case 4:
    case 5: {
      const addr = y === 6 ? idxAddr(c, bus, idx) : 0;
      const v = getReg(c, bus, y, idx, true, addr);
      if (y === 6) bus.internal(1);
      const r = z === 4 ? inc8(c, v) : dec8(c, v);
      return setReg(c, bus, y, r, idx, true, addr);
    }
    case 6: {
      // `LD (IX+d),n` reads the displacement BEFORE the immediate, and its
      // internal cycles are 2 rather than the usual 5.
      if (y === 6 && idx) {
        const d = signed(imm8(c, bus));
        const n = imm8(c, bus);
        bus.internal(2);
        return bus.write((c[idx] + d) & 0xffff, n);
      }
      const addr = y === 6 ? hl(c) : 0;
      return setReg(c, bus, y, imm8(c, bus), idx, true, addr);
    }
    default:
      if (y < 4) return rotA(c, y);
      if (y === 4) return daa(c);
      if (y === 5) {
        c.a ^= 0xff;
        c.f = (c.f & (SF | ZF | PV | CF)) | HF | NF | (c.a & F53);
        return;
      }
      if (y === 6) {
        // SCF
        c.f = (c.f & (SF | ZF | PV)) | CF | (c.a & F53);
        return;
      }
      // CCF — the old carry lands in H, which is what makes it reversible.
      c.f =
        (c.f & (SF | ZF | PV)) |
        ((c.f & CF) << 4) |
        ((c.f & CF) ^ CF) |
        (c.a & F53);
      return;
  }
}

function execX3(c, bus, idx, y, z, p, q) {
  switch (z) {
    case 0:
      bus.internal(1);
      if (cond(c, y)) c.pc = pop16(c, bus);
      return;
    case 1:
      if (q === 0) return setRP2(c, p, pop16(c, bus), idx);
      if (p === 0) return void (c.pc = pop16(c, bus));
      if (p === 1) {
        // EXX — the three main pairs, never AF.
        [c.b, c.b2] = [c.b2, c.b];
        [c.c, c.c2] = [c.c2, c.c];
        [c.d, c.d2] = [c.d2, c.d];
        [c.e, c.e2] = [c.e2, c.e];
        [c.h, c.h2] = [c.h2, c.h];
        [c.l, c.l2] = [c.l2, c.l];
        return;
      }
      if (p === 2) return void (c.pc = getRP(c, 2, idx));
      bus.internal(2);
      return void (c.sp = getRP(c, 2, idx));
    case 2: {
      const a = imm16(c, bus);
      if (cond(c, y)) c.pc = a;
      return;
    }
    case 3:
      if (y === 0) return void (c.pc = imm16(c, bus));
      if (y === 2) {
        // OUT (n),A — A rides the high half of the port address.
        const n = imm8(c, bus);
        return bus.out((c.a << 8) | n, c.a);
      }
      if (y === 3) {
        const n = imm8(c, bus);
        c.a = bus.in((c.a << 8) | n);
        return;
      }
      if (y === 4) {
        // EX (SP),HL
        const lo = bus.read(c.sp);
        const hi = bus.read((c.sp + 1) & 0xffff);
        bus.internal(1);
        const v = getRP(c, 2, idx);
        bus.write((c.sp + 1) & 0xffff, (v >> 8) & 0xff);
        bus.write(c.sp, v & 0xff);
        bus.internal(2);
        return setRP(c, 2, (hi << 8) | lo, idx);
      }
      if (y === 5) {
        // EX DE,HL — never indexed, however it was prefixed.
        const t = de(c);
        setDE(c, hl(c));
        setHL(c, t);
        return;
      }
      if (y === 6) {
        c.iff1 = 0;
        c.iff2 = 0;
        return;
      }
      c.iff1 = 1;
      c.iff2 = 1;
      c.eiPending = true; // no interrupt until after the NEXT instruction
      return;
    case 4: {
      const a = imm16(c, bus);
      if (cond(c, y)) {
        bus.internal(1);
        push16(c, bus, c.pc);
        c.pc = a;
      }
      return;
    }
    case 5:
      if (q === 0) {
        bus.internal(1);
        return push16(c, bus, getRP2(c, p, idx));
      }
      if (p === 0) {
        const a = imm16(c, bus);
        bus.internal(1);
        push16(c, bus, c.pc);
        c.pc = a;
        return;
      }
      return; // DD/FD/ED are handled in `dispatch` and never reach here
    case 6:
      return alu(c, y, imm8(c, bus));
    default:
      bus.internal(1);
      push16(c, bus, c.pc);
      c.pc = y * 8;
      return;
  }
}

// ── CB: rotates, BIT, RES, SET ───────────────────────────────────────────────

function execCB(c, bus, idx) {
  let addr = 0;
  let op;
  if (idx) {
    // `DD CB dd op` — the displacement comes BEFORE the final byte, and that
    // byte is a plain READ, not an M1 fetch (so R does not move for it).
    const d = signed(imm8(c, bus));
    op = imm8(c, bus);
    bus.internal(2);
    addr = (c[idx] + d) & 0xffff;
  } else {
    op = fetchOp(c, bus);
  }
  const x = op >> 6;
  const y = (op >> 3) & 7;
  const z = op & 7;
  // Under an index prefix EVERY slot operates on (IX+d); a slot other than 6
  // additionally copies the result into that register (undocumented, but it is
  // what the hardware does and it is two lines).
  const mem = idx ? true : z === 6;
  const v = mem
    ? bus.read(idx ? addr : hl(c))
    : getReg(c, bus, z, null, false, 0);
  const target = idx ? addr : hl(c);

  if (x === 1) {
    if (mem) bus.internal(1);
    // With no MEMPTR, the memory forms take F3/F5 from the byte itself.
    return bitTest(c, y, v, mem ? v : v);
  }

  let r;
  if (x === 0) r = ROT[y](c, v);
  else if (x === 2) r = v & ~(1 << y) & 0xff;
  else r = (v | (1 << y)) & 0xff;

  if (mem) {
    bus.internal(1);
    bus.write(target, r);
    if (idx && z !== 6) setReg(c, bus, z, r, null, false, 0);
    return;
  }
  return setReg(c, bus, z, r, null, false, 0);
}

// ── ED: block ops, 16-bit arithmetic, interrupt modes, RRD/RLD ──────────────

const IM_FOR = [0, 0, 1, 2, 0, 0, 1, 2];

function execED(c, bus) {
  const op = fetchOp(c, bus);
  const x = op >> 6;
  const y = (op >> 3) & 7;
  const z = op & 7;
  const p = y >> 1;
  const q = y & 1;

  if (x === 2 && z <= 3 && y >= 4) return blockOp(c, bus, y, z);
  if (x !== 1) return; // every other ED slot is a two-byte NOP

  switch (z) {
    case 0: {
      // IN r,(C) — B rides the high half; slot 6 sets the flags and discards.
      const v = bus.in(bc(c));
      c.f = (c.f & CF) | sz53p(v);
      if (y !== 6) setReg(c, bus, y, v, null, false, 0);
      return;
    }
    case 1:
      // OUT (C),r — slot 6 outputs zero on the Z80 (0xFF on a CMOS Z80C).
      return bus.out(bc(c), y === 6 ? 0 : getReg(c, bus, y, null, false, 0));
    case 2:
      bus.internal(7);
      return setHL(
        c,
        q === 0
          ? sbc16(c, hl(c), getRP(c, p, null))
          : adc16(c, hl(c), getRP(c, p, null)),
      );
    case 3: {
      const a = imm16(c, bus);
      if (q === 0) {
        const v = getRP(c, p, null);
        bus.write(a, v & 0xff);
        return bus.write((a + 1) & 0xffff, (v >> 8) & 0xff);
      }
      const lo = bus.read(a);
      return setRP(c, p, (bus.read((a + 1) & 0xffff) << 8) | lo, null);
    }
    case 4: {
      // NEG — every y aliases it.
      const v = c.a;
      c.a = 0;
      sub8(c, v);
      return;
    }
    case 5:
      // RETN / RETI — both restore IFF1 from the shadow IFF2.
      c.pc = pop16(c, bus);
      c.iff1 = c.iff2;
      return;
    case 6:
      c.im = IM_FOR[y];
      return;
    default:
      if (y === 0) {
        bus.internal(1);
        c.i = c.a;
        return;
      }
      if (y === 1) {
        bus.internal(1);
        c.r = c.a;
        return;
      }
      if (y === 2 || y === 3) {
        // LD A,I / LD A,R — PV shows IFF2, which is how you read the
        // interrupt-enable state at all.
        bus.internal(1);
        c.a = y === 2 ? c.i : c.r;
        c.f = (c.f & CF) | sz53(c.a) | (c.iff2 ? PV : 0);
        return;
      }
      if (y === 4 || y === 5) {
        // RRD / RLD — a nibble rotate through (HL) and the low half of A.
        const v = bus.read(hl(c));
        bus.internal(4);
        let mem;
        if (y === 4) {
          mem = ((c.a << 4) | (v >> 4)) & 0xff;
          c.a = (c.a & 0xf0) | (v & 0x0f);
        } else {
          mem = ((v << 4) | (c.a & 0x0f)) & 0xff;
          c.a = (c.a & 0xf0) | (v >> 4);
        }
        bus.write(hl(c), mem);
        c.f = (c.f & CF) | sz53p(c.a);
        return;
      }
      return; // ED 77 / ED 7F — NOP
  }
}

/**
 * The block group: LDI/LDD/LDIR/LDDR, CPI/CPD/CPIR/CPDR, INI/IND/INIR/INDR,
 * OUTI/OUTD/OTIR/OTDR. `y` picks the operation and the direction (bit 0 of
 * y - 4 is decrement), `z` picks the family. A repeating form that still has
 * work to do backs PC up over its own two bytes, so each iteration is a
 * separate instruction — which is exactly why an interrupt can land in the
 * middle of an LDIR on real hardware.
 */
function blockOp(c, bus, y, z) {
  const dec = (y & 1) === 1;
  const repeat = y >= 6;
  const delta = dec ? -1 : 1;

  if (z === 0) {
    // LDI / LDD / LDIR / LDDR
    const v = bus.read(hl(c));
    bus.write(de(c), v);
    bus.internal(2);
    setHL(c, (hl(c) + delta) & 0xffff);
    setDE(c, (de(c) + delta) & 0xffff);
    setBC(c, (bc(c) - 1) & 0xffff);
    const n = (c.a + v) & 0xff;
    c.f =
      (c.f & (SF | ZF | CF)) |
      (bc(c) !== 0 ? PV : 0) |
      (n & F3) |
      (n & 0x02 ? F5 : 0);
    if (repeat && bc(c) !== 0) {
      bus.internal(5);
      c.pc = (c.pc - 2) & 0xffff;
    }
    return;
  }

  if (z === 1) {
    // CPI / CPD / CPIR / CPDR — compares against (HL) without touching it.
    const v = bus.read(hl(c));
    bus.internal(5);
    const r = (c.a - v) & 0xff;
    const half = (c.a ^ v ^ r) & HF;
    setHL(c, (hl(c) + delta) & 0xffff);
    setBC(c, (bc(c) - 1) & 0xffff);
    const n = (r - (half ? 1 : 0)) & 0xff;
    c.f =
      (c.f & CF) |
      NF |
      (r & SF) |
      (r === 0 ? ZF : 0) |
      half |
      (bc(c) !== 0 ? PV : 0) |
      (n & F3) |
      (n & 0x02 ? F5 : 0);
    if (repeat && bc(c) !== 0 && r !== 0) {
      bus.internal(5);
      c.pc = (c.pc - 2) & 0xffff;
    }
    return;
  }

  if (z === 2) {
    // INI / IND / INIR / INDR — the port is BC with B as it stands NOW.
    bus.internal(1);
    const v = bus.in(bc(c));
    bus.write(hl(c), v);
    c.b = (c.b - 1) & 0xff;
    setHL(c, (hl(c) + delta) & 0xffff);
    const k = v + ((c.c + delta) & 0xff);
    c.f =
      sz53(c.b) |
      (v & 0x80 ? NF : 0) |
      (k > 0xff ? HF | CF : 0) |
      parity((k & 7) ^ c.b);
    if (repeat && c.b !== 0) {
      bus.internal(5);
      c.pc = (c.pc - 2) & 0xffff;
    }
    return;
  }

  // OUTI / OUTD / OTIR / OTDR — B is decremented BEFORE the port address is
  // formed, so the port sees the new B.
  bus.internal(1);
  const v = bus.read(hl(c));
  c.b = (c.b - 1) & 0xff;
  bus.out(bc(c), v);
  setHL(c, (hl(c) + delta) & 0xffff);
  const k = v + c.l;
  c.f =
    sz53(c.b) |
    (v & 0x80 ? NF : 0) |
    (k > 0xff ? HF | CF : 0) |
    parity((k & 7) ^ c.b);
  if (repeat && c.b !== 0) {
    bus.internal(5);
    c.pc = (c.pc - 2) & 0xffff;
  }
}

// ── Interrupt entry ──────────────────────────────────────────────────────────

/**
 * A non-maskable interrupt. IFF1 is cleared and IFF2 keeps the old value, so
 * RETN can put it back — that pair IS the NMI's "remember whether interrupts
 * were on" mechanism.
 */
export function doNmi(c, bus) {
  c.halted = false;
  bus.fetch(c.pc); // the /M1 acknowledge cycle; the byte is discarded
  c.r = (c.r & 0x80) | ((c.r + 1) & 0x7f);
  c.iff2 = c.iff1;
  c.iff1 = 0;
  bus.internal(1);
  push16(c, bus, c.pc);
  c.pc = 0x0066;
}

/**
 * A maskable interrupt, in whichever mode is selected.
 *   IM 0 — execute the byte the device puts on the bus as an instruction. An
 *          UNDRIVEN bus floats, reads as $FF through `asInput`, and so becomes
 *          `RST 38h` — exactly what happens on a real bench.
 *   IM 1 — a fixed `RST 38h`.
 *   IM 2 — (I << 8) | vector selects a table entry holding the handler address.
 */
export function doInt(c, bus) {
  c.halted = false;
  c.iff1 = 0;
  c.iff2 = 0;
  const vector = bus.intAck(c.pc);
  c.r = (c.r & 0x80) | ((c.r + 1) & 0x7f);

  if (c.im === 2) {
    bus.internal(1);
    push16(c, bus, c.pc);
    const slot = ((c.i << 8) | (vector & 0xfe)) & 0xffff;
    const lo = bus.read(slot);
    c.pc = (bus.read((slot + 1) & 0xffff) << 8) | lo;
    return;
  }
  if (c.im === 1) {
    bus.internal(1);
    push16(c, bus, c.pc);
    c.pc = 0x0038;
    return;
  }
  // IM 0: run the supplied byte as an instruction. The overwhelmingly common
  // case is an RST, which pushes and vectors on its own.
  dispatch(c, bus, vector, null);
}

/** Fresh power-on registers — what /RESET leaves behind. */
export function initialRegs() {
  return {
    a: 0xff,
    f: 0xff,
    b: 0,
    c: 0,
    d: 0,
    e: 0,
    h: 0,
    l: 0,
    a2: 0xff,
    f2: 0xff,
    b2: 0,
    c2: 0,
    d2: 0,
    e2: 0,
    h2: 0,
    l2: 0,
    ix: 0xffff,
    iy: 0xffff,
    sp: 0xffff,
    pc: 0,
    i: 0,
    r: 0,
    iff1: 0,
    iff2: 0,
    im: 0,
    halted: false,
    eiPending: false,
  };
}

/** The register field names, in the order state is copied between cycles. */
export const REG_KEYS = Object.freeze(Object.keys(initialRegs()));

/** Lift just the registers out of a machine state (never its bus bookkeeping). */
export function regsOf(s) {
  const out = {};
  for (const k of REG_KEYS) out[k] = s[k];
  return out;
}

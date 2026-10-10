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

// disasm-z80.js — the Z80 disassembler the CPU monitor shows its instruction
// pipeline with. PURE and DOM-free. It decodes on the opcode's own fields
// (x = bits 7–6, y = 5–3, z = 2–0, p = y >> 1, q = y & 1), the same split
// z80-ops.js executes on, with the CB, ED, DD/FD and DDCB/FDCB prefixes.
//
// Under DD/FD, HL becomes IX/IY, (HL) becomes (IX+d), and H/L become the
// undocumented IXH/IXL — except in an instruction that also uses (IX+d), where
// H and L stay themselves. A DD/FD in front of an instruction that touches none
// of those is a NOP of its own (one byte), and the instruction after it is the
// next line, which is how the silicon runs it. An ED opcode with no
// instruction is a two-byte NOP.
//
// Memory is read through `read(addr)`, which may answer null for a byte the
// monitor cannot see; an operand it could not read shows as `??`.

const R = ["B", "C", "D", "E", "H", "L", "(HL)", "A"];
const RP = ["BC", "DE", "HL", "SP"];
const RP2 = ["BC", "DE", "HL", "AF"];
const CC = ["NZ", "Z", "NC", "C", "PO", "PE", "P", "M"];
const ALU = [
  "ADD A,",
  "ADC A,",
  "SUB ",
  "SBC A,",
  "AND ",
  "XOR ",
  "OR ",
  "CP ",
];
const ROT = ["RLC", "RRC", "RL", "RR", "SLA", "SRA", "SLL", "SRL"];
const IM = ["0", "0/1", "1", "2", "0", "0/1", "1", "2"];
const X0Z7 = ["RLCA", "RRCA", "RLA", "RRA", "DAA", "CPL", "SCF", "CCF"];
const BLOCK = [
  ["LDI", "CPI", "INI", "OUTI"],
  ["LDD", "CPD", "IND", "OUTD"],
  ["LDIR", "CPIR", "INIR", "OTIR"],
  ["LDDR", "CPDR", "INDR", "OTDR"],
];

const hex2 = (v) => (v == null ? "??" : v.toString(16).toUpperCase().padStart(2, "0")); // prettier-ignore
const hex4 = (v) => (v == null ? "????" : v.toString(16).toUpperCase().padStart(4, "0")); // prettier-ignore
const signed = (b) => (b < 0x80 ? b : b - 256);

/** A displacement as the index operand prints it: `+$05`, `-$03`. */
function disp(d) {
  if (d == null) return "+$??";
  const s = signed(d);
  return s < 0 ? `-$${hex2(-s)}` : `+$${hex2(s)}`;
}

/**
 * A byte cursor over memory from one address: `next()` takes the next byte
 * (null if unreadable), and `bytes` is everything taken.
 */
function cursor(read, addr) {
  const bytes = [];
  return {
    bytes,
    next() {
      const v = read((addr + bytes.length) & 0xffff);
      bytes.push(v);
      return v;
    },
    word() {
      const lo = this.next();
      const hi = this.next();
      return lo == null || hi == null ? null : lo | (hi << 8);
    },
  };
}

/** The CB page: rotates, shifts and bit operations on r[z]. */
function decodeCB(op) {
  const x = op >> 6;
  const y = (op >> 3) & 7;
  const z = op & 7;
  if (x === 0) return `${ROT[y]} ${R[z]}`;
  return `${["", "BIT", "RES", "SET"][x]} ${y},${R[z]}`;
}

/** The ED page. Returns the text, or null for an opcode with none. */
function decodeED(op, c) {
  const x = op >> 6;
  const y = (op >> 3) & 7;
  const z = op & 7;
  const p = y >> 1;
  const q = y & 1;
  if (x === 1) {
    switch (z) {
      case 0:
        return y === 6 ? "IN (C)" : `IN ${R[y]},(C)`;
      case 1:
        return y === 6 ? "OUT (C),0" : `OUT (C),${R[y]}`;
      case 2:
        return `${q ? "ADC" : "SBC"} HL,${RP[p]}`;
      case 3: {
        const nn = `($${hex4(c.word())})`;
        return q ? `LD ${RP[p]},${nn}` : `LD ${nn},${RP[p]}`;
      }
      case 4:
        return "NEG";
      case 5:
        return y === 1 ? "RETI" : "RETN";
      case 6:
        return `IM ${IM[y]}`;
      default:
        return ["LD I,A", "LD R,A", "LD A,I", "LD A,R", "RRD", "RLD", null, null][y]; // prettier-ignore
    }
  }
  if (x === 2 && z <= 3 && y >= 4) return BLOCK[y - 4][z];
  return null;
}

/**
 * The unprefixed page, with HL standing for `ix` (null, "IX" or "IY"). Index
 * operands take their displacement from `c` the first time one is named.
 * Returns the text, or null for an instruction a DD/FD prefix does not touch
 * (the caller prints the prefix as a NOP on its own).
 */
function decodeMain(op, c, ix, at) {
  const x = op >> 6;
  const y = (op >> 3) & 7;
  const z = op & 7;
  const p = y >> 1;
  const q = y & 1;
  let touched = false;
  let d;
  // (HL) → (IX+d): the displacement is the byte after the opcode, read once.
  const mem = () => {
    touched = true;
    if (!ix) return "(HL)";
    if (d === undefined) d = c.next();
    return `(${ix}${disp(d)})`;
  };
  // r[i], H/L → IXH/IXL unless `plain` (the instruction also uses (IX+d)).
  const r = (i, plain = false) => {
    if (i === 6) return mem();
    if (ix && !plain && (i === 4 || i === 5)) {
      touched = true;
      return `${ix}${i === 4 ? "H" : "L"}`;
    }
    return R[i];
  };
  const hl = () => {
    touched = true;
    return ix ?? "HL";
  };
  const rp = (i) => (i === 2 ? hl() : RP[i]);
  const rp2 = (i) => (i === 2 ? hl() : RP2[i]);
  const n = () => `$${hex2(c.next())}`;
  const nn = () => `$${hex4(c.word())}`;
  const rel = () => {
    const off = c.next();
    return off == null ? "$????" : `$${hex4((at + c.bytes.length + signed(off)) & 0xffff)}`; // prettier-ignore
  };

  let text;
  if (x === 0) {
    switch (z) {
      case 0:
        text = ["NOP", "EX AF,AF'", null, null][y] ?? (y === 2 ? `DJNZ ${rel()}` : y === 3 ? `JR ${rel()}` : `JR ${CC[y - 4]},${rel()}`); // prettier-ignore
        break;
      case 1:
        text = q ? `ADD ${hl()},${rp(p)}` : `LD ${rp(p)},${nn()}`;
        break;
      case 2:
        if (q === 0) {
          text = [() => "LD (BC),A", () => "LD (DE),A", () => `LD (${nn()}),${hl()}`, () => `LD (${nn()}),A`][p](); // prettier-ignore
        } else {
          text = [() => "LD A,(BC)", () => "LD A,(DE)", () => `LD ${hl()},(${nn()})`, () => `LD A,(${nn()})`][p](); // prettier-ignore
        }
        break;
      case 3:
        text = `${q ? "DEC" : "INC"} ${rp(p)}`;
        break;
      case 4:
        text = `INC ${r(y)}`;
        break;
      case 5:
        text = `DEC ${r(y)}`;
        break;
      case 6: {
        const dst = r(y); // (IX+d)'s displacement comes before the immediate
        text = `LD ${dst},${n()}`;
        break;
      }
      default:
        text = X0Z7[y];
    }
  } else if (x === 1) {
    if (y === 6 && z === 6) text = "HALT";
    else {
      const plain = y === 6 || z === 6;
      const dst = r(y, plain);
      text = `LD ${dst},${r(z, plain)}`;
    }
  } else if (x === 2) {
    text = `${ALU[y]}${r(z)}`;
  } else {
    switch (z) {
      case 0:
        text = `RET ${CC[y]}`;
        break;
      case 1:
        if (q === 0) text = `POP ${rp2(p)}`;
        else text = [() => "RET", () => "EXX", () => `JP (${hl()})`, () => `LD SP,${hl()}`][p](); // prettier-ignore
        break;
      case 2:
        text = `JP ${CC[y]},${nn()}`;
        break;
      case 3:
        switch (y) {
          case 0:
            text = `JP ${nn()}`;
            break;
          case 2:
            text = `OUT (${n()}),A`;
            break;
          case 3:
            text = `IN A,(${n()})`;
            break;
          case 4:
            text = `EX (SP),${hl()}`;
            break;
          default:
            text = [null, null, null, null, null, "EX DE,HL", "DI", "EI"][y];
        }
        break;
      case 4:
        text = `CALL ${CC[y]},${nn()}`;
        break;
      case 5:
        text = q === 0 ? `PUSH ${rp2(p)}` : `CALL ${nn()}`;
        break;
      case 6:
        text = `${ALU[y]}${n()}`;
        break;
      default:
        text = `RST $${hex2(y * 8)}`;
    }
  }
  return ix && !touched ? null : text;
}

/**
 * Decode the instruction at `addr`.
 * @param {(addr: number) => number|null} read - one byte, or null if unknown
 * @param {number} addr
 * @returns {{addr: number, length: number, bytes: Array<number|null>,
 *   text: string, mode: string, illegal: boolean}} — `illegal` for an opcode
 *   the Z80 runs as a NOP (an ED hole, a DD/FD with nothing to index)
 */
export function disassembleZ80(read, addr) {
  addr &= 0xffff;
  const c = cursor(read, addr);
  const done = (text, illegal = false) => ({
    addr,
    length: c.bytes.length,
    bytes: c.bytes,
    text,
    mode: "",
    illegal,
  });
  const op = c.next();
  if (op == null) return done("??");

  if (op === 0xcb) {
    const op2 = c.next();
    return done(op2 == null ? "??" : decodeCB(op2));
  }
  if (op === 0xed) {
    const op2 = c.next();
    if (op2 == null) return done("??");
    const text = decodeED(op2, c);
    return text == null ? done("NOP", true) : done(text);
  }
  if (op === 0xdd || op === 0xfd) {
    const ix = op === 0xdd ? "IX" : "IY";
    const op2 = read((addr + 1) & 0xffff);
    if (op2 == null) return done("??");
    // Another prefix (or ED) after it: this one is a NOP of its own.
    if (op2 === 0xdd || op2 === 0xfd || op2 === 0xed) return done("NOP", true);
    if (op2 === 0xcb) {
      // DD CB d op: the displacement comes BEFORE the final opcode.
      c.next();
      const d = c.next();
      const op3 = c.next();
      if (op3 == null) return done("??");
      const x = op3 >> 6;
      const y = (op3 >> 3) & 7;
      const z = op3 & 7;
      const target = `(${ix}${disp(d)})`;
      const base =
        x === 0
          ? `${ROT[y]} ${target}`
          : `${["", "BIT", "RES", "SET"][x]} ${y},${target}`;
      // The undocumented forms that also copy the result into r[z].
      return done(x !== 1 && z !== 6 ? `${base},${R[z]}` : base);
    }
    const body = cursor(read, (addr + 1) & 0xffff);
    body.next();
    const text = decodeMain(op2, body, ix, addr);
    if (text == null) return done("NOP", true);
    c.bytes.push(...body.bytes);
    return done(text);
  }
  return done(decodeMain(op, c, null, addr));
}

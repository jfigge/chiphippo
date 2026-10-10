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

// disasm.test.js — the CPU monitor's two disassemblers (sim/disasm-6502.js,
// sim/disasm-z80.js): each line's text, length and bytes, and what an
// unreadable byte does to a line.

import test from "node:test";
import assert from "node:assert/strict";

import { disassemble6502 } from "../sim/disasm-6502.js";
import { disassembleZ80 } from "../sim/disasm-z80.js";
import { W65C02_OPCODES } from "../sim/w65c02.js";

/** A reader over `bytes` placed at `org`; null outside them. */
const reader =
  (bytes, org = 0) =>
  (addr) => {
    const i = addr - org;
    return i >= 0 && i < bytes.length ? bytes[i] : null;
  };

const line6502 = (bytes, org = 0x0200) =>
  disassemble6502(reader(bytes, org), org);
const lineZ80 = (bytes, org = 0) => disassembleZ80(reader(bytes, org), org);

test("6502: every addressing mode prints its operand", () => {
  const cases = [
    [[0xa9, 0xff], "LDA #$FF", "IMM"],
    [[0xa5, 0x12], "LDA $12", "ZP"],
    [[0xb5, 0x12], "LDA $12,X", "ZPX"],
    [[0xb6, 0x12], "LDX $12,Y", "ZPY"],
    [[0x8d, 0x02, 0x60], "STA $6002", "ABS"],
    [[0xbd, 0x34, 0x12], "LDA $1234,X", "ABX"],
    [[0xb9, 0x34, 0x12], "LDA $1234,Y", "ABY"],
    [[0xa1, 0x40], "LDA ($40,X)", "IZX"],
    [[0xb1, 0x40], "LDA ($40),Y", "IZY"],
    [[0xb2, 0x40], "LDA ($40)", "IZP"],
    [[0x0a], "ASL A", "ACC"],
    [[0x1a], "INC A", "ACC"],
    [[0xe8], "INX", "IMP"],
    [[0x6c, 0xfc, 0xff], "JMP ($FFFC)", "IND"],
    [[0x7c, 0x00, 0x80], "JMP ($8000,X)", "IAX"],
    [[0x20, 0x60, 0x02], "JSR $0260", "ABS"],
  ];
  for (const [bytes, text, mode] of cases) {
    const l = line6502(bytes);
    assert.equal(l.text, text);
    assert.equal(l.mode, mode, text);
    assert.equal(l.length, bytes.length, text);
    assert.deepEqual(l.bytes, bytes, text);
  }
});

test("6502: branches print their target, forward and back", () => {
  assert.equal(line6502([0xd0, 0x05]).text, "BNE $0207");
  assert.equal(line6502([0x80, 0xfe]).text, "BRA $0200");
  // BBRx/BBSx: zero page, then a branch from the end of the 3-byte line.
  const bbr = line6502([0x3f, 0x12, 0xfd]);
  assert.equal(bbr.text, "BBR3 $12,$0200");
  assert.equal(bbr.length, 3);
  assert.equal(line6502([0xf7, 0x80]).text, "SMB7 $80");
});

test("6502: lengths agree with the core for every opcode", () => {
  for (let op = 0; op < 256; op++) {
    const l = line6502([op, 0, 0]);
    const e = W65C02_OPCODES[op];
    if (!e) {
      assert.equal(l.length, 1, `$${op.toString(16)} runs as a 1-byte NOP`);
      assert.equal(l.illegal, true);
      continue;
    }
    assert.ok(l.length >= 1 && l.length <= 3, `$${op.toString(16)}`);
    assert.equal(l.illegal, e.m === "NOPR", `$${op.toString(16)}`);
  }
  // The undefined NOPs the W65C02S skips operands for.
  assert.equal(line6502([0x02, 0x00]).length, 2);
  assert.equal(line6502([0x5c, 0, 0]).length, 3);
  assert.equal(line6502([0x5c, 0, 0]).text, "NOP $0000");
  // BRK skips its signature byte, so the next line starts after it.
  assert.equal(line6502([0x00, 0xea]).length, 2);
});

test("6502: an unreadable byte decodes as far as it can", () => {
  assert.equal(line6502([]).text, "??");
  const l = line6502([0xad, 0x34]); // the high byte is not there
  assert.equal(l.text, "LDA $????");
  assert.deepEqual(l.bytes, [0xad, 0x34, null]);
  assert.equal(line6502([0xd0]).text, "BNE $????");
});

test("Z80: the unprefixed page", () => {
  const cases = [
    [[0x00], "NOP"],
    [[0x3e, 0x42], "LD A,$42"],
    [[0x32, 0x00, 0x06], "LD ($0600),A"],
    [[0x21, 0x34, 0x12], "LD HL,$1234"],
    [[0x2a, 0x34, 0x12], "LD HL,($1234)"],
    [[0x09], "ADD HL,BC"],
    [[0x34], "INC (HL)"],
    [[0x36, 0x07], "LD (HL),$07"],
    [[0x78], "LD A,B"],
    [[0x76], "HALT"],
    [[0x86], "ADD A,(HL)"],
    [[0x90], "SUB B"],
    [[0xfe, 0x10], "CP $10"],
    [[0xc9], "RET"],
    [[0xc0], "RET NZ"],
    [[0xc3, 0x00, 0x01], "JP $0100"],
    [[0xca, 0x00, 0x01], "JP Z,$0100"],
    [[0xcd, 0x00, 0x01], "CALL $0100"],
    [[0xf5], "PUSH AF"],
    [[0xd9], "EXX"],
    [[0x08], "EX AF,AF'"],
    [[0xeb], "EX DE,HL"],
    [[0xe9], "JP (HL)"],
    [[0xd3, 0x10], "OUT ($10),A"],
    [[0xdb, 0x10], "IN A,($10)"],
    [[0xff], "RST $38"],
    [[0x07], "RLCA"],
    [[0xf3], "DI"],
  ];
  for (const [bytes, text] of cases) {
    const l = lineZ80(bytes);
    assert.equal(l.text, text);
    assert.equal(l.length, bytes.length, text);
  }
});

test("Z80: relative jumps print their target", () => {
  assert.equal(lineZ80([0x18, 0xfe], 0x100).text, "JR $0100");
  assert.equal(lineZ80([0x20, 0x03], 0x100).text, "JR NZ,$0105");
  assert.equal(lineZ80([0x10, 0xfe], 0x100).text, "DJNZ $0100");
});

test("Z80: the CB and ED pages", () => {
  assert.equal(lineZ80([0xcb, 0x00]).text, "RLC B");
  assert.equal(lineZ80([0xcb, 0x7e]).text, "BIT 7,(HL)");
  assert.equal(lineZ80([0xcb, 0xc7]).text, "SET 0,A");
  assert.equal(lineZ80([0xcb, 0x87]).length, 2);
  assert.equal(lineZ80([0xed, 0xb0]).text, "LDIR");
  assert.equal(lineZ80([0xed, 0x44]).text, "NEG");
  assert.equal(lineZ80([0xed, 0x56]).text, "IM 1");
  assert.equal(lineZ80([0xed, 0x4d]).text, "RETI");
  assert.equal(lineZ80([0xed, 0x78]).text, "IN A,(C)");
  assert.equal(lineZ80([0xed, 0x52]).text, "SBC HL,DE");
  const ld = lineZ80([0xed, 0x73, 0x00, 0x80]);
  assert.equal(ld.text, "LD ($8000),SP");
  assert.equal(ld.length, 4);
  const hole = lineZ80([0xed, 0x00]);
  assert.equal(hole.text, "NOP");
  assert.equal(hole.illegal, true);
  assert.equal(hole.length, 2);
});

test("Z80: DD/FD index the HL forms", () => {
  assert.equal(lineZ80([0xdd, 0x21, 0x00, 0x40]).text, "LD IX,$4000");
  assert.equal(lineZ80([0xdd, 0x21, 0x00, 0x40]).length, 4);
  assert.equal(lineZ80([0xfd, 0x7e, 0x05]).text, "LD A,(IY+$05)");
  assert.equal(lineZ80([0xdd, 0x66, 0xfd]).text, "LD H,(IX-$03)");
  const st = lineZ80([0xdd, 0x36, 0x02, 0x99]);
  assert.equal(st.text, "LD (IX+$02),$99");
  assert.equal(st.length, 4);
  assert.equal(lineZ80([0xdd, 0x34, 0x01]).text, "INC (IX+$01)");
  assert.equal(lineZ80([0xdd, 0xe9]).text, "JP (IX)");
  assert.equal(lineZ80([0xfd, 0xe5]).text, "PUSH IY");
  assert.equal(lineZ80([0xdd, 0x7c]).text, "LD A,IXH");
  // A prefix with nothing to index is a NOP of its own.
  const lone = lineZ80([0xdd, 0x00]);
  assert.equal(lone.text, "NOP");
  assert.equal(lone.length, 1);
  assert.equal(lone.illegal, true);
  assert.equal(lineZ80([0xdd, 0xc9]).length, 1, "RET is not indexed");
  assert.equal(lineZ80([0xdd, 0xeb]).length, 1, "EX DE,HL is not indexed");
});

test("Z80: DDCB/FDCB take the displacement before the opcode", () => {
  const bit = lineZ80([0xdd, 0xcb, 0x04, 0x46]);
  assert.equal(bit.text, "BIT 0,(IX+$04)");
  assert.equal(bit.length, 4);
  assert.equal(lineZ80([0xfd, 0xcb, 0xff, 0x06]).text, "RLC (IY-$01)");
  assert.equal(lineZ80([0xfd, 0xcb, 0x00, 0xc0]).text, "SET 0,(IY+$00),B");
});

test("Z80: an unreadable byte decodes as far as it can", () => {
  assert.equal(lineZ80([]).text, "??");
  const l = lineZ80([0xc3, 0x00]);
  assert.equal(l.text, "JP $????");
  assert.deepEqual(l.bytes, [0xc3, 0x00, null]);
});

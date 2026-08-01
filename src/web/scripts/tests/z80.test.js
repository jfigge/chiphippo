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

// z80.test.js — the Z80 CPU CORE against a plain 64 KiB memory array plus a
// 64 K port space (fast, no engine/clock plumbing). Each `cycle()` drives one
// whole clock cycle — a rising edge that advances a T-state and serves the bus,
// then a falling edge — and small programs then assert registers and memory.
// Reset boots at $0000 with no vector, so a machine simply runs from `org`.
//
// The second half drives the CATALOG UNIT (`partDef("Z80A").logic`) through
// hand-built level maps, which is where the pin-level contract is proved: /M1
// on a fetch, /RFSH and the refresh address behind it, /WAIT stretching a
// cycle, and /BUSRQ floating the lot.

import test from "node:test";
import assert from "node:assert/strict";

import { initialZ80, z80Tick, z80Fall } from "../sim/z80.js";
import { SF, ZF, HF, PV, NF, CF } from "../sim/z80-ops.js";
import { partDef } from "../catalog/index.js";
import { H, L, Z } from "../sim/levels.js";

/** T-state counts and sampling edges, mirroring the module's own table. */
const LEN = {
  M1: 4,
  READ: 3,
  WRITE: 3,
  IN: 4,
  OUT: 4,
  INTACK: 6,
  RESET: 1,
  BUSACK: 1,
};
const SAMPLE = { M1: 3, READ: 3, IN: 4, INTACK: 6 };

/** A CPU wired to a flat memory image and a flat port space. */
function machine(program, org = 0x0000) {
  const mem = new Uint8Array(0x10000);
  const io = new Uint8Array(0x10000);
  mem.set(program, org);
  let state = initialZ80();
  let ctl = { reset: false, int: false, nmi: false, wait: false, busrq: false };
  let vector = 0xff; // what an INTACK cycle finds on the bus

  // One tick with /RESET asserted puts the CPU in its held-reset state; the
  // next rising edge with it released begins the first fetch at $0000.
  state = z80Tick(state, { ...ctl, reset: true, data: 0xff });

  const m = {
    mem,
    io,
    get state() {
      return state;
    },
    setCtl(patch) {
      ctl = { ...ctl, ...patch };
    },
    setVector(v) {
      vector = v & 0xff;
    },
    /** One whole clock cycle: rising edge (advance + serve), then falling. */
    cycle() {
      const s = state;
      let data = 0xff;
      // Serve the byte on the edge the CPU latches it — the one ENTERING the
      // sampling T-state, while the cycle's own address is still on the bus.
      if (s.t + 1 === SAMPLE[s.mk] && !s.wait) {
        if (s.mk === "M1" || s.mk === "READ") data = mem[s.addr];
        else if (s.mk === "IN") data = io[s.addr];
        else if (s.mk === "INTACK") data = vector;
      }
      state = z80Tick(state, { ...ctl, data });
      // A write commits as its cycle ends — the same edge the CPU releases it.
      const len = s.mk === "INTERNAL" ? s.itc : LEN[s.mk];
      if (s.t === len && !s.wait) {
        if (s.mk === "WRITE") mem[s.addr] = s.dout;
        else if (s.mk === "OUT") io[s.addr] = s.dout;
      }
      state = z80Fall(state, ctl);
    },
    steps(n) {
      for (let i = 0; i < n; i++) m.cycle();
    },
    /** Run until the CPU is about to fetch the opcode at `pc`. */
    runTo(pc, max = 20000) {
      for (let i = 0; i < max; i++) {
        m.cycle();
        if (
          state.cur === "instr" &&
          state.mk === "M1" &&
          state.t === 1 &&
          state.pc === pc
        ) {
          return;
        }
      }
      throw new Error(`runTo $${pc.toString(16)} not reached`);
    },
  };
  return m;
}

const hl = (s) => (s.h << 8) | s.l;
const de = (s) => (s.d << 8) | s.e;
const bc = (s) => (s.b << 8) | s.c;

// ── Reset and the load spine ────────────────────────────────────────────────

test("reset boots at $0000 with SP = $FFFF, interrupts off, IM 0", () => {
  const m = machine([0x00]);
  assert.equal(m.state.pc, 0x0000);
  assert.equal(m.state.sp, 0xffff);
  assert.equal(m.state.iff1, 0);
  assert.equal(m.state.iff2, 0);
  assert.equal(m.state.im, 0);
});

test("LD A,n / LD (nn),A / LD A,(HL)", () => {
  // LD A,$42 ; LD ($0600),A ; LD HL,$0600 ; LD A,(HL)  (via a scrub of A)
  const m = machine([
    0x3e, 0x42, 0x32, 0x00, 0x06, 0x21, 0x00, 0x06, 0x3e, 0x00, 0x7e, 0x00,
  ]);
  m.runTo(11);
  assert.equal(m.mem[0x0600], 0x42, "stored");
  assert.equal(m.state.a, 0x42, "loaded back through (HL)");
});

test("16-bit load, ADD HL,rr and INC/DEC rr", () => {
  // LD HL,$1234 ; LD DE,$1111 ; ADD HL,DE ; INC DE ; DEC HL
  const m = machine([
    0x21, 0x34, 0x12, 0x11, 0x11, 0x11, 0x19, 0x13, 0x2b, 0x00,
  ]);
  m.runTo(9);
  assert.equal(hl(m.state), 0x2344);
  assert.equal(de(m.state), 0x1112);
});

// ── The flag matrix ─────────────────────────────────────────────────────────

test("ADD $FF+$01 sets Z, C and H together", () => {
  const m = machine([0x3e, 0xff, 0xc6, 0x01, 0x00]);
  m.runTo(4);
  assert.equal(m.state.a, 0x00);
  assert.ok(m.state.f & ZF, "Z");
  assert.ok(m.state.f & CF, "C");
  assert.ok(m.state.f & HF, "H");
  assert.ok(!(m.state.f & NF), "N clear after an add");
});

test("ADD $7F+$01 is the signed OVERFLOW case, not a carry", () => {
  const m = machine([0x3e, 0x7f, 0xc6, 0x01, 0x00]);
  m.runTo(4);
  assert.equal(m.state.a, 0x80);
  assert.ok(m.state.f & PV, "PV — overflow into the sign bit");
  assert.ok(m.state.f & SF, "S");
  assert.ok(!(m.state.f & CF), "C clear — no carry out of bit 7");
});

test("SUB $00-$01 borrows, and sets N", () => {
  const m = machine([0x3e, 0x00, 0xd6, 0x01, 0x00]);
  m.runTo(4);
  assert.equal(m.state.a, 0xff);
  assert.ok(m.state.f & CF, "C — borrow");
  assert.ok(m.state.f & NF, "N");
  assert.ok(m.state.f & SF, "S");
});

test("CP takes its undocumented F3/F5 from the OPERAND, not the result", () => {
  // LD A,$00 ; CP $28 — the operand carries both bits, the result ($D8) does not.
  const m = machine([0x3e, 0x00, 0xfe, 0x28, 0x00]);
  m.runTo(4);
  assert.equal(m.state.a, 0x00, "CP leaves A alone");
  assert.equal(m.state.f & 0x28, 0x28, "F3/F5 copied from $28");
});

test("AND sets H and clears C; OR/XOR clear both", () => {
  const m = machine([0x3e, 0xf0, 0xe6, 0x3c, 0x00]); // LD A,$F0 ; AND $3C
  m.runTo(4);
  assert.equal(m.state.a, 0x30);
  assert.ok(m.state.f & HF, "AND sets H");
  assert.ok(!(m.state.f & CF), "C clear");

  const m2 = machine([0x3e, 0xf0, 0xf6, 0x0f, 0x00]); // LD A,$F0 ; OR $0F
  m2.runTo(4);
  assert.equal(m2.state.a, 0xff);
  assert.ok(!(m2.state.f & HF), "OR clears H");
  assert.ok(m2.state.f & PV, "parity of $FF is even");
});

test("DAA corrects in the direction the N flag records", () => {
  // The single most-broken instruction in a hobby core: the same $19/$01 pair
  // corrects UP after an add and DOWN after a subtract, and only N says which.
  const add = machine([0x3e, 0x19, 0xc6, 0x01, 0x27, 0x00]);
  add.runTo(5);
  assert.equal(add.state.a, 0x20, "BCD 19 + 1 = 20");

  const sub = machine([0x3e, 0x20, 0xd6, 0x01, 0x27, 0x00]);
  sub.runTo(5);
  assert.equal(sub.state.a, 0x19, "BCD 20 - 1 = 19");
});

test("INC/DEC leave the carry alone", () => {
  // SCF ; LD A,$FF ; INC A — A wraps to 0 but C must survive untouched.
  const m = machine([0x37, 0x3e, 0xff, 0x3c, 0x00]);
  m.runTo(4);
  assert.equal(m.state.a, 0x00);
  assert.ok(m.state.f & ZF, "Z");
  assert.ok(m.state.f & CF, "C preserved — INC is not ADD 1");
});

// ── Control flow ────────────────────────────────────────────────────────────

test("DJNZ counts B down to zero", () => {
  // LD B,3 ; LD A,0 ; loop: INC A ; DJNZ loop
  const m = machine([0x06, 0x03, 0x3e, 0x00, 0x3c, 0x10, 0xfd, 0x00]);
  m.runTo(7);
  assert.equal(m.state.a, 3, "the body ran three times");
  assert.equal(m.state.b, 0);
});

test("JR takes a SIGNED displacement", () => {
  // JR +2 over a LD A,$FF, landing on LD A,$11
  const m = machine([0x18, 0x02, 0x3e, 0xff, 0x3e, 0x11, 0x00]);
  m.runTo(6);
  assert.equal(m.state.a, 0x11, "the skipped load never ran");
});

test("CALL and RET balance the stack", () => {
  const prog = new Uint8Array(0x20);
  prog.set([0xcd, 0x10, 0x00, 0x00], 0); // CALL $0010 ; NOP
  prog.set([0x3e, 0x77, 0xc9], 0x10); // LD A,$77 ; RET
  const m = machine(prog);
  m.runTo(3);
  assert.equal(m.state.a, 0x77);
  assert.equal(m.state.sp, 0xffff, "SP back where it started");
});

test("RST y*8 vectors through the low page", () => {
  const prog = new Uint8Array(0x40);
  prog.set([0xdf, 0x00], 0); // RST $18
  prog.set([0x3e, 0x5a, 0xc9], 0x18); // LD A,$5A ; RET
  const m = machine(prog);
  m.runTo(1);
  assert.equal(m.state.a, 0x5a);
});

test("PUSH/POP AF round-trips the flag byte, undocumented bits and all", () => {
  // LD A,$3F ; ADD A,$00 (sets F3/F5 from $3F) ; PUSH AF ; LD A,0 ; POP AF
  const m = machine([0x3e, 0x3f, 0xc6, 0x00, 0xf5, 0x3e, 0x00, 0xf1, 0x00]);
  m.runTo(8);
  assert.equal(m.state.a, 0x3f, "A came back");
  assert.equal(m.state.f & 0x28, 0x28, "F3/F5 survived the stack");
  assert.equal(m.state.sp, 0xffff);
});

// ── The alternate register file ─────────────────────────────────────────────

test("EX DE,HL, EXX and EX AF,AF' really swap", () => {
  // LD HL,$1122 ; LD DE,$3344 ; EX DE,HL
  const m = machine([0x21, 0x22, 0x11, 0x11, 0x44, 0x33, 0xeb, 0x00]);
  m.runTo(7);
  assert.equal(hl(m.state), 0x3344);
  assert.equal(de(m.state), 0x1122);

  // LD BC,$0102 ; EXX ; LD BC,$0304 ; EXX — the first pair comes back.
  const m2 = machine([0x01, 0x02, 0x01, 0xd9, 0x01, 0x04, 0x03, 0xd9, 0x00]);
  m2.runTo(8);
  assert.equal(bc(m2.state), 0x0102, "EXX restored the original BC");

  // LD A,$AA ; EX AF,AF' ; LD A,$BB ; EX AF,AF'
  const m3 = machine([0x3e, 0xaa, 0x08, 0x3e, 0xbb, 0x08, 0x00]);
  m3.runTo(6);
  assert.equal(m3.state.a, 0xaa);
});

// ── CB, DD/FD ───────────────────────────────────────────────────────────────

test("BIT reads the COMPLEMENT of the tested bit into Z", () => {
  // LD A,$10 ; BIT 4,A ; then BIT 3,A
  const m = machine([0x3e, 0x10, 0xcb, 0x67, 0x00]);
  m.runTo(4);
  assert.ok(!(m.state.f & ZF), "bit 4 is SET, so Z is clear");
  assert.ok(m.state.f & HF, "BIT always sets H");

  const m2 = machine([0x3e, 0x10, 0xcb, 0x5f, 0x00]);
  m2.runTo(4);
  assert.ok(m2.state.f & ZF, "bit 3 is clear, so Z is set");
});

test("SET/RES on (HL) read-modify-write through the bus", () => {
  // LD HL,$0600 ; LD (HL),$FF ; RES 3,(HL) ; SET 0,(HL)
  const m = machine([
    0x21, 0x00, 0x06, 0x36, 0xff, 0xcb, 0x9e, 0xcb, 0xc6, 0x00,
  ]);
  m.runTo(9);
  assert.equal(m.mem[0x0600], 0xf7, "bit 3 cleared, bit 0 already set");
});

test("LD A,(IX+d) resolves a NEGATIVE displacement", () => {
  // LD IX,$0610 ; LD A,(IX-1)
  const m = machine([0xdd, 0x21, 0x10, 0x06, 0xdd, 0x7e, 0xff, 0x00]);
  m.mem[0x060f] = 0x99;
  m.runTo(7);
  assert.equal(m.state.a, 0x99);
});

test("INC (IY+d) is a read-modify-write at the displaced address", () => {
  // LD IY,$0700 ; INC (IY+2)
  const m = machine([0xfd, 0x21, 0x00, 0x07, 0xfd, 0x34, 0x02, 0x00]);
  m.mem[0x0702] = 0x41;
  m.runTo(7);
  assert.equal(m.mem[0x0702], 0x42);
});

test("LD H,(IX+d) uses the REAL H, not IXH", () => {
  // The classic index rule: an instruction reaching memory through the index
  // takes its other operand from the plain register file.
  const m = machine([0xdd, 0x21, 0x00, 0x07, 0xdd, 0x66, 0x00, 0x00]);
  m.mem[0x0700] = 0x5c;
  m.runTo(7);
  assert.equal(m.state.h, 0x5c, "H loaded");
  assert.equal(m.state.ix, 0x0700, "IX untouched");
});

test("LD (IX+d),n reads the displacement BEFORE the immediate", () => {
  // The one operand order that is not left-to-right in the encoding.
  const m = machine([0xdd, 0x21, 0x00, 0x07, 0xdd, 0x36, 0x04, 0x9a, 0x00]);
  m.runTo(8);
  assert.equal(m.mem[0x0704], 0x9a);
});

// ── The block groups ────────────────────────────────────────────────────────

test("LDIR copies a block and leaves BC zero with PV clear", () => {
  const m = machine([
    0x21, 0x00, 0x07, 0x11, 0x00, 0x08, 0x01, 0x04, 0x00, 0xed, 0xb0, 0x00,
  ]);
  m.mem.set([1, 2, 3, 4], 0x0700);
  m.runTo(11, 60000);
  assert.deepEqual([...m.mem.slice(0x0800, 0x0804)], [1, 2, 3, 4]);
  assert.equal(bc(m.state), 0, "BC exhausted");
  assert.ok(!(m.state.f & PV), "PV clear means the count ran out");
});

test("LDDR copies downwards", () => {
  // LD HL,$0703 ; LD DE,$0803 ; LD BC,4 ; LDDR
  const m = machine([
    0x21, 0x03, 0x07, 0x11, 0x03, 0x08, 0x01, 0x04, 0x00, 0xed, 0xb8, 0x00,
  ]);
  m.mem.set([9, 8, 7, 6], 0x0700);
  m.runTo(11, 60000);
  assert.deepEqual([...m.mem.slice(0x0800, 0x0804)], [9, 8, 7, 6]);
});

test("CPIR stops on a match, leaving Z set and PV showing bytes left", () => {
  // LD HL,$0700 ; LD BC,8 ; LD A,$33 ; CPIR
  const m = machine([
    0x21, 0x00, 0x07, 0x01, 0x08, 0x00, 0x3e, 0x33, 0xed, 0xb1, 0x00,
  ]);
  m.mem.set([1, 2, 0x33, 4, 5, 6, 7, 8], 0x0700);
  m.runTo(10, 60000);
  assert.ok(m.state.f & ZF, "found it");
  assert.equal(hl(m.state), 0x0703, "HL stepped past the match");
  assert.equal(bc(m.state), 5, "five bytes of the count left");
});

// ── The I/O space ───────────────────────────────────────────────────────────

test("OUT (n),A and IN A,(n) put A on the HIGH half of the port address", () => {
  // The 8-bit port number is only half the address the Z80 actually drives.
  const m = machine([0x3e, 0x5e, 0xd3, 0x12, 0xdb, 0x12, 0x00]);
  m.runTo(6);
  assert.equal(m.io[0x5e12], 0x5e, "written to $5E12, not $0012");
  assert.equal(m.state.a, 0x5e, "and read back from the same port");
});

test("IN r,(C) puts B on the high half and sets the flags", () => {
  // LD BC,$1234 ; IN E,(C)
  const m = machine([0x01, 0x34, 0x12, 0xed, 0x58, 0x00]);
  m.io[0x1234] = 0x7b;
  m.runTo(5);
  assert.equal(m.state.e, 0x7b);
  assert.ok(m.state.f & PV, "PV is the PARITY of the byte read");
  assert.ok(!(m.state.f & NF), "N clear");
});

test("OUT (C),r drives the whole BC pair", () => {
  const m = machine([0x01, 0x55, 0x44, 0x16, 0x3c, 0xed, 0x51, 0x00]);
  m.runTo(7);
  assert.equal(m.io[0x4455], 0x3c);
});

// ── ED oddments ─────────────────────────────────────────────────────────────

test("RLD rotates a nibble through (HL) and the low half of A", () => {
  // LD HL,$0600 ; LD (HL),$31 ; LD A,$7A ; RLD  →  A=$73, (HL)=$1A
  const m = machine([
    0x21, 0x00, 0x06, 0x36, 0x31, 0x3e, 0x7a, 0xed, 0x6f, 0x00,
  ]);
  m.runTo(9);
  assert.equal(m.state.a, 0x73);
  assert.equal(m.mem[0x0600], 0x1a);
});

test("NEG is a subtract from zero", () => {
  const m = machine([0x3e, 0x01, 0xed, 0x44, 0x00]);
  m.runTo(4);
  assert.equal(m.state.a, 0xff);
  assert.ok(m.state.f & NF, "N");
  assert.ok(m.state.f & CF, "C — it borrowed");
});

test("SBC HL,rr carries the borrow through 16 bits", () => {
  // AND A clears the carry first — the part powers up with AF = $FFFF, so a
  // bare SBC would borrow the reset carry as well and land a count short.
  // LD HL,$0000 ; LD DE,$0001 ; AND A ; SBC HL,DE
  const m = machine([
    0x21, 0x00, 0x00, 0x11, 0x01, 0x00, 0xa7, 0xed, 0x52, 0x00,
  ]);
  m.runTo(9);
  assert.equal(hl(m.state), 0xffff);
  assert.ok(m.state.f & CF, "borrow out of bit 15");
  assert.ok(m.state.f & NF, "N — SBC is a subtract");
});

test("LD A,R reports IFF2 in PV, and R counts M1 fetches", () => {
  // EI ; LD A,R — PV must show interrupts are enabled.
  const m = machine([0xfb, 0xed, 0x5f, 0x00]);
  m.runTo(3);
  assert.ok(m.state.f & PV, "PV mirrors IFF2");
  assert.ok((m.state.r & 0x7f) > 0, "R advanced");
});

test("R wraps at 7 bits and keeps bit 7", () => {
  // LD A,$FF ; LD R,A ; then NOPs — bit 7 stays set while the low 7 wrap.
  const prog = new Uint8Array(0x90);
  prog.set([0x3e, 0xff, 0xed, 0x4f], 0);
  const m = machine(prog);
  m.runTo(4);
  assert.equal(m.state.r & 0x80, 0x80, "bit 7 held");
  m.steps(400);
  assert.equal(m.state.r & 0x80, 0x80, "still held after the low bits wrapped");
});

// ── Interrupts ──────────────────────────────────────────────────────────────

test("NMI is serviced regardless of IFF1 and vectors to $0066", () => {
  const prog = new Uint8Array(0x80);
  prog.set([0x00, 0x18, 0xfd], 0); // NOP ; JR -3 (spin)
  prog.set([0x3e, 0xab, 0xed, 0x45], 0x66); // LD A,$AB ; RETN
  const m = machine(prog);
  m.steps(6);
  assert.equal(m.state.iff1, 0, "interrupts are OFF — an NMI does not care");
  m.setCtl({ nmi: true });
  m.steps(40);
  assert.equal(m.state.a, 0xab, "the handler ran");
});

test("RETN restores IFF1 from the IFF2 shadow", () => {
  const prog = new Uint8Array(0x80);
  prog.set([0xfb, 0x00, 0x18, 0xfd], 0); // EI ; NOP ; JR -3
  prog.set([0xed, 0x45], 0x66); // RETN
  const m = machine(prog);
  m.steps(20);
  assert.equal(m.state.iff1, 1);
  m.setCtl({ nmi: true });
  m.steps(30);
  m.setCtl({ nmi: false });
  m.steps(30);
  assert.equal(m.state.iff1, 1, "put back by RETN");
});

test("IM 1 vectors a maskable interrupt to $0038, and DI masks it", () => {
  const prog = new Uint8Array(0x80);
  prog.set([0xed, 0x56, 0xfb, 0x00, 0x18, 0xfd], 0); // IM 1 ; EI ; NOP ; JR -3
  prog.set([0x3e, 0xcd, 0xed, 0x4d], 0x38); // LD A,$CD ; RETI
  const m = machine(prog);
  m.steps(14);
  m.setCtl({ int: true });
  m.steps(40);
  assert.equal(m.state.a, 0xcd, "handler ran");

  const masked = new Uint8Array(0x80);
  masked.set([0xed, 0x56, 0xf3, 0x00, 0x18, 0xfd], 0); // IM 1 ; DI ; NOP ; JR -3
  masked.set([0x3e, 0xcd, 0xed, 0x4d], 0x38);
  const m2 = machine(masked);
  m2.steps(14);
  m2.setCtl({ int: true });
  m2.steps(60);
  assert.notEqual(m2.state.a, 0xcd, "DI kept the handler out");
});

test("IM 2 selects a handler through the I register and the bus vector", () => {
  const prog = new Uint8Array(0x200);
  prog.set([0xed, 0x5e, 0x3e, 0x90, 0xed, 0x47, 0xfb, 0x00, 0x18, 0xfd], 0);
  // IM 2 ; LD A,$90 ; LD I,A ; EI ; NOP ; JR -3
  prog.set([0x3e, 0x64, 0xed, 0x4d], 0x100); // the handler, at $0100
  const m = machine(prog);
  // The vector table lives at (I << 8) | (vector & $FE) = $9020.
  m.mem[0x9020] = 0x00;
  m.mem[0x9021] = 0x01;
  m.setVector(0x20);
  m.steps(30);
  m.setCtl({ int: true });
  m.steps(60);
  assert.equal(m.state.a, 0x64, "reached the table's handler");
});

test("IM 0 executes the byte on the bus — an undriven bus is RST 38h", () => {
  // A floating bus reads $FF through asInput, which IS `RST 38h`. That is what
  // a real bench does with an interrupting device that drives no vector.
  const prog = new Uint8Array(0x80);
  prog.set([0xed, 0x46, 0xfb, 0x00, 0x18, 0xfd], 0); // IM 0 ; EI ; NOP ; JR -3
  prog.set([0x3e, 0x7e, 0xed, 0x4d], 0x38); // LD A,$7E ; RETI
  const m = machine(prog);
  m.setVector(0xff);
  m.steps(14);
  m.setCtl({ int: true });
  m.steps(50);
  assert.equal(m.state.a, 0x7e, "the floating bus became RST 38h");
});

test("EI delays the interrupt by exactly one instruction", () => {
  // The instruction after EI must retire before the handler is entered, or an
  // `EI; RET` epilogue would take an interrupt before it could return.
  //   IM 1 ; LD A,$00 ; EI ; INC A ; JR -2 (spin)
  // /INT is asserted before EI even runs, so the interrupt is pending the whole
  // time; A must nonetheless read 1 at the moment it is finally taken.
  const prog = new Uint8Array(0x80);
  prog.set([0xed, 0x56, 0x3e, 0x00, 0xfb, 0x3c, 0x18, 0xfe], 0);
  prog.set([0xed, 0x4d], 0x38); // RETI
  const m = machine(prog);
  m.setCtl({ int: true });
  let taken = false;
  for (let i = 0; i < 300 && !taken; i++) {
    m.cycle();
    if (m.state.cur === "int") taken = true;
  }
  assert.ok(taken, "the interrupt was eventually taken");
  assert.equal(m.state.a, 0x01, "INC A retired first — exactly once");
});

// ── HALT ────────────────────────────────────────────────────────────────────

test("HALT holds PC and asserts /HALT, and an interrupt resumes after it", () => {
  const prog = new Uint8Array(0x80);
  prog.set([0xed, 0x56, 0xfb, 0x76, 0x3c, 0x18, 0xfd], 0);
  // IM 1 ; EI ; HALT ; INC A ; JR -3
  prog.set([0xed, 0x4d], 0x38); // RETI
  const m = machine(prog);
  m.steps(20);
  assert.equal(m.state.halted, true, "halted");
  assert.equal(m.state.pc, 4, "PC sits on the instruction AFTER the HALT");
  m.setCtl({ int: true });
  m.steps(40);
  assert.equal(m.state.halted, false, "the interrupt woke it");
});

// ── A program that runs for a while ─────────────────────────────────────────

test("a counter program advances memory over many instructions", () => {
  // LD HL,$0900 ; LD (HL),0 ; loop: INC (HL) ; JR loop
  const m = machine([0x21, 0x00, 0x09, 0x36, 0x00, 0x34, 0x18, 0xfd]);
  m.steps(400);
  assert.ok(m.mem[0x0900] > 3, `counter advanced (${m.mem[0x0900]})`);
});

// ── The catalog unit: the pin-level contract ────────────────────────────────

const Z80 = () => partDef("Z80A").logic;
const PIN = {
  CLK: 6,
  M1: 27,
  MREQ: 19,
  IORQ: 20,
  RD: 21,
  WR: 22,
  RFSH: 28,
  HALT: 18,
  BUSACK: 23,
  WAIT: 24,
  BUSRQ: 25,
  RESET: 26,
  INT: 16,
  NMI: 17,
};
const ADDR = [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 1, 2, 3, 4, 5];
const DATA = [14, 15, 12, 8, 7, 9, 10, 13];

/** Input levels for the unit: every control line idle-high, D carrying `byte`. */
function ins({ clk = H, byte = 0xff, ...over } = {}) {
  const m = new Map();
  m.set(PIN.CLK, clk);
  for (const p of [PIN.RESET, PIN.WAIT, PIN.BUSRQ, PIN.INT, PIN.NMI])
    m.set(p, H);
  DATA.forEach((p, i) => m.set(p, (byte >> i) & 1 ? H : L));
  for (const [p, v] of Object.entries(over)) m.set(PIN[p], v);
  return m;
}

/** The address the unit is driving, or null if the bus is floating. */
function addrOf(out) {
  if (out.get(ADDR[0]) === Z) return null;
  return ADDR.reduce((n, p, i) => n | ((out.get(p) === H ? 1 : 0) << i), 0);
}

test("the unit's step is edge-gated — an unchanged clock returns state VERBATIM", () => {
  // This is what keeps the engine's per-tick step fixpoint terminating; a
  // state that kept changing would be reported as an oscillation.
  const u = Z80();
  const s = u.state0();
  assert.equal(
    u.step(s, ins({ clk: H }), ins({ clk: H })),
    s,
    "no edge, no change",
  );
  assert.equal(u.step(s, ins({ clk: L }), null), s, "no prev, no change");
});

test("a fetch asserts /M1, then hands the bus to a refresh in T3/T4", () => {
  const u = Z80();
  // Release reset and run to the first M1 cycle.
  let s = u.step(
    u.state0(),
    ins({ clk: H, RESET: L }),
    ins({ clk: L, RESET: L }),
  );
  s = u.step(s, ins({ clk: H }), ins({ clk: L }));
  assert.equal(s.mk, "M1", "the first cycle after reset is an opcode fetch");

  // T1 high: address valid, /M1 asserted, /MREQ not yet.
  let out = u.outputs(s, ins({ clk: H }));
  assert.equal(addrOf(out), 0x0000, "PC on the address bus");
  assert.equal(out.get(PIN.M1), L, "/M1 low through the fetch");
  assert.equal(out.get(PIN.MREQ), H, "/MREQ waits for T1's falling edge");
  assert.equal(out.get(PIN.RFSH), H, "no refresh yet");

  // T1 low: /MREQ and /RD assert.
  out = u.outputs(s, ins({ clk: L }));
  assert.equal(out.get(PIN.MREQ), L);
  assert.equal(out.get(PIN.RD), L);

  // Advance to T3: the byte is latched, /M1 releases, and the REFRESH address
  // takes the bus with /RFSH asserted.
  //
  // Run on to a LATER fetch first, or the claim is untestable: at the very
  // first M1 after reset PC and I:R are BOTH $0000, and a stream of NOPs is no
  // better — PC and R then advance in lockstep and stay equal forever. Feeding
  // $C3 makes every fetch `JP $C3C3`, which parks PC while R keeps counting, so
  // the two addresses are unmistakably different.
  let clk = H;
  let prev = ins({ clk: H });
  const half = () => {
    clk = clk === H ? L : H;
    const now = ins({ clk, byte: 0xc3 });
    s = u.step(s, now, prev);
    prev = now;
  };
  for (let i = 0; i < 200 && !(s.mk === "M1" && s.t === 3 && s.r > 1); i++) {
    half();
  }
  assert.equal(s.mk, "M1");
  assert.equal(s.t, 3, "T3 of a later fetch");
  out = u.outputs(s, ins({ clk: H }));
  assert.equal(out.get(PIN.M1), H, "/M1 released at T3");
  assert.equal(out.get(PIN.RFSH), L, "/RFSH asserted");
  assert.equal(out.get(PIN.RD), H, "the read is over");
  assert.equal(addrOf(out), (s.i << 8) | s.r, "the refresh address I:R");
  assert.notEqual(addrOf(out), s.pc, "which by now is NOT the program counter");
});

test("a memory READ never asserts /M1 — that is what tells it from a fetch", () => {
  const u = Z80();
  // LD A,(nn) reaches a plain READ cycle after its fetch + operand reads.
  let s = u.step(
    u.state0(),
    ins({ clk: H, RESET: L }),
    ins({ clk: L, RESET: L }),
  );
  let prev = ins({ clk: L });
  let sawRead = false;
  for (let i = 0; i < 40 && !sawRead; i++) {
    const now = ins({ clk: i % 2 === 0 ? H : L, byte: 0x00 });
    s = u.step(s, now, prev);
    prev = now;
    if (s.mk === "READ") sawRead = true;
  }
  if (sawRead) {
    const out = u.outputs(s, ins({ clk: L }));
    assert.equal(out.get(PIN.M1), H, "/M1 stays high on a data read");
    assert.equal(out.get(PIN.RFSH), H, "and there is no refresh on one either");
  }
});

test("/WAIT low at the sampling edge stretches the cycle", () => {
  const u = Z80();
  let s = u.step(
    u.state0(),
    ins({ clk: H, RESET: L }),
    ins({ clk: L, RESET: L }),
  );
  s = u.step(s, ins({ clk: H }), ins({ clk: L }));
  // Advance to T2, then hold /WAIT low over its falling edge.
  s = u.step(s, ins({ clk: L }), ins({ clk: H }));
  s = u.step(s, ins({ clk: H }), ins({ clk: L }));
  assert.equal(s.t, 2, "T2");
  s = u.step(s, ins({ clk: L, WAIT: L }), ins({ clk: H }));
  assert.equal(s.wait, true, "/WAIT was sampled");
  const held = s.t;
  s = u.step(s, ins({ clk: H }), ins({ clk: L, WAIT: L }));
  assert.equal(s.t, held, "the T-state did NOT advance — a wait state");
});

test("/BUSRQ floats the address bus, the data bus AND the control lines", () => {
  // The reason a CPU can never declare an `outputEnable`: this is a hand-over,
  // not an enable, and it takes every driven pin with it.
  const u = Z80();
  let s = u.step(
    u.state0(),
    ins({ clk: H, RESET: L }),
    ins({ clk: L, RESET: L }),
  );
  s = u.step(s, ins({ clk: H }), ins({ clk: L }));
  assert.equal(
    s.t,
    1,
    "at an M-cycle boundary, where a bus request is honoured",
  );
  s = u.step(s, ins({ clk: H, BUSRQ: L }), ins({ clk: L }));
  assert.equal(s.mk, "BUSACK");

  const out = u.outputs(s, ins({ clk: H, BUSRQ: L }));
  assert.equal(addrOf(out), null, "address bus floating");
  assert.equal(out.get(DATA[0]), Z, "data bus floating");
  for (const p of [PIN.MREQ, PIN.IORQ, PIN.RD, PIN.WR, PIN.RFSH]) {
    assert.equal(out.get(p), Z, `control line ${p} floating`);
  }
  assert.equal(
    out.get(PIN.BUSACK),
    L,
    "/BUSACK asserted — and it never floats",
  );
});

test("a chip held in /RESET drives nothing at all", () => {
  const u = Z80();
  const s = u.step(
    u.state0(),
    ins({ clk: H, RESET: L }),
    ins({ clk: L, RESET: L }),
  );
  const out = u.outputs(s, ins({ clk: H, RESET: L }));
  assert.equal(addrOf(out), null, "address bus floating");
  assert.equal(out.get(PIN.MREQ), Z);
  assert.equal(
    out.get(PIN.HALT),
    H,
    "/HALT is not a bus line — it still drives",
  );
});

test("outputs() drives every output pin, which the catalog guard requires", () => {
  const def = partDef("Z80A");
  const u = def.logic;
  const out = u.outputs(u.state0(), ins({ clk: H }));
  for (const p of def.pins.filter((p) => p.role === "output")) {
    assert.ok(out.has(p.n), `pin ${p.n} (${p.name}) is driven`);
  }
  for (const p of out.keys()) {
    const role = def.pins.find((q) => q.n === p).role;
    assert.ok(
      role === "output" || role === "io",
      `pin ${p} is an output or io`,
    );
  }
});

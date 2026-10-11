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

// w65c02.test.js — the W65C02 CPU CORE against a plain 64 KiB memory array (fast,
// no engine/PHI2 plumbing). Each `cycle()` serves the CPU's pending bus access
// from memory and advances one clock; small programs then assert registers and
// memory. Reset boots from the $FFFC vector, so a machine just runs from `org`.

import test from "node:test";
import assert from "node:assert/strict";

import { initialCpu, cpuCycle } from "../sim/w65c02.js";
import { partDef } from "../catalog/index.js";

// Status-flag masks (mirror the module).
const C = 0x01;
const ZF = 0x02;

/** A CPU wired to a flat memory image. */
function machine(program, org = 0x8000, { irqVec, nmiVec } = {}) {
  const mem = new Uint8Array(0x10000);
  mem.set(program, org);
  mem[0xfffc] = org & 0xff;
  mem[0xfffd] = (org >> 8) & 0xff;
  if (irqVec != null) {
    mem[0xfffe] = irqVec & 0xff;
    mem[0xffff] = (irqVec >> 8) & 0xff;
  }
  if (nmiVec != null) {
    mem[0xfffa] = nmiVec & 0xff;
    mem[0xfffb] = (nmiVec >> 8) & 0xff;
  }
  let state = initialCpu();
  const m = {
    mem,
    get state() {
      return state;
    },
    cycle(ctl = {}) {
      const s = state;
      const c = { reset: false, irq: false, nmi: false, ready: true, ...ctl };
      let busByte = 0;
      if (s.rw === "r") busByte = mem[s.addr];
      else mem[s.addr] = s.dout;
      state = cpuCycle(s, busByte, c);
    },
    /** Run until the CPU is about to fetch the opcode at `pc` (settled there). */
    runTo(pc, max = 2000, ctl) {
      for (let i = 0; i < max; i++) {
        m.cycle(ctl);
        if (state.cur === "instr" && state.sync && state.addr === pc) return;
      }
      throw new Error(`runTo $${pc.toString(16)} not reached`);
    },
    steps(n, ctl) {
      for (let i = 0; i < n; i++) m.cycle(ctl);
    },
  };
  return m;
}

test("reset boots from the $FFFC/$FFFD vector with I set and S = $FD", () => {
  const m = machine([0xea], 0x8000); // NOP at $8000
  m.runTo(0x8000);
  assert.equal(m.state.pc, 0x8000);
  assert.equal(m.state.s, 0xfd);
  assert.equal(m.state.p & 0x04, 0x04); // I flag set out of reset
});

test("LDA immediate then STA absolute + zero page", () => {
  // A9 42     LDA #$42
  // 8D 00 02  STA $0200
  // 85 10     STA $10
  // 4C 07 80  JMP $8007 (self-loop)
  const m = machine([
    0xa9, 0x42, 0x8d, 0x00, 0x02, 0x85, 0x10, 0x4c, 0x07, 0x80,
  ]);
  m.runTo(0x8007);
  assert.equal(m.state.a, 0x42);
  assert.equal(m.mem[0x0200], 0x42);
  assert.equal(m.mem[0x10], 0x42);
});

test("ADC sets carry and zero on $FF + $01", () => {
  // A9 FF LDA #$FF ; 18 CLC ; 69 01 ADC #$01 ; 4C 06 80 JMP $8006
  const m = machine([0xa9, 0xff, 0x18, 0x69, 0x01, 0x4c, 0x06, 0x80]);
  m.runTo(0x8006);
  assert.equal(m.state.a, 0x00);
  assert.equal(m.state.p & C, C, "carry out");
  assert.equal(m.state.p & ZF, ZF, "zero");
});

test("a DEX/BNE loop counts X down to zero", () => {
  // A2 03 LDX #3 ; (loop) CA DEX ; D0 FD BNE loop ; 4C 05 80 JMP $8005
  const m = machine([0xa2, 0x03, 0xca, 0xd0, 0xfd, 0x4c, 0x05, 0x80]);
  m.runTo(0x8005);
  assert.equal(m.state.x, 0x00);
  assert.equal(m.state.p & ZF, ZF);
});

test("JSR/RTS runs the subroutine and returns", () => {
  // $8000: 20 09 80 JSR $8009 ; A9 AA LDA #$AA ; 4C 05 80 JMP $8005
  // $8009: A2 55 LDX #$55 ; 60 RTS
  const prog = [
    0x20,
    0x09,
    0x80, // JSR $8009
    0xa9,
    0xaa, // LDA #$AA
    0x4c,
    0x05,
    0x80, // JMP $8005
    0xea, // padding at $8008 (unused)
    0xa2,
    0x55, // $8009 LDX #$55
    0x60, // RTS
  ];
  const m = machine(prog);
  m.runTo(0x8005);
  assert.equal(m.state.x, 0x55, "subroutine ran");
  assert.equal(m.state.a, 0xaa, "returned and continued");
  assert.equal(m.state.s, 0xfd, "stack balanced");
});

test("PHA/PLA round-trips a value through the stack", () => {
  // A9 12 LDA #$12 ; 48 PHA ; A9 34 LDA #$34 ; 68 PLA ; 4C 06 80 JMP $8006
  const m = machine([0xa9, 0x12, 0x48, 0xa9, 0x34, 0x68, 0x4c, 0x06, 0x80]);
  m.runTo(0x8006);
  assert.equal(m.state.a, 0x12);
});

test("65C02: BRA, STZ, INC A", () => {
  // A9 05 LDA #5 ; 1A INC A ; 64 20 STZ $20 ; 80 00 BRA $8007 ; 4C 07 80 JMP
  const m = machine([
    0xa9, 0x05, 0x1a, 0x64, 0x20, 0x80, 0x00, 0x4c, 0x07, 0x80,
  ]);
  m.runTo(0x8007);
  assert.equal(m.state.a, 0x06, "INC A");
  assert.equal(m.mem[0x20], 0x00, "STZ cleared $20");
});

test("(zp),y indirect-indexed load reaches the pointed address", () => {
  // Build pointer $0300 at $10/$11, Y=2, load ($10),y → $0302.
  // A9 00 STA $10 ; A9 03 STA $11 ; A0 02 LDY #2 ; B1 10 LDA ($10),Y ; JMP self
  const prog = [
    0xa9,
    0x00,
    0x85,
    0x10, // LDA #$00 / STA $10
    0xa9,
    0x03,
    0x85,
    0x11, // LDA #$03 / STA $11
    0xa0,
    0x02, // LDY #$02
    0xb1,
    0x10, // LDA ($10),Y
    0x4c,
    0x0c,
    0x80, // JMP $800C
  ];
  const m = machine(prog);
  m.mem[0x0302] = 0x77;
  m.runTo(0x800c);
  assert.equal(m.state.a, 0x77);
});

test("RMB/BBR: reset a bit, then branch on it being clear", () => {
  // Seed $30 = $FF. 47 30 RMB4 $30 (clears bit 4 → $EF).
  // 4F 30 03 BBR4 $30,+3 → branch taken (bit4 clear) to $8008; else fallthrough.
  // Layout: RMB4 $30 (2) ; BBR4 $30,rel (3) ; A9 01 LDA #1 (not-taken path) ;
  //         at target: A9 02 LDA #2 ; JMP self
  const prog = [
    0x47,
    0x30, // $8000 RMB4 $30
    0x4f,
    0x30,
    0x03, // $8002 BBR4 $30, +3 → $8008
    0xa9,
    0x01, // $8005 LDA #$01 (skipped)
    0xea, // $8007 pad
    0xa9,
    0x02, // $8008 LDA #$02 (branch target)
    0x4c,
    0x0a,
    0x80, // $800A JMP $800A
  ];
  const m = machine(prog);
  m.mem[0x30] = 0xff;
  m.runTo(0x800a);
  assert.equal(m.mem[0x30], 0xef, "bit 4 reset");
  assert.equal(m.state.a, 0x02, "branch on bit clear was taken");
});

test("decimal-mode ADC produces a BCD result", () => {
  // F8 SED ; A9 09 LDA #$09 ; 18 CLC ; 69 01 ADC #$01 ; D8 CLD ; JMP self
  const m = machine([
    0xf8, 0xa9, 0x09, 0x18, 0x69, 0x01, 0xd8, 0x4c, 0x07, 0x80,
  ]);
  m.runTo(0x8007);
  assert.equal(m.state.a, 0x10, "09 + 01 = 10 in BCD");
});

test("a maskable IRQ is serviced once interrupts are enabled", () => {
  // Main: 58 CLI ; (loop) EA NOP ; 4C 01 80 JMP $8001
  // IRQ @ $9000: A9 EE LDA #$EE ; 8D 00 04 STA $0400 ; 40 RTI
  const main = [0x58, 0xea, 0x4c, 0x01, 0x80];
  const m = machine(main, 0x8000, { irqVec: 0x9000 });
  m.mem.set([0xa9, 0xee, 0x8d, 0x00, 0x04, 0x40], 0x9000);
  m.runTo(0x8001); // past CLI — interrupts now enabled
  m.steps(40, { irq: true }); // hold IRQ asserted; the handler should run
  assert.equal(m.mem[0x0400], 0xee, "IRQ handler wrote its marker");
});

test("an IRQ waiting behind CLI lets ONE more instruction run first", () => {
  // Main: 58 CLI ; E8 INX ; E8 INX ; 4C 03 80 JMP $8003
  // IRQ @ $9000: 86 10 STX $10 ; 40 RTI — records X as the IRQ found it.
  const m = machine([0x58, 0xe8, 0xe8, 0x4c, 0x03, 0x80], 0x8000, { irqVec: 0x9000 }); // prettier-ignore
  m.mem.set([0x86, 0x10, 0x40], 0x9000);
  m.mem[0x10] = 0xff;
  m.runTo(0x8000, 2000, { irq: true }); // IRQ held from the start (masked)
  m.steps(40, { irq: true });
  assert.equal(m.mem[0x10], 1, "the first INX ran before the handler");
});

test("an IRQ pending at SEI is still taken once", () => {
  // Main: 58 CLI ; 78 SEI ; E8 INX ; 4C 03 80 JMP $8003 — IRQ raised at SEI.
  const m = machine([0x58, 0x78, 0xe8, 0x4c, 0x03, 0x80], 0x8000, { irqVec: 0x9000 }); // prettier-ignore
  m.mem.set([0xa9, 0xee, 0x85, 0x11, 0x40], 0x9000); // LDA #$EE ; STA $11 ; RTI
  m.runTo(0x8001); // CLI done, SEI next
  m.steps(30, { irq: true });
  assert.equal(m.mem[0x11], 0xee, "the poll before SEI's change saw I clear");
});

test("undefined opcodes are NOPs of the W65C02S's own lengths", () => {
  // 02 xx (2 bytes) ; 44 xx (2) ; 5C lo hi (3) ; 03 (1) ; A9 77 LDA #$77 ; JMP self
  const m = machine([0x02, 0xa9, 0x44, 0xa9, 0x5c, 0xa9, 0xa9, 0x03, 0xa9, 0x77, 0x4c, 0x0a, 0x80]); // prettier-ignore
  m.runTo(0x800a);
  assert.equal(m.state.a, 0x77, "every operand byte was skipped, none run");
});

test("an NMI is serviced on its falling edge regardless of the I flag", () => {
  // Main leaves interrupts masked (reset default). NMI is non-maskable.
  // Main: EA NOP ; 4C 00 80 JMP $8000
  // NMI @ $9100: A9 CC LDA #$CC ; 8D 01 04 STA $0401 ; 40 RTI
  const m = machine([0xea, 0x4c, 0x00, 0x80], 0x8000, { nmiVec: 0x9100 });
  m.mem.set([0xa9, 0xcc, 0x8d, 0x01, 0x04, 0x40], 0x9100);
  m.runTo(0x8000);
  m.steps(2); // run with NMI high…
  m.steps(30, { nmi: true }); // …then assert it (falling edge triggers)
  assert.equal(m.mem[0x0401], 0xcc, "NMI handler ran");
});

test("a counter program increments a RAM cell each pass", () => {
  // $8000: E6 20 INC $20 ; 4C 00 80 JMP $8000  (tight increment loop)
  const m = machine([0xe6, 0x20, 0x4c, 0x00, 0x80]);
  m.runTo(0x8000); // about to run the first INC
  // Each loop pass is INC $20 (RMW) + JMP. Run several passes.
  for (let want = 1; want <= 5; want++) {
    m.runTo(0x8000); // complete one INC+JMP pass, back to the top
    assert.equal(m.mem[0x20], want, `pass ${want}`);
  }
});

// ── The PHI2 wrapper: WHEN the data bus is sampled ───────────────────────────
// Everything above drives `cpuCycle` directly against a flat array, which is
// why none of it could see this: the bug was in the `w65c02Unit` wrapper that
// sits between the core and the engine's two-phase tick. It sampled the bus in
// the FALLING edge's own settle, but a 65xx peripheral gates its bus drivers on
// PHI2 and has already let go by then — so every VIA and PIA register read as a
// floating $FF, and a button wired to a VIA port could never read as pressed.
// An asynchronous ROM/SRAM drives on /CE alone and reads the same either way,
// which is exactly why three shipped demos ran perfectly on top of it.

test("a read latches the byte from the PHI2-HIGH phase, not the falling edge", () => {
  const unit = partDef("W65C02").logic;
  const P = {
    A: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25],
    D: [33, 32, 31, 30, 29, 28, 27, 26],
    RWB: 34,
    PHI2: 37,
    RESB: 40,
    BE: 36,
    RDY: 2,
    IRQB: 4,
    NMIB: 6,
  };
  // $FFFC/$FFFD hold the reset vector $9ABC; everything else reads $EA (NOP).
  const mem = new Uint8Array(0x10000).fill(0xea);
  mem[0xfffc] = 0xbc;
  mem[0xfffd] = 0x9a;

  const levels = (state, phi2, dataByte) => {
    const m = new Map();
    for (const pin of [P.RESB, P.BE, P.RDY, P.IRQB, P.NMIB]) m.set(pin, "H");
    m.set(P.PHI2, phi2);
    P.A.forEach((pin, i) => m.set(pin, (state.addr >> i) & 1 ? "H" : "L"));
    P.D.forEach((pin, i) => m.set(pin, (dataByte >> i) & 1 ? "H" : "L"));
    return m;
  };

  let state = unit.state0();
  let firstFetch = null;
  for (let cycle = 0; cycle < 12 && firstFetch === null; cycle++) {
    // PHI2 HIGH: the addressed part drives the real byte. This is the tick a
    // peripheral answers in, and the only one where the value is on the bus.
    const high = levels(state, "H", state.rw === "r" ? mem[state.addr] : 0xff);
    state = unit.step(state, high, levels(state, "L", 0x00)) ?? state;
    // PHI2 LOW: the bus has been RELEASED. $FF is what a floating one reads,
    // and taking the byte from here is precisely the bug — so poison it.
    state = unit.step(state, levels(state, "L", 0xff), high) ?? state;
    if (state.sync && state.cur === "instr") firstFetch = state.addr & 0xffff;
  }

  assert.equal(
    firstFetch,
    0x9abc,
    "the CPU booted to the vector it was shown during PHI2 high",
  );
});

// ── SBC, BIT and the read-modify-write shifts ───────────────────────────────
// None of these had ever been executed by a test (coverage showed `sbc`,
// `bitTest` and the ASL/ROL/ROR/DEC arms dark), including the two BCD flag
// rules the code comments promise.

const N = 0x80;
const V = 0x40;

/** Run `LDA #a ; SEC|CLC ; SBC #b` (decimal when `bcd`) and read A and P. */
function sbc(a, b, { carry = true, bcd = false } = {}) {
  const prog = [
    ...(bcd ? [0xf8] : []), // SED
    0xa9,
    a, // LDA #a
    carry ? 0x38 : 0x18, // SEC / CLC
    0xe9,
    b, // SBC #b
  ];
  const end = 0x8000 + prog.length;
  const m = machine([...prog, 0x4c, end & 0xff, end >> 8]); // JMP self
  m.runTo(end);
  return { a: m.state.a, p: m.state.p };
}

test("binary SBC: result, borrow and signed overflow", () => {
  let r = sbc(0x50, 0xf0);
  assert.equal(r.a, 0x60);
  assert.equal(r.p & C, 0, "a borrow clears C");
  assert.equal(r.p & V, 0);
  r = sbc(0x50, 0xb0); // +80 − (−80) overflows into the negative range
  assert.equal(r.a, 0xa0);
  assert.equal(r.p & V, V);
  assert.equal(r.p & N, N);
  r = sbc(0x80, 0x01); // −128 − 1 overflows the other way
  assert.equal(r.a, 0x7f);
  assert.equal(r.p & V, V);
  assert.equal(r.p & C, C, "no borrow");
  r = sbc(0x05, 0x04, { carry: false }); // the borrow in takes one more
  assert.equal(r.a, 0x00);
  assert.equal(r.p & ZF, ZF);
});

test("decimal SBC: BCD digits, BCD borrow, and N/Z from the CORRECTED byte", () => {
  let r = sbc(0x00, 0x01, { bcd: true });
  assert.equal(r.a, 0x99, "00 − 01 = 99, borrowing");
  assert.equal(r.p & C, 0);
  assert.equal(r.p & N, N, "N reads the BCD result, not the binary $FF");
  r = sbc(0x50, 0x25, { bcd: true });
  assert.equal(r.a, 0x25);
  assert.equal(r.p & C, C);
  r = sbc(0x10, 0x01, { bcd: true, carry: false });
  assert.equal(r.a, 0x08, "10 − 01 − borrow = 08");
  r = sbc(0x42, 0x42, { bcd: true });
  assert.equal(r.a, 0x00);
  assert.equal(r.p & ZF, ZF);
});

test("decimal ADC: a carry out of 99, with Z from the corrected byte", () => {
  // F8 SED ; A9 99 LDA #$99 ; 38 SEC ; 69 00 ADC #$00 ; JMP self
  const m = machine([0xf8, 0xa9, 0x99, 0x38, 0x69, 0x00, 0x4c, 0x06, 0x80]);
  m.runTo(0x8006);
  assert.equal(m.state.a, 0x00);
  assert.equal(m.state.p & C, C);
  assert.equal(m.state.p & ZF, ZF, "99 + 1 rolls to 00: Z set");
  assert.equal(m.state.p & N, 0);
});

test("BIT: memory forms copy bits 7/6 into N/V; the immediate form touches only Z", () => {
  // A9 00 LDA #0 ; 2C 00 02 BIT $0200 ; JMP self
  let m = machine([0xa9, 0x00, 0x2c, 0x00, 0x02, 0x4c, 0x05, 0x80]);
  m.mem[0x0200] = 0xc0;
  m.runTo(0x8005);
  assert.equal(m.state.p & (N | V | ZF), N | V | ZF);
  // B8 CLV ; A9 40 LDA #$40 (N clear) ; 89 C0 BIT #$C0 ; JMP self
  m = machine([0xb8, 0xa9, 0x40, 0x89, 0xc0, 0x4c, 0x05, 0x80]);
  m.runTo(0x8005);
  assert.equal(m.state.p & ZF, 0, "A & $C0 is non-zero");
  assert.equal(m.state.p & (N | V), 0, "N and V are left alone");
});

test("ASL / ROL / ROR / DEC on memory: the result, and the bit shifted out", () => {
  // 38 SEC ; 26 10 ROL $10 ; 38 SEC ; 66 11 ROR $11 ; 06 12 ASL $12 ;
  // C6 13 DEC $13 ; JMP self
  const m = machine([
    0x38, 0x26, 0x10, 0x38, 0x66, 0x11, 0x06, 0x12, 0xc6, 0x13,
    0x4c, 0x0a, 0x80,
  ]); // prettier-ignore
  m.mem.set([0x81, 0x01, 0x80, 0x00], 0x10);
  m.runTo(0x800a);
  assert.deepEqual([...m.mem.slice(0x10, 0x14)], [0x03, 0x80, 0x00, 0xff]);
  assert.equal(m.state.p & N, N, "the last op, DEC to $FF, sets N");
});

// ── Cycle counts: the datasheet's, dummy cycles included ─────────────────────
// WDC W65C02S datasheet, the opcode matrix's cycle column with its notes
// (+1 across a page on indexed reads, +1/+2 for a taken branch, +1 in decimal
// mode). Each case runs `setup` (registers, memory) and jumps to `at`, then
// counts the cycles from the instruction's opcode fetch to the next one's.

/** Trace one instruction: every access from its opcode fetch to the next. */
function traceOne(instr, { setup = [], at = 0x9000, mem = {}, s } = {}) {
  const m = machine([...setup, 0x4c, at & 0xff, at >> 8]);
  m.mem.set(instr, at);
  for (const [addr, v] of Object.entries(mem)) m.mem[Number(addr)] = v;
  m.runTo(at);
  if (s != null) m.state.s = s;
  const trace = [];
  do {
    const st = m.state;
    trace.push(`${st.rw}${st.addr.toString(16).padStart(4, "0")}`);
    m.cycle();
  } while (!(m.state.cur === "instr" && m.state.sync));
  return trace;
}

const CYCLES = [
  // [what, instruction bytes, cycles, options]
  ["NOP", [0xea], 2],
  ["INX", [0xe8], 2],
  ["ASL A", [0x0a], 2],
  ["LDA #", [0xa9, 1], 2],
  ["LDA zp", [0xa5, 0x10], 3],
  ["LDA zp,X", [0xb5, 0x10], 4],
  ["LDA abs", [0xad, 0x00, 0x02], 4],
  ["LDA abs,X in page", [0xbd, 0x00, 0x02], 4, { setup: [0xa2, 0x05] }],
  ["LDA abs,X across a page", [0xbd, 0xff, 0x02], 5, { setup: [0xa2, 0x05] }],
  ["LDA abs,Y across a page", [0xb9, 0xff, 0x02], 5, { setup: [0xa0, 0x05] }],
  ["LDA (zp,X)", [0xa1, 0x10], 6],
  ["LDA (zp),Y in page", [0xb1, 0x10], 5, { mem: { 0x10: 0x00, 0x11: 0x02 } }],
  ["LDA (zp),Y across a page", [0xb1, 0x10], 6, { setup: [0xa0, 0x05], mem: { 0x10: 0xff, 0x11: 0x02 } }], // prettier-ignore
  ["LDA (zp)", [0xb2, 0x10], 5],
  ["STA abs", [0x8d, 0x00, 0x02], 4],
  ["STA abs,X in page", [0x9d, 0x00, 0x02], 5],
  ["STA (zp),Y in page", [0x91, 0x10], 6, { mem: { 0x10: 0x00, 0x11: 0x02 } }],
  ["STZ abs,X", [0x9e, 0x00, 0x02], 5],
  ["ASL zp", [0x06, 0x10], 5],
  ["ASL zp,X", [0x16, 0x10], 6],
  ["ASL abs", [0x0e, 0x00, 0x02], 6],
  ["ASL abs,X in page", [0x1e, 0x00, 0x02], 6],
  ["ASL abs,X across a page", [0x1e, 0xff, 0x02], 7, { setup: [0xa2, 0x05] }],
  ["INC abs,X in page", [0xfe, 0x00, 0x02], 7],
  ["TSB zp", [0x04, 0x10], 5],
  ["TRB abs", [0x1c, 0x00, 0x02], 6],
  ["RMB0 zp", [0x07, 0x10], 5],
  ["BIT abs,X", [0x3c, 0x00, 0x02], 4],
  ["PHA", [0x48], 3],
  ["PLA", [0x68], 4],
  ["PHP", [0x08], 3],
  ["PLP", [0x28], 4],
  ["JSR", [0x20, 0x00, 0xa0], 6],
  ["RTS", [0x60], 6],
  ["RTI", [0x40], 6],
  ["BRK", [0x00, 0x00], 7],
  ["JMP abs", [0x4c, 0x00, 0xa0], 3],
  ["JMP (abs)", [0x6c, 0x00, 0x02], 6],
  ["JMP (abs,X)", [0x7c, 0x00, 0x02], 6],
  ["BNE not taken", [0xd0, 0x10], 2, { setup: [0xa9, 0x00] }],
  ["BNE taken", [0xd0, 0x10], 3, { setup: [0xa9, 0x01] }],
  ["BNE taken across a page", [0xd0, 0x10], 4, { setup: [0xa9, 0x01], at: 0x90f0 }], // prettier-ignore
  ["BRA", [0x80, 0x10], 3],
  ["BBR0 not taken", [0x0f, 0x10, 0x10], 5, { mem: { 0x10: 0x01 } }],
  ["BBR0 taken", [0x0f, 0x10, 0x10], 6, { mem: { 0x10: 0x00 } }],
  ["ADC # binary", [0x69, 0x01], 2],
  ["ADC # decimal", [0x69, 0x01], 3, { setup: [0xf8] }],
  ["SBC abs decimal", [0xed, 0x00, 0x02], 5, { setup: [0xf8] }],
  ["undefined $03 (1 byte)", [0x03], 1],
  ["undefined $02 (2 bytes)", [0x02, 0x00], 2],
  ["undefined $44 (zp)", [0x44, 0x10], 3],
  ["undefined $54 (zp,X)", [0x54, 0x10], 4],
  ["undefined $DC (abs)", [0xdc, 0x00, 0x02], 4],
  ["undefined $5C", [0x5c, 0x00, 0x02], 8],
];

for (const [what, instr, cycles, opts] of CYCLES) {
  test(`cycles: ${what} takes ${cycles}`, () => {
    assert.equal(traceOne(instr, opts).length, cycles);
  });
}

test("the dummy cycles read where the 65C02 reads, never a half-formed address", () => {
  // RMW: read, read again (the 65C02's re-read), write.
  assert.deepEqual(traceOne([0x0e, 0x00, 0x02]), ["r9000", "r9001", "r9002", "r0200", "r0200", "w0200"]); // prettier-ignore
  // An index carried into the high byte: the last operand byte again.
  assert.deepEqual(traceOne([0xbd, 0xff, 0x02], { setup: [0xa2, 0x05] }), ["r9000", "r9001", "r9002", "r9002", "r0304"]); // prettier-ignore
  // Implied: the next byte, PC unmoved.
  assert.deepEqual(traceOne([0xe8]), ["r9000", "r9001"]);
  // PLA: the next byte, the stack at S, then the pull from S+1.
  assert.deepEqual(traceOne([0x68], { s: 0xf0 }), ["r9000", "r9001", "r01f0", "r01f1"]); // prettier-ignore
  // RTS: …and the return address read before it is stepped past.
  const rts = traceOne([0x60], { s: 0xf0, mem: { 0x1f1: 0x34, 0x1f2: 0x12 } });
  assert.deepEqual(rts, ["r9000", "r9001", "r01f0", "r01f1", "r01f2", "r1234"]);
});

test("reset takes seven cycles and leaves S at $FD; an IRQ takes seven", () => {
  const m = machine([0x58, 0xea, 0x4c, 0x01, 0x80], 0x8000, { irqVec: 0x9000 }); // CLI ; NOP ; JMP $8001
  m.mem.set([0x40], 0x9000); // RTI
  let n = 0;
  while (!(m.state.cur === "instr" && m.state.sync)) {
    m.cycle();
    n++;
  }
  assert.equal(n, 7, "two reads of PC, three of the stack, the vector");
  assert.equal(m.state.s, 0xfd);
  m.runTo(0x8001);
  m.runTo(0x8001); // the NOP once more, with interrupts on
  // Raise IRQ: it is taken at the next boundary, and its sequence is 7.
  const seen = [];
  for (let i = 0; i < 40 && m.state.cur !== "irq"; i++) m.cycle({ irq: true });
  while (m.state.cur === "irq") {
    seen.push(`${m.state.rw}${m.state.addr.toString(16)}`);
    m.cycle({ irq: true });
  }
  assert.equal(seen.length, 7);
  assert.deepEqual(seen.slice(5), ["rfffe", "rffff"]);
});

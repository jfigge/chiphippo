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

// w65c02.test.js — the W65C02 CPU CORE against a plain 64 KiB memory array (fast,
// no engine/PHI2 plumbing). Each `cycle()` serves the CPU's pending bus access
// from memory and advances one clock; small programs then assert registers and
// memory. Reset boots from the $FFFC vector, so a machine just runs from `org`.

import test from "node:test";
import assert from "node:assert/strict";

import { initialCpu, cpuCycle } from "../sim/w65c02.js";

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

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

// Behavioral tests for the 74LS wave (catalog/chips-74ls.js). Combinational
// parts are checked through evaluate(); sequential parts by driving the pure
// `logic.step`/`logic.outputs` directly, mirroring how the engine feeds them
// (inputLevels floats → HIGH, so omitted input pins default HIGH here too).
// Datasheet-exact pin numbers come from the def, so a wrong pin map fails.

import test from "node:test";
import assert from "node:assert/strict";

import { chipDef } from "../catalog/index.js";
import { H, L, Z } from "../sim/levels.js";
import { evaluate } from "../sim/chip-eval.js";

/** Combinational: pin→level map (only the pins named; others left unset → Z). */
const lv = (obj) => new Map(Object.entries(obj).map(([k, v]) => [+k, v]));

/** Sequential input map: every input pin floats HIGH (asInput), then overrides. */
function ins(def, obj = {}) {
  const m = new Map();
  for (const p of def.pins) if (p.role === "input") m.set(p.n, H);
  for (const [k, v] of Object.entries(obj)) m.set(+k, v);
  return m;
}

/** A sequential stepper: applies one (prev→cur) transition, returns new state. */
function step(def, state, curObj, prevObj) {
  return def.logic.step(state, ins(def, curObj), ins(def, prevObj ?? curObj));
}
/** The outputs a sequential def drives for a state + current inputs. */
function outs(def, state, curObj) {
  return def.logic.outputs(state, ins(def, curObj));
}
/** Pulse a clock pin L→H (or H→L) once and return { state, out }. */
function pulse(def, state, base, clkPin, rising = true) {
  const lowFirst = { ...base, [clkPin]: rising ? L : H };
  const highNext = { ...base, [clkPin]: rising ? H : L };
  const s = step(def, state, highNext, lowFirst);
  return { state: s, out: outs(def, s, highNext) };
}

// ── Inverters ────────────────────────────────────────────────────────────────

test("74LS05 / 74LS14: six inverters (Schmitt is analog — logic is NOT)", () => {
  for (const id of ["74LS05", "74LS14"]) {
    const def = chipDef(id);
    assert.equal(evaluate(def, lv({ 1: H })).get(2), L);
    assert.equal(evaluate(def, lv({ 1: L })).get(2), H);
    assert.equal(evaluate(def, lv({ 13: L })).get(12), H); // last inverter
  }
});

// ── 74LS112 dual JK, negative edge ───────────────────────────────────────────

test("74LS112: JK toggles on the falling edge; async preset/clear win", () => {
  const def = chipDef("74LS112");
  // FF1: J=3,K=2,CLK=1,PRE=4,CLR=15,Q=5. Toggle mode J=K=H.
  let s = def.logic.state0();
  // Falling edge with J=K=H toggles L→H.
  let r = pulse(def, s, { 3: H, 2: H, 4: H, 15: H }, 1, false);
  assert.equal(r.out.get(5), H);
  r = pulse(def, r.state, { 3: H, 2: H, 4: H, 15: H }, 1, false);
  assert.equal(r.out.get(5), L); // toggled back
  // A RISING edge does nothing (negative-edge part).
  r = pulse(def, r.state, { 3: H, 2: H, 4: H, 15: H }, 1, true);
  assert.equal(r.out.get(5), L);
  // Async clear (CLR=15 low) forces Q low regardless of clock.
  s = step(def, def.logic.state0(), { 15: L });
  assert.equal(outs(def, s, { 15: L }).get(5), L);
  // Async preset (PRE=4 low) forces Q high.
  s = step(def, def.logic.state0(), { 4: L, 15: H });
  assert.equal(outs(def, s, { 4: L, 15: H }).get(5), H);
});

// ── 74LS173 4-bit register, tri-state ────────────────────────────────────────

test("74LS173: loads when both Ḡ low, holds otherwise, CLR active-HIGH, OE→Z", () => {
  const def = chipDef("74LS173");
  // D1..D4 = 14,13,12,11 ; Q1..Q4 = 3,4,5,6 ; CLK=7 ; G1̄=9,G2̄=10 ; M̄=1,N̄=2 ; CLR=15.
  const enabled = { 1: L, 2: L, 15: L }; // outputs enabled, not cleared
  // Load 1010 (D1=H,D2=L,D3=H,D4=L) with both data-enables low.
  let r = pulse(
    def,
    def.logic.state0(),
    {
      ...enabled,
      9: L,
      10: L,
      14: H,
      13: L,
      12: H,
      11: L,
    },
    7,
  );
  assert.deepEqual(
    [3, 4, 5, 6].map((p) => r.out.get(p)),
    [H, L, H, L],
  );
  // Data-enable G1̄ high → the clock is ignored (hold), even with new data.
  r = pulse(
    def,
    r.state,
    { ...enabled, 9: H, 10: L, 14: L, 13: L, 12: L, 11: L },
    7,
  );
  assert.deepEqual(
    [3, 4, 5, 6].map((p) => r.out.get(p)),
    [H, L, H, L],
  );
  // Output-enable de-asserted (M̄ high) → outputs float.
  assert.equal(outs(def, r.state, { 1: H, 2: L, 15: L }).get(3), Z);
  // CLR is active-HIGH and asynchronous.
  const cleared = step(def, r.state, { 15: H });
  assert.deepEqual(
    [3, 4, 5, 6].map((p) => outs(def, cleared, { 1: L, 2: L, 15: H }).get(p)),
    [L, L, L, L],
  );
});

// ── 74LS174 / 74LS273 D registers ────────────────────────────────────────────

test("74LS174: hex D register loads on the rising edge; async clear low", () => {
  const def = chipDef("74LS174");
  // D1..D6 = 3,4,6,11,13,14 ; Q1..Q6 = 2,5,7,10,12,15 ; CLK=9 ; CLR̄=1.
  const r = pulse(
    def,
    def.logic.state0(),
    {
      1: H,
      3: H,
      4: L,
      6: H,
      11: L,
      13: H,
      14: L,
    },
    9,
  );
  assert.deepEqual(
    [2, 5, 7, 10, 12, 15].map((p) => r.out.get(p)),
    [H, L, H, L, H, L],
  );
  // Async clear (CLR̄=1 low) zeroes every Q.
  const cleared = step(def, r.state, { 1: L });
  assert.deepEqual(
    [2, 5, 7, 10, 12, 15].map((p) => outs(def, cleared, { 1: L }).get(p)),
    [L, L, L, L, L, L],
  );
});

test("74LS273: octal D register loads on the rising edge; async clear low", () => {
  const def = chipDef("74LS273");
  // D1..D8 = 3,4,7,8,13,14,17,18 ; Q1..Q8 = 2,5,6,9,12,15,16,19 ; CLK=11 ; CLR̄=1.
  const dPins = [3, 4, 7, 8, 13, 14, 17, 18];
  const qPins = [2, 5, 6, 9, 12, 15, 16, 19];
  const pattern = [H, L, H, L, H, H, L, L];
  const base = { 1: H };
  dPins.forEach((p, i) => (base[p] = pattern[i]));
  const r = pulse(def, def.logic.state0(), base, 11);
  assert.deepEqual(
    qPins.map((p) => r.out.get(p)),
    pattern,
  );
  const cleared = step(def, r.state, { 1: L });
  assert.deepEqual(
    qPins.map((p) => outs(def, cleared, { 1: L }).get(p)),
    Array(8).fill(L),
  );
});

// ── 74LS279 quad SR latch ────────────────────────────────────────────────────

test("74LS279: S̄ low sets, R̄ low resets, both high holds; dual-set OR", () => {
  const def = chipDef("74LS279");
  // Latch 1: S̄A=2,S̄B=3,R̄=1,Q=4 (dual set). Latch 2: S̄=6,R̄=5,Q=7.
  let s = def.logic.state0();
  // Set latch 1 via S̄B only (either set input low sets it).
  s = step(def, s, { 2: H, 3: L, 1: H });
  assert.equal(outs(def, s, { 2: H, 3: L, 1: H }).get(4), H);
  // Hold (both S̄ high, R̄ high).
  s = step(def, s, { 2: H, 3: H, 1: H });
  assert.equal(outs(def, s, { 2: H, 3: H, 1: H }).get(4), H);
  // Reset latch 1.
  s = step(def, s, { 2: H, 3: H, 1: L });
  assert.equal(outs(def, s, { 2: H, 3: H, 1: L }).get(4), L);
  // Latch 2 independent: set it.
  s = step(def, s, { 6: L, 5: H });
  assert.equal(outs(def, s, { 6: L, 5: H }).get(7), H);
});

// ── Multiplexers / selectors (COMB — not covered by the gate harness) ────────

test("74LS151: 8:1 mux selects the addressed data; strobe forces LOW", () => {
  const def = chipDef("74LS151");
  // sel A=11,B=10,C=9 ; D0..D7 = 4,3,2,1,15,14,13,12 ; Y=5,W̄=6 ; Ḡ=7.
  // Address 3 (CBA=011) → D3 = pin 1.
  const at3 = { 11: H, 10: H, 9: L, 7: L };
  assert.equal(evaluate(def, lv({ ...at3, 1: H })).get(5), H); // Y = D3
  assert.equal(evaluate(def, lv({ ...at3, 1: H })).get(6), L); // W̄ = Ȳ
  assert.equal(evaluate(def, lv({ ...at3, 1: L })).get(5), L);
  // Strobe high → Y LOW, W̄ HIGH (not tri-state).
  assert.equal(evaluate(def, lv({ ...at3, 7: H, 1: H })).get(5), L);
  assert.equal(evaluate(def, lv({ ...at3, 7: H, 1: H })).get(6), H);
});

test("74LS153: dual 4:1 mux — shared select, independent strobes", () => {
  const def = chipDef("74LS153");
  // Shared select A=14,B=2. Sec1 data 1C0..3 = 6,5,4,3 ; 1Y=7 ; 1Ḡ=1.
  // Address 2 (BA=10) → 1C2 = pin 4.
  assert.equal(evaluate(def, lv({ 14: L, 2: H, 1: L, 4: H })).get(7), H);
  assert.equal(evaluate(def, lv({ 14: L, 2: H, 1: L, 4: L })).get(7), L);
  // Section-1 strobe high → 1Y LOW regardless of data.
  assert.equal(evaluate(def, lv({ 14: L, 2: H, 1: H, 4: H })).get(7), L);
  // Section 2 is independent: 2C1 = pin 11, 2Y = 9, 2Ḡ = 15, address 1 (BA=01).
  assert.equal(evaluate(def, lv({ 14: H, 2: L, 15: L, 11: H })).get(9), H);
});

test("74LS157: quad 2:1 selects A or B; disabled → LOW (not Z)", () => {
  const def = chipDef("74LS157");
  // S=1 ; ch1 A=2,B=3,Y=4 ; Ḡ=15.
  assert.equal(evaluate(def, lv({ 1: L, 15: L, 2: H, 3: L })).get(4), H); // S low → A
  assert.equal(evaluate(def, lv({ 1: H, 15: L, 2: H, 3: L })).get(4), L); // S high → B
  assert.equal(evaluate(def, lv({ 1: L, 15: H, 2: H })).get(4), L); // disabled → LOW
});

test("74LS257: quad 2:1 tri-state — disabled outputs float (Z)", () => {
  const def = chipDef("74LS257");
  // S=1 ; ch1 A=2,B=3,Y=4 ; ŌĒ=15.
  assert.equal(evaluate(def, lv({ 1: L, 15: L, 2: H, 3: L })).get(4), H); // S low → A
  assert.equal(evaluate(def, lv({ 1: H, 15: L, 2: L, 3: H })).get(4), H); // S high → B
  assert.equal(evaluate(def, lv({ 1: L, 15: H, 2: H })).get(4), Z); // disabled → Z
});

// ── Octal buffers (240 inverting-COMB; 244 BUF3 covered by the gate harness) ──

test("74LS240: octal inverting 3-state buffer, per-group enable", () => {
  const def = chipDef("74LS240");
  // Group 1 enable 1Ḡ=1 ; 1A1(2)→1Y1(18). Inverting.
  assert.equal(evaluate(def, lv({ 1: L, 2: H })).get(18), L);
  assert.equal(evaluate(def, lv({ 1: L, 2: L })).get(18), H);
  assert.equal(evaluate(def, lv({ 1: H, 2: H })).get(18), Z); // group disabled → Z
  // Group 2 is independent: 2Ḡ=19 ; 2A1(11)→2Y1(9).
  assert.equal(evaluate(def, lv({ 19: L, 11: H })).get(9), L);
  assert.equal(evaluate(def, lv({ 19: H, 11: H })).get(9), Z);
});

test("74LS245: octal transceiver drives A→B or B→A; ŌĒ tri-states both sides", () => {
  const def = chipDef("74LS245");
  // DIR=1 (high → A→B), ŌĒ=19 ; pair A1=2 / B1=18.
  // A→B: B1 follows A1, and the A side is the input (not driven → Z).
  let out = evaluate(def, lv({ 1: H, 19: L, 2: L }));
  assert.equal(out.get(18), L); // B1 = A1
  assert.equal(out.get(2), Z); // A1 is the source side, not driven
  out = evaluate(def, lv({ 1: H, 19: L, 2: H }));
  assert.equal(out.get(18), H);
  // B→A: DIR low → A1 follows B1, B side not driven.
  out = evaluate(def, lv({ 1: L, 19: L, 18: L }));
  assert.equal(out.get(2), L); // A1 = B1
  assert.equal(out.get(18), Z);
  // Output-enable de-asserted → both sides float.
  out = evaluate(def, lv({ 1: H, 19: H, 2: L }));
  assert.equal(out.get(18), Z);
  assert.equal(out.get(2), Z);
});

// ── Decoders / arithmetic / comparators (COMB) ───────────────────────────────

test("74LS47: BCD→7-segment decode, lamp test, and blanking", () => {
  const def = chipDef("74LS47");
  // seg pins a=13,b=12,c=11,d=10,e=9,f=15,g=14 ; BCD A=7,B=1,C=2,D=6.
  const seg = { a: 13, b: 12, c: 11, d: 10, e: 9, f: 15, g: 14 };
  const on = (out, s) => out.get(seg[s]) === L; // active-low: L = lit
  // Digit 0 (A=B=C=D=L): a-f lit, g dark. LT̄/RBĪ/BĪ default HIGH.
  let out = evaluate(def, lv({ 7: L, 1: L, 2: L, 6: L }));
  assert.deepEqual(
    ["a", "b", "c", "d", "e", "f", "g"].map((s) => on(out, s)),
    [true, true, true, true, true, true, false],
  );
  // Digit 1 (A=H): only b,c lit.
  out = evaluate(def, lv({ 7: H, 1: L, 2: L, 6: L }));
  assert.deepEqual(
    ["a", "b", "c", "d", "e", "f", "g"].map((s) => on(out, s)),
    [false, true, true, false, false, false, false],
  );
  // Lamp test (LT̄=3 low) → every segment lit.
  out = evaluate(def, lv({ 3: L }));
  assert.ok(["a", "b", "c", "d", "e", "f", "g"].every((s) => on(out, s)));
  // Blanking input (BĪ=4 low) dominates → every segment dark, even in lamp test.
  out = evaluate(def, lv({ 4: L, 3: L }));
  assert.ok(["a", "b", "c", "d", "e", "f", "g"].every((s) => !on(out, s)));
});

test("74LS85: 4-bit magnitude comparator with cascade", () => {
  const def = chipDef("74LS85");
  // A0..3 = 10,12,13,15 ; B0..3 = 9,11,14,1 ; cascade IA>B=4,IA=B=3,IA<B=2.
  // Normal cascade: IA>B=L, IA<B=L, IA=B=H. Outputs A>B=5,A=B=6,A<B=7.
  const casc = { 4: L, 2: L, 3: H };
  // A=5 (0101), B=3 (0011) → A>B.
  const A5 = { 10: H, 12: L, 13: H, 15: L };
  const B3 = { 9: H, 11: H, 14: L, 1: L };
  let out = evaluate(def, lv({ ...casc, ...A5, ...B3 }));
  assert.deepEqual([out.get(5), out.get(6), out.get(7)], [H, L, L]);
  // A=B=5 with normal cascade → A=B.
  const B5 = { 9: H, 11: L, 14: H, 1: L };
  out = evaluate(def, lv({ ...casc, ...A5, ...B5 }));
  assert.deepEqual([out.get(5), out.get(6), out.get(7)], [L, H, L]);
});

test("74LS148: 8-to-3 priority encoder (active-low, highest wins)", () => {
  const def = chipDef("74LS148");
  // I0..7 = 10,11,12,13,1,2,3,4 ; EI=5 ; A0=9,A1=7,A2=6 ; GS=14,EO=15.
  // Enabled (EI low), assert I5 (pin 2) low, plus a lower one I2 (pin 12).
  let out = evaluate(def, lv({ 5: L, 2: L, 12: L }));
  // Highest = 5 → code = ~5 = A2A1A0 (101) active-low = L,H,L.
  assert.deepEqual([out.get(9), out.get(7), out.get(6)], [L, H, L]);
  assert.equal(out.get(14), L); // GS: valid data
  assert.equal(out.get(15), H); // EO: not "enabled-but-idle"
  // Disabled (EI high) → all outputs high.
  out = evaluate(def, lv({ 5: H, 2: L }));
  assert.deepEqual(
    [out.get(9), out.get(7), out.get(6), out.get(14), out.get(15)],
    [H, H, H, H, H],
  );
  // Enabled but no input active → EO low (cascade down), GS high.
  out = evaluate(def, lv({ 5: L }));
  assert.deepEqual([out.get(14), out.get(15)], [H, L]);
});

test("74LS283: 4-bit adder with carry-lookahead", () => {
  const def = chipDef("74LS283");
  // A1..4 = 5,3,14,12 ; B1..4 = 6,2,15,11 ; C0=7 ; S1..4 = 4,1,13,10 ; C4=9.
  // 3 + 6 + 0 = 9 → S = 1001.
  const A3 = { 5: H, 3: H, 14: L, 12: L };
  const B6 = { 6: L, 2: H, 15: H, 11: L };
  let out = evaluate(def, lv({ ...A3, ...B6, 7: L }));
  assert.deepEqual(
    [out.get(4), out.get(1), out.get(13), out.get(10), out.get(9)],
    [H, L, L, H, L], // S1 S2 S3 S4 C4
  );
  // 15 + 1 + 0 = 16 → S = 0000, carry out.
  const A15 = { 5: H, 3: H, 14: H, 12: H };
  const B1 = { 6: H, 2: L, 15: L, 11: L };
  out = evaluate(def, lv({ ...A15, ...B1, 7: L }));
  assert.deepEqual(
    [out.get(4), out.get(1), out.get(13), out.get(10), out.get(9)],
    [L, L, L, L, H],
  );
});

// ── Sequential: counter, addressable latch, octal latches, shift register ────

test("74LS169: synchronous up/down count, load, and ripple carry", () => {
  const def = chipDef("74LS169");
  // CLK=2, U/D̄=1, ENP̄=7, ENT̄=10, LOAD̄=9 ; A..D = 3,4,5,6 ; QA..QD = 14,13,12,11 ; RCŌ=15.
  const q = (out) => [out.get(14), out.get(13), out.get(12), out.get(11)];
  // Synchronous load of 5 (A=H,B=L,C=H,D=L).
  let r = pulse(def, def.logic.state0(), { 9: L, 3: H, 4: L, 5: H, 6: L }, 2);
  assert.deepEqual(q(r.out), [H, L, H, L]); // 5
  // Count up once (LOAD̄ high, both enables low, U/D̄ high) → 6.
  r = pulse(def, r.state, { 9: H, 1: H, 7: L, 10: L }, 2);
  assert.deepEqual(q(r.out), [L, H, H, L]); // 6
  // Count down once → 5.
  r = pulse(def, r.state, { 9: H, 1: L, 7: L, 10: L }, 2);
  assert.deepEqual(q(r.out), [H, L, H, L]); // 5
  // Load 15 and check RCŌ asserts (low) counting up with ENT̄ low.
  r = pulse(def, r.state, { 9: L, 3: H, 4: H, 5: H, 6: H }, 2);
  assert.equal(outs(def, r.state, { 1: H, 10: L }).get(15), L); // terminal count up
  assert.equal(outs(def, r.state, { 1: H, 10: H }).get(15), H); // ENT̄ high masks RCŌ
});

test("74LS259: addressable latch stores one addressed bit; clear zeroes all", () => {
  const def = chipDef("74LS259");
  // A0=1,A1=2,A2=3 ; D=13 ; Ḡ=14 ; CLR̄=15 ; Q0..7 = 4,5,6,7,9,10,11,12.
  let s = def.logic.state0();
  // Addressable-latch mode (CLR̄ high, Ḡ low): write D=1 into latch 3 (addr 011).
  s = step(def, s, { 15: H, 14: L, 1: H, 2: H, 3: L, 13: H });
  assert.equal(
    outs(def, s, { 15: H, 14: L, 1: H, 2: H, 3: L, 13: H }).get(7),
    H,
  ); // Q3
  // Memory mode (Ḡ high): latch 3 holds even as D/address change.
  s = step(def, s, { 15: H, 14: H, 13: L, 1: L, 2: L, 3: L });
  assert.equal(outs(def, s, { 15: H, 14: H }).get(7), H); // Q3 still set
  assert.equal(outs(def, s, { 15: H, 14: H }).get(4), L); // Q0 untouched
  // Clear (CLR̄ low, Ḡ high) → every output low.
  s = step(def, s, { 15: L, 14: H });
  const out = outs(def, s, { 15: L, 14: H });
  assert.deepEqual(
    [4, 5, 6, 7, 9, 10, 11, 12].map((p) => out.get(p)),
    Array(8).fill(L),
  );
});

test("74LS573 / 74LS533: transparent octal latch, tri-state (533 inverts)", () => {
  const t = chipDef("74LS573");
  // D1=2→Q1=19 ; LE=11 ; ŌĒ=1. Transparent while LE high.
  let s = step(t, t.logic.state0(), { 1: L, 11: H, 2: H });
  assert.equal(outs(t, s, { 1: L, 11: H, 2: H }).get(19), H); // follows D
  // Latch: LE low holds the last value even as D changes.
  s = step(t, s, { 1: L, 11: L, 2: L });
  assert.equal(outs(t, s, { 1: L, 11: L, 2: L }).get(19), H);
  // Output-enable high → high-Z.
  assert.equal(outs(t, s, { 1: H, 11: L }).get(19), Z);

  const inv = chipDef("74LS533");
  // D1=3→Q̄1=2 (inverting) ; LE=11 ; ŌĒ=1.
  const si = step(inv, inv.logic.state0(), { 1: L, 11: H, 3: H });
  assert.equal(outs(inv, si, { 1: L, 11: H, 3: H }).get(2), L); // Q̄ = NOT D
});

test("74LS595: shift register feeds the storage latch; OE tri-states outputs", () => {
  const def = chipDef("74LS595");
  // SER=14, SRCLK=11, RCLK=12, MR̄=10, ŌĒ=13 ; QA=15 ; QH′=9.
  let s = def.logic.state0();
  // Shift a 1 into stage A. Parallel outputs still hold OLD storage (0).
  let r = pulse(def, s, { 14: H, 13: L }, 11);
  assert.equal(outs(def, r.state, { 13: L }).get(15), L); // QA still 0 (not latched)
  // Latch the shift register into storage → QA now 1.
  r = pulse(def, r.state, { 13: L }, 12);
  assert.equal(outs(def, r.state, { 13: L }).get(15), H); // QA = 1
  // Output-enable high → parallel outputs float; QH′ stays driven.
  assert.equal(outs(def, r.state, { 13: H }).get(15), Z);
  assert.notEqual(outs(def, r.state, { 13: H }).get(9), Z);
});

test("74LS90: ÷2 section on QA; gated reset-to-0 and set-to-9", () => {
  const def = chipDef("74LS90");
  // CKA=14→QA(12) ; CKB=1→QB(9),QC(8),QD(11) ; R0=2,3 ; R9=6,7. Falling edge.
  // Hold one of each reset pair low so the counter can run.
  const run = { 2: L, 6: L }; // R0(1) low, R9(1) low → neither reset asserted
  let r = pulse(def, def.logic.state0(), run, 14, false); // CKA falling
  assert.equal(r.out.get(12), H); // QA toggled 0→1
  r = pulse(def, r.state, run, 14, false);
  assert.equal(r.out.get(12), L); // QA 1→0
  // ÷5 section: one CKB fall → QB high (count = 1).
  r = pulse(def, def.logic.state0(), run, 1, false);
  assert.equal(r.out.get(9), H); // QB
  // Set-to-9: R9(1)&R9(2) high (R0 not both high) → QD,QA high; QB,QC low → 1001.
  const s9 = step(def, def.logic.state0(), { 2: L, 6: H, 7: H });
  const o9 = outs(def, s9, { 2: L, 6: H, 7: H });
  assert.deepEqual(
    [o9.get(12), o9.get(9), o9.get(8), o9.get(11)],
    [H, L, L, H], // QA QB QC QD = 1001 = 9
  );
});

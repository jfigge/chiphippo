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

// w65c22.js — the WDC W65C22 Versatile Interface Adapter (VIA), the CMOS 6522,
// as a PURE, DOM-free state machine behind the STANDARD sequential contract
// ({ state0, step, outputs }). Like sim/w65c21.js (the PIA) and sim/hd44780.js
// (the LCD), it is genuine per-part code the gate/family vocabulary cannot
// express; the def in catalog/chips-io.js is pure data referencing this builder.
//
// The VIA adds to the PIA two 16-bit interval timers (T1/T2), an 8-bit shift
// register, and a unified interrupt-flag / interrupt-enable pair (IFR/IER). The
// 16 registers select from RS3..RS0 (Table 2-1):
//
//   0 ORB/IRB   4 T1C-L   8 T2C-L   C PCR
//   1 ORA/IRA   5 T1C-H   9 T2C-H   D IFR
//   2 DDRB      6 T1L-L   A SR      E IER
//   3 DDRA      7 T1L-H   B ACR     F ORA/IRA (no handshake)
//
// Bus timing follows the PIA/LCD model: the VIA is SELECTED while CS1 is high
// and CS2B low; a READ (RWB high) drives D0–D7 with the addressed register while
// PHI2 is high; a transfer COMMITS on PHI2's FALLING edge. The timers decrement
// once per PHI2 cycle, sampled on PHI2's RISING edge — so a value loaded on a
// falling edge first decrements on the next rising edge, matching the datasheet's
// "counts down on the next PHI2 following the load."
//
// ── Zero-delay abstraction & scope ───────────────────────────────────────────
// This is a LOGIC-LEVEL, timerless model (the engine has no wall clock — the
// SimController's interval merely produces PHI2 edges). Consequences, all
// faithful to how the rest of the sim works:
//   • Timer periods are measured in PHI2 cycles the user clocks in, not seconds.
//   • The SHIFT REGISTER is fully modeled for the EXTERNAL-clock modes (CB1 in),
//     where each CB1 edge shifts one bit — the natural breadboard use. The
//     internal-clock modes (PHI2- and T2-paced) shift one bit per PHI2 cycle and
//     drive CB1 as a toggling output clock; the exact CB1 waveform and the
//     T2-rate pacing are APPROXIMATED at PHI2 rate (documented, not datasheet-
//     exact). 8-bit transfers and IFR2 still behave correctly.
//   • IRQB is OPEN-DRAIN active-low (the W65C22N model): LOW when an enabled flag
//     is set, else high-impedance (Z) so it wire-ORs onto the processor IRQ.
//
// Ports PA/PB and the control lines CA2/CB1/CB2 are the `io` role — driven when
// programmed as outputs, floating (Z) when inputs. Input latching (ACR bits 0/1)
// captures the port pins at the active CA1/CB1 edge.

import { H, L, Z } from "./levels.js";

/** One clean bit from an asInput'd level (H → 1; L/X → 0 — a float reads H). */
const bit = (lv) => (lv === H ? 1 : 0);
const high = (lv) => lv === H;
const b = (v, n) => (v >> n) & 1;
const rose = (p, c) => p === L && c === H;
const fell = (p, c) => p === H && c === L;
const activeEdge = (edgeSelHigh, prev, cur) =>
  edgeSelHigh ? rose(prev, cur) : fell(prev, cur);

// IFR / IER bit positions (Table 2-11).
const F_CA2 = 0;
const F_CA1 = 1;
const F_SR = 2;
const F_CB2 = 3;
const F_CB1 = 4;
const F_T2 = 5;
const F_T1 = 6;

/**
 * The W65C22 VIA behavior as a sequential unit.
 * @param {object} pins - catalog pin numbers.
 * @param {number[]} pins.pa @param {number[]} pins.pb @param {number[]} pins.d
 * @param {number} pins.ca1 @param {number} pins.ca2
 * @param {number} pins.cb1 @param {number} pins.cb2
 * @param {number[]} pins.rs - [RS0, RS1, RS2, RS3]
 * @param {number} pins.cs1 @param {number} pins.cs2b
 * @param {number} pins.rwb @param {number} pins.phi2 @param {number} pins.resb
 * @param {number} pins.irqb
 * @returns {{ state0: Function, step: Function, outputs: Function }}
 */
export function w65c22Unit(pins) {
  const {
    pa,
    pb,
    d,
    ca1,
    ca2,
    cb1,
    cb2,
    rs,
    cs1,
    cs2b,
    rwb,
    phi2,
    resb,
    irqb,
  } = pins;

  const selected = (ins) => high(ins.get(cs1)) && !high(ins.get(cs2b));
  const regSelect = (ins) =>
    rs.reduce((n, pin, i) => n | (bit(ins.get(pin)) << i), 0);
  const readData = (ins) =>
    d.reduce((n, pin, i) => n | (bit(ins.get(pin)) << i), 0);
  const pinsToByte = (list, ins) =>
    list.reduce((n, pin, i) => n | (bit(ins.get(pin)) << i), 0);

  // Shift-register mode decode from ACR bits 4..2 (Table 2-10).
  const srMode = (s) => (s.acr >> 2) & 7;
  const srEnabled = (s) => srMode(s) !== 0;
  const srShiftOut = (s) => (srMode(s) & 4) !== 0;
  const srExternal = (s) => srMode(s) === 3 || srMode(s) === 7;
  const srFreeRun = (s) => srMode(s) === 4;

  /** Port A read value: the latched IRA (ACR0) or the live pin levels. */
  const readPortA = (s, ins) => (b(s.acr, 0) ? s.ira : pinsToByte(pa, ins));

  /** Port B read value: ORB for output lines, else the latch or the pin. */
  const readPortB = (s, ins) =>
    pb.reduce((n, pin, i) => {
      const val = b(s.ddrb, i)
        ? b(s.orb, i)
        : b(s.acr, 1)
          ? b(s.irb, i)
          : bit(ins.get(pin));
      return n | (val << i);
    }, 0);

  /** IRQ asserted when any enabled flag is set. */
  const irqActive = (s) => (s.ifr & s.ier & 0x7f) !== 0;

  /** The value a register presents on a read — PURE (no side effects). */
  const readRegister = (s, ins) => {
    switch (regSelect(ins)) {
      case 0x0:
        return readPortB(s, ins);
      case 0x1:
      case 0xf:
        return readPortA(s, ins);
      case 0x2:
        return s.ddrb;
      case 0x3:
        return s.ddra;
      case 0x4:
        return s.t1c & 0xff;
      case 0x5:
        return (s.t1c >> 8) & 0xff;
      case 0x6:
        return s.t1l & 0xff;
      case 0x7:
        return (s.t1l >> 8) & 0xff;
      case 0x8:
        return s.t2c & 0xff;
      case 0x9:
        return (s.t2c >> 8) & 0xff;
      case 0xa:
        return s.sr;
      case 0xb:
        return s.acr;
      case 0xc:
        return s.pcr;
      case 0xd:
        return s.ifr | (irqActive(s) ? 0x80 : 0);
      default:
        return s.ier | 0x80; // 0xe
    }
  };

  /** CA2 output level, or null (input → floats). PCR bits 3..1. */
  const ca2Out = (s) => {
    const m = (s.pcr >> 1) & 7;
    if (m < 4) return null;
    if (m === 6) return L;
    if (m === 7) return H;
    return s.ca2; // 100 handshake / 101 pulse → tracked level
  };
  /** CB2 output level, or null. Serial-out (SR) wins; else PCR bits 7..5. */
  const cb2Out = (s) => {
    if (srEnabled(s)) return srShiftOut(s) ? s.srDataOut : null; // serial data
    const m = (s.pcr >> 5) & 7;
    if (m < 4) return null;
    if (m === 6) return L;
    if (m === 7) return H;
    return s.cb2;
  };

  // ── Timer / shift helpers (mutate `next`, read `state`) ──────────────────────
  const decrementT1 = (next, state) => {
    const freerun = b(state.acr, 6) === 1;
    const pb7en = b(state.acr, 7) === 1;
    if (next.t1c === 0) {
      if (state.t1Armed) {
        next.ifr |= 1 << F_T1;
        if (pb7en) next.pb7 = freerun ? (state.pb7 === H ? L : H) : H;
        if (!freerun) next.t1Armed = false; // one-shot fires once
      }
      next.t1c = freerun ? state.t1l : 0xffff;
    } else {
      next.t1c = (next.t1c - 1) & 0xffff;
    }
  };

  const decrementT2 = (next, state) => {
    if (next.t2c === 0) {
      if (state.t2Armed) {
        next.ifr |= 1 << F_T2;
        next.t2Armed = false; // T2 is always one-shot
      }
      next.t2c = 0xffff;
    } else {
      next.t2c = (next.t2c - 1) & 0xffff;
    }
  };

  /** Shift one bit; `sample` is the CB2 input bit for shift-in modes. */
  const shiftOnce = (next, state, sample) => {
    if (srShiftOut(state)) {
      const outBit = (state.sr >> 7) & 1;
      next.sr = ((state.sr << 1) | outBit) & 0xff; // rotate (recirculate)
      next.srDataOut = outBit ? H : L;
    } else {
      next.sr = ((state.sr << 1) | sample) & 0xff; // new bit enters bit 0
    }
  };

  return {
    state0() {
      // Reset clears the registers and floats the ports; the timers hold their
      // (undefined) counts disarmed; the shift clock / serial out idle HIGH.
      return {
        ora: 0,
        orb: 0,
        ddra: 0,
        ddrb: 0,
        ira: 0,
        irb: 0,
        t1c: 0,
        t1l: 0,
        t2c: 0,
        t2ll: 0,
        t1Armed: false,
        t2Armed: false,
        sr: 0,
        srCount: 0,
        srActive: false,
        srClk: H,
        srDataOut: H,
        acr: 0,
        pcr: 0,
        ifr: 0,
        ier: 0,
        pb7: H,
        ca2: H,
        cb2: H,
        ca2pulse: false,
        cb2pulse: false,
      };
    },

    step(state, ins, prev) {
      if (ins.get(resb) === L) return this.state0(); // async reset

      const next = { ...state };
      const p = prev ?? new Map();
      const was = (pin) => (prev ? p.get(pin) : undefined);

      const caMode = (state.pcr >> 1) & 7; // CA2 control
      const cbMode = (state.pcr >> 5) & 7; // CB2 control
      const usingCb1Clock = srEnabled(state) && srExternal(state);

      // ── CA1 interrupt / latch / handshake return ───────────────────────────
      if (prev && activeEdge(b(state.pcr, 0), was(ca1), ins.get(ca1))) {
        next.ifr |= 1 << F_CA1;
        if (b(state.acr, 0)) next.ira = pinsToByte(pa, ins); // latch IRA
        if (caMode === 4) next.ca2 = H; // handshake output returns high
      }
      // ── CB1: either the SR external shift clock, or the CB1 interrupt ───────
      if (usingCb1Clock) {
        if (prev && rose(was(cb1), ins.get(cb1))) {
          shiftOnce(next, state, bit(ins.get(cb2)));
          next.srCount = state.srCount + 1;
          if (next.srCount >= 8) {
            next.ifr |= 1 << F_SR;
            next.srCount = 0; // recount the next eight (pulse counter)
          }
        }
      } else if (prev && activeEdge(b(state.pcr, 4), was(cb1), ins.get(cb1))) {
        next.ifr |= 1 << F_CB1;
        if (b(state.acr, 1)) next.irb = pinsToByte(pb, ins); // latch IRB
        if (cbMode === 4) next.cb2 = H;
      }
      // ── CA2 / CB2 as interrupt inputs (modes 0..3) ─────────────────────────
      if (
        caMode < 4 &&
        prev &&
        activeEdge(caMode & 2 ? 1 : 0, was(ca2), ins.get(ca2))
      ) {
        next.ifr |= 1 << F_CA2;
      }
      if (
        !srEnabled(state) &&
        cbMode < 4 &&
        prev &&
        activeEdge(cbMode & 2 ? 1 : 0, was(cb2), ins.get(cb2))
      ) {
        next.ifr |= 1 << F_CB2;
      }

      // ── PHI2 rising edge: advance the timers + internal shift clock ─────────
      if (prev && rose(was(phi2), ins.get(phi2))) {
        decrementT1(next, state);
        if (b(state.acr, 5) === 0) decrementT2(next, state); // timed mode
        // Internal (PHI2/T2-paced) shifting — one bit per cycle, CB1 toggling.
        if (srEnabled(state) && !srExternal(state)) {
          const run = srFreeRun(state) || (state.srActive && state.srCount < 8);
          if (run) {
            shiftOnce(next, state, bit(ins.get(cb2)));
            next.srClk = state.srClk === H ? L : H;
            if (!srFreeRun(state)) {
              next.srCount = state.srCount + 1;
              if (next.srCount >= 8) {
                next.ifr |= 1 << F_SR;
                next.srActive = false;
              }
            }
          }
        }
      }
      // ── T2 pulse-counting mode: decrement on PB6 falling edges ──────────────
      if (b(state.acr, 5) === 1 && prev && fell(was(pb[6]), ins.get(pb[6]))) {
        decrementT2(next, state);
      }

      // ── Bus transaction: commit on PHI2's falling edge while selected ───────
      if (prev && fell(was(phi2), ins.get(phi2)) && selected(ins)) {
        if (state.ca2pulse) {
          next.ca2 = H;
          next.ca2pulse = false;
        }
        if (state.cb2pulse) {
          next.cb2 = H;
          next.cb2pulse = false;
        }
        const reg = regSelect(ins);
        const write = ins.get(rwb) === L;
        const data = readData(ins);
        // CA2/CB2 flags are NOT auto-cleared in the "independent" input modes
        // (PCR 001/011) — only by writing the IFR.
        const caIndependent = caMode === 1 || caMode === 3;
        const cbIndependent = cbMode === 1 || cbMode === 3;

        if (write) {
          switch (reg) {
            case 0x0: // ORB
              next.orb = data;
              next.ifr &= ~(1 << F_CB1);
              if (!cbIndependent) next.ifr &= ~(1 << F_CB2);
              if (cbMode === 4 || cbMode === 5) {
                next.cb2 = L; // data-ready handshake / pulse
                if (cbMode === 5) next.cb2pulse = true;
              }
              break;
            case 0x1: // ORA (handshake)
              next.ora = data;
              next.ifr &= ~(1 << F_CA1);
              if (!caIndependent) next.ifr &= ~(1 << F_CA2);
              if (caMode === 4 || caMode === 5) {
                next.ca2 = L;
                if (caMode === 5) next.ca2pulse = true;
              }
              break;
            case 0x2:
              next.ddrb = data;
              break;
            case 0x3:
              next.ddra = data;
              break;
            case 0x4: // T1C-L (low latch)
            case 0x6: // T1L-L
              next.t1l = (state.t1l & 0xff00) | data;
              break;
            case 0x5: // T1C-H: load high latch, transfer latch→counter, start
              next.t1l = (state.t1l & 0x00ff) | (data << 8);
              next.t1c = next.t1l;
              next.ifr &= ~(1 << F_T1);
              next.t1Armed = true;
              if (b(state.acr, 7) && b(state.acr, 6) === 0) next.pb7 = L; // 1-shot
              break;
            case 0x7: // T1L-H: load high latch only (no transfer)
              next.t1l = (state.t1l & 0x00ff) | (data << 8);
              next.ifr &= ~(1 << F_T1);
              break;
            case 0x8: // T2C-L (low latch)
              next.t2ll = data;
              break;
            case 0x9: // T2C-H: load high, transfer low latch, start
              next.t2c = (data << 8) | state.t2ll;
              next.ifr &= ~(1 << F_T2);
              next.t2Armed = true;
              break;
            case 0xa: // SR
              next.sr = data;
              next.ifr &= ~(1 << F_SR);
              next.srCount = 0;
              next.srActive = true;
              break;
            case 0xb:
              next.acr = data;
              break;
            case 0xc:
              next.pcr = data;
              break;
            case 0xd: // IFR: writing 1 clears a flag
              next.ifr &= ~(data & 0x7f);
              break;
            case 0xe: // IER: bit7 = set/clear the marked enables
              next.ier =
                data & 0x80
                  ? state.ier | (data & 0x7f)
                  : state.ier & ~(data & 0x7f);
              break;
            case 0xf: // ORA (no handshake): no flag clear, no CA2 handshake
              next.ora = data;
              break;
          }
        } else {
          switch (reg) {
            case 0x0: // IRB
              next.ifr &= ~(1 << F_CB1);
              if (!cbIndependent) next.ifr &= ~(1 << F_CB2);
              break;
            case 0x1: // IRA (handshake)
              next.ifr &= ~(1 << F_CA1);
              if (!caIndependent) next.ifr &= ~(1 << F_CA2);
              if (caMode === 4 || caMode === 5) {
                next.ca2 = L; // data-taken handshake / pulse
                if (caMode === 5) next.ca2pulse = true;
              }
              break;
            case 0x4: // read T1C-L clears the T1 flag
              next.ifr &= ~(1 << F_T1);
              break;
            case 0x8: // read T2C-L clears the T2 flag
              next.ifr &= ~(1 << F_T2);
              break;
            case 0xa: // read SR clears its flag, restarts the shift-in count
              next.ifr &= ~(1 << F_SR);
              next.srCount = 0;
              next.srActive = true;
              break;
            // 0xf (IRA no-handshake) and the rest have no read side effects.
          }
        }
      }

      return next;
    },

    outputs(state, ins) {
      const out = new Map();

      // Peripheral A: output lines drive ORA; input lines float.
      pa.forEach((pin, i) =>
        out.set(pin, b(state.ddra, i) ? (b(state.ora, i) ? H : L) : Z),
      );
      // Peripheral B, with two overrides: PB7 as the T1 output (ACR7), and PB6
      // as the T2 pulse-count input (ACR5 → always an input, floats).
      pb.forEach((pin, i) => {
        if (i === 7 && b(state.acr, 7)) out.set(pin, state.pb7);
        else if (i === 6 && b(state.acr, 5)) out.set(pin, Z);
        else out.set(pin, b(state.ddrb, i) ? (b(state.orb, i) ? H : L) : Z);
      });

      // Control lines.
      out.set(ca2, ca2Out(state) ?? Z);
      out.set(cb2, cb2Out(state) ?? Z);
      // CB1 drives the internal shift clock; otherwise it's an input.
      out.set(cb1, srEnabled(state) && !srExternal(state) ? state.srClk : Z);

      // Data bus during a selected read while PHI2 is high.
      const driving =
        selected(ins) && ins.get(rwb) === H && ins.get(phi2) === H;
      if (driving) {
        const value = readRegister(state, ins);
        d.forEach((pin, i) => out.set(pin, (value >> i) & 1 ? H : L));
      } else {
        for (const pin of d) out.set(pin, Z);
      }

      // IRQB: open-drain, LOW when asserted.
      out.set(irqb, irqActive(state) ? L : Z);
      return out;
    },
  };
}

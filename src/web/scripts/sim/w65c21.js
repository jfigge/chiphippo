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

// w65c21.js — the WDC W65C21 Peripheral Interface Adapter (PIA), the CMOS
// 6521/6821, as a PURE, DOM-free state machine. Like the HD44780 it is genuine
// per-part code (a register file addressed over a microprocessor bus, plus the
// CA/CB handshake + interrupt logic) that the gate/COMB/family vocabulary cannot
// express, isolated here behind the STANDARD sequential contract
// ({ state0, step, outputs }) so the engine drives it with zero part-specific
// branches. The def in catalog/chips-io.js is pure data referencing this builder.
//
// Bus interface (logic levels only — zero-delay, power-agnostic):
//   The PIA is SELECTED while CS0·CS1 are high and CS2B is low. A transfer is
//   clocked by PHI2: during a READ (RWB high) the addressed register drives
//   D0–D7 while PHI2 is high; a transfer COMMITS on PHI2's FALLING edge — a
//   write latches the data bus into the addressed register, a read applies its
//   side effects (clearing interrupt flags, stepping CA2/CB2 handshakes). This
//   mirrors the HD44780's "latch on E's falling edge" model.
//
//   Six registers select from RS1,RS0 and bit 2 of the control register
//   (Table 2, W65C21 datasheet):
//     RS1 RS0  CRx-2   Register
//      0   0     1     Peripheral (ORA/PIBA reads the pins)   — clears IRQ flags
//      0   0     0     Data Direction A (DDRA)
//      0   1     -     Control Register A (CRA)
//      1   0     1     Peripheral B (ORB/PIBB)                — clears IRQ flags
//      1   0     0     Data Direction B (DDRB)
//      1   1     -     Control Register B (CRB)
//
//   Control register (CRA/CRB, Table 1 + Table 3):
//     b7 IRQ1 flag (read-only; set by active CA1/CB1 edge; cleared by a periph read)
//     b6 IRQ2 flag (read-only; set by active CA2/CB2 edge WHEN CA2/CB2 is an input)
//     b5 CA2/CB2 direction: 0 = input, 1 = output
//     b4 } CA2/CB2 sub-mode  (input: b4 = active edge, b3 = IRQ enable;
//     b3 }                    output: b4b3 = handshake / pulse / low / high)
//     b2 DDR-access: 1 = peripheral register, 0 = data direction register
//     b1 CA1/CB1 active edge: 0 = negative (H→L), 1 = positive (L→H)
//     b0 CA1/CB1 interrupt enable
//
//   IRQAB/IRQBB are OPEN-DRAIN, active low: driven LOW when an enabled flag is
//   set, else high-impedance (Z) so an external pull-up reads HIGH and several
//   PIAs wire-OR onto one processor IRQ line.
//
// The peripheral ports PA0–PA7 / PB0–PB7 and the control lines CA2/CB2 are the
// `io` role: each is DRIVEN when the DDR / control register makes it an output,
// and floats (Z, read externally) when an input — the same bidirectional-pin
// model the 74245 transceiver uses. Reads follow the datasheet: Port A reads the
// PIN levels (PIBA), Port B reads ORB for lines programmed as outputs.

import { H, L, X, Z } from "./levels.js";

/** One clean bit from an asInput'd level (H → 1; L/X → 0 — a float reads H). */
const bit = (lv) => (lv === H ? 1 : 0);
const high = (lv) => lv === H;
const b = (v, n) => (v >> n) & 1;

/** A bus line read against the level it must stand at: H when it does, L
    when it is at the other, X when unknown. */
const asked = (lv, want) => (lv === want ? H : lv === H || lv === L ? L : X);
/** All of them: L if any is L, else X if any is unknown, else H. */
const every = (...ts) => (ts.includes(L) ? L : ts.includes(X) ? X : H);
const rose = (p, c) => p === L && c === H;
const fell = (p, c) => p === H && c === L;

/** A control-line edge is "active" per its edge-select bit (1 = positive). */
const activeEdge = (edgeSelHigh, prev, cur) =>
  edgeSelHigh ? rose(prev, cur) : fell(prev, cur);

/**
 * Which of the six registers RS1,RS0 (+ the DDR-access bit of the relevant
 * control register) addresses. Returns a stable string key.
 */
function registerAt(rs1, rs0, cra, crb) {
  if (rs1 === 0 && rs0 === 0) return b(cra, 2) ? "pra" : "ddra";
  if (rs1 === 0 && rs0 === 1) return "cra";
  if (rs1 === 1 && rs0 === 0) return b(crb, 2) ? "prb" : "ddrb";
  return "crb"; // 1,1
}

/**
 * The W65C21 PIA behavior as a sequential unit.
 * @param {object} pins - catalog pin numbers.
 * @param {number[]} pins.pa  - [PA0…PA7]
 * @param {number[]} pins.pb  - [PB0…PB7]
 * @param {number[]} pins.d   - [D0…D7]
 * @param {number} pins.ca1 @param {number} pins.ca2
 * @param {number} pins.cb1 @param {number} pins.cb2
 * @param {number} pins.rs0 @param {number} pins.rs1
 * @param {number} pins.cs0 @param {number} pins.cs1 @param {number} pins.cs2b
 * @param {number} pins.rwb @param {number} pins.phi2 @param {number} pins.resb
 * @param {number} pins.irqab @param {number} pins.irqbb
 * @returns {{ state0: Function, step: Function, outputs: Function }}
 */
export function w65c21Unit(pins) {
  const {
    pa,
    pb,
    d,
    ca1,
    ca2,
    cb1,
    cb2,
    rs0,
    rs1,
    cs0,
    cs1,
    cs2b,
    rwb,
    phi2,
    resb,
    irqab,
    irqbb,
  } = pins;

  const selected = (ins) =>
    high(ins.get(cs0)) && high(ins.get(cs1)) && !high(ins.get(cs2b));

  /** Read the 8-bit value on the data bus into an integer (LSB = D0). */
  const readData = (ins) =>
    d.reduce((n, pin, i) => n | (bit(ins.get(pin)) << i), 0);

  /** Port A read: the actual PIN levels (PIBA), every bit. */
  const readPortA = (ins) =>
    pa.reduce((n, pin, i) => n | (bit(ins.get(pin)) << i), 0);

  /** Port B read: ORB for output lines, the PIN level for input lines. */
  const readPortB = (s, ins) =>
    pb.reduce((n, pin, i) => {
      const out = b(s.ddrb, i) ? b(s.orb, i) : bit(ins.get(pin));
      return n | (out << i);
    }, 0);

  /** The value the addressed register presents on a read. */
  const readRegister = (s, ins) => {
    switch (registerAt(bit(ins.get(rs1)), bit(ins.get(rs0)), s.cra, s.crb)) {
      case "pra":
        return readPortA(ins);
      case "ddra":
        return s.ddra;
      case "cra":
        return s.cra;
      case "prb":
        return readPortB(s, ins);
      case "ddrb":
        return s.ddrb;
      default:
        return s.crb; // crb
    }
  };

  /** IRQ (open-drain) asserted for a side: flag·enable on CA1/CB1 OR CA2/CB2. */
  const irqAsserted = (cr) =>
    (b(cr, 7) && b(cr, 0)) || (b(cr, 6) && b(cr, 3) && !b(cr, 5));

  /** The CA2/CB2 output level, or null when the line is an input (floats). */
  const controlOut = (cr, held) => {
    if (!b(cr, 5)) return null; // input mode → high-impedance
    if (b(cr, 4)) return b(cr, 3) ? H : L; // manual: level = bit 3
    return held; // handshake / pulse: the tracked level
  };

  return {
    state0() {
      // Reset (RESB low) clears every register and floats every peripheral line
      // (DDR = 0 → input). CA2/CB2 handshake outputs idle HIGH.
      return {
        ora: 0,
        orb: 0,
        ddra: 0,
        ddrb: 0,
        cra: 0,
        crb: 0,
        ca2: H, // CA2 handshake/pulse output level
        cb2: H, // CB2 handshake/pulse output level
        ca2pulse: false, // a pulse-mode low is active, restore next cycle
        cb2pulse: false,
        cb2arm: false, // a Port B write: CB2 goes low at the next PHI2 rise
        cb2restore: false, // a deselected E pulse seen: high at the next rise
      };
    },

    step(state, ins, prev) {
      if (ins.get(resb) === L) return this.state0(); // async reset

      const next = { ...state };
      const p = prev ?? new Map();
      const was = (pin) => (prev ? p.get(pin) : undefined);

      // ── Interrupt-input edges (asynchronous to PHI2) ───────────────────────
      // CA1: sets CRA bit 7. An active CA1 edge also raises a CA2 handshake.
      if (prev && activeEdge(b(state.cra, 1), was(ca1), ins.get(ca1))) {
        next.cra |= 0x80;
        if (b(state.cra, 5) && !b(state.cra, 4)) next.ca2 = H; // handshake return
      }
      // CB1: sets CRB bit 7, raises a CB2 handshake.
      if (prev && activeEdge(b(state.crb, 1), was(cb1), ins.get(cb1))) {
        next.crb |= 0x80;
        if (b(state.crb, 5) && !b(state.crb, 4)) next.cb2 = H;
      }
      // CA2 / CB2 as inputs (bit 5 = 0): an active edge sets bit 6.
      if (
        !b(state.cra, 5) &&
        prev &&
        activeEdge(b(state.cra, 4), was(ca2), ins.get(ca2))
      ) {
        next.cra |= 0x40;
      }
      if (
        !b(state.crb, 5) &&
        prev &&
        activeEdge(b(state.crb, 4), was(cb2), ins.get(cb2))
      ) {
        next.crb |= 0x40;
      }

      // A CA2/CB2 strobe keeps the 6821's edges, which the W65C21 keeps.
      // CA2 (the READ strobe) runs on E's FALL: low on the fall that reads
      // PRA, high on the first fall the chip is DESELECTED for — a chip still
      // selected (the 65C02's read-modify-write reading PRA twice) holds it
      // low. CB2 (the WRITE strobe) runs on E's RISE: low on the rise after
      // the write to PRB, high on the rise after an E pulse during which the
      // chip was deselected. (Unlike the VIA's one-cycle pulse, which restores
      // on the next fall whatever is selected.)
      const phi2Fell = prev && fell(was(phi2), ins.get(phi2));
      const phi2Rose = prev && rose(was(phi2), ins.get(phi2));
      const deselectFall = phi2Fell && !selected(ins);
      if (deselectFall && state.ca2pulse) {
        next.ca2 = H;
        next.ca2pulse = false;
      }
      if (phi2Rose && state.cb2arm) {
        next.cb2 = L;
        next.cb2arm = false;
      } else if (phi2Rose && state.cb2restore) {
        next.cb2 = H;
        next.cb2pulse = false;
        next.cb2restore = false;
      }
      if (deselectFall && state.cb2pulse && !state.cb2arm) {
        next.cb2restore = true;
      }

      // ── Bus transaction: commit on PHI2's falling edge while selected ───────
      if (phi2Fell && selected(ins)) {
        const reg = registerAt(
          bit(ins.get(rs1)),
          bit(ins.get(rs0)),
          state.cra,
          state.crb,
        );
        if (ins.get(rwb) === L) {
          // WRITE: latch the data bus into the addressed register.
          const data = readData(ins);
          if (reg === "pra") next.ora = data;
          else if (reg === "ddra") next.ddra = data;
          // (IRQx2, bit 6, reads 0 while CA2/CB2 is an output — bit 5 —
          // and so is cleared by the write that makes it one.)
          else if (reg === "cra") next.cra = (state.cra & (data & 0x20 ? 0x80 : 0xc0)) | (data & 0x3f); // prettier-ignore
          else if (reg === "prb") {
            next.orb = data;
            // A write to Peripheral B raises the CB2 handshake / pulse —
            // low at the NEXT rise of PHI2 (`cb2arm`).
            if (b(state.crb, 5) && !b(state.crb, 4)) {
              next.cb2arm = true;
              next.cb2restore = false;
              if (b(state.crb, 3)) next.cb2pulse = true; // pulse mode
            }
          } else if (reg === "ddrb") next.ddrb = data;
          else if (reg === "crb") next.crb = (state.crb & (data & 0x20 ? 0x80 : 0xc0)) | (data & 0x3f); // prettier-ignore
        } else {
          // READ side effects: reading a peripheral register clears its flags
          // and (Port A) lowers the CA2 handshake / pulse.
          if (reg === "pra") {
            next.cra &= 0x3f; // clear IRQA1 / IRQA2
            if (b(state.cra, 5) && !b(state.cra, 4)) {
              next.ca2 = L;
              if (b(state.cra, 3)) next.ca2pulse = true; // pulse mode
            }
          } else if (reg === "prb") {
            next.crb &= 0x3f; // clear IRQB1 / IRQB2
          }
        }
      }

      return next;
    },

    outputs(state, ins) {
      const out = new Map();

      // Peripheral ports: an output line drives its OR-register bit; an input
      // line floats (Z) so the external level is read back.
      pa.forEach((pin, i) =>
        out.set(pin, b(state.ddra, i) ? (b(state.ora, i) ? H : L) : Z),
      );
      pb.forEach((pin, i) =>
        out.set(pin, b(state.ddrb, i) ? (b(state.orb, i) ? H : L) : Z),
      );

      // CA2 / CB2 output lines.
      const ca2out = controlOut(state.cra, state.ca2);
      const cb2out = controlOut(state.crb, state.cb2);
      out.set(ca2, ca2out ?? Z);
      out.set(cb2, cb2out ?? Z);

      // Data bus: driven with the addressed register only during a selected
      // read while PHI2 is high; otherwise high-impedance.
      // A select, R/W̄ or PHI2 unknown that could make it one drives X
      // (the regrade, 2026-10-26: read as deselected, the CPU took $FF).
      const driving = every(
        asked(ins.get(cs0), H),
        asked(ins.get(cs1), H),
        asked(ins.get(cs2b), L),
        asked(ins.get(rwb), H),
        asked(ins.get(phi2), H),
      );
      if (driving === H) {
        const value = readRegister(state, ins);
        d.forEach((pin, i) => out.set(pin, (value >> i) & 1 ? H : L));
      } else {
        for (const pin of d) out.set(pin, driving === X ? X : Z);
      }

      // Interrupt requests: open-drain — LOW when asserted, else floating.
      out.set(irqab, irqAsserted(state.cra) ? L : Z);
      out.set(irqbb, irqAsserted(state.crb) ? L : Z);
      return out;
    },
  };
}

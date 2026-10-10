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

// hd44780.js — the Hitachi HD44780 character-LCD controller as a PURE,
// DOM-free state machine. It is genuine per-part code (an instruction decoder +
// address counter + display/entry state that the gate/COMB/family vocabulary
// cannot express), isolated here behind the STANDARD sequential contract
// ({ state0, step, outputs }) so the engine (chip-eval.js / engine.js) drives it
// with zero part-specific branches — exactly as a chip def references
// shiftRegister595. The def in catalog/parts.js is pure data referencing this
// builder.
//
// Interface (logic levels only — no wall-clock timing, no analog):
//   RS  0 = instruction, 1 = data          RW 0 = write, 1 = read
//   E   the strobe: a WRITE latches on E's FALLING edge; a READ presents data
//       while E is HIGH (level-sensitive), and its address counter advances on
//       the falling edge. Zero-delay ⇒ the busy flag (DB7 on a status read) is
//       ALWAYS 0 (ready); instruction "execution time" is instantaneous.
//   DB0–DB7  the bus (8-bit), or DB4–DB7 in 4-bit mode (two E pulses per byte).
//
// DDRAM/CGRAM live in run-volatile sequential STATE (reset on Run), never in the
// document. `framebufferOf(state, params)` derives the visible character grid +
// cursor for the view — the only "display output"; the font (CGROM) is the
// view's concern, so this module emits character CODES, not pixels.

import { H, L, Z } from "./levels.js";

/** DDRAM is addressed by the 7-bit AC (0x00–0x7F); a flat 128-byte array indexes
    directly by address. Real storage is 80 bytes — 0x00–0x4F in 1-line mode,
    0x00–0x27 and 0x40–0x67 in 2-line mode — and the AC wraps WITHIN them
    (`stepAc`): 0x27 runs on to 0x40 and 0x67 back to 0x00, so text written
    past a line's 40th byte continues on the next line. */
const DDRAM_SIZE = 128;
const CGRAM_SIZE = 64; // 8 custom glyphs × 8 rows (low 5 bits used)
const SPACE = 0x20;

/** Visible-line DDRAM start addresses per module size (the classic mapping). */
const LINE_STARTS = Object.freeze({
  "16x2": [0x00, 0x40],
  "20x4": [0x00, 0x40, 0x14, 0x54],
});

/** One bit from an asInput'd level (H → 1; L/X → 0 — a floating bus reads H). */
const bit = (level) => (level === H ? 1 : 0);

/** The full 8-bit value on DB0–DB7. */
function readBus(ins, db) {
  let v = 0;
  for (let i = 0; i < 8; i++) v |= bit(ins.get(db[i])) << i;
  return v & 0xff;
}

/** The 4-bit nibble on DB4–DB7 (DB4 = bit 0 … DB7 = bit 3). */
function readNibble(ins, db) {
  let v = 0;
  for (let i = 0; i < 4; i++) v |= bit(ins.get(db[4 + i])) << i;
  return v & 0x0f;
}

/** The address counter one step up or down within the RAM it addresses — in
    2-line DDRAM across the gap between the lines' 40-byte banks. */
function stepAc(ac, up, target, twoLine) {
  if (target === "cgram") return (ac + (up ? 1 : -1) + CGRAM_SIZE) % CGRAM_SIZE;
  if (!twoLine) {
    if (ac >= 0x50) return (ac + (up ? 1 : -1)) & 0x7f; // outside the RAM
    return (ac + (up ? 1 : -1) + 0x50) % 0x50;
  }
  if (up) {
    if (ac === 0x27) return 0x40;
    if (ac === 0x67) return 0x00;
    return (ac + 1) & 0x7f;
  }
  if (ac === 0x40) return 0x27;
  if (ac === 0x00) return 0x67;
  return (ac + 0x7f) & 0x7f;
}

/** Advance the address counter by the entry mode's step. */
function advanceAc(next) {
  next.ac = stepAc(next.ac, next.id, next.target, next.twoLine);
}

/** Apply an instruction byte (RS=0, RW=0), decoding by the highest set bit. */
function applyInstruction(next, state, byte) {
  if (byte & 0x80) {
    next.target = "ddram";
    next.ac = byte & 0x7f;
  } else if (byte & 0x40) {
    next.target = "cgram";
    next.ac = byte & 0x3f;
  } else if (byte & 0x20) {
    // Function set: DL (bus width), N (lines), F (font).
    next.dataLen8 = Boolean(byte & 0x10);
    next.twoLine = Boolean(byte & 0x08);
    next.font5x10 = Boolean(byte & 0x04);
    next.nibblePhase = 0;
    next.highNibble = 0;
  } else if (byte & 0x10) {
    // Cursor / display shift: S/C (bit 3), R/L (bit 2).
    const right = Boolean(byte & 0x04);
    if (byte & 0x08) {
      // Shifting the DISPLAY right reveals LOWER addresses, so shiftOffset must
      // DECREASE (+39 ≡ −1) — the opposite sign from the cursor-move branch
      // below, and matching the entry-mode auto-shift (increment → left → +1).
      next.shiftOffset = (state.shiftOffset + (right ? 39 : 1)) % 40;
    } else {
      next.ac = stepAc(state.ac, right, state.target, state.twoLine);
    }
  } else if (byte & 0x08) {
    // Display on/off: D (display), C (cursor), B (blink).
    next.displayOn = Boolean(byte & 0x04);
    next.cursorOn = Boolean(byte & 0x02);
    next.blinkOn = Boolean(byte & 0x01);
  } else if (byte & 0x04) {
    // Entry mode: I/D (increment), S (shift-on-write).
    next.id = Boolean(byte & 0x02);
    next.shiftEntry = Boolean(byte & 0x01);
  } else if (byte & 0x02) {
    // Return home: AC → 0, un-shift; DDRAM untouched.
    next.ac = 0;
    next.target = "ddram";
    next.shiftOffset = 0;
  } else if (byte & 0x01) {
    // Clear: DDRAM → spaces, AC → 0, un-shift, entry increment (per datasheet).
    next.ddram = new Uint8Array(state.ddram.length).fill(SPACE);
    next.ac = 0;
    next.target = "ddram";
    next.shiftOffset = 0;
    next.id = true;
  }
  // byte === 0x00 → no defined instruction (NOP).
}

/** Write a data byte (RS=1, RW=0) to the addressed RAM, then advance AC. */
function writeData(next, state, byte) {
  if (state.target === "cgram") {
    next.cgram = new Uint8Array(state.cgram);
    next.cgram[state.ac & 0x3f] = byte & 0xff;
  } else {
    next.ddram = new Uint8Array(state.ddram);
    next.ddram[state.ac & 0x7f] = byte & 0xff;
    // Entry-mode S shifts the whole display on each write (rarely used).
    if (state.shiftEntry) {
      next.shiftOffset = (state.shiftOffset + (state.id ? 1 : 39)) % 40;
    }
  }
  advanceAc(next);
}

/** Commit one fully-assembled bus transaction on the E falling edge. */
function commit(next, state, rsHigh, rwHigh, byte) {
  if (rwHigh) {
    // READ: the value was presented in `outputs` while E was high; a DATA read
    // auto-increments AC. A status read (RS=0) leaves AC alone.
    if (rsHigh) advanceAc(next);
  } else if (rsHigh) {
    writeData(next, state, byte);
  } else {
    applyInstruction(next, state, byte);
  }
}

/**
 * The HD44780 behavior as a sequential unit.
 * @param {object} pins - catalog pin numbers.
 * @param {number} pins.rs
 * @param {number} pins.rw
 * @param {number} pins.e
 * @param {number[]} pins.db - [DB0 … DB7].
 * @returns {{ state0: Function, step: Function, outputs: Function }}
 */
export function hd44780Unit({ rs, rw, e, db }) {
  if (!Array.isArray(db) || db.length !== 8) {
    throw new Error("hd44780Unit: db must be [DB0..DB7]");
  }

  /** The value a read presents: status (RS=0 → busy=0 + AC) or the RAM byte. */
  const readValue = (state, rsHigh) => {
    if (!rsHigh) return state.ac & 0x7f; // DB7 = 0 → never busy
    return state.target === "cgram"
      ? state.cgram[state.ac & 0x3f]
      : state.ddram[state.ac & 0x7f];
  };

  return {
    state0() {
      return {
        ddram: new Uint8Array(DDRAM_SIZE).fill(SPACE),
        cgram: new Uint8Array(CGRAM_SIZE),
        ac: 0,
        target: "ddram", // which RAM the AC currently indexes
        id: true, // entry: increment (true) / decrement
        shiftEntry: false, // entry: shift display on write (S)
        displayOn: false,
        cursorOn: false,
        blinkOn: false,
        twoLine: false, // function set N
        font5x10: false, // function set F
        dataLen8: true, // function set DL (8-bit vs 4-bit)
        shiftOffset: 0, // display-shift window origin (0..39)
        nibblePhase: 0, // 4-bit assembly: 0 = high nibble expected, 1 = low
        highNibble: 0,
      };
    },

    step(state, ins, prev) {
      // All state changes happen on E's FALLING edge (write latch / read AC
      // advance / nibble assembly). Off-edge is identity — cheap warm-start.
      const eNow = ins.get(e);
      const ePrev = prev ? prev.get(e) : undefined;
      if (!(ePrev === H && eNow === L)) return state;

      const next = { ...state };
      const rsHigh = ins.get(rs) === H;
      const rwHigh = ins.get(rw) === H;

      if (state.dataLen8) {
        commit(next, state, rsHigh, rwHigh, readBus(ins, db));
      } else if (state.nibblePhase === 0) {
        // First of two 4-bit transfers: capture the high nibble, wait for more.
        next.nibblePhase = 1;
        next.highNibble = readNibble(ins, db);
      } else {
        next.nibblePhase = 0;
        const byte = ((state.highNibble << 4) | readNibble(ins, db)) & 0xff;
        commit(next, state, rsHigh, rwHigh, byte);
      }
      return next;
    },

    outputs(state, ins) {
      const out = new Map();
      const reading = ins.get(rw) === H && ins.get(e) === H;
      if (!reading) {
        // Not driving — float the bus so an external writer owns it.
        for (const pin of db) out.set(pin, Z);
        return out;
      }
      const value = readValue(state, ins.get(rs) === H);
      if (state.dataLen8) {
        for (let i = 0; i < 8; i++) {
          out.set(db[i], (value >> i) & 1 ? H : L);
        }
      } else {
        // 4-bit: drive DB4–DB7 with the current nibble; float DB0–DB3.
        const nib =
          state.nibblePhase === 0 ? (value >> 4) & 0x0f : value & 0x0f;
        for (let i = 0; i < 4; i++) {
          out.set(db[i], Z);
          out.set(db[4 + i], (nib >> i) & 1 ? H : L);
        }
      }
      return out;
    },
  };
}

/**
 * Derive the visible character grid + cursor from the controller state — the
 * LCD's "display output". Emits character CODES (the view resolves the font);
 * `cgram` is passed through so the view can render custom glyphs (codes 0x00–
 * 0x0F). Pure.
 * @param {object} state - an hd44780Unit state (or undefined → blank).
 * @param {{cols?: number, rows?: number}} grid - the module's character grid,
 *   i.e. its def's `characterDisplay`. A grid with no line mapping falls back
 *   to the 16×2 one rather than failing: the DDRAM layout is the controller's,
 *   and every panel it drives is one of these two shapes.
 * @returns {{cols:number, rows:number, chars:Uint8Array, cgram:Uint8Array,
 *   cursor:{row:number,col:number,on:boolean,blink:boolean}, displayOn:boolean}}
 */
export function framebufferOf(state, grid) {
  const cols = grid?.cols ?? 16;
  const rows = grid?.rows ?? 2;
  const starts = LINE_STARTS[`${cols}x${rows}`] ?? LINE_STARTS["16x2"];
  const chars = new Uint8Array(cols * rows);

  if (!state) {
    return {
      cols,
      rows,
      chars,
      cgram: new Uint8Array(CGRAM_SIZE),
      cursor: { row: 0, col: 0, on: false, blink: false },
      displayOn: false,
    };
  }

  // Each panel row is a window on one of the two 40-byte line banks (0x00,
  // 0x40), and a display shift turns the bank as a RING: a 20×4's third row is
  // the first bank's second half, so it shows (20 + c + shift) % 40 of it.
  const bankOf = (addr) => addr & 0x40;
  const ringOf = (addr) => addr & 0x3f;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const at = (ringOf(starts[r]) + c + state.shiftOffset) % 40;
      chars[r * cols + c] = state.ddram[bankOf(starts[r]) | at];
    }
  }

  // Cursor: the first visible row whose bank holds the AC, mapped back
  // through the display shift to a visible column.
  let cursor = { row: 0, col: 0, on: false, blink: false };
  for (let r = 0; r < rows; r++) {
    if (bankOf(state.ac) !== bankOf(starts[r]) || ringOf(state.ac) >= 40) continue; // prettier-ignore
    const d = ringOf(state.ac) - ringOf(starts[r]);
    const col = (((d - state.shiftOffset) % 40) + 40) % 40;
    if (col < cols) {
      cursor = {
        row: r,
        col,
        on: state.cursorOn,
        blink: state.blinkOn,
      };
      break;
    }
  }

  return {
    cols,
    rows,
    chars,
    cgram: state.cgram,
    cursor,
    displayOn: state.displayOn,
  };
}

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
    directly by address (real storage is 80 bytes across non-contiguous ranges —
    0x00–0x27 / 0x40–0x67 — but direct indexing is simpler and equivalent). */
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

/** Advance the address counter by ±1 within its RAM's modulus. */
function advanceAc(next) {
  const delta = next.id ? 1 : -1;
  const mod = next.target === "cgram" ? CGRAM_SIZE : 0x80;
  next.ac = (next.ac + delta + mod) % mod;
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
      next.shiftOffset = (state.shiftOffset + (right ? 1 : 39)) % 40;
    } else {
      next.ac = (state.ac + (right ? 1 : 0x7f)) & 0x7f;
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
 * @param {{size?: string}} params
 * @returns {{cols:number, rows:number, chars:Uint8Array, cgram:Uint8Array,
 *   cursor:{row:number,col:number,on:boolean,blink:boolean}, displayOn:boolean}}
 */
export function framebufferOf(state, params) {
  const size = params?.size === "20x4" ? "20x4" : "16x2";
  const cols = size === "20x4" ? 20 : 16;
  const rows = size === "20x4" ? 4 : 2;
  const starts = LINE_STARTS[size];
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

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const addr = (starts[r] + ((c + state.shiftOffset) % 40)) & 0x7f;
      chars[r * cols + c] = state.ddram[addr];
    }
  }

  // Cursor: the first visible line whose 40-address span holds the AC, mapped
  // back through the display shift to a visible column.
  let cursor = { row: 0, col: 0, on: false, blink: false };
  for (let r = 0; r < rows; r++) {
    const d = state.ac - starts[r];
    if (d < 0 || d >= 40) continue;
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

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

// terminal-screen.js — what the Terminal window shows (Feature 420): a GLASS
// TTY, the simplest terminal there is. Pure and DOM-free.
//
// Bytes arrive and are written where the cursor is; the cursor only ever moves
// along the last line or down to a new one, so the screen is a list of lines
// whose last is being written, scrolled back to SCROLLBACK lines.
//
//   printable (0x20–0x7E)  written at the cursor, which moves right; past the
//                          last column the line wraps
//   CR                     back to column 0 — and, with "CR as CR LF" (an
//                          Apple-1 monitor's habit), down a line too
//   LF                     down a line, the column kept
//   BS                     back one column (nothing erased, as on a VT100)
//   TAB                    to the next multiple of 8
//   BEL                    counted (`bells`): the window flashes
//   FF                     clears the screen
//   DEL, NUL               ignored
//   any other control      shown as ^X, so a stray byte is seen, not lost
//
// A byte with bit 7 set is shown as its low seven bits: a 7-bit terminal's
// habit, and the Apple-1 monitor's characters all carry it. A frame that
// arrived broken — a framing or parity error, a break — shows as ▒.
//
// VT100/ANSI escape sequences are NOT interpreted (ESC shows as ^[).

/** Lines kept above the one being written. */
export const SCROLLBACK = 2000;

/** What a broken frame shows as. */
export const BAD_FRAME = "▒";

const TAB = 8;

export class TerminalScreen {
  /** @type {string[]} */
  lines = [""];
  /** The cursor's column on the last line. */
  col = 0;
  /** BELs received since the screen was made. */
  bells = 0;
  /** The first line changed since `takeDirty` last asked; null for none.
      A scroll past SCROLLBACK makes it 0 (every line moved up). */
  #dirtyFrom = 0;
  #columns;
  #crlf;

  /**
   * @param {{columns?: number, crAsCrLf?: boolean}} [opts]
   */
  constructor({ columns = 80, crAsCrLf = false } = {}) {
    this.#columns = columns;
    this.#crlf = crAsCrLf;
  }

  /** How the screen reads CRs and how wide it is — a settings change. */
  configure({ columns = this.#columns, crAsCrLf = this.#crlf } = {}) {
    this.#columns = columns;
    this.#crlf = crAsCrLf;
  }

  get columns() {
    return this.#columns;
  }

  /** Blank the screen, scrollback and all. */
  clear() {
    this.lines = [""];
    this.col = 0;
    this.#dirtyFrom = 0;
  }

  /**
   * Write what arrived: bytes, or received frames
   * (`{byte, framingError, parityError, brk}`).
   * @param {Iterable<number | {byte: number, framingError?: boolean,
   *   parityError?: boolean, brk?: boolean}>} input
   */
  write(input) {
    for (const item of input) {
      if (typeof item === "number") this.#byte(item);
      else if (item.framingError || item.parityError || item.brk)
        this.#put(BAD_FRAME); // prettier-ignore
      else this.#byte(item.byte);
    }
  }

  /** The text of every line, scrollback first. */
  text() {
    return this.lines.join("\n");
  }

  /** The first line changed since the last call (and so to redraw from),
      or null when none has. */
  takeDirty() {
    const from = this.#dirtyFrom;
    this.#dirtyFrom = null;
    return from;
  }

  #touch(row) {
    if (this.#dirtyFrom == null || row < this.#dirtyFrom) this.#dirtyFrom = row;
  }

  #byte(raw) {
    const b = raw & 0x7f;
    if (b >= 0x20 && b < 0x7f) return this.#put(String.fromCharCode(b));
    switch (b) {
      case 0x0d:
        this.col = 0;
        if (this.#crlf) this.#newline();
        return;
      case 0x0a:
        return this.#newline();
      case 0x08:
        this.col = Math.max(0, this.col - 1);
        return;
      case 0x09:
        this.col = Math.min(this.#columns - 1, (Math.floor(this.col / TAB) + 1) * TAB); // prettier-ignore
        return;
      case 0x07:
        this.bells++;
        return;
      case 0x0c:
        return this.clear();
      case 0x00:
      case 0x7f:
        return;
      default:
        // ^@ … ^_ : the control's letter, as a terminal's "show controls".
        this.#put("^");
        this.#put(String.fromCharCode(b + 0x40));
    }
  }

  #put(ch) {
    if (this.col >= this.#columns) {
      // Wrap: the cursor goes to the start of a new line, as a glass TTY's
      // does, and keeps no column to come back to.
      this.#newline();
      this.col = 0;
    }
    const row = this.lines.length - 1;
    const line = this.lines[row];
    const padded = line.length < this.col ? line.padEnd(this.col) : line;
    this.lines[row] = padded.slice(0, this.col) + ch + padded.slice(this.col + 1); // prettier-ignore
    this.col++;
    this.#touch(row);
  }

  #newline() {
    this.lines.push("");
    if (this.lines.length > SCROLLBACK + 1) {
      this.lines.splice(0, this.lines.length - SCROLLBACK - 1);
      this.#dirtyFrom = 0;
    }
    this.#touch(this.lines.length - 1);
  }
}

/**
 * The bytes a key sends, by the adapter's settings — null for a key that
 * sends nothing. Printable characters are their code (anything past 0x7E is
 * not sent: the line carries ASCII); Enter and Backspace follow the settings;
 * Ctrl+letter is the control code (Ctrl+C is 0x03).
 * @param {{key: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean}} e
 * @param {{enter: string, backspace: string}} settings
 * @returns {number[] | null}
 */
export function keyBytes(e, settings) {
  if (e.metaKey) return null;
  if (e.ctrlKey && !e.altKey && e.key.length === 1) {
    const c = e.key.toUpperCase().charCodeAt(0);
    if (c >= 0x40 && c <= 0x5f) return [c - 0x40];
    return null;
  }
  switch (e.key) {
    case "Enter":
      return settings.enter === "lf" ? [0x0a] : settings.enter === "crlf" ? [0x0d, 0x0a] : [0x0d]; // prettier-ignore
    case "Backspace":
      return [settings.backspace === "del" ? 0x7f : 0x08];
    case "Tab":
      return [0x09];
    case "Escape":
      return [0x1b];
    default:
      break;
  }
  if (e.key.length !== 1 || e.altKey) return null;
  return textBytes(e.key);
}

/**
 * Text (a paste) as the bytes a terminal sends: ASCII as is, every newline
 * (CR LF, CR or LF) as the Enter key's bytes, anything past ASCII left out.
 * @param {string} text
 * @param {{enter?: string}} [settings]
 * @returns {number[]}
 */
export function textBytes(text, settings = {}) {
  const enter = settings.enter === "lf" ? [0x0a] : settings.enter === "crlf" ? [0x0d, 0x0a] : [0x0d]; // prettier-ignore
  const out = [];
  const lines = text.split(/\r\n|\r|\n/);
  lines.forEach((line, i) => {
    if (i) out.push(...enter);
    for (const ch of line) {
      const c = ch.codePointAt(0);
      if (c === 0x09 || (c >= 0x20 && c < 0x7f)) out.push(c);
    }
  });
  return out;
}

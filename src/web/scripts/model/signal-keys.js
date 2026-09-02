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

// signal-keys.js — the 1–8 held set that drives the signal buttons from the
// keyboard (Feature 370). Pure and DOM-free: it takes plain event-shaped
// objects, so the whole thing is testable under `node --test`.
//
// WHY BARE DIGITS, AND ONLY WHILE RUNNING. Several signals must be
// assertable at once — that is the feature's whole reason for existing, and one
// mouse can only hold one button. A bare digit is the only thing a hand can
// hold three of. It is free because the ONLY other claim on 1–9 is the wire
// tool's colour and the bus tool's width (desk-controller.js), and Run disarms
// both tools — so the two meanings can never be live at the same moment.
//
// THE HELD SET IS A MAP, NOT A SET, and that is the load-bearing detail: it
// remembers WHICH SIGNAL each digit pressed, so a release always reaches the
// signal that was pressed even if the rail changed underneath (a signal deleted
// mid-hold would otherwise renumber the digits and strand the first one down
// for good). A stuck signal is far worse than a missed press, which is also why
// keyup is never gated on anything.

import { SIGNAL_DIGITS, signalForDigit } from "./signals.js";

/**
 * The digits that name a signal, DERIVED from how many there can be — so
 * dropping a colour (black went, taking the eighth signal with it) narrows
 * the shortcut in the same move, and a key that can never reach a button is
 * never swallowed from whatever else might want it.
 */
const DIGIT_RE = new RegExp(`^[1-${SIGNAL_DIGITS}]$`);

/** Is this a bare digit keydown — no modifier, no auto-repeat? */
function digitOf(e) {
  if (!e || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  // Matched on `e.key`, as the wire-colour and bus-width digits are: the two
  // sets of digit shortcuts must mean the same keystroke. (Shift is excluded
  // rather than ignored — "!" is not "1" on every layout, and Shift belongs to
  // the marquee.)
  return DIGIT_RE.test(e.key) ? Number(e.key) : null;
}

/**
 * @param {object} opts
 * @param {() => boolean} opts.isRunning is the simulation live?
 * @param {() => Array} opts.signalsOf the desk's signals, in rail order
 * @param {(id: string, on: boolean) => void} opts.press
 */
export function createSignalKeys({ isRunning, signalsOf, press }) {
  /** digit → the signal id that digit is currently holding down. */
  const held = new Map();

  const release = (digit) => {
    const id = held.get(digit);
    if (id == null) return false;
    held.delete(digit);
    press(id, false);
    return true;
  };

  return {
    /** @returns {boolean} did this consume the key? */
    handleKeyDown(e) {
      const digit = digitOf(e);
      if (digit == null) return false;
      if (!isRunning()) return false; // stopped: 1–8 are the tools' to claim
      // Auto-repeat must never re-fire a toggle or re-press a held button —
      // but it IS our key, so swallow it rather than letting it fall through.
      if (e.repeat) return true;
      if (held.has(digit)) return true;
      const sig = signalForDigit(signalsOf(), digit);
      if (!sig) return false; // no button there — not ours to swallow
      held.set(digit, sig.id);
      press(sig.id, true);
      return true;
    },

    /**
     * @returns {boolean} did this release something?
     *
     * Deliberately gated on NOTHING — not the run state, not a dialog, not the
     * typing guard. A key that went down on the desk and comes up somewhere
     * else still has to come up.
     */
    handleKeyUp(e) {
      if (!e || !DIGIT_RE.test(e.key)) return false;
      // Modifiers are NOT checked here either: press ⌘ after the digit and the
      // keyup arrives with metaKey set, which must still release it.
      return release(Number(e.key));
    },

    /** Let go of everything — window blur, or the transport stopping. */
    releaseAll() {
      for (const digit of [...held.keys()]) release(digit);
    },

    /** The digits currently down, for tests. */
    get heldDigits() {
      return [...held.keys()].sort((a, b) => a - b);
    },
  };
}

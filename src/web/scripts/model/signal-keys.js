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

// signal-keys.js — the held set of digit keys (1–9, then 0) that drives the
// signal buttons from the keyboard (Feature 370). Pure and DOM-free: it takes
// plain event-shaped objects, so the whole thing is testable under
// `node --test`.
//
// WHY BARE DIGITS, AND ONLY WHILE RUNNING. Several signals must be
// assertable at once — that is the feature's whole reason for existing, and one
// mouse can only hold one button. A bare digit is the only thing a hand can
// hold three of. It is free because the ONLY other claim on 1–9 is the wire
// tool's colour and the bus tool's width (desk-controller.js), and Run disarms
// both tools — so the two meanings can never be live at the same moment. Bare
// 0 has no other claim at all.
//
// THE HELD SET IS A MAP, NOT A SET, and that is the load-bearing detail: it
// remembers WHICH SIGNAL each key pressed, so a release always reaches the
// signal that was pressed even if the rail changed underneath (a signal deleted
// mid-hold would otherwise renumber the digits and strand the first one down
// for good). A stuck signal is far worse than a missed press, which is also why
// keyup is never gated on anything.

import { SIGNAL_KEYS, signalForKey } from "./signals.js";

/** Is this one of the signal keys? Matched on `e.key`, as the wire-colour and
    bus-width digits are: the two sets of digit shortcuts must mean the same
    keystroke. */
const isSignalKey = (key) => SIGNAL_KEYS.includes(key);

/** The signal key of a bare keydown — no modifier — or null. */
function keyOf(e) {
  if (!e || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  // Shift is excluded rather than ignored — "!" is not "1" on every layout,
  // and Shift belongs to the marquee.
  return isSignalKey(e.key) ? e.key : null;
}

/**
 * @param {object} opts
 * @param {() => boolean} opts.isRunning is the simulation live?
 * @param {() => Array} opts.signalsOf the desk's signals, in rail order
 * @param {(id: string, on: boolean) => void} opts.press
 */
export function createSignalKeys({ isRunning, signalsOf, press }) {
  /** key → the signal id that key is currently holding down. */
  const held = new Map();

  const release = (key) => {
    const id = held.get(key);
    if (id == null) return false;
    held.delete(key);
    press(id, false);
    return true;
  };

  return {
    /** @returns {boolean} did this consume the key? */
    handleKeyDown(e) {
      const key = keyOf(e);
      if (key == null) return false;
      if (!isRunning()) return false; // stopped: 1–9 are the tools' to claim
      // Auto-repeat must never re-fire a toggle or re-press a held button —
      // but it IS our key, so swallow it rather than letting it fall through.
      if (e.repeat) return true;
      if (held.has(key)) return true;
      const sig = signalForKey(signalsOf(), key);
      if (!sig) return false; // no button there — not ours to swallow
      held.set(key, sig.id);
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
      if (!e || !isSignalKey(e.key)) return false;
      // Modifiers are NOT checked here either: press ⌘ after the digit and the
      // keyup arrives with metaKey set, which must still release it.
      return release(e.key);
    },

    /** Let go of everything — window blur, or the transport stopping. */
    releaseAll() {
      for (const key of [...held.keys()]) release(key);
    },

    /** The keys currently down, in digit-row order, for tests. */
    get heldKeys() {
      return SIGNAL_KEYS.filter((k) => held.has(k));
    },
  };
}

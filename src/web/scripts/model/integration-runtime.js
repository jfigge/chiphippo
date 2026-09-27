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

// integration-runtime.js — what the Arduino serial integration DOES at a
// settle boundary, as pure state: no port, no timer, no DOM. The renderer's
// IntegrationController feeds it received values and settled boards, and acts
// on its answers (sending, stalling, re-settling); every rule of the timing
// model lives here, where a test can reach it.
//
// THE TIMING MODEL (the spec's §5), stated once:
//   · An OUTPUT fires when its trigger line's level NOW differs from its level
//     at the PREVIOUS boundary in the configured direction — the trigger's
//     initial state stands in for "previous" at the first one. Only settled
//     levels are compared, so a glitch inside one settle is never seen: that
//     is intended. Firing samples the pins at the same boundary.
//   · An INPUT's received value is BUFFERED — the latest one wins — and is
//     never put on the board mid-propagation. At a boundary the eligible
//     values are: every LIVE input's (no trigger tag), and every TRIGGERED
//     input's whose trigger showed its edge at that boundary. All of them are
//     applied at once, and the board settles once more.
//   · A value that arrives while the board is stalled on an Output is still
//     eligible at that boundary: the boundary is not over until the stall is.
//     That is what makes the request/response shape work — an Output handler
//     on the Arduino that answers with an Input lands its answer in the SAME
//     boundary, before the board moves on.
//
// A TRIGGER LEVEL IS A BOOLEAN: high, or not. A floating or unknown line is
// not a transition to anything, and an unplanted pin reads 0 — the same rule
// `packValue` states.

import {
  TRIGGER_KEY,
  edgeFired,
  elementIndex,
  hasTagKey,
  packValue,
  pinCount,
  unpackLevels,
} from "./integration.js";

/** The trigger tag's anchor, or null when it is not on the board. */
function triggerAnchor(element) {
  const anchor = element?.tags?.[TRIGGER_KEY]?.anchor;
  return typeof anchor === "string" ? anchor : null;
}

/** Is an Input LIVE — no trigger tag planted, so a value is applied as soon
    as the board is between settles? */
export function isLive(element) {
  return triggerAnchor(element) == null;
}

export class IntegrationRuntime {
  #prevHigh = new Map(); // element id → trigger was HIGH at the last boundary
  #pending = new Map(); // input id → { width, value } received, not yet applied
  #applied = new Map(); // input id → { width, value } on the board now

  /**
   * A run is starting: every trigger's "previous" level is its initial state,
   * and no Input holds a value yet — until the Arduino sends one, an Input's
   * pins drive nothing at all.
   */
  begin(elements) {
    this.#prevHigh.clear();
    this.#pending.clear();
    this.#applied.clear();
    for (const e of elements ?? []) {
      this.#prevHigh.set(e.id, e.triggerInit === "high");
    }
  }

  /** The run is over: forget everything (run-volatile, like a clock phase). */
  end() {
    this.#prevHigh.clear();
    this.#pending.clear();
    this.#applied.clear();
  }

  /**
   * An Input's value arrived. Held until a boundary makes it eligible; a newer
   * value for the same Input replaces one not applied yet.
   * @returns {boolean} whether the element is one of the elements given
   */
  receive(elements, element, width, value) {
    if (!elements?.some((e) => e.id === element?.id)) return false;
    this.#pending.set(element.id, { width, value });
    return true;
  }

  /** Is any LIVE Input holding a value it could apply right now? A caller
      with no boundary coming uses this to decide to make one. */
  hasLivePending(elements) {
    return (elements ?? []).some(
      (e) => e.kind === "input" && isLive(e) && this.#pending.has(e.id),
    );
  }

  /**
   * The boundary: read the settled board, decide which Outputs fire (and what
   * they send) and which triggered Inputs are released. Advances every
   * trigger's "previous" level, so call it exactly once per settle.
   *
   * @param {Array} elements the desk's elements
   * @param {(address: string) => string|undefined} levelAt the settled level
   *   of the net under an address (`"H"`, `"L"`, `"Z"`, `"X"`)
   * @returns {{sends: Array<{element: object, index: number, width: number,
   *   value: number}>, released: Set<string>}}
   */
  boundary(elements, levelAt) {
    const sends = [];
    const released = new Set();
    const high = (address) => address != null && levelAt(address) === "H";
    for (const e of elements ?? []) {
      const anchor = triggerAnchor(e);
      if (anchor == null) continue; // no trigger: an Output never fires,
      // and an Input is live (handled in apply)
      const now = high(anchor);
      const prev = this.#prevHigh.get(e.id) ?? e.triggerInit === "high";
      this.#prevHigh.set(e.id, now);
      if (!edgeFired(e.triggerEdge, prev, now)) continue;
      if (e.kind === "output") {
        if (!e.connection) continue;
        const { width, value } = packValue(e.fields, (pin) =>
          high(e.tags?.[String(pin)]?.anchor),
        );
        sends.push({
          element: e,
          index: elementIndex(elements, e),
          width,
          value,
        });
      } else {
        released.add(e.id);
      }
    }
    return { sends, released };
  }

  /**
   * Put every eligible value on the board at once — each LIVE Input's
   * pending value, and each Input `released` names that has one.
   * @returns {boolean} whether anything changed (so the board must re-settle)
   */
  apply(elements, released = new Set()) {
    let changed = false;
    for (const e of elements ?? []) {
      if (e.kind !== "input") continue;
      const pending = this.#pending.get(e.id);
      if (!pending) continue;
      if (!isLive(e) && !released.has(e.id)) continue;
      this.#pending.delete(e.id);
      const was = this.#applied.get(e.id);
      if (was && was.width === pending.width && was.value === pending.value) {
        continue; // the same value again: nothing on the board moves
      }
      this.#applied.set(e.id, pending);
      changed = true;
    }
    return changed;
  }

  /**
   * The level every planted Input pin tag drives, for the engine — keyed
   * `<element>:<pin>`, the id engine.js gives each one. A pin past the width
   * the Arduino sent (a header generated for a narrower element) drives
   * nothing, rather than a made-up 0.
   * @returns {Map<string, "H"|"L">}
   */
  levels(elements) {
    const out = new Map();
    for (const e of elements ?? []) {
      if (e.kind !== "input") continue;
      const applied = this.#applied.get(e.id);
      if (!applied) continue;
      const width = Math.min(applied.width, pinCount(e.fields));
      for (const [pin, level] of unpackLevels(width, applied.value)) {
        const key = String(pin);
        if (hasTagKey(e, key) && e.tags?.[key]?.anchor) {
          out.set(`${e.id}:${key}`, level);
        }
      }
    }
    return out;
  }

  /** The value an Input is driving now, or null (for tests and tooltips). */
  appliedValue(id) {
    return this.#applied.get(id) ?? null;
  }
}

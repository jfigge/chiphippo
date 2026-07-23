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

// scope-recorder.js — the pure, DOM-free core of the logic analyzer (Feature
// 210). A `ScopeRecorder` is a bounded, tick-indexed ring of columns; each
// column is a `Map<channelId, cell>` sampled from ONE `chiphippo:sim-state`
// broadcast. A cell is a net level ("H"/"L"/"Z"/"X"), a decoded bus integer,
// or `null` (undriven / unresolved). No timers, no engine access — the analyzer
// is a passive recorder of the stream the live views already consume.
//
// `decodeBus` and `readNet` are the pure resolution primitives (shared with the
// tests); the view folds them over `doc.scopeChannels` each tick and hands the
// recorder the resulting column via `sample`.

/** Default column cap — the number of ticks retained before the oldest evicts. */
export const SCOPE_CAPACITY = 8000;

/** A driven bit: only H/L are known; Z/X/undefined make the whole word unknown. */
const isHigh = (lv) => lv === "H";
const isDriven = (lv) => lv === "H" || lv === "L";

/**
 * Decode an ordered array of member levels into an integer, MSB:LSB aware.
 * `bits[i]` is the BIT NUMBER member `i` carries (from `parseBusName`, so
 * `D[7:0]` → member 0 is bit 7). A single undriven member (Z/X/undefined) makes
 * the value unknown.
 *
 * @param {Array<string|null>} memberLevels - one level per ordered member.
 * @param {number[]} bits - the bit number each member carries.
 * @returns {{ value: number|null, known: boolean }}
 */
export function decodeBus(memberLevels, bits) {
  let value = 0;
  for (let i = 0; i < bits.length; i += 1) {
    const lv = memberLevels[i];
    if (!isDriven(lv)) return { value: null, known: false };
    // 2**bit (not 1<<bit) so a >31-bit bus doesn't wrap through the sign bit.
    if (isHigh(lv)) value += 2 ** bits[i];
  }
  return { value, known: true };
}

/**
 * The live level on the net a member ADDRESS belongs to, or `null` when the
 * address is off-circuit / undriven. Resolving through the address (not a net
 * id) is what lets a channel survive a rebuild that re-keys the net — the same
 * bench point maps to whatever net now owns it.
 *
 * @param {string} address - a hole/terminal address, e.g. "bb1.f12".
 * @param {{ netLevels: Map, netlist: { netOfPoint: Map }|null }} detail
 * @returns {string|null}
 */
export function readNet(address, detail) {
  const netId = detail?.netlist?.netOfPoint?.get(address);
  if (netId == null) return null;
  return detail.netLevels?.get(netId) ?? null;
}

/**
 * A bounded, tick-indexed multi-channel ring. Each `sample` appends one column
 * keyed by monotonically increasing tick; past the capacity the oldest column
 * evicts, so `firstTick` advances and the time axis scrolls. Columns are keyed
 * by channel id, so adding/removing a channel mid-run never corrupts the ring —
 * a channel simply has no cell in columns recorded before it existed.
 */
export class ScopeRecorder {
  #columns = []; // [{ tick, cells: Map<channelId, cell> }]
  #next = 0; // next tick index to assign (monotonic across the run)
  #capacity;

  constructor({ capacity = SCOPE_CAPACITY } = {}) {
    this.#capacity = Math.max(1, Math.floor(capacity) || SCOPE_CAPACITY);
  }

  /** Drop every column and rewind the tick counter (called on Run). */
  reset() {
    this.#columns = [];
    this.#next = 0;
  }

  /**
   * Append one column of samples. `cells` is a `Map<channelId, cell>` (cell =
   * level string, decoded integer, or null). Evicts the oldest column past cap.
   */
  sample(cells) {
    this.#columns.push({ tick: this.#next, cells });
    this.#next += 1;
    if (this.#columns.length > this.#capacity) this.#columns.shift();
  }

  /** Columns currently retained. */
  get size() {
    return this.#columns.length;
  }

  /** The next tick index (also the total number of ticks ever recorded). */
  get nextTick() {
    return this.#next;
  }

  /** The tick index of the oldest retained column (0 when empty). */
  get firstTick() {
    return this.#columns.length ? this.#columns[0].tick : 0;
  }

  /** The tick index of the newest column (-1 when empty). */
  get lastTick() {
    return this.#columns.length
      ? this.#columns[this.#columns.length - 1].tick
      : -1;
  }

  /** The retained columns, oldest first (live reference — do not mutate). */
  columns() {
    return this.#columns;
  }

  /** The column at an absolute tick index, or null if evicted / out of range. */
  columnAt(tick) {
    const i = tick - this.firstTick;
    return i >= 0 && i < this.#columns.length ? this.#columns[i] : null;
  }

  /** The cell a channel held at a tick, or null (channel absent / evicted). */
  cellAt(tick, channelId) {
    const col = this.columnAt(tick);
    return col ? (col.cells.get(channelId) ?? null) : null;
  }
}

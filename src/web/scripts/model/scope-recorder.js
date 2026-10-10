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

// scope-recorder.js — the pure, DOM-free core of the logic analyzer (Feature
// 210). A `ScopeRecorder` is a bounded, tick-indexed ring of columns; each
// column is a `Map<channelId, cell>` sampled from ONE `chiphippo:sim-state`
// broadcast. A cell is a net level ("H"/"L"/"Z"/"X"), a decoded bus integer,
// or `null` (undriven / unresolved). No timers, no engine access — the analyzer
// is a passive recorder of the stream the live views already consume.
//
// Beside its levels a column may carry VOLTS (`Map<channelId, volts>`): what
// Spice Lite knew a net's voltage to be at that tick (a charging RC node, a
// 555's capacitor — the broadcast's `nodeVolts`). The level is still recorded
// for those nets (it is what the inputs on them read); the volts are what the
// lane draws, so a capacitor is seen charging rather than stepping.
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
 * The voltage on the net a member ADDRESS belongs to, when the run knows one
 * (Spice Lite's `nodeVolts`), else `null` — always `null` on the digital
 * engine, which knows levels and nothing else.
 *
 * @param {string} address - a hole/terminal address, e.g. "bb1.f12".
 * @param {{ nodeVolts?: Map, netlist: { netOfPoint: Map }|null }} detail
 * @returns {number|null}
 */
export function readVolts(address, detail) {
  const netId = detail?.netlist?.netOfPoint?.get(address);
  if (netId == null) return null;
  const volts = detail.nodeVolts?.get(netId);
  return Number.isFinite(volts) ? volts : null;
}

/**
 * The full scale of a voltage lane: the highest voltage any supply on the desk
 * is SET to (a drooping supply does not shrink the scale), or 0 when the
 * broadcast names no supply. A lane is drawn at a fixed scale, as a scope's
 * is — scaled to the trace instead, a node creeping up from 0 V would fill
 * the lane from the first sample and look like a step all over again.
 *
 * @param {{ supplies?: Map<string, {set: number}> }} detail
 * @returns {number}
 */
export function fullScaleOf(detail) {
  let top = 0;
  for (const supply of detail?.supplies?.values() ?? []) {
    if (Number.isFinite(supply?.set) && supply.set > top) top = supply.set;
  }
  return top;
}

/**
 * Whether a sim-state comes from a Spice Lite run: its `lamps` (every LED
 * junction's verdict) is a map there and null on the digital engine.
 * @param {{lamps?: Map|null}} detail
 */
export function isSpiceRun(detail) {
  return detail?.lamps != null;
}

/**
 * A bounded, tick-indexed multi-channel ring. Each `sample` appends one column
 * keyed by monotonically increasing tick; past the capacity the oldest column
 * evicts, so `firstTick` advances and the time axis scrolls. Columns are keyed
 * by channel id, so adding/removing a channel mid-run never corrupts the ring —
 * a channel simply has no cell in columns recorded before it existed.
 */
export class ScopeRecorder {
  // [{ tick, cells: Map<channelId, cell>, volts? }] — the retained columns
  // start at #head: an eviction only moves it, and the evicted front is cut
  // off in one go once it is a capacity long (or when the columns are read),
  // so a tick at 8000 a second never shifts an 8000-long array.
  #columns = [];
  #head = 0;
  #next = 0; // next tick index to assign (monotonic across the run)
  #capacity;
  #fullScale = 0; // the highest supply seen this run (0 = none)
  #spice = false; // whether this run is Spice Lite's

  constructor({ capacity = SCOPE_CAPACITY } = {}) {
    this.#capacity = Math.max(1, Math.floor(capacity) || SCOPE_CAPACITY);
  }

  /** Drop every column and rewind the tick counter (called on Run). */
  reset() {
    this.#columns = [];
    this.#head = 0;
    this.#next = 0;
    this.#fullScale = 0;
    this.#spice = false;
  }

  /**
   * Append one column of samples. `cells` is a `Map<channelId, cell>` (cell =
   * level string, decoded integer, or null). `volts` (`Map<channelId, volts>`)
   * is kept on the column only when it holds something, `fullScale` only
   * ever raises the run's scale, and `spice` marks the run as Spice Lite's
   * (until the next reset). `at` is the tick's simulated moment, seconds
   * (the sim-tick's own), kept when known. Evicts the oldest column past cap.
   */
  sample(
    cells,
    { volts = null, fullScale = 0, spice = false, at = null } = {},
  ) {
    const column = { tick: this.#next, cells };
    if (Number.isFinite(at)) column.at = at;
    if (volts?.size) column.volts = volts;
    this.#columns.push(column);
    this.#next += 1;
    if (fullScale > this.#fullScale) this.#fullScale = fullScale;
    if (spice) this.#spice = true;
    if (this.#columns.length - this.#head > this.#capacity) this.#head += 1;
    if (this.#head >= this.#capacity) this.#compact();
  }

  /** Cut the evicted columns off the front. */
  #compact() {
    if (this.#head === 0) return;
    this.#columns.splice(0, this.#head);
    this.#head = 0;
  }

  /** The run's voltage full scale (`fullScaleOf`'s highest), 0 when none. */
  get fullScale() {
    return this.#fullScale;
  }

  /** Whether the recorded run is Spice Lite's. */
  get spice() {
    return this.#spice;
  }

  /** Columns currently retained. */
  get size() {
    return this.#columns.length - this.#head;
  }

  /** The next tick index (also the total number of ticks ever recorded). */
  get nextTick() {
    return this.#next;
  }

  /** The tick index of the oldest retained column (0 when empty). */
  get firstTick() {
    return this.size ? this.#columns[this.#head].tick : 0;
  }

  /** The tick index of the newest column (-1 when empty). */
  get lastTick() {
    return this.size ? this.#columns[this.#columns.length - 1].tick : -1;
  }

  /** The retained columns, oldest first (live reference — do not mutate). */
  columns() {
    this.#compact();
    return this.#columns;
  }

  /** The column at an absolute tick index, or null if evicted / out of range. */
  columnAt(tick) {
    const i = tick - this.firstTick;
    return i >= 0 && i < this.size ? this.#columns[this.#head + i] : null;
  }

  /** The cell a channel held at a tick, or null (channel absent / evicted). */
  cellAt(tick, channelId) {
    const col = this.columnAt(tick);
    return col ? (col.cells.get(channelId) ?? null) : null;
  }

  /** The simulated moment (seconds) a tick ran at, or null (not known). */
  atOf(tick) {
    return this.columnAt(tick)?.at ?? null;
  }

  /** The volts a channel's net was at on a tick, or null (none known). */
  voltsAt(tick, channelId) {
    return this.columnAt(tick)?.volts?.get(channelId) ?? null;
  }

  /** Whether any retained column knows a voltage for the channel. */
  hasVolts(channelId) {
    for (let i = this.#head; i < this.#columns.length; i++) {
      if (this.#columns[i].volts?.has(channelId)) return true;
    }
    return false;
  }
}

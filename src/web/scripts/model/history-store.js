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

// history-store.js — the pure, DOM-free undo/redo core (Feature 200). It holds
// an ordered list of immutable document SNAPSHOTS with a cursor at the
// "present": everything before the cursor is undo history, everything after is
// the redo future. Undo/redo just walk the cursor and hand back the snapshot to
// restore — no per-mutator inverse code, so a new DeskDoc mutator needs no undo
// support of its own.
//
// The document is small and fully serializable (that is how autosave and dirty
// tracking already work), so whole-snapshot history is robust and cheap; if it
// ever grows heavy, structural sharing or diffing can slot in behind this same
// interface.
//
// PURE by contract: it takes no wall-clock of its own (the caller stamps each
// record with a monotonic `time`, matching the engine's determinism rule) and
// never clones — callers pass a fresh snapshot in and treat what comes back as
// read-only. Coalescing is OPT-IN per record (`coalesce: true`): only a run of
// same-label, same-flag records inside the time window collapses into one
// entry, so a burst of rapid param nudges is one undo step while genuinely
// distinct edits (each add / delete / paste / drag) always stand alone.

/** Default cap on history depth; the oldest entry is dropped past it. */
const DEFAULT_LIMIT = 100;

/** Default coalescing window (ms) for consecutive same-label opt-in records. */
const DEFAULT_COALESCE_MS = 400;

export class HistoryStore {
  #entries = []; // { snapshot, label, time, coalesce }
  #index = -1; // cursor at the present entry; -1 when empty
  #limit;
  #coalesceMs;
  #frozen = false;

  /**
   * @param {object} [opts]
   * @param {number} [opts.limit] - max entries retained (oldest dropped past it).
   * @param {number} [opts.coalesceMs] - window for same-label coalescing.
   */
  constructor({
    limit = DEFAULT_LIMIT,
    coalesceMs = DEFAULT_COALESCE_MS,
  } = {}) {
    this.#limit = Math.max(1, Math.floor(limit));
    this.#coalesceMs = Math.max(0, coalesceMs);
  }

  /** Is there a prior snapshot to undo to? */
  get canUndo() {
    return this.#index > 0;
  }

  /** Is there an undone snapshot to redo to? */
  get canRedo() {
    return this.#index >= 0 && this.#index < this.#entries.length - 1;
  }

  /** The number of retained entries (past + present + future). */
  get size() {
    return this.#entries.length;
  }

  /** The present entry's label, or null when empty. */
  get label() {
    return this.#index >= 0 ? this.#entries[this.#index].label : null;
  }

  /** While frozen, `record` is a no-op (history is paused during a run). */
  get frozen() {
    return this.#frozen;
  }

  freeze() {
    this.#frozen = true;
  }

  unfreeze() {
    this.#frozen = false;
  }

  /**
   * Reset the stack. With a `snapshot`, seed it as the sole (present) entry —
   * the fresh baseline a New/Open lands on; without one, leave it empty.
   */
  clear(snapshot = null, label = "load") {
    this.#entries = [];
    this.#index = -1;
    this.#frozen = false;
    if (snapshot != null) this.record(snapshot, label, 0);
  }

  /**
   * Push `snapshot` as the new present, dropping any redo future. A no-op while
   * frozen. When `coalesce` is set AND the present entry is a coalescing record
   * of the same label within the time window, the present entry is UPDATED in
   * place instead — so a burst collapses to one undo step whose baseline is the
   * state before the burst began.
   *
   * @param {object} snapshot - a plain, already-cloned document (kept as-is).
   * @param {string} [label] - drives coalescing + a future history UI.
   * @param {number} [time] - caller-stamped monotonic time (no Date here).
   * @param {{coalesce?: boolean}} [opts]
   */
  record(snapshot, label = "edit", time = 0, { coalesce = false } = {}) {
    if (this.#frozen) return;
    const present = this.#entries[this.#index];
    const canMerge =
      coalesce &&
      present != null &&
      present.coalesce &&
      present.label === label &&
      this.#index === this.#entries.length - 1 && // nothing to redo over
      time - present.time <= this.#coalesceMs;
    if (canMerge) {
      present.snapshot = snapshot;
      present.time = time;
      return;
    }
    // A genuine new edit invalidates the redo future.
    if (this.#index < this.#entries.length - 1) {
      this.#entries.length = this.#index + 1;
    }
    this.#entries.push({ snapshot, label, time, coalesce });
    this.#index = this.#entries.length - 1;
    // Enforce the depth bound by dropping the oldest entries.
    if (this.#entries.length > this.#limit) {
      const drop = this.#entries.length - this.#limit;
      this.#entries.splice(0, drop);
      this.#index -= drop;
    }
  }

  /** Step back one entry and return its snapshot, or null when at the start. */
  undo() {
    if (!this.canUndo) return null;
    this.#index -= 1;
    return this.#entries[this.#index].snapshot;
  }

  /** Step forward one entry and return its snapshot, or null when at the end. */
  redo() {
    if (!this.canRedo) return null;
    this.#index += 1;
    return this.#entries[this.#index].snapshot;
  }

  /**
   * Replace the present entry's snapshot without adding an undo step — used to
   * reconcile the history's notion of "present" with run-volatile persisted
   * effects (12 V damage, a switch flipped while running) after Stop, so a
   * later undo/redo stays consistent with the live document.
   */
  sync(snapshot) {
    if (this.#index < 0) return;
    this.#entries[this.#index].snapshot = snapshot;
  }
}

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

/**
 * connection-stream.js — ONE connection's stream, as its connection window
 * shows it (docs/chiphippo-connection-window.md): a single ordered list of
 * everything that happened on it, so cause and effect read in order — a frame
 * arrives, then the line the device printed in response. Pure: entries in,
 * entries out, no port, no timer, no window.
 *
 * Four kinds of entry, each stamped with `t` (ms since the epoch):
 *
 *   text   a finished line of the device's log text
 *   data   a value that crossed the wire: `dir` "out" (an OUTPUT) or "in"
 *          (an INBOUND), its index, width, value, SEQ and raw bytes — and the
 *          element it belongs to, snapshotted, since the next run may differ
 *   proto  the protocol's own traffic and a run's milestones: `event` names
 *          it (hello, hello-ack, ack-in, ack-out, open, handshake, close, …)
 *   error  what went wrong: resends, damaged frames, a failed delivery, a
 *          refused handshake, a restart, a drop
 *
 * FACTS ONLY: an entry carries codes and numbers, never a sentence — what a
 * line SAYS is the renderer's, in the user's language.
 *
 * Log text arrives in chunks that ignore line boundaries, so it is cut here:
 * everything up to a newline is a finished line, and what follows waits as
 * the `partial` shown at the bottom. Any OTHER entry arriving mid-line ends
 * that line where it is — the partial is kept as a line of its own, not lost,
 * and the new entry follows it.
 *
 * A run CLEARS the stream as it begins (`beginRun`), and `t0` — what the
 * window's timestamps count from — is that moment. After Stop the stream
 * stays as it was, to be read at leisure, until the next run or a Clear.
 */
"use strict";

/** The most entries one connection keeps; older ones drop off the top. The
    window's own row cap (serial-log-view.js's MAX_ROWS) is held equal to it by
    a test, so a reopened window shows exactly what a live one did. */
const MAX_ENTRIES = 2000;

class ConnectionStream {
  #entries = [];
  #partial = "";
  #partialT = 0;
  #t0 = null;

  /** A run is starting: forget the last one, and count time from now. */
  beginRun(t = Date.now()) {
    this.#entries = [];
    this.#partial = "";
    this.#t0 = t;
  }

  /** Empty it (the window's Clear) — the run's clock keeps its origin. */
  clear() {
    this.#entries = [];
    this.#partial = "";
  }

  /**
   * Log text as it arrived. Returns the lines it finished.
   * @param {string} chunk
   * @param {number} [t]
   * @returns {Array<object>}
   */
  text(chunk, t = Date.now()) {
    const had = this.#partial !== "";
    const parts = (this.#partial + String(chunk).replace(/\r/g, "")).split(
      "\n",
    );
    const rest = parts.pop();
    // A line is stamped with when its FIRST character arrived.
    const lines = parts.map((text, i) => ({
      kind: "text",
      t: i === 0 && had ? this.#partialT : t,
      text,
    }));
    this.#push(lines);
    if (lines.length || !had) this.#partialT = t;
    this.#partial = rest;
    return lines;
  }

  /**
   * Any other entry. A partial log line it interrupts is finished first.
   * Returns every entry that was added (that line included).
   * @param {object} entry
   * @returns {Array<object>}
   */
  add(entry) {
    const added = [];
    if (this.#partial) {
      added.push({ kind: "text", t: this.#partialT, text: this.#partial });
      this.#partial = "";
    }
    added.push({ t: Date.now(), ...entry });
    this.#push(added);
    return added;
  }

  #push(list) {
    if (list.length === 0) return;
    this.#entries.push(...list);
    const excess = this.#entries.length - MAX_ENTRIES;
    if (excess > 0) this.#entries.splice(0, excess);
  }

  /** The unfinished last line of log text. */
  get partial() {
    return this.#partial;
  }

  /** When the current run began, or null before the first. */
  get t0() {
    return this.#t0;
  }

  /** Everything, for a window that has just opened. */
  snapshot() {
    return {
      t0: this.#t0,
      entries: [...this.#entries],
      partial: this.#partial,
    };
  }
}

module.exports = { ConnectionStream, MAX_ENTRIES };

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

// slider-windows.js — the MAIN renderer's side of the floated sliders: one
// Properties slider (a `"range"` field marked `float: true` — a potentiometer's
// Position) torn off into a small OS window of its own (web/slider.html), so
// the knob can be turned while the circuit stays in sight. The Properties card
// is a modal that dims the desk; this window covers nothing of the app's it is
// not dragged over, and floats above it.
//
// The window is its own sandboxed renderer, so it reaches this one only
// through main's `slider:*` relay, addressed by part and field: it announces
// itself (`ready`), moves the thumb (`set`, numbered so a reply to an older
// move never drags the thumb back), says when it is pointed at or focused
// (`hover`) and passes on a tapped Space (`run-toggle`); main reports it
// `closed`. Everything it shows comes from here (`state`): the part's title,
// the field's label and range, the value and the two end readouts, worked out
// here because a field's `ends` is a function and cannot cross the bridge.
//
// This class knows nothing about any part. Its host (DeskController) answers
// `read(id, key)` — the title, the label, the field and the part's values, or
// null once there is nothing to show — and takes every `set` through
// `apply(id, key, value)`, the Properties card's own path, so a move there is
// exactly a move here (live, one coalesced undo entry). `refresh()` re-reads
// every window after a document change, sending only what changed;
// `closeAll()` is for another document coming in.

/** One window's address. */
const windowKey = (id, key) => `${id}:${key}`;

export class SliderWindows {
  #bridge;
  #read;
  #apply;
  #onHover;
  #anchorOf;
  #onRunToggle;
  /** windowKey → { id, key, seq, sent, lit } — every window asked for and
      not yet closed. `seq` is the last `set` taken; `sent`, the last state. */
  #windows = new Map();
  #onInbound = (e) => this.#receive(e.detail);

  /**
   * @param {object} opts
   * @param {object} [opts.bridge] - window.chiphippo.slider; none, and
   *   nothing floats.
   * @param {(id: string, key: string) => ({title: string, label: string, field: object, values: object}|null)} opts.read
   * @param {(id: string, key: string, value: number) => (boolean|void)} opts.apply
   * @param {(id: string, on: boolean) => void} [opts.onHover] - the part a
   *   window is pointed at or focused on, lit on the desk while it is.
   * @param {(id: string) => object|null} [opts.anchorOf] - where the part
   *   and the circuit around it are in the app window, for main to open the
   *   window off the circuit (model/float-placement.js).
   * @param {() => void} [opts.onRunToggle] - Space tapped in a window.
   */
  constructor({ bridge, read, apply, onHover, anchorOf, onRunToggle }) {
    this.#bridge = bridge ?? null;
    this.#read = read;
    this.#apply = apply;
    this.#onHover = onHover;
    this.#anchorOf = anchorOf;
    this.#onRunToggle = onRunToggle;
    window.addEventListener("chiphippo:slider-host-inbound", this.#onInbound);
  }

  /** How many windows are open. */
  get size() {
    return this.#windows.size;
  }

  /** @returns {boolean} whether `key` of part `id` floats. */
  has(id, key) {
    return this.#windows.has(windowKey(id, key));
  }

  /**
   * Float `key` of part `id` in a window — or bring its window forward if it
   * already floats (main focuses it). A no-op when `read` has nothing to
   * show, or with no bridge.
   * @returns {boolean} whether a window was asked for
   */
  open(id, key) {
    if (!this.#bridge) return false;
    const subject = this.#read(id, key);
    if (!subject) return false;
    const k = windowKey(id, key);
    if (!this.#windows.has(k)) {
      this.#windows.set(k, { id, key, seq: 0, sent: null, lit: false });
    }
    this.#call(() =>
      this.#bridge.open(id, key, {
        title: `${subject.title} — ${subject.label}`,
        anchor: this.#anchorOf?.(id) ?? null,
      }),
    );
    return true;
  }

  /** Re-read every window and send it what changed — closing the ones whose
      part or field has gone. */
  refresh() {
    for (const entry of [...this.#windows.values()]) {
      const subject = this.#read(entry.id, entry.key);
      if (subject) this.#send(entry, subject);
      else this.#close(entry);
    }
  }

  /** Close `key` of part `id`'s window, if it floats. */
  close(id, key) {
    const entry = this.#windows.get(windowKey(id, key));
    if (entry) this.#close(entry);
  }

  /** Close every window — another document is coming in. */
  closeAll() {
    for (const entry of [...this.#windows.values()]) this.#close(entry);
  }

  /** Stop listening (a controller torn down). */
  dispose() {
    window.removeEventListener("chiphippo:slider-host-inbound", this.#onInbound); // prettier-ignore
  }

  // ── Talking to a window ─────────────────────────────────────────────────

  /** Everything a window shows, as plain data. */
  #state(entry, { title, label, field, values }) {
    return {
      kind: "state",
      title,
      label,
      min: field.min ?? 0,
      max: field.max ?? 100,
      step: field.step ?? 1,
      valuePercent: Boolean(field.valuePercent),
      value: values[field.key],
      ends: typeof field.ends === "function" ? field.ends(values) : null,
      seq: entry.seq,
    };
  }

  /** Send a window its state — unless it is what it was last sent. */
  #send(entry, subject, { force = false } = {}) {
    const state = this.#state(entry, subject);
    const text = JSON.stringify(state);
    if (!force && text === entry.sent) return;
    entry.sent = text;
    this.#call(() => this.#bridge.toWindow(entry.id, entry.key, state));
  }

  #receive(detail) {
    const entry = this.#windows.get(windowKey(detail?.compId, detail?.key));
    if (!entry) return;
    const msg = detail.msg;
    if (msg?.kind === "ready") {
      // A window (re)loaded: it holds nothing yet.
      const subject = this.#read(entry.id, entry.key);
      if (subject) this.#send(entry, subject, { force: true });
      else this.#close(entry);
    } else if (msg?.kind === "set") {
      if (!Number.isFinite(msg.value)) return;
      if (Number.isInteger(msg.seq)) entry.seq = Math.max(entry.seq, msg.seq);
      this.#apply(entry.id, entry.key, msg.value);
      // The host's refresh has usually said it already; a refused move (or
      // one that changed nothing) still owes the window its true state.
      const subject = this.#read(entry.id, entry.key);
      if (subject) this.#send(entry, subject);
    } else if (msg?.kind === "hover") {
      this.#light(entry, Boolean(msg.on));
    } else if (msg?.kind === "run-toggle") {
      this.#onRunToggle?.();
    } else if (msg?.kind === "closed") {
      // The window is gone already (its own close, or main's).
      this.#light(entry, false);
      this.#windows.delete(windowKey(entry.id, entry.key));
    }
  }

  #light(entry, on) {
    if (entry.lit === on) return;
    entry.lit = on;
    this.#onHover?.(entry.id, on);
  }

  #close(entry) {
    this.#light(entry, false);
    this.#windows.delete(windowKey(entry.id, entry.key));
    this.#call(() => this.#bridge.close(entry.id, entry.key));
  }

  /** A bridge call, fire and forget — a window that has gone answers false. */
  #call(fn) {
    try {
      Promise.resolve(fn()).catch(() => {});
    } catch {
      // nothing to tell: the window simply is not there
    }
  }
}

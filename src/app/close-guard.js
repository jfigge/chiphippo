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

// close-guard.js — the three-flag state machine behind "is it safe to close?".
//
// Main owns the lifecycle; the RENDERER owns the unsaved state and the dialog
// that asks about it. So a close or a quit is prevented ONCE, the renderer is
// asked (`app:confirm-close`), and the answer (`app:close-reply`) resumes or
// abandons it. This is that handshake with no Electron in it, so the transitions
// can be tested — main.js keeps only the event wiring.
//
// THE CONFIRMATION AUTHORISES ONE CLOSE AND NO OTHER, which is the whole reason
// `closed()` exists. `confirmed` used to be a one-way latch, and on macOS —
// where closing the last window does NOT quit the app — that was a silent
// data-loss path: close the window, answer "discard", click the dock icon, and
// the fresh window inherited a latch that was still set. Every later close and
// ⌘Q then skipped the guard entirely and threw away an unsaved project without
// asking. Clearing it when the window it authorised actually goes away puts the
// next window back where the first one started.
//
// There is deliberately NO timeout on the answer (the user may sit on that
// dialog as long as they like), so `pending` is a latch with exactly one key —
// the reply — plus `rendererGone()` for the one failure main can see. A
// renderer that is alive and simply silent is invisible from here, which is why
// the "it always answers" guarantee lives on the renderer side
// (ProjectWorkspace#askUnsaved).
"use strict";

class CloseGuard {
  /** The renderer said "go" for the close now in progress. */
  #confirmed = false;
  /** A question is out; a second close must not stack another dialog. */
  #pending = false;
  /** That question came from a QUIT (⌘Q / menu), not the window's own button. */
  #quitting = false;

  /**
   * May a close/quit proceed without asking? True only between the renderer's
   * "go" and the window actually going away.
   */
  allows() {
    return this.#confirmed;
  }

  /** Is a question already out? (Exposed for assertions/diagnostics.) */
  get pending() {
    return this.#pending;
  }

  /**
   * Put the question to the renderer — once. A ⌘Q arriving while a
   * window-button question is already out still marks the answer as a QUIT,
   * which is what the user last asked for.
   *
   * @param {{quitting?: boolean}} [opts]
   * @returns {boolean} whether the caller should actually send it.
   */
  ask({ quitting = false } = {}) {
    if (quitting) this.#quitting = true;
    if (this.#pending) return false;
    this.#pending = true;
    return true;
  }

  /**
   * The renderer answered.
   *
   * @param {boolean} ok - true to go ahead (it saved or discarded).
   * @returns {"quit"|"close"|"stay"} what the caller should now do.
   */
  reply(ok) {
    this.#pending = false;
    if (!ok) {
      this.#quitting = false; // a cancelled quit is not a pending one
      return "stay";
    }
    this.#confirmed = true;
    return this.#quitting ? "quit" : "close";
  }

  /**
   * The window the confirmation authorised has gone. On macOS the app lives on,
   * so this is what stops a reopened window inheriting the answer given about
   * the one before it — see the header.
   */
  closed() {
    this.#confirmed = false;
    this.#quitting = false;
  }

  /**
   * The renderer we are waiting on died. It will never reply, and with the
   * latch still set no question would ever be asked again — so the window could
   * not be closed even though there was nobody left to ask.
   */
  rendererGone() {
    this.#pending = false;
  }
}

module.exports = { CloseGuard };

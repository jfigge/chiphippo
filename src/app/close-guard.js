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
//
// WHETHER THERE IS ANYBODY TO ASK is the fourth flag, and the renderer states
// it (`rendererReady`, from `app:close-ready`) rather than main guessing it. It
// used to be guessed from `webContents.isDestroyed()` — which stays FALSE after
// a renderer crash, so a crashed window re-asked a dead page, latched on a reply
// that could never come, and could not be closed or quit at all. The same was
// true of a page that failed to load, and of the moments at boot before app.js
// has registered its handler. Until the page says it can answer, nothing it
// holds can be unsaved, so the close simply proceeds.
"use strict";

class CloseGuard {
  /** The renderer said "go" for the close now in progress. */
  #confirmed = false;
  /** A question is out; a second close must not stack another dialog. */
  #pending = false;
  /** That question came from a QUIT (⌘Q / menu), not the window's own button. */
  #quitting = false;
  /** A renderer is loaded, has its handler registered, and has not died since. */
  #answerable = false;
  /** That quit is to INSTALL a downloaded update (the Restart button). */
  #installing = false;

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
   * Is there a renderer that can answer? False until one says so, and again
   * the moment it dies or starts loading a new page — the caller lets a close
   * proceed rather than ask nobody.
   */
  get answerable() {
    return this.#answerable;
  }

  /** The renderer has registered its close handler and can answer. */
  rendererReady() {
    this.#answerable = true;
  }

  /**
   * Put the question to the renderer — once. A ⌘Q arriving while a
   * window-button question is already out still marks the answer as a QUIT,
   * which is what the user last asked for.
   *
   * `installing` is a quit for an update: electron-updater's `quitAndInstall`
   * starts the installer BEFORE it quits (on Windows and Linux), so it must
   * run only once the question is answered — never as the thing that asks it.
   *
   * @param {{quitting?: boolean, installing?: boolean}} [opts]
   * @returns {boolean} whether the caller should actually send it.
   */
  ask({ quitting = false, installing = false } = {}) {
    if (installing) this.#installing = true;
    if (quitting || installing) this.#quitting = true;
    if (this.#pending) return false;
    this.#pending = true;
    return true;
  }

  /**
   * The renderer answered.
   *
   * @param {boolean} ok - true to go ahead (it saved or discarded).
   * @returns {"install"|"quit"|"close"|"stay"} what the caller should now do.
   */
  reply(ok) {
    // An answer to no question authorises nothing: a stray or duplicated reply,
    // or a late one from a page already written off, must not close the window
    // without asking.
    if (!this.#pending) return "stay";
    this.#pending = false;
    if (!ok) {
      this.#quitting = false; // a cancelled quit is not a pending one
      this.#installing = false; // nor is the update it was for
      return "stay";
    }
    this.#confirmed = true;
    if (this.#installing) return "install";
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
    this.#installing = false;
  }

  /**
   * The renderer died, or is being replaced by a new page load. It will never
   * reply, and with the latch still set no question would ever be asked again —
   * so the window could not be closed even though there was nobody left to
   * ask. Nor can it be asked afresh until its successor says it is ready.
   */
  rendererGone() {
    this.#pending = false;
    this.#answerable = false;
  }
}

module.exports = { CloseGuard };

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

// tutorials/player.js — plays one tutorial's steps, in order, to the end or
// until it is told to stop.
//
// FULLY AUTOMATED: a step advances on its timer, or once its action's
// animation has finished and the reader has had a pause — never on the
// user's input (there is no "now you do it" mode). The user's controls are
// Exit (and Esc), Pause/Resume, Previous and Next.
//
// PAUSE IS STICKY. Previous and Next move between steps, paused or not, but
// only Resume starts the clock again: a reader who paused to take a step in
// has not asked for the tour to carry on by stepping to the next one.
//
// A STEP REVISITED DOES NOT REDO WHAT IT DID. A click or a drag acts on the
// app (a section opens, a board lands on the desk); stepping back onto it
// with Previous — or forward again after that — shows its words over the
// same target, but does not click again or place a second board. A moveTo
// changes nothing, so it glides again.
//
// THE CURSOR IS THERE ONLY WHEN SOMETHING USES IT: a step whose action runs
// shows the fake pointer; a step that only points with its callout hides it.
//
// The player is DOM-free. Everything it touches is handed in:
//   rect(id)       the target's window rectangle, or null (tutorials/targets.js)
//   element(id)    the target's element, or null — for what a click acts on
//   view           the overlay: showStep / setCursor / setPressed / setPaused
//                  / size (components/tutorial-overlay.js)
//   actuator       click(el) / dragStart(el) / dragMove(point) / dragEnd(point)
//                  — the app's own handlers (components/tutorial-controller.js)
//   clock          { now(), frame() } — performance.now and a promise per
//                  animation frame in the app, a fake under `node --test`
// so the whole sequence — skips, waits, pauses, the cursor's path — is
// testable with no window at all.

import { easeInOut, lerpPoint, rectPoint, travelMs } from "./geometry.js";

/** The read pause after an `afterAction` step's animation, by default. */
export const READ_PAUSE_MS = 1800;
/** How long the cursor holds a press before the click lands. */
export const PRESS_MS = 160;

/** Thrown through the awaits when the tutorial is exited mid-step. */
class Exited extends Error {}

export class TutorialPlayer {
  #steps;
  #deps;
  #log;
  #index = -1;
  #state = "idle"; // idle · playing · completed · exited
  #paused = false;
  #skip = false; // Next or Previous was pressed: cut the current wait short
  #back = false; // …and it was Previous
  #visited = new Set(); // steps already shown — their clicks and drags done
  #first = -1; // the first step shown: there is no Previous before it
  #cursor = null; // where the fake cursor is, or null before it first appears

  /**
   * @param {object} deps
   * @param {object} deps.tutorial - a TUTORIALS entry.
   * @param {(id: string) => object|null} deps.rect
   * @param {(id: string) => Element|null} deps.element
   * @param {object} deps.view
   * @param {object} deps.actuator
   * @param {{now: () => number, frame: () => Promise<unknown>}} deps.clock
   * @param {{warn: Function}} [deps.log]
   */
  constructor({
    tutorial,
    rect,
    element,
    view,
    actuator,
    clock,
    log = console,
  }) {
    this.#steps = tutorial.steps;
    this.#deps = { rect, element, view, actuator, clock };
    this.#log = log;
  }

  /** Hand over the view, when it is built after the player (its controls'
      callbacks need the player, so one of the two has to come second). */
  attach(view) {
    this.#deps.view = view;
  }

  /** The step on screen (0-based), or -1 before the first. */
  get index() {
    return this.#index;
  }

  get total() {
    return this.#steps.length;
  }

  get paused() {
    return this.#paused;
  }

  get state() {
    return this.#state;
  }

  /**
   * Play to the end.
   * @returns {Promise<"completed"|"exited">}
   */
  async play() {
    if (this.#state !== "idle") return this.#state; // exited before it began
    this.#state = "playing";
    try {
      // A skipped step (optional, nothing to point at) is passed over in the
      // direction of travel — so Previous walks back past it, too.
      let i = 0;
      let dir = 1;
      while (i < this.#steps.length) {
        if (i < 0) {
          i = 0; // walked back past everything shown: start over
          dir = 1;
        }
        this.#index = i;
        const shown = await this.#play(this.#steps[i], i);
        if (!shown) {
          i += dir;
          continue;
        }
        this.#visited.add(i);
        dir = this.#back ? -1 : 1;
        this.#back = false;
        i += dir;
      }
      this.#state = "completed";
    } catch (err) {
      if (!(err instanceof Exited)) {
        // A step that throws must not leave the overlay up over a dead app:
        // the tour ends, as if the user had pressed Exit, and says why.
        this.#log.warn?.("[tutorial] a step failed; ending the tutorial:", err);
      }
      this.#state = "exited";
    }
    return this.#state;
  }

  /** Stop at once (Exit, Esc). Safe to call at any time. */
  exit() {
    if (this.#state === "playing" || this.#state === "idle") {
      this.#state = "exited";
    }
  }

  togglePause() {
    this.#paused = !this.#paused;
    this.#deps.view.setPaused?.(this.#paused);
  }

  /** On to the next step now. A paused tour stays paused. */
  next() {
    this.#skip = true;
    this.#back = false;
  }

  /** Back to the step before. A paused tour stays paused; on the first step
      there is nowhere to go, and the view greys the button. */
  previous() {
    if (this.#index <= this.#first) return;
    this.#skip = true;
    this.#back = true;
  }

  // ── One step ─────────────────────────────────────────────────────────────

  /** Show one step, run its action, dwell. @returns {boolean} whether it was
      shown (false: an optional step with nothing to show, skipped). */
  async #play(step, i) {
    const { view } = this.#deps;
    const revisit = this.#visited.has(i);
    // A click or a drag is done once per tour (see the header).
    const action =
      revisit && step.action?.type !== "moveTo" ? null : (step.action ?? null);
    let target = step.target ?? null;

    if (target && !this.#deps.rect(target)) {
      if (step.optional) return false;
      // The spec's fallback: the words are still worth showing, centred, and
      // a target that cannot be found is a bug worth a line in the console.
      this.#log.warn?.(
        `[tutorial] step ${i + 1}: target "${target}" is not on screen; showing it centred`,
      );
      target = null;
    }
    const acting = action ? this.#actionApplies(action, i) : false;
    if (action && !acting && step.optional && !revisit) return false;

    if (this.#first < 0) this.#first = i;
    view.showStep({
      index: i,
      total: this.#steps.length,
      target,
      callout: step.callout,
      canPrevious: i > this.#first,
    });
    this.#skip = false;
    this.#back = false;
    if (acting) {
      if (this.#cursor) view.setCursor(this.#cursor);
      await this.#perform(action);
    } else {
      view.setCursor(null); // nothing for a hand to do on this step
    }

    const advance = step.advance ?? { mode: "afterAction" };
    const ms =
      advance.mode === "timed"
        ? Number(advance.ms) || 0
        : Number(advance.ms) || READ_PAUSE_MS;
    await this.#wait(ms);
    return true;
  }

  /** Whether `action` can and should run: its targets are present, and its
      `onlyIf` (read off the target's `aria-expanded`) holds. */
  #actionApplies(action, i) {
    const ids =
      action.type === "drag" ? [action.from, action.to] : [action.target];
    const missing = ids.filter((id) => !this.#deps.rect(id));
    if (missing.length) {
      this.#log.warn?.(
        `[tutorial] step ${i + 1}: ${action.type} skipped — "${missing.join('", "')}" not on screen`,
      );
      return false;
    }
    if (action.onlyIf) {
      const el = this.#deps.element(action.target);
      const expanded = el?.getAttribute?.("aria-expanded") === "true";
      if (action.onlyIf === "collapsed" && expanded) return false;
      if (action.onlyIf === "expanded" && !expanded) return false;
    }
    return true;
  }

  async #perform(action) {
    const { actuator, view } = this.#deps;
    if (action.type === "moveTo") {
      await this.#moveTo(this.#centreOf(action.target));
      return;
    }
    if (action.type === "click") {
      await this.#moveTo(this.#centreOf(action.target));
      await this.#press(() =>
        actuator.click(this.#deps.element(action.target)),
      );
      return;
    }
    if (action.type === "drag") {
      await this.#moveTo(this.#centreOf(action.from));
      // The press picks the part up…
      await this.#press(
        () => actuator.dragStart(this.#deps.element(action.from)),
        { release: false },
      );
      // …the hand carries it to where it goes, the app tracking every frame…
      const to = this.#pointIn(action.to, action.at);
      await this.#moveTo(to, (p) => actuator.dragMove(p));
      // …and lets go.
      view.setPressed(true);
      await this.#sleep(PRESS_MS);
      const dropped = actuator.dragEnd(to);
      view.setPressed(false);
      if (dropped === false) {
        this.#log.warn?.(`[tutorial] the drop on "${action.to}" was refused`);
      }
      return;
    }
    this.#log.warn?.(`[tutorial] unknown action "${action.type}" skipped`);
  }

  #centreOf(id) {
    const rect = this.#deps.rect(id);
    if (!rect) throw new Exited(); // vanished between the check and the move
    return rectPoint(rect);
  }

  #pointIn(id, at) {
    const rect = this.#deps.rect(id);
    if (!rect) throw new Exited();
    return rectPoint(rect, at);
  }

  /** Press, act, release — the act lands at the bottom of the press. */
  async #press(act, { release = true } = {}) {
    const { view } = this.#deps;
    view.setPressed(true);
    await this.#sleep(PRESS_MS);
    act();
    if (release) {
      await this.#sleep(PRESS_MS / 2);
      view.setPressed(false);
    }
  }

  /** Glide the fake cursor to `to`, eased, calling `onFrame` at every step of
      the way. The first appearance is at the window's centre. */
  async #moveTo(to, onFrame = null) {
    const { clock, view } = this.#deps;
    if (!this.#cursor) {
      const size = view.size ?? { width: 0, height: 0 };
      this.#cursor = { x: size.width / 2, y: size.height / 2 };
      view.setCursor(this.#cursor);
    }
    const from = this.#cursor;
    const ms = travelMs(from, to);
    const start = clock.now();
    for (;;) {
      this.#check();
      const t = ms > 0 ? (clock.now() - start) / ms : 1;
      const p = t >= 1 ? to : lerpPoint(from, to, easeInOut(t));
      this.#cursor = p;
      view.setCursor(p);
      onFrame?.(p);
      if (t >= 1) return;
      await clock.frame();
    }
  }

  /** A short beat that neither pauses nor skips (inside an action). */
  async #sleep(ms) {
    const { clock } = this.#deps;
    const start = clock.now();
    while (clock.now() - start < ms) {
      this.#check();
      await clock.frame();
    }
    this.#check();
  }

  /** The step's dwell: counts only while not paused, and Next ends it. */
  async #wait(ms) {
    const { clock } = this.#deps;
    let elapsed = 0;
    let last = clock.now();
    while (elapsed < ms) {
      this.#check();
      if (this.#skip) break;
      await clock.frame();
      const now = clock.now();
      if (!this.#paused) elapsed += now - last;
      last = now;
    }
    this.#skip = false;
    this.#check();
  }

  #check() {
    if (this.#state === "exited") throw new Exited();
  }
}

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

// chip-debug-bar.js — the chip debugger's own transport, in the toolbar's
// pill shape, scoped to the chip in view: Continue · Step · Step Out · To
// Settled · Detach, the Break-on-Settled toggle, and the Settled lamp. (A
// breakpoint IN the code is set in the editor's gutter, on its line.)
//
// The app's Run / Stop / Pause / Step / speed stay the ONLY controls of the
// whole simulation; nothing here repeats them (a speed means nothing while
// paused inside a block), and Detach is deliberately neither called Stop nor
// red — red is the global Stop's.
//
// While the debugger runs the five transport buttons are on function keys
// (`DEBUG_KEYS`, listened for by the designer view): a key is a PRESS of its
// button, so it is refused exactly when the button is disabled.

import { el } from "../dom.js";
import { t } from "../i18n.js";

/** Each debugger function key → the bar button it presses. */
export const DEBUG_KEYS = Object.freeze({
  F8: "continue",
  F6: "step",
  F7: "stepOut",
  F9: "toSettled",
  F10: "detach",
});

export class ChipDebugBar {
  #root;
  #buttons;
  #settled;
  #lamp;
  #status;

  /**
   * @param {object} on - `{continue, step, stepOut, toSettled, detach,
   *   breakSettled(on)}` callbacks.
   */
  constructor(on) {
    const button = (key, onClick) =>
      el("button", {
        class: "toolbar-pill-btn cd-bar-btn",
        type: "button",
        text: t(`chipdesign.debug.${key}`),
        title: t(`chipdesign.debug.${key}Title`),
        onClick,
      });
    this.#buttons = {
      continue: button("continue", () => on.continue?.()),
      step: button("step", () => on.step?.()),
      stepOut: button("stepOut", () => on.stepOut?.()),
      toSettled: button("toSettled", () => on.toSettled?.()),
      detach: button("detach", () => on.detach?.()),
    };
    const toggle = (key, onChange) => {
      const btn = el("button", {
        class: "toolbar-pill-btn cd-bar-toggle",
        type: "button",
        text: t(`chipdesign.debug.${key}`),
        title: t(`chipdesign.debug.${key}Title`),
        "aria-pressed": "false",
        onClick: () => onChange(btn.getAttribute("aria-pressed") !== "true"),
      });
      return btn;
    };
    this.#settled = toggle("breakSettled", (v) => on.breakSettled?.(v));
    this.#lamp = el("span", { class: "cd-lamp", "aria-hidden": "true" });
    const lampLabel = el("span", {
      class: "cd-lamp-label",
      text: t("chipdesign.debug.settled"),
    });
    this.#status = el("span", { class: "cd-bar-status", role: "status" });
    this.#root = el("div", { class: "cd-bar" }, [
      el("div", { class: "toolbar-pill" }, Object.values(this.#buttons)),
      el("div", { class: "toolbar-pill" }, [
        el("span", {
          class: "cd-bar-label",
          text: t("chipdesign.debug.breakOn"),
        }),
        this.#settled,
      ]),
      el(
        "div",
        { class: "cd-bar-lamp", title: t("chipdesign.debug.settledTitle") },
        [
          // prettier-ignore
          this.#lamp,
          lampLabel,
        ],
      ),
      this.#status,
    ]);
  }

  get element() {
    return this.#root;
  }

  /**
   * Press a transport button by its key (`continue`, `step`, …) — nothing
   * when the button is disabled.
   * @returns {boolean} whether it was pressed.
   */
  press(key) {
    const btn = this.#buttons[key];
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  }

  /**
   * Bring the bar in line with the debugger.
   * @param {object|null} tab - the focused tab's view (chip-debugger.js).
   * @param {object} debug - the debugger's whole view.
   */
  update(tab, debug) {
    const paused = tab?.state === "paused";
    const session = debug?.paused === true;
    this.#buttons.step.disabled = !paused;
    this.#buttons.stepOut.disabled = !paused;
    this.#buttons.continue.disabled = !session;
    this.#buttons.toSettled.disabled = !session || debug.atSettled;
    this.#buttons.detach.disabled =
      !tab || !(tab.armed.lines || tab.armed.settled || paused);
    const settledOn = Boolean(tab?.armed.settled);
    this.#settled.disabled = !tab;
    this.#settled.setAttribute("aria-pressed", String(settledOn));
    this.#settled.classList.toggle("toolbar-btn--active", settledOn);
    const settled = debug?.settled !== false;
    this.#lamp.classList.toggle("cd-lamp--settled", settled);
    this.#lamp.classList.toggle("cd-lamp--busy", !settled);
    this.#status.textContent = statusText(tab, debug);
  }
}

/** The one-line account of where the debugger is. */
function statusText(tab, debug) {
  if (!debug?.running) return "";
  if (debug.atSettled) return t("chipdesign.debug.statusAtSettled");
  if (tab?.state === "paused") {
    if (tab.phase === "nba") return t("chipdesign.debug.statusNba");
    const p = tab.progress;
    return t("chipdesign.debug.statusPaused", {
      index: (p?.index ?? 0) + 1,
      count: p?.count ?? 1,
    });
  }
  if (debug.paused) return t("chipdesign.debug.statusElsewhere");
  if (tab && !(tab.armed.lines || tab.armed.settled)) {
    return t("chipdesign.debug.statusNotArmed");
  }
  return t("chipdesign.debug.statusRunning");
}

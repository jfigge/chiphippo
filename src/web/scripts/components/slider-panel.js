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

// slider-panel.js — what a floated slider's window (web/slider.html, entry
// slider.js) draws: the field's label and the Properties card's own slider
// (range-control.js), ends and all, filling the window. It is told everything
// it shows (`show(state)`, from components/slider-windows.js in the app
// window, relayed by main) and reports every move (`onSet`), numbered: a
// state answering an OLDER move than the last one made here leaves the thumb
// where the user has it, so a quick drag is never pulled back by its echo.
//
// Keys and wheel: the arrows step 1, as a range input does natively;
// Shift+arrow and PageUp/PageDown step 10; the wheel steps 1 a notch, up
// raising it. A tapped Space is passed on (`onRunToggle`) — this window has
// the focus, and Space runs and stops the circuit it is turning.

import { el } from "../dom.js";
import { buildRangeControl, fillRangeEnds } from "./range-control.js";

/** The larger step (Shift+arrow, PageUp/PageDown), in the field's steps. */
const BIG_STEP = 10;

export class SliderPanel {
  #root;
  #onSet;
  #onHover;
  #onRunToggle;
  #label;
  #body;
  #input = null;
  /** The state shown, and the shape its control was built for. */
  #state = null;
  #shape = null;
  /** The last move sent. */
  #seq = 0;
  #hovered = false;
  #focused = false;

  /**
   * @param {HTMLElement} root
   * @param {object} opts
   * @param {(value: number, seq: number) => void} opts.onSet
   * @param {(on: boolean) => void} [opts.onHover]
   * @param {() => void} [opts.onRunToggle]
   */
  constructor(root, { onSet, onHover, onRunToggle }) {
    this.#root = root;
    this.#onSet = onSet;
    this.#onHover = onHover;
    this.#onRunToggle = onRunToggle;
    this.#label = el("span", { class: "slider-label" });
    this.#body = el("div", { class: "slider-body" });
    root.append(this.#label, this.#body);
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    doc.documentElement.addEventListener("pointerenter", () => this.#hover("hovered", true)); // prettier-ignore
    doc.documentElement.addEventListener("pointerleave", () => this.#hover("hovered", false)); // prettier-ignore
    win.addEventListener("focus", () => this.#hover("focused", true));
    win.addEventListener("blur", () => this.#hover("focused", false));
    win.addEventListener("wheel", (e) => this.#onWheel(e), { passive: false });
    win.addEventListener("keyup", (e) => {
      if (e.key !== " " || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return; // prettier-ignore
      e.preventDefault();
      this.#onRunToggle?.();
    });
  }

  /** The window's title: the part, then the field. */
  get title() {
    return this.#state ? `${this.#state.title} — ${this.#state.label}` : "";
  }

  /**
   * Show what the app window says.
   * @param {{title: string, label: string, min: number, max: number,
   *   step: number, valuePercent?: boolean, value: number,
   *   ends: string[]|null, seq: number}} state
   */
  show(state) {
    if (state?.kind !== "state") return;
    this.#state = state;
    this.#label.textContent = state.label;
    this.#root.setAttribute("aria-label", this.title);
    const shape = JSON.stringify([state.min, state.max, state.step, Boolean(state.ends), Boolean(state.valuePercent)]); // prettier-ignore
    // Built afresh for a new shape, or — a slider with a percentage it keeps
    // to itself — for a value changed elsewhere; otherwise the thumb takes
    // the value, unless the user has moved it since.
    const current = state.seq >= this.#seq;
    if (!this.#input || shape !== this.#shape) {
      this.#mount(state);
    } else if (current && Number(this.#input.value) !== state.value) {
      if (state.ends) this.#input.value = String(state.value);
      else this.#mount(state);
    }
    this.#shape = shape;
    if (state.ends) fillRangeEnds(this.#body, state.ends);
  }

  #mount(state) {
    this.#body.replaceChildren();
    const field = {
      key: "value",
      min: state.min,
      max: state.max,
      step: state.step,
      valuePercent: state.valuePercent,
      ends: Boolean(state.ends),
    };
    const control = buildRangeControl(
      field,
      state.value,
      (_key, value) => this.#onSet(value, ++this.#seq),
      state.label,
    );
    this.#body.append(control);
    this.#input = control.querySelector(".properties-range-input");
    this.#input.addEventListener("keydown", (e) => this.#onKey(e));
    // The window's one control: the keys are always its.
    this.#input.focus();
  }

  // ── Keys and wheel ──────────────────────────────────────────────────────

  /** Move the thumb `steps` of the field's step, as a drag would. */
  #nudge(steps) {
    const input = this.#input;
    if (!input || !this.#state) return;
    const { min, max, step } = this.#state;
    const next = Math.min(max, Math.max(min, Number(input.value) + steps * step)); // prettier-ignore
    if (next === Number(input.value)) return;
    input.value = String(next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  #onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const up = e.key === "ArrowUp" || e.key === "ArrowRight";
    const down = e.key === "ArrowDown" || e.key === "ArrowLeft";
    let steps = 0;
    if (e.key === "PageUp") steps = BIG_STEP;
    else if (e.key === "PageDown") steps = -BIG_STEP;
    else if (e.shiftKey && up) steps = BIG_STEP;
    else if (e.shiftKey && down) steps = -BIG_STEP;
    if (!steps) return; // a plain arrow, Home, End: the input's own
    e.preventDefault();
    this.#nudge(steps);
  }

  #onWheel(e) {
    const delta = e.deltaY || e.deltaX;
    if (!delta) return;
    e.preventDefault();
    this.#nudge(delta < 0 ? 1 : -1);
  }

  #hover(which, on) {
    const was = this.#hovered || this.#focused;
    if (which === "hovered") this.#hovered = on;
    else this.#focused = on;
    const now = this.#hovered || this.#focused;
    if (now !== was) this.#onHover?.(now);
  }
}

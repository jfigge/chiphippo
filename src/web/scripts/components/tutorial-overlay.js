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

// tutorial-overlay.js — the layer a tutorial plays on: a transparent sheet
// over the whole window that dims everything but the step's target, draws the
// callout and its decoration (brace, arrow or ring), carries the fake cursor,
// and holds the tutorial's controls: Previous · Pause/Resume · Next · Exit.
//
// IT IS ALSO THE INPUT BLOCK. While it is up it takes every pointer event
// (it covers the window and sits above every docked panel and toast) and a
// capture-phase keydown on the window swallows every key — except Escape,
// which exits, and the keys that operate its own controls. The app underneath
// is driven only by the player, through the app's own handlers; the real
// pointer never reaches it. (Popups live in the browser's top layer, above
// any z-index — the tutorial opens none while it plays.)
//
// Layout is re-derived EVERY FRAME from the target registry: resolve id →
// rect, measure the card, place it (tutorials/geometry.js). That is what keeps
// a callout on its target through a window resize, a tray sliding open or a
// font-size step — nothing is cached but the last layout's key, which is what
// stops an unchanged frame from touching the DOM.

import { el, svgEl } from "../dom.js";
import { t } from "../i18n.js";
import {
  arrowPath,
  bracePath,
  normRect,
  placeCallout,
  ringPath,
  spotlightPath,
} from "../tutorials/geometry.js";
import { targetRect } from "../tutorials/targets.js";

/** The fake pointer: an arrow cursor, drawn in its own 24-unit box with the
    hot spot at the top-left corner (where the real one's is). */
const CURSOR_SVG =
  '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">' +
  '<path d="M3 2 L3 19 L7.5 14.8 L10.6 21.6 L13.6 20.3 L10.6 13.6 L16.6 13.6 Z" ' +
  'class="tutorial-cursor-shape"/></svg>';

export class TutorialOverlay {
  #root;
  #shade;
  #decor;
  #card;
  #text;
  #counter;
  #cursor;
  #controls;
  #previousBtn;
  #pauseBtn;
  #nextBtn;
  #exitBtn;
  #onExit;
  #onNext;
  #onPrevious;
  #onTogglePause;
  #rect;
  #step = null; // what showStep last said
  #layoutKey = "";
  #raf = 0;
  #mod;

  /**
   * @param {object} opts
   * @param {string} opts.title - the tutorial's (translated) title, its label.
   * @param {() => void} opts.onExit
   * @param {() => void} opts.onNext
   * @param {() => void} opts.onPrevious
   * @param {() => void} opts.onTogglePause
   * @param {string} [opts.mod] - "⌘" or "Ctrl", for `{mod}` in callout text.
   * @param {(id: string) => object|null} [opts.rect] - the target resolver
   *   (the registry's, unless a test hands its own).
   */
  constructor({
    title,
    onExit,
    onNext,
    onPrevious,
    onTogglePause,
    mod = "Ctrl",
    rect = targetRect,
  }) {
    this.#onExit = onExit;
    this.#onNext = onNext;
    this.#onPrevious = onPrevious;
    this.#onTogglePause = onTogglePause;
    this.#rect = rect;
    this.#mod = mod;

    this.#shade = svgEl("path", {
      class: "tutorial-shade",
      "fill-rule": "evenodd",
    });
    this.#decor = svgEl("path", { class: "tutorial-decoration" });
    const svg = svgEl(
      "svg",
      { class: "tutorial-canvas", "aria-hidden": "true" },
      [this.#shade, this.#decor],
    );

    this.#text = el("p", { class: "tutorial-callout-text" });
    this.#counter = el("span", { class: "tutorial-callout-step" });
    this.#card = el(
      "div",
      { class: "tutorial-callout", "aria-live": "polite", hidden: true },
      [this.#text, this.#counter],
    );

    this.#cursor = el("div", { class: "tutorial-cursor", hidden: true });
    this.#cursor.innerHTML = CURSOR_SVG;

    this.#previousBtn = el("button", {
      class: "btn btn--secondary tutorial-control",
      type: "button",
      text: t("tutorials.controls.previous"),
      disabled: true, // until a step after the first is showing
      onClick: () => this.#onPrevious?.(),
    });
    this.#pauseBtn = el("button", {
      class: "btn btn--secondary tutorial-control",
      type: "button",
      text: t("tutorials.controls.pause"),
      onClick: () => this.#onTogglePause?.(),
    });
    this.#nextBtn = el("button", {
      class: "btn btn--secondary tutorial-control",
      type: "button",
      text: t("tutorials.controls.next"),
      onClick: () => this.#onNext?.(),
    });
    this.#exitBtn = el("button", {
      class: "btn btn--primary tutorial-control",
      type: "button",
      text: t("tutorials.controls.exit"),
      title: t("tutorials.controls.exitTitle"),
      onClick: () => this.#onExit?.(),
    });
    this.#controls = el(
      "div",
      {
        class: "tutorial-controls",
        role: "toolbar",
        "aria-label": t("tutorials.controls.label"),
      },
      [this.#previousBtn, this.#pauseBtn, this.#nextBtn, this.#exitBtn],
    );

    this.#root = el(
      "div",
      {
        class: "tutorial-overlay",
        role: "region",
        "aria-label": t("tutorials.overlay.label", { title }),
      },
      [svg, this.#card, this.#cursor, this.#controls],
    );
    // Nothing underneath may be reached: no context menu, no wheel zoom.
    this.#root.addEventListener("contextmenu", (e) => e.preventDefault());
    this.#root.addEventListener("wheel", (e) => e.preventDefault(), {
      passive: false,
    });
  }

  get element() {
    return this.#root;
  }

  /** The window, which is what every coordinate here is in. */
  get size() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  mount(parent = document.body) {
    parent.append(this.#root);
    window.addEventListener("keydown", this.#onKey, true);
    window.addEventListener("resize", this.#relayout);
    this.#exitBtn.focus({ preventScroll: true });
    this.#tick();
  }

  unmount() {
    window.removeEventListener("keydown", this.#onKey, true);
    window.removeEventListener("resize", this.#relayout);
    if (this.#raf && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.#raf);
    }
    this.#raf = 0;
    this.#root.remove();
  }

  /** Put a step on screen. */
  showStep({ index, total, target, callout, canPrevious = false }) {
    this.#step = { target, callout };
    // A focused button that goes disabled drops focus to <body>, where the
    // overlay swallows Tab — so hand it on to Pause first.
    if (!canPrevious && document.activeElement === this.#previousBtn) {
      this.#pauseBtn.focus({ preventScroll: true });
    }
    this.#previousBtn.disabled = !canPrevious;
    this.#text.textContent = t(callout.text, { mod: this.#mod });
    this.#counter.textContent = t("tutorials.controls.step", {
      n: index + 1,
      total,
    });
    this.#card.hidden = false;
    this.#layoutKey = "";
    this.#layout();
  }

  setCursor(point) {
    if (!point) {
      this.#cursor.hidden = true;
      return;
    }
    this.#cursor.hidden = false;
    this.#cursor.style.transform = `translate(${point.x}px, ${point.y}px)`;
  }

  setPressed(on) {
    this.#cursor.classList.toggle("tutorial-cursor--pressed", on === true);
  }

  setPaused(paused) {
    this.#pauseBtn.textContent = paused
      ? t("tutorials.controls.resume")
      : t("tutorials.controls.pause");
    this.#root.classList.toggle("tutorial-overlay--paused", paused === true);
  }

  // ── Layout ───────────────────────────────────────────────────────────────

  #relayout = () => {
    this.#layoutKey = "";
    this.#layout();
  };

  /** Re-derive every frame: a target can move without the window resizing. */
  #tick = () => {
    if (!this.#root.isConnected) return;
    this.#layout();
    if (typeof requestAnimationFrame === "function") {
      this.#raf = requestAnimationFrame(this.#tick);
    }
  };

  #layout() {
    if (!this.#step) return;
    const view = this.size;
    const { target, callout } = this.#step;
    const rect = target ? normRect(this.#rect(target)) : null;
    const size = {
      width: this.#card.offsetWidth,
      height: this.#card.offsetHeight,
    };
    const key = JSON.stringify([view, rect, size, target, callout.text]);
    if (key === this.#layoutKey) return;
    this.#layoutKey = key;

    const placed = placeCallout({
      rect,
      size,
      placement: callout.placement,
      decoration: callout.decoration,
      view,
    });
    this.#card.style.left = `${placed.x}px`;
    this.#card.style.top = `${placed.y}px`;
    this.#shade.setAttribute("d", spotlightPath(view, rect));

    let d = "";
    if (rect && placed.side) {
      if (callout.decoration === "brace") {
        d = bracePath(rect, placed.side).d;
      } else if (callout.decoration === "arrow") {
        const box = { left: placed.x, top: placed.y, ...size };
        d = arrowPath(rect, box, placed.side).d;
      }
    }
    if (rect && callout.decoration === "ring") d = ringPath(rect);
    this.#decor.setAttribute("d", d);
    this.#decor.dataset.kind = callout.decoration;
  }

  // ── Keys ─────────────────────────────────────────────────────────────────

  /** Capture phase, on the window: this runs before every other listener in
      the app, so a swallowed key never reaches the desk, the shortcuts or
      the transport. Escape exits; Tab, Enter and Space stay with the
      overlay's own buttons (they are how a keyboard reaches them). */
  #onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.#onExit?.();
      return;
    }
    const own = e.target?.nodeType != null && this.#controls.contains(e.target);
    if (own && (e.key === "Tab" || e.key === "Enter" || e.key === " ")) {
      if (e.key === "Tab") this.#trapTab(e);
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  /** Keep Tab cycling among the controls that can be pressed. */
  #trapTab(e) {
    const buttons = [
      this.#previousBtn,
      this.#pauseBtn,
      this.#nextBtn,
      this.#exitBtn,
    ].filter((b) => !b.disabled);
    const at = buttons.indexOf(document.activeElement);
    const next = (at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
    e.preventDefault();
    buttons[next].focus();
  }
}

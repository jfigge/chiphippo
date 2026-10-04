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

// info-button.js — the app's (i): a small circled glyph beside something,
// opening a POPOVER with an explanation that is worth having but not worth the
// room it takes when you are not reading it.
//
// Shared rather than per-dialog, and un-prefixed for the same reason
// `segmented-picker.js` and `color-swatches.js` are: two dialogs meet the same
// control (About's version details, and every note in Settings), so there is
// one look and one behaviour, not two that drift.
//
// Deliberately NOT a `PopupManager.popover`: PopupManager QUEUES a second popup
// rather than stacking it, so a card raised from inside the Settings modal
// would not appear at all until Settings closed. The card is therefore an
// ordinary element the caller owns and positions, shown and hidden here — but
// it is dismissed the three ways a popup is: Escape, a click outside it, or the
// (i) again.
//
// ESCAPE IS THE WHOLE REASON THIS IS NOT FIVE LINES INLINE. Both callers live
// inside a native modal `<dialog>`, where Escape fires `cancel` and closes the
// WHOLE dialog — so a note opened in Settings could only be dismissed by
// throwing away the Settings card with it. The keydown is caught in the CAPTURE
// phase and `preventDefault`ed, which is what stops the browser's own
// close-request before the dialog ever sees it: Escape closes the note, and the
// next Escape closes the dialog.

import { el } from "../dom.js";

/** A circled lowercase i: the dot, then the stem. */
const INFO_SVG =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
  '<circle cx="8" cy="4" r="1.25" fill="currentColor"/>' +
  '<rect x="7" y="6.5" width="2" height="6" rx="1" fill="currentColor"/></svg>';

/**
 * Build an (i) that opens `target` as a popover.
 *
 * The target's `hidden` attribute is the single source of truth — nothing here
 * keeps a flag of its own, so a caller that hides the target itself (a rebuild,
 * a panel switch) can never leave the two disagreeing.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.target - the card to show. Needs an `id`, which is
 *   what `aria-controls` points at; the caller owns its position and styling.
 * @param {string} opts.label - the button's accessible name AND its tooltip.
 * @param {(shown: boolean) => void} [opts.onToggle]
 * @returns {HTMLButtonElement}
 */
export function buildInfoButton({ target, label, onToggle }) {
  /** Dismissal listeners, live only while the card is open. */
  let detach = null;

  const setOpen = (show) => {
    target.toggleAttribute("hidden", !show);
    btn.setAttribute("aria-expanded", String(show));
    detach?.();
    detach = show ? watch() : null;
    onToggle?.(show);
  };

  const watch = () => {
    const onKeyDown = (e) => {
      if (e.key !== "Escape") return;
      // Capture + preventDefault: this Escape is the browser's close-request
      // for the surrounding <dialog>, and without stopping it here the note
      // would take the whole dialog with it.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      btn.focus();
    };
    const onDown = (e) => {
      if (!target.contains(e.target) && !btn.contains(e.target)) setOpen(false);
    };
    // A card whose dialog was torn down while it was open would otherwise leave
    // these behind, holding a detached node for the life of the page.
    const alive = () => {
      if (target.isConnected) return true;
      stop();
      return false;
    };
    const key = (e) => alive() && onKeyDown(e);
    const down = (e) => alive() && onDown(e);
    const stop = () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", down, true);
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", down, true);
    return stop;
  };

  const btn = el("button", {
    class: "info-btn",
    type: "button",
    "aria-controls": target.id,
    "aria-expanded": "false",
    "aria-label": label,
    title: label,
    onClick: () => setOpen(target.hasAttribute("hidden")),
  });
  btn.innerHTML = INFO_SVG;
  return btn;
}

/**
 * The same (i) as a MARK rather than a control: the glyph and its circle,
 * carrying its explanation as a hover tooltip — for a place a button cannot
 * go, such as inside another button (a parts-tray header, which folds its
 * group on a click). `variant` recolours it and changes nothing else
 * (`danger`: red).
 *
 * @param {object} opts
 * @param {string} opts.label - the tooltip, and the mark's accessible name.
 * @param {string} [opts.variant]
 * @returns {HTMLSpanElement}
 */
export function buildInfoMark({ label, variant }) {
  const mark = el("span", {
    class: `info-btn info-btn--mark${variant ? ` info-btn--${variant}` : ""}`,
    role: "img",
    "aria-label": label,
    title: label,
  });
  mark.innerHTML = INFO_SVG;
  return mark;
}

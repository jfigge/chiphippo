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

// header-fit.js — keeps the header toolbar inside the room it has. The
// toolbar's width is not something CSS can be told in advance: it depends on
// the language (Japanese's transport is half again English's), the font size
// (11–18) and whether the circuit is RUNNING (the transport pill grows from
// one segment to four). So rather than guess breakpoints, the header is
// MEASURED and given the fewest of these steps that make it fit, in order of
// what is least missed:
//
//   1. `--tight`   the gaps between the brand, the pills and the gear halve;
//   2. `--no-logo` the "Chip Hippo" wordmark goes (the icon stays, and is
//                  still the About button);
//   3. `--glyphs`  the transport segments drop their words to their glyphs
//                  (▶ ■ ⏸ ⇥ — the word stays as the accessible name, and the
//                  tooltip names the action);
//   4. `--scroll`  the DESK-TOOLS pill gives up the rest, scrolling inside its
//                  own border (a wheel turned over it scrolls it), so File and
//                  the transport — Run/Stop above all — are never cut, and the
//                  toolbar clips rather than reach under the gear.
//
// A fit TIGHTENS at once — a step is added the moment the content is wider
// than the toolbar — but only RELAXES a step when the toolbar would then fit
// with `HEADER_FIT_SLACK` px to spare. Without that band a header sitting at a
// step's boundary flipped it every time a readout ticked a digit wider or
// narrower (the speed readout while a heavy desk falls behind: up to ~12 Hz,
// the Run word and the tools pill jumping with it). So within those few px the
// steps depend on which way the room last moved; outside them a fit is still
// the fewest steps that make it fit, and a fit never feeds its own resize.

export const HEADER_FIT_STEPS = Object.freeze([
  "app-header--tight",
  "app-header--no-logo",
  "app-header--glyphs",
  "app-header--scroll",
]);

/** The room a relaxed step must leave over, in px (the hysteresis band). */
export const HEADER_FIT_SLACK = 8;

const SCROLL_STEP = HEADER_FIT_STEPS.length - 1;

/**
 * The toolbar's room left over, in px: negative while its content overflows,
 * otherwise the gap between the last pill's right edge and the toolbar's own.
 * (`scrollWidth` alone cannot say how much room is LEFT — it never reads less
 * than `clientWidth`.)
 */
function spareRoom(toolbar) {
  const over = toolbar.scrollWidth - toolbar.clientWidth;
  if (over > 0) return -over;
  let right = -Infinity;
  for (const pill of toolbar.children) {
    const r = pill.getBoundingClientRect();
    if (r.width > 0 && r.right > right) right = r.right;
  }
  if (right === -Infinity) return toolbar.clientWidth;
  const box = toolbar.getBoundingClientRect();
  return box.left + toolbar.clientLeft + toolbar.clientWidth - right;
}

/**
 * Bring `header`'s steps to what `toolbar` needs: add steps, in order, while
 * the content overflows; otherwise take the last step off for as long as the
 * toolbar then fits with `slack` px to spare.
 *
 * @param {HTMLElement} header - `.app-header`
 * @param {HTMLElement} toolbar - `.app-header-toolbar`
 * @param {{scroller?: HTMLElement|null, slack?: number}} [opts] - the pill the
 *   last step scrolls (its scroll position survives a relax that was tried
 *   and put back), and the hysteresis band
 * @returns {number} how many steps are taken (0 = none needed).
 */
export function fitHeader(
  header,
  toolbar,
  { scroller = null, slack = HEADER_FIT_SLACK } = {},
) {
  const list = header.classList;
  // The steps are always a prefix of the list; anything past a gap is stray.
  let taken = 0;
  while (
    taken < HEADER_FIT_STEPS.length &&
    list.contains(HEADER_FIT_STEPS[taken])
  )
    taken += 1;
  for (let i = taken; i < HEADER_FIT_STEPS.length; i += 1)
    if (list.contains(HEADER_FIT_STEPS[i])) list.remove(HEADER_FIT_STEPS[i]);

  if (spareRoom(toolbar) < 0) {
    while (taken < HEADER_FIT_STEPS.length && spareRoom(toolbar) < 0) {
      list.add(HEADER_FIT_STEPS[taken]);
      taken += 1;
    }
    return taken;
  }
  // Trying the scroll step off un-scrolls the tools pill, which loses its
  // place; put it back if the step is.
  const scrolled = taken > SCROLL_STEP ? (scroller?.scrollLeft ?? 0) : 0;
  while (taken > 0) {
    list.remove(HEADER_FIT_STEPS[taken - 1]);
    if (spareRoom(toolbar) >= slack) {
      taken -= 1;
      continue;
    }
    list.add(HEADER_FIT_STEPS[taken - 1]);
    if (taken - 1 === SCROLL_STEP && scroller && scrolled)
      scroller.scrollLeft = scrolled;
    break;
  }
  return taken;
}

/**
 * Keep `header` fitted from now on: refitted whenever the header (the window,
 * the font size) or any toolbar pill (a relabel, Run, the speed readout)
 * changes size. The refit waits for the next frame — run inside the observer's
 * callback it would resize what that callback is reporting on, which the
 * browser answers with a "loop limit" error.
 *
 * At the scrolling step the scroller also says WHICH of its edges clip
 * (`toolbar-pill--clip-start` / `--clip-end`, faded in app.css), and a tool
 * focused from the keyboard is scrolled fully into view — the browser's own
 * focus scroll only acts on a button wholly out of sight, so one half under
 * the edge stayed half there.
 *
 * @param {HTMLElement} header - `.app-header`
 * @param {HTMLElement} toolbar - `.app-header-toolbar`, already populated
 * @param {HTMLElement|null} [scroller] - the pill that scrolls at the last step
 * @returns {{refit: () => void, disconnect: () => void}}
 */
export function watchHeaderFit(header, toolbar, scroller = null) {
  let frame = 0;
  const scrolling = () =>
    header.classList.contains(HEADER_FIT_STEPS[SCROLL_STEP]);
  const markEdges = () => {
    if (!scroller) return;
    const on = scrolling();
    const left = scroller.scrollLeft;
    const end = scroller.scrollWidth - scroller.clientWidth;
    // toggle(…, force) writes nothing when the class is already as asked.
    scroller.classList.toggle("toolbar-pill--clip-start", on && left > 0.5);
    scroller.classList.toggle("toolbar-pill--clip-end", on && left < end - 0.5);
  };
  const refit = () => {
    frame = 0;
    fitHeader(header, toolbar, { scroller });
    markEdges();
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(refit);
  };
  const observer =
    typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  observer?.observe(header);
  for (const pill of toolbar.children) observer?.observe(pill);
  // Only the scrolling step has anything to scroll; a mouse wheel turns
  // vertically, so it is turned into the pill's horizontal scroll there.
  const onWheel = (e) => {
    if (!scrolling()) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    scroller.scrollLeft += e.deltaY;
    e.preventDefault();
  };
  // A focused tool lands clear of the fade too (the pill's own scroll only —
  // never scrollIntoView, which would move the toolbar and the page with it).
  // KEYBOARD focus only: a press focuses its button too, and scrolling then
  // slid the button out from under the pointer, so the release landed on the
  // pill and the click was lost (regrade 7, 2026-10-28).
  let pressing = false;
  const onPress = () => {
    pressing = true;
  };
  const onRelease = () => {
    pressing = false;
  };
  const onFocus = (e) => {
    if (pressing || !scrolling() || !(e.target instanceof Element)) return;
    const box = scroller.getBoundingClientRect();
    const inner = box.left + scroller.clientLeft;
    const fade = Math.min(
      parseFloat(getComputedStyle(scroller).getPropertyValue("--tools-fade")) ||
        0,
      scroller.clientWidth / 4,
    );
    const r = e.target.getBoundingClientRect();
    const from = inner + fade;
    const to = inner + scroller.clientWidth - fade;
    if (r.left < from) scroller.scrollLeft -= from - r.left;
    else if (r.right > to) scroller.scrollLeft += r.right - to;
  };
  scroller?.addEventListener("wheel", onWheel, { passive: false });
  scroller?.addEventListener("pointerdown", onPress, true);
  scroller?.ownerDocument.addEventListener("pointerup", onRelease, true);
  scroller?.ownerDocument.addEventListener("pointercancel", onRelease, true);
  scroller?.addEventListener("focusin", onFocus);
  scroller?.addEventListener("scroll", markEdges, { passive: true });
  refit();
  return {
    refit,
    disconnect() {
      observer?.disconnect();
      scroller?.removeEventListener("wheel", onWheel);
      scroller?.removeEventListener("pointerdown", onPress, true);
      scroller?.ownerDocument.removeEventListener("pointerup", onRelease, true);
      scroller?.ownerDocument.removeEventListener(
        "pointercancel",
        onRelease,
        true,
      );
      scroller?.removeEventListener("focusin", onFocus);
      scroller?.removeEventListener("scroll", markEdges);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}

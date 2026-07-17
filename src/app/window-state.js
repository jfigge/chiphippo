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

// window-state.js — remember the main window's position and size across
// launches. `resolveWindowBounds` is a pure decision (kept dependency-free so
// it unit-tests without Electron): it returns saved bounds ONLY when they
// still appear on a connected display and are no larger than that display's
// work area — otherwise the defaults, so a window saved on a now-disconnected
// monitor (or a display that shrank) never opens off-screen or oversized.
// `trackWindowState` wires a live BrowserWindow's move/resize/close to a
// debounced save. Ported from Port Hippo (src/app/window-state.js).
"use strict";

// The window's opening size when nothing valid is stored. No x/y → Electron
// centres it on the primary display.
const DEFAULT_BOUNDS = Object.freeze({ width: 1280, height: 800 });

// Minimum slice of the window (px, each axis) that must overlap a display for
// it to count as "on screen" — enough to grab the title bar and drag it back.
const MIN_VISIBLE = 80;

// How long after the last move/resize to persist, so a drag writes once.
const SAVE_DEBOUNCE_MS = 500;

/** Coerce arbitrary stored data into a clean integer rect, or null if unusable. */
function normalizeBounds(b) {
  if (!b || typeof b !== "object") return null;
  const { x, y, width, height } = b;
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  if (width < 1 || height < 1) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/** The overlapping rectangle's size (0×0 when the two rects don't touch). */
function intersection(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return {
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/**
 * Are `bounds` restorable given the current displays? True when some display's
 * work area both contains the window (not larger than the screen) and overlaps
 * it enough to be reachable (appears on screen).
 *
 * @param {{x:number,y:number,width:number,height:number}} bounds
 * @param {Array<{bounds?:object, workArea?:object}>} displays  each display's
 *        `bounds` / `workArea` (as from Electron's `screen.getAllDisplays()`).
 * @returns {boolean}
 */
function isBoundsVisible(bounds, displays) {
  if (!bounds || !Array.isArray(displays)) return false;
  for (const d of displays) {
    const area = d && (d.workArea || d.bounds);
    if (
      !area ||
      !Number.isFinite(area.width) ||
      !Number.isFinite(area.height)
    ) {
      continue;
    }
    // "not larger than the screen" — must fit within this display's work area.
    if (bounds.width > area.width || bounds.height > area.height) continue;
    // "appears on screen" — a meaningful part overlaps this display.
    const o = intersection(bounds, area);
    if (
      o.width >= Math.min(bounds.width, MIN_VISIBLE) &&
      o.height >= Math.min(bounds.height, MIN_VISIBLE)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Choose the bounds to open the window with: the saved bounds when they're
 * still valid for `displays`, else a copy of `defaults`.
 *
 * @param {object|null} saved     the persisted `{x,y,width,height}` (or junk)
 * @param {Array<object>} displays  connected displays (bounds/workArea)
 * @param {object} [defaults]      fallback size (no x/y → centred)
 * @returns {object}
 */
function resolveWindowBounds(saved, displays, defaults = DEFAULT_BOUNDS) {
  const b = normalizeBounds(saved);
  if (b && isBoundsVisible(b, displays)) return b;
  return { ...defaults };
}

/**
 * Persist a live window's position/size. Debounces move/resize (so a drag
 * saves once it settles) and flushes on close. Reads the *normal* bounds so a
 * maximized/minimized window stores the size it restores to, never the
 * maximized frame. Minimized windows are skipped (their bounds are unreliable).
 *
 * @param {import('electron').BrowserWindow} win
 * @param {object} opts
 * @param {(bounds: {x:number,y:number,width:number,height:number}) => void} opts.save
 * @param {number} [opts.delay]  debounce window in ms (tests shrink it)
 * @returns {() => void}  a disposer that cancels the pending save
 */
function trackWindowState(win, { save, delay = SAVE_DEBOUNCE_MS } = {}) {
  let timer = null;

  const persist = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const getBounds = win.getNormalBounds || win.getBounds;
    const b = getBounds.call(win);
    if (!b) return;
    save({ x: b.x, y: b.y, width: b.width, height: b.height });
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      persist();
    }, delay);
  };

  win.on("resize", schedule);
  win.on("move", schedule);
  // Flush synchronously as the window goes away — the debounce may not have
  // fired yet, and on a real quit the window is about to be destroyed.
  win.on("close", () => {
    if (timer) clearTimeout(timer);
    timer = null;
    persist();
  });

  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

module.exports = {
  DEFAULT_BOUNDS,
  resolveWindowBounds,
  isBoundsVisible,
  trackWindowState,
};

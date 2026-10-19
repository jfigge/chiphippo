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

// tutorials/targets.js — the TARGET REGISTRY: a stable TutorialId
// (`componentTray`, `toolbar.save`, `desktop.tabs`, …) → the live widget it
// names.
//
// A tutorial's steps say WHAT to point at, never WHERE: the overlay resolves
// id → element → its current screen rectangle on every frame, so a tour
// survives a resize, a tray sliding open and a different font size. A widget
// registers when it is built and deregisters when it goes (the function
// `registerTarget` returns), and a widget whose element comes and goes with
// its own state — a tray section that is only drawn while open, the rail
// chevron that only exists while the tray is shut — registers a GETTER, which
// answers null whenever there is nothing to point at. Null is an answer, not
// an error: the player skips (or centres) a step whose target is absent.
//
// Module-level on purpose: there is one window and one tutorial at a time,
// and a widget registering itself should not need a handle on whoever plays
// the tour.

/** @type {Map<string, {get: () => (Element|Element[]|null), clip: Element|null}>} */
const registry = new Map();

/**
 * Register a target.
 * @param {string} id - the TutorialId the definitions name.
 * @param {Element|(() => Element|Element[]|null)} target - the element, or
 *   a getter for whichever element stands for it right now — or for SEVERAL,
 *   when the thing is drawn as more than one (a breadboard kit is a strip
 *   element per strip): its rectangle is then their union.
 * @param {{clip?: Element}} [opts] - `clip`: the element the target is seen
 *   THROUGH (a board on the desk is clipped by the desk's viewport, and on a
 *   narrow window runs on under the parts tray) — the rectangle is cut to it.
 * @returns {() => void} deregisters THIS registration (a later one under the
 *   same id is left alone).
 */
export function registerTarget(id, target, { clip = null } = {}) {
  const entry = {
    get: typeof target === "function" ? target : () => target,
    clip,
  };
  registry.set(id, entry);
  return () => {
    if (registry.get(id) === entry) registry.delete(id);
  };
}

/** Is `el` on screen at all — attached, and not hidden by an ancestor? */
function shown(el) {
  if (!el?.isConnected) return false;
  for (let node = el; node; node = node.parentElement) {
    if (node.hidden) return false;
  }
  return true;
}

/** Every on-screen element `id` names right now (none when unregistered). */
function resolveAll(id) {
  const entry = registry.get(id);
  if (!entry) return [];
  let found = null;
  try {
    found = entry.get();
  } catch (err) {
    console.error(`[tutorial] target "${id}" failed to resolve:`, err);
    return [];
  }
  return (Array.isArray(found) ? found : [found]).filter(shown);
}

/**
 * The element `id` names right now — the first, when it names several — or
 * null: unregistered, a getter with nothing to offer, or an element that is
 * detached or hidden.
 */
export function resolveTarget(id) {
  return resolveAll(id)[0] ?? null;
}

/**
 * The target's rectangle in window coordinates, or null when it cannot be
 * pointed at (absent, or laid out to nothing).
 * @returns {{left:number, top:number, width:number, height:number}|null}
 */
export function targetRect(id) {
  let box = null;
  for (const el of resolveAll(id)) {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 || r.height > 0)) continue;
    const right = r.left + r.width;
    const bottom = r.top + r.height;
    box = box
      ? {
          left: Math.min(box.left, r.left),
          top: Math.min(box.top, r.top),
          right: Math.max(box.right, right),
          bottom: Math.max(box.bottom, bottom),
        }
      : { left: r.left, top: r.top, right, bottom };
  }
  const clip = registry.get(id)?.clip;
  if (box && clip) {
    const c = clip.getBoundingClientRect();
    box = {
      left: Math.max(box.left, c.left),
      top: Math.max(box.top, c.top),
      right: Math.min(box.right, c.left + c.width),
      bottom: Math.min(box.bottom, c.top + c.height),
    };
    if (box.right <= box.left || box.bottom <= box.top) return null;
  }
  if (!box) return null;
  return {
    left: box.left,
    top: box.top,
    width: box.right - box.left,
    height: box.bottom - box.top,
  };
}

/** Every registered id (tests, and the definitions' integrity check). */
export function registeredTargets() {
  return [...registry.keys()];
}

/** Forget every registration (tests only). */
export function clearTargets() {
  registry.clear();
}

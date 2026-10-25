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

// accelerators.js — Electron's accelerator strings ("CmdOrCtrl+Shift+S"),
// read for the web build's menu: the label the menu shows beside an item, and
// whether a keydown is that chord. Pure, so web-host/tests/accelerators.test.js
// holds both to the menu main builds.

const NAMED_KEYS = {
  plus: "+",
  space: " ",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  enter: "Enter",
  return: "Enter",
  escape: "Escape",
  esc: "Escape",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

/**
 * @param {string} accel
 * @param {boolean} isMac - CmdOrCtrl is ⌘ there, Ctrl everywhere else.
 * @returns {{meta: boolean, ctrl: boolean, alt: boolean, shift: boolean,
 *   key: string}|null}
 */
export function parseAccelerator(accel, isMac) {
  if (typeof accel !== "string" || !accel) return null;
  const parts = accel.split("+");
  // "CmdOrCtrl+Plus" and a bare trailing "+" both mean the plus key.
  if (accel.endsWith("++")) parts.splice(-2, 2, "+");
  const chord = { meta: false, ctrl: false, alt: false, shift: false, key: "" };
  for (const raw of parts) {
    const p = raw.trim().toLowerCase();
    if (p === "cmdorctrl" || p === "commandorcontrol") {
      if (isMac) chord.meta = true;
      else chord.ctrl = true;
    } else if (
      p === "cmd" ||
      p === "command" ||
      p === "super" ||
      p === "meta"
    ) {
      chord.meta = true;
    } else if (p === "ctrl" || p === "control") {
      chord.ctrl = true;
    } else if (p === "alt" || p === "option" || p === "altgr") {
      chord.alt = true;
    } else if (p === "shift") {
      chord.shift = true;
    } else {
      chord.key =
        NAMED_KEYS[p] ?? (/^f\d{1,2}$/.test(p) ? p.toUpperCase() : raw.trim());
    }
  }
  return chord.key ? chord : null;
}

/** Does this keydown press the chord? Letters and digits also match by
    physical key, so a non-Latin layout still reaches ⌘S. */
export function matchesAccelerator(chord, e) {
  if (!chord) return false;
  if (
    Boolean(e.metaKey) !== chord.meta ||
    Boolean(e.ctrlKey) !== chord.ctrl ||
    Boolean(e.altKey) !== chord.alt ||
    Boolean(e.shiftKey) !== chord.shift
  ) {
    return false;
  }
  const key = chord.key;
  if (key.length === 1) {
    const want = key.toLowerCase();
    if (String(e.key ?? "").toLowerCase() === want) return true;
    if (/^[a-z]$/.test(want)) return e.code === `Key${want.toUpperCase()}`;
    if (/^[0-9]$/.test(want)) return e.code === `Digit${want}`;
    if (want === "/") return e.code === "Slash";
    if (want === ",") return e.code === "Comma";
    return false;
  }
  return e.key === key;
}

const MAC_GLYPHS = { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" };
const KEY_LABELS = {
  " ": "Space",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
};

/** The chord as a menu shows it: "⇧⌘S" on a Mac, "Ctrl+Shift+S" elsewhere. */
export function acceleratorLabel(accel, isMac) {
  const chord = parseAccelerator(accel, isMac);
  if (!chord) return "";
  const key =
    KEY_LABELS[chord.key] ??
    (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  if (isMac) {
    return `${chord.ctrl ? MAC_GLYPHS.ctrl : ""}${chord.alt ? MAC_GLYPHS.alt : ""}${chord.shift ? MAC_GLYPHS.shift : ""}${chord.meta ? MAC_GLYPHS.meta : ""}${key}`;
  }
  return [
    chord.ctrl && "Ctrl",
    chord.alt && "Alt",
    chord.shift && "Shift",
    chord.meta && "Win",
    key,
  ]
    .filter(Boolean)
    .join("+");
}

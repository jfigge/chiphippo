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

// feature-flags.js — the renderer's read of the launch's feature flags
// (app/feature-flags.js decides them; main answers `app:features`). Asked
// ONCE at boot (app.js `init`), so every later question is synchronous:
//
//   if (featureEnabled("<name>")) { …offer the feature… }
//
// A window that never loads them sees every flag OFF — the shipped build's
// answer, and the safe one. Hiding the UI is half the gate: main refuses a
// flagged feature's IPC on its own (a renderer flag is no permission).

let enabled = new Set();

/**
 * Ask main which flags are on. Never throws: a failed ask leaves every flag
 * off.
 * @param {{getFeatures?: () => Promise<unknown>}} [bridge]
 * @returns {Promise<string[]>}
 */
export async function loadFeatures(bridge = globalThis.window?.chiphippo) {
  let list = [];
  try {
    list = (await bridge?.getFeatures?.()) ?? [];
  } catch {
    list = [];
  }
  enabled = new Set(
    Array.isArray(list) ? list.filter((f) => typeof f === "string") : [],
  );
  return [...enabled];
}

/** Is the flagged feature `name` switched on for this launch? */
export const featureEnabled = (name) => enabled.has(name);

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

// chip-status.js — a chip's power/health states, the engine's verdict on each
// powered part (sim/engine.js `buildContext`). Its own module so the settle
// primitives (settle-pass.js) can read it without importing the engine.

/** Chip power/health states. Only "ok" chips drive their outputs. */
export const CHIP_STATUS = Object.freeze({
  OK: "ok",
  UNPOWERED: "unpowered",
  UNDERPOWERED: "underpowered",
  REVERSED: "reversed",
  DAMAGED: "damaged",
  // Spice Lite's "brown smoke": a pin pushed past its absolute maximum — an
  // output's current or power, an input's clamp current, a switch channel's
  // current (sim/spice/params.js, loads.js). Like DAMAGED it is run-volatile
  // — written into params.overloaded by SimController, cleared by Stop,
  // dropped on load.
  OVERLOADED: "overloaded",
});

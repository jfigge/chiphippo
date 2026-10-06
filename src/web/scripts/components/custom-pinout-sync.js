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

// custom-pinout-sync.js — keeps a CUSTOM chip's open pin-assignments window
// showing the chip as it now is. That window is its own renderer with no
// catalog of the user's chips: it was handed what it shows when it opened
// (app.js's onOpenPinout, `customPinoutOf`), so a rename on the chip's
// Properties card, or a port added in the chip designer, has to be TOLD to it.
//
// On every change to the set of designs this works out which chips' pinouts
// actually moved — editing a chip's code changes none — and sends only those
// to main, which passes each to its window if one is open and drops the rest.
// A chip that has gone is sent as null, and main closes its window.

import { customPinoutOf } from "../model/custom-chip.js";

export class CustomPinoutSync {
  #bridge;
  #sent = new Map(); // chip id → the pinout last sent, as JSON

  /**
   * @param {object} opts
   * @param {object} opts.bridge - `window.chiphippo` (`pinout.*`).
   * @param {object[]} [opts.chips] - the designs as they stand now: no window
   *   can be showing anything older, so none of them is sent.
   */
  constructor({ bridge, chips = [] }) {
    this.#bridge = bridge;
    for (const chip of chips) {
      this.#sent.set(chip.id, JSON.stringify(customPinoutOf(chip)));
    }
    window.addEventListener("chiphippo:custom-chips-changed", (e) =>
      this.update(e.detail?.chips ?? []),
    );
  }

  /**
   * The designs as they now stand: send what changed since the last call.
   * @param {object[]} chips - normalised custom chips.
   * @returns {Array<{ref: string, chip: object|null}>} what was sent.
   */
  update(chips) {
    const changes = [];
    const present = new Set();
    for (const chip of chips) {
      present.add(chip.id);
      const pinout = customPinoutOf(chip);
      const key = JSON.stringify(pinout);
      if (this.#sent.get(chip.id) === key) continue;
      this.#sent.set(chip.id, key);
      changes.push({ ref: chip.id, chip: pinout });
    }
    for (const ref of [...this.#sent.keys()]) {
      if (present.has(ref)) continue;
      this.#sent.delete(ref);
      changes.push({ ref, chip: null });
    }
    if (changes.length) {
      Promise.resolve(this.#bridge?.pinout?.updateChips?.(changes)).catch(
        (err) => console.error("[renderer] pinout:update-chips failed:", err),
      );
    }
    return changes;
  }
}

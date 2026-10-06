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

// custom-chips.js — the chips the user DESIGNED (the chip designer), as main
// holds them: their SHAPE, which every file that carries one is held to, and
// the machine's LIBRARY of them.
//
// THE LIBRARY IS THE USER'S, A PROJECT'S COPY IS THE PROJECT'S. A chip made in
// the designer is saved here (`userData/custom-chips.json`), so every project
// on this machine can place it; a project FILE carries the chips its desktops
// place, so it opens anywhere. A project opening with a chip this library does
// not hold hands it over (the renderer's ProjectWorkspace decides that — main
// only keeps what it is given).
//
// A file of its own rather than a key in settings.json: a chip carries its
// Verilog (up to MAX_CUSTOM_CODE), and settings.json is rewritten on every
// camera move and handed to the renderer whole on every read.
//
// Main knows the fields, never their meaning: whether a chip's pins make sense
// or its code compiles is the renderer's to say (model/custom-chip.js).
"use strict";

const path = require("path");
const io = require("./io");

/** What a custom chip's id looks like (the renderer's own rule). */
const CUSTOM_ID_RE = /^custom-[0-9a-f]{8}$/;
/** How many chips one list may hold — a project's, or the library. */
const MAX_CUSTOM_CHIPS = 256;
/** How long a chip's code may be, in characters. */
const MAX_CUSTOM_CODE = 64 * 1024;

const LIBRARY_FILE = "custom-chips.json";
const LIBRARY_VERSION = 1;

const intIn = (v, lo, hi, fallback) =>
  Number.isInteger(v) && v >= lo && v <= hi ? v : fallback;

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * A list of designed chips, each one's plain fields held to their shapes and
 * limits, and nothing else: an entry that is not a chip, or repeats an id
 * already kept, is dropped (first wins).
 * @param {unknown} list
 * @returns {object[]}
 */
function sanitizeCustomChips(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const c of list) {
    if (out.length >= MAX_CUSTOM_CHIPS) break;
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    if (typeof c.id !== "string" || !CUSTOM_ID_RE.test(c.id)) continue;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const ports = (Array.isArray(c.ports) ? c.ports : [])
      .filter((p) => p && typeof p === "object" && typeof p.name === "string")
      .slice(0, 64)
      .map((p) => ({
        name: p.name.slice(0, 32),
        dir: ["output", "inout"].includes(p.dir) ? p.dir : "input",
        width: intIn(p.width, 1, 16, 1),
      }));
    const units = (Array.isArray(c.units) ? c.units : [])
      .slice(0, 6)
      .map((u) => {
        const map = {};
        for (const p of ports) {
          const pins = Array.isArray(u?.[p.name]) ? u[p.name] : [];
          map[p.name] = pins.slice(0, p.width).map((n) => intIn(n, 0, 40, 0));
        }
        return map;
      });
    out.push({
      id: c.id,
      name: text(c.name).slice(0, 16),
      description: text(c.description).slice(0, 200),
      family: c.family === "CD4000" ? "CD4000" : "74LS",
      pinsPerSide: intIn(c.pinsPerSide, 2, 20, 7),
      wide: c.wide === true,
      ports,
      units,
      vcc: intIn(c.vcc, 0, 40, 0),
      gnd: intIn(c.gnd, 0, 40, 0),
      code: typeof c.code === "string" ? c.code.slice(0, MAX_CUSTOM_CODE) : "",
    });
  }
  return out;
}

/**
 * The machine's library of designed chips: `{version, chips}` in one JSON
 * file in userData, read once and kept, every change written whole and
 * atomically. A damaged file is quarantined (it is the app's own) and reads
 * as an empty library.
 */
class ChipLibraryStore {
  #file;
  #chips = null;

  /** @param {string} dataDir - the app's userData directory. */
  constructor(dataDir) {
    this.#file = path.join(dataDir, LIBRARY_FILE);
  }

  /** @returns {object[]} every chip in the library, in the order added. */
  list() {
    if (!this.#chips) {
      const raw = io.readJSON(this.#file);
      this.#chips = sanitizeCustomChips(raw?.chips);
    }
    return this.#chips.map((c) => ({ ...c }));
  }

  /**
   * Add chips, or replace the ones with their ids. Writes only when something
   * changed; a chip past the library's limit is not added.
   * @param {unknown} chips
   * @returns {{ok: true, count: number}}
   */
  put(chips) {
    const incoming = sanitizeCustomChips(chips);
    const list = this.list();
    let changed = false;
    for (const chip of incoming) {
      const at = list.findIndex((c) => c.id === chip.id);
      if (at >= 0) {
        if (JSON.stringify(list[at]) === JSON.stringify(chip)) continue;
        list[at] = chip;
      } else {
        if (list.length >= MAX_CUSTOM_CHIPS) continue;
        list.push(chip);
      }
      changed = true;
    }
    if (changed) this.#write(list);
    return { ok: true, count: list.length };
  }

  /**
   * Remove one chip (a no-op for an id the library does not hold).
   * @param {unknown} id
   * @returns {{ok: true, count: number}}
   */
  remove(id) {
    const list = this.list();
    const next = list.filter((c) => c.id !== id);
    if (next.length !== list.length) this.#write(next);
    return { ok: true, count: next.length };
  }

  #write(list) {
    io.writeJSON(this.#file, { version: LIBRARY_VERSION, chips: list });
    this.#chips = list;
  }
}

module.exports = {
  CUSTOM_ID_RE,
  MAX_CUSTOM_CHIPS,
  MAX_CUSTOM_CODE,
  sanitizeCustomChips,
  ChipLibraryStore,
};

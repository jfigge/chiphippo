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

// scene3d-fixture.js — a desk holding ONE OF EVERYTHING the catalog offers
// that is not a chip, plus a chip of every DIP package, a bent LED, both
// bench bricks, a direct, a routed and a bussed set of wires and a planted
// signal flag — built through DeskDoc's own placement API, so every part is
// seated somewhere the desk would let it be. The 3D tests build a scene from
// it to prove every model draws; nothing about it is 3D-specific.

import { CHIP_DEFS } from "../catalog/index.js";
import { PART_DEFS } from "../catalog/parts.js";
import { DeskDoc } from "../model/desk-doc.js";

/** The boards are this far apart down the desk, so a module hanging off one
    (an LCD's PCB) never stops the next board from being placed. */
const KIT_STEP = 26;

/**
 * @returns {{doc: DeskDoc, placed: string[]}} the desk, and the refs seated
 */
export function everyPartDesk() {
  const doc = new DeskDoc();
  const placed = [];
  let row = 0;
  const kitAt = () => {
    const y = row * KIT_STEP;
    row += 1;
    const before = new Set(doc.boards.map((b) => b.id));
    doc.addKit("full", 0, y);
    return doc.boards.find((b) => !before.has(b.id) && b.type === "pins-full");
  };

  /** Seat `ref` wherever it first fits on the newest board — on a fresh
      board when that one is full — leaving a gap of free columns after it. */
  let current = null;
  const fit = (board, ref, params) => {
    for (const r of ["e", "c", "h", "a", "j"]) {
      for (let col = 3; col <= 58; col++) {
        const anchor = `${r}${col}`;
        if (doc.canPlacePart(ref, board.id, anchor, { params })) return anchor;
      }
    }
    return null;
  };
  const seat = (ref, kind, params = {}, { fresh = false } = {}) => {
    if (fresh || !current) current = kitAt();
    let anchor = fit(current, ref, params);
    if (!anchor) {
      current = kitAt();
      anchor = fit(current, ref, params);
    }
    if (!anchor) throw new Error(`fixture: nowhere to seat ${ref}`);
    doc.addComponent({ kind, ref, board: current.id, anchor, params });
    placed.push(ref);
    return { board: current, anchor };
  };

  // A chip of every DIP package the catalog uses.
  const packages = new Map();
  for (const def of CHIP_DEFS) {
    if (!packages.has(def.package)) packages.set(def.package, def.id);
  }
  for (const id of packages.values()) seat(id, "chip");
  seat("74LS00", "chip", { rot: 180 });

  // A character-LCD module is the size of a board; each gets its own.
  for (const def of PART_DEFS) {
    if (def.kind !== "discrete") continue;
    seat(def.id, "discrete", {}, { fresh: Boolean(def.characterDisplay) });
  }
  current = null; // nothing else goes under an LCD
  // The bent, free-ends form of a two-lead part, and the other looks some
  // parts have.
  seat("led", "discrete", { rot: 90, end: { dx: 3, dy: -4 }, color: "green" });
  seat("inductor", "discrete", { style: "can", bodyHoles: 3 });
  seat("nmos", "discrete", { case: "TO-220" });
  seat("sw-toggle", "discrete", { on: true });
  seat("rnet9", "discrete", { rot: 180 });

  // The bench bricks, off to the right of every board.
  doc.addBrick("psu", 80, 0, { volts: 5 });
  doc.addBrick("clock", 80, 10, { hz: 1 });
  placed.push("psu", "clock");

  // Wiring on a board of its own: a direct jumper, a routed one, a 4-wide
  // bus, a wire to a brick terminal, and a planted signal flag.
  const board = kitAt();
  doc.addWire({
    from: `${board.id}.a5`,
    to: `${board.id}.j30`,
    color: "yellow",
  });
  doc.addWire({
    from: `${board.id}.a40`,
    to: `${board.id}.a50`,
    color: "blue",
    layout: "routed",
    points: [
      { x: 41, y: board.y + 18 },
      { x: 49, y: board.y + 18 },
    ],
  });
  const members = [];
  for (let i = 0; i < 4; i++) {
    members.push(
      doc.addWire({
        from: `${board.id}.b${10 + i}`,
        to: `${board.id}.i${20 + i}`,
        color: "green",
      }).id,
    );
  }
  doc.addBus("D[4]", members);
  const psu = doc.components.find((c) => c.ref === "psu");
  doc.addWire({ from: `${psu.id}.+`, to: `${board.id}.c60`, color: "red" });
  const sig = doc.addSignal();
  doc.plantSignalFlag(sig.id, `${board.id}.f45`, 0);
  return { doc, placed };
}

/** The plain document a DeskDoc holds — what the 3D view builds a scene of. */
export function plainDoc(doc) {
  return {
    boards: doc.boards,
    components: doc.components,
    wires: doc.wires,
    buses: doc.buses,
    signals: doc.signals,
    integrations: doc.integrations,
    annotations: doc.annotations,
  };
}

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

// islands-fixtures.js — the desks the Spice Lite performance series is
// measured on (features/00-bench-islands.md): the busy counter board
// (bench/busy-circuit.js) and the timing fixtures' 555 astable
// (tests/timing-fixtures.js), alone and side by side. Each sub-circuit added
// beside another sits on its OWN board and its OWN supply, sharing nothing —
// independent "islands" in the engine review's sense (§4.2).
//
// Each fixture is `{name, doc, scope, oscillators}`: `scope` stands for the
// analyzer recording (wave frames), and each oscillator says where to read
// its running period and what that period should be.

import { busyDocument } from "./busy-circuit.js";
import { astable555, bench } from "../tests/timing-fixtures.js";
import { relaxation } from "../tests/incremental-fixtures.js";

/** The datasheet period of a 555 astable, seconds: 0.693·(RA + 2·RB)·C. */
const astablePeriod = (ra, rb, c) => 0.693 * (ra + 2 * rb) * c;

/** The 555 astables the series uses, by their rough rate. */
export const ASTABLES = Object.freeze({
  slow: { ra: 1e3, rb: 10e3, c: 1e-6 }, //  ~69 Hz
  fast: { ra: 1e3, rb: 10e3, c: 10e-9 }, // ~6.9 kHz
  faster: { ra: 1e3, rb: 10e3, c: 1e-9 }, // ~68 kHz
});

/**
 * `part` re-identified under `prefix` and moved by (dx, dy): every board,
 * component, wire and signal id, and every address naming one, so it can sit
 * on a desk beside another document without a shared name.
 */
export function relabel(part, prefix, dx, dy) {
  const ids = new Map();
  for (const b of part.boards) ids.set(b.id, `${prefix}${b.id}`);
  for (const c of part.components) ids.set(c.id, `${prefix}${c.id}`);
  const address = (a) => {
    const dot = a.indexOf(".");
    const owner = a.slice(0, dot);
    return ids.has(owner) ? `${ids.get(owner)}${a.slice(dot)}` : a;
  };
  return {
    boards: part.boards.map((b) => ({ ...b, id: ids.get(b.id), x: b.x + dx, y: b.y + dy, ...(b.group ? { group: `${prefix}${b.group}` } : {}) })), // prettier-ignore
    components: part.components.map((c) => ({
      ...c,
      id: ids.get(c.id),
      ...(c.board != null ? { board: ids.get(c.board) } : { x: c.x + dx, y: c.y + dy }), // prettier-ignore
    })),
    wires: part.wires.map((w) => ({ ...w, id: `${prefix}${w.id}`, from: address(w.from), to: address(w.to) })), // prettier-ignore
    signals: (part.signals ?? []).map((s) => ({ ...s, id: `${prefix}${s.id}`, flag: s.flag ? { ...s.flag, anchor: address(s.flag.anchor) } : s.flag })), // prettier-ignore
  };
}

/** `base` with each of `parts` (relabelled) added beside it. */
export function desk(base, ...parts) {
  const doc = structuredClone(base);
  for (const p of parts) {
    doc.boards.push(...p.boards);
    doc.components.push(...p.components);
    doc.wires.push(...p.wires);
    doc.signals = [...(doc.signals ?? []), ...p.signals];
  }
  return doc;
}

/** An empty desk to add islands to. */
export const EMPTY = Object.freeze({ version: 15, boards: [], components: [], wires: [], signals: [] }); // prettier-ignore

/** A 555 astable on its own board and supply, `slot` boards along. */
export function island555(values, slot) {
  const { doc } = astable555(values);
  return relabel(doc, `i${slot}_`, 100 + 80 * slot, 0);
}

/** A clock brick putting out `wave` at `hz` into an RC low-pass (`ohms`,
    `farads`), on its own board and supply, `slot` boards along. */
export function islandWave(wave, hz, ohms, farads, slot) {
  const b = bench();
  const r = b.seat("r1", "resistor", "a10", { ohms });
  const c = b.seat("c1", "cap-ceramic", "a20", { farads });
  b.link(r.get(2), c.get(1));
  b.gnd(c.get(2));
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: { hz, wave } }); // prettier-ignore
  b.doc.wires.push(
    { id: "wc1", from: "clk1.vcc", to: "psu1.+", color: "red" },
    { id: "wc2", from: "clk1.gnd", to: "psu1.-", color: "black" },
    { id: "wc3", from: "clk1.out", to: b.at(r.get(1).replace(/^a/, "c")), color: "yellow" }, // prettier-ignore
  );
  return relabel(b.doc, `w${slot}_`, 100 + 80 * slot, 0);
}

const osc555 = (slot, values) => ({
  name: `555@i${slot}`,
  chip: `i${slot}_u1`,
  expected: astablePeriod(values.ra, values.rb, values.c),
});

/**
 * Every fixture, each with how long to run it (simulated seconds) — chosen
 * so the whole set times in well under half a minute on today's engine.
 * @returns {Array<{name: string, doc: object, scope: boolean, seconds: number, oscillators: object[]}>}
 */
export function islandFixtures() {
  const busy = busyDocument(4, { hz: 100 });
  const busyWave = (wave) => {
    const doc = structuredClone(busy);
    for (const c of doc.components) {
      if (c.kind === "clock") c.params = { ...c.params, wave };
    }
    return doc;
  };
  const { slow, fast, faster } = ASTABLES;
  return [
    { name: "busy-square", doc: busy, scope: false, seconds: 1, oscillators: [] }, // prettier-ignore
    { name: "busy-triangle", doc: busyWave("triangle"), scope: true, seconds: 0.5, oscillators: [] }, // prettier-ignore
    { name: "busy-triangle-noscope", doc: busyWave("triangle"), scope: false, seconds: 0.5, oscillators: [] }, // prettier-ignore
    { name: "555-slow", doc: desk(EMPTY, island555(slow, 0)), scope: false, seconds: 1, oscillators: [osc555(0, slow)] }, // prettier-ignore
    { name: "busy+555-slow", doc: desk(busy, island555(slow, 0)), scope: false, seconds: 0.5, oscillators: [osc555(0, slow)] }, // prettier-ignore
    { name: "555-fast", doc: desk(EMPTY, island555(fast, 0)), scope: false, seconds: 0.5, oscillators: [osc555(0, fast)] }, // prettier-ignore
    { name: "555-fast-x2", doc: desk(EMPTY, island555(fast, 0), island555({ ...fast, rb: 12e3 }, 1)), scope: false, seconds: 0.1, oscillators: [osc555(0, fast), osc555(1, { ...fast, rb: 12e3 })] }, // prettier-ignore
    { name: "busy+555-fast", doc: desk(busy, island555(fast, 0)), scope: false, seconds: 0.2, oscillators: [osc555(0, fast)] }, // prettier-ignore
    { name: "555-68k+wave", doc: desk(EMPTY, island555(faster, 0), islandWave("triangle", 10, 10e3, 1e-6, 1)), scope: false, seconds: 1, oscillators: [osc555(0, faster)] }, // prettier-ignore
    // A CD4000 island beside a 74LS board (features/13 — its own quantum).
    { name: "busy+cd40106", doc: desk(busy, relabel(relaxation("CD40106B", { r: 100e3, c: 1e-6 }), "x_", 0, -40)), scope: false, seconds: 0.5, oscillators: [] }, // prettier-ignore
    { name: "rc-sine", doc: desk(EMPTY, islandWave("sine", 250, 1e3, 1e-6, 0)), scope: false, seconds: 1, oscillators: [] }, // prettier-ignore
  ];
}

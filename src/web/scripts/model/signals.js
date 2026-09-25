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

// signals.js — external signals: bench stimulus that lives OFF the boards
// (Feature 370). Pure and DOM-free.
//
// A signal is a BUTTON pinned to the desk viewport's right edge plus a FLAG —
// a pointed glyph whose apex plugs into one breadboard hole. Pressing the
// button injects a level at that hole. It is the first desk item that is
// neither a component nor decoration: an annotation is invisible to occupancy,
// the netlist and the engine; a wire is visible to occupancy and the netlist;
// a flag is visible to OCCUPANCY and the ENGINE, and is neither.
//
// The vocabulary here is the DOCUMENT's — "low"/"high" — never the engine's
// H/L. SimController is the one place that maps between them, which is what
// keeps this module out of sim/ entirely.

import { ROTATIONS, rotateOffset } from "./breadboard.js";
import { WIRE_COLORS } from "./wire-colors.js";

/** How a signal's button behaves under a press. */
export const SIGNAL_TYPES = Object.freeze(["momentary", "toggle"]);

/** The level a signal holds when nobody is pressing it. */
export const SIGNAL_RESTS = Object.freeze(["low", "high"]);

/**
 * The colours a signal may take — the jumper palette MINUS BLACK, in the order
 * new signals are handed them (`nextSignalColor`).
 *
 * Black is the bench's ground colour. A black flag planted in a hole reads as
 * a ground tie rather than as a stimulus lead, and its button's dot all but
 * disappears against the dark rail. It is excluded here rather than merely
 * discouraged, so NO path in the app can hand it out: the picker cannot offer
 * it, `addSignal` cannot mint it, and a hand-edited document carrying one is
 * repaired to a real colour on load (`normalizeSignalFields`).
 *
 * Derived by SUBTRACTION rather than retyped, so a ninth jumper colour reaches
 * signals for free and the two lists can never disagree about which tokens
 * exist at all.
 */
export const SIGNAL_COLORS = Object.freeze(
  WIRE_COLORS.filter((c) => c !== "black"),
);

/**
 * The keys that press a signal, in the order they run along the digit row —
 * `1` to `9`, then `0` for the tenth. There are exactly ten, and that is the
 * CAP: every signal has a key, so there is no eleventh signal.
 *
 * The cap used to be the colour palette's length, back when a colour was a
 * signal's whole identity. It is not any more — colours repeat once the seven
 * are used — so the identity tying a flag to its button is this key, printed
 * inside the flag and on the button (`signalKey`).
 */
export const SIGNAL_KEYS = Object.freeze([
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "0",
]);

/** At most one signal per key — the cap IS the digit row's length. */
export const MAX_SIGNALS = SIGNAL_KEYS.length;

/**
 * The colour a new signal takes: the first colour in `SIGNAL_COLORS` order that
 * no signal is using, and once all of them are in use, a second lap from the
 * beginning. Stated as LEAST-USED, ties by palette order, which is the same
 * rule on every lap — so deleting a signal frees its colour for the next one
 * added, whichever lap it was on. Never null (the palette is never empty).
 * @param {Array<{color?: string}>} signals
 * @returns {string}
 */
export function nextSignalColor(signals) {
  const uses = new Map(SIGNAL_COLORS.map((c) => [c, 0]));
  for (const s of signals ?? []) {
    if (uses.has(s?.color)) uses.set(s.color, uses.get(s.color) + 1);
  }
  let best = SIGNAL_COLORS[0];
  for (const c of SIGNAL_COLORS) if (uses.get(c) < uses.get(best)) best = c;
  return best;
}

/**
 * Coerce a stored signal's three scalars. Shared by the loader and by every
 * mutator, so "a valid signal" has one definition.
 *
 * Any signal colour is kept — two signals may share one. Only a colour that is
 * not a signal colour at all (black, or junk) is REPAIRED, never rejected: it
 * is presentation, and dropping a whole stimulus source over it would lose work
 * to fix a cosmetic fault. The repair takes `nextSignalColor` over `others`.
 * @param {object} raw
 * @param {Array<{color?: string}>} [others] the signals it joins
 * @returns {{color: string, type: string, rest: string}}
 */
export function normalizeSignalFields(raw, others = []) {
  const wanted = raw?.color;
  return {
    color: SIGNAL_COLORS.includes(wanted) ? wanted : nextSignalColor(others),
    type: SIGNAL_TYPES.includes(raw?.type) ? raw.type : "momentary",
    rest: SIGNAL_RESTS.includes(raw?.rest) ? raw.rest : "low",
  };
}

/**
 * The signals in the order their buttons run down the rail — today the
 * document's own order. It exists as a function because THREE things read it
 * (the rail, the digit keys, and a future user-positionable rail), and they
 * must never disagree about which button is second.
 * @param {Array} signals
 * @returns {Array}
 */
export function railOrder(signals) {
  return [...(signals ?? [])];
}

/**
 * The signal a key drives (`"1"`…`"9"`, `"0"`), or null. Stated in terms of
 * `railOrder`, so "the third button down" and key 3 cannot come apart.
 * @param {Array} signals
 * @param {string} key
 * @returns {object|null}
 */
export function signalForKey(signals, key) {
  const i = SIGNAL_KEYS.indexOf(key);
  return i < 0 ? null : (railOrder(signals)[i] ?? null);
}

/**
 * The sequence number in a signal's id (`sig4` → 4), or null.
 *
 * The DEFAULT NAME is built from this rather than from the rail's length,
 * because ids never repeat and lengths do: add four signals, delete the
 * second, add another, and a length-based name hands out a second "Signal 4".
 * Same argument as `Desktop N` — a default name is data from the moment it is
 * minted, so it has to be unique then.
 */
export function signalSeq(id) {
  const m = /^sig([1-9]\d*)$/.exec(String(id ?? ""));
  return m ? Number(m[1]) : null;
}

/**
 * The key that drives a signal — `"1"`…`"9"`, `"0"` for the tenth — or null
 * when it is not on the rail. This is the signal's IDENTITY on the desk: the
 * flag prints it and so does the button, since colours repeat.
 * @param {Array} signals
 * @param {string} id
 * @returns {string|null}
 */
export function signalKey(signals, id) {
  const i = railOrder(signals).findIndex((s) => s?.id === id);
  return i >= 0 ? (SIGNAL_KEYS[i] ?? null) : null;
}

/** The level a signal holds when released — its `rest`. */
export function restLevel(sig) {
  return sig?.rest === "high" ? "high" : "low";
}

/** The level a MOMENTARY signal asserts while held — the other one. */
export function assertedLevel(sig) {
  return restLevel(sig) === "high" ? "low" : "high";
}

/** Is this signal plugged into a board? */
export function isPlanted(sig) {
  return typeof sig?.flag?.anchor === "string";
}

// ── The flag glyph ──────────────────────────────────────────────────────────

/** Flag body length along its axis, in world pitch units. */
export const FLAG_LEN = 4;

/** Flag body width across its axis, in world pitch units. */
export const FLAG_W = 2;

/**
 * The height of an equilateral triangle of side FLAG_W — the depth of the
 * point. Requirement: "a rectangle with one short end replaced by the other
 * two sides of an equilateral triangle".
 */
const POINT_DEPTH = (FLAG_W * Math.sqrt(3)) / 2;

/**
 * The flag as five world-coordinate vertices, APEX AT THE ANCHOR.
 *
 * At rot 0 the body extends to the right of its point; each quarter-turn is
 * `rotateOffset`, the app's one 90°-step rotator (the same primitive an
 * oscillator can's pin offsets spin through), so there is no trigonometry here
 * and no second rotation implementation anywhere.
 *
 * Because the apex is the origin of the rotation, "R rotates the flag about its
 * point" costs nothing: the anchor is simply never part of the sum.
 * @param {{x: number, y: number}} point the anchor hole's world position
 * @param {number} rot 0 | 90 | 180 | 270
 * @returns {Array<{x: number, y: number}>}
 */
export function flagPolygon(point, rot = 0) {
  const px = point?.x ?? 0;
  const py = point?.y ?? 0;
  const local = [
    { dx: 0, dy: 0 }, // the apex — the connection
    { dx: POINT_DEPTH, dy: -FLAG_W / 2 },
    { dx: FLAG_LEN, dy: -FLAG_W / 2 },
    { dx: FLAG_LEN, dy: FLAG_W / 2 },
    { dx: POINT_DEPTH, dy: FLAG_W / 2 },
  ];
  return local.map((v) => {
    const r = rotateOffset(v, rot);
    return { x: px + r.dx, y: py + r.dy };
  });
}

/**
 * The radius of the disc the flag's KEY sits on — the rail button's dot, drawn
 * on the flag. It leaves a fifth of a pitch of body showing on either side, and
 * fits the body's rectangle lengthwise too, so it never spills into the point.
 */
export const FLAG_KEY_R = 0.8;

/**
 * Where the flag's KEY is printed: the middle of its rectangular body, clear
 * of the point. Rotated with the flag, but the glyph itself never is — one
 * upright character fits the 2-pitch-wide body at every quarter-turn, which is
 * exactly what a horizontal NAME could not do (the name lives on the button).
 * @param {{x: number, y: number}} point the anchor hole's world position
 * @param {number} rot 0 | 90 | 180 | 270
 * @returns {{x: number, y: number}}
 */
export function flagKeyPoint(point, rot = 0) {
  const r = rotateOffset({ dx: (POINT_DEPTH + FLAG_LEN) / 2, dy: 0 }, rot);
  return { x: (point?.x ?? 0) + r.dx, y: (point?.y ?? 0) + r.dy };
}

/** The next quarter-turn round, for R. Junk normalizes to 0 FIRST and then
    advances, so R always turns the flag rather than silently straightening it. */
export function nextFlagRotation(rot) {
  const i = ROTATIONS.indexOf(normalizeFlagRotation(rot));
  return ROTATIONS[(i + 1) % ROTATIONS.length];
}

/** Coerce a stored flag rotation. */
export function normalizeFlagRotation(rot) {
  return ROTATIONS.includes(rot) ? rot : 0;
}

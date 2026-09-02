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
 * The colours a signal may own — the jumper palette MINUS BLACK.
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
 * At most one signal per SIGNAL colour, so the cap IS that palette's length.
 *
 * The colour is not decoration — it is the identity tying a flag on the desk
 * to a button on the rail, which is why it must be unique and why there is no
 * eighth signal. Stating it as `SIGNAL_COLORS.length` rather than `7` keeps
 * the two facts (uniqueness, and the cap) as ONE rule: drop a colour and the
 * cap follows, which is exactly what happened when black went.
 */
export const MAX_SIGNALS = SIGNAL_COLORS.length;

/**
 * How many signals the DIGIT KEYS can reach. A different fact from the cap,
 * and deliberately not folded into it: there are only nine digits, so a
 * palette that ever grew past that would leave signals unreachable from the
 * keyboard rather than silently mis-binding them. Today the cap binds.
 */
export const SIGNAL_DIGITS = Math.min(MAX_SIGNALS, 9);

/**
 * The first palette colour no signal holds, or null when all are taken.
 * @param {Array<{color?: string}>} signals
 * @returns {string|null}
 */
export function nextSignalColor(signals) {
  const taken = new Set((signals ?? []).map((s) => s?.color));
  return SIGNAL_COLORS.find((c) => !taken.has(c)) ?? null;
}

/**
 * The colours a signal's own picker may offer: everything free, plus the one
 * it already holds. Uniqueness expressed as an ABSENCE — every swatch on
 * screen is one that works, so the shared colour-swatch control needs no
 * disabled state of its own.
 * @param {Array<{id: string, color?: string}>} signals
 * @param {string} id the signal being edited
 * @returns {string[]}
 */
export function availableSignalColors(signals, id) {
  const taken = new Set(
    (signals ?? []).filter((s) => s?.id !== id).map((s) => s?.color),
  );
  return SIGNAL_COLORS.filter((c) => !taken.has(c));
}

/**
 * Coerce a stored signal's three scalars. Shared by the loader and by every
 * mutator, so "a valid signal" has one definition.
 *
 * The colour is REPAIRED rather than rejected: it is presentation, and dropping
 * a whole stimulus source because a hand-edited file duplicated a token would
 * lose work to fix a cosmetic clash. `taken` is what has already been accepted.
 * @param {object} raw
 * @param {Set<string>} [taken] colours already spoken for
 * @returns {{color: string, type: string, rest: string}|null} null when no
 *   colour is left to give it
 */
export function normalizeSignalFields(raw, taken = new Set()) {
  const wanted = raw?.color;
  const color =
    typeof wanted === "string" &&
    SIGNAL_COLORS.includes(wanted) &&
    !taken.has(wanted)
      ? wanted
      : (SIGNAL_COLORS.find((c) => !taken.has(c)) ?? null);
  if (color == null) return null;
  return {
    color,
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
 * The signal a digit key drives, or null. Stated in terms of `railOrder`, so
 * "the third button down" and "key 3" cannot come apart.
 * @param {Array} signals
 * @param {number} digit 1-based
 * @returns {object|null}
 */
export function signalForDigit(signals, digit) {
  if (!Number.isInteger(digit) || digit < 1) return null;
  return railOrder(signals)[digit - 1] ?? null;
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
 * The 1-based digit that drives a signal, or null when it is past the keys.
 * @param {Array} signals
 * @param {string} id
 * @returns {number|null}
 */
export function signalDigit(signals, id) {
  const i = railOrder(signals).findIndex((s) => s?.id === id);
  return i >= 0 && i < SIGNAL_DIGITS ? i + 1 : null;
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

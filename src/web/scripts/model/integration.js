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

// integration.js — OUTPUT and INPUT elements: the running circuit's two-way
// serial link to a real Arduino. Pure and DOM-free.
//
// An element is a card on the desk's right-edge rail (under the signal
// buttons) plus a set of TAGS — small numbered pointers, one per pin, whose
// point plugs into one breadboard hole, and a TRIGGER tag for an element that
// waits for an edge. An OUTPUT samples its pins and sends the value to the
// Arduino — when its trigger line shows the configured edge, or on AUTO
// whenever the value changes; an INPUT drives its pins with whatever the
// Arduino last sent — on AUTO straight away ("live"), or when its trigger line
// shows the edge ("triggered"). Auto is a trigger setting like the edges, not
// the absence of a tag: an element on Auto has no trigger tag at all, and one
// waiting for an edge must have its tag on the board before the circuit runs.
//
// It is the signal flag's arrangement one step on (model/signals.js), and for
// the same reason it is not a component: no footprint, no catalog def, no BOM
// line. A tag claims its hole the way a flag does (one hole, one lead), and an
// Input's pin tags drive their nets at the flag's strength, so a fight with a
// chip output reports a conflict with no new engine code.
//
// ONE MODEL FOR BOTH KINDS: an element carries an ordered list of FIELDS, each
// a bit (bool), a byte (uint8_t) or a word (uint16_t), sixteen pins at most.
// The width picked when the element is dropped is a PRESET — 1, 2 and 4 are
// that many bits, 8 is one byte, 16 is one word — and the Properties card can
// mix them (a byte of data plus three strobes is one element, one frame, one
// generated call, applied atomically). Tags are numbered by PIN, 1 to N, and
// pin 1 is bit 0 of the value on the wire: the fields only say what each
// number MEANS, so re-shaping them leaves every planted tag where it is.

import { crc32, FIELD_PINS, MAX_WIDTH } from "./serial-wire.js";
import {
  FLAG_KEY_R,
  FLAG_LEN,
  FLAG_W,
  flagKeyPoint,
  flagPolygon,
  nextFlagRotation,
  nextSignalColor,
  normalizeFlagRotation,
  SIGNAL_COLORS,
} from "./signals.js";

/** The two kinds, by direction from the BOARD's point of view. */
export const ELEMENT_KINDS = Object.freeze(["output", "input"]);

/** What one field can be, and how many pins each takes. */
export const FIELD_TYPES = Object.freeze(["bit", "byte", "word"]);
export { FIELD_PINS };

/** The widest element: a uint16_t on the wire. */
export const MAX_ELEMENT_PINS = MAX_WIDTH;

/** The widths offered when an element is dropped (the bus sizes, plus 1). */
export const DROP_WIDTHS = Object.freeze([1, 2, 4, 8, 16]);

/** When an element acts. AUTO watches no line: an Output sends whenever its
    settled value changes, an Input applies each value as it arrives. The
    others are which transition of the trigger line fires (Output) or releases
    (Input). Auto leads, since the picker lists them in this order. */
export const TRIGGER_EDGES = Object.freeze([
  "auto",
  "rising",
  "falling",
  "either",
]);

/** The trigger a new element starts on: an Output waits for a strobe (its
    pins are often valid only at one), an Input takes values as they come. */
export const DEFAULT_TRIGGER_EDGE = Object.freeze({
  output: "rising",
  input: "auto",
});

/** Is this element on AUTO — no trigger line, and so no trigger tag? */
export function isAutoTrigger(element) {
  return element?.triggerEdge === "auto";
}

/** What the trigger line is taken to have been BEFORE the first settle. */
export const TRIGGER_INITS = Object.freeze(["low", "high"]);

/** The trigger tag's key, beside the pin tags' "1"…"16". */
export const TRIGGER_KEY = "T";

/** How many elements one desk holds — the rail is not a scrolling list. */
export const MAX_ELEMENTS = 16;

/** The longest field (parameter) or element name kept. */
const MAX_NAME = 32;

const ID_RES = Object.freeze({
  output: /^out([1-9]\d*)$/,
  input: /^in([1-9]\d*)$/,
});

/** The id prefix each kind mints (`out3`, `in1`). */
export const ID_PREFIX = Object.freeze({ output: "out", input: "in" });

/** Which kind an id names, or null. */
export function elementKindOf(id) {
  const s = String(id ?? "");
  for (const kind of ELEMENT_KINDS) if (ID_RES[kind].test(s)) return kind;
  return null;
}

/** The sequence number in an element's id (`out4` → 4), or null — what its
    default NAME is built from, for the reason `signalSeq` gives. */
export function elementSeq(id) {
  const kind = elementKindOf(id);
  return kind ? Number(ID_RES[kind].exec(String(id))[1]) : null;
}

// ── Fields ─────────────────────────────────────────────────────────────────

/** The name a new field gets: its type and the value bit it starts at, so a
    default reads as where it lives (`bit8` after a byte). */
export function defaultFieldName(type, firstPin) {
  return `${type}${firstPin - 1}`;
}

/**
 * The fields a drop-time width stands for: 1, 2 and 4 are that many bits
 * (one bool parameter per pin), 8 is one byte, 16 is one word.
 * @param {number} width
 * @returns {Array<{type: string, name: string}>}
 */
export function presetFields(width) {
  if (width === 16) return [{ type: "word", name: "value" }];
  if (width === 8) return [{ type: "byte", name: "value" }];
  const n = [1, 2, 4].includes(width) ? width : 1;
  return Array.from({ length: n }, (_, i) => ({
    type: "bit",
    name: defaultFieldName("bit", i + 1),
  }));
}

/** How many pins a field list takes. */
export function pinCount(fields) {
  let n = 0;
  for (const f of fields ?? []) n += FIELD_PINS[f?.type] ?? 0;
  return n;
}

/**
 * Coerce a stored field list. Junk entries go; a field that would take the
 * element past sixteen pins goes; a blank name takes its default. Never
 * empty — an element with no pins would be a card with nothing to plug in.
 * @returns {Array<{type: string, name: string}>}
 */
export function normalizeFields(raw) {
  const out = [];
  let pins = 0;
  for (const f of Array.isArray(raw) ? raw : []) {
    if (!f || typeof f !== "object" || !FIELD_TYPES.includes(f.type)) continue;
    const n = FIELD_PINS[f.type];
    if (pins + n > MAX_ELEMENT_PINS) continue;
    const name =
      typeof f.name === "string" ? f.name.trim().slice(0, MAX_NAME) : "";
    out.push({
      type: f.type,
      name: name || defaultFieldName(f.type, pins + 1),
    });
    pins += n;
  }
  return out.length ? out : presetFields(1);
}

/**
 * Each field with the pins it covers, 1-based and inclusive.
 * @returns {Array<{type: string, name: string, first: number, last: number}>}
 */
export function fieldSpans(fields) {
  const spans = [];
  let next = 1;
  for (const f of fields ?? []) {
    const n = FIELD_PINS[f.type] ?? 0;
    spans.push({ type: f.type, name: f.name, first: next, last: next + n - 1 });
    next += n;
  }
  return spans;
}

/**
 * What pin `pin` is: which field, and which bit of that field. Null past the
 * last pin.
 * @returns {{field: number, name: string, type: string, bit: number}|null}
 */
export function pinRole(fields, pin) {
  const spans = fieldSpans(fields);
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    if (pin >= s.first && pin <= s.last) {
      return { field: i, name: s.name, type: s.type, bit: pin - s.first };
    }
  }
  return null;
}

// ── Tags ───────────────────────────────────────────────────────────────────

/** Is this a pin tag's key ("1"…"16")? */
export function isPinKey(key) {
  return /^([1-9]|1[0-6])$/.test(String(key ?? ""));
}

/** Every tag key an element has, pins first then the trigger — which an
    element on Auto does not have at all. */
export function tagKeys(element) {
  const n = pinCount(element?.fields);
  const pins = Array.from({ length: n }, (_, i) => String(i + 1));
  return isAutoTrigger(element) ? pins : [...pins, TRIGGER_KEY];
}

/** Is `key` one of this element's tags? */
export function hasTagKey(element, key) {
  if (key === TRIGGER_KEY) return !isAutoTrigger(element);
  return isPinKey(key) && Number(key) <= pinCount(element?.fields);
}

/** The composite id a tag goes by on the desk and in the selection. */
export function tagId(elementId, key) {
  return `${elementId}:${key}`;
}

/** The inverse of `tagId`, or null. */
export function parseTagId(id) {
  const m = /^([a-z]+[1-9]\d*):(T|[1-9]\d?)$/.exec(String(id ?? ""));
  return m ? { elementId: m[1], key: m[2] } : null;
}

/** Is this tag planted? */
export function isTagPlanted(element, key) {
  return typeof element?.tags?.[key]?.anchor === "string";
}

/** Tag rotation is a flag's: the same four quarter-turns about the point. */
export const nextTagRotation = nextFlagRotation;
export const normalizeTagRotation = normalizeFlagRotation;

// ── Records ────────────────────────────────────────────────────────────────

/**
 * Coerce an element's scalar settings. Shared by the loader and every
 * mutator, so "a valid element" has one definition — the signal fields' rule
 * too: a colour that is not a signal colour is REPAIRED, never a reason to
 * drop the element.
 * A missing or unknown trigger takes its KIND's default
 * (`DEFAULT_TRIGGER_EDGE`), the kind read off the id when there is one — as
 * the loader does, never trusting a field that could disagree with it — and
 * off `raw.kind` for an element still being minted.
 * @param {object} raw
 * @param {Array<{color?: string}>} [others] the colours it joins (signals and
 *   other elements), for the repair
 */
export function normalizeElementFields(raw, others = []) {
  const kind =
    elementKindOf(raw?.id) ??
    (ELEMENT_KINDS.includes(raw?.kind) ? raw.kind : "output");
  return {
    color: SIGNAL_COLORS.includes(raw?.color)
      ? raw.color
      : nextSignalColor(others),
    connection:
      typeof raw?.connection === "string" && raw.connection
        ? raw.connection
        : null,
    triggerEdge: TRIGGER_EDGES.includes(raw?.triggerEdge)
      ? raw.triggerEdge
      : DEFAULT_TRIGGER_EDGE[kind],
    triggerInit: TRIGGER_INITS.includes(raw?.triggerInit)
      ? raw.triggerInit
      : "low",
    fields: normalizeFields(raw?.fields),
  };
}

// ── Run-time arithmetic (shared by the runtime and the code generator) ─────

/**
 * Did the trigger line do what the element waits for, between two settles?
 * Levels are booleans — HIGH or not — because a floating or unknown line is
 * not a transition to anything. Auto waits for no line, so no transition is
 * ever its edge.
 */
export function edgeFired(edge, prevHigh, nowHigh) {
  if (prevHigh === nowHigh || edge === "auto") return false;
  if (edge === "either") return true;
  return edge === "rising" ? nowHigh : !nowHigh;
}

/**
 * Sample an element's pins into the value on the wire: pin k is bit k-1,
 * right-aligned. `isHigh(pin)` answers for one pin; an unplanted pin, a
 * floating one and an unknown one all read 0.
 * @returns {{width: number, value: number}}
 */
export function packValue(fields, isHigh) {
  const width = pinCount(fields);
  let value = 0;
  for (let pin = 1; pin <= width; pin++) {
    if (isHigh(pin)) value |= 1 << (pin - 1);
  }
  return { width, value };
}

/**
 * The level each pin takes from a received value — `"H"` or `"L"` per pin,
 * 1 to `width`. Pins beyond the element's own width are not driven.
 * @returns {Map<number, "H"|"L">}
 */
export function unpackLevels(width, value) {
  const levels = new Map();
  for (let pin = 1; pin <= width; pin++) {
    levels.set(pin, (value >> (pin - 1)) & 1 ? "H" : "L");
  }
  return levels;
}

/**
 * A value as its fields read it — `addr=0x3F rw=1`: a bit as 0 or 1, a byte
 * or a word in hex. What a window prints for a value that crossed the wire,
 * in the design's own words.
 */
export function describeFields(fields, value) {
  return fieldSpans(fields)
    .map((span) => {
      const bits = span.last - span.first + 1;
      const v = (value >>> (span.first - 1)) & ((1 << bits) - 1);
      const shown =
        span.type === "bit"
          ? String(v)
          : `0x${v
              .toString(16)
              .toUpperCase()
              .padStart(span.type === "word" ? 4 : 2, "0")}`;
      return `${span.name}=${shown}`;
    })
    .join(" ");
}

/** The elements that talk over one connection, of one kind, in WIRE ORDER —
    by the number in their id (`out2` before `out10`), which only ever counts
    up, so an element's index moves only when one before it is added or
    removed. This is the order the generated header numbers them, the element
    index in every data frame, and the order the layout signature lists them:
    ONE ordering, so the three can never disagree (protocol §7). */
export function elementsFor(elements, connectionId, kind) {
  return (elements ?? [])
    .filter((e) => e.connection === connectionId && e.kind === kind)
    .sort((a, b) => (elementSeq(a.id) ?? 0) - (elementSeq(b.id) ?? 0));
}

/** An element's index on the wire: its place among `elementsFor`. */
export function elementIndex(elements, element) {
  return elementsFor(elements, element?.connection, element?.kind).findIndex(
    (e) => e.id === element.id,
  );
}

/**
 * What a DEVICE on one connection sees of the design: its Outputs and its
 * Inputs, in wire order (so an element's place is its index), each by name
 * and fields. The Mock's window is built from it — the one device Chip Hippo
 * draws — which is why it carries names at all: nothing on the wire does.
 * @returns {{outputs: Array<{name: string, fields: Array<{type, name}>}>,
 *   inputs: Array<{name: string, fields: Array<{type, name}>}>}}
 */
export function connectionLayout(elements, connectionId) {
  const side = (kind) =>
    elementsFor(elements, connectionId, kind).map((e) => ({
      name: e.name || e.id,
      fields: (e.fields ?? []).map((f) => ({ type: f.type, name: f.name })),
    }));
  return { outputs: side("output"), inputs: side("input") };
}

/**
 * The layout one connection's sketch is built for, as the protocol spells it
 * (§7.2): every Output, then every Input, in wire order, each as
 * `<O|I><index>:<field widths in order, joined by +>` — `O0:8+1,O1:1,I0:16`.
 * What decides which bits reach which parameter is in it — the field
 * boundaries, not only the total, or a `[bit, byte]` reordered to
 * `[byte, bit]` would pass while every value landed in the wrong parameter.
 * Names never are, so a rename leaves it alone.
 */
export function layoutString(elements, connectionId) {
  const part = (letter, kind) =>
    elementsFor(elements, connectionId, kind).map(
      (e, i) =>
        `${letter}${i}:${(e.fields ?? []).map((f) => FIELD_PINS[f.type] ?? 0).join("+")}`,
    );
  return [...part("O", "output"), ...part("I", "input")].join(",");
}

/**
 * The layout SIGNATURE: CRC-32 of `layoutString`'s ASCII. The ONE function
 * both the generator (which bakes it into the header) and a run's handshake
 * (which sends it in HELLO and holds the board's HELLO_ACK to it) call.
 * @returns {number} unsigned 32-bit
 */
export function layoutSignature(elements, connectionId) {
  return crc32(new TextEncoder().encode(layoutString(elements, connectionId)));
}

/** Every connection id the elements use, in first-use order (nulls skipped). */
export function connectionsUsed(elements) {
  const out = [];
  for (const e of elements ?? []) {
    if (e.connection && !out.includes(e.connection)) out.push(e.connection);
  }
  return out;
}

/** Is any of this element's tags on the breadboard — a pin, or its trigger? */
export function isElementPlanted(element) {
  return Object.values(element?.tags ?? {}).some(
    (tag) => typeof tag?.anchor === "string",
  );
}

/**
 * The elements a RUN involves.
 *
 * A connection takes part only when the breadboard references it — at least
 * one of its elements has a tag planted — and then ALL of its elements do,
 * planted or not, because the layout signature its sketch was compiled against
 * counts every one of them. An element with nothing on the board reaches no
 * net, so a board referenced only by such elements is not opened, not checked
 * and not complained about: an Arduino left unplugged, or a connection not set
 * up on this computer, must not stop a circuit that makes no use of it.
 */
export function runElements(elements) {
  const referenced = new Set();
  for (const e of elements ?? []) {
    if (e.connection && isElementPlanted(e)) referenced.add(e.connection);
  }
  return (elements ?? []).filter((e) => referenced.has(e.connection));
}

// ── The tag glyph ──────────────────────────────────────────────────────────

// A tag IS a signal flag — the same pentagon, point at the anchor, and the
// same plate for its label — so these are signals.js's glyph under the names
// this module's callers read (as `nextTagRotation` is). Why that size, and why
// neighbours overlap, is stated there once.

/** Tag width across its axis, in pitch units. */
export const TAG_W = FLAG_W;

/** Tag length along its axis, in pitch units. */
export const TAG_LEN = FLAG_LEN;

/**
 * Half the height of the plate the tag's label sits on — the flag's key disc.
 * One character makes it a disc; a two-digit pin stretches it into a pill.
 */
export const TAG_KEY_R = FLAG_KEY_R;

/** The tag as five world-coordinate vertices, POINT AT THE ANCHOR, so R turns
    it about its point for free. */
export const tagPolygon = flagPolygon;

/** Where the tag's label (its pin number, or the edge glyph) is printed: the
    middle of its body, clear of the point. Upright at every rotation. */
export const tagLabelPoint = flagKeyPoint;

/** The glyph a trigger tag prints: which edge it waits for. A symbol, not a
    word — it reads the same in every language. */
export function triggerGlyph(edge) {
  return edge === "falling" ? "↓" : edge === "either" ? "↕" : "↑";
}

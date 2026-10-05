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

// annotation-model.js — the desk's labels and notes (Feature 120) in 3D: the
// same words at the same place, so the captions a generated circuit or a demo
// bench carries still say what the circuit is.
//
// They lie flat at the height of the boards' top faces wherever they are —
// over a board or out over the bare desk. On the desk they draw ABOVE
// everything (the annotation layer is the top one), and a caption set down
// on the floor 8.5 mm below would hide behind the very board it captions.
//
// The desk draws them in WORLD px (styles/app.css `.annotation-text`: 12px
// type, 1.35 lines, 2px × 6px padding), which at PX_PER_UNIT 10 is the size
// used here. A note wraps at the desk's 320px; the 3D view has no text layout
// of its own, so it breaks a long line at about the same width by counting
// characters — close, not exact, and only ever for a note's line breaks.

import { parseColor } from "./palette.js";

/** The desk's annotation type, in pitch units (12px, 1.35 lines, padding). */
const TEXT = 1.2;
const LINE = TEXT * 1.35;
const PAD_X = 0.6;
const PAD_Y = 0.2;

/** A note's wrap width (the desk's 320px) and Inter's average glyph width as
    a share of the type size — enough to count characters to a line. */
const NOTE_WIDTH = 32 - 2 * PAD_X;
const GLYPH = 0.55;

/** Where the text lies: a hair above a board's top face (y 0). */
const PRINT_Y = 0.01;

/**
 * The lines a note shows: its own line breaks, and a long line broken at
 * spaces near the desk's wrap width. A label never wraps (the desk's rule).
 * @param {string} text
 * @param {boolean} wrap
 * @returns {string[]}
 */
export function annotationLines(text, wrap) {
  const perLine = Math.max(8, Math.floor(NOTE_WIDTH / (TEXT * GLYPH)));
  const out = [];
  for (const raw of String(text ?? "").split("\n")) {
    if (!wrap || raw.length <= perLine) {
      out.push(raw);
      continue;
    }
    let line = "";
    for (const word of raw.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (next.length > perLine && line) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Add one label or note.
 * @param {import("./scene-builder.js").SceneBuilder} sb
 */
export function buildAnnotation(sb, ann) {
  if (!Number.isFinite(ann?.x) || !Number.isFinite(ann?.y)) return false;
  const lines = annotationLines(ann.text, ann.kind === "note");
  if (!lines.some((l) => l.trim())) return false;
  const color = parseColor(ann.color) ?? sb.palette.text;
  lines.forEach((line, i) => {
    const x = ann.x + PAD_X;
    const z = ann.y + PAD_Y + LINE * (i + 0.5);
    sb.label({
      text: line,
      center: [x, PRINT_Y, z],
      height: TEXT,
      color,
      align: "left",
      weight: ann.kind === "label" ? 600 : 400,
    });
  });
  return true;
}

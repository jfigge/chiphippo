#!/usr/bin/env node
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

// Write src/web/scripts/model/export/digital-lib.js — the pin tables of the
// DIL chips in the Digital simulator's library that the Digital export
// (model/export/digital.js) places.
//
// WHY A COPY AND NOT A LOOKUP. A `.dig` file names a library chip by its file
// name (`<elementName>7400.dig</elementName>`) and Digital draws it from its
// own library, so the exporter never needs the chip's LOGIC — but it does need
// the chip's SHAPE: where each pin of a DIL package sits (DILShape.java: pin p
// of n is at (0, 40(p−1)) down the left and (20·(Width+1), 40(n−p)) up the
// right), and that depends on the library file's own `Width` attribute. A wire
// drawn to where a pin is not connects to nothing, silently. So the geometry is
// read from the library itself, once, here — and the same table lets
// tests/export-digital.test.js hold every mapped chip's pin NUMBERS and power
// pins to ours, so a chip whose Digital model is pinned differently can never
// be mapped by mistake.
//
// Run it against an unpacked Digital release (https://github.com/hneemann/Digital,
// GPL-3.0 like this app):
//
//     node scripts/extract-digital-pins.mjs /path/to/Digital/lib
//
// It only keeps the chips the exporter maps (`DIGITAL_FILES` in
// digital-parts.js), so the table cannot grow a line nothing reads. Run
// `make fmt` afterwards: the file is written as plain JSON.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DIGITAL_FILES } from "../src/web/scripts/model/export/digital-parts.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(
  HERE,
  "..",
  "src",
  "web",
  "scripts",
  "model",
  "export",
  "digital-lib.js",
);

/** Digital's default for a subcircuit's `Width` (Keys.WIDTH). */
const DEFAULT_WIDTH = 3;

const HEADER = fs
  .readFileSync(fileURLToPath(import.meta.url), "utf8")
  .split("\n")
  .slice(1, 19)
  .join("\n");

/** Every `.dig` file under `dir`, recursively, keyed by its base name. */
function indexLibrary(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".dig")) out.set(entry.name, full);
    }
  };
  walk(dir);
  return out;
}

/** The root `<attributes>` value of `key` as an int, or null. */
function rootInt(xml, key) {
  const attrs = xml.split("<visualElements>")[0];
  const m = new RegExp(
    `<string>${key}</string>\\s*<int>(-?\\d+)</int>`,
  ).exec(attrs);
  return m ? Number(m[1]) : null;
}

/**
 * Every top-level pin with a pinNumber: `{ n, label, out }`. A pin is an `In`,
 * an `Out`, or a `Clock` (the '161 takes its clock through one).
 */
function pinsOf(xml) {
  const pins = [];
  const re =
    /<visualElement>\s*<elementName>(In|Out|Clock)<\/elementName>([\s\S]*?)<\/visualElement>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const body = m[2];
    const label = /<string>Label<\/string>\s*<string>([^<]*)<\/string>/.exec(
      body,
    )?.[1];
    const n = /<string>pinNumber<\/string>\s*<string>(\d+)<\/string>/.exec(
      body,
    )?.[1];
    if (label != null && n != null) {
      pins.push({ n: Number(n), label: decode(label), out: m[1] === "Out" });
    }
  }
  return pins.sort((a, b) => a.n - b.n);
}

function decode(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function main() {
  const lib = process.argv[2];
  if (!lib || !fs.existsSync(lib)) {
    console.error(
      "usage: node scripts/extract-digital-pins.mjs /path/to/Digital/lib",
    );
    process.exit(2);
  }
  const files = indexLibrary(lib);
  const chips = {};
  const missing = [];
  for (const file of [...new Set(Object.values(DIGITAL_FILES))].sort()) {
    const full = files.get(file);
    if (!full) {
      missing.push(file);
      continue;
    }
    const xml = fs.readFileSync(full, "utf8");
    const pins = pinsOf(xml);
    const highest = Math.max(0, ...pins.map((p) => p.n));
    let count = Math.max(highest, rootInt(xml, "pinCount") ?? 0);
    if (count % 2) count += 1; // DILShape rounds an odd count up
    chips[file] = {
      width: rootInt(xml, "Width") ?? DEFAULT_WIDTH,
      pins: count,
      outputs: pins.filter((p) => p.out).map((p) => p.n),
      names: Object.fromEntries(pins.map((p) => [p.n, p.label])),
    };
  }
  if (missing.length) {
    console.error(`not in that library: ${missing.join(", ")}`);
    process.exit(1);
  }

  const body =
    `${HEADER}\n\n` +
    "// digital-lib.js — GENERATED by scripts/extract-digital-pins.mjs from the\n" +
    "// Digital simulator's DIL chip library (hneemann/Digital, GPL-3.0). Do not\n" +
    "// edit by hand: re-run the script against a Digital release instead.\n" +
    "//\n" +
    "// Per library file: its `Width` attribute (which places the right-hand pin\n" +
    "// column), its pin count, which pins are OUTPUTS, and each pin's label —\n" +
    "// the geometry model/export/digital.js draws to, and the table\n" +
    "// tests/export-digital.test.js holds our catalog's pin numbers against.\n\n" +
    `export const DIGITAL_LIB = Object.freeze(${JSON.stringify(chips, null, 2)});\n`;
  fs.writeFileSync(OUT, body);
  console.log(
    `wrote ${path.relative(process.cwd(), OUT)} (${Object.keys(chips).length} chips)`,
  );
}

main();

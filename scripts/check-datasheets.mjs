#!/usr/bin/env node
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

// Report which pin-assignments windows are missing their datasheet figure.
//
// THIS REPLACED A GENERATOR. `make datasheets` used to re-crop every PNG under
// src/web/datasheets/ out of the source PDFs; it never cropped them well enough
// to ship, so the crops are made BY HAND and committed, and the generator and
// its crop manifest are gone. What was actually wanted from the tooling was not
// the cropping — it was knowing WHICH crops are missing, because a part with no
// file is invisible: chip-pinout.js removes the <figure> on load error, so the
// window just shows a pin map and looks exactly like a part that never had a
// datasheet to begin with. That is the one question this answers.
//
// It is pure bookkeeping — the catalog against the committed files. No PDFs, no
// Electron, no network, and nothing is written.
//
// Usage: node scripts/check-datasheets.mjs [--strict]
//   --strict  exit 1 when a crop is missing (for CI; the default is to report
//             and exit 0, since some parts have no obtainable datasheet at all)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PALETTE_DEFS,
  datasheetCrop,
} from "../src/web/scripts/catalog/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CROP_DIR = path.join(ROOT, "src/web/datasheets");

// Parts with no `74LS*` datasheet to crop from, so their window deliberately
// shows the pin map alone. Listed here rather than left to show up as missing
// every run: a report that always names the same four unobtainable files is a
// report nobody reads to the end. The list is the ONLY hand-kept thing here —
// add a name once you have established there is nothing to crop, remove one to
// put it back on the to-do list.
const NO_DATASHEET = new Set(["74LS164", "74LS193", "74LS27", "74LS76"]);

const has = (name) => fs.existsSync(path.join(CROP_DIR, `${name}.png`));

// What the APP asks for, via the one rule that decides it: a packaged part's
// sheet IS its id, anything else has to name one with a `datasheet` field. Two
// defs may name the same file (both character-LCD modules share the HD44780
// controller sheet), so the wanted set is keyed by FILE and remembers who asked.
const wanted = new Map();
for (const def of PALETTE_DEFS) {
  const name = datasheetCrop(def);
  if (!name) continue; // declares no sheet — nothing to miss
  if (!wanted.has(name)) wanted.set(name, []);
  wanted.get(name).push(def);
}

const missing = [];
const excused = [];
for (const [name, defs] of [...wanted].sort(([a], [b]) => a.localeCompare(b))) {
  if (has(name)) continue;
  (NO_DATASHEET.has(name) ? excused : missing).push({ name, defs });
}

// The other direction: a file no def asks for. A chip dropped from the catalog
// leaves its PNG behind, and nothing else would ever mention it again.
const orphans = fs
  .readdirSync(CROP_DIR)
  .filter((f) => f.endsWith(".png"))
  .map((f) => f.replace(/\.png$/, ""))
  .filter((name) => !wanted.has(name))
  .sort();

const label = (defs) =>
  defs.map((d) => `${d.id} — ${d.title ?? "(untitled)"}`).join("; ");

console.log(
  `Datasheet crops: ${wanted.size - missing.length - excused.length}/${wanted.size} present ` +
    `(src/web/datasheets/, ${PALETTE_DEFS.length} catalog parts)`,
);

if (missing.length) {
  console.log(
    `\nMISSING — crop by hand into src/web/datasheets/<name>.png.` +
      `\n(Not a fault: the pinout window drops the figure and shows the pin map` +
      `\nalone, which is why these are invisible without asking.)`,
  );
  for (const { name, defs } of missing) {
    console.log(`  ${name}.png`.padEnd(24) + label(defs));
  }
}

if (excused.length) {
  console.log(`\nKnown to have no usable datasheet (skipped):`);
  for (const { name } of excused) console.log(`  ${name}`);
}

if (orphans.length) {
  console.log(`\nORPHANED — a committed crop no catalog part asks for:`);
  for (const name of orphans) console.log(`  ${name}.png`);
}

if (!missing.length && !orphans.length) {
  console.log(`\nEvery part that wants a datasheet figure has one.`);
}

if (process.argv.includes("--strict") && missing.length) process.exit(1);

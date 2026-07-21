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

// datasheet-crops.mjs — the crop manifest consumed by `make datasheets`
// (scripts/make-datasheets.mjs). One entry per catalog chip that has a
// datasheet PDF: the source basename (resolved case-insensitively in the
// datasheet directory), the 1-based `page` the diagram / table sits on, and the
// `crop` rectangle as FRACTIONS of that rendered page ({ x, y, w, h }, top-left
// origin, 0..1). The build script renders the page at high DPI and crops to
// this rectangle → src/web/datasheets/<id>.png.
//
// Crops are hand-tuned per datasheet — layouts vary by manufacturer, so each
// crop targets the most useful block available on that sheet:
//   • Fairchild "Connection Diagram + Function Table" (internal gate art + truth
//     table) — the ideal, captured whole.
//   • TI / Motorola sheets that separate the pinout from the table — the crop
//     favours the FUNCTION TABLE (the app already draws its own pin map, so the
//     table is the new value), or the internal LOGIC DIAGRAM for parts with no
//     table (counters, registers).
//   • Some diagrams live on page 2 (combined 138/139, 174/175, etc.) or behind a
//     Jameco distributor cover — hence the per-entry `page`.
//
// An entry with `crop: null` is skipped (no image). The four catalog chips with
// no matching 74LS* datasheet (74164, 74193, 7427, 7476) are absent by design —
// the pinout window simply shows no diagram for them.

/** @typedef {{ file: string, page: number, crop: {x:number,y:number,w:number,h:number}|null }} CropEntry */

/** @type {Record<string, CropEntry>} */
export const DATASHEET_CROPS = {
  // Combinational gates (catalog 74NN → datasheet 74LSNN). Fairchild sheets:
  // Connection Diagram + Function Table on page 1.
  "74LS00": { file: "74LS00", page: 1, crop: { x: 0.155, y: 0.42, w: 0.62, h: 0.21 } },
  7402: { file: "74LS02", page: 1, crop: { x: 0.15, y: 0.235, w: 0.34, h: 0.24 } }, // Motorola: diagram only
  7404: { file: "74LS04", page: 1, crop: { x: 0.155, y: 0.4, w: 0.57, h: 0.21 } },
  7408: { file: "74LS08", page: 1, crop: { x: 0.155, y: 0.42, w: 0.62, h: 0.21 } },
  7410: { file: "74LS10", page: 1, crop: { x: 0.155, y: 0.42, w: 0.62, h: 0.21 } },
  7411: { file: "74LS11", page: 1, crop: { x: 0.155, y: 0.42, w: 0.62, h: 0.21 } },
  7420: { file: "74LS20", page: 1, crop: { x: 0.155, y: 0.42, w: 0.63, h: 0.2 } },
  7430: { file: "74LS30", page: 1, crop: { x: 0.155, y: 0.42, w: 0.62, h: 0.2 } },
  7432: { file: "74LS32", page: 1, crop: { x: 0.155, y: 0.42, w: 0.62, h: 0.19 } },
  7486: { file: "74LS86", page: 1, crop: { x: 0.155, y: 0.42, w: 0.62, h: 0.19 } },
  74125: { file: "74LS125", page: 1, crop: { x: 0.155, y: 0.515, w: 0.62, h: 0.215 } },

  // Flip-flops / latches (Feature 100 wave). Fairchild sheets sit lower (long
  // titles); TI/Motorola sheets favour the function table.
  7473: { file: "74LS73", page: 1, crop: { x: 0.155, y: 0.545, w: 0.62, h: 0.235 } },
  7474: { file: "74LS74", page: 1, crop: { x: 0.155, y: 0.565, w: 0.62, h: 0.25 } },
  7475: { file: "74LS75", page: 1, crop: { x: 0.15, y: 0.095, w: 0.63, h: 0.235 } }, // TI: table + pinout
  74107: { file: "74LS107", page: 2, crop: { x: 0.55, y: 0.75, w: 0.31, h: 0.15 } }, // Jameco cover; LS107A table
  74151: { file: "74LS151", page: 1, crop: { x: 0.155, y: 0.5, w: 0.62, h: 0.3 } },
  74157: { file: "74LS157", page: 1, crop: { x: 0.15, y: 0.655, w: 0.33, h: 0.175 } }, // combined 157/158
  74161: { file: "74LS161", page: 2, crop: { x: 0.17, y: 0.15, w: 0.49, h: 0.205 } }, // connection diagram
  74165: { file: "74LS165", page: 1, crop: { x: 0.155, y: 0.595, w: 0.66, h: 0.28 } },
  74175: { file: "74LS175", page: 1, crop: { x: 0.49, y: 0.62, w: 0.33, h: 0.205 } }, // combined 174/175 (right)
  74138: { file: "74LS138", page: 2, crop: { x: 0.17, y: 0.145, w: 0.32, h: 0.49 } }, // combined 138/139 (left)
  74139: { file: "74LS139", page: 2, crop: { x: 0.5, y: 0.145, w: 0.3, h: 0.49 } }, // combined 138/139 (right)

  // 74LS wave (catalog ids already carry the LS).
  "74LS05": { file: "74LS05", page: 1, crop: { x: 0.155, y: 0.565, w: 0.62, h: 0.205 } },
  "74LS14": { file: "74LS14", page: 1, crop: { x: 0.155, y: 0.495, w: 0.62, h: 0.19 } },
  "74LS47": { file: "74LS47", page: 1, crop: { x: 0.185, y: 0.35, w: 0.245, h: 0.175 } }, // TI: DIP pinout
  "74LS85": { file: "74LS85", page: 1, crop: { x: 0.1, y: 0.575, w: 0.81, h: 0.29 } }, // TI: function table
  "74LS90": { file: "74LS90", page: 1, crop: { x: 0.155, y: 0.565, w: 0.66, h: 0.215 } },
  "74LS112": { file: "74LS112", page: 1, crop: { x: 0.155, y: 0.565, w: 0.62, h: 0.255 } },
  "74LS148": { file: "74LS148", page: 1, crop: { x: 0.15, y: 0.715, w: 0.34, h: 0.215 } }, // Motorola: pinout
  "74LS151": { file: "74LS151", page: 1, crop: { x: 0.155, y: 0.5, w: 0.62, h: 0.3 } },
  "74LS153": { file: "74LS153", page: 1, crop: { x: 0.155, y: 0.525, w: 0.66, h: 0.225 } },
  "74LS157": { file: "74LS157", page: 1, crop: { x: 0.15, y: 0.655, w: 0.33, h: 0.175 } },
  "74LS169": { file: "74LS169", page: 2, crop: { x: 0.3, y: 0.65, w: 0.36, h: 0.205 } }, // Jameco cover; conn diagram
  "74LS173": { file: "74LS173", page: 1, crop: { x: 0.07, y: 0.455, w: 0.31, h: 0.155 } }, // Motorola: conn diagram
  "74LS174": { file: "74LS174", page: 1, crop: { x: 0.15, y: 0.62, w: 0.33, h: 0.205 } }, // combined 174/175 (left)
  "74LS240": { file: "74LS240", page: 1, crop: { x: 0.155, y: 0.645, w: 0.33, h: 0.16 } }, // combined 240/241 (left)
  "74LS244": { file: "74LS244", page: 1, crop: { x: 0.155, y: 0.715, w: 0.35, h: 0.17 } }, // Motorola 240/241/244
  "74LS245": { file: "74LS245", page: 1, crop: { x: 0.09, y: 0.375, w: 0.44, h: 0.39 } }, // Motorola: diagram + table
  "74LS257": { file: "74LS257", page: 1, crop: { x: 0.33, y: 0.66, w: 0.4, h: 0.185 } }, // TI: function table
  "74LS259": { file: "74LS259", page: 2, crop: { x: 0.17, y: 0.15, w: 0.66, h: 0.4 } }, // conn + function + latch tables
  "74LS273": { file: "74LS273", page: 1, crop: { x: 0.07, y: 0.3, w: 0.44, h: 0.16 } }, // Motorola: conn diagram
  "74LS279": { file: "74LS279", page: 1, crop: { x: 0.1, y: 0.415, w: 0.4, h: 0.2 } }, // TI: function table
  "74LS283": { file: "74LS283", page: 1, crop: { x: 0.5, y: 0.6, w: 0.41, h: 0.29 } }, // TI: function table
  "74LS533": { file: "74LS533", page: 1, crop: { x: 0.16, y: 0.365, w: 0.62, h: 0.42 } }, // conn + logic + function
  "74LS573": { file: "74LS573", page: 2, crop: { x: 0.16, y: 0.365, w: 0.62, h: 0.42 } }, // Jameco cover
  "74LS595": { file: "74LS595", page: 2, crop: { x: 0.18, y: 0.05, w: 0.55, h: 0.48 } }, // ON: pinout + logic diagram
};

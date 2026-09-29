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

// model/export/ — a desktop in another tool's format (Feature 390). This is
// the front door: the formats there are, in the order the Export To menu lists
// them, and the one call that runs one.
//
//   kicad    a KiCad project folder (schematic + symbol library + library
//            table + project file) — to take the design to a PCB. KiCad
//            opens it as it is, and EasyEDA Pro imports it.
//   digital  a circuit for the Digital logic simulator — to keep simulating
//            it with the same chips, in a tool built for logic.
//
// Every writer is PURE: document in, file TEXT out. Where the files go is
// main's business (app/ipc/export.js), and main names no format it has not
// been told the files of.

import { exportDigital } from "./digital.js";
import { exportKicad } from "./kicad.js";

/** The formats, in menu order. `folder`: the export is a directory of files. */
export const EXPORT_FORMATS = Object.freeze([
  Object.freeze({ id: "kicad", folder: true, run: exportKicad }),
  Object.freeze({ id: "digital", folder: false, run: exportDigital }),
]);

/** Whether a document holds anything an export could carry. */
export function exportable(doc) {
  return (doc?.components ?? []).length > 0;
}

/**
 * Export one desktop.
 *
 * @param {string} format - an EXPORT_FORMATS id.
 * @param {object} doc - the desktop's plain document.
 * @param {{tabId:string, name:string, description?:string}} desktop
 * @returns {{ format:string, base:string,
 *   files: Array<{name:string, text:string}>, report: Array<object>,
 *   stats: {parts:number, nets:number} }}
 */
export function exportDesktop(format, doc, desktop) {
  const spec = EXPORT_FORMATS.find((f) => f.id === format);
  if (!spec) throw new Error(`unknown export format: ${format}`);
  return { format, ...spec.run(doc, desktop) };
}

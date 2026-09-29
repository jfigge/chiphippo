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

// integration-files.js — what Generate writes for one connection, in the
// connection's LANGUAGE: the one place that choice is read, so the Generate
// card knows nothing about C++ or Python. Pure.
//
//   · C++ (the default): ChipHippo.h, and the ChipHippoExample.ino that uses it;
//   · Python: chiphippo.py, and main.py (MicroPython), code.py + boot.py
//     (CircuitPython) that use it.
//
// `main` is the file the board's own code imports; `files` is everything
// the Generate viewer shows, `main` first (Copy and Save As… there act on
// whichever file is on show).

import {
  HEADER_FILE,
  generateExample,
  generateHeader,
} from "./integration-codegen.js";
import {
  generatePythonExamples,
  generatePythonModule,
} from "./integration-codegen-python.js";

/**
 * @param {object} opts
 * @param {object} opts.connection the settings record
 * @param {Array} opts.elements the desk's elements
 * @param {string} [opts.projectName]
 * @param {string} [opts.desktopName]
 * @param {string} [opts.appVersion]
 * @returns {{language: "cpp"|"python", main: {name: string, text: string},
 *   files: Array<{name: string, text: string}>, hash: number,
 *   warnings: Array}}
 */
export function connectionFiles(opts) {
  if (opts.connection?.language === "python") {
    const module = generatePythonModule(opts);
    const main = { name: module.name, text: module.text };
    return {
      language: "python",
      main,
      files: [main, ...generatePythonExamples(opts)],
      hash: module.hash,
      warnings: module.warnings,
    };
  }
  const header = generateHeader(opts);
  const main = { name: HEADER_FILE, text: header.text };
  return {
    language: "cpp",
    main,
    files: [main, generateExample(opts)],
    hash: header.hash,
    warnings: header.warnings,
  };
}

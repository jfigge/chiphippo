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

// integration-files.js — what Generate writes for one connection, in the
// connection's LANGUAGE: the one place that choice is read, so the Generate
// card knows nothing about C++ or Python. Pure.
//
//   · C++ (the default): ChipHippo.h, and the ChipHippoExample.ino that uses it;
//   · Python: chiphippo.py, and main.py (MicroPython), code.py + boot.py
//     (CircuitPython) that use it.
//
// `main` is the file Save and Copy mean — the one the board's own code
// imports; `files` is everything View files shows, `main` first.

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

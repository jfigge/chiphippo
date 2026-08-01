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

// make-gate-demos.mjs — write the per-chip demonstration projects in demos/.
//
// ONE PROJECT PER CATALOG GROUP, one desktop per chip in it: the catalog's own
// `group` field is the organising fact (NAND, Flip-flop, Multiplexer…), so the
// demos track the palette rather than a second opinion about which part is
// like which. A group's project is named for the group and holds a desktop for
// every chip in it, in catalog order — open Multiplexer.chiphippo and the '151,
// '153, '157 and '257 are four tabs of the same idea, wired the same way, ready
// to compare.
//
// Every desktop is laid out by demo-bench.mjs and proved out by demo-build.mjs
// against the real simulation engine before anything reaches a file. A group
// with no spec for one of its chips fails the run: the point of grouping by
// the catalog is that the coverage question has one answer.
//
// The Memory, Interface and PROCESSOR groups are deliberately NOT here — a RAM
// or a CPU cannot be demonstrated by flipping switches at it; those are
// demos/65xx-*, which carry a program to run.
//
// TWO OUTPUTS, ONE BUILD. Every desktop is also written on its own to
// src/web/demos/<ref>.json — the copy that ships INSIDE the app, which a
// chip's pin-assignments window offers as its example circuit. Both come from
// the same buildDemo call in the same pass, so the two can never drift, and
// gate-demos.test.js holds them to byte-for-byte agreement.
//
//   node scripts/make-gate-demos.mjs        (or `make demos`)

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { DEMOS } from "./demo-specs.mjs";
import {
  assertComplete,
  buildDemo,
  catalogGroups,
  fileNameOf,
  validateDemo,
} from "./demo-build.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "demos");
// The SHIPPED copy of the very same desktops: one document per chip, bundled
// under src/web/ so it rides the existing "web/**/*" packaging glob (the ride
// make-datasheets.mjs gives its crops) and main can read it with
// path.join(__dirname, "..", "web", …) identically under `make debug` and
// inside app.asar. This is what a pin-assignments window's "example circuit"
// button opens — see src/app/main.js's demo:read.
const WEB_DIR = join(ROOT, "src", "web", "demos");

function main() {
  const groups = catalogGroups();
  const specs = new Map(DEMOS.map((spec) => [spec.ref, spec]));
  assertComplete(groups, specs);

  mkdirSync(WEB_DIR, { recursive: true });
  const shipped = new Set();

  let desktops = 0;
  for (const [group, ids] of groups) {
    const tabs = ids.map((id, i) => {
      const spec = specs.get(id);
      const built = buildDemo(spec);
      const proof = validateDemo(built);
      console.log(
        `demos: ${group.padEnd(15)} ${id.padEnd(8)} ` +
          `${String(built.doc.components.length).padStart(3)} parts, ` +
          `${String(built.doc.wires.length).padStart(3)} wires — ${proof}`,
      );
      // The bundled copy and the group project's tab hold the SAME document,
      // written in the same pass from the same buildDemo call — there is no
      // second build for them to drift apart from, and gate-demos.test.js
      // compares them byte for byte. Minified because nobody reads this one:
      // the pretty copy of the very same desktop is demos/<Group>.chiphippo.
      writeFileSync(
        join(WEB_DIR, `${id}.json`),
        JSON.stringify({ ref: id, title: spec.title, doc: built.doc }) + "\n",
      );
      shipped.add(`${id}.json`);

      return {
        id: `t${i + 1}`,
        name: id,
        description: spec.title,
        doc: built.doc,
      };
    });

    const file = fileNameOf(group);
    writeFileSync(
      join(OUT_DIR, file),
      JSON.stringify(
        {
          version: 4,
          name: group,
          description: `${group} — one desktop per catalog part.`,
          activeTab: "t1",
          nextIndex: tabs.length + 1,
          tabs,
        },
        null,
        2,
      ) + "\n",
    );
    desktops += tabs.length;
    console.log(`demos: → ${file} (${tabs.length} desktops)`);
  }

  // src/web/demos/ is owned ENTIRELY by this script, so what it did not just
  // write does not belong there: a chip dropped from the catalog (or moved
  // into PROGRAM_ONLY) would otherwise leave a document behind that still puts
  // an example button on a pin-assignments window and still opens a circuit for
  // a part that has gone.
  for (const file of readdirSync(WEB_DIR)) {
    if (!file.endsWith(".json") || shipped.has(file)) continue;
    rmSync(join(WEB_DIR, file));
    console.log(`demos: ✕ src/web/demos/${file} (no such demo any more)`);
  }

  console.log(
    `demos: ${groups.size} group projects, ${desktops} desktops in total`,
  );
  console.log(`demos: → src/web/demos/ (${shipped.size} bundled examples)`);
}

main();

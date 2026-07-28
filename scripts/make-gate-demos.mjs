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
// The Memory and Interface groups are deliberately NOT here — a RAM or a CPU
// cannot be demonstrated by flipping switches at it; those are demos/65xx-*,
// which carry a program to run.
//
//   node scripts/make-gate-demos.mjs        (or `make demos`)

import { writeFileSync } from "node:fs";
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

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "demos");

function main() {
  const groups = catalogGroups();
  const specs = new Map(DEMOS.map((spec) => [spec.ref, spec]));
  assertComplete(groups, specs);

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
  console.log(
    `demos: ${groups.size} group projects, ${desktops} desktops in total`,
  );
}

main();

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

// make-gate-demos.mjs — write the per-chip demonstration DESKTOPS of
// demos/GateTests.chiphippo. One desktop per spec in demo-specs.mjs, laid out
// by demo-bench.mjs and proved out by demo-build.mjs against the real
// simulation engine before anything reaches the file.
//
// The two desktops that were built BY HAND (the '00 and the '02) are preserved
// verbatim — this script only ever replaces the desktops it generated itself,
// so it is safe to re-run.
//
//   node scripts/make-gate-demos.mjs        (or `make demos`)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { DEMOS } from "./demo-specs.mjs";
import {
  buildDemo,
  validateDemo,
  HAND_BUILT,
  FIRST_GENERATED_TAB,
} from "./demo-build.mjs";

const PROJECT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "demos",
  "GateTests.chiphippo",
);

function main() {
  const project = JSON.parse(readFileSync(PROJECT, "utf8"));

  const kept = project.tabs
    .filter((tab) => HAND_BUILT.has(tab.id))
    .map((tab) => ({ ...tab, name: HAND_BUILT.get(tab.id) }));
  if (kept.length !== HAND_BUILT.size) {
    throw new Error(
      `${PROJECT}: expected the hand-built desktops ${[...HAND_BUILT.keys()].join(", ")}`,
    );
  }

  const generated = DEMOS.map((spec, i) => {
    const built = buildDemo(spec);
    const proof = validateDemo(built);
    console.log(
      `demos: ${spec.ref.padEnd(8)} ` +
        `${String(built.doc.components.length).padStart(3)} parts, ` +
        `${String(built.doc.wires.length).padStart(3)} wires — validated: ${proof}`,
    );
    return {
      id: `t${FIRST_GENERATED_TAB + i}`,
      name: spec.ref,
      description: spec.title,
      doc: built.doc,
    };
  });

  const tabs = [...kept, ...generated];
  const out = {
    version: 4,
    name: project.name,
    ...(project.description ? { description: project.description } : {}),
    activeTab: tabs.some((t) => t.id === project.activeTab)
      ? project.activeTab
      : tabs[0].id,
    nextIndex: FIRST_GENERATED_TAB + generated.length,
    tabs,
  };
  writeFileSync(PROJECT, JSON.stringify(out, null, 2) + "\n");
  console.log(
    `demos: GateTests.chiphippo — ${tabs.length} desktops ` +
      `(${kept.length} hand-built, ${generated.length} generated)`,
  );
}

main();

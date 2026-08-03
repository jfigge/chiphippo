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

// desk-brief.test.js — the circuit as the model reads it (Feature 320). The two
// properties that matter: it says enough to reason about (parts, pin-level nets,
// switch positions, the findings) and it leaks no geometry, which is the same
// rule the builder's prompt enforces in the other direction.

import test from "node:test";
import assert from "node:assert/strict";

import { DeskDoc, normalizeDocument } from "../model/desk-doc.js";
import { buildNetlist } from "../sim/netlist.js";
import { compileNetlist } from "../model/autobuild.js";
import { reviewDesk } from "../model/desk-review.js";
import { buildDeskBrief, MAX_PARTS, MAX_NETS } from "../ai/desk-brief.js";
import { buildReviewSystemPrompt } from "../ai/catalog-brief.js";

/** A compiled bench: a NAND fed from a switch bank, driving a lamp. */
function bench() {
  const built = compileNetlist({
    title: "NAND bench",
    parts: [
      { id: "U1", ref: "74LS00", label: "the gate" },
      { id: "SW", ref: "sw-dip8" },
      { id: "D1", ref: "led" },
    ],
    nets: [
      { name: "A", members: ["U1.1A", "SW.1A"] },
      { name: "A_SRC", members: ["SW.1B", "VCC"] },
      { name: "B", members: ["U1.1B", "SW.2A"] },
      { name: "B_SRC", members: ["SW.2B", "VCC"] },
      { name: "Y", members: ["U1.1Y", "D1.A"] },
      { name: "LAMP", members: ["D1.K", "GND"] },
    ],
  });
  assert.ok(built.ok, JSON.stringify(built.errors));
  const doc = normalizeDocument(built.document);
  const netlist = buildNetlist(doc);
  return { doc, netlist, review: reviewDesk(doc, netlist) };
}

const briefOf = (b) => buildDeskBrief(b.doc, b.netlist, b.review);

test("the brief names every part by its id and ref", () => {
  const b = bench();
  const text = briefOf(b);
  for (const comp of b.doc.components) {
    assert.match(text, new RegExp(`\\b${comp.id}\\b`), `${comp.id} is listed`);
  }
  assert.match(text, /74LS00/);
  assert.match(text, /Power supply|psu/i);
});

test("nets are described by the PINS they join, not by holes", () => {
  const b = bench();
  const text = briefOf(b);
  const nand = b.doc.components.find((c) => c.ref === "74LS00");
  // A pin-level member, in the same `id.PIN` form the builder's DSL uses.
  assert.match(text, new RegExp(`${nand.id}\\.1A\\b`));
  assert.match(text, new RegExp(`${nand.id}\\.VCC\\b`));
});

test("the brief gives no hole positions, columns or anchors", () => {
  const b = bench();
  const text = briefOf(b);
  // Every board id followed by a ROW letter and a column number is a hole. Net
  // ids take exactly that form and are allowed — they are what the findings and
  // the probe tool quote — so they are the only occurrences permitted, and each
  // one has to be a net that really exists.
  const holes = text.match(/\bbb\d+\.[a-j]\d+\b/g) ?? [];
  for (const h of holes) {
    assert.ok(b.netlist.nets.has(h), `${h} is a net id, not a stray hole`);
  }
  assert.doesNotMatch(text, /anchor/i);
  assert.doesNotMatch(text, /\bcolumn\b/i);
});

test("a switch bank's current positions are spelled out", () => {
  const b = bench();
  const sw = b.doc.components.find((c) => c.ref === "sw-dip8");
  sw.params = { ...sw.params, states: [true, false, true, ...Array(5).fill(false)] }; // prettier-ignore
  const netlist = buildNetlist(b.doc);
  const text = buildDeskBrief(b.doc, netlist, reviewDesk(b.doc, netlist));
  assert.match(text, /closed: 1,3/, "the thrown positions are named");
});

test("a part's own Name and Description reach the model", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0);
  const chip = doc.addComponent({
    kind: "chip",
    ref: "74LS00",
    board: "bb2",
    anchor: "e5",
  });
  doc.setComponentMeta(chip.id, {
    name: "carry gate",
    description: "should pull LOW when both bits are set",
  });
  const json = doc.toJSON();
  const netlist = buildNetlist(json);
  const text = buildDeskBrief(json, netlist, reviewDesk(json, netlist));
  assert.match(text, /carry gate/);
  assert.match(text, /both bits are set/);
});

test("a clean desk says so rather than listing nothing", () => {
  const b = bench();
  const text = buildDeskBrief(b.doc, b.netlist, {
    stats: b.review.stats,
    findings: [],
  });
  assert.match(text, /Nothing\./);
});

test("findings ride the brief verbatim, with their severity and code", () => {
  const b = bench();
  const text = buildDeskBrief(b.doc, b.netlist, {
    stats: b.review.stats,
    findings: [
      { code: "SHORT", severity: "fault", message: "Opposing supplies meet." },
    ],
  });
  assert.match(text, /\[fault\] SHORT: Opposing supplies meet\./);
});

test("a desk too big for the prompt says what it left out", () => {
  const b = bench();
  const text = buildDeskBrief(b.doc, b.netlist, b.review, {
    maxParts: 1,
    maxNets: 1,
  });
  assert.match(text, /more parts, not listed here/);
  assert.match(text, /more nets, not listed here/);
  assert.ok(MAX_PARTS > 1 && MAX_NETS > 1, "the shipped caps are generous");
});

test("the review prompt forbids re-diagnosis and carries the catalogue", () => {
  const prompt = buildReviewSystemPrompt();
  assert.match(prompt, /findings are FACTS/i);
  assert.match(prompt, /Do NOT re-derive/);
  assert.match(prompt, /74LS00/, "the derived parts catalogue rides along");
  assert.doesNotMatch(prompt, /Language/, "no language section unless asked");
});

test("the review prompt names the language to answer in", () => {
  const prompt = buildReviewSystemPrompt(undefined, "Deutsch");
  assert.match(prompt, /Answer in Deutsch/);
  assert.match(prompt, /net\s+ids and finding codes exactly as they are given/);
});

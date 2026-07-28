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

// The path from a model's reply to something placeable, with no network and no
// DOM. What it has to guarantee is narrow and absolute: a reply that does not
// PASS never becomes a design clip.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFromReply,
  buildFromSpec,
  buildStepsFromReply,
  parseNetlist,
  partitionFaults,
} from "../ai/generate.js";
import {
  buildCatalogCard,
  buildRepairMessage,
  buildSystemPrompt,
} from "../ai/catalog-brief.js";
import { PALETTE_DEFS, partDef } from "../catalog/index.js";

const COUNTER_SPEC = {
  title: "4-bit counter on an LED bar",
  parts: [
    { id: "CTR", ref: "74LS161" },
    { id: "BAR", ref: "bar8" },
    { id: "CLK", ref: "clock" },
  ],
  nets: [
    {
      name: "RUN",
      members: ["CTR.CLR", "CTR.LOAD", "CTR.ENP", "CTR.ENT", "VCC"],
    },
    { name: "CLOCK", members: ["CLK.out", "CTR.CLK"] },
    { name: "CLKGND", members: ["CLK.gnd", "GND"] },
    { name: "Q0", members: ["CTR.QA", "BAR.1"] },
    { name: "Q1", members: ["CTR.QB", "BAR.2"] },
    { name: "Q2", members: ["CTR.QC", "BAR.3"] },
    { name: "Q3", members: ["CTR.QD", "BAR.4"] },
    { name: "BARGND", members: ["BAR.K", "GND"] },
  ],
  tests: [
    { name: "reset state", edges: 0, expect: { BAR: "00000000" } },
    { name: "one edge", edges: 1, expect: { BAR: "10000000" } },
  ],
};

// ── Parsing ─────────────────────────────────────────────────────────────────

test("a bare JSON reply parses", () => {
  const r = parseNetlist('{"parts":[],"nets":[]}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.spec, { parts: [], nets: [] });
});

test("a fenced block or a leading sentence is tolerated", () => {
  // Structured output SHOULD make this unnecessary, but a local
  // OpenAI-compatible server may ignore `response_format` entirely.
  for (const text of [
    '```json\n{"parts":[],"nets":[]}\n```',
    'Here is the design:\n{"parts":[],"nets":[]}',
    '```\n{"parts":[],"nets":[]}```',
  ]) {
    assert.equal(parseNetlist(text).ok, true, text);
  }
});

test("a test's set/expect pair list folds back into a map", () => {
  // The wire schema cannot express an open-ended map, so a constrained model
  // emits pairs. Nothing past this seam should ever see the list form.
  const r = parseNetlist(
    JSON.stringify({
      parts: [],
      nets: [],
      tests: [
        {
          name: "sum",
          set: [{ target: "SW1", value: "1010" }],
          expect: [
            { target: "BAR", value: "0101" },
            { target: "D1.A", value: "H" },
          ],
        },
      ],
    }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.spec.tests[0].set, { SW1: "1010" });
  assert.deepEqual(r.spec.tests[0].expect, { BAR: "0101", "D1.A": "H" });
});

test("a server that ignores the schema and emits maps still parses", () => {
  const r = parseNetlist(
    JSON.stringify({
      parts: [],
      nets: [],
      tests: [{ name: "sum", expect: { BAR: "0101" } }],
    }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.spec.tests[0].expect, { BAR: "0101" });
  assert.equal("set" in r.spec.tests[0], false, "an absent set stays absent");
});

test("a null optional reads as absent, not as a value", () => {
  // Strict mode has no "omit" — every key is required, so the model spells an
  // absent field as null. Downstream contracts never learned about that.
  const r = parseNetlist(
    JSON.stringify({
      title: null,
      parts: [{ id: "U1", ref: "74LS08", label: null }],
      nets: [],
      tests: [{ name: "t", set: null, edges: null, expect: [] }],
    }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.spec.parts[0], { id: "U1", ref: "74LS08" });
  assert.equal("title" in r.spec, false);
  assert.deepEqual(r.spec.tests[0], { name: "t", expect: {} });
});

test("a reply with no object in it fails rather than being guessed at", () => {
  for (const text of ["", "   ", "I cannot build that.", "[1,2,3]", null]) {
    const r = parseNetlist(text);
    assert.equal(r.ok, false, JSON.stringify(text));
    assert.equal(r.errors[0].code, "NOT_JSON");
  }
});

test("malformed JSON reports the parse error, it does not throw", () => {
  const r = parseNetlist('{"parts": [,]}');
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, "NOT_JSON");
});

// ── Build ───────────────────────────────────────────────────────────────────

test("a passing spec becomes a placeable clip", () => {
  const built = buildFromSpec(COUNTER_SPEC);
  assert.equal(
    built.ok,
    true,
    built.ok ? "" : built.faults.map((f) => f.message).join("; "),
  );
  assert.ok(built.clip.boards.length, "the clip carries its boards");
  assert.equal(built.title, "4-bit counter on an LED bar");
  assert.equal(built.results.length, 2, "its own tests ran");
  assert.ok(
    built.results.every((r) => r.ok),
    "and passed",
  );
});

test("the clip comes from the LOADED document, not the compiled one", () => {
  // What the desk places must be what the loader would keep — otherwise a
  // normalisation could silently differ between the check and the paste.
  const built = buildFromSpec(COUNTER_SPEC);
  const clipBoards = built.clip.boards.length;
  assert.equal(clipBoards, built.document.boards.length);
});

test("a spec that fails its OWN test never becomes a clip", () => {
  // The highest-value gate: the circuit is built correctly and computes the
  // wrong thing. Nothing about the document looks wrong.
  const built = buildFromSpec({
    ...COUNTER_SPEC,
    tests: [{ name: "backwards", edges: 1, expect: { BAR: "00000001" } }],
  });
  assert.equal(built.ok, false);
  assert.equal(built.clip, undefined, "nothing to place");
  const failed = built.faults.find((f) => f.code === "TEST_FAILED");
  assert.ok(failed, "reported as a test failure");
  assert.equal(failed.kind, "repair", "the spec's mistake, so it can be fixed");
});

test("an unknown chip is a repairable spec error", () => {
  const built = buildFromSpec({
    parts: [{ id: "U1", ref: "74LS9999" }],
    nets: [{ name: "N", members: ["U1.1", "GND"] }],
  });
  assert.equal(built.ok, false);
  assert.equal(built.faults[0].code, "UNKNOWN_REF");
});

test("buildFromReply carries the parsed spec through on success", () => {
  const built = buildFromReply(JSON.stringify(COUNTER_SPEC));
  assert.equal(built.ok, true);
  assert.equal(built.spec.title, COUNTER_SPEC.title);
});

test("buildFromReply reports a parse failure in the fault shape", () => {
  const built = buildFromReply("nope");
  assert.equal(built.ok, false);
  assert.equal(built.faults[0].code, "NOT_JSON");
});

test("faults split into what the model can fix and what it cannot", () => {
  const { abort, repair } = partitionFaults([
    { code: "A", kind: "abort" },
    { code: "B", kind: "repair" },
    { code: "C" }, // unclassified errors are the spec's, not ours
  ]);
  assert.deepEqual(
    abort.map((f) => f.code),
    ["A"],
  );
  assert.deepEqual(
    repair.map((f) => f.code),
    ["B", "C"],
  );
});

// ── The derived prompt ──────────────────────────────────────────────────────

test("the catalog card names every part in the palette", () => {
  // The whole point of deriving it: a chip added to the catalog is available to
  // the model the moment it lands, with no prompt to remember to update.
  const card = buildCatalogCard();
  for (const def of PALETTE_DEFS) {
    assert.ok(card.includes(def.id), `${def.id} is offered`);
  }
});

test("pin names are quoted case-exactly, because the resolver is case-first", () => {
  // 74LS47 distinguishes its A–D inputs from its a–g segment outputs by CASE
  // alone. Folding either way would make the model's spelling ambiguous.
  const card = buildCatalogCard([partDef("74LS47")]);
  assert.match(card, /\d+:A\b/, "the uppercase input survives");
  assert.match(card, /\d+:a\b/, "and so does the lowercase output");
});

test("bricks are described by their terminals, not by pins they do not have", () => {
  const card = buildCatalogCard([partDef("psu"), partDef("clock")]);
  assert.match(card, /psu — .*\+ -/);
  assert.match(card, /clock — .*out gnd/);
});

test("the system prompt states the rules the compiler actually enforces", () => {
  const prompt = buildSystemPrompt();
  // Each of these is a real fault the ladder raises; a prompt that failed to
  // mention one would spend a repair round teaching it every time.
  assert.match(prompt, /NEVER list a power pin/);
  assert.match(prompt, /at least two members/);
  assert.match(prompt, /at most one net/);
  assert.match(prompt, /Two outputs must not share a net/);
  assert.match(prompt, /series resistor/);
  // The compiler adds the pull itself, so the netlist must not: a spec that
  // brings its own gets it, and one that does not gets one anyway — but a
  // model that thinks a bare switch DRIVES its input writes a circuit whose
  // every test fails, which is the round this sentence exists to save.
  assert.match(prompt, /Switches do NOT need a pull resistor/);
  // Both proved against the demo corpus in autobuild-corpus.test.js: a
  // switched enable leaves the outputs at Z and L6 rejects the design, and the
  // flipped LED is how all 52 benches read an active-low output.
  assert.match(prompt, /ACTIVE-LOW output gets its LED the other way up/);
  // The note is written for someone looking at a circuit they did not build.
  assert.match(prompt, /ONE paragraph, plain prose/);
  // Tri-state: the card MARKS every output enable and the legend explains it,
  // because nothing in a pin's name ("1G", "OE", "M") says active-low and a
  // part whose enable is left out comes up driving nothing at all.
  assert.match(prompt, /ACTIVE-LOW OUTPUT ENABLE/);
  assert.match(
    prompt,
    /74LS244 \[DIP-20\][^\n]*1:1G!/,
    "the mark is on the pin",
  );
  assert.match(prompt, /74LS244 \[DIP-20\][^\n]*18:1Y1>/, "outputs marked too");
  assert.ok(prompt.length > 4000, "over the prompt-cache minimum");
});

test("the repair message is structured faults, never prose", () => {
  const msg = buildRepairMessage([
    {
      code: "AMBIGUOUS_PIN",
      path: "nets[3].members[1]",
      message: 'Two pins named "A".',
      candidates: [7, 13],
    },
  ]);
  assert.match(msg, /AMBIGUOUS_PIN at nets\[3\]\.members\[1\]/);
  assert.match(msg, /candidates: 7, 13/);
  assert.match(msg, /return the whole corrected JSON object/);
});

// ── Stepping ────────────────────────────────────────────────────────────────

test("the stepped build and the drained one agree, all the way to the clip", () => {
  // `buildFromReply` IS the drained generator, so this proves the seam rather
  // than two implementations — but it is the assertion that would catch the
  // day someone re-forks them.
  const reply = JSON.stringify(COUNTER_SPEC);
  const sync = buildFromReply(reply);

  const it = buildStepsFromReply(reply);
  const labels = [];
  let step = it.next();
  while (!step.done) {
    labels.push(step.value.label);
    step = it.next();
  }
  const stepped = step.value;

  assert.equal(stepped.ok, true, JSON.stringify(stepped.faults));
  assert.equal(stepped.ok, sync.ok);
  assert.equal(stepped.title, sync.title);
  assert.equal(stepped.clip.boards.length, sync.clip.boards.length);
  assert.deepEqual(
    stepped.results.map((r) => [r.name, r.ok]),
    sync.results.map((r) => [r.name, r.ok]),
  );
  assert.match(labels[0], /Compiling/, "compiling is announced first");
  assert.ok(labels.length > 1, "and the ladder's own gates follow");
});

test("a reply that will not parse yields nothing before it gives up", () => {
  // There is nothing to narrate about text that is not a netlist, and a label
  // that flashed "Compiling…" for an unparseable reply would be a small lie.
  const it = buildStepsFromReply("not json at all");
  const first = it.next();
  assert.equal(first.done, true, "it refuses before any work is announced");
  assert.equal(first.value.ok, false);
  assert.equal(first.value.faults[0].code, "NOT_JSON");
});

test("the design's own explanation reaches the caller as well as the desk", () => {
  // Two audiences for one paragraph: the panel says it while the user decides
  // whether to place the design, and the desk keeps it long after the
  // conversation is gone.
  const notes = "A 74LS161 free-runs from the clock and drives the bar.";
  const built = buildFromSpec({ ...COUNTER_SPEC, notes });
  assert.equal(built.ok, true);
  assert.equal(built.notes, notes, "handed back for the panel");
  assert.ok(
    built.document.annotations.some((a) => notes.startsWith(a.text)),
    "and stamped on the desk",
  );
  assert.equal(
    buildFromSpec(COUNTER_SPEC).notes,
    "",
    "a spec without one reports no note rather than undefined",
  );
});

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

// generate.js — reply text in, a placeable design out (Feature 260).
//
// The whole path from "the model finished talking" to "there is a circuit to
// place" lives here, DOM-free, so it is testable with no window and no network:
//
//   text ──▶ parseNetlist ──▶ compileNetlist ──▶ verifyBuild ──▶ designClipOf
//
// Everything is fail-closed. A reply that will not parse, will not compile, or
// will not PASS is never handed to the desk — the panel shows what went wrong
// and offers the model the faults back. That is the point of the ladder: the
// user should never be shown a generated circuit that has not been run.

import { tf } from "../i18n.js";
import { compileNetlist, designClipOf } from "../model/autobuild.js";
import { verifySteps } from "../model/autobuild-verify.js";

/**
 * How many tests a generated design must carry. The prompt quotes this
 * number (ai/catalog-brief.js), so it is stated once.
 */
export const MIN_TESTS = 2;

/**
 * The test SUITE's own faults — the ones no single test can have.
 *
 * L7 is the only gate that checks a design against what was ASKED for rather
 * than against itself, and it checks only what the tests check. A spec with
 * no tests passed it vacuously; one whose tests all apply the same inputs
 * proved one state and claimed a suite. Neither is a circuit fault, so neither
 * belongs to the verifier, which other callers run without tests at all — it
 * is the AI builder's rule for what a design must bring with it.
 */
export function testSuiteFaults(spec) {
  const tests = Array.isArray(spec?.tests) ? spec.tests : [];
  const faults = [];
  if (tests.length < MIN_TESTS) {
    faults.push({
      gate: "L7",
      kind: "repair",
      code: "TOO_FEW_TESTS",
      message:
        `The spec carries ${tests.length} test${tests.length === 1 ? "" : "s"}; ` +
        `a design needs at least ${MIN_TESTS}, because they are the only check ` +
        `that it does what was asked. Give each one a different input state ` +
        `(or a different number of clock edges) and what that state must show.`,
    });
  }
  const seen = new Map(); // input state → the first test that applied it
  tests.forEach((t, i) => {
    const name = typeof t?.name === "string" && t.name ? t.name : `tests[${i}]`;
    const set = t?.set && typeof t.set === "object" ? t.set : {};
    const state = JSON.stringify([
      Object.entries(set)
        .map(([k, v]) => [k, String(v)])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      Number.isInteger(t?.edges) ? t.edges : 0,
    ]);
    if (seen.has(state)) {
      faults.push({
        gate: "L7",
        kind: "repair",
        code: "DUPLICATE_TEST",
        message:
          `"${name}" applies exactly the inputs "${seen.get(state)}" does, so ` +
          `it proves nothing new — give it a different input state.`,
        test: name,
      });
    } else {
      seen.set(state, name);
    }
  });
  return faults;
}

/** Drain a step generator to its return value. */
function drain(iterator) {
  let step = iterator.next();
  while (!step.done) step = iterator.next();
  return step.value;
}

/**
 * Fold a `[{target, value}]` pair list back into the `{target: value}` map the
 * verifier reads.
 *
 * The wire schema cannot express an open-ended map (see `PIN_MAP` in
 * `app/ai/providers.js`), so a schema-constrained model emits pairs. A local
 * OpenAI-compatible server may ignore the schema entirely and emit the map
 * directly, so both are accepted — and the map is the only shape that leaves
 * this module, which is why nothing downstream knows about the pair list.
 *
 * @returns the map, or undefined for anything unusable (an absent `set` must
 *   stay absent rather than become an empty object the verifier then "applies").
 */
function pinMap(value) {
  if (Array.isArray(value)) {
    const out = {};
    for (const pair of value) {
      if (!pair || typeof pair !== "object") continue;
      if (typeof pair.target !== "string" || !pair.target) continue;
      out[pair.target] = String(pair.value ?? "");
    }
    return out;
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

/**
 * Strip null-valued keys, everywhere.
 *
 * Strict structured outputs cannot express an omitted property — every key must
 * appear in `required` — so "absent" is spelled as an explicit `null` (see
 * `optional` in `app/ai/providers.js`). Dropping them here means the spec that
 * leaves this module has exactly the shape it always had: a part with no label
 * has no `label` key, not a null one. Nothing in a netlist is legitimately
 * null, so this needs no exceptions.
 */
function dropNulls(value) {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === null) continue;
    out[key] = dropNulls(v);
  }
  return out;
}

/** A spec with every test's `set`/`expect` folded to map form. */
function foldPinMaps(spec) {
  if (!Array.isArray(spec.tests)) return spec;
  return {
    ...spec,
    tests: spec.tests.map((t) => {
      if (!t || typeof t !== "object") return t;
      const out = { ...t };
      for (const key of ["set", "expect"]) {
        if (!(key in out)) continue;
        const folded = pinMap(out[key]);
        if (folded === undefined) delete out[key];
        else out[key] = folded;
      }
      return out;
    }),
  };
}

/**
 * Pull the netlist object out of a reply.
 *
 * Structured output means the reply SHOULD be bare JSON, but a local
 * OpenAI-compatible server may not honour `response_format` at all — so a
 * fenced block or surrounding prose is tolerated rather than rejected. What is
 * NOT tolerated is guessing at a repair: a reply with no object in it fails.
 *
 * @param {string} text
 * @returns {{ok:true, spec:object}|{ok:false, errors:Array}}
 */
export function parseNetlist(text) {
  const raw = String(text ?? "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : raw;
  // The first `{` to the last `}` — enough to survive a leading sentence.
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return {
      ok: false,
      errors: [
        {
          code: "NOT_JSON",
          message: "The reply contained no JSON object.",
        },
      ],
    };
  }
  try {
    const spec = JSON.parse(body.slice(start, end + 1));
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new Error("not an object");
    }
    return { ok: true, spec: foldPinMaps(dropNulls(spec)) };
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          code: "NOT_JSON",
          message: `The reply was not valid JSON: ${err?.message ?? err}.`,
        },
      ],
    };
  }
}

/**
 * Compile, verify and wrap a spec as a design clip.
 *
 * @param {object} spec
 * @returns {{ok:true, clip:object, document:object, warnings:Array, results:Array, title:string}
 *          |{ok:false, faults:Array, document?:object, warnings?:Array}}
 */
export function buildFromSpec(spec) {
  return drain(buildStepsFromSpec(spec));
}

/**
 * The same build, reporting each stage before it runs.
 *
 * Compiling is one step; the ladder's gates come from `verifySteps` through
 * `yield*`, so this narrates the whole pipeline without knowing what the gates
 * are. Still DOM-free and still synchronous between yields — WHEN to resume is
 * entirely the caller's business, which is what lets the panel paint in the
 * gaps while a test suite drains it in one go.
 *
 * @param {object} spec
 * @yields {{gate:string, label:string}}
 * @returns the same result shape `buildFromSpec` returns
 */
export function* buildStepsFromSpec(spec) {
  yield {
    gate: "compile",
    label: tf("ai.gate.compile", "Compiling the netlist…"),
  };

  // Reported beside whatever else fails, so one repair round can fix both.
  const suite = testSuiteFaults(spec);
  const compiled = compileNetlist(spec);
  if (!compiled.ok) {
    // Compiler errors and verifier faults are the same shape to the caller —
    // a repair round should not have to know which stage refused.
    return { ok: false, faults: [...compiled.errors, ...suite] };
  }

  const verdict = yield* verifySteps(compiled, spec);
  if (!verdict.ok || suite.length) {
    return {
      ok: false,
      faults: [...verdict.faults, ...suite],
      document: verdict.document,
      // What the compiler changed on the way, so a repair round can be told
      // (ai/catalog-brief.js `buildRepairMessage`) — a model that does not know
      // a pull-down was added cannot reason about the level it sees.
      warnings: compiled.warnings ?? [],
    };
  }

  // The clip comes from the VERIFIED document, not the compiled one: the
  // loader is what the desk will read, so anything it normalised away must be
  // absent from what gets placed too.
  const clip = designClipOf(verdict.document);
  if (!clip) {
    return {
      ok: false,
      faults: [
        {
          gate: "L8",
          kind: "abort",
          code: "EMPTY_BUILD",
          message: "The build produced nothing to place.",
        },
      ],
    };
  }
  return {
    ok: true,
    clip,
    document: verdict.document,
    warnings: compiled.warnings ?? [],
    results: verdict.results ?? [],
    title: typeof spec.title === "string" ? spec.title : "",
    // Also stamped on the desk as a caption (autobuild.js); handed back here so
    // the panel can say it at the moment the design is offered, when the user
    // is deciding whether to place it at all.
    notes: typeof spec.notes === "string" ? spec.notes : "",
  };
}

/**
 * The whole path, for a caller that just has text.
 *
 * @param {string} text
 * @returns the `buildFromSpec` result, or its parse failure in the same shape.
 */
export function buildFromReply(text) {
  return drain(buildStepsFromReply(text));
}

/**
 * The whole path, one stage at a time — what the panel drives.
 *
 * @param {string} text
 * @yields {{gate:string, label:string}}
 * @returns the same result shape `buildFromReply` returns
 */
export function* buildStepsFromReply(text) {
  const parsed = parseNetlist(text);
  if (!parsed.ok) return { ok: false, faults: parsed.errors };
  const built = yield* buildStepsFromSpec(parsed.spec);
  return built.ok ? { ...built, spec: parsed.spec } : built;
}

/** Split faults into the two kinds the panel treats differently. */
export function partitionFaults(faults = []) {
  return {
    // OUR bug — the model cannot fix a compiler mistake, so a repair round
    // would just burn tokens on an unchanged answer.
    abort: faults.filter((f) => f.kind === "abort"),
    repair: faults.filter((f) => f.kind !== "abort"),
  };
}

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
import { partDef } from "../catalog/index.js";
import { BUILDABLE_DEFS, MIN_TESTS } from "./catalog-brief.js";

// How many tests a generated design must carry — stated once, beside the
// prompt that quotes it (ai/catalog-brief.js).
export { MIN_TESTS };

/** The ids the card offers (ai/catalog-brief.js `BUILDABLE_DEFS`). */
const ON_CARD = new Set(BUILDABLE_DEFS.map((d) => d.id));

/**
 * Parts the spec names that are not on the card. The compiler accepts any
 * catalog part (other callers build with more), but the model was shown only
 * the card: a part off it — a 555 with no R and C, a tactile button the pull
 * rule cannot read, Mains — is one the prompt never described, and some
 * pass the whole ladder while meaning nothing.
 */
export function offCardFaults(spec) {
  const parts = Array.isArray(spec?.parts) ? spec.parts : [];
  return parts
    .filter(
      (p) =>
        typeof p?.ref === "string" && partDef(p.ref) && !ON_CARD.has(p.ref),
    ) // prettier-ignore
    .map((p) => ({
      gate: "compile",
      kind: "repair",
      code: "OFF_CARD",
      message:
        `"${p.id}" is a ${p.ref}, which is not on the list of parts this ` +
        `builder can use — choose one from the list.`,
    }));
}

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
  // A design with nothing a test can set — no switch, no clock — has ONE
  // input state, so two tests can only differ in what they EXPECT. Holding
  // them to different inputs refused every correct static circuit.
  if (!hasInputs(spec)) return faults;
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

/** Whether a spec has anything a test can vary: switch positions to `set`
    (autobuild-verify.js reads a bank's, or any part's `states`) or a clock
    to give `edges` — or a test that sets or clocks something anyway. */
function hasInputs(spec) {
  const tests = Array.isArray(spec?.tests) ? spec.tests : [];
  const varied = (t) =>
    (t?.set && typeof t.set === "object" && Object.keys(t.set).length > 0) ||
    t?.edges != null;
  if (tests.some(varied)) return true; // a test that sets something says so
  const parts = Array.isArray(spec?.parts) ? spec.parts : [];
  return parts.some((p) => {
    const def = typeof p?.ref === "string" ? partDef(p.ref) : null;
    if (!def) return true; // unknown: the compiler refuses it; stay strict
    if (def.switchBank || def.kind === "clock") return true;
    return Array.isArray(def.normalizeParams?.({})?.states);
  });
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
  // Every fenced block, then the reply as a whole: a reply may fence a pin
  // map or a sketch BEFORE the netlist, so the first fence is not necessarily
  // the one — the first candidate that holds an object is.
  const fences = [...raw.matchAll(/```([\w-]*)[^\n]*\n?([\s\S]*?)```/g)];
  const candidates = [
    ...fences.filter((f) => /^json$/i.test(f[1])).map((f) => f[2]),
    ...fences.filter((f) => !/^json$/i.test(f[1])).map((f) => f[2]),
    raw,
  ];
  let failure = null;
  let failedLength = -1;
  // The first object that LOOKS like a netlist wins; failing one, the first
  // that parses at all — so a `{}` or a `{"QA": 14}` in prose before the
  // netlist is not taken for it.
  let fallback = null;
  for (const body of candidates) {
    for (const { object, enclosed } of objectsIn(body)) {
      try {
        const spec = JSON.parse(object);
        if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
          throw new Error("not an object");
        }
        if (Object.hasOwn(spec, "parts") || Object.hasOwn(spec, "nets")) {
          return { ok: true, spec: foldPinMaps(dropNulls(spec)) };
        }
        // Inside a brace that never closed, only a netlist is believed: that
        // brace may be a broken netlist, and its parts parse on their own.
        if (!enclosed && !fallback) fallback = spec;
      } catch (err) {
        // The repair round is told what is wrong with the LONGEST object
        // tried — the netlist, not a `{QA..QD}` in a sentence before it.
        if (object.length > failedLength) {
          failure = err;
          failedLength = object.length;
        }
      }
    }
  }
  if (fallback) return { ok: true, spec: foldPinMaps(dropNulls(fallback)) };
  return {
    ok: false,
    errors: [
      {
        code: "NOT_JSON",
        message: failure
          ? `The reply was not valid JSON: ${failure?.message ?? failure}.`
          : "The reply contained no JSON object.",
      },
    ],
  };
}

/** How many `{…}` one candidate offers before it is given up on. */
const MAX_OBJECT_STARTS = 16;

/**
 * Each `{…}` in `text` in turn, braces BALANCED (and those inside strings
 * ignored) — enough to survive a leading sentence and a trailing one that
 * mentions `{QA..QD}`, which "first `{` to last `}`" swallowed. The next one
 * starts AFTER the one before it ends, so a prose brace ahead of the netlist
 * is stepped over while a broken netlist is never mined for an inner object
 * that parses. An object that never closes is returned to its end, so the
 * parse says what is wrong, and the walk goes on from the brace after it —
 * an unclosed `{QA..QD drive it:` in prose must not hide the netlist — with
 * every object from there on marked `enclosed`, since it lies inside that
 * unclosed one.
 *
 * @returns {Generator<{object:string, enclosed:boolean}>}
 */
function* objectsIn(text) {
  let from = 0;
  let enclosed = false;
  for (let n = 0; n < MAX_OBJECT_STARTS; n++) {
    const start = text.indexOf("{", from);
    if (start === -1) return;
    const end = objectEnd(text, start);
    if (end === -1) {
      yield { object: text.slice(start), enclosed };
      enclosed = true;
      from = start + 1;
      continue;
    }
    yield { object: text.slice(start, end), enclosed };
    from = end;
  }
}

/** Where the balanced object opening at `start` ends (one past its `}`), or -1. */
function objectEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth += 1;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
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
  const offCard = offCardFaults(spec);
  if (offCard.length) return { ok: false, faults: [...offCard, ...suite] };
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
  // The prompt's own way to say "this cannot be built": no parts, and the
  // reason in the title. Built, it is a spec with nothing in it — NO_PARTS,
  // TOO_FEW_TESTS — and two repair rounds paid to push the model into the
  // substitution it was told not to make. So it is an ANSWER, handed back as
  // one, with nothing to repair.
  const declined = declinedReply(parsed.spec);
  if (declined) return declined;
  const built = yield* buildStepsFromSpec(parsed.spec);
  return built.ok ? { ...built, spec: parsed.spec } : built;
}

/**
 * A reply that declines the request (`parts: []` with a title saying why), as
 * a result: not ok, `declined`, no faults — or null for a reply that is a
 * design.
 */
export function declinedReply(spec) {
  const title = typeof spec?.title === "string" ? spec.title.trim() : "";
  if (!title || !Array.isArray(spec.parts) || spec.parts.length > 0) {
    return null;
  }
  return {
    ok: false,
    declined: true,
    faults: [],
    title,
    notes: typeof spec.notes === "string" ? spec.notes : "",
    spec,
  };
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

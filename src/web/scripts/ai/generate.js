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
 *          |{ok:false, faults:Array, document?:object}}
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

  const compiled = compileNetlist(spec);
  if (!compiled.ok) {
    // Compiler errors and verifier faults are the same shape to the caller —
    // a repair round should not have to know which stage refused.
    return { ok: false, faults: compiled.errors };
  }

  const verdict = yield* verifySteps(compiled, spec);
  if (!verdict.ok) {
    return { ok: false, faults: verdict.faults, document: verdict.document };
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

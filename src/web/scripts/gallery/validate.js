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

// validate.js — is this file a design the gallery can publish? One function,
// run in the app (the Share dialog's verdict, before anything is sent), in
// the Worker and in the gallery's CI — the same code in all three, so what
// the dialog promised is what the server checks (features/
// chiphippo-gallery-plan.md → Phase 1, and 1.4 for why it goes past schema).
//
// A submission is a `.desktop.chiphippo` SNAPSHOT (D2: one desktop):
//   {version, kind: "desktop", name, description?, doc, images?, blobs?,
//    customChips?}
// — what Export writes (app/store/project-store.js `writeDesktopSnapshot`).
//
// THE LOADER'S SILENCE IS THE THING CHECKED. `normalizeDocument` is built to
// land a desk you can work on, so it quietly DROPS what it cannot place — an
// overlapping strip, a second lead in one hole, a footprint that does not
// fit, a wire to nothing. A design that loads with parts missing would pass
// a schema check and arrive broken. So the document is migrated, normalized,
// and every content list's ids compared before and after: anything the
// loader dropped refuses the submission, naming what went. (Ids, never
// values: a value the loader rounds onto its grid is a desk landing where it
// always would.)
//
// SELF-CONTAINED: the catalog is asked with the snapshot's own designed chips
// and nothing else (`withCustomChips`), so a chip that lived only in the
// sharer's library is a missing chip here — as it would be on every other
// machine — and a chip that cannot run (its package or code has an error, and
// so it drives nothing) is refused.
//
// MIGRATION IS THE CALLER'S. The desk migrations are main's
// (app/store/migrations.js, CommonJS, `migrateDeskDocument`), and there must
// be one copy of them: main passes its own, CI and the Worker require it.

import { partDef, withCustomChips } from "../catalog/index.js";
import {
  CONTENT_KEYS,
  DOC_VERSION,
  normalizeDocument,
} from "../model/desk-doc.js";
import {
  customRefsIn,
  isCustomRef,
  normalizeCustomChips,
} from "../model/custom-chip.js";
import { deriveEntry } from "./derive.js";
import {
  MAX_ROM_BYTES,
  MAX_SNAPSHOT_BYTES,
  snapshotRoms,
} from "./entry-format.js";

export { MAX_ROM_BYTES, MAX_SNAPSHOT_BYTES };

/** Each content list's members' ids (or, for a list without ids, a count). */
function contentOf(doc) {
  const out = {};
  for (const key of CONTENT_KEYS) {
    const list = Array.isArray(doc?.[key]) ? doc[key] : [];
    const ids = list.map((item) => item?.id).filter((id) => typeof id === "string"); // prettier-ignore
    out[key] = ids.length === list.length ? { ids } : { count: list.length };
  }
  return out;
}

/**
 * Does this (migrated) document LOAD in this build with nothing lost? The
 * half of validation that depends on the build, not on the file: run by the
 * validator on a submission, and by the app on a gallery entry pinned to an
 * older release (the plan's D7 compatibility check) — the same verdict both
 * ways. The catalog is asked with `chips` and nothing else.
 * @param {object} migrated - a desk document, already migrated (not changed).
 * @param {object[]} chips - the designed chips it carries (normalized).
 * @returns {{doc: object, problems: object[]}} the normalized document, and
 *   each problem: unknownPart, missingChip, brokenChip, dropped.
 */
export function loadCheck(migrated, chips = []) {
  const problems = [];
  const { doc, unknown } = withCustomChips(chips, () => {
    const missing = new Set();
    for (const comp of migrated.components ?? []) {
      if (comp && typeof comp.ref === "string" && !partDef(comp.ref)) missing.add(comp.ref); // prettier-ignore
    }
    for (const chip of chips) {
      if (!partDef(chip.id)?.customRuntime) {
        problems.push({ code: "brokenChip", name: chip.name });
      }
    }
    return { doc: normalizeDocument(migrated), unknown: missing };
  });
  // A part whose ref nothing knows, said once per ref: a designed chip the
  // snapshot did not carry, or a catalog part this build does not have.
  const unknownIds = new Set();
  for (const ref of unknown) {
    problems.push(isCustomRef(ref) ? { code: "missingChip", ref } : { code: "unknownPart", ref }); // prettier-ignore
  }
  for (const comp of migrated.components ?? []) {
    if (unknown.has(comp?.ref)) unknownIds.add(comp.id);
  }

  const before = contentOf(migrated);
  const after = contentOf(doc);
  for (const key of CONTENT_KEYS) {
    const [b, a] = [before[key], after[key]];
    if (b.ids && a.ids) {
      const kept = new Set(a.ids);
      const lost = b.ids.filter((id) => !kept.has(id) && !(key === "components" && unknownIds.has(id))); // prettier-ignore
      if (lost.length) problems.push({ code: "dropped", list: key, ids: lost });
    } else {
      const was = b.ids?.length ?? b.count;
      const now = a.ids?.length ?? a.count;
      if (now < was) problems.push({ code: "dropped", list: key, count: was - now }); // prettier-ignore
    }
  }
  return { doc, problems };
}

/**
 * Validate a submission.
 * @param {string} text - the design file, as sent.
 * @param {{migrate: (doc: object) => object}} opts - main's desk migration.
 * @returns {{ok: boolean, problems: object[], snapshot: object|null,
 *   derived: object|null, docVersion: number}}
 *   `problems`: each `{code, ...args}` — tooBig, notJson, notDesktop,
 *   newerDocument, empty, unknownPart, missingChip, brokenChip, dropped,
 *   badRom, romTooBig. `snapshot`: the design as the gallery would publish
 *   it (`doc` normalized, `customChips` the ones it places). `derived`:
 *   derive.js's block.
 */
export function validateSubmission(text, { migrate } = {}) {
  if (typeof migrate !== "function") throw new Error("validateSubmission: needs migrate"); // prettier-ignore
  const fail = (problem) => ({ ok: false, problems: [problem], snapshot: null, derived: null, docVersion: 0 }); // prettier-ignore
  if (typeof text !== "string") return fail({ code: "notJson" });
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_SNAPSHOT_BYTES) return fail({ code: "tooBig", bytes, max: MAX_SNAPSHOT_BYTES }); // prettier-ignore
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail({ code: "notJson" });
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    raw.kind !== "desktop" ||
    !raw.doc ||
    typeof raw.doc !== "object" ||
    Array.isArray(raw.doc)
  ) {
    return fail({ code: "notDesktop" });
  }
  const docVersion = Number.isInteger(raw.doc.version) ? raw.doc.version : 0;
  // A document from a NEWER app is left untouched by the migrations, and this
  // build cannot say what it means: refuse it rather than judge half of it.
  if (docVersion > DOC_VERSION) {
    return { ...fail({ code: "newerDocument", version: docVersion, max: DOC_VERSION }), docVersion }; // prettier-ignore
  }

  const problems = [];
  const migrated = migrate(structuredClone(raw.doc));
  const placed = customRefsIn(migrated);
  const chips = normalizeCustomChips(raw.customChips).filter((c) => placed.has(c.id)); // prettier-ignore

  const { doc, problems: loading } = loadCheck(migrated, chips);
  problems.push(...loading);
  if (!doc.components.length) problems.push({ code: "empty" });

  const { images, bytes: romBytes, bad } = snapshotRoms(raw);
  for (const guid of bad) problems.push({ code: "badRom", guid });
  if (romBytes > MAX_ROM_BYTES) problems.push({ code: "romTooBig", bytes: romBytes, max: MAX_ROM_BYTES }); // prettier-ignore

  return {
    ok: problems.length === 0,
    problems,
    snapshot: {
      name: typeof raw.name === "string" ? raw.name : "",
      description: typeof raw.description === "string" ? raw.description : "",
      doc,
      customChips: chips,
      images,
    },
    derived: deriveEntry(doc, chips),
    docVersion,
  };
}

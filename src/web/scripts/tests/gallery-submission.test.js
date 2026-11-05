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

// The review of one shared design (scripts/check-submission.mjs), as the
// private submission repo's CI runs it on each pull request.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"; // prettier-ignore
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkSubmission, reviewComment } from "../../../../scripts/check-submission.mjs"; // prettier-ignore

const HERE = dirname(fileURLToPath(import.meta.url));
const nand = () =>
  JSON.parse(readFileSync(join(HERE, "../../demos/74LS00.json"), "utf8")).doc;
const ENTRY = { schema: 1, kind: "design", title: "Gates", author: "Ada", description: "", tags: ["nand"], source: "shared" }; // prettier-ignore

function entryDir(
  id,
  {
    entry = { ...ENTRY, id },
    design = { kind: "desktop", name: "Gates", doc: nand() },
  } = {},
) {
  // prettier-ignore
  const root = mkdtempSync(join(tmpdir(), "ch-sub-"));
  const dir = join(root, id);
  mkdirSync(dir);
  if (entry) writeFileSync(join(dir, "entry.json"), JSON.stringify(entry));
  if (design) writeFileSync(join(dir, "design.desktop.chiphippo"), JSON.stringify(design)); // prettier-ignore
  return { dir, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("a good share is ready, with what the gallery derives from it", () => {
  const { dir, done } = entryDir("gates-abcdef");
  const result = checkSubmission(dir);
  done();
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.derived.chips, 1);
  const comment = reviewComment(result, "1.6.0");
  assert.match(comment, /Ready to publish.*1\.6\.0/);
  assert.match(comment, /\*\*Gates\*\* by Ada/);
});

test("the folder is the id, both files are there, and the design loads", () => {
  const cases = [
    ["Not-An-Id", {}, "badId"],
    ["gates-abcdef", { entry: { ...ENTRY, id: "other-123456" } }, "idMismatch"],
    ["gates-abcdef", { design: null }, "missingFile"],
    ["gates-abcdef", { design: { kind: "desktop", doc: { ...nand(), components: [] } } }, "empty"],
    ["gates-abcdef", { entry: { ...ENTRY, id: "gates-abcdef", title: "" } }, "titleMissing"],
  ]; // prettier-ignore
  for (const [id, opts, code] of cases) {
    const { dir, done } = entryDir(id, opts);
    const result = checkSubmission(dir);
    done();
    assert.equal(result.ok, false, code);
    assert.ok(result.problems.some((p) => p.code === code), `${code}: ${JSON.stringify(result.problems)}`); // prettier-ignore
    assert.match(reviewComment(result, "1.6.0"), /Would be left out/);
  }
});

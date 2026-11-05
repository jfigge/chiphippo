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

// check-submission.mjs — the review of ONE shared design (the gallery work,
// Phase 5), run by the private chiphippo-gallery-submission repo's CI on each
// pull request the submission service opens, with THIS repo checked out at
// the latest release (so a share is judged by the app people have). It
// validates the entry folder exactly as the site's build will
// (gallery/validate.js with main's migrations, `checkEntryText`, the folder
// being the id) and writes the pull request's review comment: what the
// gallery will derive from the design, and every problem, in plain words.
//
//   node scripts/check-submission.mjs --entry <entries/id> [--comment FILE]
//
// Exit 1 when the entry would be left out of the gallery, so the check goes
// red on the pull request; the comment says why either way.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ENTRY_ID_RE,
  checkEntryText,
} from "../src/web/scripts/gallery/entry-format.js";
import { validateSubmission } from "../src/web/scripts/gallery/validate.js";

const require = createRequire(import.meta.url);
const { migrateDeskDocument } = require("../src/app/store/migrations.js");

/** The files an entry folder may hold, as the service writes it. */
export const ENTRY_FILES = Object.freeze(["entry.json", "design.desktop.chiphippo"]); // prettier-ignore

/** One problem in a sentence (the validator's codes and the text's). */
export function sayProblem(p) {
  switch (p.code) {
    case "notJson": return `${p.file ?? "the design"} is not JSON`;
    case "notDesktop": return "the design is not a desktop snapshot";
    case "tooBig": return `the design is ${p.bytes} bytes; the gallery takes ${p.max}`;
    case "newerDocument": return `the design was saved by a newer app (desk v${p.version}; this release reads v${p.max})`;
    case "empty": return "the desktop has no parts on it";
    case "unknownPart": return `this release has no part \`${p.ref}\``;
    case "missingChip": return `the designed chip \`${p.ref}\` is placed but not carried`;
    case "brokenChip": return `the designed chip “${p.name}” cannot run`;
    case "dropped": return `loading drops ${p.ids ? `${p.ids.length} ${p.list} (${p.ids.join(", ")})` : `${p.count} ${p.list}`}`;
    case "badRom": return `ROM image ${p.guid} is not base64`;
    case "romTooBig": return `the ROM images are ${p.bytes} bytes; the gallery takes ${p.max}`;
    case "idMismatch": return `entry.json names \`${p.id}\`, but its folder is \`${p.folder}\``;
    case "badId": return `\`${p.folder}\` is not an entry id`;
    case "missingFile": return `${p.file} is missing`;
    default: return p.code;
  }
} // prettier-ignore

/**
 * Check one entry folder.
 * @param {string} dir
 * @returns {{ok: boolean, problems: object[], entry: object|null,
 *   derived: object|null}}
 */
export function checkSubmission(dir) {
  const folder = basename(dir);
  const problems = [];
  if (!ENTRY_ID_RE.test(folder)) problems.push({ code: "badId", folder });
  for (const file of ENTRY_FILES) {
    if (!existsSync(resolve(dir, file))) problems.push({ code: "missingFile", file }); // prettier-ignore
  }
  if (problems.some((p) => p.code === "missingFile")) {
    return { ok: false, problems, entry: null, derived: null };
  }
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(resolve(dir, "entry.json"), "utf8"));
  } catch {
    problems.push({ code: "notJson", file: "entry.json" });
  }
  const text = checkEntryText(raw ?? {});
  problems.push(...text.problems);
  if (raw && raw.id !== folder) problems.push({ code: "idMismatch", folder, id: raw.id }); // prettier-ignore
  const design = readFileSync(resolve(dir, "design.desktop.chiphippo"), "utf8");
  const result = validateSubmission(design, { migrate: migrateDeskDocument });
  problems.push(...result.problems);
  return { ok: problems.length === 0, problems, entry: text.value, derived: result.derived }; // prettier-ignore
}

/** The review comment, Markdown. `release` names the app that judged it. */
export function reviewComment({ ok, problems, entry, derived }, release) {
  const lines = [
    ok
      ? `✅ **Ready to publish** — checked with Chip Hippo ${release}.`
      : `❌ **Would be left out of the gallery** — checked with Chip Hippo ${release}.`,
    "",
  ];
  if (entry) {
    lines.push(
      `**${entry.title || "(no title)"}** by ${entry.author || "(no name)"}`,
      "",
    );
  }
  if (derived) {
    lines.push(
      "| Engine | Level | Chips | Parts | Wires | Families | Auto tags |",
      "|---|---|---|---|---|---|---|",
      `| ${derived.engine} | ${derived.level} | ${derived.chips} | ${derived.parts} | ${derived.wires} | ${derived.families.join(", ") || "—"} | ${derived.autoTags.join(", ") || "—"} |`,
      "",
    ); // prettier-ignore
  }
  if (problems.length) {
    lines.push("**Problems**", "", ...problems.map((p) => `- ${sayProblem(p)}`), ""); // prettier-ignore
  }
  lines.push(
    "To look at it: download `design.desktop.chiphippo` from **Files changed** and open it in Chip Hippo (Desktop ▸ Import Desktop…).",
  );
  return `${lines.join("\n")}\n`;
}

const IS_MAIN =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (IS_MAIN) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const dir = arg("entry");
  if (!dir) {
    console.error("usage: check-submission.mjs --entry <entries/id> [--comment FILE]"); // prettier-ignore
    process.exit(2);
  }
  const release = JSON.parse(readFileSync(new URL("../src/package.json", import.meta.url), "utf8")).version; // prettier-ignore
  const result = checkSubmission(resolve(dir));
  const comment = reviewComment(result, release);
  if (arg("comment")) writeFileSync(resolve(arg("comment")), comment);
  else process.stdout.write(comment);
  for (const p of result.problems)
    console.error(`submission: ${sayProblem(p)}`);
  if (!result.ok) process.exit(1);
}

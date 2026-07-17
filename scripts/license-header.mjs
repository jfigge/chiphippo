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

// License-header stamper + guard.
//
//   node scripts/license-header.mjs            # add the header to any file missing it
//   node scripts/license-header.mjs --check    # fail (exit 1) if any file is missing it
//
// Scope (kept in lockstep with CLAUDE.md → "License headers"): first-party
// JavaScript and CSS under src/ plus the build scripts. Dependencies
// (node_modules/) and non-comment file types (JSON / Markdown / HTML) are out
// of scope.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, extname, basename } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Directory trees to scan, each with the file extensions that must be stamped.
const ROOTS = [
  { dir: "src/app", exts: [".js"] },
  { dir: "src/web/scripts", exts: [".js"] },
  { dir: "src/web/styles", exts: [".css"] },
  { dir: "scripts", exts: [".mjs", ".cjs", ".js"] },
];

// Directory names never descended into, anywhere in the tree.
const EXCLUDE_DIRS = new Set(["node_modules", "vendor"]);

// The canonical Apache 2.0 short header, as a block comment (valid in JS & CSS).
const HEADER = `/*
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
 */`;

// A file counts as already-stamped if this marker appears near its top. Matching
// a substring (not the exact block) keeps the guard stable across reformatting.
const MARKER = "Licensed under the Apache License, Version 2.0";

function* walk(dir, exts) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // tree may not exist in every checkout; skip silently
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      yield* walk(full, exts);
    } else if (entry.isFile() && exts.includes(extname(entry.name))) {
      yield full;
    }
  }
}

function collectFiles() {
  const files = new Set();
  for (const { dir, exts } of ROOTS) {
    for (const f of walk(join(REPO_ROOT, dir), exts)) files.add(f);
  }
  return [...files].sort();
}

function hasHeader(content) {
  return content.slice(0, 2000).includes(MARKER);
}

// Insert the header at the top, but after a shebang line if one is present.
function stamp(content) {
  let shebang = "";
  let body = content;
  if (body.startsWith("#!")) {
    const nl = body.indexOf("\n");
    shebang = nl === -1 ? body + "\n" : body.slice(0, nl + 1);
    body = nl === -1 ? "" : body.slice(nl + 1);
  }
  body = body.replace(/^[\s﻿]+/, ""); // drop leading BOM / blank lines
  return `${shebang}${HEADER}\n\n${body}`;
}

const check = process.argv.includes("--check");
const files = collectFiles();
const missing = [];

for (const file of files) {
  const content = readFileSync(file, "utf8");
  if (hasHeader(content)) continue;
  missing.push(file);
  if (!check) writeFileSync(file, stamp(content));
}

const rel = (f) => relative(REPO_ROOT, f);

if (check) {
  if (missing.length) {
    console.error(
      `License-header guard: ${missing.length} file(s) missing the Apache 2.0 header:`,
    );
    for (const f of missing) console.error(`  ${rel(f)}`);
    console.error(`\nAdd it with:  make license-headers`);
    console.error(`(stamps ${basename(process.argv[1])}'s scope; see CLAUDE.md).`);
    process.exit(1);
  }
  console.log(`License-header guard: all ${files.length} files carry the header.`);
} else if (missing.length) {
  console.log(`Stamped ${missing.length} file(s) with the Apache 2.0 header:`);
  for (const f of missing) console.log(`  ${rel(f)}`);
} else {
  console.log(`All ${files.length} files already carry the header. Nothing to do.`);
}

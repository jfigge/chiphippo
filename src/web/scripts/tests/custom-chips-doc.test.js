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

// The Custom Chips guide page (docs/custom-chips.md) promises that every
// Verilog snippet in it compiles as it stands. Each one opens with a
// `// Ports:` comment naming the pins it expects; this compiles every snippet
// against those ports, through the real compiler, and wants no error and no
// warning — so a change to the subset that breaks an example in the guide
// fails here rather than in a reader's designer.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { compileModule } from "../hdl/compile.js";

const PAGE = new URL("../../docs/custom-chips.md", import.meta.url);
const DIRS = { in: "input", out: "output", inout: "inout" };

/** The ```verilog blocks of the page, in order. */
function snippets() {
  const md = fs.readFileSync(PAGE, "utf8");
  return [...md.matchAll(/```verilog\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/**
 * The ports a snippet's opening comment names: `// Ports: A[3:0], B in;
 * Y out — …` (it may run over several comment lines; a dash or the closing
 * full stop ends it).
 */
function portsOf(code) {
  const comment = [];
  for (const line of code.split("\n")) {
    const m = /^\s*\/\/\s?(.*)$/.exec(line);
    if (!m) break;
    comment.push(m[1].trim());
  }
  const text = comment.join(" ");
  assert.ok(text.startsWith("Ports:"), `no "// Ports:" line in:\n${code}`);
  const list = text.slice("Ports:".length).split(" — ")[0].replace(/\.$/, "");
  const ports = [];
  for (const group of list.split(";")) {
    const words = group.trim().split(/\s+/);
    const dir = DIRS[words.pop()];
    assert.ok(dir, `a ports group without a direction: "${group}"`);
    for (const item of words.join(" ").split(",")) {
      const m = /^(\w+)(?:\[(\d+):0\])?$/.exec(item.trim());
      assert.ok(m, `not a port: "${item}"`);
      ports.push({ name: m[1], dir, width: m[2] ? Number(m[2]) + 1 : 1 });
    }
  }
  return ports;
}

test("the guide has its examples", () => {
  assert.ok(snippets().length >= 15);
});

test("every Verilog snippet in the guide compiles clean against its ports", () => {
  for (const code of snippets()) {
    const r = compileModule(code, portsOf(code), { name: "example" });
    assert.deepEqual(
      [...r.errors, ...r.warnings].map((d) => `${d.code} @${d.line}`),
      [],
      `this snippet does not compile clean:\n${code}`,
    );
  }
});

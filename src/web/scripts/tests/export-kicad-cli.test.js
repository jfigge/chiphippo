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

// export-kicad-cli.test.js — the KiCad export, checked by KiCad (Feature 390).
//
// Every demo bench is exported to a project folder and handed to KiCad's own
// command line: its electrical rules check must find NOTHING, at every
// severity, and the netlist KiCad derives from the sheet must join exactly
// the part pins our model does. export-kicad.test.js makes the same check
// with a reader of our own; this one is the proof the reader is right.
//
// It needs KiCad (8 or later), so it SKIPS where there is none — like the
// serial tests with no compiler. `kicad-cli` on the PATH is used; set
// KICAD_CLI to point elsewhere (it may be a wrapper that runs KiCad's Docker
// image with the working directory mounted).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { exportNetlist } from "../model/export/export-netlist.js";
import { kicadMapped, kicadPart } from "../model/export/kicad-parts.js";
import { exportKicad } from "../model/export/kicad.js";
import { parseSexpr } from "../model/export/sexpr.js";
import { demoDocs } from "./export-fixtures.js";

const CLI = process.env.KICAD_CLI || "kicad-cli";
const available =
  spawnSync(CLI, ["version"], { encoding: "utf8" }).status === 0;

const kids = (node, head) =>
  node.filter((n) => Array.isArray(n) && n[0] === head);
const kid = (node, head) => kids(node, head)[0];
const str = (n) => (n && typeof n === "object" ? n.quoted : n);

/** KiCad's netlist as sorted groups of `REF.PAD`, power flags left out. */
function kicadGroups(netText) {
  const root = parseSexpr(netText);
  return kids(kid(root, "nets"), "net")
    .map((net) =>
      kids(net, "node")
        .map((n) => `${str(kid(n, "ref")[1])}.${str(kid(n, "pin")[1])}`)
        .filter((m) => !m.startsWith("#"))
        .sort(),
    )
    .filter((g) => g.length);
}

/** Our model's nets as the same groups. */
function modelGroups(doc) {
  const model = exportNetlist(doc);
  const byNet = new Map();
  for (const part of model.parts) {
    if (!kicadMapped(part.def)) continue;
    const kp = kicadPart(part);
    for (const port of part.ports) {
      if (!port.net) continue;
      if (!byNet.has(port.net)) byNet.set(port.net, []);
      byNet.get(port.net).push(`${part.designator}.${kp.pad(port.key)}`);
    }
  }
  return [...byNet.values()].map((g) => g.sort());
}

/**
 * ERC findings that describe the MACHINE, not the export: a KiCad whose global
 * footprint table has never been set up (a fresh install, a CI image) reports
 * every standard library a symbol names — `Package_DIP`, `Resistor_THT` — as
 * missing. The footprint names are KiCad's own, so this says nothing about
 * what we wrote, and failing on it made the test pass or fail by who ran it.
 */
const ENVIRONMENT_ONLY = new Set(["footprint_link_issues"]);

test(
  "KiCad reads every demo's export: ERC clean, netlist identical",
  { skip: !available && `no ${CLI}`, timeout: 30 * 60 * 1000 },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-kicad-"));
    // Every demo is checked before anything is asserted: one bench stopping
    // the run hid how many others shared its fault.
    const failures = [];
    try {
      for (const { ref, doc } of demoDocs()) {
        const dir = path.join(root, ref);
        fs.mkdirSync(dir);
        const res = exportKicad(doc, { tabId: "t1", name: ref });
        for (const f of res.files) {
          fs.writeFileSync(path.join(dir, f.name), f.text);
        }
        const sch = `${ref}.kicad_sch`;
        const run = (...args) => {
          const r = spawnSync(CLI, args, { cwd: dir, encoding: "utf8" });
          if (r.status !== 0) {
            failures.push(`${ref}: kicad-cli ${args[1]}: ${r.stderr}`);
          }
          return r.status === 0;
        };
        const erc = ["sch", "erc", "--severity-all", "--format", "json"];
        if (run(...erc, "-o", "erc.json", sch)) {
          const report = JSON.parse(
            fs.readFileSync(path.join(dir, "erc.json"), "utf8"),
          );
          for (const v of report.sheets.flatMap((s) => s.violations)) {
            if (ENVIRONMENT_ONLY.has(v.type)) continue;
            failures.push(
              `${ref}: ERC ${v.severity} ${v.type}: ${v.description}`,
            );
          }
        }
        const netlist = ["sch", "export", "netlist", "--format", "kicadsexpr"];
        if (!run(...netlist, "-o", "out.net", sch)) continue;
        const theirs = kicadGroups(
          fs.readFileSync(path.join(dir, "out.net"), "utf8"),
        );
        const key = (g) => g.join(" ");
        const theirSet = new Set(theirs.map(key));
        for (const group of modelGroups(doc)) {
          if (!theirSet.has(key(group))) {
            failures.push(`${ref}: KiCad does not join ${key(group)}`);
          }
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    assert.deepEqual(failures, []);
  },
);

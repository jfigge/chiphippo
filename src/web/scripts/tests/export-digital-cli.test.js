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

// export-digital-cli.test.js — the Digital export, RUN in Digital (Feature
// 390).
//
// Two checks, both against the real simulator's command line:
//
//   · every demo bench's export LOADS — Digital resolves every library chip,
//     and refuses nothing (an open input, a bad attribute);
//   · for every combinational bench, at several switch settings, Digital
//     SIMULATES it to the same answer our engine gives: a Probe on every
//     chip-output and lamp net, and a Digital test case holding each to the
//     level `settle()` reports here. That is what proves the translations
//     (resistors as pulls, floating inputs as pull-ups, the slide switch's
//     starting throw, the open-collector pull-ups) mean what they claim.
//
// Sequential benches are loaded but not compared: Digital and our engine are
// free to power a flip-flop up in different states.
//
// It needs Java and Digital.jar, so it SKIPS unless DIGITAL_JAR points at one
// (https://github.com/hneemann/Digital/releases). Unpack the WHOLE zip: the
// jar reads its chip models from the `lib/` folder beside it, and a jar on its
// own loads every export with each chip drawn as "7400.dig is missing" — which
// the load check below now fails on, rather than passing over.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { partDef } from "../catalog/index.js";
import { buildNetlist } from "../sim/netlist.js";
import { settle } from "../sim/engine.js";
import { isSequential } from "../sim/chip-eval.js";
import { partPinAddresses } from "../model/occupancy.js";
import { exportNetlist } from "../model/export/export-netlist.js";
import { digitalMapped, exportDigital } from "../model/export/digital.js";
import { demoDocs } from "./export-fixtures.js";

const JAR = process.env.DIGITAL_JAR;
const available =
  Boolean(JAR) &&
  fs.existsSync(JAR) &&
  spawnSync("java", ["-version"]).status === 0;
const skip = !available && "set DIGITAL_JAR to a Digital.jar (and have java)";

function digital(...args) {
  const r = spawnSync("java", ["-cp", JAR, "CLI", ...args], {
    encoding: "utf8",
  });
  const out = `${r.stdout}\n${r.stderr}`
    .split("\n")
    .filter((l) => l && !l.startsWith("WARNING"))
    .join("\n");
  return { status: r.status, out };
}

/** Only switches, gates and lamps: a bench with no state and no clock. */
function combinational(doc) {
  return doc.components.every((c) => {
    const def = partDef(c.ref);
    if (c.kind === "clock" || c.ref.startsWith("osc-")) return false;
    if (def.kind !== "chip") return true;
    return !isSequential(def) && Boolean(def.logic?.units);
  });
}

const switches = (doc) =>
  doc.components.filter(
    (c) =>
      c.ref === "sw-slide" ||
      c.ref === "sw-toggle" ||
      c.ref.startsWith("sw-dip"),
  );

/** Set every switch from a bit list. */
function setSwitches(doc, bits) {
  let i = 0;
  for (const c of switches(doc)) {
    if (c.ref === "sw-slide") c.params = { ...c.params, pos: bits[i++] ? "2" : "1" };
    else if (c.ref === "sw-toggle") c.params = { ...c.params, on: !!bits[i++] };
    else c.params = { ...c.params, states: c.params.states.map(() => !!bits[i++]) }; // prettier-ignore
  }
}

/** Our engine's level on every chip-output and lamp net: `[name, 0|1]`. */
function expectations(doc) {
  const model = exportNetlist(doc);
  if (model.parts.some((p) => !digitalMapped(p.def))) return [];
  const netlist = buildNetlist(doc);
  const { netLevels } = settle({ document: doc, netlist });
  const out = [];
  for (const net of model.nets.values()) {
    if (net.polarity) continue;
    const parts = net.ports.map(({ partId, key }) => {
      const part = model.parts.find((p) => p.id === partId);
      return { part, port: part.ports.find((p) => p.key === key) };
    });
    const driven = parts.some(
      ({ part, port }) =>
        part.def.kind === "chip" &&
        (port.role === "output" || port.role === "io"),
    );
    const lamp = parts.some(({ part }) => /^(led|bar8)/.test(part.def.id));
    if (!driven && !lamp) continue;
    const { part, port } = parts[0];
    const address = (partPinAddresses(doc, part.comp) ?? []).find(
      (p) => String(p.pin) === port.key,
    )?.address;
    const level = address
      ? netLevels.get(netlist.netOfPoint.get(address))
      : null;
    if (level === "H" || level === "L")
      out.push([net.name, level === "H" ? 1 : 0]);
  }
  return out;
}

/** The export with a Probe on each checked net and a test case for them. */
function withTestCase(xml, expect) {
  const probes = expect
    .map(
      ([net], i) =>
        `    <visualElement><elementName>Probe</elementName><elementAttributes><entry><string>Label</string><string>P${i}</string></entry></elementAttributes><pos x="-4000" y="${-4000 - i * 60}"/></visualElement>\n` +
        `    <visualElement><elementName>Tunnel</elementName><elementAttributes><entry><string>NetName</string><string>${net}</string></entry></elementAttributes><pos x="-4000" y="${-4000 - i * 60}"/></visualElement>\n`,
    )
    .join("");
  // A test vector needs an input, so an unconnected one rides along.
  const header = ["T", ...expect.map((_, i) => `P${i}`)].join(" ");
  const row = ["0", ...expect.map(([, v]) => v)].join(" ");
  const extra =
    probes +
    `    <visualElement><elementName>In</elementName><elementAttributes><entry><string>Label</string><string>T</string></entry></elementAttributes><pos x="-6000" y="-6000"/></visualElement>\n` +
    `    <visualElement><elementName>Testcase</elementName><elementAttributes><entry><string>Testdata</string><testData><dataString>${header}\n${row}\n</dataString></testData></entry></elementAttributes><pos x="-6000" y="-5800"/></visualElement>\n`;
  return xml.replace("  </visualElements>", `${extra}  </visualElements>`);
}

test(
  "Digital loads every demo bench's export",
  { skip, timeout: 30 * 60 * 1000 },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-digital-"));
    try {
      for (const { ref, doc } of demoDocs()) {
        const res = exportDigital(doc, { tabId: "t1", name: ref });
        const file = path.join(dir, res.files[0].name);
        fs.writeFileSync(file, res.files[0].text);
        const r = digital("svg", "-dig", file, "-svg", `${file}.svg`);
        assert.ok(fs.existsSync(`${file}.svg`), `${ref} loads: ${r.out}`);
        // Digital still draws a circuit whose library chip it cannot find,
        // with the hole labelled — so a drawing is not proof it loaded.
        const missing = /\S+\.dig (?:is missing|not found)/.exec(
          fs.readFileSync(`${file}.svg`, "utf8"),
        );
        assert.equal(
          missing,
          null,
          `${ref}: ${missing?.[0]} — is Digital's lib/ folder beside the jar?`,
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Digital simulates every combinational bench as our engine does",
  { skip, timeout: 30 * 60 * 1000 },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-digital-"));
    let seed = 7;
    const coin = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff < 0.5 ? 1 : 0;
    };
    let checked = 0;
    const compared = new Set();
    try {
      for (const { ref, doc: base } of demoDocs()) {
        if (!combinational(base)) continue;
        const count = switches(base).reduce(
          (n, c) =>
            n + (c.ref.startsWith("sw-dip") ? c.params.states.length : 1),
          0,
        );
        for (let k = 0; k < 3; k++) {
          const doc = structuredClone(base);
          setSwitches(doc, Array.from({ length: count }, coin));
          const expect = expectations(doc);
          if (!expect.length) continue;
          const res = exportDigital(doc, { tabId: "t1", name: ref });
          const file = path.join(dir, `${ref}-${k}.dig`);
          fs.writeFileSync(file, withTestCase(res.files[0].text, expect));
          const r = digital("test", "-circ", file, "-verbose");
          assert.match(r.out, /passed/, `${ref} setting ${k}:\n${r.out}`);
          checked += 1;
          compared.add(ref);
        }
      }
      assert.ok(checked > 20, `compared ${checked} settings`);
      // The CD4000 parts with a Digital twin are compared too, not just placed.
      assert.ok(
        [...compared].some((ref) => ref.startsWith("CD4")),
        "at least one CD4000 bench was compared",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

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

// export-kicad.test.js — the KiCad project export (Feature 390).
//
// The strongest check here READS THE SHEET BACK the way KiCad would: it
// parses the written schematic, puts every symbol's pins where KiCad puts
// them, follows the wires, and names each group by the label or power symbol
// on it — then holds that partition to the export model's, part pin by part
// pin, for every demo bench. A pin that missed its stub, a label on the wrong
// end of a wire, or two nets sharing a name would all fail it.
// (export-kicad-cli.test.js repeats the check with KiCad itself, where it is
// installed.)

import test from "node:test";
import assert from "node:assert/strict";
import { PALETTE_DEFS, partDef } from "../catalog/index.js";
import { exportNetlist } from "../model/export/export-netlist.js";
import {
  KICAD_LEFT_OUT,
  KICAD_PARTS,
  kicadMapped,
  kicadPart,
} from "../model/export/kicad-parts.js";
import {
  KICAD_GENERATOR,
  KICAD_LIB,
  exportKicad,
} from "../model/export/kicad.js";
import { parseSexpr } from "../model/export/sexpr.js";
import { bench, demoDocs } from "./export-fixtures.js";
import { astable555, bench as timingBench } from "./timing-fixtures.js";

// ── Reading a sheet back ─────────────────────────────────────────────────────

const kids = (node, head) =>
  node.filter((n) => Array.isArray(n) && n[0] === head);
const kid = (node, head) => kids(node, head)[0];
const str = (n) => (n && typeof n === "object" ? n.quoted : n);
const key = (x, y) => `${Number(x).toFixed(3)},${Number(y).toFixed(3)}`;

/**
 * The net partition a schematic states: `{ "U1.3": name, … }` for every
 * placed part pin, by following wires to labels and power symbols.
 */
export function readSheet(text) {
  const root = parseSexpr(text);
  // Library pins, in library coordinates (y up).
  const libPins = new Map();
  for (const sym of kids(kid(root, "lib_symbols"), "symbol")) {
    const pins = new Map();
    const walk = (n) => {
      for (const c of n) {
        if (!Array.isArray(c)) continue;
        if (c[0] === "pin") {
          const at = kid(c, "at");
          pins.set(str(kid(c, "number")[1]), {
            x: +at[1],
            y: +at[2],
            type: c[1],
          });
        } else walk(c);
      }
    };
    walk(sym);
    libPins.set(str(sym[1]), pins);
  }
  // Union-find over points.
  const parent = new Map();
  const find = (a) => {
    if (!parent.has(a)) parent.set(a, a);
    while (parent.get(a) !== a) a = parent.get(a);
    return a;
  };
  const union = (a, b) => parent.set(find(a), find(b));
  for (const w of kids(root, "wire")) {
    const [a, b] = kids(kid(w, "pts"), "xy");
    union(key(a[1], a[2]), key(b[1], b[2]));
  }
  const names = new Map(); // point → name
  for (const l of kids(root, "label")) {
    const at = kid(l, "at");
    names.set(key(at[1], at[2]), str(l[1]));
  }
  const partPins = []; // { ref, pad, point }
  const noConnect = new Set(
    kids(root, "no_connect").map((n) => key(kid(n, "at")[1], kid(n, "at")[2])),
  );
  for (const s of kids(root, "symbol")) {
    const lib = str(kid(s, "lib_id")[1]);
    const at = kid(s, "at");
    const [x0, y0, rot] = [+at[1], +at[2], +at[3]];
    const ref = str(
      kids(s, "property").find((p) => str(p[1]) === "Reference")[2],
    );
    const value = str(
      kids(s, "property").find((p) => str(p[1]) === "Value")[2],
    );
    const pins = libPins.get(lib);
    assert.ok(pins, `${lib} is in lib_symbols`);
    for (const [pad, p] of pins) {
      // KiCad turns a symbol counterclockwise (y up); our parts sit at 0.
      const r = (rot * Math.PI) / 180;
      const lx =
        Math.round((p.x * Math.cos(r) - p.y * Math.sin(r)) * 1e4) / 1e4;
      const ly =
        Math.round((p.x * Math.sin(r) + p.y * Math.cos(r)) * 1e4) / 1e4;
      const point = key(x0 + lx, y0 - ly);
      if (ref.startsWith("#PWR")) names.set(point, value);
      // A no_connect-TYPE pin needs no flag: ERC reads the type itself.
      else if (!ref.startsWith("#FLG") && p.type !== "no_connect") {
        partPins.push({ ref, pad, point });
      }
    }
  }
  const groupName = new Map();
  for (const [point, name] of names) {
    const g = find(point);
    const prev = groupName.get(g);
    assert.ok(
      !prev || prev === name,
      `one group, two names: ${prev} / ${name}`,
    );
    groupName.set(g, name);
  }
  const out = {};
  for (const { ref, pad, point } of partPins) {
    const name = groupName.get(find(point));
    if (name) out[`${ref}.${pad}`] = name;
    else if (!noConnect.has(point)) out[`${ref}.${pad}`] = null; // unmarked
  }
  return out;
}

/** The partition the export MODEL says, in the same `{ "U1.3": name }` form. */
function expected(doc) {
  const model = exportNetlist(doc);
  const out = {};
  for (const part of model.parts) {
    if (!kicadMapped(part.def)) continue;
    const kp = kicadPart(part);
    for (const port of part.ports) {
      if (port.net) {
        out[`${part.designator}.${kp.pad(port.key)}`] = model.nets.get(
          port.net,
        ).name;
      }
    }
  }
  return out;
}

const sheetOf = (res) => res.files.find((f) => f.name.endsWith(".kicad_sch"));

// ── Coverage ─────────────────────────────────────────────────────────────────

test("every palette part has a KiCad footprint and symbol", () => {
  // …but for the parts left out on purpose, each with its reason.
  const missing = PALETTE_DEFS.filter(
    (def) => !kicadMapped(def) && !(def.id in KICAD_LEFT_OUT),
  ).map((d) => d.id);
  assert.deepEqual(missing, [], "a new part needs a KICAD_PARTS entry");
  for (const [id, spec] of Object.entries(KICAD_PARTS)) {
    const def = partDef(id);
    assert.ok(def, `${id} is a catalog part`);
    // A footprint the part's params choose is checked under every choice
    // its Properties offer (a MOSFET's package, an inductor's lead pitch).
    const footprints =
      typeof spec.footprint === "function"
        ? choicesOf(def).map((params) => spec.footprint({ params }, def))
        : [spec.footprint];
    for (const footprint of footprints) {
      assert.match(footprint, /^[\w.-]+:[\w.-]+$/, `${id}'s footprint`);
    }
  }
});

/** A def's params under every option of each of its segmented fields. */
function choicesOf(def) {
  const fields = (def.properties ?? []).filter((f) => f.type === "segmented");
  return [
    def.normalizeParams({}),
    ...fields.flatMap((f) =>
      f.options.map((o) => def.normalizeParams({ [f.key]: o.value })),
    ),
  ];
}

// ── The sheet reads back as the model ────────────────────────────────────────

test("every demo bench's sheet connects exactly what the model says", () => {
  for (const { ref, doc } of demoDocs()) {
    const res = exportKicad(doc, { tabId: "t1", name: ref });
    const got = readSheet(sheetOf(res).text);
    const want = expected(doc);
    for (const [pin, name] of Object.entries(got)) {
      assert.notEqual(name, null, `${ref}: ${pin} is neither wired nor NC`);
    }
    assert.deepEqual(
      Object.fromEntries(Object.entries(got).filter(([, n]) => n)),
      want,
      `${ref}: the sheet's nets`,
    );
  }
});

test("the project is four files, with the library and table beside the sheet", () => {
  const res = exportKicad(bench(), { tabId: "t1", name: "My Bench" });
  assert.deepEqual(res.files.map((f) => f.name).sort(), [
    "My Bench.kicad_pro",
    "My Bench.kicad_sch",
    "chiphippo.kicad_sym",
    "sym-lib-table",
  ]);
  const table = res.files.find((f) => f.name === "sym-lib-table").text;
  assert.match(table, /\(uri "\$\{KIPRJMOD\}\/chiphippo\.kicad_sym"\)/);
  const pro = JSON.parse(
    res.files.find((f) => f.name.endsWith(".kicad_pro")).text,
  );
  assert.equal(pro.meta.filename, "My Bench.kicad_pro");
  const sch = parseSexpr(sheetOf(res).text);
  assert.equal(str(kid(sch, "generator")[1]), KICAD_GENERATOR);
  // Every placed symbol's instance names THIS project, or KiCad shows "?".
  for (const s of kids(sch, "symbol")) {
    const project = kid(kid(s, "instances"), "project");
    assert.equal(str(project[1]), "My Bench");
  }
  // The library file carries the same part symbols, bare-named.
  const lib = parseSexpr(
    res.files.find((f) => f.name.endsWith(".kicad_sym")).text,
  );
  const libNames = kids(lib, "symbol").map((s) => str(s[1]));
  assert.ok(libNames.includes("74LS00"));
  const embedded = kids(kid(sch, "lib_symbols"), "symbol").map((s) =>
    str(s[1]),
  );
  assert.ok(embedded.includes(`${KICAD_LIB}:74LS00`));
});

test("the same desk exports the same bytes, and a new part re-keys nothing else", () => {
  const doc = bench();
  const a = exportKicad(doc, { tabId: "t1", name: "x" });
  const b = exportKicad(doc, { tabId: "t1", name: "x" });
  assert.deepEqual(a.files, b.files, "byte-deterministic");

  const uuids = (res) => {
    const out = new Map();
    for (const s of kids(parseSexpr(sheetOf(res).text), "symbol")) {
      const ref = str(
        kids(s, "property").find((p) => str(p[1]) === "Reference")[2],
      );
      if (!ref.startsWith("#")) out.set(ref, str(kid(s, "uuid")[1]));
    }
    return out;
  };
  const grown = bench({ parts: [{ id: "U9", ref: "74LS04" }] });
  const before = uuids(a);
  const after = uuids(exportKicad(grown, { tabId: "t1", name: "x" }));
  for (const [ref, uuid] of before) {
    assert.equal(after.get(ref), uuid, `${ref} keeps its UUID`);
  }
});

test("an LED's pads follow its polarity, cathode on KiCad's pad 1", () => {
  const doc = bench();
  const model = exportNetlist(doc);
  const led = model.parts.find((p) => p.def.id === "led");
  assert.equal(kicadPart(led).pad("1"), "2", "our anode (pin 1) is pad 2");
  assert.equal(kicadPart(led).pad("2"), "1");
  led.comp.params = { ...led.comp.params, flip: true };
  assert.equal(kicadPart(led).pad("1"), "1", "flipped, pin 1 is the cathode");
});

test("the report names what does not come across as it is", () => {
  const { doc } = demoDocs().find((d) => d.ref === "74LS595");
  const res = exportKicad(doc, { tabId: "t1", name: "595" });
  const clock = res.report.find((e) => e.code === "clockConnector");
  assert.ok(clock, "a clock brick becomes a connector");
  assert.equal(clock.kind, "changed");
  assert.match(clock.designators[0], /^J\d+$/);
  const seg = demoDocs().find((d) =>
    d.doc.components.some((c) => c.ref === "seg8cc" || c.ref === "seg8ca"),
  );
  if (seg) {
    const r = exportKicad(seg.doc, { tabId: "t1", name: "s" });
    assert.ok(
      r.report.some((e) => e.code === "genericFootprint"),
      "a 7-segment digit's stand-in footprint is flagged",
    );
  }
});

test("rails get power symbols and one PWR_FLAG each, so ERC knows they are supplied", () => {
  const res = exportKicad(bench(), { tabId: "t1", name: "x" });
  const sch = parseSexpr(sheetOf(res).text);
  const libs = kids(sch, "symbol").map((s) => str(kid(s, "lib_id")[1]));
  assert.equal(libs.filter((l) => l === `${KICAD_LIB}:PWR_FLAG`).length, 2);
  assert.ok(libs.includes(`${KICAD_LIB}:+5V`));
  assert.ok(libs.includes(`${KICAD_LIB}:GND`));
});

// ── Values: the reason a capacitor may sit anywhere on the desk ─────────────

test("capacitors and resistors export with their values and the right symbols", () => {
  // A 555 astable: RA 4.7k, RB 47k, a 10 µF electrolytic timing capacitor and
  // the 10 nF ceramic bypass on CONT.
  const { doc } = astable555({ ra: 4700, rb: 47000, c: 10e-6, cv: 10e-9 });
  const res = exportKicad(doc, { tabId: "t1", name: "555" });
  const text = sheetOf(res).text;
  const sch = parseSexpr(text);

  // The sheet connects exactly what the model says, capacitors included.
  assert.deepEqual(readSheet(text), expected(doc));

  const instances = kids(sch, "symbol")
    .map((s) => {
      const prop = (name) =>
        str(kids(s, "property").find((p) => str(p[1]) === name)?.[2]);
      return {
        lib: str(kid(s, "lib_id")[1]),
        ref: prop("Reference"),
        value: prop("Value"),
        footprint: prop("Footprint"),
      };
    })
    .filter((s) => !s.ref.startsWith("#"));
  const byLib = (lib) =>
    instances.filter((s) => s.lib === `${KICAD_LIB}:${lib}`);

  // Every Value is what the Properties field shows, nothing rounded, in
  // plain ASCII (model/component-value.js): u for micro, and a resistance
  // with no unit symbol, the schematic convention.
  const [electrolytic] = byLib("cap-electrolytic");
  assert.equal(electrolytic.value, "10uF");
  assert.match(electrolytic.ref, /^C\d+$/, "a capacitor is a C");
  assert.equal(
    electrolytic.footprint,
    "Capacitor_THT:CP_Radial_D5.0mm_P2.50mm",
  );
  const [ceramic] = byLib("cap-ceramic");
  assert.equal(ceramic.value, "10nF");
  assert.equal(
    kicadPart({
      def: partDef("resistor"),
      comp: { params: { ohms: 4753 } },
    }).value,
    "4.753k",
    "four figures stay four",
  );
  assert.equal(ceramic.footprint, "Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P2.50mm");
  assert.deepEqual(
    byLib("resistor")
      .map((r) => r.value)
      .sort(),
    ["4.7k", "47k"],
  );
  const [timer] = byLib("NE555");
  assert.equal(timer.value, "NE555");
  assert.equal(timer.footprint, "Package_DIP:DIP-8_W7.62mm");

  // The symbols: a ceramic is two plain plates; an electrolytic is the
  // polarised one, its + plate an open box and its − plate filled.
  const libSym = (name) =>
    kids(kid(sch, "lib_symbols"), "symbol").find(
      (s) => str(s[1]) === `${KICAD_LIB}:${name}`,
    );
  const shapes = (sym) => {
    const out = [];
    const walk = (n) => {
      for (const c of n) {
        if (!Array.isArray(c)) continue;
        if (c[0] === "rectangle" || c[0] === "polyline") out.push(c);
        else walk(c);
      }
    };
    walk(sym);
    return out;
  };
  const ceramicShapes = shapes(libSym("cap-ceramic"));
  assert.equal(ceramicShapes.filter((c) => c[0] === "polyline").length, 2);
  assert.equal(ceramicShapes.filter((c) => c[0] === "rectangle").length, 0);
  const fills = shapes(libSym("cap-electrolytic"))
    .filter((c) => c[0] === "rectangle")
    .map((c) => kid(kid(c, "fill"), "type")[1]);
  assert.deepEqual(fills, ["none", "outline"]);

  // Pad 1 (KiCad's +) is on the capacitor's own net, pad 2 on ground.
  const sheet = readSheet(text);
  assert.equal(sheet[`${electrolytic.ref}.2`], "GND");
  assert.notEqual(sheet[`${electrolytic.ref}.1`], "GND");
});

test("a potentiometer exports as an RV on a 3296W, its wiper coming down onto the track", () => {
  // The astable again, with RB a 100k pot used as a rheostat — wiper on
  // DISCH, pin 1 on TRIG+THRES, pin 3 open — and turned to an END, where the
  // engine reads that side as a wire: on a board it is still the pot between
  // two nets, never a short drawn on the sheet.
  const b = timingBench();
  const u = b.seat("u1", "NE555", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(1));
  b.vcc(u.get(4));
  b.link(u.get(2), u.get(6));
  const c = b.seat("c1", "cap-electrolytic", "a30", { farads: 10e-6 });
  b.link(c.get(1), u.get(6));
  b.gnd(c.get(2));
  const rv = b.seat("rv1", "pot", "a40", { ohms: 1e5, position: 0 });
  b.link(rv.get(2), u.get(7));
  b.link(rv.get(1), u.get(6));
  const ra = b.seat("r1", "resistor", "a50", { ohms: 1e3 });
  b.link(ra.get(1), u.get(7));
  b.vcc(ra.get(2));

  const res = exportKicad(b.doc, { tabId: "t1", name: "pot" });
  const text = sheetOf(res).text;
  // Every pin — the wiper on the symbol's TOP edge included — on the net the
  // model says.
  assert.deepEqual(readSheet(text), expected(b.doc));

  const sch = parseSexpr(text);
  const [pot] = kids(sch, "symbol")
    .filter((s) => str(kid(s, "lib_id")[1]) === `${KICAD_LIB}:pot`)
    .map((s) => {
      const prop = (name) =>
        str(kids(s, "property").find((p) => str(p[1]) === name)?.[2]);
      return {
        ref: prop("Reference"),
        value: prop("Value"),
        footprint: prop("Footprint"),
      };
    });
  assert.ok(pot, "the pot is on the sheet");
  assert.equal(pot.ref, "RV1");
  assert.equal(pot.value, "100k");
  assert.equal(
    pot.footprint,
    "Potentiometer_THT:Potentiometer_Bourns_3296W_Vertical",
  );
  const sheet = readSheet(text);
  assert.notEqual(
    sheet["RV1.1"],
    sheet["RV1.2"],
    "the wiper's side is a part, not a wire",
  );
  assert.equal(sheet["RV1.3"], undefined, "pin 3 is wired to nothing");

  // The library symbol: three passive pins, the wiper's arrowhead filled.
  const sym = kids(kid(sch, "lib_symbols"), "symbol").find(
    (s) => str(s[1]) === `${KICAD_LIB}:pot`,
  );
  const pins = [];
  const walk = (n) => {
    for (const child of n) {
      if (!Array.isArray(child)) continue;
      if (child[0] === "pin")
        pins.push([child[1], str(kid(child, "number")[1])]);
      else walk(child);
    }
  };
  walk(sym);
  assert.deepEqual(
    pins.sort((a, b) => a[1].localeCompare(b[1])),
    [
      ["passive", "1"],
      ["passive", "2"],
      ["passive", "3"],
    ],
  );
});

// ── The discretes ──────────────────────────────────────────────────────

test("every part among the discretes exports with its symbol, value and part number", () => {
  // One of each, every pin on a net, so the sheet has something to connect.
  const b = timingBench();
  const seat = (id, ref, anchor, params) => {
    const pins = b.seat(id, ref, anchor, params);
    for (const hole of pins.values()) b.gnd(hole);
    return pins;
  };
  seat("d1", "diode", "a10", { partNumber: "1N4148" });
  seat("z1", "zener", "a14", { zenerVolts: 5.1, partNumber: "BZX79-C5V1" });
  seat("z2", "zener", "a18", { zenerVolts: 3.3 });
  seat("l1", "inductor", "a22", { henries: 4.7e-6, partNumber: "IM02" });
  seat("l2", "inductor", "a26");
  seat("q1", "npn", "a30", { partNumber: "2N2222" });
  seat("q2", "pnp", "a34");
  seat("q3", "nmos", "a38", { case: "TO-92", partNumber: "2N7000" });
  seat("q4", "pmos", "a42", { rot: 180 });
  seat("c1", "cap-ceramic", "a46", { farads: 1e-7, partNumber: "K104K" });
  seat("q5", "nmos", "a50", { partNumber: "IRLZ44N" });
  seat("l3", "inductor", "a54", { bodyHoles: 3, style: "can" });
  seat("l4", "inductor", "f10", { bodyHoles: 1 });
  seat("l5", "inductor", "f14", { bodyHoles: 1, style: "can" });

  const res = exportKicad(b.doc, { tabId: "t1", name: "discretes" });
  const text = sheetOf(res).text;
  // The sheet connects exactly what the model says — a pin on every net.
  assert.deepEqual(readSheet(text), expected(b.doc));

  const sch = parseSexpr(text);
  const parts = new Map(
    kids(sch, "symbol")
      .map((s) => {
        const prop = (name) =>
          str(kids(s, "property").find((p) => str(p[1]) === name)?.[2]);
        return {
          lib: str(kid(s, "lib_id")[1]).replace(`${KICAD_LIB}:`, ""),
          ref: prop("Reference"),
          value: prop("Value"),
          footprint: prop("Footprint"),
          mpn: prop("MPN"),
        };
      })
      .filter((p) => !p.ref.startsWith("#"))
      .map((p) => [p.ref, p]),
  );
  const row = (ref) => {
    const p = parts.get(ref);
    assert.ok(p, `${ref} is on the sheet`);
    return [p.lib, p.value, p.footprint, p.mpn ?? null];
  };
  const DO35 = "Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal";
  const TOROID = "Inductor_THT:L_Toroid_Vertical_L16.0mm_W8.0mm_P7.62mm";
  const RADIAL_WIDE =
    "Inductor_THT:L_Radial_D12.0mm_P10.00mm_Neosid_SD12_style1";
  const TOROID_SMALL = "Inductor_THT:L_Toroid_Vertical_L10.0mm_W5.0mm_P5.08mm";
  const RADIAL_SMALL = "Inductor_THT:L_Radial_D7.8mm_P5.00mm_Fastron_07HCP";
  const TO92 = "Package_TO_SOT_THT:TO-92_Inline_Wide";
  const TO220 = "Package_TO_SOT_THT:TO-220-3_Vertical";
  assert.deepEqual(row("D1"), ["diode", "1N4148", DO35, "1N4148"]);
  assert.deepEqual(row("D2"), ["zener", "BZX79-C5V1 5.1V", DO35, "BZX79-C5V1"]);
  assert.deepEqual(row("D3"), ["zener", "3.3V", DO35, null]);
  assert.deepEqual(row("L1"), ["inductor", "4.7uH", TOROID, "IM02"]);
  assert.deepEqual(row("L2"), ["inductor", "L", TOROID, null]);
  assert.deepEqual(row("Q1"), ["npn", "2N2222", TO92, "2N2222"]);
  assert.deepEqual(row("Q2"), ["pnp", "PNP", TO92, null]);
  // A MOSFET is the package it was set to — a TO-220 unless told otherwise.
  assert.deepEqual(row("Q3"), ["nmos", "2N7000", TO92, "2N7000"]);
  assert.deepEqual(row("Q4"), ["pmos", "PMOS", TO220, null]);
  assert.deepEqual(row("Q5"), ["nmos", "IRLZ44N", TO220, "IRLZ44N"]);
  // An inductor's footprint is the part it is — a standing toroid, or a
  // radial drum — on the pitch its leads were set to, or the nearest.
  assert.deepEqual(row("L3"), ["inductor", "L", RADIAL_WIDE, null]);
  assert.deepEqual(row("L4"), ["inductor", "L", TOROID_SMALL, null]);
  assert.deepEqual(row("L5"), ["inductor", "L", RADIAL_SMALL, null]);
  assert.deepEqual(row("C1"), ["cap-ceramic", "100nF", "Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P2.50mm", "K104K"]); // prettier-ignore

  // A diode's CATHODE is KiCad's pad 1 (symbol and footprint alike).
  const model = exportNetlist(b.doc);
  const diode = model.parts.find((p) => p.comp.id === "d1");
  assert.equal(kicadPart(diode).pad("1"), "2", "our anode (pin 1) is pad 2");
  assert.equal(kicadPart(diode).pad("2"), "1", "our cathode is pad 1");

  // The library symbols: a Zener's bar is bent, a plain diode's straight; a
  // transistor's three passive pins are numbered as our pins are, the control
  // (2) on the left.
  const libSym = (name) =>
    kids(kid(sch, "lib_symbols"), "symbol").find(
      (s) => str(s[1]) === `${KICAD_LIB}:${name}`,
    );
  const pinsOf = (sym) => {
    const out = [];
    const walk = (n) => {
      for (const c of n) {
        if (!Array.isArray(c)) continue;
        if (c[0] === "pin") {
          const at = kid(c, "at");
          out.push([str(kid(c, "number")[1]), c[1], +at[1] < 0 ? "left" : "right"]); // prettier-ignore
        } else walk(c);
      }
    };
    walk(sym);
    return out.sort();
  };
  for (const q of ["npn", "pnp", "nmos", "pmos"]) {
    assert.deepEqual(
      pinsOf(libSym(q)),
      [
        ["1", "passive", "right"],
        ["2", "passive", "left"],
        ["3", "passive", "right"],
      ],
      q,
    );
  }
  const polylines = (sym) => {
    const out = [];
    const walk = (n) => {
      for (const c of n) {
        if (!Array.isArray(c)) continue;
        if (c[0] === "polyline") out.push(kids(kid(c, "pts"), "xy").length);
        else walk(c);
      }
    };
    walk(sym);
    return out;
  };
  assert.deepEqual(polylines(libSym("diode")), [4, 2]);
  assert.deepEqual(polylines(libSym("zener")), [4, 4]);
  // An inductor is four arcs.
  let arcs = 0;
  const countArcs = (n) => {
    for (const c of n) {
      if (!Array.isArray(c)) continue;
      if (c[0] === "arc") arcs += 1;
      else countArcs(c);
    }
  };
  countArcs(libSym("inductor"));
  assert.equal(arcs, 4);

  // Every transistor's footprint is reported as one to check — its pads are
  // in the desk's generic order, not any one maker's.
  const pinOrder = res.report.find((e) => e.code === "transistorPinout");
  assert.ok(pinOrder, "the transistors' pin order is flagged");
  assert.equal(pinOrder.kind, "footprint");
  const flagged = res.report
    .filter((e) => e.code === "transistorPinout")
    .flatMap((e) => e.designators)
    .sort();
  assert.deepEqual(flagged, ["Q1", "Q2", "Q3", "Q4", "Q5"]);
  // A radial drum's footprint is only the nearest pitch KiCad has: said so.
  const nearest = res.report.filter((e) => e.code === "nearestFootprint");
  assert.deepEqual(
    nearest.flatMap((e) => e.designators),
    ["L3", "L5"],
  );
  assert.equal(nearest[0].kind, "footprint");
});

test("a timer's RC terminal is a PASSIVE pin, its trigger an input", () => {
  const { doc } = astable555({ ra: 1e3, rb: 10e3, c: 1e-6 });
  const sch = parseSexpr(
    sheetOf(exportKicad(doc, { tabId: "t", name: "x" })).text,
  );
  const sym = kids(kid(sch, "lib_symbols"), "symbol").find(
    (s) => str(s[1]) === `${KICAD_LIB}:NE555`,
  );
  const types = new Map();
  const walk = (n) => {
    for (const c of n) {
      if (!Array.isArray(c)) continue;
      if (c[0] === "pin") types.set(str(kid(c, "number")[1]), c[1]);
      else walk(c);
    }
  };
  walk(sym);
  assert.equal(types.get("2"), "input", "TRIG");
  assert.equal(types.get("3"), "output", "OUT");
  for (const pad of ["5", "6", "7"]) {
    assert.equal(types.get(pad), "passive", `pin ${pad}`);
  }
});

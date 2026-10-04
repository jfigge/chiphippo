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

// kicad.js — a desktop as a KiCad 8 PROJECT (Feature 390): the schematic, a
// symbol library holding our parts, a project-local library table naming it,
// and a minimal project file. Pure: it returns the files' TEXT, and main
// writes them.
//
// WHY A PROJECT AND NOT A LONE SCHEMATIC: the point of going to KiCad is the
// PCB, and "Update PCB from Schematic" needs a project. The library table is
// project-local (`${KIPRJMOD}`), so opening the folder on any machine finds the
// symbols with no setup and no "library not found" warnings — the schematic
// also embeds every symbol it uses, as KiCad requires, so it stands alone too.
//
// CONNECTIVITY IS BY LABEL, NOT BY ROUTED WIRE. Every connected pin gets a
// one-pitch stub ending in a local net label (or, on a rail, a power symbol);
// KiCad joins every label of one name into one net. That cannot draw a wrong
// connection the way auto-routed wires crossing a pin can, and it is how a
// schematic of this density is commonly drawn anyway. A pin on no net gets a
// no-connect flag, so ERC reads the sheet exactly as the desk means it.
//
// The ARRANGEMENT follows the Schematic view (sheet-pack.js), and every UUID
// is derived from the desktop and the part (stable-uuid.js), so exporting the
// same desk twice writes the same bytes — and re-exporting into a folder with
// a laid-out board keeps every footprint linked to its symbol.

import { exportNetlist } from "./export-netlist.js";
import { kicadPart, kicadMapped } from "./kicad-parts.js";
import {
  CHAR_W,
  EFFECTS_HIDDEN,
  GRID,
  PITCH,
  effects,
  powerSymbolNode,
  pwrFlagNode,
  symbolFor,
  symbolName,
  symbolNode,
} from "./kicad-symbols.js";
import { safeFileBase } from "./file-base.js";
import { packColumns, viewPositions } from "./sheet-pack.js";
import { formatSexpr, q } from "./sexpr.js";
import { stableUuid } from "./stable-uuid.js";

/** The schematic file format written: KiCad 8's, which 8, 9 and 10 open. */
export const KICAD_SCH_VERSION = 20231120;
/** The symbol-library table format KiCad 8 writes. */
const SYM_LIB_TABLE_VERSION = 7;
/** The library holding our symbols, and the file it lives in. */
export const KICAD_LIB = "chiphippo";
export const KICAD_LIB_FILE = `${KICAD_LIB}.kicad_sym`;
/** What main checks before replacing a schematic: we wrote it. */
export const KICAD_GENERATOR = "chiphippo";

const MARGIN = 25.4; // sheet border to the first part
const TITLE_BAND = 40; // kept clear along the bottom for the title block
const STUB = PITCH; // pin tip to label
const COL_GAP = 4 * PITCH;
const ROW_GAP = 2 * PITCH;

/** Standard sheets, smallest first, landscape (mm). */
const PAPERS = [
  ["A4", 297, 210],
  ["A3", 420, 297],
  ["A2", 594, 420],
  ["A1", 841, 594],
  ["A0", 1189, 841],
];

const snap = (v) => Math.round(v / GRID) * GRID;

/**
 * The rotation that points a rail symbol AWAY from a pin on each side: a VCC
 * arrow points up at 0 and turns counterclockwise; a GND symbol hangs down at
 * 0. (Measured by rendering them in KiCad, not assumed.)
 */
const POWER_ROT = {
  VCC: { top: 0, left: 90, bottom: 180, right: 270 },
  GND: { bottom: 0, right: 90, top: 180, left: 270 },
};

/** The outward unit direction of a pin on each side (SHEET coords, y down). */
const OUT = {
  left: { dx: -1, dy: 0, angle: 180, justify: ["right", "bottom"] },
  right: { dx: 1, dy: 0, angle: 0, justify: ["left", "bottom"] },
  top: { dx: 0, dy: -1, angle: 90, justify: ["left", "bottom"] },
  bottom: { dx: 0, dy: 1, angle: 270, justify: ["right", "bottom"] },
};

/**
 * Export one desktop.
 *
 * @param {object} doc - the desktop's plain document.
 * @param {{tabId:string, name:string, description?:string}} desktop
 * @returns {{ files: Array<{name:string, text:string}>, report: Array<object>,
 *   stats: {parts:number, nets:number}, base: string }}
 */
export function exportKicad(doc, desktop) {
  const model = exportNetlist(doc);
  const base = safeFileBase(desktop.name);
  const tabId = desktop.tabId ?? "desktop";
  const root = stableUuid("root", tabId);
  const report = [];

  const parts = model.parts.filter((p) => kicadMapped(p.def));
  const kp = new Map(parts.map((p) => [p.id, kicadPart(p)]));

  // One library symbol per def, wide enough for every instance's Value.
  const widest = new Map();
  for (const part of parts) {
    const v = kp.get(part.id).value;
    const prev = widest.get(part.def.id);
    if (prev == null || v.length > prev.length) widest.set(part.def.id, v);
  }
  const symbols = new Map();
  for (const part of parts) {
    if (!symbols.has(part.def.id)) {
      symbols.set(
        part.def.id,
        symbolFor(part, kp.get(part.id), widest.get(part.def.id)),
      );
    }
  }

  // Each part's footprint on the sheet: its symbol, its stubs and its labels.
  const extent = new Map();
  for (const part of parts) {
    extent.set(
      part.id,
      partExtent(part, symbols.get(part.def.id), kp.get(part.id), model),
    );
  }
  // The power nets' PWR_FLAGs sit in a block of their own, top left.
  const rails = [...model.nets.values()]
    .filter((n) => n.polarity)
    .sort((a, b) =>
      a.polarity === b.polarity
        ? a.name < b.name
          ? -1
          : 1
        : a.polarity === "VCC"
          ? -1
          : 1,
    );
  const FLAGS = "power:flags";
  const flagsExtent = { w: 8 * PITCH, h: (rails.length * 3 + 1) * PITCH };
  const view = viewPositions(doc);
  if (rails.length) {
    const xs = [...view.values()].map((p) => p.x);
    const ys = [...view.values()].map((p) => p.y);
    view.set(FLAGS, { x: Math.min(0, ...xs), y: Math.min(0, ...ys) - 100 });
  }
  const at = packColumns(
    [...(rails.length ? [FLAGS] : []), ...parts.map((p) => p.id)],
    view,
    (id) => {
      if (id === FLAGS) return flagsExtent;
      const e = extent.get(id);
      return { w: e.maxX - e.minX, h: e.maxY - e.minY };
    },
    { colGap: COL_GAP, rowGap: ROW_GAP, snap: PITCH },
  );

  // Sheet size: the packed extent, a margin all round, and a band along the
  // bottom for the title block (which sits in the bottom-right corner).
  let width = 0;
  let height = 0;
  for (const [id, p] of at) {
    const e = id === FLAGS ? null : extent.get(id);
    const w = e ? e.maxX - e.minX : flagsExtent.w;
    const h = e ? e.maxY - e.minY : flagsExtent.h;
    width = Math.max(width, p.x + w);
    height = Math.max(height, p.y + h);
  }
  const paper =
    PAPERS.find(
      ([, w, h]) =>
        width + 2 * MARGIN <= w && height + 2 * MARGIN + TITLE_BAND <= h,
    ) ?? null;

  const items = []; // no-connects, wires, labels, symbols — in that order
  const wires = [];
  const labels = [];
  const noConnects = [];
  const placed = [];
  const powerSymbols = new Map(); // net name → polarity
  let pwr = 0;
  const nextPwr = () => `#PWR${String(++pwr).padStart(2, "0")}`;

  for (const part of parts) {
    const sym = symbols.get(part.def.id);
    const k = kp.get(part.id);
    const e = extent.get(part.id);
    const topLeft = at.get(part.id);
    const ox = snap(MARGIN + topLeft.x - e.minX);
    const oy = snap(MARGIN + topLeft.y + e.maxY);
    const sheet = (x, y) => ({ x: ox + x, y: oy - y });

    for (const port of part.ports) {
      const pad = k.pad(port.key);
      const pin = sym.pins.get(pad);
      if (!pin) continue;
      const tip = sheet(pin.x, pin.y);
      const net = port.net ? model.nets.get(port.net) : null;
      if (!net) {
        if (!isNoConnectPin(sym, pad)) {
          noConnects.push([
            "no_connect",
            ["at", tip.x, tip.y],
            ["uuid", q(stableUuid("nc", tabId, part.id, pad))],
          ]);
        }
        continue;
      }
      const out = OUT[pin.side];
      const end = { x: tip.x + out.dx * STUB, y: tip.y + out.dy * STUB };
      wires.push(wireNode(tip, end, stableUuid("wire", tabId, part.id, pad)));
      if (net.polarity) {
        powerSymbols.set(net.name, net.polarity);
        // Pointing AWAY from the part, so a rail symbol never lies across
        // the next pin along — with its name beyond it, read level.
        const across = pin.side === "left" || pin.side === "right";
        const reach = across ? 3.81 + textW(net.name) / 2 : 3.81;
        placed.push(
          powerInstance({
            name: net.name,
            reference: nextPwr(),
            at: end,
            rot: POWER_ROT[net.polarity][pin.side],
            value: {
              x: end.x + out.dx * reach,
              y: end.y + out.dy * reach,
              angle: across ? 90 : 0,
            },
            uuid: stableUuid("pwr", tabId, part.id, pad),
            root,
            base,
          }),
        );
      } else {
        labels.push([
          "label",
          q(net.name),
          ["at", end.x, end.y, out.angle],
          ["fields_autoplaced", "yes"],
          effects(...out.justify),
          ["uuid", q(stableUuid("label", tabId, part.id, pad))],
        ]);
      }
    }

    placed.push(
      partInstance({
        part,
        sym,
        k,
        origin: { x: ox, y: oy },
        uuid: stableUuid("sym", tabId, part.id),
        pinUuid: (pad) => stableUuid("pin", tabId, part.id, pad),
        root,
        base,
      }),
    );
  }

  // One PWR_FLAG per rail, beside a symbol of that rail: ERC's way of being
  // told the net is supplied (a bench supply is a connector here, whose pins
  // are passive, so nothing on the sheet otherwise says so).
  if (rails.length) {
    const p = at.get(FLAGS);
    rails.forEach((net, i) => {
      const y = snap(MARGIN + p.y + (i * 3 + 2) * PITCH);
      const x = snap(MARGIN + p.x + 2 * PITCH);
      const flagAt = { x: x + 2 * PITCH, y };
      powerSymbols.set(net.name, net.polarity);
      placed.push(
        powerInstance({
          name: net.name,
          reference: nextPwr(),
          at: { x, y },
          rot: 0,
          value: {
            x,
            y: y + (net.polarity === "VCC" ? -3.81 : 3.81),
            angle: 0,
          },
          uuid: stableUuid("pwr-flag", tabId, net.name),
          root,
          base,
        }),
      );
      wires.push(
        wireNode({ x, y }, flagAt, stableUuid("flag-wire", tabId, net.name)),
      );
      placed.push(
        flagInstance({
          reference: `#FLG${String(i + 1).padStart(2, "0")}`,
          at: flagAt,
          uuid: stableUuid("flg", tabId, net.name),
          root,
          base,
        }),
      );
    });
  }
  items.push(...noConnects, ...wires, ...labels, ...placed);

  // lib_symbols: every part symbol, then the power symbols, then the flag.
  const libSymbols = [
    "lib_symbols",
    ...[...symbols.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, sym]) =>
        symbolNode(sym, symbolFields(sym, parts, kp, `${KICAD_LIB}:`)),
      ),
    ...[...powerSymbols.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, polarity]) =>
        powerSymbolNode(name, polarity, `${KICAD_LIB}:`),
      ),
    ...(rails.length ? [pwrFlagNode(`${KICAD_LIB}:`)] : []),
  ];

  const titleBlock = [
    "title_block",
    ["title", q(desktop.name ?? base)],
    ["comment", 1, q(desktop.description ?? "")],
    ["comment", 2, q("Exported from Chip Hippo")],
  ];
  const sheet = [
    "kicad_sch",
    ["version", KICAD_SCH_VERSION],
    ["generator", q(KICAD_GENERATOR)],
    ["generator_version", q("1.0")],
    ["uuid", q(root)],
    paper
      ? ["paper", q(paper[0])]
      : [
          "paper",
          q("User"),
          snap(width + 2 * MARGIN),
          snap(height + 2 * MARGIN + TITLE_BAND),
        ],
    titleBlock,
    libSymbols,
    ...items,
    ["sheet_instances", ["path", q("/"), ["page", q("1")]]],
  ];

  // The library FILE carries the same symbols, bare-named.
  const library = [
    "kicad_symbol_lib",
    ["version", KICAD_SCH_VERSION],
    ["generator", q(KICAD_GENERATOR)],
    ["generator_version", q("1.0")],
    ...[...symbols.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, sym]) => symbolNode(sym, symbolFields(sym, parts, kp, ""))),
    ...[...powerSymbols.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, polarity]) => powerSymbolNode(name, polarity, "")),
    ...(rails.length ? [pwrFlagNode("")] : []),
  ];

  buildReport(model, kp, report);

  return {
    base,
    files: [
      { name: `${base}.kicad_sch`, text: `${formatSexpr(sheet)}\n` },
      { name: KICAD_LIB_FILE, text: `${formatSexpr(library)}\n` },
      { name: "sym-lib-table", text: symLibTable() },
      { name: `${base}.kicad_pro`, text: projectFile(base, root) },
    ],
    report,
    stats: { parts: parts.length, nets: model.nets.size },
  };
}

/** Is this pad a no_connect-type pin (which needs no flag)? */
function isNoConnectPin(sym, pad) {
  return sym.pinNodes.some(
    (node) => node[1] === "no_connect" && node[6]?.[1]?.quoted === pad,
  );
}

function wireNode(a, b, uuid) {
  return [
    "wire",
    ["pts", ["xy", a.x, a.y], ["xy", b.x, b.y]],
    ["stroke", ["width", 0], ["type", "default"]],
    ["uuid", q(uuid)],
  ];
}

/** The fields a library symbol shows, from its first instance. */
function symbolFields(sym, parts, kp, prefix) {
  const part = parts.find((p) => symbolName(p.def) === sym.name);
  const k = part ? kp.get(part.id) : null;
  return {
    prefix,
    reference: part ? part.designator.replace(/\d+$/, "") : "U",
    value: part ? (part.def.kind === "chip" ? part.def.id : k.value) : sym.name,
    footprint: k?.footprint ?? "",
    description: part?.def.title ?? "",
  };
}

/** A placed part: its symbol at `origin`, its fields, its pins, its instance. */
function partInstance({ part, sym, k, origin, uuid, pinUuid, root, base }) {
  const field = (key, text, f) => [
    "property",
    q(key),
    q(text),
    ["at", origin.x + f.x, origin.y - f.y, 0],
    effects(...f.justify),
  ];
  const hiddenField = (key, text) => [
    "property",
    q(key),
    q(text),
    ["at", origin.x, origin.y, 0],
    EFFECTS_HIDDEN,
  ];
  return [
    "symbol",
    ["lib_id", q(`${KICAD_LIB}:${sym.name}`)],
    ["at", origin.x, origin.y, 0],
    ["unit", 1],
    ["exclude_from_sim", "no"],
    ["in_bom", "yes"],
    ["on_board", "yes"],
    ["dnp", "no"],
    ["uuid", q(uuid)],
    field("Reference", part.designator, sym.fields.reference),
    field("Value", k.value, sym.fields.value),
    hiddenField("Footprint", k.footprint),
    hiddenField("Datasheet", ""),
    hiddenField("Description", part.def.title ?? ""),
    ...(k.fields ?? []).map(([key, text]) => hiddenField(key, text)),
    ...[...sym.pins.keys()].map((pad) => [
      "pin",
      q(pad),
      ["uuid", q(pinUuid(pad))],
    ]),
    instances(root, base, part.designator),
  ];
}

function instances(root, base, reference) {
  return [
    "instances",
    [
      "project",
      q(base),
      ["path", q(`/${root}`), ["reference", q(reference)], ["unit", 1]],
    ],
  ];
}

function powerInstance({ name, reference, at, rot, value, uuid, root, base }) {
  return [
    "symbol",
    ["lib_id", q(`${KICAD_LIB}:${name}`)],
    ["at", at.x, at.y, rot],
    ["unit", 1],
    ["exclude_from_sim", "no"],
    ["in_bom", "yes"],
    ["on_board", "yes"],
    ["dnp", "no"],
    ["uuid", q(uuid)],
    [
      "property",
      q("Reference"),
      q(reference),
      ["at", at.x, at.y, 0],
      EFFECTS_HIDDEN,
    ],
    // A field's angle is relative to the symbol's: 90 on a symbol turned a
    // quarter reads level again.
    [
      "property",
      q("Value"),
      q(name),
      ["at", value.x, value.y, value.angle],
      effects(),
    ],
    ["property", q("Footprint"), q(""), ["at", at.x, at.y, 0], EFFECTS_HIDDEN],
    ["property", q("Datasheet"), q(""), ["at", at.x, at.y, 0], EFFECTS_HIDDEN],
    ["pin", q("1"), ["uuid", q(stableUuid(uuid, "pin"))]],
    instances(root, base, reference),
  ];
}

function flagInstance({ reference, at, uuid, root, base }) {
  return [
    "symbol",
    ["lib_id", q(`${KICAD_LIB}:PWR_FLAG`)],
    ["at", at.x, at.y, 0],
    ["unit", 1],
    ["exclude_from_sim", "no"],
    ["in_bom", "yes"],
    ["on_board", "yes"],
    ["dnp", "no"],
    ["uuid", q(uuid)],
    [
      "property",
      q("Reference"),
      q(reference),
      ["at", at.x, at.y, 0],
      EFFECTS_HIDDEN,
    ],
    [
      "property",
      q("Value"),
      q("PWR_FLAG"),
      ["at", at.x + 1.27, at.y - 3.81, 0],
      effects("left"),
    ],
    ["property", q("Footprint"), q(""), ["at", at.x, at.y, 0], EFFECTS_HIDDEN],
    ["property", q("Datasheet"), q("~"), ["at", at.x, at.y, 0], EFFECTS_HIDDEN],
    ["pin", q("1"), ["uuid", q(stableUuid(uuid, "pin"))]],
    instances(root, base, reference),
  ];
}

/** A text's drawn width, for extents. */
const textW = (text) => String(text).length * CHAR_W;

/**
 * A part's full extent on the sheet (library coords, y up): its body, its
 * pins, their stubs and whatever hangs off each stub — a label running
 * outward, or a rail symbol pointing outward with its name beyond it.
 */
function partExtent(part, sym, k, model) {
  let { minX, maxX, minY, maxY } = sym.box;
  // The Reference above; a compact shape's Value below.
  maxY = Math.max(maxY, sym.fields.reference.y + GRID * 2);
  minY = Math.min(minY, sym.fields.value.y - GRID * 2);
  for (const port of part.ports) {
    const pin = sym.pins.get(k.pad(port.key));
    if (!pin) continue;
    minX = Math.min(minX, pin.x);
    maxX = Math.max(maxX, pin.x);
    minY = Math.min(minY, pin.y);
    maxY = Math.max(maxY, pin.y);
    const net = port.net ? model.nets.get(port.net) : null;
    if (!net) continue;
    const across = pin.side === "left" || pin.side === "right";
    let along;
    let side;
    if (!net.polarity) {
      along = STUB + textW(net.name) + GRID;
      side = GRID * 1.5;
    } else if (across) {
      along = STUB + 3.81 + textW(net.name) + GRID;
      side = GRID * 2;
    } else {
      along = STUB + 3.81 + GRID * 2;
      side = Math.max(textW(net.name) / 2, GRID * 2);
    }
    if (pin.side === "left") minX = Math.min(minX, pin.x - along);
    if (pin.side === "right") maxX = Math.max(maxX, pin.x + along);
    if (pin.side === "top") maxY = Math.max(maxY, pin.y + along);
    if (pin.side === "bottom") minY = Math.min(minY, pin.y - along);
    if (across) {
      minY = Math.min(minY, pin.y - side);
      maxY = Math.max(maxY, pin.y + side);
    } else {
      minX = Math.min(minX, pin.x - side);
      maxX = Math.max(maxX, pin.x + side);
    }
  }
  return { minX, maxX, minY, maxY };
}

/** The project-local library table: our library, found beside the project. */
function symLibTable() {
  return (
    formatSexpr([
      "sym_lib_table",
      ["version", SYM_LIB_TABLE_VERSION],
      [
        "lib",
        ["name", q(KICAD_LIB)],
        ["type", q("KiCad")],
        ["uri", q(`\${KIPRJMOD}/${KICAD_LIB_FILE}`)],
        ["options", q("")],
        ["descr", q("Symbols exported by Chip Hippo")],
      ],
    ]) + "\n"
  );
}

/** A minimal project file; KiCad fills in every default it does not state. */
function projectFile(base, root) {
  return `${JSON.stringify(
    {
      meta: { filename: `${base}.kicad_pro`, version: 1 },
      sheets: [[root, "Root"]],
    },
    null,
    2,
  )}\n`;
}

/**
 * What did not come across as it is. Grouped per (kind, code, ref), each
 * naming the parts by designator — the report is read beside the sheet.
 */
function buildReport(model, kp, report) {
  const add = (kind, code, part) => {
    let entry = report.find(
      (e) => e.kind === kind && e.code === code && e.ref === part.def.id,
    );
    if (!entry) {
      entry = { kind, code, ref: part.def.id, designators: [] };
      report.push(entry);
    }
    entry.designators.push(part.designator);
  };
  for (const part of model.parts) {
    if (!kicadMapped(part.def)) {
      add("dropped", "unmapped", part);
      continue;
    }
    if (part.def.kind === "clock") add("changed", "clockConnector", part);
    if (kp.get(part.id)?.generic) add("footprint", "genericFootprint", part);
    if (kp.get(part.id)?.pinOrder) add("footprint", "transistorPinout", part);
    if (kp.get(part.id)?.nearest) add("footprint", "nearestFootprint", part);
  }
  const signals = model.signals.length;
  if (signals)
    report.push({ kind: "dropped", code: "signals", count: signals });
  const elements = model.integrations.length;
  if (elements) {
    report.push({ kind: "dropped", code: "integrations", count: elements });
  }
}

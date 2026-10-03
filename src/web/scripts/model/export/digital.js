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

// digital.js — a desktop as a circuit for the Digital logic simulator
// (hneemann/Digital), so it can keep being SIMULATED somewhere else (Feature
// 390). Pure: it returns the `.dig` file's text.
//
// THE CHIPS ARE DIGITAL'S OWN. Its library models most of the 74xx family as
// DIL packages addressed by physical pin number, exactly as ours are, so a
// 7400 is `<elementName>7400.dig</elementName>` and Digital simulates it with
// its own model. Where a pin sits comes from that library (digital-lib.js).
//
// A LOGIC SIMULATOR HAS NO RESISTORS, and the translation says what ours MEAN
// in the engine rather than what they are on a bench. Our engine treats a
// resistor as a WEAK connection (catalog `weakBridges`), so:
//
//   · a resistor from a rail to a net is a PullUp / PullDown on that net —
//     which is what makes a series lamp resistor to GND read as a pulled-down
//     cathode, and a switch's resistor to GND a pulled-down throw;
//   · a resistor between two signals is a wire (reported: it no longer
//     limits anything);
//   · a resistor from rail to rail does nothing in logic and is left out.
//
// FLOATING TTL INPUTS READ HIGH (sim/levels.js `asInput`); in Digital an input
// with nothing driving it is an ERROR. So a net that holds a chip input and
// nothing that could ever drive it gets a PullUp — the same answer our engine
// gives — unless a resistor already decides its level (on it, or reachable
// through a switch), where a second pull would outvote the one the design
// has. An input on no net at all gets one right on the pin, and so does an
// open display leg (tied to its dark level), since Digital refuses to run a
// display with an input left open.
//
// A FLOATING CMOS INPUT READS UNKNOWN (Feature 400, `asCmosInput`), and there
// is no honest translation of that: Digital has no unknown to give it, and a
// file that refuses to run is no use. So it gets the same PullUp — and,
// unlike the TTL case, that is a CHANGE, reported per part (`cmosFloating`):
// Digital will compute a definite answer where our engine says X.
//
// OPEN-COLLECTOR OUTPUTS ('01, '03, '05) are modelled as plain gates here and
// as the real parts in Digital, which float a HIGH; the pull-up a real board
// would carry is added, and reported, so the two agree.
//
// A SLIDE SWITCH starts where the desk has it: Digital's double-throw switch
// has no initial-position attribute (it always starts common-to-C), so the
// throw the slider is on is the one wired to C.
//
// All of this is PROVED, not asserted: tests/export-digital-cli.test.js runs
// the exported demo benches in Digital itself and holds every chip output and
// lamp net to our engine's answer.
//
// CONNECTIVITY IS BY TUNNEL. Every connected pin gets a one-grid stub ending
// in a Tunnel named for its net, and Digital joins tunnels of one name — as
// kicad.js uses labels, and for the same reason: nothing can cross a pin it
// should not.

import { exportNetlist } from "./export-netlist.js";
import {
  DIGITAL_ELEMENTS,
  DIGITAL_FILES,
  DIGITAL_OPEN_COLLECTOR,
  DIGITAL_UNSUPPORTED,
} from "./digital-parts.js";
import { DIGITAL_LIB } from "./digital-lib.js";
import { safeFileBase } from "./file-base.js";
import { packColumns, viewPositions } from "./sheet-pack.js";
import { UnionFind } from "../../sim/union-find.js";
import { signalKey } from "../signals.js";
import { floatsUnknown } from "../../catalog/families.js";

/** Digital's grid unit. */
const SIZE = 20;
const STUB = SIZE;
const CHAR_W = 9; // a tunnel label's advance per character, roughly
const COL_GAP = 4 * SIZE;
const ROW_GAP = 3 * SIZE;

/** Our LED colours as Digital's AWT colours. */
const COLORS = Object.freeze({
  red: [255, 0, 0],
  green: [0, 204, 0],
  blue: [0, 102, 255],
  yellow: [255, 204, 0],
  white: [255, 255, 255],
});

/**
 * An enum attribute with no XStream alias is written under its Java class
 * name — which is how Digital itself saves a common-anode display.
 */
const COMMON_TYPE = "de.neemann.digital.core.io.CommonConnectionType";

/** The tunnel rotation that points its flag AWAY from a pin on each side. */
const TUNNEL_ROT = { left: 2, right: 0, top: 1, bottom: 3 };
const OUT = {
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
  top: { dx: 0, dy: -1 },
  bottom: { dx: 0, dy: 1 },
};

/** Whether the Digital export can place this part. */
export function digitalMapped(def) {
  return def.id in DIGITAL_FILES || DIGITAL_ELEMENTS.includes(def.id);
}

// ── Elements as data ─────────────────────────────────────────────────────────

const str = (s) => ({ string: String(s) });
const bool = (b) => ({ boolean: Boolean(b) });
const int = (n) => ({ int: Math.trunc(n) });
const rot = (r) => ({ rotation: r });
const inValue = (v) => ({ inValue: v });
const color = (name) => ({ color: COLORS[name] ?? COLORS.red });

/** One visual element: `{ name, attrs: [[key, typed]], x, y }`. */
function element(name, attrs, x, y) {
  return { name, attrs, x, y };
}

/**
 * A part's drawing, in LOCAL coordinates: its elements, its wires, and the
 * pins still to be stubbed out to a tunnel (`{x, y, side, net}`).
 */
function drawing() {
  return { elements: [], wires: [], pins: [] };
}

// ── The file ─────────────────────────────────────────────────────────────────

/**
 * Export one desktop as a Digital circuit.
 *
 * @param {object} doc - the desktop's plain document.
 * @param {{tabId?:string, name:string, description?:string}} desktop
 * @returns {{ files: Array<{name:string, text:string}>, report: Array<object>,
 *   stats: {parts:number, nets:number}, base: string }}
 */
export function exportDigital(doc, desktop) {
  const model = exportNetlist(doc);
  const report = [];

  // ── Resistors become pulls or wires; nets merge through the wires. ──
  // Everything below keys a net by its NAME once the merges are done: names
  // are unique per merged net (export-netlist.js), and a tunnel is a name.
  const uf = new UnionFind();
  for (const id of model.nets.keys()) uf.add(id);
  const pullOn = []; // { id, up } — a net id from before the merges
  const legs = (part) => {
    const port = (key) => part.ports.find((p) => p.key === key)?.net ?? null;
    if (part.def.id === "resistor") return [[port("1"), port("2")]];
    // rnet9: COM (pin 1) to each lead
    return part.ports.filter((p) => p.pin !== 1).map((p) => [port("1"), p.net]);
  };
  for (const part of model.parts) {
    if (part.def.id !== "resistor" && part.def.id !== "rnet9") continue;
    for (const [a, b] of legs(part)) {
      if (!a || !b) continue; // a floating leg connects nothing
      const pa = model.nets.get(a).polarity;
      const pb = model.nets.get(b).polarity;
      if (pa && pb) continue; // rail to rail: nothing, in logic
      if (pa || pb) {
        pullOn.push({ id: pa ? b : a, up: (pa ?? pb) === "VCC" });
        continue;
      }
      uf.union(a, b);
      addReport(report, "changed", "resistorMerged", part);
    }
  }
  // A merged net keeps the name of its first member in reading order — the
  // order export-netlist.js numbered them in.
  const repName = new Map();
  for (const [id, net] of model.nets) {
    const root = uf.find(id);
    if (!repName.has(root)) repName.set(root, net.name);
  }
  const nameOf = (netId) => (netId ? repName.get(uf.find(netId)) : null);
  const polarity = new Map(); // name → "VCC" | "GND"
  for (const [id, net] of model.nets) {
    if (net.polarity) polarity.set(nameOf(id), net.polarity);
  }
  const pulls = []; // { name, up }
  const addPull = (name, up) => {
    if (!pulls.some((p) => p.name === name && p.up === up)) {
      pulls.push({ name, up });
    }
  };
  for (const { id, up } of pullOn) {
    if (!polarity.has(nameOf(id))) addPull(nameOf(id), up);
  }

  // ── Every part's drawing. ──
  const drawings = new Map(); // part id → drawing
  const driven = new Set(); // nets something strong drives
  const inputNets = new Set(); // nets a chip input reads
  const switchLinks = []; // [netA, netB] pairs a switch contact can join
  const nearPins = []; // pulls placed right on an unconnected input pin
  const openCollector = new Set(); // nets an open-collector output drives
  const cmosInputs = []; // { part, name } — a CMOS input and the net it reads

  for (const part of model.parts) {
    if (part.def.id === "resistor" || part.def.id === "rnet9") continue;
    if (!digitalMapped(part.def)) {
      const reason =
        DIGITAL_UNSUPPORTED[part.def.id] ??
        (part.def.kind === "chip" ? "noDigitalModel" : "unmapped");
      addReport(report, "dropped", reason, part);
      drawings.set(part.id, noteDrawing(part));
      continue;
    }
    const d = drawPart(part, {
      nameOf,
      driven,
      inputNets,
      switchLinks,
      nearPins,
      openCollector,
      cmosInputs,
      report,
    });
    drawings.set(part.id, d);
  }

  // Our engine drives an open-collector output both ways; Digital's model
  // floats it when high, as the real part does. The pull-up a real one needs
  // is what makes the two agree.
  for (const name of openCollector) {
    if (!polarity.has(name) && !pulls.some((p) => p.name === name)) {
      addPull(name, true);
    }
  }

  // Signals: a momentary one is a Button, a toggle an input switch.
  const signalDrawings = [];
  for (const { signal, net } of model.signals) {
    if (!net) continue; // an unplanted flag stimulates nothing
    const key = signalKey(doc.signals ?? [], signal.id) ?? "";
    const label = signal.name?.trim() || `SIG${key}`;
    const d = drawing();
    const high = signal.rest === "high";
    if (signal.type === "momentary") {
      d.elements.push(
        element(
          "Button",
          [
            ["Label", str(label)],
            ["activeLow", bool(high)],
          ],
          0,
          0,
        ),
      );
    } else {
      d.elements.push(
        element(
          "In",
          [
            ["Label", str(label)],
            ["InDefault", inValue(high ? 1 : 0)],
          ],
          0,
          0,
        ),
      );
    }
    d.pins.push({ x: 0, y: 0, side: "right", net: nameOf(net) });
    driven.add(nameOf(net));
    signalDrawings.push({ id: `signal:${signal.id}`, d });
  }
  if (model.integrations.length) {
    report.push({
      kind: "dropped",
      code: "integrations",
      count: model.integrations.length,
    });
  }

  // ── Floating inputs read HIGH: the PullUps that say so. ──
  const pulled = new Set(pulls.map((p) => p.name));
  const reachesPull = (start) => {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const n = queue.shift();
      if (pulled.has(n)) return true;
      for (const [a, b] of switchLinks) {
        const to = a === n ? b : b === n ? a : null;
        if (to != null && !seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
    return false;
  };
  const floating = new Set();
  for (const name of inputNets) {
    if (polarity.has(name) || driven.has(name) || reachesPull(name)) continue;
    addPull(name, true);
    floating.add(name);
  }
  for (const { part, name } of cmosInputs) {
    if (floating.has(name)) addReport(report, "changed", "cmosFloating", part);
  }

  // ── Supplies and pulls: a column of their own at the left. ──
  const supplies = [];
  for (const [name, pol] of [...polarity].sort()) {
    supplies.push(sourceDrawing(pol === "VCC" ? "VDD" : "Ground", name));
  }
  for (const p of pulls) {
    supplies.push(sourceDrawing(p.up ? "PullUp" : "PullDown", p.name));
  }

  // ── Arrange: supplies first, then the parts as the Schematic view has them.
  const items = [
    ...supplies.map((d, i) => ({ id: `supply:${i}`, d })),
    ...model.parts
      .filter((p) => drawings.has(p.id))
      .map((p) => ({ id: p.id, d: drawings.get(p.id) })),
    ...signalDrawings,
  ];
  const extents = new Map(items.map(({ id, d }) => [id, extentOf(d)]));
  const view = viewPositions(doc);
  // Supplies sit in a column left of everything the view placed.
  const minX = Math.min(0, ...[...view.values()].map((p) => p.x));
  supplies.forEach((_, i) => view.set(`supply:${i}`, { x: minX - 100, y: i }));
  const at = packColumns(
    items.map((i) => i.id),
    view,
    (id) => {
      const e = extents.get(id);
      return { w: e.maxX - e.minX, h: e.maxY - e.minY };
    },
    { colGap: COL_GAP, rowGap: ROW_GAP, snap: SIZE },
  );

  const elements = [];
  const wires = [];
  for (const { id, d } of items) {
    const e = extents.get(id);
    const p = at.get(id);
    const ox = p.x - e.minX;
    const oy = p.y - e.minY;
    for (const el of d.elements) {
      elements.push({ ...el, x: el.x + ox, y: el.y + oy });
    }
    for (const [a, b] of d.wires) {
      wires.push([
        { x: a.x + ox, y: a.y + oy },
        { x: b.x + ox, y: b.y + oy },
      ]);
    }
    for (const pin of d.pins) {
      if (!pin.net) continue;
      const out = OUT[pin.side];
      const tip = { x: pin.x + ox, y: pin.y + oy };
      const end = { x: tip.x + out.dx * STUB, y: tip.y + out.dy * STUB };
      wires.push([tip, end]);
      elements.push(
        element(
          "Tunnel",
          [
            ["rotation", rot(TUNNEL_ROT[pin.side])],
            ["NetName", str(pin.net)],
          ],
          end.x,
          end.y,
        ),
      );
    }
  }
  for (const pin of nearPins) {
    const p = at.get(pin.partId);
    const e = extents.get(pin.partId);
    elements.push(
      element(
        pin.up ? "PullUp" : "PullDown",
        [],
        pin.x + p.x - e.minX,
        pin.y + p.y - e.minY,
      ),
    );
  }

  const base = safeFileBase(desktop.name);
  return {
    base,
    files: [
      { name: `${base}.dig`, text: circuitXml(elements, wires, desktop) },
    ],
    report,
    stats: {
      parts: model.parts.filter((p) => digitalMapped(p.def)).length,
      nets: new Set([...model.nets.keys()].map((id) => uf.find(id))).size,
    },
  };
}

function addReport(report, kind, code, part) {
  let entry = report.find(
    (e) => e.kind === kind && e.code === code && e.ref === part.def.id,
  );
  if (!entry) {
    entry = { kind, code, ref: part.def.id, designators: [] };
    report.push(entry);
  }
  if (!entry.designators.includes(part.designator)) {
    entry.designators.push(part.designator);
  }
}

// ── Per-part drawings ────────────────────────────────────────────────────────

/**
 * Draw one mapped part, recording what the pull rule needs to know: which
 * nets it DRIVES, which a chip INPUT reads, and which pairs a switch can join.
 */
function drawPart(part, ctx) {
  const { def, comp } = part;
  const net = (key) => part.ports.find((p) => p.key === key)?.net ?? null;
  const named = (key) => ctx.nameOf(net(key));
  const d = drawing();

  if (def.id in DIGITAL_FILES) return drawChip(part, ctx);

  switch (def.id) {
    case "psu":
      return d; // its rails are the VDD / Ground elements in the supply column
    case "clock":
    case "osc-full":
    case "osc-half": {
      const hz = comp.params?.hz;
      const manual = hz === "manual";
      d.elements.push(
        element(
          "Clock",
          [
            ["Label", str(part.designator)],
            ["runRealTime", bool(!manual)],
            ["Frequency", int(manual ? 1 : hz)],
          ],
          0,
          0,
        ),
      );
      const outKey = def.id === "clock" ? "out" : "3";
      d.pins.push({ x: 0, y: 0, side: "right", net: named(outKey) });
      if (net(outKey)) ctx.driven.add(named(outKey));
      return d;
    }
    case "led":
      return ledDrawing(
        part,
        0,
        0,
        d,
        def.polarity(comp.params),
        part.designator,
        ctx,
      );
    case "bar8":
    case "bar8iso": {
      for (const seg of def.segments) {
        const i = Number(seg.id.slice(1)) - 1;
        ledDrawing(
          part,
          i * 3 * SIZE,
          0,
          d,
          { anodePin: seg.anodePin, cathodePin: seg.cathodePin },
          `${part.designator}_${i + 1}`,
          ctx,
        );
      }
      return d;
    }
    case "seg8cc":
    case "seg8ca": {
      const anode = def.id === "seg8ca";
      d.elements.push(
        element(
          "Seven-Seg",
          [
            ["Label", str(part.designator)],
            ["Color", color(comp.params?.color)],
            // `commonCathode` is Digital's name for "has a common pin"; which
            // kind it is is a separate enum, cathode by default.
            ["commonCathode", bool(true)],
            ...(anode
              ? [
                  [
                    "commonConnectionType",
                    { enumValue: "anode", type: COMMON_TYPE },
                  ],
                ]
              : []),
          ],
          0,
          0,
        ),
      );
      // a b c d along the top, e f g dp then the common along the bottom. An
      // open segment is tied OFF and an open common leaves the digit dark
      // (Digital will not load a display with an input left open).
      const order = ["a", "b", "c", "d", "e", "f", "g", "dp"];
      const byName = new Map(part.ports.map((p) => [p.name, p]));
      const place = (port, x, y, side, off) => {
        const name = ctx.nameOf(port?.net ?? null);
        if (name) d.pins.push({ x, y, side, net: name });
        else ctx.nearPins.push({ partId: part.id, x, y, up: off });
      };
      order.forEach((name, i) => {
        const top = i < 4;
        place(
          byName.get(name),
          (i % 4) * SIZE,
          top ? 0 : 7 * SIZE,
          top ? "top" : "bottom",
          anode,
        );
      });
      place(
        part.ports.find((p) => !order.includes(p.name)),
        4 * SIZE,
        7 * SIZE,
        "bottom",
        !anode,
      );
      return d;
    }
    case "sw-slide": {
      // Digital's SwitchDT has no initial-position attribute: it always
      // starts with A (the common) joined to C. So the throw the slider is on
      // NOW is the one wired to C, and a click in Digital flips it, as a click
      // on the desk would.
      const on = comp.params?.pos === "2" ? "3" : "1";
      const off = on === "1" ? "3" : "1";
      d.elements.push(
        element("SwitchDT", [["Label", str(part.designator)]], 0, 0),
      );
      d.pins.push({ x: 0, y: 0, side: "left", net: named("2") });
      d.pins.push({ x: 2 * SIZE, y: 0, side: "right", net: named(off) });
      d.pins.push({ x: 2 * SIZE, y: SIZE, side: "right", net: named(on) });
      link(ctx, net("2"), net("1"));
      link(ctx, net("2"), net("3"));
      return d;
    }
    case "sw-push":
    case "sw-toggle": {
      if (def.id === "sw-push")
        addReport(ctx.report, "changed", "momentary", part);
      d.elements.push(
        element(
          "Switch",
          [
            ["Label", str(part.designator)],
            [
              "Closed",
              bool(def.id === "sw-toggle" && comp.params?.on === true),
            ],
          ],
          0,
          0,
        ),
      );
      d.pins.push({ x: 0, y: 0, side: "left", net: named("1") });
      d.pins.push({ x: 2 * SIZE, y: 0, side: "right", net: named("2") });
      link(ctx, net("1"), net("2"));
      return d;
    }
    default: {
      if (def.switchBank) {
        const n = def.pins.length / 2;
        const states = comp.params?.states ?? [];
        for (let k = 1; k <= n; k++) {
          const y = (k - 1) * 3 * SIZE;
          d.elements.push(
            element(
              "Switch",
              [
                ["Label", str(`${part.designator}_${k}`)],
                ["Closed", bool(states[k - 1] === true)],
              ],
              0,
              y,
            ),
          );
          d.pins.push({ x: 0, y, side: "left", net: named(String(k)) });
          d.pins.push({
            x: 2 * SIZE,
            y,
            side: "right",
            net: named(String(2 * n + 1 - k)),
          });
          link(ctx, net(String(k)), net(String(2 * n + 1 - k)));
        }
      }
      return d;
    }
  }
}

/** Record that a switch contact can join two nets (for the pull rule). */
function link(ctx, a, b) {
  if (a && b) ctx.switchLinks.push([ctx.nameOf(a), ctx.nameOf(b)]);
}

/** A PolarityAwareLED: anode on top, cathode 80 below. */
function ledDrawing(part, x, y, d, { anodePin, cathodePin }, label, ctx) {
  const netOf = (pin) =>
    ctx.nameOf(part.ports.find((p) => p.pin === pin)?.net ?? null);
  d.elements.push(
    element(
      "PolarityAwareLED",
      [
        ["Label", str(label)],
        ["Color", color(part.comp.params?.color)],
      ],
      x,
      y,
    ),
  );
  // Digital will not load a display with an input left open; one that is
  // open here is dark, so it is tied to its OFF level.
  const leg = (pin, dy, side, off) => {
    const net = netOf(pin);
    if (net) d.pins.push({ x, y: y + dy, side, net });
    else ctx.nearPins.push({ partId: part.id, x, y: y + dy, up: off });
  };
  leg(anodePin, 0, "top", false);
  leg(cathodePin, 4 * SIZE, "bottom", true);
  return d;
}

/** A DIL chip from Digital's library, with its pins where the library puts them. */
function drawChip(part, ctx) {
  const file = DIGITAL_FILES[part.def.id];
  const lib = DIGITAL_LIB[file];
  const n = lib.pins;
  const right = SIZE * (lib.width + 1);
  const d = drawing();
  d.elements.push(element(file, [["Label", str(part.designator)]], 0, 0));
  const outputs = new Set(lib.outputs);
  let unpowered = false;
  for (const port of part.ports) {
    const p = port.pin;
    const pos =
      p <= n / 2
        ? { x: 0, y: 2 * SIZE * (p - 1), side: "left" }
        : { x: right, y: 2 * SIZE * (n - p), side: "right" };
    const name = ctx.nameOf(port.net);
    const cmosInput = port.role === "input" && floatsUnknown(part.def);
    if (name) {
      d.pins.push({ ...pos, net: name });
      if (port.role === "output" || port.role === "io") ctx.driven.add(name);
      if (port.role === "input") ctx.inputNets.add(name);
      if (cmosInput) ctx.cmosInputs.push({ part, name });
      continue;
    }
    // On no net. Digital cannot load a chip with an input left unconnected,
    // and a floating TTL input reads HIGH anyway — so tie it high, right on
    // the pin (a CMOS one too, and say so). Power pins get the supply they
    // would need.
    if (port.role === "vcc" || port.role === "gnd") unpowered = true;
    if (outputs.has(p) || port.role === "nc") continue;
    if (cmosInput) addReport(ctx.report, "changed", "cmosFloating", part);
    ctx.nearPins.push({
      partId: part.id,
      x: pos.x,
      y: pos.y,
      up: port.role !== "gnd",
    });
  }
  if (unpowered) addReport(ctx.report, "changed", "unpowered", part);
  if (DIGITAL_OPEN_COLLECTOR.includes(part.def.id)) {
    for (const port of part.ports) {
      const name = ctx.nameOf(port.net);
      if (name && port.role === "output") ctx.openCollector.add(name);
    }
    addReport(ctx.report, "changed", "openCollector", part);
  }
  return d;
}

/** A part Digital cannot model: a note where it would have been. */
function noteDrawing(part) {
  const d = drawing();
  d.elements.push(
    element(
      "Text",
      [
        [
          "Description",
          str(`${part.designator} ${part.def.id} (not exported)`),
        ],
      ],
      0,
      0,
    ),
  );
  return d;
}

/** A supply or pull element driving a tunnel of `net`'s name. */
function sourceDrawing(kind, net) {
  const d = drawing();
  d.elements.push(element(kind, [], 0, 0));
  d.pins.push({ x: 0, y: 0, side: "right", net });
  return d;
}

/** A drawing's extent, local coords, generous enough for bodies and labels. */
function extentOf(d) {
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  const grow = (x, y) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };
  for (const el of d.elements) {
    const size = bodySize(el);
    grow(el.x + size.minX, el.y + size.minY);
    grow(el.x + size.maxX, el.y + size.maxY);
  }
  for (const pin of d.pins) {
    if (!pin.net) continue;
    const out = OUT[pin.side];
    const reach = STUB + SIZE + String(pin.net).length * CHAR_W;
    grow(pin.x + out.dx * reach, pin.y + out.dy * reach);
    if (pin.side === "left" || pin.side === "right") {
      grow(pin.x, pin.y - SIZE);
      grow(pin.x, pin.y + SIZE);
    } else {
      grow(pin.x - SIZE, pin.y);
      grow(pin.x + SIZE, pin.y);
    }
  }
  const snapDown = (v) => Math.floor(v / SIZE) * SIZE;
  const snapUp = (v) => Math.ceil(v / SIZE) * SIZE;
  return {
    minX: snapDown(minX),
    maxX: snapUp(maxX),
    minY: snapDown(minY),
    maxY: snapUp(maxY),
  };
}

/** Rough body extents of each element kind, around its origin. */
function bodySize(el) {
  if (el.name.endsWith(".dig")) {
    const lib = DIGITAL_LIB[el.name];
    return {
      minX: 0,
      maxX: SIZE * (lib.width + 1),
      minY: -SIZE,
      maxY: 2 * SIZE * (lib.pins / 2 - 1) + SIZE,
    };
  }
  switch (el.name) {
    case "Seven-Seg":
      return { minX: -SIZE, maxX: 5 * SIZE, minY: 0, maxY: 7 * SIZE };
    case "PolarityAwareLED":
      return { minX: -SIZE, maxX: 3 * SIZE, minY: 0, maxY: 4 * SIZE };
    case "Switch":
    case "SwitchDT":
      return { minX: 0, maxX: 2 * SIZE, minY: -2 * SIZE, maxY: 2 * SIZE };
    case "Clock":
    case "Button":
    case "In":
      return { minX: -4 * SIZE, maxX: 0, minY: -SIZE, maxY: SIZE };
    case "VDD":
    case "PullUp":
      return { minX: -SIZE, maxX: SIZE, minY: -2 * SIZE, maxY: 0 };
    case "Ground":
    case "PullDown":
      return { minX: -SIZE, maxX: SIZE, minY: 0, maxY: 2 * SIZE };
    case "Text":
      return { minX: 0, maxX: 12 * SIZE, minY: -SIZE, maxY: SIZE };
    default:
      return { minX: -SIZE, maxX: SIZE, minY: -SIZE, maxY: SIZE };
  }
}

// ── XML ──────────────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function attrXml([key, value], pad = "        ") {
  let body;
  if ("string" in value) body = `<string>${esc(value.string)}</string>`;
  else if ("boolean" in value) body = `<boolean>${value.boolean}</boolean>`;
  else if ("int" in value) body = `<int>${value.int}</int>`;
  else if ("rotation" in value) {
    body = `<rotation rotation="${value.rotation}"/>`;
  } else if ("inValue" in value) {
    body = `<value v="${value.inValue}" z="false"/>`;
  } else if ("color" in value) {
    const [r, g, b] = value.color;
    body =
      `<awt-color><red>${r}</red><green>${g}</green><blue>${b}</blue>` +
      `<alpha>255</alpha></awt-color>`;
  } else if ("enumValue" in value) {
    body = `<${value.type}>${esc(value.enumValue)}</${value.type}>`;
  }
  return (
    `${pad}<entry>\n${pad}  <string>${esc(key)}</string>\n` +
    `${pad}  ${body}\n${pad}</entry>`
  );
}

function circuitXml(elements, wires, desktop) {
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<circuit>",
    "  <version>2</version>",
    "  <attributes>",
    attrXml(
      [
        "Description",
        str(
          [desktop.name, desktop.description, "Exported from Chip Hippo"]
            .filter(Boolean)
            .join("\n"),
        ),
      ],
      "    ",
    ),
    "  </attributes>",
    "  <visualElements>",
  ];
  for (const el of elements) {
    lines.push("    <visualElement>");
    lines.push(`      <elementName>${esc(el.name)}</elementName>`);
    if (el.attrs.length) {
      lines.push("      <elementAttributes>");
      for (const a of el.attrs) lines.push(attrXml(a));
      lines.push("      </elementAttributes>");
    } else {
      lines.push("      <elementAttributes/>");
    }
    lines.push(`      <pos x="${el.x}" y="${el.y}"/>`);
    lines.push("    </visualElement>");
  }
  lines.push("  </visualElements>");
  lines.push("  <wires>");
  for (const [a, b] of wires) {
    lines.push("    <wire>");
    lines.push(`      <p1 x="${a.x}" y="${a.y}"/>`);
    lines.push(`      <p2 x="${b.x}" y="${b.y}"/>`);
    lines.push("    </wire>");
  }
  lines.push("  </wires>");
  lines.push("  <measurementOrdering/>");
  lines.push("</circuit>");
  return `${lines.join("\n")}\n`;
}

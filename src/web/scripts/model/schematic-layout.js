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

// schematic-layout.js — the pure projection of a desk document onto a logical
// schematic (Feature 150). DOM-free and DETERMINISTIC (no Math.random, per the
// engine rules): the same design always lays out the same way.
//
// Pipeline:
//   1. one NODE per part with a symbol; CHIPS take a COLUMN by signal-flow
//      depth (a chip driven by another sits one column to its right) with a
//      cheap barycentric pass to reduce edge crossings, and the discretes
//      place AROUND them by role — sources and switch banks to the left,
//      indicators to the right, passives by the direction of the chip pins
//      on their nets (a series LED resistor between its chip and its LED);
//   2. every pin resolved to its NET (from the netlist) so ports know what
//      they connect to; power/ground nets never route — they DROP a VCC/GND
//      rail symbol at each pin — and never steer placement either;
//   3. columns stack COMPACTLY (each node by its own height) and a column of
//      discretes FOLDS into side-by-side sub-columns until the diagram reads
//      wider than tall — the shape of the window it is viewed in;
//   4. EDGES routed orthogonally (Manhattan) between pin stubs; a `pinGroups`
//      bus that connects two chips collapses to ONE fat bus line.
//
// `schematicPos` hints (a dragged symbol) override the computed position; edges
// always re-derive from the actual node positions, so a nudge reflows only its
// own connections and never disturbs the rest.

import { symbolFor } from "../catalog/symbols.js";
import { formatAddress } from "./breadboard.js";

// ── Symbol box geometry (pitch units; the schematic reuses the desk camera) ──

const STUB = 1.6; // stub length outside the box edge
const PIN_PITCH = 2.2; // spacing between stubs along an edge
const SIDE_PAD = 1.7; // vertical pad above the first / below the last row
const MIN_W = 7; // narrowest box
const MIN_H = 4.4; // shortest box
const CHAR_W = 0.55; // approx label width per character

/** Stable per-stub key within a symbol (a pin number, or a bus name). */
function stubKey(stub) {
  return stub.kind === "bus" ? `bus:${stub.name}` : `pin:${stub.pin}`;
}

function labelWidth(text) {
  return (text ? String(text).length : 0) * CHAR_W;
}

/** Bounding size (pitch units) of each distinctive-shape symbol. */
const SHAPE_SIZES = Object.freeze({
  led: { w: 3.2, h: 5 },
  resistor: { w: 6, h: 2.4 },
  switch: { w: 5, h: 4.4 },
  button: { w: 5, h: 2.8 },
  psu: { w: 5, h: 5 },
  clock: { w: 5.5, h: 4.4 },
});

/**
 * The box/shape + port geometry for a symbol, in LOCAL coords (origin at the
 * top-left). Shared by the layout router and the view so a stub is drawn and
 * routed at exactly one place.
 *
 * @returns {{ width:number, height:number, ports:Array }}
 *   Each port: `{ key, side, name, pins, terminal, ex, ey, tx, ty }` where
 *   (ex,ey) is the edge attach point and (tx,ty) the stub tip.
 */
export function symbolGeometry(symbol) {
  return symbol.kind === "shape" ? shapeGeometry(symbol) : boxGeometry(symbol);
}

/** A distinctive-shape part's terminal ports at fixed edge positions. */
function shapeGeometry(symbol) {
  const { w, h } = SHAPE_SIZES[symbol.shape] ?? { w: MIN_W, h: MIN_H };
  const ports = symbol.terminals.map((t) => {
    const off = t.offset ?? 0;
    let ex;
    let ey;
    let tx;
    let ty;
    if (t.side === "left" || t.side === "right") {
      const x = t.side === "left" ? 0 : w;
      ex = x;
      ey = h / 2 + off;
      tx = t.side === "left" ? -STUB : w + STUB;
      ty = ey;
    } else {
      const y = t.side === "top" ? 0 : h;
      ex = w / 2 + off;
      ey = y;
      tx = ex;
      ty = t.side === "top" ? -STUB : h + STUB;
    }
    return {
      key: t.key,
      side: t.side,
      kind: "terminal",
      name: t.name,
      pins: t.pin != null ? [t.pin] : [],
      terminal: t.terminal ?? null,
      ex,
      ey,
      tx,
      ty,
    };
  });
  return { width: w, height: h, ports };
}

/** A chip / box part's pin-stub geometry from its `sides`. */
function boxGeometry(symbol) {
  const { left, right, top, bottom } = symbol.sides;
  const rows = Math.max(left.length, right.length, 1);
  const height = Math.max(MIN_H, 2 * SIDE_PAD + (rows - 1) * PIN_PITCH);

  const leftMax = Math.max(0, ...left.map((s) => labelWidth(s.name)));
  const rightMax = Math.max(0, ...right.map((s) => labelWidth(s.name)));
  const centerMax = Math.max(labelWidth(symbol.label), 2.5);
  const width = Math.max(
    MIN_W,
    leftMax + rightMax + centerMax + 2,
    (Math.max(top.length, bottom.length) + 1) * PIN_PITCH,
  );

  const ports = [];
  const place = (stubs, side) => {
    const n = stubs.length;
    stubs.forEach((stub, i) => {
      let ex;
      let ey;
      let tx;
      let ty;
      if (side === "left" || side === "right") {
        const x = side === "left" ? 0 : width;
        ex = x;
        ey = height / 2 + (i - (n - 1) / 2) * PIN_PITCH;
        tx = side === "left" ? x - STUB : x + STUB;
        ty = ey;
      } else {
        const y = side === "top" ? 0 : height;
        ex = width / 2 + (i - (n - 1) / 2) * PIN_PITCH;
        ey = y;
        tx = ex;
        ty = side === "top" ? y - STUB : y + STUB;
      }
      ports.push({
        key: stubKey(stub),
        side,
        kind: stub.kind,
        role: stub.role,
        name: stub.name,
        pins: stub.kind === "bus" ? [...stub.pins] : [stub.pin],
        terminal: null,
        ex,
        ey,
        tx,
        ty,
      });
    });
  };
  place(left, "left");
  place(right, "right");
  place(top, "top");
  place(bottom, "bottom");
  return { width, height, ports };
}

// ── Layout ───────────────────────────────────────────────────────────────────

const COL_GAP = 12; // bare desk between one column's boxes and the next
const ROW_GAP = 3; // bare desk between stacked slots in a column
const SUB_GAP = 9; // between the sub-columns of a folded column
const V_CLEAR = STUB + 2.6; // room above/below a box for stubs + rail glyphs
const ASPECT = 1.5; // stop folding once the diagram is this much wider than tall
const COL_BUDGET = 100; // a column taller than ~5 chip symbols folds regardless
const BARY_PASSES = 4; // barycentric sweeps (fixed → deterministic)

// Where a non-chip part sits relative to its chip neighbours: supplies and
// every switch bank feed from the LEFT, indicators sink to the RIGHT, and a
// passive (resistor, network, module) sits by the direction of the chip pins
// on its nets. `sw-` is a PREFIX rule so the DIP banks (sw-dip1…8) and any
// future switch classify without a hand-kept list.
const SOURCE_REFS = new Set(["psu", "clock"]);
const SINK_REFS = new Set(["led", "seg8cc", "seg8ca", "bar8", "bar8iso"]);
const isSource = (ref) => SOURCE_REFS.has(ref) || ref.startsWith("sw-");
const isSink = (ref) => SINK_REFS.has(ref);

// Pin roles that make a chip DRIVE a net / READ it, for placing passives.
const DRIVER_ROLES = ["output", "io"];
const READER_ROLES = ["input"];

/** A net's `+`/`-` power polarity, or null if it is an ordinary signal net. */
function netPolarity(net) {
  let plus = false;
  let minus = false;
  for (const t of net.terminals) {
    if (t.endsWith("+")) plus = true;
    else if (t.endsWith("-")) minus = true;
  }
  for (const r of net.rails) {
    if (r.endsWith("+")) plus = true;
    else if (r.endsWith("-")) minus = true;
  }
  for (const p of net.pins) {
    if (p.role === "vcc") plus = true;
    else if (p.role === "gnd") minus = true;
  }
  if (plus && !minus) return "VCC";
  if (minus && !plus) return "GND";
  return null; // undriven signal, or a supply short — route it so it shows
}

/**
 * Assign each node a column by longest signal-flow depth. Cycles (a cross-
 * coupled latch) are broken deterministically: a DFS in sorted-id order labels
 * back edges, and the depth is the longest path over the remaining DAG.
 */
function assignColumns(nodeIds, driverEdges) {
  const ids = [...nodeIds].sort();
  const adj = new Map(ids.map((id) => [id, []]));
  for (const [u, v] of driverEdges) {
    if (u !== v && adj.has(u) && adj.has(v)) adj.get(u).push(v);
  }
  for (const id of ids) adj.set(id, [...new Set(adj.get(id))].sort());

  // DFS colouring to find back edges (edge into a node still on the stack).
  const color = new Map(ids.map((id) => [id, 0])); // 0 white, 1 gray, 2 black
  const back = new Set(); // "u v"
  const visit = (u) => {
    color.set(u, 1);
    for (const v of adj.get(u)) {
      if (color.get(v) === 1) back.add(`${u} ${v}`);
      else if (color.get(v) === 0) visit(v);
    }
    color.set(u, 2);
  };
  for (const id of ids) if (color.get(id) === 0) visit(id);

  // Column = longest distance FROM a source. Relax over the DAG's forward edges
  // (back edges dropped) until stable — bounded by the node count.
  const col = new Map(ids.map((id) => [id, 0]));
  const forwardEdges = [];
  for (const u of ids) {
    for (const v of adj.get(u)) {
      if (!back.has(`${u} ${v}`)) forwardEdges.push([u, v]);
    }
  }
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const [u, v] of forwardEdges) {
      if (col.get(v) < col.get(u) + 1) {
        col.set(v, col.get(u) + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return col;
}

/** Order nodes within each column, reducing crossings by barycentric sweeps. */
function assignRows(columns, neighbors) {
  // columns: Map<col, id[]> (each already id-sorted); neighbors: id -> id[].
  const order = new Map(); // col -> id[]
  for (const [c, ids] of columns) order.set(c, [...ids]);
  const rowOf = new Map();
  const reindex = () => {
    for (const ids of order.values()) {
      ids.forEach((id, i) => rowOf.set(id, i));
    }
  };
  reindex();

  const cols = [...order.keys()].sort((a, b) => a - b);
  for (let pass = 0; pass < BARY_PASSES; pass++) {
    const sweep = pass % 2 === 0 ? cols : [...cols].reverse();
    for (const c of sweep) {
      const ids = order.get(c);
      const bary = new Map();
      ids.forEach((id, i) => {
        const ns = neighbors.get(id) ?? [];
        const rows = ns.map((n) => rowOf.get(n)).filter((r) => r != null);
        bary.set(
          id,
          rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : i,
        );
      });
      ids.sort((a, b) => {
        const d = bary.get(a) - bary.get(b);
        return d !== 0 ? d : a < b ? -1 : 1; // stable id tie-break
      });
      reindex();
    }
  }
  return rowOf;
}

/**
 * Project a desk document + its netlist onto a schematic.
 *
 * @param {{components:Array, signals:Array}} doc - a plain desk document
 *   (from `toJSON`).
 * @param {{nets:Map, netOfPoint:Map, names:Map}} netlist - from buildNetlist.
 * @param {Object<string,{x:number,y:number}>} [posHints] - componentId → a
 *   persisted `schematicPos` nudge that overrides the computed position.
 * @returns {{ nodes:Array, edges:Array, powerStubs:Array, signalStubs:Array,
 *   bounds:object }}
 */
export function layout(doc, netlist, posHints = {}) {
  const components = doc.components ?? [];
  const nets = netlist?.nets ?? new Map();
  const names = netlist?.names ?? new Map();
  const netOfPoint = netlist?.netOfPoint ?? new Map();

  // Nodes: EVERY component with a symbol — chips + discretes (board-seated) and
  // PSU/clock bricks (desk-level, no board; their terminals are the ports).
  const nodeList = [];
  for (const comp of components) {
    const symbol = symbolFor(comp.ref);
    if (!symbol) continue;
    nodeList.push({ comp, symbol, geometry: symbolGeometry(symbol) });
  }
  nodeList.sort((a, b) => (a.comp.id < b.comp.id ? -1 : 1));
  const nodeIds = nodeList.map((n) => n.comp.id);
  const nodeById = new Map(nodeList.map((n) => [n.comp.id, n]));
  const chipIds = new Set(
    nodeList.filter((n) => n.symbol.kind === "chip").map((n) => n.comp.id),
  );

  // pin → net (chips AND discretes are classified in the netlist by hole).
  const pinNet = new Map(); // `${compId}#${pin}` -> netId
  for (const [netId, net] of nets) {
    for (const p of net.pins) {
      if (nodeById.has(p.componentId)) {
        pinNet.set(`${p.componentId}#${p.pin}`, netId);
      }
    }
  }

  // The nets a port touches: a pin via its hole, a brick terminal via its pad.
  const netsOfPort = (nodeId, port) => {
    if (port.terminal != null) {
      const nid = netOfPoint.get(formatAddress(nodeId, port.terminal));
      return nid ? [nid] : [];
    }
    return port.pins
      .map((pin) => pinNet.get(`${nodeId}#${pin}`))
      .filter(Boolean);
  };

  // Net polarity up front. Power nets drop rail stubs instead of routing —
  // and they must not steer PLACEMENT either: every part touches power, so a
  // power net says nothing about where a part belongs (counting them made
  // every LED a "neighbour" of every chip through the ground rail).
  const polarityOf = new Map(); // netId -> "VCC" | "GND"
  for (const [netId, net] of nets) {
    const polarity = netPolarity(net);
    if (polarity) polarityOf.set(netId, polarity);
  }

  // Per-node net sets: SIGNAL nets steer placement; ALL nets (power included)
  // stay the fallback for a part with no signal wiring at all (a PSU).
  const signalNetsOf = new Map(nodeIds.map((id) => [id, new Set()]));
  const allNetsOf = new Map(nodeIds.map((id) => [id, new Set()]));
  for (const node of nodeList) {
    for (const port of node.geometry.ports) {
      for (const nid of netsOfPort(node.comp.id, port)) {
        allNetsOf.get(node.comp.id).add(nid);
        if (!polarityOf.has(nid)) signalNetsOf.get(node.comp.id).add(nid);
      }
    }
  }

  // Undirected SIGNAL neighbours (nodes sharing a routed net) for the
  // crossing-reduction pass and the discrete placement below.
  const neighbors = new Map(nodeIds.map((id) => [id, new Set()]));
  const nodesOnNet = new Map();
  for (const [id, set] of signalNetsOf) {
    for (const nid of set) {
      if (!nodesOnNet.has(nid)) nodesOnNet.set(nid, []);
      nodesOnNet.get(nid).push(id);
    }
  }
  for (const ids of nodesOnNet.values()) {
    for (const a of ids)
      for (const b of ids) if (a !== b) neighbors.get(a).add(b);
  }

  // Column depth over CHIPS only: a chip output drives the chips reading it.
  const chipDriverEdges = [];
  for (const [, net] of nets) {
    const drv = [];
    const rds = [];
    for (const p of net.pins) {
      if (!chipIds.has(p.componentId)) continue;
      if (p.role === "output" || p.role === "io") drv.push(p.componentId);
      if (p.role === "input" || p.role === "io") rds.push(p.componentId);
    }
    for (const d of drv)
      for (const r of rds) if (d !== r) chipDriverEdges.push([d, r]);
  }
  const chipCol = assignColumns([...chipIds], chipDriverEdges);

  // Every node's column. Chips take their signal-flow depth; a non-chip part
  // is placed by what it IS relative to the chips on its signal nets, resolved
  // in dependency order — passives from the chips, then sources and sinks from
  // the chips and the placed passives — so a series LED resistor lands BETWEEN
  // its driving chip and its LED instead of stacked into the chip's column,
  // and the LED lands one column further right again.
  const colOf = new Map();
  for (const id of chipIds) colOf.set(id, chipCol.get(id) ?? 0);

  /** Columns of the chip pins on a node's signal nets, filtered by role. */
  const chipColsOf = (id, roles) => {
    const cols = [];
    for (const nid of signalNetsOf.get(id)) {
      for (const p of nets.get(nid)?.pins ?? []) {
        if (!chipIds.has(p.componentId)) continue;
        if (roles && !roles.includes(p.role)) continue;
        cols.push(colOf.get(p.componentId) ?? 0);
      }
    }
    return cols;
  };
  const placedNeighborCols = (id, among) =>
    [...neighbors.get(id)]
      .filter((n) => among.has(n) && colOf.has(n))
      .map((n) => colOf.get(n));

  const nonChips = nodeList.filter((n) => !chipIds.has(n.comp.id));
  const passiveIds = new Set(
    nonChips
      .filter((n) => !isSource(n.comp.ref) && !isSink(n.comp.ref))
      .map((n) => n.comp.id),
  );
  // Passives first: DOWNSTREAM of any chip output on their nets (a series LED
  // resistor), UPSTREAM beside the sources when they condition a chip input
  // with no driver (a pull), inline with any other chip contact.
  for (const node of nonChips) {
    const id = node.comp.id;
    if (!passiveIds.has(id)) continue;
    const drivers = chipColsOf(id, DRIVER_ROLES);
    if (drivers.length) {
      colOf.set(id, Math.max(...drivers) + 1);
      continue;
    }
    const readers = chipColsOf(id, READER_ROLES);
    if (readers.length) {
      colOf.set(id, Math.min(...readers) - 1);
      continue;
    }
    const any = chipColsOf(id, null);
    if (any.length) colOf.set(id, Math.min(...any));
  }
  // A passive reaching only other passives (a divider chain) tags along.
  for (let pass = 0; pass < 3; pass++) {
    for (const node of nonChips) {
      const id = node.comp.id;
      if (!passiveIds.has(id) || colOf.has(id)) continue;
      const near = placedNeighborCols(id, passiveIds);
      if (near.length) colOf.set(id, Math.min(...near));
    }
  }
  // Sources feed from the LEFT of what they reach; sinks fall to the RIGHT.
  // Each looks to its chips first, then to the placed passives between it and
  // the chips (an LED behind its series resistor) — never to its own kind, so
  // two switches sharing a net cannot chase each other leftward.
  for (const node of nonChips) {
    const id = node.comp.id;
    if (passiveIds.has(id)) continue;
    const chips = chipColsOf(id, null);
    const near = chips.length ? chips : placedNeighborCols(id, passiveIds);
    if (!near.length) continue; // no signal wiring — the fallback below
    colOf.set(
      id,
      isSource(node.comp.ref) ? Math.min(...near) - 1 : Math.max(...near) + 1,
    );
  }
  // A passive hanging off a SINK (the resistor between an LED's cathode and
  // ground touches no chip at all) continues the flow OUTWARD — one column
  // past the sink, where an anode-side series resistor sits one before it.
  // One reaching anything else joins the leftmost column it touches.
  for (let pass = 0; pass < 3; pass++) {
    for (const node of nonChips) {
      const id = node.comp.id;
      if (!passiveIds.has(id) || colOf.has(id)) continue;
      const placed = [...neighbors.get(id)].filter((n) => colOf.has(n));
      if (!placed.length) continue;
      const cols = placed.map((n) => colOf.get(n));
      const allSinks = placed.every((n) => isSink(nodeById.get(n).comp.ref));
      colOf.set(id, allSinks ? Math.max(...cols) + 1 : Math.min(...cols));
    }
  }
  // Anything still unplaced has no routed signal to steer it (a PSU touches
  // only power nets): fall back to the chips it shares ANY net with.
  for (const node of nodeList) {
    const id = node.comp.id;
    if (colOf.has(id)) continue;
    const cols = [];
    for (const nid of allNetsOf.get(id)) {
      for (const p of nets.get(nid)?.pins ?? []) {
        if (chipIds.has(p.componentId)) cols.push(colOf.get(p.componentId));
      }
    }
    let c = 0;
    if (cols.length) {
      if (isSource(node.comp.ref)) c = Math.min(...cols) - 1;
      else if (isSink(node.comp.ref)) c = Math.max(...cols) + 1;
      else c = Math.min(...cols);
    }
    colOf.set(id, c);
  }
  const minCol = Math.min(0, ...colOf.values());
  for (const [id, c] of colOf) colOf.set(id, c - minCol);

  const columns = new Map();
  for (const id of [...nodeIds].sort()) {
    const c = colOf.get(id) ?? 0;
    if (!columns.has(c)) columns.set(c, []);
    columns.get(c).push(id);
  }
  const neighborArrays = new Map(
    [...neighbors].map(([id, set]) => [id, [...set].sort()]),
  );
  const rowOf = assignRows(columns, neighborArrays);

  // ── Stacking & folding ─────────────────────────────────────────────────────
  // Nodes stack COMPACTLY: each advances by its own height (plus clearance
  // for any top/bottom stubs and their rail glyphs), never by a global row
  // pitch — a pitch sized to the tallest symbol on the desk spaced sixteen
  // small LEDs a chip-height apart each. Then a column of DISCRETES (no chip
  // in it: the LED bank, the resistor bank, the switches) FOLDS into
  // side-by-side sub-columns until the diagram reads wider than tall — the
  // shape of the window it is viewed in. A chip column never folds: the
  // left→right signal flow is the schematic's readable skeleton.
  const padCache = new Map();
  const padOf = (id) => {
    let pad = padCache.get(id);
    if (!pad) {
      const ports = nodeById.get(id).geometry.ports;
      pad = {
        top: ports.some((p) => p.side === "top") ? V_CLEAR : 0,
        bottom: ports.some((p) => p.side === "bottom") ? V_CLEAR : 0,
      };
      padCache.set(id, pad);
    }
    return pad;
  };
  const slotH = (id) => {
    const pad = padOf(id);
    return pad.top + nodeById.get(id).geometry.height + pad.bottom;
  };
  const stackedHeight = (ids) =>
    ids.reduce((sum, id) => sum + slotH(id), 0) +
    ROW_GAP * Math.max(0, ids.length - 1);

  /** Split an ordered stack into ≤count runs of roughly equal height. */
  const foldStack = (ids, count) => {
    if (count <= 1 || ids.length <= 1) return [ids];
    const runs = [];
    let run = [];
    let height = 0;
    let remaining = stackedHeight(ids);
    // The fair share is FROZEN at the start of each run (what is left over
    // the runs still to fill) — recomputing it per node shrinks the target
    // as the run consumes, closing every run early and dumping the surplus
    // into the last one.
    let target = remaining / count;
    for (const id of ids) {
      const add = (run.length ? ROW_GAP : 0) + slotH(id);
      if (run.length && runs.length < count - 1 && height + add / 2 > target) {
        runs.push(run);
        run = [];
        height = 0;
        target = remaining / (count - runs.length);
      }
      const consumed = (run.length ? ROW_GAP : 0) + slotH(id);
      run.push(id);
      height += consumed;
      remaining -= consumed;
    }
    runs.push(run);
    return runs;
  };

  const colKeys = [...columns.keys()].sort((a, b) => a - b);
  const orderedIds = new Map(
    colKeys.map((c) => [
      c,
      [...columns.get(c)].sort((a, b) => rowOf.get(a) - rowOf.get(b)),
    ]),
  );
  const folds = new Map(colKeys.map((c) => [c, 1]));
  const runsOf = new Map(colKeys.map((c) => [c, [orderedIds.get(c)]]));
  // How freely a column folds. A column of discretes: whenever the diagram
  // wants width ("free" — stacking order between LEDs carries no meaning). A
  // column holding chips: only past the absolute height budget, and only when
  // no member DRIVES another member ("over-budget" — four parallel XOR chips
  // are independent lanes, and folding lanes breaks nothing; co-reading one
  // source does not couple them). A driver→reader pair in ONE column is a
  // feedback loop (a cross-coupled latch), whose adjacency is the drawing —
  // that column never folds, and neither does a small aligned diagram that
  // already fits: the left→right flow is the schematic's readable skeleton,
  // not something to fold into a grid just to chase a window shape.
  const laneCoupled = new Set();
  for (const [u, v] of chipDriverEdges) {
    if (colOf.get(u) === colOf.get(v)) {
      laneCoupled.add(u);
      laneCoupled.add(v);
    }
  }
  const foldTier = new Map(
    colKeys.map((c) => {
      const ids = orderedIds.get(c);
      if (!ids.some((id) => chipIds.has(id))) return [c, "free"];
      return [
        c,
        ids.some((id) => laneCoupled.has(id)) ? "never" : "over-budget",
      ];
    }),
  );
  const runWidth = (run) =>
    Math.max(...run.map((id) => nodeById.get(id).geometry.width));
  const colWidth = (c) =>
    runsOf.get(c).reduce((sum, run) => sum + runWidth(run), 0) +
    SUB_GAP * (runsOf.get(c).length - 1);
  const colHeight = (c) => Math.max(...runsOf.get(c).map(stackedHeight));
  const totalWidth = () =>
    colKeys.reduce((sum, c) => sum + colWidth(c), 0) +
    (STUB * 2 + COL_GAP) * Math.max(0, colKeys.length - 1);

  while (colKeys.length) {
    const tall = Math.max(...colKeys.map(colHeight));
    if (tall <= COL_BUDGET && totalWidth() >= ASPECT * tall) break;
    // Fold the tallest foldable column one step further; when the tallest
    // cannot fold, the diagram is as wide as it honestly gets.
    const pick = colKeys.find((c) => {
      if (folds.get(c) >= orderedIds.get(c).length) return false;
      const tier = foldTier.get(c);
      if (tier === "never") return false;
      if (tier === "over-budget" && tall <= COL_BUDGET) return false;
      return colHeight(c) >= tall - 1e-6;
    });
    if (pick == null) break;
    folds.set(pick, folds.get(pick) + 1);
    runsOf.set(pick, foldStack(orderedIds.get(pick), folds.get(pick)));
  }

  // Column x by accumulated widths; each column's runs centred vertically so
  // the diagram balances around the origin.
  const colX = new Map();
  let x = 0;
  for (const c of colKeys) {
    colX.set(c, x);
    x += colWidth(c) + STUB * 2 + COL_GAP;
  }
  const posOf = new Map();
  for (const c of colKeys) {
    let runX = colX.get(c);
    for (const run of runsOf.get(c)) {
      let y = -stackedHeight(run) / 2;
      for (const id of run) {
        posOf.set(id, { x: runX, y: y + padOf(id).top });
        y += slotH(id) + ROW_GAP;
      }
      runX += runWidth(run) + SUB_GAP;
    }
  }

  const nodes = [];
  for (const node of nodeList) {
    const id = node.comp.id;
    const pos = posOf.get(id) ?? { x: 0, y: 0 };
    let nx = pos.x;
    let ny = pos.y;
    const hint = posHints[id];
    if (hint && Number.isFinite(hint.x) && Number.isFinite(hint.y)) {
      nx = hint.x;
      ny = hint.y;
    }
    nodes.push({
      id,
      ref: node.comp.ref,
      params: node.comp.params ?? {},
      x: nx,
      y: ny,
      symbol: node.symbol,
      geometry: node.geometry,
      portNets: {}, // port key → [netId…] (filled below, for stub tinting)
    });
  }

  // World-space ports: single-pin ports keyed by their net; bus stubs keep the
  // set of nets they fan onto.
  const netPorts = new Map(); // netId -> [{ nodeId, tx, ty, side }]
  const busPorts = []; // { nodeId, name, tip, side, nets:Set }
  for (const node of nodes) {
    for (const port of node.geometry.ports) {
      const tip = { x: node.x + port.tx, y: node.y + port.ty };
      if (port.kind === "bus") {
        const set = new Set();
        for (const pin of port.pins) {
          const nid = pinNet.get(`${node.id}#${pin}`);
          if (nid) set.add(nid);
        }
        node.portNets[port.key] = [...set].sort();
        busPorts.push({
          nodeId: node.id,
          name: port.name,
          tip,
          side: port.side,
          nets: set,
        });
        // ALSO expose each wired bit as an ordinary port at the stub tip. A bit
        // routed to a single pin/terminal (an LED, an ungrouped input, a brick
        // terminal — anything that is NOT another bus port) would otherwise be
        // dropped: its net never reached netPorts, so no connecting edge drew.
        // When the whole bus bundles with a matching bus port those nets get
        // `consumed` and the ordinary pass skips them (no double draw); a
        // leftover bit routes a normal 2-port trunk instead.
        for (const nid of set) {
          if (!netPorts.has(nid)) netPorts.set(nid, []);
          // Tagged so a bus-bundle edge below can consume ITS OWN two stub
          // entries without hiding any OTHER (non-bus) port left on this net.
          netPorts.get(nid).push({
            nodeId: node.id,
            ...tip,
            side: port.side,
            fromBus: true,
          });
        }
      } else {
        // A single pin (chip/discrete) or a brick terminal → its one net.
        const nid =
          port.terminal != null
            ? netOfPoint.get(formatAddress(node.id, port.terminal))
            : pinNet.get(`${node.id}#${port.pins[0]}`);
        if (!nid) continue; // a floating pin/terminal joins no net
        node.portNets[port.key] = [nid];
        if (!netPorts.has(nid)) netPorts.set(nid, []);
        netPorts.get(nid).push({ nodeId: node.id, ...tip, side: port.side });
      }
    }
  }

  // Power nets never route — they drop a rail symbol at each of their pins.
  const powerStubs = [];
  for (const [netId, ports] of netPorts) {
    const polarity = polarityOf.get(netId);
    if (!polarity) continue;
    for (const p of ports) {
      powerStubs.push({ x: p.x, y: p.y, side: p.side, polarity });
    }
  }

  // External signals (Feature 370): a signal is not a component, so it can
  // never be a layout NODE — this walks doc.components through symbolFor. The
  // right precedent is the power stub: a glyph dropped AT a port rather than
  // routed. One stub per planted signal, at the FIRST port of its net in
  // sorted order (deterministic — this module carries no randomness), so the
  // schematic says "this net is driven by RESET" in the signal's own colour.
  // A signal on a net with no symbol port draws nothing, which is honest:
  // there is nothing there to stimulate.
  const signalStubs = [];
  for (const sig of doc.signals ?? []) {
    if (!sig?.flag?.anchor) continue;
    const nid = netOfPoint.get(sig.flag.anchor);
    if (!nid) continue;
    const ports = netPorts.get(nid);
    if (!ports?.length) continue;
    const port = [...ports].sort(
      (a, b) =>
      a.nodeId === b.nodeId ? a.side.localeCompare(b.side) : a.nodeId.localeCompare(b.nodeId), // prettier-ignore
    )[0];
    signalStubs.push({
      x: port.x,
      y: port.y,
      side: port.side,
      name: sig.name || sig.id,
      color: sig.color,
      netId: nid,
    });
  }

  // Nets that will draw a real trunk between ≥2 ports — a bus port must NOT also
  // drop a dangling stub for a bit that already routes to a real counterpart.
  const routedNets = new Set();
  for (const [netId, ports] of netPorts) {
    if (!polarityOf.has(netId) && ports.length >= 2) routedNets.add(netId);
  }

  const edges = [];
  const consumed = new Set(); // net ids drawn as a fat bus bundle

  // Bus bundles: two bus stubs that share nets → ONE fat line (the whole bus).
  for (let i = 0; i < busPorts.length; i++) {
    for (let j = i + 1; j < busPorts.length; j++) {
      const a = busPorts[i];
      const b = busPorts[j];
      const shared = [...a.nets].filter((n) => b.nets.has(n)).sort();
      if (!shared.length) continue;
      for (const n of shared) consumed.add(n);
      edges.push({
        bus: true,
        name: a.name,
        netIds: shared,
        segments: routeTrunk([
          { x: a.tip.x, y: a.tip.y, side: a.side },
          { x: b.tip.x, y: b.tip.y, side: b.side },
        ]),
        label: busLabel(a, b),
      });
    }
  }
  // A bus stub tapping a marching run (no other chip) → a short labelled fat
  // stub so its width and name still read.
  for (const bp of busPorts) {
    const live = [...bp.nets].some(
      (n) => !consumed.has(n) && !routedNets.has(n),
    );
    if (!live || bp.nets.size === 0) continue;
    if (edges.some((e) => e.bus && e.netIds.some((n) => bp.nets.has(n))))
      continue;
    const dir = exitDir(bp.side);
    const end = { x: bp.tip.x + dir.dx * 2.4, y: bp.tip.y + dir.dy * 2.4 };
    edges.push({
      bus: true,
      dangling: true,
      name: bp.name,
      netIds: [...bp.nets].sort(),
      segments: [[bp.tip, end]],
      label: {
        x: end.x + dir.dx * 0.6,
        y: end.y + dir.dy * 0.6,
        text: bp.name,
        anchor: dir.dx < 0 ? "end" : "start",
      },
    });
  }

  // Ordinary signal nets: an orthogonal trunk between the pins on the net; a
  // named net also drops its name at the trunk.
  for (const [netId, ports] of [...netPorts].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    if (polarityOf.has(netId)) continue;
    const name = names.get(netId) ?? null;
    // A net a bus bundle already consumed still needs any OTHER (non-bus)
    // port routed — e.g. an LED tapped onto one line of a data bus must not
    // silently vanish just because the bus itself drew a fat trunk for it.
    const relevantPorts = consumed.has(netId)
      ? ports.filter((p) => !p.fromBus)
      : ports;
    if (relevantPorts.length === 0) continue;
    if (relevantPorts.length >= 2) {
      const segments = routeTrunk(relevantPorts);
      edges.push({
        bus: false,
        net: netId,
        netIds: [netId],
        name,
        segments,
        label: name ? trunkLabel(segments) : null,
      });
    } else if (relevantPorts.length === 1 && (name || consumed.has(netId))) {
      // A single pin on a NAMED net — or the sole non-bus tap left on a
      // consumed bus net — gets a short lead (labelled when a name exists).
      const p = relevantPorts[0];
      const dir = exitDir(p.side);
      const end = { x: p.x + dir.dx * 2.4, y: p.y + dir.dy * 2.4 };
      edges.push({
        bus: false,
        net: netId,
        netIds: [netId],
        name,
        segments: [[{ x: p.x, y: p.y }, end]],
        label: name
          ? {
              x: end.x + dir.dx * 0.6,
              y: end.y + dir.dy * 0.4,
              text: name,
              anchor: dir.dx < 0 ? "end" : "start",
            }
          : null,
      });
    }
  }

  const bounds = computeBounds(nodes, edges, [...powerStubs, ...signalStubs]);
  return { nodes, edges, powerStubs, signalStubs, bounds };
}

/** The outward unit direction a stub on a given side exits toward. */
function exitDir(side) {
  if (side === "left") return { dx: -1, dy: 0 };
  if (side === "right") return { dx: 1, dy: 0 };
  if (side === "top") return { dx: 0, dy: -1 };
  return { dx: 0, dy: 1 };
}

/**
 * Route a net over its ports as an orthogonal "comb": each port leads out to a
 * shared vertical trunk, and the trunk spans their vertical extent. Returns a
 * list of polyline segments (each an array of {x,y}).
 */
function routeTrunk(ports) {
  const LEAD = 1.4;
  const leads = ports.map((p) => {
    const dir = exitDir(p.side);
    return { p, lead: { x: p.x + dir.dx * LEAD, y: p.y + dir.dy * LEAD } };
  });
  const trunkX = leads.reduce((s, l) => s + l.lead.x, 0) / leads.length;
  const ys = leads.map((l) => l.p.y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const segments = [];
  for (const { p, lead } of leads) {
    segments.push([{ x: p.x, y: p.y }, lead, { x: trunkX, y: p.y }]);
  }
  if (maxY - minY > 1e-6) {
    segments.push([
      { x: trunkX, y: minY },
      { x: trunkX, y: maxY },
    ]);
  }
  return segments;
}

/** Where to drop a net-name label on a trunk route (mid of the trunk). */
function trunkLabel(segments) {
  const trunk = segments[segments.length - 1];
  const a = trunk[0];
  const b = trunk[trunk.length - 1];
  return { x: a.x + 0.5, y: (a.y + b.y) / 2, text: null, anchor: "start" };
}

/** Bus-bundle label placed at the midpoint of the two stub tips. */
function busLabel(a, b) {
  return {
    x: (a.tip.x + b.tip.x) / 2,
    y: (a.tip.y + b.tip.y) / 2 - 0.6,
    text: a.name,
    anchor: "middle",
  };
}

function computeBounds(nodes, edges, powerStubs) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const n of nodes) {
    grow(n.x - STUB, n.y - STUB);
    grow(n.x + n.geometry.width + STUB, n.y + n.geometry.height + STUB);
  }
  for (const e of edges) {
    for (const seg of e.segments) for (const p of seg) grow(p.x, p.y);
  }
  for (const s of powerStubs) grow(s.x, s.y);
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

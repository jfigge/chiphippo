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

// schematic-view.js — the derived LOGICAL view (Feature 150): the same
// DeskDoc, drawn as chip symbols + routed named nets + fat bus lines rather
// than a physical breadboard. It is a PROJECTION — the desk stays the single
// source of truth; only per-symbol position nudges are stored (schematicPos).
//
// The surface reuses the desk camera (DeskView) so pan/zoom/grid behave
// identically and stay transform-only. The picture rebuilds only on a document
// change (a fresh `layout()`), never on a camera move. Live simulation tint and
// the shared probe highlight are applied IN PLACE from `chiphippo:sim-state` /
// `chiphippo:net-probed` by flipping `data-level` / a highlight class on the
// already-drawn elements — the schematic never queries the engine.
//
// DOM building lives in the pure exported functions (jsdom-testable); the class
// wires them to the document, the camera, and symbol-drag.

import { el } from "../dom.js";
import { PX_PER_UNIT, clampZoom } from "../desk/desk-geometry.js";
import { layout } from "../model/schematic-layout.js";
import { DeskView } from "./desk-view.js";
import { NetlistCache } from "./netlist-cache.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

function svgText(text, x, y, cls, size, anchor = "middle") {
  const t = svgEl("text", {
    class: cls,
    x,
    y,
    "font-size": size,
    "text-anchor": anchor,
    "dominant-baseline": "middle",
  });
  t.textContent = text;
  return t;
}

const PAD = 4; // world-unit margin around the diagram bounds

// ── Distinctive-shape gate glyphs (a FIXED vocabulary, never per-chip) ────────

/** A small distinctive-shape badge, centred at the TOP of the box (above the
    pin rows) so it never collides with a pin or the part-number label. */
function buildGlyph(name, geometry) {
  const s = 1.5;
  const g = svgEl("g", {
    class: "schematic-glyph",
    transform: `translate(${geometry.width / 2 - s * 0.6} 0.5) scale(${s})`,
  });
  const inverting = name === "NAND" || name === "NOR" || name === "NOT";
  const base =
    name === "NAND"
      ? "AND"
      : name === "NOR"
        ? "OR"
        : name === "NOT"
          ? "BUFFER"
          : name;
  let bodyD;
  if (base === "AND") {
    bodyD = "M0,0 L0.45,0 A0.5,0.5 0 0 1 0.45,1 L0,1 Z";
  } else if (base === "OR" || base === "XOR") {
    bodyD = "M0.02,0 Q0.5,0.12 0.95,0.5 Q0.5,0.88 0.02,1 Q0.34,0.5 0.02,0 Z";
  } else {
    bodyD = "M0,0 L0.9,0.5 L0,1 Z"; // BUFFER triangle
  }
  g.append(svgEl("path", { class: "schematic-glyph-shape", d: bodyD }));
  if (base === "XOR") {
    g.append(
      svgEl("path", {
        class: "schematic-glyph-line",
        d: "M-0.14,0 Q0.18,0.5 -0.14,1",
      }),
    );
  }
  if (inverting) {
    g.append(
      svgEl("circle", {
        class: "schematic-glyph-shape",
        cx: (base === "BUFFER" ? 0.9 : 0.98) + 0.09,
        cy: 0.5,
        r: 0.09,
      }),
    );
  }
  return g;
}

// ── Power / ground rail symbols ───────────────────────────────────────────────

/** A VCC bar / GND ladder at a pin tip, oriented outward along its side. */
function buildPowerSymbol({ x, y, side, polarity }) {
  const dir =
    side === "left"
      ? { x: -1, y: 0 }
      : side === "right"
        ? { x: 1, y: 0 }
        : side === "top"
          ? { x: 0, y: -1 }
          : { x: 0, y: 1 };
  const perp = { x: -dir.y, y: dir.x };
  const g = svgEl("g", {
    class: `schematic-power schematic-power--${polarity}`,
  });
  const stemEnd = { x: x + dir.x * 0.9, y: y + dir.y * 0.9 };
  g.append(
    svgEl("line", {
      class: "schematic-power-stem",
      x1: x,
      y1: y,
      x2: stemEnd.x,
      y2: stemEnd.y,
    }),
  );
  const bar = (at, half) =>
    svgEl("line", {
      class: "schematic-power-bar",
      x1: at.x - perp.x * half,
      y1: at.y - perp.y * half,
      x2: at.x + perp.x * half,
      y2: at.y + perp.y * half,
    });
  if (polarity === "VCC") {
    g.append(bar(stemEnd, 0.8)); // one wide bar
  } else {
    // Ground: three shrinking rungs.
    [0.8, 0.5, 0.24].forEach((half, i) => {
      const at = {
        x: stemEnd.x + dir.x * i * 0.3,
        y: stemEnd.y + dir.y * i * 0.3,
      };
      g.append(bar(at, half));
    });
  }
  g.append(
    svgText(
      polarity,
      x + dir.x * 2.1,
      y + dir.y * 2.1,
      "schematic-power-label",
      0.85,
    ),
  );
  return g;
}

// ── The whole diagram ─────────────────────────────────────────────────────────

/** Build one polyline per routed segment of an edge. */
function buildEdge(edge) {
  const cls =
    "schematic-edge" +
    (edge.bus ? " schematic-edge--bus" : "") +
    (edge.dangling ? " schematic-edge--dangling" : "");
  const g = svgEl("g", {
    class: cls,
    "data-nets": (edge.netIds ?? []).join(" "),
  });
  for (const seg of edge.segments) {
    g.append(
      svgEl("polyline", {
        class: "schematic-wire",
        points: seg.map((p) => `${p.x},${p.y}`).join(" "),
      }),
    );
  }
  const text = edge.label?.text ?? edge.name;
  if (edge.label && text) {
    g.append(
      svgText(
        text,
        edge.label.x,
        edge.label.y,
        "schematic-net-label",
        edge.bus ? 1.1 : 0.95,
        edge.label.anchor ?? "start",
      ),
    );
  }
  return g;
}

// ── Distinctive-shape parts (LED / resistor / switch / button / PSU / clock) ──

/** Human ohms, e.g. 10000 → "10k", 220 → "220". */
function formatOhms(n) {
  if (!Number.isFinite(n)) return "";
  return n >= 1000 ? `${n / 1000}k` : `${n}`;
}

/** The small value text for a shape symbol (volts / ohms / Hz), or "". */
function shapeText(shape, params) {
  if (shape === "resistor") return formatOhms(Number(params?.ohms));
  if (shape === "psu") return `${params?.volts ?? 5}V`;
  if (shape === "clock") {
    return params?.hz === "manual" ? "man" : `${params?.hz ?? 1}Hz`;
  }
  return "";
}

/** Draw the distinctive body of a shape symbol into `g` (local coords). */
function buildShapeBody(g, shape, geo, node) {
  const w = geo.width;
  const h = geo.height;
  const cx = w / 2;
  const cy = h / 2;
  const line = (x1, y1, x2, y2, cls = "schematic-shape-line") =>
    svgEl("line", { class: cls, x1, y1, x2, y2 });

  if (shape === "led") {
    // Diode triangle (anode top → cathode bottom) + cathode bar, filled in the
    // LED's colour; two little emission arrows.
    const bw = w * 0.34;
    const top = h * 0.28;
    const apex = h * 0.6;
    const body = svgEl("path", {
      class: "schematic-led-body",
      d: `M ${cx - bw} ${top} L ${cx + bw} ${top} L ${cx} ${apex} Z`,
    });
    const color = node.params?.color ?? "red";
    body.style.setProperty("--led-color", `var(--color-wire-${color})`);
    g.append(body, line(cx - bw, apex, cx + bw, apex, "schematic-led-bar"));
    for (const dx of [0.3, 0.9]) {
      g.append(
        line(
          cx + bw * dx,
          top - 0.1,
          cx + bw * dx + 0.6,
          top - 0.8,
          "schematic-led-ray",
        ),
      );
    }
  } else if (shape === "resistor") {
    // Zigzag body between the two leads.
    const mid = cy;
    const a = h * 0.3;
    const x0 = w * 0.22;
    const x1 = w * 0.78;
    const step = (x1 - x0) / 6;
    let d = `M 0 ${mid} L ${x0} ${mid}`;
    for (let i = 0; i < 6; i++) {
      const yy = i % 2 === 0 ? mid - a : mid + a;
      d += ` L ${x0 + step * (i + 0.5)} ${yy}`;
    }
    d += ` L ${x1} ${mid} L ${w} ${mid}`;
    g.append(svgEl("path", { class: "schematic-shape-line", d }));
  } else if (shape === "switch") {
    // SPDT: a common pivot throwing a lever toward contact 1 (the upper pin).
    const pivot = { x: w * 0.32, y: cy };
    g.append(line(0, cy, pivot.x, pivot.y));
    g.append(line(pivot.x, pivot.y, w * 0.82, cy - 1));
    for (const dy of [-1, 1]) {
      g.append(
        svgEl("circle", {
          class: "schematic-shape-dot",
          cx: w * 0.85,
          cy: cy + dy,
          r: 0.28,
        }),
      );
    }
    g.append(
      svgEl("circle", {
        class: "schematic-shape-dot",
        cx: pivot.x,
        cy: pivot.y,
        r: 0.28,
      }),
    );
  } else if (shape === "button") {
    // Momentary: two contacts with a gap, a plunger bar above.
    g.append(line(0, cy, w * 0.36, cy), line(w * 0.64, cy, w, cy));
    for (const x of [w * 0.36, w * 0.64]) {
      g.append(
        svgEl("circle", { class: "schematic-shape-dot", cx: x, cy, r: 0.26 }),
      );
    }
    g.append(line(cx, cy, cx, h * 0.22));
    g.append(line(w * 0.32, h * 0.22, w * 0.68, h * 0.22));
  } else if (shape === "psu" || shape === "clock") {
    // A source: circle (PSU) or square-wave box (clock).
    if (shape === "psu") {
      g.append(
        svgEl("circle", {
          class: "schematic-shape-body",
          cx,
          cy,
          r: Math.min(w, h) * 0.34,
        }),
      );
    } else {
      g.append(
        svgEl("rect", {
          class: "schematic-shape-body",
          x: w * 0.15,
          y: h * 0.15,
          width: w * 0.7,
          height: h * 0.5,
          rx: 0.3,
        }),
      );
      const y0 = h * 0.28;
      const y1 = h * 0.52;
      g.append(
        svgEl("path", {
          class: "schematic-shape-line",
          d: `M ${w * 0.24} ${y1} V ${y0} H ${w * 0.44} V ${y1} H ${w * 0.62} V ${y0} H ${w * 0.78}`,
        }),
      );
    }
    g.append(
      svgText(node.symbol.label, cx, cy, "schematic-shape-label", 1),
      svgText(
        shapeText(shape, node.params),
        cx,
        h * 0.86,
        "schematic-shape-value",
        0.85,
      ),
    );
  }
  // Resistor value sits below its zigzag; LED needs no text.
  if (shape === "resistor") {
    g.append(
      svgText(
        shapeText(shape, node.params),
        cx,
        h * 0.9,
        "schematic-shape-value",
        0.8,
      ),
    );
  }
}

/** Build one symbol node: its body (box or distinctive shape) + labelled stubs. */
function buildNode(node) {
  const geo = node.geometry;
  const shape = node.symbol.kind === "shape" ? node.symbol.shape : null;
  const g = svgEl("g", {
    class: `schematic-node${shape ? ` schematic-shape--${shape}` : ""}`,
    "data-id": node.id,
    "data-ref": node.ref,
    transform: `translate(${node.x} ${node.y})`,
  });

  if (shape) {
    buildShapeBody(g, shape, geo, node);
    if (shape === "led") {
      // Carry the anode/cathode nets so the sim can light the LED (anode H,
      // cathode L) exactly as the breadboard does.
      const a = node.portNets?.["pin:1"]?.[0];
      const k = node.portNets?.["pin:2"]?.[0];
      if (a) g.setAttribute("data-anode", a);
      if (k) g.setAttribute("data-cathode", k);
    }
  } else {
    g.append(
      svgEl("rect", {
        class: "schematic-box",
        x: 0,
        y: 0,
        width: geo.width,
        height: geo.height,
        rx: 0.4,
      }),
    );
    if (node.symbol.glyph) g.append(buildGlyph(node.symbol.glyph, geo));
    if (node.symbol.label) {
      g.append(
        svgText(
          node.symbol.label,
          geo.width / 2,
          geo.height / 2,
          "schematic-label",
          1.3,
        ),
      );
    }
  }

  for (const port of geo.ports) {
    const nets = (node.portNets?.[port.key] ?? []).join(" ");
    g.append(
      svgEl("line", {
        class: "schematic-stub",
        "data-nets": nets,
        x1: port.ex,
        y1: port.ey,
        x2: port.tx,
        y2: port.ty,
      }),
    );
    if (shape) {
      // A shape terminal is labelled just inside its edge (small).
      const lx =
        port.ex +
        (port.side === "left" ? 0.4 : port.side === "right" ? -0.4 : 0);
      const ly =
        port.ey +
        (port.side === "top" ? 0.7 : port.side === "bottom" ? -0.7 : 0);
      const anchor =
        port.side === "left"
          ? "start"
          : port.side === "right"
            ? "end"
            : "middle";
      g.append(
        svgText(port.name, lx, ly, "schematic-terminal-label", 0.7, anchor),
      );
      continue;
    }
    // A box pin is labelled inside on its side; power pins (top/bottom) rely on
    // their VCC/GND rail symbol instead.
    if (port.side === "top" || port.side === "bottom") continue;
    const lx = port.ex + (port.side === "left" ? 0.5 : -0.5);
    const anchor = port.side === "left" ? "start" : "end";
    g.append(
      svgText(port.name, lx, port.ey, "schematic-pin-label", 0.85, anchor),
    );
  }
  return g;
}

/**
 * Build the complete schematic SVG for a `layout()` result. Positioned in world
 * px (a child of the camera-transformed surface) with an inner viewBox in pitch
 * units so drawing coordinates are the layout's own. Pure DOM.
 */
export function buildSchematicSvg(result) {
  const b = result.bounds;
  const x0 = b.minX - PAD;
  const y0 = b.minY - PAD;
  const w = Math.max(1, b.maxX - b.minX + 2 * PAD);
  const h = Math.max(1, b.maxY - b.minY + 2 * PAD);
  const svg = svgEl("svg", {
    class: "schematic-svg",
    viewBox: `${x0} ${y0} ${w} ${h}`,
    width: w * PX_PER_UNIT,
    height: h * PX_PER_UNIT,
    style: `left:${x0 * PX_PER_UNIT}px; top:${y0 * PX_PER_UNIT}px;`,
  });

  const gEdges = svgEl("g", { class: "schematic-edges" });
  const gPower = svgEl("g", { class: "schematic-powers" });
  const gNodes = svgEl("g", { class: "schematic-nodes" });
  for (const edge of result.edges) gEdges.append(buildEdge(edge));
  for (const stub of result.powerStubs) gPower.append(buildPowerSymbol(stub));
  for (const node of result.nodes) gNodes.append(buildNode(node));
  svg.append(gEdges, gPower, gNodes);
  return svg;
}

/** The combined level of a net-id list (all-equal → that level; mixed → X). */
function combinedLevel(netIds, levels) {
  const seen = new Set(netIds.map((id) => levels.get(id) ?? "Z"));
  return seen.size === 1 ? [...seen][0] : "X";
}

/** Tint every edge/stub by its net level while running (cleared otherwise),
    and light each LED (anode HIGH + cathode LOW) exactly as the breadboard. */
export function applyLevels(svg, levels = new Map(), running = false) {
  for (const node of svg.querySelectorAll("[data-nets]")) {
    const ids = node.getAttribute("data-nets").split(" ").filter(Boolean);
    if (running && ids.length) node.dataset.level = combinedLevel(ids, levels);
    else delete node.dataset.level;
  }
  for (const led of svg.querySelectorAll(".schematic-shape--led")) {
    const lit =
      running &&
      levels.get(led.getAttribute("data-anode")) === "H" &&
      levels.get(led.getAttribute("data-cathode")) === "L";
    led.classList.toggle("schematic-lit", lit);
  }
}

/** Reflect each chip's health as a status class on its symbol node. */
export function applyStatus(svg, chipStatus = new Map(), running = false) {
  const STATUSES = ["unpowered", "underpowered", "reversed", "damaged"];
  for (const node of svg.querySelectorAll(".schematic-node")) {
    const status = running ? chipStatus.get(node.dataset.id)?.status : null;
    for (const s of STATUSES) {
      node.classList.toggle(`schematic-node--${s}`, status === s);
    }
  }
}

/** Highlight (or clear) every element carrying `netId`, matching the probe. */
export function applyHighlight(svg, netId) {
  for (const node of svg.querySelectorAll("[data-nets]")) {
    const on =
      Boolean(netId) &&
      node.getAttribute("data-nets").split(" ").includes(netId);
    node.classList.toggle("schematic--highlight", on);
  }
}

export class SchematicView {
  #viewport;
  #deskView;
  #doc;
  #netlist;
  #onSetSchematicPos;
  #onAutoLayout;

  #svg = null;
  #result = null;
  #hint; // "add chips" overlay

  #levels = new Map();
  #chipStatus = new Map();
  #running = false;
  #highlightNet = null;

  #dragHint = null; // { id, x, y } — live, uncommitted
  #drag = null;
  #fitted = false;

  #onDocChanged;
  #onSimState;
  #onProbed;

  /**
   * @param {HTMLElement} viewport - the `.schematic-viewport` element to own.
   * @param {object} opts
   * @param {import('../model/desk-doc.js').DeskDoc} opts.doc
   * @param {(id:string,x:number,y:number)=>void} opts.onSetSchematicPos
   * @param {()=>void} [opts.onAutoLayout] - clear every position nudge.
   * @param {object} [opts.netlist] - injectable NetlistCache (tests).
   */
  constructor(
    viewport,
    { doc, onSetSchematicPos, onAutoLayout, netlist } = {},
  ) {
    this.#viewport = viewport;
    this.#doc = doc;
    this.#onSetSchematicPos = onSetSchematicPos;
    this.#onAutoLayout = onAutoLayout;
    this.#netlist = netlist ?? new NetlistCache(doc);

    this.#deskView = new DeskView(viewport, {
      camera: { cx: 0, cy: 0, zoom: 0.9 },
    });
    this.#deskView.surface.classList.add("schematic-surface");

    this.#hint = el("p", {
      class: "schematic-hint",
      text: "Add chips to the desk to see the schematic",
      hidden: true,
    });
    viewport.append(this.#hint);
    if (onAutoLayout) {
      viewport.append(
        el("div", { class: "schematic-tools" }, [
          el("button", {
            class: "schematic-tool-btn",
            type: "button",
            text: "Auto-layout",
            onClick: () => this.#onAutoLayout?.(),
          }),
        ]),
      );
    }

    this.#onDocChanged = () => this.#render();
    window.addEventListener("chiphippo:doc-changed", this.#onDocChanged);
    this.#onSimState = (e) => this.#applySim(e.detail);
    window.addEventListener("chiphippo:sim-state", this.#onSimState);
    this.#onProbed = (e) => this.#applyProbe(e.detail);
    window.addEventListener("chiphippo:net-probed", this.#onProbed);

    this.#deskView.surface.addEventListener("pointerdown", this.#onPointerDown);
    this.#render();
  }

  /** Show or hide the schematic; fit the diagram the first time it is shown. */
  setVisible(on) {
    this.#viewport.hidden = !on;
    if (on && !this.#fitted && this.#result?.nodes.length) {
      this.fit();
      this.#fitted = true;
    }
  }

  zoomIn() {
    this.#deskView.zoomIn();
  }

  zoomOut() {
    this.#deskView.zoomOut();
  }

  resetZoom() {
    this.#deskView.resetZoom();
  }

  zoomOutFull() {
    this.#deskView.zoomOutFull();
  }

  /** Centre + scale the camera to frame the whole diagram. */
  fit() {
    const b = this.#result?.bounds;
    if (!b) return;
    const rect = this.#viewport.getBoundingClientRect();
    const wPitch = b.maxX - b.minX + 2 * PAD;
    const hPitch = b.maxY - b.minY + 2 * PAD;
    let zoom = 0.9;
    if (rect.width && rect.height && wPitch && hPitch) {
      const zx = rect.width / (wPitch * PX_PER_UNIT);
      const zy = rect.height / (hPitch * PX_PER_UNIT);
      zoom = clampZoom(Math.min(zx, zy, 1.5));
    }
    this.#deskView.setCamera({
      cx: (b.minX + b.maxX) / 2,
      cy: (b.minY + b.maxY) / 2,
      zoom,
    });
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  #posHints() {
    const hints = {};
    for (const c of this.#doc.toJSON().components) {
      if (c.schematicPos) hints[c.id] = c.schematicPos;
    }
    if (this.#dragHint) {
      hints[this.#dragHint.id] = { x: this.#dragHint.x, y: this.#dragHint.y };
    }
    return hints;
  }

  #render() {
    this.#result = layout(
      this.#doc.toJSON(),
      this.#netlist.get(),
      this.#posHints(),
    );
    const svg = buildSchematicSvg(this.#result);
    if (this.#svg) this.#svg.replaceWith(svg);
    else this.#deskView.surface.append(svg);
    this.#svg = svg;
    this.#hint.hidden = this.#result.nodes.length > 0;

    // Re-apply the live overlays onto the freshly built DOM.
    applyLevels(svg, this.#levels, this.#running);
    applyStatus(svg, this.#chipStatus, this.#running);
    applyHighlight(svg, this.#highlightNet);
  }

  #applySim(detail) {
    this.#running = Boolean(detail?.running);
    this.#levels = detail?.netLevels ?? new Map();
    this.#chipStatus = detail?.chipStatus ?? new Map();
    if (!this.#svg) return;
    applyLevels(this.#svg, this.#levels, this.#running);
    applyStatus(this.#svg, this.#chipStatus, this.#running);
  }

  #applyProbe(detail) {
    this.#highlightNet = detail?.netId ?? null;
    if (this.#svg) applyHighlight(this.#svg, this.#highlightNet);
  }

  // ── Symbol drag (nudge → schematicPos) ───────────────────────────────────────

  #onPointerDown = (e) => {
    if (e.button !== 0 || this.#drag) return;
    const nodeEl = e.target.closest?.(".schematic-node");
    if (!nodeEl) return; // empty space → let DeskView pan
    const id = nodeEl.dataset.id;
    const node = this.#result?.nodes.find((n) => n.id === id);
    if (!node) return;
    e.stopPropagation(); // don't let the camera pan
    const world = this.#deskView.worldFromEvent(e);
    this.#drag = {
      id,
      pointerId: e.pointerId,
      offX: world.x - node.x,
      offY: world.y - node.y,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    // Capture on the STABLE viewport so #render() (which replaces the svg
    // mid-drag) never drops the gesture.
    try {
      this.#viewport.setPointerCapture(e.pointerId);
    } catch {
      /* best-effort */
    }
    this.#viewport.addEventListener("pointermove", this.#onPointerMove);
    this.#viewport.addEventListener("pointerup", this.#onPointerUp);
    this.#viewport.addEventListener("pointercancel", this.#onPointerUp);
  };

  #onPointerMove = (e) => {
    const d = this.#drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
      d.moved = true;
    }
    const world = this.#deskView.worldFromEvent(e);
    this.#dragHint = { id: d.id, x: world.x - d.offX, y: world.y - d.offY };
    this.#render(); // live reflow of the dragged symbol's edges only
  };

  #onPointerUp = (e) => {
    const d = this.#drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.#viewport.removeEventListener("pointermove", this.#onPointerMove);
    this.#viewport.removeEventListener("pointerup", this.#onPointerUp);
    this.#viewport.removeEventListener("pointercancel", this.#onPointerUp);
    try {
      this.#viewport.releasePointerCapture(d.pointerId);
    } catch {
      /* already released */
    }
    const hint = this.#dragHint;
    this.#drag = null;
    this.#dragHint = null;
    if (d.moved && hint) {
      // Commit → doc-changed → a clean re-render from the stored nudge.
      this.#onSetSchematicPos?.(hint.id, hint.x, hint.y);
    } else {
      this.#render();
    }
  };

  dispose() {
    window.removeEventListener("chiphippo:doc-changed", this.#onDocChanged);
    window.removeEventListener("chiphippo:sim-state", this.#onSimState);
    window.removeEventListener("chiphippo:net-probed", this.#onProbed);
    this.#deskView.surface.removeEventListener(
      "pointerdown",
      this.#onPointerDown,
    );
    this.#deskView.dispose();
  }
}

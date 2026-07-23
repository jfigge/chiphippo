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

// scope-view.js — the logic-analyzer's dockable waveform panel (Feature 210). A
// bottom-docked aside that RECORDS the `chiphippo:sim-state` stream into a pure
// ScopeRecorder (one column per tick) and RENDERS a scrolling timing diagram:
// a gutter of channels, one lane each (bit waveform for a net, hex value-lane
// for a bus), a shared tick grid, and two click-placed cursors with a Δ
// readout. It never drives or stalls the sim — it only reads the broadcast the
// live views already consume, so the analyzer adds nothing to the settle loop.
//
// Channel resolution and bus decode are the pure helpers in
// model/scope-recorder.js; channels persist in the document (doc.scopeChannels)
// so a saved design keeps its instrument setup. All channel mutations route
// through the DeskController callbacks so they ride the one undo/redo seam.

import { clear, el } from "../dom.js";
import { parseBusName } from "../model/desk-doc.js";
import { ScopeRecorder, decodeBus, readNet } from "../model/scope-recorder.js";
import { PopupManager } from "../popup-manager.js";

const SVGNS = "http://www.w3.org/2000/svg";

/** Lane geometry, in CSS px. */
const LANE_H = 46; // one channel row
const WAVE_PAD = 10; // top/bottom inset within a lane
const PX_PER_TICK = 10; // one tick column's width

/** Distinct lane colors, cycled by position when a channel has no own color. */
const CHANNEL_COLORS = [
  "var(--color-wire-blue)",
  "var(--color-wire-green)",
  "var(--color-wire-orange)",
  "var(--color-wire-purple)",
  "var(--color-wire-yellow)",
  "var(--color-net-glow)",
  "var(--color-wire-red)",
  "var(--color-wire-white)",
];

/** Build a namespaced SVG element (dom.js `el` only makes HTML elements). */
function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else node.setAttribute(k, String(v));
  }
  for (const c of (Array.isArray(children) ? children : [children]).flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export class ScopeView {
  #doc;
  #netlist;
  #onVisibilityChange;
  #onAddChannel;
  #onRemoveChannel;
  #onMoveChannel;
  #tickMs;

  #el;
  #body;
  #gutter;
  #lanes; // the horizontally-scrolling lanes viewport
  #svg;
  #empty;
  #delta; // the cursor Δ readout in the header

  #recorder = new ScopeRecorder();
  #lastMode = "stopped";
  #lastDetail = null; // most recent sim-state detail (for resolution + Run reset)
  #cursorA = null; // tick index or null
  #cursorB = null;
  #dragging = null; // "a" | "b" while dragging a cursor
  #follow = true; // keep scrolled to the live right edge
  #renderScheduled = false;

  /**
   * @param {HTMLElement} container - the app shell (#app, a flex column); the
   *   panel docks along its bottom edge.
   * @param {object} opts
   * @param {import('../model/desk-doc.js').DeskDoc} opts.deskDoc
   * @param {import('./netlist-cache.js').NetlistCache} opts.netlist
   * @param {(visible:boolean)=>void} [opts.onVisibilityChange]
   * @param {(kind:string, ref:string)=>void} opts.onAddChannel
   * @param {(id:string)=>void} opts.onRemoveChannel
   * @param {(id:string, index:number)=>void} opts.onMoveChannel
   * @param {()=>number|null} [opts.tickMs] - ms per tick for the Δ readout.
   */
  constructor(
    container,
    {
      deskDoc,
      netlist,
      onVisibilityChange,
      onAddChannel,
      onRemoveChannel,
      onMoveChannel,
      tickMs,
    },
  ) {
    this.#doc = deskDoc;
    this.#netlist = netlist;
    this.#onVisibilityChange = onVisibilityChange;
    this.#onAddChannel = onAddChannel;
    this.#onRemoveChannel = onRemoveChannel;
    this.#onMoveChannel = onMoveChannel;
    this.#tickMs = tickMs ?? (() => null);

    this.#buildDom();
    container.append(this.#el);

    window.addEventListener("chiphippo:sim-state", (e) =>
      this.#onSim(e.detail),
    );
    // The channel list / bus definitions may have changed — repaint the gutter.
    window.addEventListener("chiphippo:doc-changed", () => {
      if (this.visible) this.#scheduleRender();
    });
  }

  // ── DOM ────────────────────────────────────────────────────────────────────

  #buildDom() {
    this.#delta = el("span", { class: "scope-delta", text: "" });

    const addBtn = el("button", {
      class: "scope-btn",
      type: "button",
      text: "+ Channel",
      title: "Add a named net or bus as a channel",
      onClick: (e) => this.#openAddMenu(e),
    });
    const clearBtn = el("button", {
      class: "scope-btn",
      type: "button",
      text: "Clear",
      title: "Clear the recorded trace",
      onClick: () => this.#clearTrace(),
    });
    const svgBtn = el("button", {
      class: "scope-btn",
      type: "button",
      text: "SVG",
      title: "Export the timing diagram as SVG",
      onClick: () => this.#export(false),
    });
    const pngBtn = el("button", {
      class: "scope-btn",
      type: "button",
      text: "PNG",
      title: "Export the timing diagram as PNG",
      onClick: () => this.#export(true),
    });

    const header = el("div", { class: "scope-header" }, [
      el("span", { class: "scope-title", text: "Logic analyzer" }),
      el("div", { class: "scope-tools" }, [
        addBtn,
        clearBtn,
        el("span", { class: "scope-sep" }),
        svgBtn,
        pngBtn,
        this.#delta,
      ]),
      el("button", {
        class: "scope-close",
        type: "button",
        title: "Close the logic analyzer",
        "aria-label": "Close the logic analyzer",
        text: "×",
        onClick: () => this.setVisible(false),
      }),
    ]);

    this.#gutter = el("div", { class: "scope-gutter" });
    this.#svg = svg("svg", { class: "scope-svg" });
    this.#lanes = el("div", { class: "scope-lanes" }, [this.#svg]);
    this.#lanes.addEventListener("scroll", () => this.#onScroll());
    this.#svg.addEventListener("pointerdown", (e) => this.#onCursorDown(e));
    this.#svg.addEventListener("pointermove", (e) => this.#onCursorMove(e));
    this.#svg.addEventListener("pointerup", (e) => this.#onCursorUp(e));

    this.#empty = el("div", { class: "scope-empty" }, [
      "No channels yet — ",
      el("button", {
        class: "scope-link",
        type: "button",
        text: "add a net or bus",
        onClick: (e) => this.#openAddMenu(e),
      }),
      ", or right-click a probed net → “Add to analyzer”.",
    ]);

    this.#body = el("div", { class: "scope-body" }, [
      this.#gutter,
      this.#lanes,
    ]);
    this.#el = el(
      "aside",
      { class: "scope-panel", "aria-label": "Logic analyzer", hidden: true },
      [header, this.#body, this.#empty],
    );
  }

  get element() {
    return this.#el;
  }

  get visible() {
    return !this.#el.hidden;
  }

  setVisible(on) {
    const was = this.visible;
    this.#el.hidden = !on;
    if (on) this.#render();
    if (was !== on) this.#onVisibilityChange?.(on);
  }

  toggle() {
    this.setVisible(!this.visible);
  }

  // ── Public channel entry points (probe "Add to analyzer", picker) ───────────

  /** Track a net by a member address (deduped by the controller). */
  addNetChannel(address) {
    if (this.#doc.hasScopeChannel("net", address)) return;
    this.#onAddChannel?.("net", address);
  }

  /** Track a bus by its id. */
  addBusChannel(busId) {
    if (this.#doc.hasScopeChannel("bus", busId)) return;
    this.#onAddChannel?.("bus", busId);
  }

  // ── Recording (a pure fold over the sim-state broadcast) ────────────────────

  #onSim(detail) {
    const wasStopped = this.#lastMode === "stopped";
    this.#lastMode = detail.mode;
    this.#lastDetail = detail;
    if (detail.mode === "stopped") {
      // Keep the last run's trace on screen for inspection / export.
      if (this.visible) this.#scheduleRender();
      return;
    }
    if (wasStopped) {
      // A fresh Run — start a new trace.
      this.#recorder.reset();
      this.#cursorA = null;
      this.#cursorB = null;
      this.#follow = true;
    }
    this.#recorder.sample(this.#resolveCells(detail));
    if (this.visible) this.#scheduleRender();
  }

  /** Resolve every channel to its cell value from one broadcast. */
  #resolveCells(detail) {
    const cells = new Map();
    for (const ch of this.#doc.scopeChannels) {
      cells.set(ch.id, this.#readChannel(ch, detail));
    }
    return cells;
  }

  /** A channel's value this tick: a level string (net) or integer|null (bus). */
  #readChannel(ch, detail) {
    if (ch.kind === "bus") {
      const bus = this.#doc.getBus(ch.ref);
      if (!bus) return null;
      const parsed = parseBusName(bus.name);
      const bits = parsed?.bits ?? bus.members.map((_, i) => i);
      const levels = bus.members.map((wid) => {
        const wire = this.#doc.getWire(wid);
        return wire ? readNet(wire.from, detail) : null;
      });
      return decodeBus(levels, bits).value;
    }
    return readNet(ch.ref, detail);
  }

  #clearTrace() {
    this.#recorder.reset();
    this.#cursorA = null;
    this.#cursorB = null;
    this.#render();
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  #scheduleRender() {
    if (this.#renderScheduled) return;
    this.#renderScheduled = true;
    const run = () => {
      this.#renderScheduled = false;
      this.#render();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else run();
  }

  #render() {
    if (!this.visible) return;
    const channels = this.#doc.scopeChannels;
    this.#empty.hidden = channels.length > 0;
    this.#body.hidden = channels.length === 0;
    if (!channels.length) return;
    this.#renderGutter(channels);
    this.#renderLanes(channels);
    this.#renderDelta();
    if (this.#follow && this.#lastMode !== "stopped") {
      this.#lanes.scrollLeft = this.#lanes.scrollWidth;
    }
  }

  #renderGutter(channels) {
    clear(this.#gutter);
    channels.forEach((ch, i) => {
      const color = ch.color || CHANNEL_COLORS[i % CHANNEL_COLORS.length];
      const value = this.#formatCell(
        ch,
        this.#cursorA != null
          ? this.#recorder.cellAt(this.#cursorA, ch.id)
          : this.#recorder.cellAt(this.#recorder.lastTick, ch.id),
      );
      const row = el(
        "div",
        { class: "scope-chan", style: { height: `${LANE_H}px` } },
        [
          el("span", {
            class: "scope-chan-dot",
            style: { background: color },
            "aria-hidden": "true",
          }),
          el("span", { class: "scope-chan-name", text: this.#labelOf(ch) }),
          el("span", { class: "scope-chan-value", text: value }),
          el("span", { class: "scope-chan-ctl" }, [
            el("button", {
              class: "scope-mini",
              type: "button",
              text: "↑",
              title: "Move up",
              disabled: i === 0,
              onClick: () => this.#onMoveChannel?.(ch.id, i - 1),
            }),
            el("button", {
              class: "scope-mini",
              type: "button",
              text: "↓",
              title: "Move down",
              disabled: i === channels.length - 1,
              onClick: () => this.#onMoveChannel?.(ch.id, i + 1),
            }),
            el("button", {
              class: "scope-mini scope-mini--del",
              type: "button",
              text: "×",
              title: "Remove channel",
              onClick: () => this.#onRemoveChannel?.(ch.id),
            }),
          ]),
        ],
      );
      this.#gutter.append(row);
    });
  }

  #renderLanes(channels) {
    const width = Math.max(1, this.#recorder.size) * PX_PER_TICK;
    const height = Math.max(1, channels.length) * LANE_H;
    clear(this.#svg);
    this.#svg.setAttribute("width", String(width));
    this.#svg.setAttribute("height", String(height));
    this.#svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    for (const node of this.#buildLaneNodes(channels, { width, height })) {
      this.#svg.append(node);
    }
  }

  /**
   * Build every SVG child of the lanes surface. `colorOf` maps a token/color to
   * an applied color — identity for live (CSS resolves `var(--…)` in a style),
   * or a resolved hex for export. Reused by the export path.
   */
  #buildLaneNodes(channels, { width, height, colorOf = (c) => c } = {}) {
    const nodes = [];
    const conflict = colorOf("var(--color-sim-conflict)");
    const gridColor = colorOf("var(--color-overlay)");
    nodes.push(this.#hatchDefs(conflict));

    // Lane separators + a light row background for legibility.
    channels.forEach((_, i) => {
      const y = i * LANE_H;
      nodes.push(
        svg("line", {
          x1: 0,
          y1: y,
          x2: width,
          y2: y,
          style: { stroke: gridColor, strokeWidth: "0.5", opacity: "0.5" },
        }),
      );
    });

    const floatColor = colorOf("var(--color-sim-float)");
    channels.forEach((ch, i) => {
      const color = colorOf(
        ch.color || CHANNEL_COLORS[i % CHANNEL_COLORS.length],
      );
      const runs = this.#runsOf(ch);
      const laneNodes =
        ch.kind === "bus"
          ? this.#busLane(runs, i, { color, colorOf })
          : this.#netLane(runs, i, { color, floatColor });
      for (const n of laneNodes) nodes.push(n);
    });

    // Cursors on top.
    for (const [tick, cls] of [
      [this.#cursorA, "a"],
      [this.#cursorB, "b"],
    ]) {
      if (tick == null) continue;
      const x = this.#xOf(tick);
      if (x < 0) continue;
      const stroke = colorOf(
        cls === "a" ? "var(--color-sim-high)" : "var(--color-info)",
      );
      nodes.push(
        svg("line", {
          x1: x,
          y1: 0,
          x2: x,
          y2: height,
          style: { stroke, strokeWidth: "1", strokeDasharray: "3 2" },
        }),
      );
    }
    return nodes;
  }

  /** An amber diagonal hatch pattern for unknown (X / undriven) regions. */
  #hatchDefs(color) {
    const pattern = svg("pattern", {
      id: "scope-hatch",
      width: 6,
      height: 6,
      patternUnits: "userSpaceOnUse",
      patternTransform: "rotate(45)",
    });
    pattern.append(
      svg("line", {
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 6,
        style: { stroke: color, strokeWidth: "1.5", opacity: "0.7" },
      }),
    );
    return svg("defs", {}, [pattern]);
  }

  /** Run-length-encode a channel's cells across the retained columns. */
  #runsOf(ch) {
    const runs = [];
    for (const col of this.#recorder.columns()) {
      const key = col.cells.get(ch.id) ?? null;
      const last = runs[runs.length - 1];
      if (last && last.key === key) last.to = col.tick + 1;
      else runs.push({ key, from: col.tick, to: col.tick + 1 });
    }
    return runs;
  }

  #xOf(tick) {
    return (tick - this.#recorder.firstTick) * PX_PER_TICK;
  }

  /** A single net waveform: one step path + overlays for the Z / X regions. */
  #netLane(runs, laneIndex, { color, floatColor }) {
    const top = laneIndex * LANE_H;
    const highY = top + WAVE_PAD;
    const lowY = top + LANE_H - WAVE_PAD;
    const midY = top + LANE_H / 2;
    const yFor = (lv) => (lv === "H" ? highY : lv === "L" ? lowY : midY);

    const nodes = [];
    let d = "";
    runs.forEach((run, idx) => {
      const x0 = this.#xOf(run.from);
      const x1 = this.#xOf(run.to);
      const y = yFor(run.key);
      d += idx === 0 ? `M ${x0} ${y}` : ` L ${x0} ${y}`;
      d += ` L ${x1} ${y}`;
      if (run.key === "X" || run.key == null) {
        nodes.push(
          svg("rect", {
            x: x0,
            y: top + 2,
            width: Math.max(0, x1 - x0),
            height: LANE_H - 4,
            fill: "url(#scope-hatch)",
            stroke: "none",
          }),
        );
      } else if (run.key === "Z") {
        nodes.push(
          svg("line", {
            x1: x0,
            y1: midY,
            x2: x1,
            y2: midY,
            style: {
              stroke: floatColor,
              strokeWidth: "1.5",
              strokeDasharray: "2 3",
              opacity: "0.85",
            },
          }),
        );
      }
    });
    // The main step line last so it sits above the region fills.
    nodes.push(
      svg("path", {
        d: d || "M 0 0",
        fill: "none",
        style: { stroke: color, strokeWidth: "1.75" },
      }),
    );
    return nodes;
  }

  /** A bus value-lane: a hex-labelled band with a crossover at each change. */
  #busLane(runs, laneIndex, { color, colorOf }) {
    const top = laneIndex * LANE_H;
    const highY = top + WAVE_PAD;
    const lowY = top + LANE_H - WAVE_PAD;
    const midY = top + LANE_H / 2;
    const nodes = [];
    let d = "";
    const textColor = colorOf("var(--color-text)");
    for (const run of runs) {
      const x0 = this.#xOf(run.from);
      const x1 = this.#xOf(run.to);
      const w = x1 - x0;
      if (run.key == null) {
        nodes.push(
          svg("rect", {
            x: x0,
            y: top + 2,
            width: Math.max(0, w),
            height: LANE_H - 4,
            fill: "url(#scope-hatch)",
            stroke: "none",
          }),
        );
        continue;
      }
      const slew = Math.min(4, w / 2);
      // A pointed hexagon: mid → top/bottom rails → mid.
      d += ` M ${x0} ${midY} L ${x0 + slew} ${highY} L ${x1 - slew} ${highY}`;
      d += ` L ${x1} ${midY} L ${x1 - slew} ${lowY} L ${x0 + slew} ${lowY}`;
      d += ` L ${x0} ${midY} Z`;
      const label = this.#busHex(run.key);
      if (w > label.length * 7 + 10) {
        nodes.push(
          svg(
            "text",
            {
              x: (x0 + x1) / 2,
              y: midY + 3,
              "text-anchor": "middle",
              style: {
                fill: textColor,
                font: "10px var(--font-mono)",
                pointerEvents: "none",
              },
            },
            label,
          ),
        );
      }
    }
    nodes.unshift(
      svg("path", {
        d: d || "M 0 0",
        fill: "none",
        style: { stroke: color, strokeWidth: "1.5" },
      }),
    );
    return nodes;
  }

  #busHex(value) {
    return `0x${(value >>> 0).toString(16).toUpperCase()}`;
  }

  #labelOf(ch) {
    if (ch.label) return ch.label;
    if (ch.kind === "bus") {
      const bus = this.#doc.getBus(ch.ref);
      return bus ? bus.name : `${ch.ref} (missing)`;
    }
    const netId = this.#netlist.netOf(ch.ref);
    return this.#netlist.nameOf(netId) || ch.ref;
  }

  #formatCell(ch, cell) {
    if (cell == null) return "—";
    if (ch.kind === "bus") return this.#busHex(cell);
    return cell; // a level string
  }

  #renderDelta() {
    if (this.#cursorA == null || this.#cursorB == null) {
      this.#delta.textContent =
        this.#cursorA != null ? `t=${this.#cursorA}` : "";
      return;
    }
    const dTicks = Math.abs(this.#cursorB - this.#cursorA);
    const ms = this.#tickMs();
    const msPart =
      ms != null && ms > 0 ? ` · ${(dTicks * ms).toFixed(1)} ms` : "";
    this.#delta.textContent = `Δ ${dTicks} ${dTicks === 1 ? "tick" : "ticks"}${msPart}`;
  }

  // ── Cursors ─────────────────────────────────────────────────────────────────

  #tickFromEvent(e) {
    const x = e.offsetX;
    const tick = this.#recorder.firstTick + Math.floor(x / PX_PER_TICK);
    return Math.max(
      this.#recorder.firstTick,
      Math.min(this.#recorder.lastTick, tick),
    );
  }

  #onCursorDown(e) {
    if (this.#recorder.size === 0) return;
    this.#dragging = e.shiftKey ? "b" : "a";
    const tick = this.#tickFromEvent(e);
    if (this.#dragging === "b") this.#cursorB = tick;
    else this.#cursorA = tick;
    this.#svg.setPointerCapture?.(e.pointerId);
    this.#render();
  }

  #onCursorMove(e) {
    if (!this.#dragging) return;
    const tick = this.#tickFromEvent(e);
    if (this.#dragging === "b") this.#cursorB = tick;
    else this.#cursorA = tick;
    this.#render();
  }

  #onCursorUp(e) {
    if (!this.#dragging) return;
    this.#dragging = null;
    this.#svg.releasePointerCapture?.(e.pointerId);
  }

  #onScroll() {
    // Turn live-follow off when the user scrolls away from the right edge.
    const nearEnd =
      this.#lanes.scrollLeft + this.#lanes.clientWidth >=
      this.#lanes.scrollWidth - 4;
    this.#follow = nearEnd;
    // Keep the gutter's rows aligned with the lanes when scrolled vertically.
    this.#gutter.scrollTop = this.#lanes.scrollTop;
  }

  // ── Add-channel picker ──────────────────────────────────────────────────────

  #openAddMenu(e) {
    const items = [];
    const nets = this.#doc.netNames.filter(
      (n) => !this.#doc.hasScopeChannel("net", n.address),
    );
    for (const n of nets) {
      items.push({
        label: `${n.name}  ·  ${n.address}`,
        onSelect: () => this.addNetChannel(n.address),
      });
    }
    const buses = this.#doc.buses.filter(
      (b) => !this.#doc.hasScopeChannel("bus", b.id),
    );
    if (nets.length && buses.length) items.push({ separator: true });
    for (const b of buses) {
      items.push({
        label: `${b.name}  ·  bus`,
        onSelect: () => this.addBusChannel(b.id),
      });
    }
    if (!items.length) {
      items.push({ label: "No named nets or buses yet", disabled: true });
    }
    const rect = e.currentTarget.getBoundingClientRect();
    PopupManager.menu({ x: rect.left, y: rect.bottom + 4, items });
  }

  // ── Export (self-contained SVG / PNG, no new IPC — a browser download) ───────

  #export(asPng) {
    const channels = this.#doc.scopeChannels;
    if (!channels.length || this.#recorder.size === 0) return;
    const svgEl = this.#buildExportSvg(channels);
    const xml = new XMLSerializer().serializeToString(svgEl);
    const data = `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
    if (!asPng) {
      this.#download(new Blob([data], { type: "image/svg+xml" }), "timing.svg");
      return;
    }
    const width = Number(svgEl.getAttribute("width"));
    const height = Number(svgEl.getAttribute("height"));
    const img = new Image();
    const url = URL.createObjectURL(
      new Blob([data], { type: "image/svg+xml" }),
    );
    img.onload = () => {
      const scale = 2; // crisp raster
      const canvas = el("canvas");
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => blob && this.#download(blob, "timing.png"));
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  /** A standalone SVG (concrete colors, a label column) for file export. */
  #buildExportSvg(channels) {
    const resolve = (c) => this.#resolveColor(c);
    const labelW = 150;
    const lanesW = Math.max(1, this.#recorder.size) * PX_PER_TICK;
    const height = channels.length * LANE_H;
    const width = labelW + lanesW;
    const root = svg("svg", {
      xmlns: SVGNS,
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
    });
    root.append(
      svg("rect", {
        x: 0,
        y: 0,
        width,
        height,
        fill: resolve("var(--color-mantle)"),
      }),
    );
    // Label column.
    channels.forEach((ch, i) => {
      const color = resolve(
        ch.color || CHANNEL_COLORS[i % CHANNEL_COLORS.length],
      );
      root.append(
        svg("rect", {
          x: 4,
          y: i * LANE_H + LANE_H / 2 - 4,
          width: 8,
          height: 8,
          fill: color,
        }),
        svg(
          "text",
          {
            x: 18,
            y: i * LANE_H + LANE_H / 2 + 4,
            style: {
              fill: resolve("var(--color-text)"),
              font: "12px var(--font-sans)",
            },
          },
          this.#labelOf(ch),
        ),
      );
    });
    const lanes = svg("g", { transform: `translate(${labelW}, 0)` });
    for (const node of this.#buildLaneNodes(channels, {
      width: lanesW,
      height,
      colorOf: resolve,
    })) {
      lanes.append(node);
    }
    root.append(lanes);
    return root;
  }

  /** Resolve a `var(--token)` to its computed value; pass other colors through. */
  #resolveColor(color) {
    if (typeof color !== "string") return "#888888";
    const m = /^var\((--[\w-]+)\)$/.exec(color.trim());
    if (!m) return color;
    const v = getComputedStyle(this.#el).getPropertyValue(m[1]).trim();
    return v || "#888888";
  }

  #download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

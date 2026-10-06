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
import { t } from "../i18n.js";
import { parseBusName } from "../model/desk-doc.js";
import { ScopeRecorder, decodeBus, readNet } from "../model/scope-recorder.js";
import { PopupManager } from "../popup-manager.js";
import { beginPointerGesture } from "./pointer-gesture.js";

const SVGNS = "http://www.w3.org/2000/svg";

/** Lane geometry, in CSS px. */
const LANE_H = 46; // one channel row
const WAVE_PAD = 10; // top/bottom inset within a lane
const PX_PER_TICK = 10; // one tick column's width

/** Panel sizing (the bottom-docked height, in CSS px). */
const DEFAULT_PANEL_H = 280; // matches the .scope-panel CSS fallback
const MIN_PANEL_H = 120; // header + at least one legible lane
const MAX_PANEL_FRAC = 0.5; // never taller than half the window

/** Reordering a channel by dragging its gutter row. */
const DRAG_THRESHOLD = 4; // px of travel before a press becomes a drag
const EDGE_ZONE = LANE_H / 2; // px from the list's top/bottom that scroll it
const EDGE_SPEED = 12; // the fastest that scroll goes, in px per frame

/** Distinct lane colors, cycled by channel when a channel has no own color. */
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

/**
 * A channel's lane color: its own, else the palette's entry for the channel's
 * id NUMBER — never for its row, or every channel without a color of its own
 * would change color whenever one is moved past it. `index` is only a fallback
 * for an id that is not `sc<n>`, which a loaded document never holds.
 */
function channelColor(ch, index) {
  if (ch.color) return ch.color;
  const m = /^sc(\d+)$/.exec(ch.id ?? "");
  const n = m ? Number(m[1]) - 1 : index;
  return CHANNEL_COLORS[n % CHANNEL_COLORS.length];
}

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
  #chrome = []; // built-once header/resize labels, for relocalize()
  #resize; // the draggable top edge
  #onHeightChange;
  #height = DEFAULT_PANEL_H;
  #resizeStartY = null; // pointer Y at drag start (null = not resizing)
  #resizeStartH = 0; // panel height at drag start

  #recorder = new ScopeRecorder();
  #lastMode = "stopped";
  #cursorA = null; // tick index or null
  #cursorB = null;
  #dragging = null; // "a" | "b" while dragging a cursor
  #follow = true; // keep scrolled to the live right edge
  #renderScheduled = false;
  #reorder = null; // a gutter row being dragged to another place (#onChanDown)

  /**
   * @param {HTMLElement} container - the app shell (#app, a flex column); the
   *   panel docks along its bottom edge.
   * @param {object} opts
   * @param {import('../model/desk-doc.js').DeskDoc} opts.deskDoc
   * @param {import('./netlist-cache.js').NetlistCache} opts.netlist
   * @param {(visible:boolean)=>void} [opts.onVisibilityChange]
   * @param {(kind:string, ref:string, opts?:object)=>void} opts.onAddChannel
   * @param {(id:string)=>void} opts.onRemoveChannel
   * @param {(id:string, index:number)=>void} opts.onMoveChannel
   * @param {()=>number|null} [opts.tickMs] - ms per tick for the Δ readout.
   * @param {number} [opts.height] - restored panel height in CSS px.
   * @param {(height:number)=>void} [opts.onHeightChange] - persist the height
   *   after a resize drag settles.
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
      height,
      onHeightChange,
    },
  ) {
    this.#doc = deskDoc;
    this.#netlist = netlist;
    this.#onVisibilityChange = onVisibilityChange;
    this.#onAddChannel = onAddChannel;
    this.#onRemoveChannel = onRemoveChannel;
    this.#onMoveChannel = onMoveChannel;
    this.#tickMs = tickMs ?? (() => null);
    this.#onHeightChange = onHeightChange;

    this.#buildDom();
    container.append(this.#el);
    this.#applyHeight(Number.isFinite(height) ? height : DEFAULT_PANEL_H);

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
    // Kept so `relocalize()` can re-apply their text/titles: they are built once
    // here and never re-rendered (unlike the gutter and lanes, which are).
    this.#chrome = [];

    const addBtn = el("button", {
      class: "scope-btn",
      type: "button",
      // The "+" is a glyph, so only the word after it is translated.
      text: `+ ${t("scope.channel")}`,
      title: t("scope.addTitle"),
      onClick: (e) => this.#openAddMenu(e),
    });
    const clearBtn = el("button", {
      class: "scope-btn",
      type: "button",
      text: t("common.clear"),
      title: t("scope.clearTitle"),
      onClick: () => this.#clearTrace(),
    });
    const svgBtn = el("button", {
      class: "scope-btn",
      type: "button",
      text: "SVG",
      title: t("scope.exportSvg"),
      onClick: () => this.#export(false),
    });
    const pngBtn = el("button", {
      class: "scope-btn",
      type: "button",
      text: "PNG",
      title: t("scope.exportPng"),
      onClick: () => this.#export(true),
    });

    const title = el("span", { class: "scope-title", text: t("scope.title") });
    const closeBtn = el("button", {
      class: "scope-close",
      type: "button",
      title: t("scope.close"),
      "aria-label": t("scope.close"),
      text: "×",
      onClick: () => this.setVisible(false),
    });
    const header = el("div", { class: "scope-header" }, [
      title,
      el("div", { class: "scope-tools" }, [
        addBtn,
        clearBtn,
        el("span", { class: "scope-sep" }),
        svgBtn,
        pngBtn,
        this.#delta,
      ]),
      closeBtn,
    ]);

    this.#gutter = el("div", { class: "scope-gutter" });
    // One listener for every row: the rows are rebuilt on every render (each
    // sim tick while running), the gutter never is — which is also why the drag
    // takes its pointer capture on the GUTTER, not on the row it started on.
    this.#gutter.addEventListener("pointerdown", (e) => this.#onChanDown(e));
    this.#svg = svg("svg", { class: "scope-svg" });
    this.#lanes = el("div", { class: "scope-lanes" }, [this.#svg]);
    this.#lanes.addEventListener("scroll", () => this.#onScroll());
    this.#svg.addEventListener("pointerdown", (e) => this.#onCursorDown(e));
    this.#svg.addEventListener("pointermove", (e) => this.#onCursorMove(e));
    this.#svg.addEventListener("pointerup", (e) => this.#onCursorUp(e));

    // Three fragments around one button — the sentence is split by the LINK in
    // the middle of it, so each side is its own key rather than markup smuggled
    // through a translation.
    this.#empty = el("div", { class: "scope-empty" }, [
      t("scope.emptyBefore"),
      el("button", {
        class: "scope-link",
        type: "button",
        text: t("scope.emptyLink"),
        onClick: (e) => this.#openAddMenu(e),
      }),
      t("scope.emptyAfter"),
    ]);

    this.#body = el("div", { class: "scope-body" }, [
      this.#gutter,
      this.#lanes,
    ]);

    // The draggable top edge. A dedicated strip (its own flex row) so it never
    // competes with the header controls or the desk above for pointer events.
    this.#resize = el("div", {
      class: "scope-resize",
      title: t("scope.resize"),
      "aria-hidden": "true",
    });
    this.#resize.addEventListener("pointerdown", (e) => this.#onResizeDown(e));
    this.#resize.addEventListener("pointermove", (e) => this.#onResizeMove(e));
    this.#resize.addEventListener("pointerup", (e) => this.#onResizeUp(e));

    this.#el = el(
      "aside",
      { class: "scope-panel", "aria-label": t("scope.title"), hidden: true },
      [this.#resize, header, this.#body, this.#empty],
    );

    // One entry per piece of built-once chrome: the element, and how to label it
    // again. Listed here rather than re-queried in relocalize() so a class
    // rename can't silently stop a label from following the language.
    this.#chrome = [
      [addBtn, () => `+ ${t("scope.channel")}`, () => t("scope.addTitle")],
      [clearBtn, () => t("common.clear"), () => t("scope.clearTitle")],
      [svgBtn, null, () => t("scope.exportSvg")],
      [pngBtn, null, () => t("scope.exportPng")],
      [title, () => t("scope.title"), null],
      [closeBtn, null, () => t("scope.close")],
      [this.#resize, null, () => t("scope.resize")],
    ];
  }

  /**
   * Re-render in the new language (see app.js's `relabelChrome`). The gutter,
   * lanes and Δ readout are redrawn from the document on every `#render()`; only
   * the header and the empty-state sentence are built once, so those are the two
   * things this has to say again by hand.
   */
  relocalize() {
    for (const [node, text, title] of this.#chrome) {
      if (text) node.textContent = text();
      if (title) {
        node.title = title();
        if (node.hasAttribute("aria-label")) {
          node.setAttribute("aria-label", title());
        }
      }
    }
    this.#el.setAttribute("aria-label", t("scope.title"));
    this.#empty.replaceChildren(
      t("scope.emptyBefore"),
      el("button", {
        class: "scope-link",
        type: "button",
        text: t("scope.emptyLink"),
        onClick: (e) => this.#openAddMenu(e),
      }),
      t("scope.emptyAfter"),
    );
    if (this.visible) this.#render();
  }

  get element() {
    return this.#el;
  }

  get visible() {
    return !this.#el.hidden;
  }

  setVisible(on) {
    const was = this.visible;
    if (!on) this.#endReorder(null);
    this.#el.hidden = !on;
    if (on) this.#render();
    if (was !== on) this.#onVisibilityChange?.(on);
  }

  toggle() {
    this.setVisible(!this.visible);
  }

  // ── Sizing (drag the top edge; the panel docks along the window's bottom) ────

  /** The tallest the panel may grow to: half the window, floored at the min. */
  #maxHeight() {
    const half = Math.floor((window.innerHeight || 0) * MAX_PANEL_FRAC);
    return Math.max(MIN_PANEL_H, half);
  }

  /** Clamp a pixel height to [min, half-window] and apply it; returns applied. */
  #applyHeight(h) {
    const clamped = Math.round(
      Math.min(this.#maxHeight(), Math.max(MIN_PANEL_H, h)),
    );
    this.#height = clamped;
    this.#el.style.height = `${clamped}px`;
    return clamped;
  }

  #onResizeDown(e) {
    e.preventDefault();
    this.#resizeStartY = e.clientY;
    this.#resizeStartH = this.#el.getBoundingClientRect().height;
    this.#resize.setPointerCapture?.(e.pointerId);
    this.#resize.classList.add("scope-resize--active");
  }

  #onResizeMove(e) {
    if (this.#resizeStartY == null) return;
    // Dragging the handle UP (a negative delta) grows the bottom-docked panel.
    this.#applyHeight(this.#resizeStartH - (e.clientY - this.#resizeStartY));
  }

  #onResizeUp(e) {
    if (this.#resizeStartY == null) return;
    this.#resizeStartY = null;
    this.#resize.releasePointerCapture?.(e.pointerId);
    this.#resize.classList.remove("scope-resize--active");
    this.#onHeightChange?.(this.#height);
  }

  // ── Public channel entry points (probe "Add to analyzer", picker) ───────────

  /**
   * Track a net by a member address (deduped by the controller). `opts` reaches
   * DeskDoc.addScopeChannel, which has always accepted a colour and a label —
   * it was only this hop that dropped them. A signal flag passes its own
   * colour, so the flag, its button's dot and the analyzer lane are one hue.
   */
  addNetChannel(address, opts = {}) {
    if (this.#doc.hasScopeChannel("net", address)) return;
    this.#onAddChannel?.("net", address, opts);
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
    // The channel being dragged has gone (an undo, a tab switch): drop the drag
    // rather than carry a row that is no longer there.
    const r = this.#reorder;
    if (r && !this.#doc.scopeChannels.some((c) => c.id === r.id)) {
      this.#endReorder(null);
    }
    const channels = this.#channels();
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
    const dragged = this.#reorder?.started ? this.#reorder : null;
    channels.forEach((ch, i) => {
      const color = channelColor(ch, i);
      const lifted = dragged?.id === ch.id;
      const value = this.#formatCell(
        ch,
        this.#cursorA != null
          ? this.#recorder.cellAt(this.#cursorA, ch.id)
          : this.#recorder.cellAt(this.#recorder.lastTick, ch.id),
      );
      const row = el(
        "div",
        {
          class: lifted ? "scope-chan scope-chan--dragging" : "scope-chan",
          dataset: { channel: ch.id },
          style: {
            height: `${LANE_H}px`,
            transform: lifted ? `translateY(${dragged.offset}px)` : null,
          },
        },
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
              title: t("scope.moveUp"),
              disabled: i === 0,
              onClick: () => this.#onMoveChannel?.(ch.id, i - 1),
            }),
            el("button", {
              class: "scope-mini",
              type: "button",
              text: "↓",
              title: t("scope.moveDown"),
              disabled: i === channels.length - 1,
              onClick: () => this.#onMoveChannel?.(ch.id, i + 1),
            }),
            el("button", {
              class: "scope-mini scope-mini--del",
              type: "button",
              text: "×",
              title: t("scope.removeChannel"),
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
    // The dragged channel's lane is shaded in the row it would land in, behind
    // its waveform (after the <defs>, before everything else).
    if (this.#reorder?.started) {
      const at = channels.findIndex((c) => c.id === this.#reorder.id);
      this.#svg.insertBefore(
        svg("rect", {
          class: "scope-lane-lift",
          x: 0,
          y: at * LANE_H,
          width,
          height: LANE_H,
        }),
        this.#svg.firstChild?.nextSibling ?? null,
      );
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
      const color = colorOf(channelColor(ch, i));
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
      return bus ? bus.name : t("scope.missingRef", { ref: ch.ref });
    }
    // The name AT the channel's point — never one a closed switch carried
    // over from the net on its other side.
    return this.#netlist.nameAt(ch.ref) || ch.ref;
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
    // Δ is a glyph; only the tick plural and the separator are catalog text.
    this.#delta.textContent = `Δ ${t("scope.tickCount", { count: dTicks })}${msPart}`;
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

  // ── Reordering (drag a channel's gutter row up or down) ─────────────────────
  //
  // The drag never touches the document until the drop: while it is in flight
  // the panel DRAWS the order a drop would leave (#channels), so the gutter and
  // the lanes both show it, and the held row floats under the pointer. The drop
  // is one onMoveChannel — the same call ↑/↓ make, so it is one undo step. It
  // works while the circuit runs, as every channel edit does; a tick's render
  // just redraws the preview from the same state.

  /**
   * The channels in the order they are drawn: the document's, or while a row
   * is being dragged, the order a drop where it is now would leave.
   */
  #channels() {
    const channels = this.#doc.scopeChannels;
    const r = this.#reorder;
    if (!r?.started) return channels;
    const from = channels.findIndex((c) => c.id === r.id);
    if (from === -1) return channels;
    const [ch] = channels.splice(from, 1);
    channels.splice(r.target, 0, ch);
    return channels;
  }

  /** A client Y as a distance down the channel list (scroll included). */
  #listY(clientY) {
    const { top } = this.#gutter.getBoundingClientRect();
    return clientY - top + this.#gutter.scrollTop;
  }

  /**
   * Where the held row is at `clientY`: the row it would land in, and how far
   * it floats off that row's top so it stays under the pointer. Kept on the
   * list — the row stops at the first and last places rather than leaving it.
   */
  #reorderAt(r, clientY) {
    const last = Math.max(0, this.#doc.scopeChannels.length - 1);
    const top = Math.max(
      0,
      Math.min(last * LANE_H, this.#listY(clientY) - r.grab),
    );
    const target = Math.round(top / LANE_H);
    return { target, offset: top - target * LANE_H };
  }

  #onChanDown(e) {
    if (e.button !== 0 || this.#reorder) return;
    if (e.target.closest?.("button")) return; // ↑ ↓ × keep their clicks
    const id = e.target.closest?.(".scope-chan")?.dataset.channel;
    const channels = this.#doc.scopeChannels;
    const from = channels.findIndex((c) => c.id === id);
    if (from === -1 || channels.length < 2) return;
    e.preventDefault(); // no text selection while the row is held
    const r = {
      id,
      pointerId: e.pointerId,
      startY: e.clientY,
      grab: this.#listY(e.clientY) - from * LANE_H, // where in the row it was taken
      clientY: e.clientY,
      started: false,
      target: from,
      offset: 0,
      speed: 0, // edge-scroll px per frame, signed
      frame: null,
    };
    r.end = beginPointerGesture(this.#gutter, e.pointerId, {
      onMove: (ev) => this.#onChanMove(ev),
      onEnd: (ev) => this.#onChanUp(ev),
    });
    // Escape puts the row back. Only once it has moved: before that nothing is
    // on screen to cancel, and the key belongs to whoever else wants it.
    r.onKey = (ev) => {
      if (ev.key !== "Escape" || !r.started) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.#endReorder(null);
      this.#render();
    };
    window.addEventListener("keydown", r.onKey, true);
    this.#reorder = r;
  }

  #onChanMove(e) {
    const r = this.#reorder;
    if (!r || e.pointerId !== r.pointerId) return;
    r.clientY = e.clientY;
    if (!r.started) {
      if (Math.abs(e.clientY - r.startY) < DRAG_THRESHOLD) return;
      r.started = true;
      this.#el.classList.add("scope-panel--reordering");
      this.#trackReorder(true);
      return;
    }
    this.#trackReorder(false);
  }

  /**
   * Re-place the held row at the last pointer position. A new landing row
   * redraws the gutter and lanes in the new order; the same one only slides
   * the floating row, so a drag across one row redraws nothing else.
   */
  #trackReorder(redraw) {
    const r = this.#reorder;
    const { target, offset } = this.#reorderAt(r, r.clientY);
    redraw ||= target !== r.target;
    r.target = target;
    r.offset = offset;
    this.#edgeScroll(r);
    if (redraw) {
      this.#render();
      return;
    }
    const row = this.#gutter.querySelector(".scope-chan--dragging");
    if (row) row.style.transform = `translateY(${offset}px)`;
  }

  /**
   * A row held at (or past) the top or bottom of a list longer than the panel
   * scrolls it, faster the further out, so a channel can be carried to a place
   * that was scrolled out of sight. Runs per frame, since a pointer held still
   * sends no moves.
   */
  #edgeScroll(r) {
    const lanes = this.#lanes;
    if (lanes.scrollHeight <= lanes.clientHeight) {
      r.speed = 0;
      return;
    }
    const { top, bottom } = this.#gutter.getBoundingClientRect();
    const past =
      r.clientY < top + EDGE_ZONE
        ? r.clientY - (top + EDGE_ZONE)
        : r.clientY > bottom - EDGE_ZONE
          ? r.clientY - (bottom - EDGE_ZONE)
          : 0;
    r.speed = Math.max(-EDGE_SPEED, Math.min(EDGE_SPEED, past / 2));
    if (!r.speed || r.frame != null) return;
    if (typeof requestAnimationFrame !== "function") return;
    r.frame = requestAnimationFrame(() => {
      r.frame = null;
      if (this.#reorder !== r || !r.speed) return;
      const before = lanes.scrollTop;
      lanes.scrollTop = before + r.speed;
      this.#gutter.scrollTop = lanes.scrollTop;
      if (lanes.scrollTop !== before) this.#trackReorder(false);
    });
  }

  #onChanUp(e) {
    const r = this.#reorder;
    if (!r || (e.pointerId != null && e.pointerId !== r.pointerId)) return;
    // The drop lands where the button came UP, not at the last move — the move
    // stream is coalesced and can be a frame or more behind the release.
    const drop =
      r.started && e.type === "pointerup" && typeof e.clientY === "number"
        ? this.#reorderAt(r, e.clientY).target
        : null;
    this.#endReorder(drop);
    this.#render();
  }

  /**
   * Finish the drag: tear down its listeners and, given a landing row, move the
   * channel there. `null` puts it back where it was. Draws nothing — a caller
   * that is not already rendering follows it with #render.
   */
  #endReorder(target) {
    const r = this.#reorder;
    if (!r) return;
    this.#reorder = null;
    r.end();
    window.removeEventListener("keydown", r.onKey, true);
    if (r.frame != null) cancelAnimationFrame(r.frame);
    this.#el.classList.remove("scope-panel--reordering");
    if (target == null) return;
    const from = this.#doc.scopeChannels.findIndex((c) => c.id === r.id);
    if (from !== -1 && target !== from) this.#onMoveChannel?.(r.id, target);
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
        label: `${b.name}  ·  ${t("scope.busSuffix")}`,
        onSelect: () => this.addBusChannel(b.id),
      });
    }
    if (!items.length) {
      items.push({ label: t("scope.noNets"), disabled: true });
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
      const color = resolve(channelColor(ch, i));
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

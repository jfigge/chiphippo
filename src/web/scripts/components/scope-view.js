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
// bottom-docked aside that RECORDS the `chiphippo:sim-tick` stream into a pure
// ScopeRecorder (one column per tick — every tick, though the views are shown
// only a batch's last) and RENDERS a scrolling timing diagram:
// a gutter of channels, one lane each (bit waveform for a net, hex value-lane
// for a bus), a shared tick grid, and two click-placed cursors with a Δ
// readout. A net whose VOLTAGE the run knows (Spice Lite's `nodeVolts`: an RC
// node, a 555's capacitor) draws that voltage instead of its level, so a
// charging capacitor is seen to curve rather than to step. It never drives or stalls the sim — it only reads the per-tick
// broadcast, so the analyzer adds nothing to the settle loop.
//
// The lanes' x axis is one of two modes over the same columns
// (model/scope-axis.js, the header's Timing | Transitions picker): TIMING puts
// each column at its simulated moment, at a per-division scale (− / + / Fit,
// ⌘/Ctrl+wheel); TRANSITIONS gives each change a slice and folds a steady run
// into a marked break. Only the stretch of the lanes on screen (and a
// viewport either side) is drawn, so a fine scale over a long trace costs
// what a coarse one does.
//
// Channel resolution and bus decode are the pure helpers in
// model/scope-recorder.js; channels persist in the document (doc.scopeChannels)
// so a saved design keeps its instrument setup. All channel mutations route
// through the DeskController callbacks so they ride the one undo/redo seam.

import { clear, el } from "../dom.js";
import { formatNumber, t, tf } from "../i18n.js";
import { parseBusName } from "../model/desk-doc.js";
import {
  BREAK_PX,
  SEC_PER_DIV,
  columnAtX,
  columnTimes,
  fitSecPerDiv,
  joined,
  minSecPerDiv,
  normalizeAxisMode,
  stepSecPerDiv,
  timingAxis,
  transitionAxis,
} from "../model/scope-axis.js";
import { formatSeconds } from "../model/timing-summary.js";
import { WIRE_COLORS } from "../model/wire-colors.js";
import {
  ScopeRecorder,
  decodeBus,
  fullScaleOf,
  laneSpan,
  isSpiceRun,
  readNet,
  readVoltsAgainst,
} from "../model/scope-recorder.js";
import { PopupManager } from "../popup-manager.js";
import {
  DEFAULT_GAP_PERCENT,
  normalizeSpiceConfig,
} from "../sim/spice/config.js";
import { beginPointerGesture } from "./pointer-gesture.js";
import { buildSegmented } from "./segmented-picker.js";

const SVGNS = "http://www.w3.org/2000/svg";

/** Lane geometry, in CSS px. */
const LANE_H = 46; // one channel row
const WAVE_PAD = 10; // top/bottom inset within a lane
const DEFAULT_FULL_SCALE = 5; // volts, for a voltage lane with no supply named
const FALLBACK_VIEW_PX = 800; // the lanes' width when none is laid out (hidden, jsdom)
const EDGE_PAD = 2; // px past the drawn window an off-screen point is held at
const WHEEL_STEP = 40; // wheel delta (px) that makes one zoom step
const EXPORT_MAX_PX = 16000; // past this an export is what is on screen

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
 *
 * Its own color is a stored WIRE_COLORS token (a signal flag hands over its
 * own, so flag, button dot and lane are one hue), drawn through the theme's
 * `--color-wire-<token>` like every wire and flag on the desk. Handed to CSS
 * bare, `"red"` was the CSS named color of that name, which no theme defines;
 * a value that is not a token is no color the app ever stores, so it takes the
 * palette's.
 */
function channelColor(ch, index) {
  if (WIRE_COLORS.includes(ch.color)) return `var(--color-wire-${ch.color})`;
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
  #onSetGround; // (address|null) → void — the analyzer's ground lead
  #ground; // the header's ground-lead chip: { group, label, clear }

  #el;
  #body;
  #gutter;
  #lanes; // the horizontally-scrolling lanes viewport
  #track; // the lanes' full width and height, inside #lanes (what scrolls)
  #svg; // the drawn window of the track, positioned over its stretch of it
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

  #axisMode; // "timing" | "transitions" (model/scope-axis.js)
  #onAxisModeChange;
  #axisSlot; // holds the Timing | Transitions picker (rebuilt on relocalize)
  #zoom = {}; // the timing scale's header controls: group, out, perDiv, in, fit
  #secPerDiv = null; // the chosen timing scale; null = fit the trace
  #gapPercent = DEFAULT_GAP_PERCENT; // what counts as a change (Spice Lite's gap)
  #now = -Infinity; // the latest moment this run has reported (sim-state `at`)
  #axis = null; // the last render's axis (scope-axis.js, plus its mode)
  #win = { x0: 0, x1: 0 }; // the stretch of the track drawn, track px
  #anchor = null; // a zoom's {t, px}: keep moment t (s after t0) at px
  #wheelAcc = 0; // ⌘/Ctrl+wheel travel not yet turned into a zoom step

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
   * @param {(address:string|null)=>void} [opts.onSetGround] - move or take
   *   off the analyzer's ground lead.
   * @param {number} [opts.height] - restored panel height in CSS px.
   * @param {(height:number)=>void} [opts.onHeightChange] - persist the height
   *   after a resize drag settles.
   * @param {string} [opts.axisMode] - the restored x-axis mode.
   * @param {(mode:string)=>void} [opts.onAxisModeChange] - persist the mode.
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
      onSetGround,
      height,
      onHeightChange,
      axisMode,
      onAxisModeChange,
    },
  ) {
    this.#doc = deskDoc;
    this.#netlist = netlist;
    this.#onVisibilityChange = onVisibilityChange;
    this.#onAddChannel = onAddChannel;
    this.#onRemoveChannel = onRemoveChannel;
    this.#onMoveChannel = onMoveChannel;
    this.#onSetGround = onSetGround ?? null;
    this.#onHeightChange = onHeightChange;
    this.#axisMode = normalizeAxisMode(axisMode);
    this.#onAxisModeChange = onAxisModeChange;

    this.#buildDom();
    container.append(this.#el);
    this.#applyHeight(Number.isFinite(height) ? height : DEFAULT_PANEL_H);

    // EVERY tick is a column: `sim-tick` is each one (a batch runs many
    // between two views' updates); `sim-state` only says when a run ends.
    window.addEventListener("chiphippo:sim-tick", (e) => this.#onSim(e.detail));
    // …and, while one runs, how far it has got: the timing axis reaches the
    // moment the board was last shown at, not just the last tick's.
    window.addEventListener("chiphippo:sim-state", (e) => {
      if (e.detail.mode === "stopped") this.#onSim(e.detail);
      else this.#onShownAt(e.detail.at);
    });
    // The channel list / bus definitions may have changed — repaint the gutter.
    window.addEventListener("chiphippo:doc-changed", () => {
      if (this.visible) this.#scheduleRender();
    });
    // Another document on the desk (a desktop switch, a project): the trace
    // kept from the last run is the LAST desk's, and its channel ids (sc1,
    // sc2, …) name this one's channels too — so it would be drawn under them.
    window.addEventListener("chiphippo:desk-loaded", () => this.#clearTrace());
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
    // The ground lead, once one is clipped on (the probe's menu puts it
    // there): where every voltage lane is read from, and its × takes it off.
    const groundClear = el("button", {
      class: "scope-ground-clear",
      type: "button",
      text: "×",
      title: t("scope.groundClear"),
      "aria-label": t("scope.groundClear"),
      onClick: () => this.#onSetGround?.(null),
    });
    const groundLabel = el("span", { class: "scope-ground-label", text: "" });
    this.#ground = {
      group: el("span", { class: "scope-ground", hidden: true }, [
        el("span", { class: "scope-ground-glyph", text: "⏚", "aria-hidden": "true" }), // prettier-ignore
        groundLabel,
        groundClear,
      ]),
      label: groundLabel,
      clear: groundClear,
    };
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

    // The timing scale: − / readout / + / Fit, shown in Timing mode only.
    const zoomOut = el("button", {
      class: "scope-btn scope-zoom-btn",
      type: "button",
      text: "−",
      title: t("scope.zoomOut"),
      "aria-label": t("scope.zoomOut"),
      onClick: () => this.#zoomBy(1),
    });
    const zoomIn = el("button", {
      class: "scope-btn scope-zoom-btn",
      type: "button",
      text: "+",
      title: t("scope.zoomIn"),
      "aria-label": t("scope.zoomIn"),
      onClick: () => this.#zoomBy(-1),
    });
    const fitBtn = el("button", {
      class: "scope-btn",
      type: "button",
      text: t("scope.fit"),
      title: t("scope.fitTitle"),
      onClick: () => this.#fit(),
    });
    const perDiv = el("span", { class: "scope-per-div", text: "" });
    this.#zoom = {
      group: el("span", { class: "scope-zoom" }, [
        zoomOut,
        perDiv,
        zoomIn,
        fitBtn,
        el("span", { class: "scope-sep" }),
      ]),
      out: zoomOut,
      in: zoomIn,
      fit: fitBtn,
      perDiv,
    };
    // A holder, as the AI panel's Build/Review: the picker's labels are read
    // when it is built, so a language change rebuilds it into the same slot.
    this.#axisSlot = el("div", { class: "scope-axis" });
    this.#paintAxisPicker();

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
      this.#axisSlot,
      el("div", { class: "scope-tools" }, [
        addBtn,
        clearBtn,
        this.#ground.group,
        el("span", { class: "scope-sep" }),
        this.#zoom.group,
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
    this.#track = el("div", { class: "scope-track" }, [this.#svg]);
    this.#lanes = el("div", { class: "scope-lanes" }, [this.#track]);
    this.#lanes.addEventListener("scroll", () => this.#onScroll());
    this.#lanes.addEventListener("wheel", (e) => this.#onWheel(e), {
      passive: false,
    });
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
      [groundClear, null, () => t("scope.groundClear")],
      [svgBtn, null, () => t("scope.exportSvg")],
      [pngBtn, null, () => t("scope.exportPng")],
      [zoomOut, null, () => t("scope.zoomOut")],
      [zoomIn, null, () => t("scope.zoomIn")],
      [fitBtn, () => t("scope.fit"), () => t("scope.fitTitle")],
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
    this.#paintAxisPicker();
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

  /** The x-axis mode the lanes are drawn in. */
  get axisMode() {
    return this.#axisMode;
  }

  /**
   * Draw the lanes in `mode` ("timing" | "transitions"). The recording is
   * the same in both; only where its columns are put changes.
   */
  setAxisMode(mode) {
    const next = normalizeAxisMode(mode);
    if (next === this.#axisMode) return;
    this.#axisMode = next;
    this.#paintAxisPicker();
    this.#onAxisModeChange?.(next);
    if (this.visible) this.#render();
  }

  /**
   * Follow Settings ▸ Spice Lite: its settle gap is what Transitions mode
   * counts as no change in a voltage. Read live — it is how the trace is
   * drawn, not how the run was simulated.
   */
  setSpiceLite(config) {
    const gap = normalizeSpiceConfig(config).gapPercent;
    if (gap === this.#gapPercent) return;
    this.#gapPercent = gap;
    if (this.visible && this.#axisMode === "transitions") this.#render();
  }

  #paintAxisPicker() {
    this.#axisSlot.replaceChildren(
      buildSegmented({
        options: [
          { value: "timing", label: t("scope.axisTiming") },
          { value: "transitions", label: t("scope.axisTransitions") },
        ],
        value: this.#axisMode,
        ariaLabel: t("scope.axisLabel"),
        onPick: (mode) => this.setAxisMode(mode),
      }),
    );
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

  // ── Recording (a pure fold over the sim-tick stream) ────────────────────────

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
      this.#now = -Infinity;
    }
    // Nothing to watch, nothing to record: a run with no channels costs the
    // analyzer nothing per tick. (Columns are keyed by channel, so the first
    // channel added mid-run simply starts its trace there.)
    if (this.#doc.scopeChannels.length === 0) return;
    const { cells, volts } = this.#resolveCells(detail);
    this.#recorder.sample(cells, {
      volts,
      fullScale: fullScaleOf(detail),
      spice: isSpiceRun(detail),
      at: detail.at,
    });
    if (this.visible) this.#scheduleRender();
  }

  /** A running board was shown at `at` (simulated seconds): the trace now
      reaches that far, whether or not a tick has landed there. */
  #onShownAt(at) {
    if (!Number.isFinite(at) || at <= this.#now) return;
    this.#now = at;
    if (this.visible && this.#recorder.size) this.#scheduleRender();
  }

  /** Resolve every channel to its cell value — and, for a net whose voltage
      the run knows, its volts — from one broadcast. */
  #resolveCells(detail) {
    const cells = new Map();
    const volts = new Map();
    const ground = this.#doc.scopeGround;
    for (const ch of this.#doc.scopeChannels) {
      cells.set(ch.id, this.#readChannel(ch, detail));
      if (ch.kind === "bus") continue;
      const v = readVoltsAgainst(ch.ref, ground, detail);
      if (v != null) volts.set(ch.id, v);
    }
    return { cells, volts };
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
    this.#now = -Infinity;
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
    if (!channels.length) {
      this.#zoom.group.hidden = true; // no trace, no scale
      return;
    }
    this.#renderGround();
    this.#renderGutter(channels);
    this.#renderLanes(channels);
    this.#renderDelta();
    this.#renderZoom();
  }

  /** The header's ground-lead chip: the net the lanes are read from (its
      name, else the hole), hidden while no lead is on. */
  #renderGround() {
    const lead = this.#doc.scopeGround;
    this.#ground.group.hidden = !lead;
    if (!lead) return;
    const name = this.#netlist.nameAt(lead) || lead;
    this.#ground.label.textContent = name;
    this.#ground.group.title = tf("scope.groundTitle", "Voltages are read against {name}", { name }); // prettier-ignore
  }

  #renderGutter(channels) {
    clear(this.#gutter);
    const dragged = this.#reorder?.started ? this.#reorder : null;
    channels.forEach((ch, i) => {
      const color = channelColor(ch, i);
      const lifted = dragged?.id === ch.id;
      const tick = this.#cursorA ?? this.#recorder.lastTick;
      const value = this.#formatCell(
        ch,
        this.#recorder.cellAt(tick, ch.id),
        this.#recorder.voltsAt(tick, ch.id),
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
    // The lanes scroll both ways, so their horizontal scrollbar takes height
    // the gutter does not have: without its height again at the foot, the
    // last row could never scroll up level with the last lane.
    const bar = this.#lanes.offsetHeight - this.#lanes.clientHeight;
    if (bar > 0) {
      this.#gutter.append(
        el("div", {
          class: "scope-gutter-foot",
          style: { height: `${bar}px` },
        }),
      );
    }
    // Emptied a moment ago, the gutter fell back to its top: put it where the
    // lanes are, or every render while scrolled down (a tick's, while
    // running) left the names a scroll away from their traces.
    this.#gutter.scrollTop = this.#lanes.scrollTop;
  }

  #renderLanes(channels) {
    const axis = (this.#axis = this.#axisOf(channels));
    const width = Math.max(1, Math.ceil(axis.width));
    const height = Math.max(1, channels.length) * LANE_H;
    this.#track.style.width = `${width}px`;
    this.#track.style.height = `${height}px`;
    // Scrolled before drawing: what is drawn is the stretch the scroll shows.
    const view = this.#lanes.clientWidth;
    if (this.#anchor) {
      // A zoom keeps the moment it was made about where it was on screen.
      const { t: at, px } = this.#anchor;
      this.#anchor = null;
      this.#lanes.scrollLeft = at * axis.pxPerSec - px;
      this.#follow =
        this.#lanes.scrollLeft + view >= this.#lanes.scrollWidth - 4;
    } else if (this.#follow && this.#lastMode !== "stopped") {
      this.#lanes.scrollLeft = this.#lanes.scrollWidth;
    }
    const win = (this.#win = this.#windowOf(width));
    const w = Math.max(1, win.x1 - win.x0);
    clear(this.#svg);
    this.#svg.setAttribute("width", String(w));
    this.#svg.setAttribute("height", String(height));
    this.#svg.setAttribute("viewBox", `${win.x0} 0 ${w} ${height}`);
    this.#svg.style.left = `${win.x0}px`;
    for (const node of this.#buildLaneNodes(channels, { height })) {
      this.#svg.append(node);
    }
    // The dragged channel's lane is shaded in the row it would land in, behind
    // its waveform (after the <defs>, before everything else).
    if (this.#reorder?.started) {
      const at = channels.findIndex((c) => c.id === this.#reorder.id);
      this.#svg.insertBefore(
        svg("rect", {
          class: "scope-lane-lift",
          x: win.x0,
          y: at * LANE_H,
          width: w,
          height: LANE_H,
        }),
        this.#svg.firstChild?.nextSibling ?? null,
      );
    }
  }

  /**
   * Where every retained column goes, in the current mode (scope-axis.js):
   * TIMING at the chosen scale — or, at Fit, the finest that shows the whole
   * trace — never finer than the track can hold; TRANSITIONS by change,
   * against the Spice Lite gap of the lanes' full scale.
   */
  #axisOf(channels) {
    const cols = this.#recorder.columns();
    if (this.#axisMode === "transitions") {
      return {
        mode: "transitions",
        pxPerSec: 0,
        ...transitionAxis(
          cols,
          channels.map((c) => c.id),
          {
            gapPercent: this.#gapPercent,
            fullScale: this.#recorder.fullScale || DEFAULT_FULL_SCALE,
            end: this.#now,
          },
        ),
      };
    }
    const times = columnTimes(cols);
    const n = cols.length;
    const span = n ? Math.max(times[n - 1], this.#now) - times[0] : 0;
    const floor = minSecPerDiv(span);
    const secPerDiv =
      this.#secPerDiv == null
        ? fitSecPerDiv(span, this.#lanes.clientWidth || FALLBACK_VIEW_PX)
        : Math.max(this.#secPerDiv, floor);
    return {
      mode: "timing",
      secPerDiv,
      floor,
      breaks: [],
      ...timingAxis(cols, { secPerDiv, end: this.#now }),
    };
  }

  /**
   * The stretch of the track to draw: what the lanes show, and a viewport
   * either side so a scroll shows drawn lanes until the next render catches
   * up. All of it where nothing is laid out (hidden, jsdom).
   */
  #windowOf(width) {
    const view = this.#lanes.clientWidth;
    if (!view) return { x0: 0, x1: width };
    const left = this.#lanes.scrollLeft;
    return {
      x0: Math.max(0, left - view),
      x1: Math.min(width, left + 2 * view),
    };
  }

  /** The timing scale's controls: shown in Timing mode, reading its scale. */
  #renderZoom() {
    const z = this.#zoom;
    const axis = this.#axis;
    const timing = this.#axisMode === "timing";
    z.group.hidden = !timing;
    if (!timing || !axis) return;
    z.perDiv.textContent = t("scope.perDiv", {
      time: formatSeconds(axis.secPerDiv),
    });
    z.in.disabled = axis.secPerDiv <= Math.max(SEC_PER_DIV[0], axis.floor);
    z.out.disabled = axis.secPerDiv >= SEC_PER_DIV.at(-1);
    z.fit.classList.toggle("scope-btn--active", this.#secPerDiv == null);
    z.fit.setAttribute("aria-pressed", String(this.#secPerDiv == null));
  }

  /**
   * Build every SVG child of the drawn window of the lanes (`#win`, in track
   * px). `colorOf` maps a token/color to an applied color — identity for live
   * (CSS resolves `var(--…)` in a style), or a resolved hex for export.
   * Reused by the export path.
   */
  #buildLaneNodes(
    channels,
    { height, colorOf = (c) => c, fontOf = (f) => f } = {},
  ) {
    const nodes = [];
    const { x0, x1 } = this.#win;
    const conflict = colorOf("var(--color-sim-conflict)");
    const gridColor = colorOf("var(--color-overlay)");
    const bandColor = colorOf("var(--color-text)");
    nodes.push(this.#hatchDefs(conflict));

    // Lane separators + a light row background for legibility.
    channels.forEach((_, i) => {
      const y = i * LANE_H;
      nodes.push(
        svg("line", {
          x1: x0,
          y1: y,
          x2: x1,
          y2: y,
          style: { stroke: gridColor, strokeWidth: "0.5", opacity: "0.5" },
        }),
      );
    });
    for (const n of this.#gridNodes(height, gridColor)) nodes.push(n);
    for (const n of this.#breakNodes(height, gridColor, bandColor)) {
      nodes.push(n);
    }

    const floatColor = colorOf("var(--color-sim-float)");
    channels.forEach((ch, i) => {
      const color = colorOf(channelColor(ch, i));
      const runs = this.#runsOf(ch);
      const laneNodes =
        ch.kind === "bus"
          ? this.#busLane(runs, i, { color, colorOf, fontOf })
          : this.#netLane(runs, i, {
              color,
              floatColor,
              bandColor,
              channelId: ch.id,
            });
      for (const n of laneNodes) nodes.push(n);
    });

    // Cursors on top.
    for (const [tick, cls] of [
      [this.#cursorA, "a"],
      [this.#cursorB, "b"],
    ]) {
      const x = this.#xRaw(tick);
      if (x == null || x < x0 - EDGE_PAD || x > x1 + EDGE_PAD) continue;
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

  /**
   * Timing mode's divisions: a faint line at every whole multiple of the
   * scale inside the drawn window, so the scale in the header can be read
   * off the lanes.
   */
  #gridNodes(height, color) {
    const axis = this.#axis;
    if (axis?.mode !== "timing" || !(axis.pxPerSec > 0)) return [];
    const { x0, x1 } = this.#win;
    const step = axis.secPerDiv;
    const first = Math.ceil((axis.t0 + x0 / axis.pxPerSec) / step - 1e-9);
    const last = Math.floor((axis.t0 + x1 / axis.pxPerSec) / step + 1e-9);
    const out = [];
    for (let k = first; k <= last && out.length < 4000; k += 1) {
      const x = Math.round((k * step - axis.t0) * axis.pxPerSec * 100) / 100;
      out.push(
        svg("line", {
          class: "scope-grid",
          x1: x,
          y1: 0,
          x2: x,
          y2: height,
          style: { stroke: color, strokeWidth: "0.5", opacity: "0.6" },
        }),
      );
    }
    return out;
  }

  /**
   * Transitions mode's folds: where a steady run was cut out, a shaded
   * break with a dashed seam down its middle — titled with the stretch of
   * simulated time between the transitions either side of it.
   */
  #breakNodes(height, seamColor, shadeColor) {
    const axis = this.#axis;
    if (axis?.mode !== "transitions") return [];
    const { x0, x1 } = this.#win;
    const out = [];
    for (const b of axis.breaks) {
      if (b.x + BREAK_PX < x0 || b.x > x1) continue;
      const mid = b.x + BREAK_PX / 2;
      const span = Math.max(0, b.to - b.from);
      out.push(
        svg("g", { class: "scope-break" }, [
          svg("title", {}, [
            t("scope.folded", {
              time: formatSeconds(span) || "0 s",
            }),
          ]),
          svg("rect", {
            x: b.x,
            y: 0,
            width: BREAK_PX,
            height,
            style: { fill: shadeColor, opacity: "0.08" },
          }),
          svg("line", {
            x1: mid,
            y1: 0,
            x2: mid,
            y2: height,
            style: {
              stroke: seamColor,
              strokeWidth: "1",
              strokeDasharray: "2 3",
              opacity: "0.8",
            },
          }),
        ]),
      );
    }
    return out;
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

  /** A column's left edge (or, for one past the last, the trace's right
      edge) on the track, px — null for a tick no longer retained. */
  #xRaw(tick) {
    if (tick == null || !this.#axis) return null;
    const x = this.#axis.xs[tick - this.#recorder.firstTick];
    return x == null ? null : x;
  }

  /** `#xRaw`, held to just outside the drawn window: whatever lies beyond it
      collapses onto an edge no one sees, so a path stays one path. */
  #xOf(tick) {
    const x = this.#xRaw(tick) ?? 0;
    const { x0, x1 } = this.#win;
    return Math.max(x0 - EDGE_PAD, Math.min(x1 + EDGE_PAD, x));
  }

  /**
   * A single net waveform: one path + overlays for the Z / X regions. The path
   * steps between the rails — or, while the run knew the net's voltage, traces
   * it (`#voltsPath`). A Spice Lite run hatches no X: its level is what the
   * inputs on the net read, which is X wherever the voltage sits between two
   * readers' thresholds — a 555's capacitor between ⅓ and ⅔ of its supply,
   * its whole cycle — and the trace already shows where it stands.
   */
  #netLane(runs, laneIndex, { color, floatColor, bandColor, channelId }) {
    const top = laneIndex * LANE_H;
    const highY = top + WAVE_PAD;
    const lowY = top + LANE_H - WAVE_PAD;
    const midY = top + LANE_H / 2;
    const yFor = (lv) => (lv === "H" ? highY : lv === "L" ? lowY : midY);

    const nodes = [];
    const volts = this.#recorder.hasVolts(channelId);
    // A voltage lane's RANGE — 0 V to the run's full scale (its highest
    // supply), the two rails the trace is drawn between — as a faint band
    // the text colour tints (a touch lighter on a dark theme, darker on a
    // light one), so a signal short of a rail, or a node part-way up its
    // curve, reads against the span it should swing across.
    if (volts) {
      nodes.push(
        svg("rect", {
          class: "scope-volts-range",
          x: this.#win.x0,
          y: highY,
          width: Math.max(0, this.#win.x1 - this.#win.x0),
          height: lowY - highY,
          style: { fill: bandColor, opacity: "0.06" },
        }),
      );
      // A lane that reaches below 0 V (an AC source's) marks where 0 V is:
      // its zero crossings are what it is read for.
      const [bottom, top] = this.#spanOf(channelId);
      if (bottom < 0) {
        const y = lowY - (-bottom / (top - bottom)) * (lowY - highY);
        nodes.push(
          svg("line", {
            class: "scope-volts-zero",
            x1: this.#win.x0,
            y1: y,
            x2: this.#win.x1,
            y2: y,
            style: { stroke: bandColor, strokeWidth: "1", strokeDasharray: "3 3", opacity: "0.35" }, // prettier-ignore
          }),
        );
      }
    }
    let d = "";
    runs.forEach((run, idx) => {
      const x0 = this.#xOf(run.from);
      const x1 = this.#xOf(run.to);
      const y = yFor(run.key);
      d += idx === 0 ? `M ${x0} ${y}` : ` L ${x0} ${y}`;
      d += ` L ${x1} ${y}`;
      if (run.key === "X" || run.key == null) {
        if (this.#recorder.spice) return;
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
    if (volts) d = this.#voltsPath(channelId, { highY, lowY, yFor });
    // The main line last so it sits above the region fills.
    nodes.push(
      svg("path", {
        d: d || "M 0 0",
        fill: "none",
        style: { stroke: color, strokeWidth: "1.75" },
      }),
    );
    return nodes;
  }

  /**
   * The path of a net whose voltage the run knew: 0 V on the bottom rail, the
   * run's full scale (its highest supply) on the top one — or the lane's span
   * widened to what the channel went past, below 0 V for an AC source
   * (`laneSpan`) — each sample joined
   * straight to the next where it is a display frame on (`joined` — the
   * samples come at Spice Lite's display frames while a node moves, so the
   * joins draw its curve), and otherwise held to the next sample's moment and
   * stepped there: a switch thrown after a quiet second is a step, not a
   * second-long ramp. A column with no volts
   * (the net was not a node then) steps at its level as `#netLane` would, and
   * a voltage is HELD across its column where the trace turns digital or ends.
   * A flat stretch adds only its ends, so a long trace stays short.
   */
  #voltsPath(channelId, { highY, lowY, yFor }) {
    const [bottom, top] = this.#spanOf(channelId);
    const yOfVolts = (v) =>
      lowY -
      Math.max(0, Math.min(1, (v - bottom) / (top - bottom))) * (lowY - highY);
    const cols = this.#recorder.columns();
    const times = this.#axis?.times ?? columnTimes(cols);
    const voltsOf = (k) => cols[k]?.volts?.get(channelId) ?? null;
    // A column's level, or undefined for one that is not a level column (a
    // voltage, or off either end) — never equal to a real level, null included.
    const levelOf = (k) => {
      if (!cols[k] || voltsOf(k) != null) return undefined;
      return cols[k].cells.get(channelId) ?? null;
    };
    let d = "";
    const to = (x, y) => {
      d += d ? ` L ${x} ${y}` : `M ${x} ${y}`;
    };
    cols.forEach((col, k) => {
      const x0 = this.#xOf(col.tick);
      const x1 = this.#xOf(col.tick + 1);
      const v = voltsOf(k);
      if (v != null) {
        // A sample is a point where the trace starts or moves — held at the
        // last voltage to here first, unless the two are one curve — or where
        // a flat stretch ends and the line leaves straight for the next.
        const prev = voltsOf(k - 1);
        const next = voltsOf(k + 1);
        if (prev == null) to(x0, yOfVolts(v));
        else if (prev !== v) {
          if (!joined(times, k)) to(x0, yOfVolts(prev));
          to(x0, yOfVolts(v));
        } else if (next != null && next !== v && joined(times, k + 1)) {
          to(x0, yOfVolts(v));
        }
        if (next == null) to(x1, yOfVolts(v));
        return;
      }
      const level = levelOf(k);
      if (levelOf(k - 1) !== level) to(x0, yFor(level));
      if (levelOf(k + 1) !== level) to(x1, yFor(level));
    });
    return d;
  }

  /** A voltage lane's span, volts (`laneSpan`): 0 V to the run's full
      scale, widened to what the channel itself went past. */
  #spanOf(channelId) {
    return laneSpan(
      this.#recorder.fullScale || DEFAULT_FULL_SCALE,
      this.#recorder.rangeOf(channelId),
    );
  }

  /** A bus value-lane: a hex-labelled band with a crossover at each change. */
  #busLane(runs, laneIndex, { color, colorOf, fontOf = (f) => f }) {
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
                // SVG user units, as the lane geometry is.
                font: `10px ${fontOf("var(--font-mono)")}`,
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

  #formatCell(ch, cell, volts = null) {
    if (volts != null) {
      // Two places always, so the readout does not jitter as a node moves.
      return t("scope.volts", {
        volts: formatNumber(volts, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
      });
    }
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
    // The time between the two columns is each one's OWN simulated moment
    // (the tick's `at`), never ticks × a guessed tick length: a column is any
    // tick — an edge of any clock, a PWM's short half, an input, a timer's
    // wake, a display frame — so no one figure converts the two.
    const a = this.#recorder.atOf(this.#cursorA);
    const b = this.#recorder.atOf(this.#cursorB);
    const msPart =
      a != null && b != null
        ? ` · ${formatNumber(Math.abs(b - a) * 1000, { maximumSignificantDigits: 4 })} ms` // prettier-ignore
        : "";
    // Δ is a glyph; only the tick plural and the separator are catalog text.
    this.#delta.textContent = `Δ ${t("scope.tickCount", { count: dTicks })}${msPart}`;
  }

  // ── Cursors ─────────────────────────────────────────────────────────────────

  #tickFromEvent(e) {
    // The svg is the drawn window, so its own x is that far into the track.
    const x = this.#win.x0 + (e.offsetX ?? 0);
    const k = this.#axis ? columnAtX(this.#axis.xs, x) : 0;
    const tick = this.#recorder.firstTick + k;
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
    // Scrolled past what was drawn: draw the stretch now on screen.
    const left = this.#lanes.scrollLeft;
    const { x0, x1 } = this.#win;
    if (left < x0 || left + this.#lanes.clientWidth > x1) {
      if (this.visible) this.#scheduleRender();
    }
  }

  // ── The timing scale (− / + / Fit, ⌘/Ctrl+wheel) ────────────────────────────

  /**
   * One ladder step coarser (`dir` 1) or finer (-1), about the screen x `px`
   * into the lanes — by default the live edge while following, else the
   * middle — so what was under it stays under it.
   */
  #zoomBy(dir, px = null) {
    const axis = this.#axis;
    if (axis?.mode !== "timing") return;
    const next = stepSecPerDiv(axis.secPerDiv, dir, axis.floor);
    if (next === axis.secPerDiv) return;
    const view = this.#lanes.clientWidth;
    const at = px ?? (this.#follow ? view : view / 2);
    this.#anchor = { t: (this.#lanes.scrollLeft + at) / axis.pxPerSec, px: at };
    this.#secPerDiv = next;
    this.#render();
  }

  /** Back to fitting the whole trace in the panel, following the live edge. */
  #fit() {
    this.#secPerDiv = null;
    this.#follow = true;
    this.#render();
  }

  /** ⌘/Ctrl+wheel (a trackpad pinch arrives as one) zooms about the pointer;
      a plain wheel still scrolls the lanes. */
  #onWheel(e) {
    if (this.#axisMode !== "timing" || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    this.#wheelAcc += e.deltaY;
    if (Math.abs(this.#wheelAcc) < WHEEL_STEP) return;
    const dir = Math.sign(this.#wheelAcc);
    this.#wheelAcc = 0;
    const px = e.clientX - this.#lanes.getBoundingClientRect().left;
    this.#zoomBy(dir, px);
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
    // A file has no stylesheet: a font left as var(--…) is no font at all.
    const font = (f) => this.#resolveToken(f, "sans-serif");
    const labelW = 150;
    this.#axis = this.#axisOf(channels);
    // The whole trace at the scale on screen — or, where that is wider than
    // an image can sensibly be (a fine scale over a long run), what is on
    // screen.
    const trackW = Math.max(1, Math.ceil(this.#axis?.width ?? 0));
    const left = this.#lanes.scrollLeft;
    const view = this.#lanes.clientWidth || trackW;
    const win =
      trackW <= EXPORT_MAX_PX
        ? { x0: 0, x1: trackW }
        : { x0: left, x1: Math.min(trackW, left + view) };
    const lanesW = Math.max(1, win.x1 - win.x0);
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
              font: `12px ${font("var(--font-sans)")}`,
            },
          },
          this.#labelOf(ch),
        ),
      );
    });
    const lanes = svg("g", {
      transform: `translate(${labelW - win.x0}, 0)`,
    });
    const shown = this.#win;
    this.#win = win;
    try {
      for (const node of this.#buildLaneNodes(channels, {
        height,
        colorOf: resolve,
        fontOf: (f) => this.#resolveToken(f, "monospace"),
      })) {
        lanes.append(node);
      }
    } finally {
      this.#win = shown;
    }
    // The lanes clipped to their own column, clear of the labels.
    const clipId = "scope-export-lanes";
    root.append(
      svg("defs", {}, [
        svg("clipPath", { id: clipId }, [
          svg("rect", { x: labelW, y: 0, width: lanesW, height }),
        ]),
      ]),
      svg("g", { "clip-path": `url(#${clipId})` }, [lanes]),
    );
    return root;
  }

  /** Resolve a `var(--token)` to its computed value; pass other colors through. */
  #resolveColor(color) {
    return this.#resolveToken(color, "#888888");
  }

  /** A `var(--token)` as the value it has here (a colour, a font stack), or
      `fallback` when it has none; any other value as it is. */
  #resolveToken(value, fallback) {
    if (typeof value !== "string") return fallback;
    const m = /^var\((--[\w-]+)\)$/.exec(value.trim());
    if (!m) return value;
    const v = getComputedStyle(this.#el).getPropertyValue(m[1]).trim();
    return v || fallback;
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

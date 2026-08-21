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

// desk-controller.js — the single owner of everything ON the desk: it holds
// the in-memory DeskDoc, creates the four surface layers (boards → parts →
// wires → overlay), mounts/removes the board/part/PSU views + the wire
// layer, and runs the desk interactions — placement modes with snapping
// ghosts (boards, chips, discretes, PSU bricks), the click-click wire tool,
// select / drag / delete for everything, right-click menus, and hover
// addressing for holes, part pins, and PSU terminals (holeAt / derived-pin
// math — never per-hole or per-pin DOM). Every document mutation flows
// through desk-doc and is announced with a `chiphippo:doc-changed`
// CustomEvent; interactive part state (switch flips) also announces
// `chiphippo:part-state`.
//
// Views report gestures through constructor callbacks (house rule); the
// camera stays DeskView's job — this class only reads worldFromEvent/camera.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import { PX_PER_UNIT, clampZoom } from "../desk/desk-geometry.js";
import { ROTATIONS, columnAt, parseHole, spec } from "../model/breadboard.js";
import { holeAtWorld } from "../model/occupancy.js";
import { partSeatAt } from "../model/seating.js";
import {
  addressWorld,
  boardsInRect,
  componentPoints,
  componentsInRect,
  deskBounds,
  hoverHitAt,
  partPinsWorld,
  wiresInRect,
} from "../model/part-geometry.js";
import { clusterDelta } from "../model/cluster-move.js";
import {
  DeskDoc,
  WIRE_COLORS,
  WIRE_LAYOUTS,
  busWidthForKey,
} from "../model/desk-doc.js";
import { isToggleSelectEvent } from "../model/selection-toggle.js";
import { wireRunMm } from "../model/wire-length.js";
import { HistoryStore } from "../model/history-store.js";
import { partDef } from "../catalog/index.js";
import { kitLabel, partTitle } from "../catalog/labels.js";
import { isMemory, isRomChip, memoryConfig } from "../sim/chip-eval.js";
import { BreadboardView } from "./breadboard-view.js";
import { ChipView, buildChipSvg } from "./chip-view.js";
import { DiscreteView, buildDiscreteSvg } from "./discrete-view.js";
import { PsuView } from "./psu-view.js";
import { ClockView } from "./clock-view.js";
import { LcdView } from "./lcd-view.js";
import { WireLayer } from "./wire-layer.js";
import { PartPropertiesDialog } from "./part-properties-dialog.js";
import { AnnotationLayer } from "./annotation-layer.js";
import { SimOverlay } from "./sim-overlay.js";
import { ProbeInspector } from "./probe-inspector.js";
import { WireTools } from "./wire-tools.js";
import { BusTools } from "./bus-tools.js";
import { beginPointerGesture, releaseWorld } from "./pointer-gesture.js";
import { DeskSelection } from "./desk-selection.js";
import { DeskPlacement } from "./desk-placement.js";

/** Which platform's additive-select modifier the desk answers to — ⌘ on
    macOS, Ctrl elsewhere. See model/selection-toggle.js for why Ctrl cannot be
    it on a Mac. Read once, as every other platform-glyph site does. */
const IS_MAC = globalThis.window?.chiphippo?.platform === "darwin";

/** A non-volatile memory chip's backing-file size in bytes (address space ×
    bytes-per-word), used when provisioning its `.bin` on placement. */
function memByteLength(def) {
  const { size, width } = memoryConfig(def);
  return size * (width > 8 ? 2 : 1);
}

/** The DIP-switch position a pointer landed on, or null (the body, or a
    non-bank part). The view stamps `data-switch-index` on each actuator and
    binds no listener of its own — a bank position is a durable param, so the
    CONTROLLER owns the write; this is where a raw event becomes an index. */
function switchIndexFromEvent(e) {
  const hit = e?.target?.closest?.("[data-switch-index]");
  if (!hit) return null;
  const i = Number(hit.dataset.switchIndex);
  return Number.isInteger(i) && i >= 0 ? i : null;
}

/** Pointer travel (px) below which a press stays a click, not a drag/pan. */
const DRAG_THRESHOLD = 4;

/** Hover addressing: dwell before the ring/tooltip shows, and the zoom floor
    below which holes are too small for hover to mean anything. */
const HOVER_DWELL_MS = 150;
const HOVER_MIN_ZOOM = 0.75;

/** Radius of the hover ring (pitch units — a shade over one hole): the "it
    lands here" marker a drag shows over the hole it would drop on. Keep 2×
    this in step with `.hole-ring`'s diameter in app.css — this is what the
    ring is offset by to centre it, so a mismatch reads as a ring sitting a
    pixel off the target rather than as anything obviously broken. */
const RING_RADIUS = 0.55;

/** World-unit margin fitToScreen() leaves around the desk's bounds, so the
    outermost board/part/wire doesn't sit flush against the viewport edge. */
const FIT_PAD = 4;

/** How close (pitch units) the cursor must press to a wire's endpoint cap to
    grab it for a drag-the-end gesture. A shade over one hole so the cap is
    forgiving to catch, but under the ~1-pitch hole spacing so an adjacent
    endpoint isn't grabbed by mistake. */
const WIRE_END_GRAB_RADIUS = 0.6;

/**
 * Does a plain click on this part flip a durable param? DERIVED from the
 * catalog — a part is click-toggling exactly when its def declares how to do
 * it (`clickToggle`, parts.js) — and never from a list of refs kept here.
 *
 * It WAS such a list, and a list is how a rule falls silently behind: the six
 * refs in it had to be remembered alongside the three-way `ref ===` ladder
 * that computed the patch, in a VIEW, in a codebase whose catalog rule is that
 * part behaviour is data. Add a seventh switch and a miss in either place is
 * invisible — the part simply does nothing under the finger, with no error to
 * follow. This is the same correction `#dragGestureActive` already made for
 * "is a drag in flight?" one class over.
 *
 * Such a part stays interactive while the sim RUNS, which is the other half of
 * why the answer must be reliable: a held-down button is momentary and has no
 * durable param, so it is deliberately not one of these.
 */
function clickTogglingPart(ref) {
  return typeof partDef(ref)?.clickToggle === "function";
}

export class DeskController {
  #viewport;
  #deskView;
  #doc;
  #layers;
  #views = new Map(); // boardId → BreadboardView
  #partViews = new Map(); // componentId → ChipView | DiscreteView | PsuView
  #wireLayer;
  #annotationLayer; // AnnotationLayer: labels + notes (Feature 120)
  // Active interaction: null, or
  //   { kind: "place", type, ghost, pos, legal }              (board)
  //   { kind: "place-chip", ref, ghost, board, anchor, legal }
  //   { kind: "place-part", ref, params, ghost, board, anchor, legal }
  //   { kind: "place-brick", ref, params, ghost, pos, legal }   (PSU / clock)
  //   { kind: "drag", id, … }                                 (board drag)
  //   { kind: "drag-part", id, … }                            (chip/discrete)
  //   { kind: "drag-brick", id, … }
  //   { kind: "drag-cluster", grabId, members, … }            (a multi-selection)
  //   { kind: "place-annotation", annKind, ghost, pos, anchor } (label / note)
  //   { kind: "drag-annotation", id, … }                      (label / note)
  //   { kind: "wire", from, hover }                           (wire tool)
  #mode = null;
  #wire; // WireTools: the wire tool + endpoint/whole-wire drags (shares #mode)
  #bus; // BusTools: the bus tool + whole-bus drag (Feature 130, shares #mode)
  #busName = "D[7:0]"; // the name the bus tool reads (the toolbar badge/digits)
  #defaultWireLayout = "direct"; // what a NEW wire gets (Settings ▸ Appearance)
  #lastDown = null; // last viewport pointerdown client pos (click-vs-pan)
  #hoverKey = null; // hover identity currently shown or pending
  #hoverTimer = null;
  #ring;
  #tooltip;
  #sel; // DeskSelection: what is picked, plus the outline + ride-preview
  #place; // DeskPlacement: every ghost, the copy buffers, and the drops
  #probe; // ProbeInspector: netlist highlight + net-status readout
  // Simulation (Feature 90): editing is locked while running; live net levels
  // arrive over chiphippo:sim-state and drive LEDs / chip badges / probe tint.
  #editingLocked = false;
  #marquee = null; // the rubber-band element while shift-dragging
  #simOverlay; // live LEDs / badges / clock lamps + net-level lookups
  // Undo/redo (Feature 200): a bounded snapshot history the doc-changed choke
  // point feeds. `#restoring` suppresses re-recording while a restore replays.
  #history = new HistoryStore();
  #restoring = false;
  #onHistoryChange;
  #onClockToggle;
  #onOpenPinout;
  #onOpenMemory;
  #onProgramMemory;
  #onCreateMemoryFile;
  #onRemoveMemoryFile;
  #onBusNameChange;
  #onWireFadeChange;

  /**
   * @param {object} opts
   * @param {HTMLElement} opts.viewport - the `.desk-viewport` element.
   * @param {object} opts.deskView - DeskView (or a stub with `surface`,
   *   `camera`, and `worldFromEvent(e)`).
   * @param {import('../model/desk-doc.js').DeskDoc} opts.deskDoc
   * @param {(state: {armed: boolean, color: string}) => void}
   *   [opts.onWireStateChange] - wire-tool arm/disarm/color changes (drives
   *   the toolbar button + swatch strip).
   * @param {(state: {armed: boolean}) => void} [opts.onProbeStateChange] -
   *   probe-tool arm/disarm (drives the toolbar probe button).
   * @param {(state: {faded: boolean}) => void} [opts.onWireFadeChange] - the
   *   wire fade toggled (drives the toolbar button + persists the setting);
   *   fires on every setWiresFaded, including the initial apply at startup.
   * @param {(id: string) => void} [opts.onClockToggle] - a manual clock's
   *   click-to-toggle while running (Feature 100).
   * @param {(ref: string, rows: number, rot?: number, kind?: string) => void} [opts.onOpenPinout] -
   *   a part's (or a wire's) context-menu "Pin Assignment" item requests its
   *   pin-assignments window (main opens a native OS window); `rot` is the
   *   part's placed rotation, a snapshot only an oscillator can's corner-
   *   assignment layout uses; `kind: "wire"` (passed through the WireTools
   *   host) tells main to skip catalog resolution — a wire's `ref` is just
   *   its own id.
   * @param {(id: string) => void} [opts.onOpenMemory] - open the memory
   *   inspector window for a memory chip (its own context-menu item,
   *   Feature 190).
   * @param {(id: string) => void} [opts.onProgramMemory] - run the in-app
   *   external programmer for a ROM chip (pick a `.bin`/`.hex` → its file).
   * @param {(guid: string, byteLength: number) => void} [opts.onCreateMemoryFile]
   *   - create a ROM chip's backing file on placement (noise-filled).
   * @param {(guid: string) => void} [opts.onRemoveMemoryFile] - delete a ROM
   *   chip's backing file on removal.
   * @param {(state: {canUndo: boolean, canRedo: boolean}) => void}
   *   [opts.onHistoryChange] - undo/redo availability changed (drives the
   *   Edit-menu enable state, Feature 200).
   */
  constructor({
    viewport,
    deskView,
    deskDoc,
    onWireStateChange,
    onBusStateChange,
    onBusNameChange,
    onProbeStateChange,
    onWireFadeChange,
    onAddNetToAnalyzer,
    onClockToggle,
    onOpenPinout,
    onOpenMemory,
    onProgramMemory,
    onCreateMemoryFile,
    onRemoveMemoryFile,
    onHistoryChange,
    netlist,
  }) {
    this.#viewport = viewport;
    this.#deskView = deskView;
    this.#doc = deskDoc;
    this.#onClockToggle = onClockToggle;
    this.#onOpenPinout = onOpenPinout;
    this.#onOpenMemory = onOpenMemory;
    this.#onProgramMemory = onProgramMemory;
    this.#onCreateMemoryFile = onCreateMemoryFile;
    this.#onRemoveMemoryFile = onRemoveMemoryFile;
    this.#onHistoryChange = onHistoryChange;
    this.#onBusNameChange = onBusNameChange;
    this.#onWireFadeChange = onWireFadeChange;

    // Layer order (established for every later stage): boards under parts
    // under wires under the interaction overlay. All are zero-size anchors —
    // children position absolutely in world px.
    const surface = deskView.surface;
    this.#layers = {
      boards: el("div", { class: "layer-boards" }),
      parts: el("div", { class: "layer-parts" }),
      wires: el("div", { class: "layer-wires" }),
      annotations: el("div", { class: "layer-annotations" }),
      overlay: el("div", { class: "layer-overlay" }),
    };
    surface.append(
      this.#layers.boards,
      this.#layers.parts,
      this.#layers.wires,
      this.#layers.annotations,
      this.#layers.overlay,
    );

    // Hover ring + address tooltip live in the overlay (inert to pointers).
    this.#ring = el("div", { class: "hole-ring", hidden: true });
    this.#tooltip = el("div", { class: "desk-tooltip", hidden: true });
    this.#layers.overlay.append(this.#ring, this.#tooltip);

    // What is SELECTED (components/desk-selection.js), and the two overlays
    // that are pure functions of it: the board highlighter and the Option-drag
    // ride preview. Same host arrangement as WireTools / BusTools below —
    // built early because the wire layer's own callbacks reach it.
    const sel = this;
    this.#sel = new DeskSelection(
      {
        get doc() {
          return sel.#doc;
        },
        get mode() {
          return sel.#mode;
        },
        get editingLocked() {
          return sel.#editingLocked;
        },
        get boardViews() {
          return sel.#views;
        },
        get partViews() {
          return sel.#partViews;
        },
        get wireLayer() {
          return sel.#wireLayer;
        },
        get annotationLayer() {
          return sel.#annotationLayer;
        },
        addressWorld: (address) => this.#addressWorld(address),
      },
      this.#layers.overlay,
    );

    // Every placement ghost, the ⌘C buffers and the drops
    // (components/desk-placement.js) — the same host arrangement as the
    // selection above and WireTools / BusTools below.
    this.#place = new DeskPlacement(
      {
        get doc() {
          return sel.#doc;
        },
        get mode() {
          return sel.#mode;
        },
        set mode(v) {
          sel.#mode = v;
        },
        get editingLocked() {
          return sel.#editingLocked;
        },
        get selection() {
          return sel.#sel;
        },
        get ring() {
          return sel.#ring;
        },
        deskView,
        viewport,
        hideHover: () => this.#hideHover(),
        deselect: () => this.deselect(),
        disarmWireTool: () => this.disarmWireTool(),
        disarmBusTool: () => this.disarmBusTool(),
        disarmProbe: () => this.disarmProbe(),
        emitDocChanged: (label) => this.#emitDocChanged(label),
        mountBoard: (board) => this.#mountBoard(board),
        mountPart: (comp) => this.#mountPart(comp),
        provisionMemory: (comp) => this.#provisionMemory(comp),
        mateStrips: (ids) => this.#mateStrips(ids),
        partSeatAt: (w, ref, cols, params) =>
          this.#partSeatAt(w, ref, cols, params),
        holeAtWorld: (w) => this.#holeAtWorld(w),
        // An ANNOTATION ghost is armed by the annotation code below but tracked
        // through the one dispatcher, so placement hands that one kind back.
        trackAnnotationGhost: (e) => this.#trackAnnotationGhost(e),
      },
      this.#layers.overlay,
    );

    // All wires render into one SVG in the wires layer.
    this.#wireLayer = new WireLayer(this.#layers.wires, deskDoc, {
      // A wire and a bus are ordinarily CLICKED rather than pressed, but the
      // additive chord is answered on the PRESS (the viewport dispatcher), so
      // that every kind toggles at the same moment a part and a board do.
      // These two therefore only have to stand down for it — the click that
      // still follows would otherwise replace the selection just toggled.
      onSelect: (id, e) => {
        if (!isToggleSelectEvent(e, IS_MAC)) this.selectWire(id);
      },
      onContextMenu: (id, e) => this.#wire.onContextMenu(id, e),
      onHover: (id) => this.#probe.onWireHover(id),
      onSelectBus: (id, e) => {
        if (!isToggleSelectEvent(e, IS_MAC)) this.selectBus(id);
      },
      onBusContextMenu: (id, e) => this.#bus.onContextMenu(id, e),
    });

    // Labels + notes (Feature 120): one renderer over the annotations layer,
    // between wires and the interaction overlay.
    this.#annotationLayer = new AnnotationLayer(
      this.#layers.annotations,
      deskDoc,
      {
        onPointerDown: (id, e) => this.#onAnnotationPointerDown(id, e),
        onContextMenu: (id, e) => this.#onAnnotationContextMenu(id, e),
        onEditCommit: (id, text) => this.#commitAnnotationText(id, text),
      },
    );

    // Live simulation state (Feature 90): LEDs, chip badges, clock lamps —
    // and the net-level lookups the probe tints with. Renders from published
    // state, never the engine.
    this.#simOverlay = new SimOverlay(this.#doc, this.#partViews);

    // Connectivity inspector (Feature 70): owns its netlist cache + net
    // highlight; borrows the shared hover ring and the controller's geometry.
    this.#probe = new ProbeInspector({
      doc: deskDoc,
      netlist,
      overlay: this.#layers.overlay,
      viewport,
      ring: this.#ring,
      simOverlay: this.#simOverlay,
      hitTest: (world) => this.#hitTest(world),
      addressWorld: (address) => this.#addressWorld(address),
      onStateChange: onProbeStateChange,
      onNameNet: (address, name, stale) => this.nameNet(address, name, stale),
      onClearNetNames: (addresses) => this.clearNetNames(addresses),
      onAddToScope: onAddNetToAnalyzer
        ? (address) => onAddNetToAnalyzer(address)
        : null,
      coordinate: {
        cancelPlacement: () => this.cancelPlacement(),
        disarmWireTool: () => this.disarmWireTool(),
        disarmBusTool: () => this.disarmBusTool(),
        deselect: () => this.deselect(),
        hideHover: () => this.#hideHover(),
      },
    });

    // Wire subsystem (Feature 50): the click-click tool + endpoint/whole-wire
    // drags. It shares the controller's `#mode` through this host so the
    // viewport dispatcher's mode checks are unchanged.
    const self = this;
    this.#wire = new WireTools({
      get mode() {
        return self.#mode;
      },
      set mode(v) {
        self.#mode = v;
      },
      get editingLocked() {
        return self.#editingLocked;
      },
      get probeArmed() {
        return self.#probe.armed;
      },
      get defaultWireLayout() {
        return self.#defaultWireLayout;
      },
      doc: deskDoc,
      deskView,
      viewport,
      wireLayer: this.#wireLayer,
      ring: this.#ring,
      emitDocChanged: (label) => this.#emitDocChanged(label),
      hideHover: () => this.#hideHover(),
      selectWire: (id) => this.selectWire(id),
      deselect: () => this.deselect(),
      cancelPlacement: () => this.cancelPlacement(),
      disarmProbe: () => this.disarmProbe(),
      disarmBusTool: () => this.disarmBusTool(),
      clearSelectionIfWire: (id) => this.#sel.clearIfWire(id),
      onStateChange: onWireStateChange,
      // The uniform Pin Assignment / Properties… context-menu pair — the
      // dialogs themselves stay centralized in DeskController (same as every
      // other part/board), threaded through like emitDocChanged/selectWire.
      onOpenPinout: (id) => this.#onOpenPinout?.(id, 2, undefined, "wire"),
      onOpenProperties: (id) => this.#onOpenWireProperties(id),
    });

    // Bus subsystem (Feature 130): the bus tool + whole-bus drag + its context
    // menu. Like WireTools it shares `#mode` through this host; the bus color
    // rides the shared wire-color pick and the name comes from the toolbar
    // input (which drives `#busName` through setBusName).
    this.#bus = new BusTools({
      get mode() {
        return self.#mode;
      },
      set mode(v) {
        self.#mode = v;
      },
      get editingLocked() {
        return self.#editingLocked;
      },
      get probeArmed() {
        return self.#probe.armed;
      },
      get busName() {
        return self.#busName;
      },
      get busColor() {
        return self.#wire.color;
      },
      doc: deskDoc,
      deskView,
      viewport,
      wireLayer: this.#wireLayer,
      ring: this.#ring,
      // A bus lands `width` leads at once, so it rings a SET of holes rather
      // than the one shared ring — it needs the overlay layer to draw them in.
      overlay: this.#layers.overlay,
      emitDocChanged: (label) => this.#emitDocChanged(label),
      hideHover: () => this.#hideHover(),
      selectBus: (id) => this.selectBus(id),
      deselect: () => this.deselect(),
      cancelPlacement: () => this.cancelPlacement(),
      disarmProbe: () => this.disarmProbe(),
      disarmWireTool: () => this.disarmWireTool(),
      clearSelectionIfBus: (id) => this.#sel.clearIfBus(id),
      onStateChange: onBusStateChange,
    });

    // A pinned net follows its anchor through edits, switch flips, and each
    // sim tick (the probe self-guards when nothing is pinned).
    window.addEventListener("chiphippo:doc-changed", () =>
      this.#probe.refreshPinned(),
    );
    window.addEventListener("chiphippo:part-state", () =>
      this.#probe.refreshPinned(),
    );
    window.addEventListener("chiphippo:sim-state", (e) => {
      this.#simOverlay.apply(e.detail);
      this.#probe.refreshPinned(); // re-tint a pinned net
    });

    for (const board of this.#doc.boards) this.#mountBoard(board);
    for (const component of this.#doc.components) this.#mountPart(component);

    // Seed the undo history with the loaded document as the baseline — a fresh
    // document (New/Open reload) starts a fresh, single-entry history.
    this.#history.clear(this.#doc.snapshot());
    this.#notifyHistoryState();

    viewport.addEventListener("pointerdown", this.#onViewportPointerDown);
    viewport.addEventListener("pointermove", this.#onViewportPointerMove);
    viewport.addEventListener("pointerleave", () => this.#hideHover());
    viewport.addEventListener("click", this.#onViewportClick);
    // Right-click while probing names the net under the cursor; while wiring it
    // cancels the pending wire (Esc-equivalent).
    viewport.addEventListener("contextmenu", (e) => {
      if (this.#probe.armed) {
        e.preventDefault();
        this.#probe.onContextMenu(this.#deskView.worldFromEvent(e), e);
        return;
      }
      if (this.#wire.armed) {
        e.preventDefault();
        this.#wire.cancelPending();
        return;
      }
      if (this.#bus.armed) {
        e.preventDefault();
        this.#bus.cancelPending();
      }
    });
  }

  get selectedId() {
    return this.#sel.single?.id ?? null;
  }

  /** Whether a placement ghost is in hand. DERIVED from the mode's own name
      (`DeskPlacement.armed`), never a hand-kept list of the seven `place*`
      kinds — the same correction `#dragGestureActive` below already made, and
      for the same reason: a list falls silently behind the eighth kind. */
  get placementArmed() {
    return this.#place.armed;
  }

  /**
   * True while a direct-manipulation pointer drag is in flight — its pointer is
   * captured and a pending pointerup will commit + tear it down. A tool-arm
   * (W/B), copy/paste, or delete shortcut must NOT run here: it would overwrite
   * #mode out from under that pointerup, orphaning the capture + listeners and
   * freezing the dragged item in its grabbed visual state.
   *
   * DERIVED FROM THE NAME, never a hand-kept list. It WAS a list, and it fell
   * silently behind: `WireTools` mints its own kinds in its own module, so when
   * routed wires added `drag-wire-point` this answered false for a live drag —
   * Escape stopped cancelling a bend, `#rebuildScene` stopped killing one (an
   * undo mid-bend left the gesture alive to commit into the swapped document),
   * and the shortcut guard below stopped applying. Every drag anywhere in the
   * app already names itself `drag…`; the marquee is the one that does not.
   */
  get #dragGestureActive() {
    const kind = this.#mode?.kind;
    return Boolean(
      kind === "marquee" || kind === "drag" || kind?.startsWith("drag-"),
    );
  }

  /**
   * Abort whichever direct-manipulation drag is in flight — Escape mid-drag,
   * and #rebuildScene pulling the dragged views out from under one. Routes a
   * synthetic `pointercancel` through the SAME up-handler the real pointer
   * event would reach — every one of them already treats
   * `e.type === "pointercancel"` as "tear down, revert, never commit" — so
   * this reuses that instead of duplicating the teardown here. It is also
   * exactly the shape `pointer-gesture.js` synthesizes for a yanked capture
   * or a lost window focus, which is what makes those paths need no special
   * case of their own. Without this, Escape used to only clear selection,
   * leaving the drag alive to commit the move anyway on the next pointerup.
   *
   * NOTE this used to double as the rescue for a release the browser never
   * delivered (a fast release, a focus change mid-drag, a capture lost with
   * no matching event — all observed in practice, not hypothetical). It no
   * longer has to: every gesture here now listens on `window` in the capture
   * phase via `beginPointerGesture`, so the release arrives whether or not
   * the capture held, and Escape is once again just Escape.
   *
   * The wire/bus gestures live in their own collaborator modules
   * (WireTools/BusTools), so they get a small public `cancelDrag()` each
   * instead of a private up-handler reference here.
   */
  #cancelDragGesture() {
    const m = this.#mode;
    if (!m) return;
    const fake = { type: "pointercancel", pointerId: m.pointerId };
    switch (m.kind) {
      case "drag":
        this.#onBoardPointerUp(fake);
        break;
      case "drag-part":
      case "drag-brick":
      case "drag-cluster":
      case "drag-resistor":
      case "drag-resistor-end":
        this.#onPartPointerUp(fake);
        break;
      case "drag-annotation":
        this.#onAnnotationPointerUp(fake);
        break;
      case "marquee":
        this.#onMarqueePointerUp(fake);
        break;
      case "drag-wire-end":
      case "drag-wire":
      case "drag-wire-point":
        this.#wire.cancelDrag();
        break;
      case "drag-bus":
        this.#bus.cancelDrag();
        break;
    }
  }

  // ── Selection ───────────────────────────────────────────────────────────
  // All of it lives in DeskSelection (components/desk-selection.js), including
  // the board highlighter and the Option-drag ride preview. What stays here is
  // the public surface the app and the views already call, delegated straight
  // through, so nothing outside this file learned that the selection moved.

  /** The component ids in the multi-selection (empty when none). */
  get multiSelectedIds() {
    return [...this.#sel.parts];
  }

  /** The wire ids in the multi-selection (empty when none). */
  get multiSelectedWireIds() {
    return [...this.#sel.wires];
  }

  /** The board ids in the multi-selection (empty when none). */
  get multiSelectedBoardIds() {
    return [...this.#sel.boards];
  }

  selectAll() {
    return this.#sel.selectAll();
  }

  selectBoard(id) {
    this.#sel.selectBoard(id);
  }

  selectComponent(id) {
    this.#sel.selectComponent(id);
  }

  selectWire(id) {
    this.#sel.selectWire(id);
  }

  selectBus(id) {
    this.#sel.selectBus(id);
  }

  selectAnnotation(id) {
    this.#sel.selectAnnotation(id);
  }

  deselect() {
    this.#sel.deselect();
  }

  /** ⌘/Ctrl-click a part or brick: in or out of the selection. */
  toggleComponentSelection(id) {
    this.#sel.toggleComponentSelection(id);
  }

  /** ⌘/Ctrl-click a wire: in or out of the selection. */
  toggleWireSelection(id) {
    this.#sel.toggleWireSelection(id);
  }

  /** ⌘/Ctrl-click a bus: its member WIRES go in or out together. */
  toggleBusSelection(id) {
    this.#sel.toggleBusSelection(id);
  }

  /** ⌘/Ctrl-click a board: the WHOLE snapped group goes in or out. */
  toggleBoardSelection(id) {
    this.#sel.toggleBoardSelection(id);
  }

  /** Option is down (or up) — see DeskSelection.setRidePreview for why this is
      pushed in from app.js rather than read off a keydown here. */
  setRidePreview(on) {
    this.#sel.setRidePreview(on);
  }

  // ── Placement modes (toolbar Add-board / palette picks) ─────────────────

  // ── Placement ───────────────────────────────────────────────────────────
  // The ghosts, the copy buffers and the drops live in DeskPlacement
  // (components/desk-placement.js). What stays here is the public surface the
  // app, the palette and the AI panel already call, delegated straight
  // through — plus `#partSeatAt`, which is NOT a placement concern: a part DRAG
  // resolves its seat with the same call.

  armPlacement(kit) {
    this.#place.armPlacement(kit);
  }

  armPartPlacement(ref, params = {}) {
    this.#place.armPartPlacement(ref, params);
  }

  armChipPlacement(ref, params = {}) {
    this.#place.armChipPlacement(ref, params);
  }

  cancelPlacement() {
    this.#place.cancelPlacement();
  }

  copySelectedComponent() {
    return this.#place.copySelectedComponent();
  }

  pasteComponent() {
    return this.#place.pasteComponent();
  }

  armGeneratedDesign(clip) {
    return this.#place.armGeneratedDesign(clip);
  }

  applyGeneratedDesign(clip, opts = {}) {
    return this.#place.applyGeneratedDesign(clip, opts);
  }

  /** Seat (board + anchor) for a part under the cursor — see model/seating.js. */
  #partSeatAt(world, ref, grabOffsetCols, params = null) {
    return partSeatAt(this.#doc.boards, ref, world, grabOffsetCols, params);
  }

  // ── Rotation while placing / dragging ───────────────────────────────────

  /** R spins the ghost/part in hand, and rotates a selected placed one. */
  #toggleResistorRotation() {
    const m = this.#mode;
    // Mid-drag: spin the end-to-end vector 90° about pin 1 and redraw at the
    // cursor's last position — free rotation while positioning.
    if (m?.kind === "drag-resistor") {
      // Negating a zero component yields -0, which would ride into the stored
      // bend and break value comparisons — fold it back.
      const dx = -m.orient.dy;
      m.orient = { dx: dx === 0 ? 0 : dx, dy: m.orient.dx };
      // A rotation counts as a real gesture even without pointer travel, so the
      // release commits (or reverts) instead of being treated as a plain click.
      if (!m.active) {
        m.active = true;
        this.#partViews.get(m.id)?.setDragging(true);
      }
      this.#trackResistorDrag();
      return true;
    }
    // Mid-drag of a chip: flip the slab in hand. Its footprint maps onto itself,
    // so the seat stays legal — the orientation rides along to the drop. Only
    // chips flip; a DIP-footprint display (bar array) is fixed anode-side-down.
    if (m?.kind === "drag-part" && partDef(m.ref)?.kind === "chip") {
      m.flip = !m.flip;
      if (!m.active) {
        m.active = true; // a flip alone still commits on release
        this.#partViews.get(m.id)?.setDragging(true);
      }
      const comp = this.#doc.getComponent(m.id);
      this.#partViews
        .get(m.id)
        ?.updateParams(this.#flippedParams(comp?.params, m.flip));
      return true;
    }
    // ANY other gesture in flight — dragging a non-rotatable part, a board, a
    // brick, a wire or one of its ends, rubber-banding, or wiring — swallows R
    // as a no-op. Falling through would rotate the part BEHIND the drag,
    // remounting its element and stranding the gesture mid-flight.
    if (m && !this.placementArmed) return false;
    // Placing a rail: R stands it on end (a quarter lap per press) so it can
    // run down the side of a board as a signal bus. Assembled kits hold a
    // pin-board and never turn.
    if (m?.kind === "place" && DeskDoc.canRotateKit(m.kit)) {
      m.rot = ROTATIONS[(ROTATIONS.indexOf(m.rot) + 1) % ROTATIONS.length];
      this.#place.renderBoardGhost(m);
      if (m.lastEvent) this.#place.trackBoardGhost(m.lastEvent);
      return true;
    }
    // Placing an assembled kit that carries its own rails: R leaves the
    // pin-board untouched and flips just the rail strips 180° in place —
    // same footprint (mating is unaffected), reversed +/- row order, for
    // users who want the opposite polarity nearest the pin-board. A toggle,
    // not a cycle: pressing R again restores the default order.
    if (m?.kind === "place" && DeskDoc.canFlipKitRails(m.kit)) {
      m.flipRails = !m.flipRails;
      this.#place.renderBoardGhost(m);
      if (m.lastEvent) this.#place.trackBoardGhost(m.lastEvent);
      return true;
    }
    // Placing a chip: R flips the ghost before it lands.
    if (m?.kind === "place-chip") {
      m.params = this.#flippedParams(m.params, true);
      m.ghost.querySelector("svg")?.remove();
      m.ghost.append(buildChipSvg(m.ref, m.params));
      return true;
    }
    // Placing an oscillator can: R spins the ghost a full quarter turn IN
    // PLACE (0/90/180/270, unlike the resistor's boolean toggle below) — the
    // ghost re-centres and its SVG is rebuilt since a full can's box isn't
    // square, so 90°/270° swap its bounding box.
    if (m?.kind === "place-part" && partDef(m.ref)?.can) {
      m.params = {
        ...m.params,
        rot: ROTATIONS[
          (ROTATIONS.indexOf(m.params.rot ?? 0) + 1) % ROTATIONS.length
        ],
      };
      m.ghost.querySelector("svg")?.remove();
      m.ghost.append(buildDiscreteSvg(m.ref, m.params));
      if (m.lastWorld) this.#place.trackSeatedGhostAt(m.lastWorld);
      return true;
    }
    // Placing a reversible linear discrete (the bussed resistor array): R turns
    // the ghost end-for-end. Same nine holes either way, so this can never make
    // the seat under the cursor illegal — it only decides which end the common
    // bus (and the dot marking it) lands on, which is the whole reason to press
    // it BEFORE dropping rather than after.
    if (m?.kind === "place-part" && partDef(m.ref)?.reversible) {
      m.params = { ...m.params, rot: m.params?.rot === 180 ? 0 : 180 };
      m.ghost.querySelector("svg")?.remove();
      m.ghost.append(buildDiscreteSvg(m.ref, m.params));
      if (m.lastWorld) this.#place.trackSeatedGhostAt(m.lastWorld);
      return true;
    }
    // Placing a rotatable part: R turns the ghost a quarter lap IN PLACE — the
    // placement stays armed, and the orientation carries into the drop. A pasted
    // ghost carries an explicit lead vector (m.orient), so spin THAT 90°
    // (pin 1 fixed); a palette pick rides the four cardinal turns.
    if (m?.kind === "place-part" && partDef(m.ref)?.rotatable) {
      if (m.orient) {
        // Fold -0 back to 0 so it never rides into the stored bend.
        const dx = -m.orient.dy;
        m.orient = { dx: dx === 0 ? 0 : dx, dy: m.orient.dx };
      } else {
        m.turns = ((m.turns ?? 0) + 1) % 4;
      }
      if (m.lastWorld) this.#place.trackSeatedGhostAt(m.lastWorld);
      return true;
    }
    // Not placing: rotate a selected placed part in situ (any DIP-packaged
    // part — a chip OR a package-footprint discrete like bar8iso — flips
    // 180°, and so does a `reversible` linear one; desk-doc.js's
    // rotateComponent gates on the def's shape, not on kind).
    if (this.#sel.single?.kind === "part") {
      const comp = this.#doc.getComponent(this.#sel.single.id);
      const def = partDef(comp?.ref);
      if (def?.rotatable || def?.can || def?.package || def?.reversible) {
        this.rotateComponent(this.#sel.single.id);
        return true;
      }
    }
    return false;
  }

  /** Params with the 180° flag toggled (or set) — chips only. */
  #flippedParams(params, toggle) {
    if (!toggle) return { ...params };
    return { ...params, rot: params?.rot === 180 ? 0 : 180 };
  }

  /**
   * The drag state for a placed resistor: it translates RIGIDLY (both ends
   * together, snapped to the 0.1-in lattice) and can be rotated freely mid-drag
   * with R. Returns null when its pins don't resolve (then a press just
   * selects). Works for both forms — the horizontal footprint and the two-end
   * span — since pin holes are always derived.
   *
   * OPTION CARRIES ITS WIRING HERE TOO. A body drag moves both leads by one
   * delta, which is the same rigid move a footprint part makes, so the ride rule
   * applies unchanged — and without this an LED carried its wiring as a member
   * of a selection but not when dragged on its own, which is one part with two
   * answers. The END drag (#resistorEndDragMode) deliberately carries nothing:
   * that lead lands at any hole, at any angle, on any strip, so there is no
   * column delta for a rider to follow.
   */
  #resistorDragMode(comp, ends, e, world) {
    const attached = e.altKey ? this.#doc.wiresRidingPart(comp.id) : [];
    const legs = e.altKey ? this.#doc.partsRidingPart(comp.id) : [];
    const riding = attached.length > 0 ? attached : null;
    const ridingParts = legs.length > 0 ? legs : null;
    return {
      kind: "drag-resistor",
      id: comp.id,
      ref: comp.ref,
      riding,
      ridingParts,
      checkBatch:
        riding || ridingParts
          ? this.#doc.prepareClusterMove({
              componentIds: [comp.id, ...legs.map((r) => r.id)],
              wireIds: attached.map((r) => r.wireId),
            })
          : null,
      plan: null,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startWorld: world,
      lastWorld: world, // re-rendered from this when R rotates mid-drag
      p1: { x: ends.a.x, y: ends.a.y }, // pin 1 at grab time
      orient: { dx: ends.b.x - ends.a.x, dy: ends.b.y - ends.a.y },
      origin: { board: comp.board, anchor: comp.anchor, params: comp.params },
      holes: null, // { boardId, one, two } while both ends land legally
      legal: false,
      active: false,
    };
  }

  /**
   * A board part's pins as `{ pin, address, x, y }`: the desk address each
   * lead resolves to and where it sits in the world.
   *
   * A rotated part's far lead is a `{dx, dy}` BEND, so its world position is
   * always derivable — but the hole it touches depends on what lies under it,
   * and `address` is null when that is bare desk (a FLOATING lead: legal, and
   * exactly what a part is left with when its rail is pulled away). Null
   * overall only when the part itself doesn't resolve.
   *
   * `boardOverride` substitutes a moved origin for the part's own board, so a
   * live board drag re-renders against the position under the cursor.
   */
  #partPins(comp, boardOverride = null) {
    // A live board drag substitutes a moved origin for the part's own board;
    // otherwise the document's boards are the truth. The world geometry itself
    // lives in model/part-geometry.js.
    const boards = boardOverride
      ? this.#doc.boards.map((b) =>
          b.id === comp.board ? { ...b, ...boardOverride } : b,
        )
      : this.#doc.boards;
    return partPinsWorld(boards, comp);
  }

  /**
   * A resistor's two ends as world points, derived from whichever form it's
   * stored in. Null when its pins don't resolve.
   */
  #resistorEndPoints(comp) {
    const pins = this.#partPins(comp);
    if (!pins || pins.length < 2) return null;
    return {
      boardId: comp.board,
      anchor: comp.anchor,
      a: { x: pins[0].x, y: pins[0].y },
      b: { x: pins[1].x, y: pins[1].y },
    };
  }

  /** Which end (if either) a press grabs — "a", "b", or null for the body. */
  #resistorEndAt(ends, world) {
    let best = null;
    let bestDist = WIRE_END_GRAB_RADIUS;
    for (const key of ["a", "b"]) {
      const p = ends[key];
      const dist = Math.hypot(world.x - p.x, world.y - p.y);
      if (dist <= bestDist) {
        best = key;
        bestDist = dist;
      }
    }
    return best;
  }

  /** Drag ONE end of a resistor to any free hole (wire-endpoint style); the
      other end stays put, so the span and angle are free to change. */
  #resistorEndDragMode(comp, ends, grabbed, e, world) {
    return {
      kind: "drag-resistor-end",
      id: comp.id,
      ref: comp.ref,
      boardId: comp.board,
      anchor: comp.anchor, // pin 1's seat, kept while only pin 2 moves
      moving: grabbed, // "a" (pin 1) or "b" (pin 2)
      fixed: ends[grabbed === "a" ? "b" : "a"],
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      lastWorld: world,
      origin: { board: comp.board, anchor: comp.anchor, params: comp.params },
      target: null, // { anchor, end } while the drop is legal
      legal: false,
      active: false,
    };
  }

  /** Live single-end drag: the moving lead snaps to a hole, the other stays. */
  // `d` defaults to the live drag, but the RELEASE passes its own copy — the
  // up-handler clears #mode before it re-resolves at the release point.
  #trackResistorEndDrag(d = this.#mode) {
    const hit = this.#holeAtWorld(d.lastWorld);
    d.target = null;
    let legal = false;
    if (hit) {
      // Pin 1 SEATS in a hole; pin 2 is a bend measured from it. So dragging
      // pin 1 re-seats the part (onto another strip if that's where it landed)
      // while dragging pin 2 only re-bends the lead — either way the pair is
      // rewritten as one anchor plus one offset.
      const movingA = d.moving === "a";
      const boardId = movingA ? hit.board.id : d.boardId;
      const anchor = movingA ? hit.hole : d.anchor;
      const from = movingA ? hit : d.fixed;
      const to = movingA ? d.fixed : hit;
      // Both points are resolved HOLES, so the bend is exactly the vector
      // between them — no rounding, or the lead would be drawn short of the
      // hole it landed in (a rail's rows are not on the pin-board's lattice).
      const end = { dx: to.x - from.x, dy: to.y - from.y };
      // canPlacePart enforces free + distinct + the minimum lead span.
      legal = this.#doc.canPlacePart(d.ref, boardId, anchor, {
        ignoreId: d.id,
        params: { rot: 90, end },
      });
      if (legal) d.target = { boardId, anchor, end };
    }
    d.legal = legal;
    // The moving end rides the snapped hole, else the raw cursor.
    const tip = hit ? { x: hit.x, y: hit.y } : d.lastWorld;
    const view = this.#partViews.get(d.id);
    view?.updateSpanWorld(
      d.moving === "a" ? tip : d.fixed,
      d.moving === "a" ? d.fixed : tip,
    );
    view?.setIllegal(!legal);
  }

  /** Live resistor drag: rigid lattice-snapped translation, both ends checked.
      Pin 1 seats in whatever hole it lands on; the lead keeps its bend, so the
      far end may reach a NEIGHBOURING strip's rail. */
  // `d` defaults to the live drag; see #trackResistorEndDrag. `preview` is off
  // on the RELEASE re-resolve: the handler has already put the riding-wire
  // preview away, and re-establishing it there would leave the committed wires
  // drawn as a drag that has ended.
  #trackResistorDrag(d = this.#mode, { preview = true } = {}) {
    // ONE delta moves both ends, so length and angle never change.
    //
    // TWO CANDIDATES FOR PIN 1, and the raw one is why a spanned run works.
    // Rounding the travel to whole pitches assumes a lattice, and there is only
    // one HORIZONTALLY: vertically the heights are MEASURED, so the next
    // pin-board of a spanned run sits 17.52 pitch down and a rounded dy lands
    // pin 1 0.48 off the hole it aimed at — past holeAt's 0.45 radius, so the
    // part could not be dropped on the other board AT ALL and its wiring never
    // went either. The raw point is where the part actually is, so it is tried
    // first; the rounded one is the fallback that keeps a same-board drag
    // exactly as it was, including the sliver between two rows where the raw
    // point is nearest to nothing. On one board the two always name the same
    // hole whenever either does.
    const tx = d.lastWorld.x - d.startWorld.x;
    const ty = d.lastWorld.y - d.startWorld.y;
    const snapped = { x: d.p1.x + Math.round(tx), y: d.p1.y + Math.round(ty) };
    const a =
      this.#holeAtWorld({ x: d.p1.x + tx, y: d.p1.y + ty }) ??
      this.#holeAtWorld(snapped);
    // Drawn from the HOLE it found, so the preview is the seat that will be
    // committed; over bare desk there is none, and it follows the cursor.
    const p1 = a ? { x: a.x, y: a.y } : snapped;
    const p2 = { x: p1.x + d.orient.dx, y: p1.y + d.orient.dy };
    // The bend is carried through a rigid translation untouched — rounding it
    // here would quietly re-bend a lead every time the part was dragged.
    const end = { dx: d.orient.dx, dy: d.orient.dy };
    // canPlacePart resolves the bent lead against the whole desk, so it is the
    // one authority on whether the far end found a free hole.
    const params = { rot: 90, end };
    let legal =
      Boolean(a) &&
      this.#doc.canPlacePart(d.ref, a.board.id, a.hole, {
        ignoreId: d.id,
        params,
      });
    d.holes = legal ? { boardId: a.board.id, anchor: a.hole, end } : null;
    // An Option-drag re-plans its riders for THIS position and checks the whole
    // batch as one, exactly as a footprint part's does — one refusal, one visual
    // language. Note the plan is told the FORM the part is landing in: a body
    // drag rewrites a footprint-form part into the two-free-ends one, and the
    // ride rule has to read the pins it will actually have.
    //
    // The plan is re-derived on EVERY sample, including the ones with nowhere to
    // land — that is what the null branch is for. This part is drawn at the raw
    // cursor whatever the position (unlike a footprint drag, which stops at its
    // last good seat), so leaving a stale plan in place left the riders frozen
    // at a hole the part had long since left: drag an LED over the gap between
    // two boards and its wiring simply stopped following it. With no plan they
    // draw from the DOCUMENT instead — where they actually are — in red, which
    // is the truth: nothing is moving.
    if (d.riding || d.ridingParts) {
      d.plan = d.holes
        ? this.#doc.planPartMove(d.id, {
            board: d.holes.boardId,
            anchor: d.holes.anchor,
            params,
            riding: d.riding,
            ridingParts: d.ridingParts,
          })
        : null;
      const placements = d.plan && [
        { id: d.id, board: d.holes.boardId, anchor: d.holes.anchor, params },
        ...d.plan.parts,
      ];
      if (!(d.plan?.resolved && d.checkBatch(placements, d.plan.moves))) {
        legal = false;
      }
    }
    d.legal = legal;
    const view = this.#partViews.get(d.id);
    view?.updateSpanWorld(p1, p2);
    view?.setIllegal(!legal);
    if (!preview) return;
    if (d.riding) this.#wireLayer.setPartDrag(this.#partDragPreview(d));
    if (d.ridingParts) this.#applyLeadRiders(d);
  }

  /** Rebuild a part's view from the document — the horizontal SVG and the
      two-end span differ, so a shape change needs a fresh mount. Also the
      canonical "snap back to where it was" after an illegal drop. */
  #remountPart(id) {
    const comp = this.#doc.getComponent(id);
    if (!comp) return;
    const selected =
      this.#sel.single?.kind === "part" && this.#sel.single.id === id;
    this.#partViews.get(id)?.remove();
    this.#partViews.delete(id);
    this.#mountPart(comp);
    if (selected) this.#partViews.get(id)?.setSelected(true);
  }

  /** Rotate a placed part in place — 90° for a rotatable two-lead part
      (resistor) or a square can (half-can oscillator); 180° for a non-square
      can (full-can oscillator), a DIP-packaged part (a chip, or a
      package-footprint discrete like bar8iso) or a `reversible` linear one
      (the bussed resistor array) — the last two its own inverse, since the
      footprint maps onto itself and only the pin numbering turns; see
      desk-doc.js. No-op if it can't fit (nothing free at the rotated
      position — a flip in place never fails). */
  rotateComponent(id) {
    try {
      this.#doc.rotateComponent(id);
    } catch {
      return; // nowhere free to rotate into — leave it as-is
    }
    this.#remountPart(id);
    this.#emitDocChanged("rotate part");
  }

  // ── Wire tool (Feature 50) ───────────────────────────────────────────────
  // The wire subsystem lives in WireTools; these are the public shims app.js /
  // keyboard drive it through. It shares `#mode` via the host in the ctor.

  get wireToolArmed() {
    return this.#wire.armed;
  }

  /** The color the next committed wire gets. */
  get wireColor() {
    return this.#wire.color;
  }

  /** Pin the next wire color (the toolbar swatch strip). */
  setWireColor(color) {
    this.#wire.setColor(color);
  }

  armWireTool() {
    this.#wire.arm();
  }

  disarmWireTool() {
    this.#wire.disarm();
  }

  toggleWireTool() {
    this.#wire.toggle();
  }

  /** Remove a wire; clears its selection. */
  removeWire(id) {
    this.#wire.removeWire(id);
  }

  /** Recolor a wire (context menu). */
  recolorWire(id, color) {
    this.#wire.recolorWire(id, color);
  }

  /** Are wires drawn as fading stubs? (the toolbar's Fade wires toggle) */
  get wiresFaded() {
    return this.#wireLayer.faded;
  }

  /**
   * Fade wires back to a short stub off each end so a crowded board stays
   * readable, or draw them in full again (see WireLayer#setFaded). Purely how
   * the desk is drawn — no document change — so it stays available while the
   * circuit runs.
   */
  setWiresFaded(on) {
    this.#wireLayer.setFaded(on);
    this.#onWireFadeChange?.({ faded: this.#wireLayer.faded });
  }

  /** Flip the wire fade; returns the new state. */
  toggleWiresFaded() {
    this.setWiresFaded(!this.wiresFaded);
    return this.wiresFaded;
  }

  // ── Bus tool (Feature 130) ───────────────────────────────────────────────
  // The bus subsystem lives in BusTools; these are the public shims app.js /
  // keyboard drive it through. The bus color rides the shared wire-color pick;
  // the name comes from the toolbar's width badge (or a digit key) via
  // setBusName.

  get busToolArmed() {
    return this.#bus.armed;
  }

  /** The name the bus tool will lay next (the toolbar badge shows its width). */
  get busName() {
    return this.#busName;
  }

  /** Update the bus name the tool reads (the toolbar badge's width picker or a
      digit key) — notifies onBusNameChange so the badge's glyph stays in sync
      regardless of which one drove the change. */
  setBusName(name) {
    const next = typeof name === "string" ? name : "";
    if (next === this.#busName) return;
    this.#busName = next;
    this.#onBusNameChange?.(next);
  }

  /**
   * The layout method a NEWLY laid wire gets (Settings ▸ Appearance ▸ "Wire
   * layout" — see WIRE_LAYOUTS). Like the default LED colour this is read at
   * placement time and applies to nothing already on the desk; an existing
   * wire's layout is its own Properties dialog's business. An unknown value
   * falls back to "direct" rather than refusing — a setting is not a command.
   */
  setDefaultWireLayout(layout) {
    this.#defaultWireLayout = WIRE_LAYOUTS.includes(layout) ? layout : "direct";
  }

  armBusTool() {
    this.#bus.arm();
  }

  disarmBusTool() {
    this.#bus.disarm();
  }

  toggleBusTool() {
    this.#bus.toggle();
  }

  /** Shared address→world resolver (the probe's highlight geometry). */
  #addressWorld(address) {
    return addressWorld(this.#doc.boards, this.#doc.components, address);
  }

  // ── Connectivity inspector / probe (Feature 70) ─────────────────────────
  // The probe subsystem lives in ProbeInspector; these are the public shims
  // app.js/keyboard drive it through.

  get probeArmed() {
    return this.#probe.armed;
  }

  /** Arm probe mode: hover highlights a net, click pins it. */
  armProbe() {
    this.#probe.arm();
  }

  disarmProbe() {
    this.#probe.disarm();
  }

  toggleProbe() {
    this.#probe.toggle();
  }

  /** Centre + scale the camera so every board, part, and wire fits on
      screen — how a lost component gets found again. The desk itself is
      recentred on the origin first (see #recentreDesk), so fitting is also
      how a design that has drifted is brought back to the middle of the
      coordinate space it lives in. */
  fitToScreen() {
    this.#recentreDesk();
    const bounds = deskBounds(
      this.#doc.boards,
      this.#doc.components,
      this.#doc.wires,
    );
    if (!bounds) return;
    const rect = this.#viewport.getBoundingClientRect();
    const wPitch = bounds.maxX - bounds.minX + 2 * FIT_PAD;
    const hPitch = bounds.maxY - bounds.minY + 2 * FIT_PAD;
    let zoom = 1;
    if (rect.width && rect.height && wPitch && hPitch) {
      const zx = rect.width / (wPitch * PX_PER_UNIT);
      const zy = rect.height / (hPitch * PX_PER_UNIT);
      zoom = clampZoom(Math.min(zx, zy, 1));
    }
    this.#deskView.setCamera({
      cx: (bounds.minX + bounds.maxX) / 2,
      cy: (bounds.minY + bounds.maxY) / 2,
      zoom,
    });
  }

  /**
   * Frame a desk that has JUST BEEN LOADED — the same recentre + fit ⌘F does,
   * but as part of the LOAD rather than as an edit sitting on top of it.
   *
   * A file may hold a design built anywhere in the coordinate space, so a
   * project (or an example desktop) that arrives is centred and framed before
   * the user ever sees it. That move is not theirs: it is the document as the
   * app understands it, exactly like a normalization or a migration brought
   * forward. So it is neither recorded (`#restoring`) nor left standing as the
   * first thing ⌘Z would undo — the history's present entry is re-baselined to
   * the recentred document instead. The caller clears the dirty flag for the
   * same reason (ProjectWorkspace's `#markClean`).
   */
  fitLoadedDesk() {
    this.#restoring = true;
    try {
      this.fitToScreen();
    } finally {
      this.#restoring = false;
    }
    this.#history.sync(this.#doc.snapshot());
  }

  /**
   * Slide the whole desk so what is on it straddles the origin — every board,
   * brick, and label by one integer delta (DeskDoc.translateAll), which is
   * rigid and so can neither refuse nor change what is mated to what.
   *
   * Fitting already centres the CAMERA on the design; centring the DESIGN
   * itself is what keeps a desk that has been panned and built across for a
   * long session from creeping ever further out, where the coordinates get
   * large enough to strain what everything downstream assumes. It is a real
   * document edit — one undo step, and it marks the project dirty — which is
   * why it is skipped while the sim is running (topology is frozen).
   */
  #recentreDesk() {
    if (this.#editingLocked) return;
    const bounds = deskBounds(
      this.#doc.boards,
      this.#doc.components,
      this.#doc.wires,
    );
    if (!bounds) return; // an empty desk is already centred
    const delta = this.#doc.translateAll(
      -(bounds.minX + bounds.maxX) / 2,
      -(bounds.minY + bounds.maxY) / 2,
    );
    if (delta.dx === 0 && delta.dy === 0) return; // already on the origin
    // Views hold their own position: boards and bricks move outright, seated
    // parts follow the board they sit on, and the wires re-derive from both.
    for (const board of this.#doc.boards) {
      this.#views.get(board.id)?.setPosition(board.x, board.y);
    }
    for (const comp of this.#doc.components) {
      const view = this.#partViews.get(comp.id);
      if (!view) continue;
      if (comp.board == null) view.setPosition(comp.x, comp.y);
      else this.#placePartView(view, comp, this.#doc.getBoard(comp.board));
    }
    this.#wireLayer.render();
    // Labels re-render from the document on doc-changed, which also re-traces
    // the board outline and records the move as one undo step.
    this.#emitDocChanged("recentre desk");
  }

  // ── Schematic view (Feature 150) ─────────────────────────────────────────
  // The derived schematic drags symbols; each nudge (and the auto-layout reset)
  // commits through the one doc-changed seam so it lands in undo/redo and
  // persists. Purely a layout hint — the physical desk placement is untouched.

  /** Persist a schematic symbol's position nudge. */
  setSchematicPos(id, x, y) {
    try {
      this.#doc.setSchematicPos(id, x, y);
    } catch {
      return; // the component vanished mid-drag — nothing to record
    }
    this.#emitDocChanged("move symbol");
  }

  /** Clear every schematic nudge, returning the diagram to auto-layout. */
  autoLayoutSchematic() {
    if (this.#doc.clearSchematicPositions() > 0) {
      this.#emitDocChanged("auto-layout schematic");
    }
  }

  // ── Net names (Feature 120) ──────────────────────────────────────────────
  // The probe drives these; each is one commit through the doc-changed seam so
  // it lands in undo/redo. Naming is inert to the engine — the netlist just
  // resolves the binding to a net and hangs the name on it.

  /**
   * Bind `name` to the net that `address` sits on, first clearing any `stale`
   * bindings on the same net so a rename never self-conflicts.
   */
  nameNet(address, name, stale = []) {
    try {
      for (const a of stale) this.#doc.clearNetName(a);
      this.#doc.nameNet(address, name);
    } catch {
      return; // bad address/name — leave the document untouched
    }
    this.#emitDocChanged("name net");
  }

  /** Clear every net-name binding in `addresses` (one undo step). */
  clearNetNames(addresses) {
    let changed = false;
    for (const a of addresses) {
      if (this.#doc.clearNetName(a)) changed = true;
    }
    if (changed) this.#emitDocChanged("clear net name");
  }

  // ── Logic-analyzer channels (Feature 210) ────────────────────────────────
  // The instrument setup is document data, so its mutations ride the ONE
  // undo/redo + autosave seam like everything else. Unlike circuit edits these
  // are NOT gated on `#editingLocked` — the analyzer stays usable while running.

  /** Add a channel bound to a net address or a bus id (deduped). Returns its id. */
  addScopeChannel(kind, ref, extra = {}) {
    if (this.#doc.hasScopeChannel(kind, ref)) return null;
    let channel;
    try {
      channel = this.#doc.addScopeChannel(kind, ref, extra);
    } catch {
      return null; // bad kind/ref — leave the document untouched
    }
    this.#emitDocChanged("add analyzer channel");
    return channel.id;
  }

  /** Remove an analyzer channel. */
  removeScopeChannel(id) {
    try {
      this.#doc.removeScopeChannel(id);
    } catch {
      return;
    }
    this.#emitDocChanged("remove analyzer channel");
  }

  /** Reorder an analyzer channel to a new index. */
  moveScopeChannel(id, index) {
    try {
      this.#doc.moveScopeChannel(id, index);
    } catch {
      return;
    }
    this.#emitDocChanged("reorder analyzer channel");
  }

  /** Patch an analyzer channel's label / color. */
  updateScopeChannel(id, patch) {
    try {
      this.#doc.updateScopeChannel(id, patch);
    } catch {
      return;
    }
    this.#emitDocChanged("update analyzer channel");
  }

  // ── Annotations: labels & notes (Feature 120) ────────────────────────────

  /** Arm a place-annotation ghost that drops a label / note on click. */
  armAnnotationPlacement(kind) {
    if (this.#editingLocked) return;
    const ghost = el("div", {
      class: `annotation annotation--${kind} annotation-ghost`,
      hidden: true,
    });
    ghost.append(
      el("div", {
        class: "annotation-text annotation-text--empty",
        // The palette's own words for the two kinds — the ghost is the pick
        // the user just made, so it has to read as the thing they clicked.
        // Two literal keys rather than one computed one, so the catalog guard
        // can see both (tests/i18n-catalogs.test.js reads literals only).
        text:
          kind === "note"
            ? t("palette.annotation.note")
            : t("palette.annotation.label"),
      }),
    );
    this.#place.enter({
      kind: "place-annotation",
      annKind: kind,
      ghost,
      pos: null,
      anchor: null,
      legal: true,
    });
  }

  /** Place-annotation ghost: rides the cursor; anchors when over a part. */
  #trackAnnotationGhost(e) {
    const m = this.#mode;
    const w = this.#deskView.worldFromEvent(e);
    m.pos = { x: w.x, y: w.y };
    m.anchor = this.#componentAt(w);
    m.ghost.hidden = false;
    m.ghost.classList.toggle("annotation-ghost--anchored", Boolean(m.anchor));
    m.ghost.style.left = `${w.x * PX_PER_UNIT}px`;
    m.ghost.style.top = `${w.y * PX_PER_UNIT}px`;
  }

  /** The component whose (padded) pin/terminal box contains a world point. */
  #componentAt(world) {
    for (const comp of this.#doc.components) {
      const points = componentPoints(this.#doc.boards, comp);
      if (points.length === 0) continue;
      const pad = 1; // one pitch of slack — the body extends past the pins
      const xs = points.map((p) => p.x);
      const ys = points.map((p) => p.y);
      if (
        world.x >= Math.min(...xs) - pad &&
        world.x <= Math.max(...xs) + pad &&
        world.y >= Math.min(...ys) - pad &&
        world.y <= Math.max(...ys) + pad
      ) {
        return comp.id;
      }
    }
    return null;
  }

  /** Drop a label / note; when anchored it rides its part. Opens the editor. */
  addAnnotationAt(kind, x, y, anchor = null) {
    const ann = this.#doc.addAnnotation(kind, x, y, "", { anchor });
    this.#emitDocChanged("add annotation"); // AnnotationLayer renders it
    this.selectAnnotation(ann.id);
    this.#annotationLayer.beginEdit(ann.id); // drop → type the caption
    return ann;
  }

  /** Annotations whose `anchor` is `componentId` (with base positions). */
  #hasAnchored(componentId) {
    return this.#doc.annotations.some((a) => a.anchor === componentId);
  }

  /** Shift every annotation anchored to `anchorIds` by (dx, dy) in the doc. */
  #shiftAnchoredAnnotations(anchorIds, dx, dy) {
    if (dx === 0 && dy === 0) return;
    const ids = anchorIds instanceof Set ? anchorIds : new Set([anchorIds]);
    for (const a of this.#doc.annotations) {
      if (a.anchor && ids.has(a.anchor)) {
        this.#doc.updateAnnotation(a.id, { x: a.x + dx, y: a.y + dy });
      }
    }
  }

  #commitAnnotationText(id, text) {
    try {
      this.#doc.updateAnnotation(id, { text });
    } catch {
      return;
    }
    this.#emitDocChanged("edit annotation");
  }

  /** Remove an annotation (Delete key / context menu). */
  removeAnnotation(id) {
    if (this.#editingLocked) return;
    try {
      this.#doc.removeAnnotation(id);
    } catch {
      return;
    }
    if (this.#sel.single?.kind === "annotation" && this.#sel.single.id === id) {
      this.#sel.forget();
    }
    this.#emitDocChanged("delete annotation");
  }

  // ── Simulation live state (Feature 90) ───────────────────────────────────

  /** Freeze/unfreeze editing while the circuit runs (app.js drives this). */
  setEditingLocked(locked) {
    this.#editingLocked = locked;
    this.#viewport.classList.toggle("desk-viewport--running", locked);
    if (locked) {
      // Cancel any armed tool the run supersedes (probe stays allowed).
      this.cancelPlacement();
      this.disarmWireTool();
      this.disarmBusTool();
      // History is frozen for the run — run-volatile effects (12 V damage, a
      // switch flipped live) never become undo steps.
      this.#history.freeze();
    } else {
      // Stop: resume recording and re-baseline the present to the live document
      // so any run-persisted change stays consistent with undo/redo.
      this.#history.unfreeze();
      this.#history.sync(this.#doc.snapshot());
    }
    // Nothing can be dragged while running, so the hint must not offer to.
    this.#sel.refreshRidePreview();
    this.#notifyHistoryState();
  }

  // ── Document mutations (all flow through desk-doc) ─────────────────────

  /** Add + mount + select a single strip; emits chiphippo:doc-changed. */
  addBoardAt(type, x, y) {
    const board = this.#doc.addBoard(type, x, y);
    this.#mountBoard(board);
    this.selectBoard(board.id);
    this.#emitDocChanged("add board");
    return board;
  }

  /**
   * Add + mount a whole breadboard kit, selecting its pin-board (the strip
   * users think of as "the board"). Emits chiphippo:doc-changed once.
   *
   * @returns {Array<object>} the new strips, in kit order.
   */
  addKitAt(kit, x, y, rot = 0, flipRails = false) {
    const strips = this.#doc.addKit(kit, x, y, rot, flipRails);
    for (const strip of strips) this.#mountBoard(strip);
    // Anything dropped flush against a board mates with it, as the real
    // dovetailed part does — the strips join that board's group and drag as
    // one unit from here on. A whole kit mates the same way a lone strip
    // does; placing and dropping follow the ONE rule.
    this.#mateStrips(strips.map((s) => s.id));
    const pins = strips.find((s) => spec(s.type).kind === "pins") ?? strips[0];
    this.selectBoard(pins.id);
    this.#emitDocChanged("add board");
    return strips;
  }

  /**
   * Offer every strip in `ids` to the mating rule. Strips of the same set
   * already share a group, so the joins compose: whatever any of them
   * dovetails with ends up in one unit.
   */
  #mateStrips(ids) {
    for (const id of ids) this.#doc.joinMatedGroup(id);
  }

  /** Seat + mount + select a board part; emits chiphippo:doc-changed. */
  addComponentAt(ref, boardId, anchor, params = {}) {
    const component = this.#doc.addComponent({
      kind: partDef(ref).kind,
      ref,
      board: boardId,
      anchor,
      params,
    });
    this.#provisionMemory(component);
    this.#mountPart(component);
    this.selectComponent(component.id);
    this.#emitDocChanged("add part");
    return component;
  }

  /**
   * Give a freshly-placed ROM chip its own backing file (Feature 190): mint a
   * GUID, clear any copied `programmed` flag (a paste is a NEW, unprogrammed
   * chip), and create the noise-filled `.bin`. A no-op for volatile SRAM (never
   * file-backed) and non-memory parts. The GUID lands in the same doc-changed
   * as the placement, so it rides one undo step. Patches `comp.params` in
   * place (not just the doc) since the caller mounts THIS object right after —
   * without it the freshly-placed chip's view never sees its own `storage`/
   * `programmed`, and (Feature 190 follow-up) never shows its "unprogrammed"
   * design-time warning until the next remount.
   */
  #provisionMemory(comp) {
    const def = partDef(comp.ref);
    if (!isRomChip(def)) return;
    const guid = crypto.randomUUID();
    const updated = this.#doc.setComponentParams(comp.id, {
      storage: { guid },
      programmed: false,
    });
    comp.params = updated.params;
    this.#onCreateMemoryFile?.(guid, memByteLength(def));
  }

  /**
   * Give every file-backed memory on a freshly LOADED desk a GUID and a backing
   * file if it arrived without one.
   *
   * A ROM gets its store when it is PLACED, and a pasted one gets a fresh store
   * of its own — but a document read from a FILE was never placed, and a chip in
   * it may name no store at all. Nothing downstream copes with that on its own:
   * a GUID is main's only handle on the bytes, so `MemoryBridge` answers
   * `#romInfo` with null and the programmer, Save and the inspector's own
   * file-backed path all fall silently through their `if (!info) return`. That
   * is a chip you cannot load an image into and are told nothing about — the
   * shipped `demos/65xx-*` computers, whose ROMs are generated rather than
   * placed, and any document written before this rule.
   *
   * So the invariant — a non-volatile memory on the desk HAS a store — is
   * established at every seam a chip can arrive through, this being the third.
   * `SimController`'s own defensive mint on Run then goes back to being
   * defensive rather than the only thing standing the invariant up (which is
   * also why the button worked after a Run and not before it, the asymmetry
   * this removes).
   *
   * Runs BEFORE `#rebuildScene` and before the history baseline is seeded, so
   * the mounted view sees its own store and ⌘Z has nothing to unwind it to.
   */
  #adoptUnbackedMemories() {
    for (const comp of this.#doc.components) {
      if (comp.params?.storage?.guid) continue;
      if (!isRomChip(partDef(comp.ref))) continue;
      this.#provisionMemory(comp);
    }
  }

  /** Delete a ROM chip's backing file as it's removed (a no-op for SRAM). */
  #releaseMemory(comp) {
    const guid = comp?.params?.storage?.guid;
    if (guid && isRomChip(partDef(comp.ref))) this.#onRemoveMemoryFile?.(guid);
  }

  /**
   * Set/clear a ROM chip's `programmed` flag (the in-app programmer wrote it),
   * and with it the record of WHICH FILE the bytes came from. The view is
   * refreshed so the "not programmed" warning triangle (Feature 190 follow-up)
   * clears/reappears immediately, not just on the next remount.
   *
   * `binding` is the one thing the programmer and the inspector's Save say
   * differently, and both land in ONE doc-changed so the flag and the label
   * ride a single undo step:
   *   · `{ source }` — a fresh load. The path is recorded (null forgets it, so
   *     a label can never name a file that is not what the chip holds) and any
   *     `edited` mark is cleared: these ARE that file's bytes again.
   *   · `{ edited: true }` — hand-edits saved from the inspector. The source is
   *     KEPT and marked, because "blink.bin, changed since" answers more than
   *     nothing does.
   * Omitting a key leaves that half alone; `programmed: false` drops both,
   * since an unprogrammed chip holds noise and noise came from nowhere.
   *
   * @param {string} id
   * @param {boolean} programmed
   * @param {{source?: string|null, edited?: boolean}} [binding]
   */
  setMemoryProgrammed(id, programmed, binding = {}) {
    const comp = this.#doc.getComponent(id);
    if (!comp || !isRomChip(partDef(comp.ref))) return;
    const patch = { programmed: programmed === true };
    const storage = comp.params?.storage;
    if (storage) {
      // setComponentParams merges SHALLOWLY, so storage goes over whole or the
      // guid — the one thing that names the backing file — would be erased.
      const next = { ...storage };
      if (programmed !== true) {
        delete next.source;
        delete next.edited;
      } else {
        if (binding.source !== undefined) {
          if (binding.source) next.source = binding.source;
          else delete next.source;
          delete next.edited;
        }
        if (binding.edited === true) next.edited = true;
      }
      patch.storage = next;
    }
    const updated = this.#doc.setComponentParams(id, patch);
    this.#partViews.get(id)?.updateParams(updated.params);
    this.#emitDocChanged("program memory");
  }

  /** Drop + mount + select a desk-level brick (PSU/clock); emits doc-changed. */
  addBrickAt(ref, x, y, params = {}) {
    const brick = this.#doc.addBrick(ref, x, y, params);
    this.#mountPart(brick);
    this.selectComponent(brick.id);
    this.#emitDocChanged("add part");
    return brick;
  }

  /**
   * Remove a board — and the whole snapped SET it belongs to. Selecting any
   * strip highlights its entire group (every joined pin-board and rail), so
   * deleting matches that outline: every strip in the set goes, along with
   * every component seated on any of them and every wire touching them —
   * including wires that cross to a board OUTSIDE the set. A lone strip is a
   * set of one. With anything to cascade, asks for confirmation first.
   */
  removeBoard(id) {
    const boardIds = this.#doc.groupMembers(id).map((b) => b.id);
    if (boardIds.length === 0) return;
    // Count the cascade deduped across the set: a component seats on one
    // strip, but a wire spanning two members touches both.
    const partIds = new Set();
    const wireIds = new Set();
    for (const bid of boardIds) {
      for (const c of this.#doc.componentsOnBoard(bid)) partIds.add(c.id);
      for (const w of this.#doc.wiresTouching(bid)) wireIds.add(w.id);
    }
    if (partIds.size === 0 && wireIds.size === 0) {
      this.#doRemoveBoards(boardIds);
      return;
    }
    const many = boardIds.length > 1;
    const bits = [];
    if (partIds.size > 0) bits.push(t("desk.count.parts", { count: partIds.size })); // prettier-ignore
    if (wireIds.size > 0) bits.push(t("desk.count.wires", { count: wireIds.size })); // prettier-ignore
    PopupManager.confirm({
      title: many ? t("desk.remove.boardsTitle") : t("desk.remove.boardTitle"),
      message: many
        ? t("desk.remove.boardsMessage", {
            count: boardIds.length,
            what: bits.join(t("desk.count.and")),
          })
        : t("desk.remove.boardMessage", {
            id,
            what: bits.join(t("desk.count.and")),
          }),
      confirmLabel: t("desk.remove.confirm"),
      confirmClass: "btn--danger",
      onConfirm: () => this.#doRemoveBoards(boardIds),
    });
  }

  /**
   * Remove every strip in `boardIds` in ONE doc-changed. Each strip's model
   * removal cascades its seated components and any wire touching it (whether
   * the other end lands on another member, an unselected board, or a brick),
   * so the whole set — and every wire crossing out of it — comes away.
   */
  #doRemoveBoards(boardIds) {
    this.#tearDownBoards(boardIds);
    this.#hideHover();
    this.#emitDocChanged("delete board"); // WireLayer re-renders from this
  }

  /**
   * The removal itself, without announcing it — so a batch that also deletes
   * parts and wires (a marquee holding boards, Feature 240) lands as ONE
   * doc-changed, and so one undo step.
   */
  #tearDownBoards(boardIds) {
    for (const bid of boardIds) {
      for (const comp of this.#doc.componentsOnBoard(bid)) {
        this.#releaseMemory(comp); // a seated ROM's backing file goes with it
        this.#partViews.get(comp.id)?.remove();
        this.#partViews.delete(comp.id);
        if (this.#sel.single?.id === comp.id) this.#sel.forget();
      }
      const cascadedWires = new Set(
        this.#doc.wiresTouching(bid).map((w) => w.id),
      );
      this.#doc.removeBoard(bid); // cascades seated components + attached wires
      this.#views.get(bid)?.remove();
      this.#views.delete(bid);
      if (
        this.#sel.single?.id === bid ||
        (this.#sel.single?.kind === "wire" &&
          cascadedWires.has(this.#sel.single.id))
      ) {
        this.#sel.forget();
      }
    }
  }

  /**
   * Remove a component. A PSU with wires on its terminals confirms first
   * (they go with it).
   */
  removeComponent(id) {
    const comp = this.#doc.getComponent(id);
    // A desk-level brick (PSU / clock) takes its wired terminals with it,
    // so confirm first when any are attached.
    if (comp?.board == null) {
      const noun = t(`desk.brick.${comp.kind === "psu" ? "psu" : "clock"}`);
      const wires = this.#doc.wiresTouching(id).length;
      if (wires > 0) {
        PopupManager.confirm({
          title: t("desk.remove.brickTitle", { noun }),
          message: t("desk.remove.brickMessage", {
            id,
            what: t("desk.count.wires", { count: wires }),
          }),
          confirmLabel: t("desk.remove.confirm"),
          confirmClass: "btn--danger",
          onConfirm: () => this.#doRemoveComponent(id),
        });
        return;
      }
    }
    this.#doRemoveComponent(id);
  }

  #doRemoveComponent(id) {
    const cascadedWires = new Set(this.#doc.wiresTouching(id).map((w) => w.id));
    this.#releaseMemory(this.#doc.getComponent(id)); // delete a ROM's backing file
    this.#doc.removeComponent(id); // a PSU cascades its attached wires
    this.#partViews.get(id)?.remove();
    this.#partViews.delete(id);
    if (
      this.#sel.single?.id === id ||
      (this.#sel.single?.kind === "wire" &&
        cascadedWires.has(this.#sel.single.id))
    ) {
      this.#sel.forget();
    }
    this.#hideHover();
    this.#emitDocChanged("delete part");
  }

  /** Apply one plain click's params patch — persists it; doc-changed
      re-settles. WHAT the click does belongs to the part (`clickToggle`); all
      that is left here is the write. `switchIndex` (a bank position, read off
      the pointer event's target) is ignored by every part that has only one
      thing to flip. */
  #toggleClickPart(id, switchIndex = null) {
    const comp = this.#doc.getComponent(id);
    // The part itself says what its click does; a null means this particular
    // press changes nothing (a bank's body, not one of its switch positions).
    const patch = partDef(comp?.ref)?.clickToggle?.(comp.params, switchIndex);
    if (!patch) return;
    const updated = this.#doc.setComponentParams(id, patch);
    this.#partViews.get(id)?.updateParams(updated.params);
    // pos/on/states lives in params, so the flip rides `doc-changed` alone —
    // which already invalidates the netlist, re-ticks the sim, and refreshes
    // the pinned net. Emitting `part-state` too would double-tick (part-state
    // is reserved for transient view state with no durable param — a held
    // button).
    this.#emitDocChanged("toggle switch");
  }

  /** Every field the Properties dialog shows for one component: the catalog
      def's static `properties` list (PSU volts, clock/oscillator rate, the
      LED's and LCD's color — all live settings, so nothing here is filtered
      by #editingLocked) plus a memory chip's instance-conditional fields (its
      own kind/ROM check, not catalog data — a chip's write affordance depends
      on whether the sim is running). The ROM's image file is READ FIRST, so
      the card says what is loaded before it offers to change it. */
  #propertyFieldsFor(comp, def) {
    // No `label`/`actionLabel`: unlike a catalog def's own fields, these are
    // minted HERE, so there is no English source for them to carry — the dialog
    // names them from `properties.field.<key>` / `properties.action.<key>`
    // (part-properties-dialog.js).
    const fields = [...(def?.properties ?? [])];
    if (comp?.kind === "chip" && isMemory(def)) {
      // A volatile SRAM is never loaded from a file, so it never has one.
      if (isRomChip(def)) fields.push({ key: "imageSource", type: "readonly" });
      fields.push({ key: "inspectMemory", type: "action" });
      if (isRomChip(def) && !this.#editingLocked) {
        fields.push({ key: "programMemory", type: "action" });
      }
    }
    return fields;
  }

  /** The file a ROM's bytes came from, for the Properties card's readonly row:
      the path it was programmed from, marked when they have been hand-edited
      since, and "None" for a chip that has never been given one — quietly,
      because the card's own `unprogrammed` warning already says that louder. */
  #memorySourceLabel(comp) {
    const storage = comp?.params?.storage;
    if (!storage?.source) return t("common.none");
    return storage.edited === true
      ? t("memory.sourceEdited", { path: storage.source })
      : storage.source;
  }

  /**
   * The faults one part is showing RIGHT NOW, as sentences for the Properties
   * dialog's warnings section — the same set its badge draws on the desk, so
   * the two can never say different things:
   *   • the engine's live power/health status (running only — the overlay
   *     answers null when stopped, and never for a healthy part);
   *   • an unprogrammed ROM, which is derived from params alone and therefore
   *     stands at design time too, exactly as ChipView#refresh has it.
   *
   * A chip can hold both at once (a dead ROM is still an empty one) and both
   * are listed: the desk suppresses one triangle behind the other because it
   * has one place to draw, which a list does not.
   *
   * Empty is the common answer, and it is what keeps the section out of the
   * card altogether.
   */
  #partWarnings(id) {
    const comp = this.#doc.getComponent(id);
    if (!comp) return [];
    const keys = [];
    const status = this.#simOverlay.statusOf(id);
    if (status) keys.push(status);
    if (
      isRomChip(partDef(comp.ref)) &&
      Boolean(comp.params?.storage?.guid) &&
      comp.params?.programmed !== true
    ) {
      keys.push("unprogrammed");
    }
    return keys.map((key) => t(`properties.warning.${key}`));
  }

  /** Open the shared Properties dialog (context menu → "Properties…") for a
      part — see #propertyFieldsFor. Every part gets Name/Description (the
      dialog itself prepends those), so this is never a no-op. */
  #onOpenProperties(id) {
    const comp = this.#doc.getComponent(id);
    if (!comp) return;
    const def = partDef(comp.ref);
    const fields = this.#propertyFieldsFor(comp, def);
    PartPropertiesDialog.open({
      // `partTitle`, never the def's raw `title`: that field is the ENGLISH
      // SOURCE the catalog translates through, and every other place a part is
      // named already goes through it (the palette, the pinout, the BOM).
      title: t("desk.partPropertiesTitle", {
        part: def ? partTitle(def) : comp.ref,
      }),
      fields,
      // Name/Description live OUTSIDE params (see setComponentMeta) — merge
      // them in so the dialog's values[field.key] lookup finds every field,
      // catalog-declared or universal, by the same key.
      values: {
        name: comp.name,
        description: comp.description,
        ...comp.params,
        // A readonly whose value is DERIVED rather than stored — `values` is
        // the established route for one (the project's Location does the same).
        imageSource: this.#memorySourceLabel(comp),
      },
      onChange: (key, value) => this.#setComponentProperty(id, key, value),
      onAction: (key) => this.#onPropertyAction(id, key),
      // A CALLBACK, not a list: the dialog re-asks on every sim tick, so a
      // chip that lets its smoke out while the card is open says so.
      warnings: () => this.#partWarnings(id),
    });
  }

  /** Apply one Properties-dialog field change. Name/Description are universal
      metadata outside a def's own params contract, so they route to
      setComponentMeta; everything else (catalog-declared properties) still
      goes through setComponentParams. Remounting (rather than updateParams
      alone) is correct for every part kind: a rotatable/span part (e.g. the
      LED) only redraws through its span geometry, which updateParams alone
      skips — see DiscreteView.updateParams. */
  #setComponentProperty(id, key, value) {
    if (key === "name" || key === "description") {
      this.#doc.setComponentMeta(id, { [key]: value });
    } else {
      this.#doc.setComponentParams(id, { [key]: value });
    }
    this.#remountPart(id);
    this.#emitDocChanged("set properties", { coalesce: true });
  }

  /** Fire a Properties-dialog `"action"` field — the memory chip commands
      (#propertyFieldsFor); the dialog has already closed by the time this
      runs. */
  #onPropertyAction(id, key) {
    if (key === "inspectMemory") this.#onOpenMemory?.(id);
    else if (key === "programMemory") this.#onProgramMemory?.(id);
  }

  // ── Central keyboard hooks (wired by app.js) ────────────────────────────

  /** @returns {boolean} true when the key was consumed. */
  handleKeyDown(e) {
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) {
      return false;
    }
    if (e.key === "Escape") {
      // A live pointer drag takes priority over everything below — revert it
      // (never commit) rather than merely deselecting out from under it.
      if (this.#dragGestureActive) {
        this.#cancelDragGesture();
        return true;
      }
      // First Esc unpins a pinned net; the next disarms the probe. Then the
      // wire tool (cancel a pending wire, else disarm).
      if (this.#probe.handleEscape()) return true;
      if (this.#wire.handleEscape()) return true;
      if (this.#bus.handleEscape()) return true;
      if (this.placementArmed) {
        this.cancelPlacement();
        return true;
      }
      if (this.#sel.single || this.#sel.size() > 0) {
        this.deselect();
        return true;
      }
      return false;
    }
    const bareKey = !e.metaKey && !e.ctrlKey && !e.altKey;
    // Probe stays available while running; edit shortcuts are locked out.
    if (
      (e.key === "i" || e.key === "I" || e.key === "p" || e.key === "P") &&
      bareKey
    ) {
      this.toggleProbe();
      return true;
    }
    // M disarms whichever of the wire/bus/probe tools is currently armed — a
    // single "put the tools away" key. Stays available while running too (the
    // probe does), so it can turn that off even while the circuit is live.
    if ((e.key === "m" || e.key === "M") && bareKey) {
      let handled = false;
      if (this.wireToolArmed) {
        this.disarmWireTool();
        handled = true;
      }
      if (this.busToolArmed) {
        this.disarmBusTool();
        handled = true;
      }
      if (this.probeArmed) {
        this.disarmProbe();
        handled = true;
      }
      return handled;
    }
    // H fades the wires back to a stub at each end (and back). Like the probe
    // it only changes what is DRAWN, so it stays available while running.
    if ((e.key === "h" || e.key === "H") && bareKey) {
      this.toggleWiresFaded();
      return true;
    }
    if (this.#editingLocked) return false;
    // A live pointer drag owns #mode until its pointerup commits + tears it
    // down. W/B arm a tool, paste arms a ghost, and Delete removes the dragged
    // item — each would overwrite #mode (or the view) out from under that
    // pending pointerup, orphaning the capture. So they are inert mid-drag (the
    // R rotate/flip path deliberately DOES act mid-drag and self-guards in
    // #toggleResistorRotation; F is gated to placement). See #dragGestureActive.
    const dragging = this.#dragGestureActive;
    // Cmd/Ctrl+C copies the one selected component; Cmd/Ctrl+V arms a fresh
    // duplicate as a placement ghost. Consume the key only when there is
    // something to act on, so the native Edit-menu copy/paste still serves text
    // fields (this handler already returned above when a text input is focused).
    const accel = (e.metaKey || e.ctrlKey) && !e.altKey;
    if (accel && (e.key === "c" || e.key === "C")) {
      return this.copySelectedComponent();
    }
    if (accel && (e.key === "v" || e.key === "V") && !dragging) {
      return this.pasteComponent();
    }
    if ((e.key === "w" || e.key === "W") && bareKey && !dragging) {
      this.toggleWireTool();
      return true;
    }
    if ((e.key === "b" || e.key === "B") && bareKey && !dragging) {
      this.toggleBusTool();
      return true;
    }
    // 1–8 pick the wire color while the wire tool is armed; 1–8 pick the bus
    // width while the bus tool is armed (2–8 name their own width, 1 is the
    // 16-bit bus — see busWidthForKey), without leaving the keyboard.
    if (bareKey && !dragging && /^[1-9]$/.test(e.key)) {
      const n = Number(e.key);
      if (this.wireToolArmed && n <= WIRE_COLORS.length) {
        this.setWireColor(WIRE_COLORS[n - 1]);
        return true;
      }
      if (this.busToolArmed) {
        const preset = busWidthForKey(n);
        if (preset) {
          this.setBusName(preset.name);
          return true;
        }
      }
    }
    // F flips LED polarity while its placement ghost is armed.
    if (
      (e.key === "f" || e.key === "F") &&
      this.#mode?.kind === "place-part" &&
      this.#mode.ref === "led"
    ) {
      const m = this.#mode;
      m.params = { ...m.params, flip: !m.params.flip };
      m.ghost.querySelector("svg")?.remove();
      m.ghost.append(buildDiscreteSvg(m.ref, m.params));
      return true;
    }
    // R rotates a resistor: toggles its placement between horizontal and the
    // vertical two-click form, and rotates a selected placed resistor 90°.
    if ((e.key === "r" || e.key === "R") && bareKey) {
      if (this.#toggleResistorRotation()) return true;
    }
    if (
      (e.key === "Delete" || e.key === "Backspace") &&
      !dragging &&
      this.#sel.size() > 0
    ) {
      this.removeSelectedComponents();
      return true;
    }
    if (
      (e.key === "Delete" || e.key === "Backspace") &&
      !dragging &&
      this.#sel.single
    ) {
      const { kind, id } = this.#sel.single;
      if (kind === "part") this.removeComponent(id);
      else if (kind === "wire") this.removeWire(id);
      else if (kind === "bus") this.#bus.removeBus(id, true);
      else if (kind === "annotation") this.removeAnnotation(id);
      else this.removeBoard(id);
      return true;
    }
    return false;
  }

  /** Camera moved/zoomed (app.js pass-through) — hover context is stale. */
  onViewportChange() {
    this.#hideHover();
  }

  // ── Mounting ─────────────────────────────────────────────────────────────

  #mountBoard(board) {
    const view = new BreadboardView(this.#layers.boards, board, {
      onPointerDown: (id, e) => this.#onBoardPointerDown(id, e),
      onContextMenu: (id, e) => this.#onBoardContextMenu(id, e),
    });
    this.#views.set(board.id, view);
  }

  #mountPart(component) {
    // Every part's pin/terminal-assignments window opens from its context
    // menu's "Pin Assignment" item (#onPartContextMenu), not a double-click.
    const callbacks = {
      onPointerDown: (id, e) => this.#onPartPointerDown(id, e),
      onContextMenu: (id, e) => this.#onPartContextMenu(id, e),
    };
    let view;
    if (component.kind === "psu") {
      view = new PsuView(this.#layers.parts, component, callbacks);
    } else if (component.kind === "clock") {
      view = new ClockView(this.#layers.parts, component, callbacks);
    } else if (component.kind === "discrete") {
      // A character-LCD module is an ordinary seated discrete that also owns a
      // live canvas (its own controller's output) — picked off the def's data
      // hook, never off the ref.
      const Seat = partDef(component.ref)?.characterDisplay
        ? LcdView
        : DiscreteView;
      view = new Seat(this.#layers.parts, component, callbacks);
      this.#placePartView(view, component, this.#doc.getBoard(component.board));
    } else {
      view = new ChipView(this.#layers.parts, component, callbacks);
      view.updatePlacement(
        this.#doc.getBoard(component.board),
        component.anchor,
      );
    }
    this.#partViews.set(component.id, view);
  }

  /** Position a part view: a rotated resistor spans its two ends, every other
      part (chip/discrete) seats at its anchor. `board` may be an override
      origin (live board drag). */
  #placePartView(view, comp, board) {
    if (!board) return;
    // Every rotatable part draws as a span between its two derived ends — body
    // centred on the pair and rotated to the lead angle, whichever form it's
    // stored in (footprint or two free ends). The span is pure geometry, so a
    // part whose far strip was pulled away keeps its exact position; only the
    // floating cue marks the connection it lost.
    if (partDef(comp.ref)?.rotatable) {
      const pins = this.#partPins(comp, board);
      if (pins?.length >= 2) {
        view.updateSpanWorld(pins[0], pins[1]);
        view.setFloating?.(pins.some((p) => p.address == null));
        return;
      }
    }
    view.updatePlacement(board, comp.anchor);
  }

  /** Row count for a part's pin/terminal-assignments window, or null if it
      has none — a DIP wraps to pins/2, a discrete/can lists every pin, a
      brick lists every terminal. Feeds the "Pin Assignment" context-menu
      item (#onPartContextMenu). */
  #pinoutRows(def) {
    if (!def) return null;
    if (def.package) return Math.ceil(def.pins.length / 2);
    if (def.can) return def.pins.length;
    if (def.footprint) return def.pins.length;
    if (def.terminals) return def.terminals.length;
    return null; // nothing to show
  }

  /** Seated parts ride their board: refresh views for a board at (x, y). */
  #repositionBoardParts(boardId, x, y) {
    const board = this.#doc.getBoard(boardId);
    if (!board) return;
    // A drag moves a strip, never turns it — but the override stands in for
    // the whole board downstream, so it carries the angle too.
    const origin = {
      id: board.id,
      type: board.type,
      x,
      y,
      rot: board.rot ?? 0,
    };
    for (const comp of this.#doc.componentsOnBoard(boardId)) {
      const view = this.#partViews.get(comp.id);
      if (view) this.#placePartView(view, comp, origin);
    }
  }

  // ── Board gestures ───────────────────────────────────────────────────────

  #onBoardPointerDown(id, e) {
    if (e.button !== 0) return; // middle = pan (DeskView), right = menu
    // Shift alone is the viewport's marquee; with Option it selects a chain.
    if (e.shiftKey && !e.altKey) return;
    // No board drags while probing or running (topology frozen).
    if (this.#mode || this.#probe.armed || this.#editingLocked) return;
    // A wire's end cap sits directly ON a board hole, so a press there lands on
    // the board SVG (caps aren't pointer targets) and this handler runs before
    // the viewport dispatcher can try the same grab. Give the wire endpoint
    // priority — pressing a wire end selects that wire and drags the one end,
    // never the board underneath it (matches the viewport dispatcher's order).
    // A bus member's cap declines the drag (see WireTools#tryBeginDrag) but
    // must still absorb the press — otherwise it falls through to a board
    // drag right here, since #capNear doesn't care whether a grab started.
    const world = this.#deskView.worldFromEvent(e);
    // ⌘/Ctrl-click adds this board's group to the selection (or takes it out)
    // and starts no drag. Checked BEFORE the drags below and with the same
    // wire-end priority: a cap sits on a board hole and is not a pointer
    // target, so the wire's own click listener never runs here — without this
    // a modifier-click aimed at a wire end would pull in a whole breadboard.
    if (isToggleSelectEvent(e, IS_MAC)) {
      e.stopPropagation();
      this.#hideHover();
      const capWire = this.#wire.wireIdNear(world);
      if (capWire) this.toggleWireSelection(capWire);
      else this.toggleBoardSelection(id);
      return;
    }
    if (this.#wire.tryBeginDrag(e, world)) return;
    if (this.#wire.capNear(world)) return;
    this.#hideHover();
    this.selectBoard(id);

    const view = this.#views.get(id);
    // Plain grab = the whole snapped unit. Option grabs the run from here
    // ONE WAY — down/right, or up/left with Shift — and dragging it tears it
    // off whatever it leaves behind.
    const members = e.altKey
      ? this.#doc.matedChain(id, e.shiftKey ? "backward" : "forward")
      : this.#doc.groupMembers(id);
    // The set lights up on mouse-down, before any travel, so it is clear what
    // is about to move (and what is about to be left behind).
    for (const b of members) this.#views.get(b.id)?.setDragSet(true);
    // Strips dragging as one rigid unit means the drag tracks a delta plus
    // every member's origin, not one board's position.
    this.#mode = {
      kind: "drag",
      id,
      members: members.map((b) => ({ id: b.id, ox: b.x, oy: b.y })),
      // The routed bends drawn over that set travel with it. Read ONCE here,
      // as a part drag freezes its riders: re-derived per sample the set would
      // grow and shrink as the strips slid under other wires' bends, so the
      // drop would depend on the path taken to it. Nothing moves in the
      // document during the drag, so this is exactly what moveBoardsBy will
      // find at the release.
      ridingPoints: this.#doc.wirePointsOverBoards(members.map((b) => b.id)),
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startWorld: world,
      lastWorld: world,
      delta: { dx: 0, dy: 0 },
      legal: true,
      active: false,
      teardown: null,
    };
    // …and the highlighter re-traces that set, so an Option grab shows the
    // torn-off run's edge rather than the whole group's.
    this.#sel.refreshBoardOutline();
    // Closed hand from the moment the board is grabbed (before any drag).
    this.#viewport.classList.add("desk-viewport--dragging");
    this.#mode.teardown = beginPointerGesture(view.element, e.pointerId, {
      onMove: this.#onBoardPointerMove,
      onEnd: this.#onBoardPointerUp,
    });
  }

  /** The lattice-snapped, magnetically-pulled delta for a board set under a
      pointer at `world`, writing d.delta/d.legal. Shared by the live drag and
      the release. */
  #resolveBoardDrag(d, world) {
    const ids = d.members.map((m) => m.id);
    d.delta = this.#pullToMate(ids, {
      dx: Math.round(world.x - d.startWorld.x),
      dy: Math.round(world.y - d.startWorld.y),
    });
    d.legal = this.#doc.canMoveBoardsBy(ids, d.delta.dx, d.delta.dy);
  }

  #onBoardPointerMove = (e) => {
    const d = this.#mode;
    if (d?.kind !== "drag" || e.pointerId !== d.pointerId) return;
    if (!d.active) {
      const travel = Math.hypot(
        e.clientX - d.startClientX,
        e.clientY - d.startClientY,
      );
      if (travel < DRAG_THRESHOLD) return;
      d.active = true;
      for (const m of d.members) this.#views.get(m.id)?.setDragging(true);
    }
    const w = this.#deskView.worldFromEvent(e);
    d.lastWorld = w;
    // The group rides the pointer, snapped live to the pitch lattice, then
    // pulled the last pitch or two onto a strip it can dovetail with.
    this.#resolveBoardDrag(d, w);
    // Wires with an endpoint on any member follow it live — and so do the
    // routed bends drawn over it.
    this.#wireLayer.render(
      this.#applyDragDelta(d, d.delta),
      this.#pointRide(d, d.delta),
    );
  };

  /** The waypoint shift a board drag previews with: the riders frozen at
      pointer-down and the delta they are travelling by (null when this set
      carries no routing, which is the usual case). */
  #pointRide(d, { dx, dy }) {
    return d.ridingPoints.size > 0 ? { points: d.ridingPoints, dx, dy } : null;
  }

  /**
   * Magnetic mating: a set dragged within a pitch or two of an edge it can
   * dovetail with is pulled the rest of the way, so dropping two boards side
   * by side joins them without pixel-perfect aim. The pull is abandoned if it
   * would land the set on top of something — a snap must never be the reason
   * a legal drop turns illegal.
   */
  #pullToMate(ids, delta) {
    const pull = this.#doc.snapBoardsBy(ids, delta.dx, delta.dy);
    if (pull.dx === 0 && pull.dy === 0) return delta;
    const snapped = { dx: delta.dx + pull.dx, dy: delta.dy + pull.dy };
    return this.#doc.canMoveBoardsBy(ids, snapped.dx, snapped.dy)
      ? snapped
      : delta;
  }

  /**
   * Move every dragged strip's view (and its seated parts) by a delta from
   * the drag origins. Returns the board → position overrides for WireLayer.
   */
  #applyDragDelta(d, { dx, dy }) {
    const overrides = new Map();
    for (const m of d.members) {
      const pos = { x: m.ox + dx, y: m.oy + dy };
      const view = this.#views.get(m.id);
      view?.setPosition(pos.x, pos.y);
      this.#repositionBoardParts(m.id, pos.x, pos.y);
      overrides.set(m.id, pos);
    }
    // The highlighter rides the set and reddens on an illegal drop — one
    // shape for the whole unit, so no seams appear between flush strips.
    this.#sel.refreshBoardOutline(overrides);
    return overrides;
  }

  #onBoardPointerUp = (e) => {
    const d = this.#mode;
    if (d?.kind !== "drag" || e.pointerId !== d.pointerId) return;
    this.#mode = null;
    this.#viewport.classList.remove("desk-viewport--dragging");

    d.teardown?.();
    for (const m of d.members) {
      const memberView = this.#views.get(m.id);
      memberView?.setDragging(false);
      memberView?.setDragSet(false);
    }
    if (!d.active) return; // plain click — selection already happened

    // A drag that spans Run (editing locked mid-gesture) reverts, never
    // commits — the teardown above already ran, so this only skips the mutation.
    const cancelled = e.type === "pointercancel" || this.#editingLocked;
    // Re-derive the delta at the RELEASE point. The magnetic #pullToMate snap
    // re-runs there too, which is the correct semantic: the drop mates against
    // where you let go, not where the last coalesced frame said you were.
    if (!cancelled) {
      this.#resolveBoardDrag(d, releaseWorld(this.#deskView, e, d.lastWorld));
    }
    const moved = d.delta.dx !== 0 || d.delta.dy !== 0;
    if (!cancelled && d.legal && moved) {
      // Moving only part of a group tears the snap — desk-doc re-derives the
      // groups on both sides of the break.
      const ids = d.members.map((m) => m.id);
      this.#doc.moveBoardsBy(ids, d.delta.dx, d.delta.dy);
      // Landing flush against a strip it dovetails with mates the two, as
      // dropping the real parts side by side does. Every dropped strip is
      // offered, so a kit that touches on more than one edge joins them all.
      this.#mateStrips(ids);
      // Labels anchored to a chip on any moved strip ride the board too.
      const carried = new Set();
      for (const id of ids) {
        for (const c of this.#doc.componentsOnBoard(id)) carried.add(c.id);
      }
      this.#shiftAnchoredAnnotations(carried, d.delta.dx, d.delta.dy);
      this.#applyDragDelta(d, d.delta);
      this.#emitDocChanged("move board"); // WireLayer re-renders from this
    } else {
      this.#applyDragDelta(d, { dx: 0, dy: 0 }); // illegal drop → revert
      this.#wireLayer.render();
    }
  };

  #onBoardContextMenu(id, e) {
    e.preventDefault();
    if (this.#probe.armed) return; // right-click names the net (viewport handler)
    if (this.#mode || this.#editingLocked) return; // no board edits while running
    this.selectBoard(id);
    PopupManager.menu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: t("desk.menu.properties"),
          onSelect: () => this.#onOpenBoardProperties(id),
        },
        { separator: true },
        {
          label: t("desk.menu.removeBoard"),
          danger: true,
          onSelect: () => this.removeBoard(id),
        },
      ],
    });
  }

  /** Open the shared Properties dialog for a board — Name/Description only
      (a strip declares no other editable fields; see part-properties-dialog.js
      for why the dialog never needs a fields list to have something to show). */
  #onOpenBoardProperties(id) {
    const board = this.#doc.getBoard(id);
    if (!board) return;
    PartPropertiesDialog.open({
      title: t("desk.boardPropertiesTitle", {
        board: kitLabel(board.type, spec(board.type)),
      }),
      values: board,
      onChange: (key, value) => this.#setBoardProperty(id, key, value),
    });
  }

  /** Apply one board Properties-dialog field change. No remount — nothing
      currently draws a board's name/description onto its SVG. */
  #setBoardProperty(id, key, value) {
    this.#doc.setBoardParams(id, { [key]: value });
    this.#emitDocChanged("set board properties", { coalesce: true });
  }

  /** Open the shared Properties dialog for a wire — Name/Description plus its
      two catalog-style fields, Color (all 8 WIRE_COLORS) and Layout Method
      (Direct / Routed), matching every other part's Properties dialog shape
      (see WireTools#onContextMenu). The layout is defaulted in rather than
      stored on every wire: a direct wire carries no `layout` at all, and a
      dropdown still has to show something.

      LAST comes the wire itself, drawn to length and dimensioned in cm
      (components/wire-gauge.js) — a picture rather than a field, so it sits
      below everything editable. What is handed over is the RUN the WireLayer
      draws (`runLength`, world px → mm), never a second measurement of its own;
      the drawing adds the stripped end at each end itself, since that is where
      STRIP_MM lives. A wire whose ends don't resolve is simply not dimensioned.
      `measure` is a callback rather than a number because switching Layout Method
      to Direct throws the wire's bends away WHILE THE DIALOG IS OPEN, which
      shortens it — it falls back to the run the dialog opened with, so a wire
      that stops resolving mid-edit keeps its last honest figure. */
  #onOpenWireProperties(id) {
    const wire = this.#doc.getWire(id);
    if (!wire) return;
    const runMm = wireRunMm(this.#doc, id);
    PartPropertiesDialog.open({
      title: t("desk.wirePropertiesTitle"),
      fields: [
        {
          key: "color",
          label: t("desk.wireColor"),
          type: "color",
          options: WIRE_COLORS,
        },
        {
          key: "layout",
          label: t("desk.wireLayout"),
          // A segmented picker, not a dropdown — the SAME control Settings ▸
          // Appearance offers the app-wide default with, so the two places a
          // user meets this choice look and behave alike.
          type: "segmented",
          options: [
            {
              value: "direct",
              label: t("settings.appearance.wireLayoutDirect"),
            },
            {
              value: "routed",
              label: t("settings.appearance.wireLayoutRouted"),
            },
          ],
        },
        runMm == null
          ? null
          : {
              type: "wire-gauge",
              color: wire.color,
              measure: () => wireRunMm(this.#doc, id) ?? runMm,
            },
      ].filter(Boolean),
      values: { ...wire, layout: wire.layout ?? "direct" },
      onChange: (key, value) => this.#setWireProperty(id, key, value),
    });
  }

  /** Apply one wire Properties-dialog field change. Color already has its own
      DeskDoc method/commit path (recolorWire — also driven by the color-
      cycling keyboard shortcut and the old flat context menu); Name/
      Description route to the new setWireMeta. Layout is NOT coalesced —
      switching back to Direct throws every waypoint away, which is exactly the
      kind of change a user wants one ⌘Z to bring back. */
  #setWireProperty(id, key, value) {
    if (key === "name" || key === "description") {
      this.#doc.setWireMeta(id, { [key]: value });
      this.#emitDocChanged("set wire properties", { coalesce: true });
    } else if (key === "layout") {
      this.#doc.setWireLayout(id, value);
      this.#emitDocChanged("set wire layout");
    } else {
      this.recolorWire(id, value); // already commits + emits
    }
  }

  // ── Part gestures (chips, discretes, PSUs) ──────────────────────────────

  #onPartPointerDown(id, e) {
    if (e.button !== 0) return;
    const toggling = isToggleSelectEvent(e, IS_MAC);
    if (e.shiftKey) return; // shift-drag is the viewport's marquee
    if (this.#mode || this.#probe.armed) return; // no part drags while probing
    // While running, only click-toggle parts stay interactive (click to
    // flip); every other part is frozen in place.
    if (this.#editingLocked) {
      // A modifier-press is a SELECT, and selection is refused while running —
      // it must not fall through and flip a switch instead.
      if (toggling) {
        e.stopPropagation();
        return;
      }
      // While running, only live interactions remain: a slide switch or
      // toggle button flips, and a manual clock toggles one edge.
      const comp = this.#doc.getComponent(id);
      if (clickTogglingPart(comp?.ref)) {
        e.stopPropagation();
        this.#toggleClickPart(id, switchIndexFromEvent(e));
      } else if (comp?.kind === "clock" && comp.params?.hz === "manual") {
        e.stopPropagation();
        this.#onClockToggle?.(id);
      }
      return;
    }
    // ⌘/Ctrl-click adds this part to the selection (or takes it out) and
    // starts no drag — the press is the whole gesture.
    if (toggling) {
      e.stopPropagation();
      this.#hideHover();
      this.toggleComponentSelection(id);
      return;
    }
    this.#hideHover();
    // A press on a MEMBER of a multi-selection drags the whole selection, so
    // it must not go through selectComponent — a single pick replaces a marquee
    // (#select), which would throw the group away with the press that is about
    // to move it. The collapse still happens, at the release, if the press
    // turns out to be a plain click (#onPartPointerUp).
    if (this.#sel.parts.has(id) && this.#sel.parts.size >= 2) {
      if (this.#beginClusterDrag(id, e)) return;
      // Refused (a board is in the set, or a member won't resolve): the press
      // is absorbed and the selection is left exactly as it was. Falling
      // through would collapse it, which is the one thing a refusal must not do.
      e.stopPropagation();
      return;
    }
    this.selectComponent(id);

    const comp = this.#doc.getComponent(id);
    const view = this.#partViews.get(id);
    const w = this.#deskView.worldFromEvent(e);

    // A resistor drags RIGIDLY by its two ends (either may be a rail), and
    // rotates freely mid-drag with R — never through the footprint reseat.
    if (partDef(comp.ref)?.rotatable) {
      const ends = this.#resistorEndPoints(comp);
      if (!ends) {
        e.stopPropagation();
        return; // unresolvable pins — the press just selected it
      }
      // Near a lead → drag that end alone (any hole, any angle); on the body →
      // translate the whole resistor rigidly.
      const grabbed = this.#resistorEndAt(ends, w);
      this.#mode = grabbed
        ? this.#resistorEndDragMode(comp, ends, grabbed, e, w)
        : this.#resistorDragMode(comp, ends, e, w);
    } else if (comp.board == null) {
      // A desk-level brick (PSU, clock) drags freely on the desk.
      this.#mode = {
        kind: "drag-brick",
        ref: comp.ref,
        id,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startWorld: w,
        lastWorld: w,
        origin: { x: comp.x, y: comp.y },
        pos: { x: comp.x, y: comp.y },
        hasAnchored: this.#hasAnchored(id),
        legal: true,
        active: false,
        teardown: null,
      };
    } else {
      const board = this.#doc.getBoard(comp.board);
      // A grid anchor is the ONE thing a footprint drag needs: the column the
      // part is pinned at, so the grab point stays under the finger. A part
      // whose anchor doesn't parse (only reachable from a hand-edited file)
      // is left where it is — the press just selects it.
      const seat = parseHole(board.type, comp.anchor);
      if (seat?.kind !== "grid") {
        e.stopPropagation();
        return;
      }
      const cursorCol = columnAt(board.type, w.x - board.x);
      // OPTION TAKES THE WIRING WITH IT (Feature 290) — the wires in the nodes
      // this part's pins occupy, and the LEADS of the two-terminal parts in
      // them. All of it is read ONCE, here, and frozen for the gesture: the
      // riding sets, because recomputing them per sample would grow and shrink
      // them as the part slid over other holes (so the drop would depend on the
      // path taken to it), and the batch check, because the reduced-occupancy
      // build it hoists is precisely what a prepared check exists to keep out of
      // a live drag's loop. Option held over a part with nothing attached is
      // just a plain drag — hence the empty sets collapsing to null.
      const attached = e.altKey ? this.#doc.wiresRidingPart(id) : [];
      const legs = e.altKey ? this.#doc.partsRidingPart(id) : [];
      const riding = attached.length > 0 ? attached : null;
      const ridingParts = legs.length > 0 ? legs : null;
      this.#mode = {
        kind: "drag-part",
        id,
        ref: comp.ref,
        params: comp.params,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startWorld: w,
        lastWorld: w,
        grabOffsetCols: seat.col - cursorCol,
        origin: { board: comp.board, anchor: comp.anchor },
        seat: { board: comp.board, anchor: comp.anchor },
        hasAnchored: this.#hasAnchored(id),
        riding,
        ridingParts,
        // A solo Option-drag is a one-member cluster, so it is checked by the
        // one predicate that understands both wires and parts.
        checkBatch:
          riding || ridingParts
            ? this.#doc.prepareClusterMove({
                componentIds: [id, ...legs.map((r) => r.id)],
                wireIds: attached.map((r) => r.wireId),
              })
            : null,
        plan: null,
        // Read NOW: pointer capture (below) retargets every later event on
        // this pointerId to the part's root element, so a switch-bank click
        // resolved at pointerup would always see the body, never an actuator.
        switchIndex: switchIndexFromEvent(e),
        legal: true,
        active: false,
        teardown: null,
      };
    }
    // The hint has done its job: from here the wires themselves show what is
    // coming, so the rings would only sit on holes being vacated.
    this.#sel.refreshRidePreview();
    // Closed hand from the moment the part is grabbed (before any drag).
    this.#viewport.classList.add("desk-viewport--dragging");
    this.#mode.teardown = beginPointerGesture(view.element, e.pointerId, {
      onMove: this.#onPartPointerMove,
      onEnd: this.#onPartPointerUp,
    });
  }

  /**
   * Begin the multi-selection drag — the whole selection moves as one, and with
   * Option so does every wire riding any of it. Returns false when the press
   * must NOT start a drag, and then starts nothing at all.
   *
   * The two refusals are the same answer for different reasons. A BOARD in the
   * set has its own gesture, one that carries strips and everything seated on
   * them under overlap and mating rules a part re-seat knows nothing about; a
   * part grab can neither honour that nor sensibly ignore it, so it declines and
   * leaves the selection for the user to narrow (⌘-click) or to grab by a board
   * instead. A member that won't RESOLVE (an unknown ref, an anchor naming no
   * hole) would make a gesture that is red wherever it goes, which is worse than
   * a press that does nothing.
   */
  #beginClusterDrag(grabId, e) {
    if (this.#sel.boards.size > 0) return false;
    const members = this.#doc.clusterMembers(this.#sel.parts);
    const grab = members?.find((m) => m.id === grabId);
    const view = this.#partViews.get(grabId);
    if (!members || !grab || !view) return false;
    const w = this.#deskView.worldFromEvent(e);
    // The grab column keeps the pressed point under the finger for a footprint
    // member, exactly as the solo drag does; the other two forms track their
    // own anchor and need no offset.
    let grabOffsetCols = 0;
    if (grab.form === "footprint") {
      const board = this.#doc.getBoard(grab.board);
      const seat = parseHole(board.type, grab.anchor);
      if (seat?.kind !== "grid") return false;
      grabOffsetCols = seat.col - columnAt(board.type, w.x - board.x);
    }
    // OPTION TAKES THE WIRING WITH IT — here, for the WHOLE selection (Feature
    // 290 one level up): the wires in the nodes any member's pins occupy, and
    // the LEADS of the two-terminal parts in them. All of it is read ONCE and
    // frozen for the gesture: the riding sets, because re-deriving them per
    // sample would grow and shrink them as the parts slid over other holes (so
    // the drop would depend on the path taken to it), and the batch check,
    // because the reduced-occupancy build it hoists is precisely what must stay
    // out of a live drag's loop. Option over a selection with nothing attached
    // is just a plain group drag — hence the empty sets collapsing to null.
    const attached = e.altKey
      ? this.#doc.wiresRidingCluster(this.#sel.parts)
      : [];
    const legs = e.altKey ? this.#doc.partsRidingCluster(this.#sel.parts) : [];
    const riding = attached.length > 0 ? attached : null;
    const ridingParts = legs.length > 0 ? legs : null;
    this.#mode = {
      kind: "drag-cluster",
      grabId,
      members,
      byId: new Map(members.map((m) => [m.id, m])),
      // The GRABBED member's own resolver decides the delta the whole group
      // travels by; see model/cluster-move.js for why it is not the pointer's.
      form: grab.form,
      ref: grab.ref,
      params: grab.params,
      anchorWorld: grab.anchorWorld,
      grabOffsetCols,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startWorld: w,
      lastWorld: w,
      delta: { dx: 0, dy: 0 },
      targets: [],
      riding,
      ridingParts,
      checkBatch: this.#doc.prepareClusterMove({
        componentIds: [...members.map((m) => m.id), ...legs.map((r) => r.id)],
        wireIds: attached.map((r) => r.wireId),
      }),
      plan: null,
      // Every member that carries a label, so the whole set of them rides the
      // one delta — a group drag can be carrying several.
      anchorIds: new Set(
        members.filter((m) => this.#hasAnchored(m.id)).map((m) => m.id),
      ),
      // Read NOW, for the reason the solo drag reads it now: pointer capture
      // retargets every later event to the grabbed part's root element.
      switchIndex: switchIndexFromEvent(e),
      legal: true,
      active: false,
      teardown: null,
    };
    this.#sel.refreshRidePreview();
    this.#viewport.classList.add("desk-viewport--dragging");
    this.#mode.teardown = beginPointerGesture(view.element, e.pointerId, {
      onMove: this.#onPartPointerMove,
      onEnd: this.#onPartPointerUp,
    });
    return true;
  }

  /**
   * Where the whole cluster lands for a pointer at `world`, writing
   * d.delta/d.targets/d.plan/d.legal. Shared by the live drag and the release,
   * so the preview and the drop can never disagree.
   *
   * ONE `legal` for the lot, deliberately: the group is rigid, so a drop that
   * seated some members and left the rest behind would be a silent edit of the
   * arrangement the user built. A member with nowhere to land, a rider with
   * nowhere to land, and a hole already spoken for are one refusal in one visual
   * language — every member and every riding wire reddens together.
   *
   * A delta of null (the grabbed member is over bare desk) KEEPS the last good
   * one, as #resolvePartSeat keeps its last good seat: the group carries on
   * drawing somewhere sane while the drop reddens.
   */
  #resolveClusterMove(d, world) {
    const delta = clusterDelta(this.#doc.boards, d, world, d.members);
    if (delta) d.delta = delta;
    const { targets, resolved } = this.#doc.resolveClusterTargets(
      d.members,
      d.delta,
    );
    d.targets = targets;
    d.plan =
      d.riding || d.ridingParts
        ? this.#doc.planClusterRiders(
            d.members,
            targets,
            d.riding,
            d.ridingParts,
          )
        : null;
    d.legal =
      Boolean(delta) &&
      resolved &&
      (d.plan?.resolved ?? true) &&
      d.checkBatch(this.#clusterPlacements(d), d.plan?.moves ?? []);
  }

  /** Everything the cluster's commit moves, in the order `prepareClusterMove`
      was prepared with: the members, then the parts riding them. */
  #clusterPlacements(d) {
    return [...d.targets, ...(d.plan?.parts ?? [])];
  }

  /** The riding-wire preview for a cluster drag, or null for a plain one.
      Every riding wire gets an entry — one with no addresses when the plan
      didn't resolve, so a refused drop tints the wires it would have carried
      rather than leaving them looking uninvolved. */
  #clusterDragPreview(d) {
    if (!d.riding) return null;
    const shifts = new Map();
    for (const { wireId } of d.riding) shifts.set(wireId, {});
    for (const move of d.plan?.moves ?? []) {
      const entry = shifts.get(move.id);
      if (entry) {
        entry.from = move.from;
        entry.to = move.to;
      }
    }
    for (const { id, dx, dy } of d.plan?.points ?? []) {
      const entry = shifts.get(id);
      if (entry) entry.points = { dx, dy };
    }
    return { shifts, legal: d.legal };
  }

  /** Live positions for the cluster's desk BRICKS, or null when it holds none.
      A wire ending on a brick's terminal is anchored to the component rather
      than to a hole, so it follows a position override and not an address. */
  #clusterBrickOverrides(d) {
    const overrides = new Map();
    for (const t of d.targets) {
      if (t.form === "brick") overrides.set(t.id, { x: t.x, y: t.y });
    }
    return overrides.size > 0 ? overrides : null;
  }

  /** Draw every member at its target seat and tint the lot on the one verdict. */
  #applyClusterPreview(d) {
    for (const t of d.targets) {
      const view = this.#partViews.get(t.id);
      if (!view) continue;
      if (t.form === "brick") {
        view.setPosition(t.x, t.y);
      } else if (t.board != null) {
        // #placePartView owns the footprint/two-ends branch (and the floating
        // cue), so a rotatable member's bend rides for free.
        const member = d.byId.get(t.id);
        this.#placePartView(
          view,
          { ...member, board: t.board, anchor: t.anchor },
          this.#doc.getBoard(t.board),
        );
      }
      view.setIllegal(!d.legal);
    }
    // …and the legs of the parts riding them bend live too.
    this.#applyLeadRiders(d);
  }

  /** Redraw every member and every riding part from the DOCUMENT — the
      snap-back after a refused drop, and equally the settle after a committed
      one (a part view is not re-rendered by #emitDocChanged; its position is
      written only here and in the move handler). */
  #restoreClusterViews(d) {
    for (const m of d.members) {
      const view = this.#partViews.get(m.id);
      const comp = this.#doc.getComponent(m.id);
      if (!view || !comp) continue;
      if (comp.board == null) view.setPosition(comp.x, comp.y);
      else this.#placePartView(view, comp, this.#doc.getBoard(comp.board));
      view.setIllegal(false);
    }
    this.#restoreLeadRiders(d);
  }

  /** Where a desk brick lands for a pointer at `world` — snapped to whole
      units, with occupancy legality. Shared by the live drag and the release,
      so the preview and the drop can never disagree. */
  #resolveBrickPos(d, world) {
    d.pos = {
      x: Math.round(d.origin.x + (world.x - d.startWorld.x)),
      y: Math.round(d.origin.y + (world.y - d.startWorld.y)),
    };
    d.legal = this.#doc.canPlaceBrick(d.ref, d.pos.x, d.pos.y, {
      ignoreId: d.id,
    });
  }

  /** Which seat a footprint part lands in for a pointer at `world`, writing
      d.seat/d.legal. Returns the seat, or null when the pointer is off-board
      or off-row — in which case d.seat is deliberately LEFT at the last good
      seat and only d.legal drops, so the part keeps drawing somewhere sane
      mid-drag. That is also exactly why the release has to call this again:
      see #onPartPointerUp. */
  #resolvePartSeat(d, world) {
    const seat = this.#partSeatAt(world, d.ref, d.grabOffsetCols, d.params);
    if (seat) {
      d.seat = seat;
      d.legal = this.#doc.canPlacePart(d.ref, seat.board, seat.anchor, {
        ignoreId: d.id,
        params: d.params,
      });
    } else {
      d.legal = false; // off-board / off-row: stay at the last seat
    }
    // An Option-drag re-plans its riders for THIS seat and checks the whole
    // batch as one. They ride the same `d.legal` the part's own tint reads, so
    // an unseatable wire (or a resistor leg with nowhere to bend to) reddens the
    // drop exactly as an unseatable pin does — one refusal, one visual language.
    // Planned against `d.seat` even when the pointer fell off-board, so the
    // riders keep drawing where the part does.
    if (d.riding || d.ridingParts) {
      d.plan = this.#doc.planPartMove(d.id, {
        board: d.seat.board,
        anchor: d.seat.anchor,
        riding: d.riding,
        ridingParts: d.ridingParts,
      });
      const placements = [
        { id: d.id, board: d.seat.board, anchor: d.seat.anchor },
        ...d.plan.parts,
      ];
      if (!(d.plan.resolved && d.checkBatch(placements, d.plan.moves))) {
        d.legal = false;
      }
    }
    return seat;
  }

  /** Draw every part riding a drag at its planned seat, tinted on the one
      verdict — `#placePartView` owns the footprint/two-ends branch, so a leg
      that has bent redraws through its span geometry for free.

      A rider the plan didn't place (it refused, or there is no plan for this
      sample) is drawn from the DOCUMENT, where it actually is. Leaving it at
      the seat some earlier sample gave it would show a leg bent to a part that
      has since moved on. */
  #applyLeadRiders(d) {
    const seats = new Map((d.plan?.parts ?? []).map((s) => [s.id, s]));
    for (const { id } of d.ridingParts ?? []) {
      const view = this.#partViews.get(id);
      const comp = this.#doc.getComponent(id);
      if (!view || !comp) continue;
      const at = { ...comp, ...(seats.get(id) ?? {}) };
      this.#placePartView(view, at, this.#doc.getBoard(at.board));
      view.setIllegal(!d.legal);
    }
  }

  /** Put every part riding a drag back where the DOCUMENT has it — the
      snap-back after a refused drop, and the settle after a committed one. */
  #restoreLeadRiders(d) {
    for (const { id } of d.ridingParts ?? []) {
      const view = this.#partViews.get(id);
      const comp = this.#doc.getComponent(id);
      if (!view || !comp) continue;
      this.#placePartView(view, comp, this.#doc.getBoard(comp.board));
      view.setIllegal(false);
    }
  }

  /** The wire layer's riding-wire preview for a `drag-part` in flight, or null
      for a plain drag. Every riding wire gets an entry — one with no addresses
      when the plan didn't resolve, so a refused drop still tints the wires it
      would have carried rather than leaving them looking uninvolved. */
  #partDragPreview(d) {
    if (!d.riding) return null;
    const shifts = new Map();
    for (const { wireId } of d.riding) shifts.set(wireId, {});
    for (const move of d.plan?.moves ?? []) {
      const entry = shifts.get(move.id);
      if (entry) {
        entry.from = move.from;
        entry.to = move.to;
      }
    }
    for (const { id, dx, dy } of d.plan?.points ?? []) {
      const entry = shifts.get(id);
      if (entry) entry.points = { dx, dy };
    }
    return { shifts, legal: d.legal };
  }

  #onPartPointerMove = (e) => {
    const d = this.#mode;
    if (
      (d?.kind !== "drag-part" &&
        d?.kind !== "drag-brick" &&
        d?.kind !== "drag-cluster" &&
        d?.kind !== "drag-resistor" &&
        d?.kind !== "drag-resistor-end") ||
      e.pointerId !== d.pointerId
    ) {
      return;
    }
    if (!d.active) {
      const travel = Math.hypot(
        e.clientX - d.startClientX,
        e.clientY - d.startClientY,
      );
      if (travel < DRAG_THRESHOLD) return;
      d.active = true;
      if (d.kind === "drag-cluster") {
        for (const m of d.members) this.#partViews.get(m.id)?.setDragging(true);
      } else {
        this.#partViews.get(d.id)?.setDragging(true);
      }
    }
    const view = this.#partViews.get(d.id);
    const w = this.#deskView.worldFromEvent(e);
    // Recorded for every kind — it is the fallback the release-point resolve
    // falls back to when the "release" is a positionless synthetic abort.
    d.lastWorld = w;

    if (d.kind === "drag-cluster") {
      this.#resolveClusterMove(d, w);
      this.#applyClusterPreview(d);
      // One call carries both channels: the riding wires' new addresses and the
      // live positions of any bricks whose terminals wires end on.
      this.#wireLayer.setPartDrag(
        this.#clusterDragPreview(d),
        this.#clusterBrickOverrides(d),
      );
      // Every label hung on any member rides the one delta.
      if (d.anchorIds.size > 0) {
        this.#annotationLayer.render({
          anchorIds: d.anchorIds,
          dx: d.delta.dx,
          dy: d.delta.dy,
        });
      }
      return;
    }

    if (d.kind === "drag-resistor") {
      this.#trackResistorDrag();
      return;
    }
    if (d.kind === "drag-resistor-end") {
      this.#trackResistorEndDrag();
      return;
    }

    if (d.kind === "drag-brick") {
      this.#resolveBrickPos(d, w);
      view?.setPosition(d.pos.x, d.pos.y);
      view?.setIllegal(!d.legal);
      // Wires on this PSU's terminals follow it live.
      this.#wireLayer.render(new Map([[d.id, d.pos]]));
      // Labels anchored to this brick ride it live.
      if (d.hasAnchored) {
        this.#annotationLayer.render({
          anchorIds: new Set([d.id]),
          dx: d.pos.x - d.origin.x,
          dy: d.pos.y - d.origin.y,
        });
      }
      return;
    }

    const seat = this.#resolvePartSeat(d, w);
    // Ride the lattice, snapped; tint tells occupancy legality.
    if (seat)
      view?.updatePlacement(this.#doc.getBoard(seat.board), seat.anchor);
    view?.setIllegal(!d.legal);
    // An Option-drag's wires follow live (a plain drag never touches the layer).
    if (d.riding) this.#wireLayer.setPartDrag(this.#partDragPreview(d));
    // …and so do the legs of the parts attached to it.
    if (d.ridingParts) this.#applyLeadRiders(d);
    // Labels anchored to this part ride it live, by its anchor-hole delta.
    if (d.hasAnchored) {
      const shift = this.#anchorDelta(d.origin, d.seat);
      if (shift) {
        this.#annotationLayer.render({ anchorIds: new Set([d.id]), ...shift });
      }
    }
  };

  /** World (dx, dy) between a part's origin and current anchor holes, or null. */
  #anchorDelta(origin, seat) {
    const originW = this.#addressWorld(`${origin.board}.${origin.anchor}`);
    const seatW = this.#addressWorld(`${seat.board}.${seat.anchor}`);
    if (!originW || !seatW) return null;
    return { dx: seatW.x - originW.x, dy: seatW.y - originW.y };
  }

  #onPartPointerUp = (e) => {
    const d = this.#mode;
    if (
      (d?.kind !== "drag-part" &&
        d?.kind !== "drag-brick" &&
        d?.kind !== "drag-cluster" &&
        d?.kind !== "drag-resistor" &&
        d?.kind !== "drag-resistor-end") ||
      e.pointerId !== d.pointerId
    ) {
      return;
    }
    this.#mode = null;
    this.#viewport.classList.remove("desk-viewport--dragging");
    // With the drag over, the hint comes back if Option is still down — from
    // here, so every exit below (a plain click, a refused drop, a commit) is
    // covered by one call. A commit refreshes it again through #emitDocChanged,
    // which is what moves the rings onto the holes the wires actually landed in.
    this.#sel.refreshRidePreview();

    d.teardown?.();
    if (d.kind === "drag-cluster") {
      for (const m of d.members) {
        const memberView = this.#partViews.get(m.id);
        memberView?.setDragging(false);
        memberView?.setIllegal(false);
      }
    }
    const view = this.#partViews.get(d.id);
    if (view) {
      view.setDragging(false);
      view.setIllegal(false);
    }
    // Put the riding-wire preview away BEFORE any mutation: this redraws the
    // layer from the document, which is already the right picture for a revert,
    // and a commit below re-renders it again through #emitDocChanged. Doing it
    // here means every exit from this handler is covered by one call — including
    // the synthetic pointercancel #rebuildScene routes through it.
    this.#wireLayer.setPartDrag(null);

    // A drag that spans Run (editing locked mid-gesture) reverts, never
    // commits — the teardown above already ran, so this only skips the mutation.
    const cancelled = e.type === "pointercancel" || this.#editingLocked;

    if (d.kind === "drag-cluster") {
      if (!d.active) {
        // A plain click on a member is the collapse the PRESS deferred: the
        // selection narrows to the one part, exactly as a press on a non-member
        // does. Without it a click inside a selection would do nothing at all,
        // which reads as a dead press.
        this.selectComponent(d.grabId);
        const comp = this.#doc.getComponent(d.grabId);
        if (clickTogglingPart(comp?.ref)) {
          this.#toggleClickPart(d.grabId, d.switchIndex ?? null);
        }
        return;
      }
      // Re-resolve at the RELEASE point, for the reason the solo drag does: a
      // fast release whose last coalesced move caught the group mid-flight
      // would otherwise revert a perfectly good drop, and a release over bare
      // desk after a legal last move must not commit.
      if (!cancelled) {
        this.#resolveClusterMove(
          d,
          releaseWorld(this.#deskView, e, d.lastWorld),
        );
      }
      const moved = d.delta.dx !== 0 || d.delta.dy !== 0;
      if (!cancelled && d.legal && moved) {
        // Every member AND everything riding it in ONE mutation, so ⌘Z restores
        // the whole arrangement — it was never several edits.
        this.#doc.moveClusterWithWires(this.#clusterPlacements(d), d.plan);
        if (d.anchorIds.size > 0) {
          this.#shiftAnchoredAnnotations(d.anchorIds, d.delta.dx, d.delta.dy);
        }
        this.#restoreClusterViews(d); // now the document's own positions
        this.#emitDocChanged("move parts");
      } else {
        this.#restoreClusterViews(d); // an illegal drop wrote nothing
        this.#wireLayer.render();
        if (d.anchorIds.size > 0) this.#annotationLayer.render();
      }
      return;
    }

    if (d.kind === "drag-resistor-end") {
      if (!d.active) return; // plain click — the press already selected it
      // Re-derive the lead at the RELEASE point. #trackResistorEndDrag reads
      // d.lastWorld, so moving that is the whole re-resolve — and it must
      // happen, since a stale sample doesn't merely misplace the lead: it can
      // fail canPlacePart's minimum-span check and revert the drag outright.
      if (!cancelled) {
        d.lastWorld = releaseWorld(this.#deskView, e, d.lastWorld);
        this.#trackResistorEndDrag(d);
      }
      if (!cancelled && d.legal && d.target) {
        this.#doc.movePartEnds(
          d.id,
          d.target.boardId,
          d.target.anchor,
          d.target.end,
        );
        this.#emitDocChanged("move part");
      }
      // Redraw from the document — an illegal drop wrote nothing, so the lead
      // springs back to where it was.
      this.#remountPart(d.id);
      return;
    }

    if (d.kind === "drag-resistor") {
      if (!d.active) return; // plain click — the press already selected it
      // Same re-resolve as the end drag: rewrite d.holes/d.legal at the
      // release point rather than trusting the last coalesced move.
      if (!cancelled) {
        d.lastWorld = releaseWorld(this.#deskView, e, d.lastWorld);
        this.#trackResistorDrag(d, { preview: false });
      }
      if (!cancelled && d.legal && d.holes) {
        // An Option-drag commits the part AND everything riding it as ONE
        // mutation (the same transaction a footprint part's does); a plain drag
        // takes the two-ends path with nothing to carry.
        if (d.riding || d.ridingParts) {
          this.#doc.moveClusterWithWires(
            [
              {
                id: d.id,
                board: d.holes.boardId,
                anchor: d.holes.anchor,
                params: { rot: 90, end: d.holes.end },
              },
              ...d.plan.parts,
            ],
            d.plan,
          );
        } else {
          this.#doc.movePartEnds(
            d.id,
            d.holes.boardId,
            d.holes.anchor,
            d.holes.end,
          );
        }
        this.#emitDocChanged("move part");
      }
      // Commit or not, redraw from the document — an illegal drop leaves the
      // document untouched, so this snaps the resistor back to its origin.
      this.#remountPart(d.id);
      this.#restoreLeadRiders(d);
      return;
    }

    if (d.kind === "drag-brick") {
      if (!d.active) return;
      if (!cancelled) {
        this.#resolveBrickPos(d, releaseWorld(this.#deskView, e, d.lastWorld));
      }
      const moved = d.pos.x !== d.origin.x || d.pos.y !== d.origin.y;
      if (!cancelled && d.legal && moved) {
        this.#doc.moveBrick(d.id, d.pos.x, d.pos.y);
        // A part view is NOT re-rendered by #emitDocChanged — its DOM position
        // is written only here and in the move handler — so the re-resolved
        // position has to be pushed to the element explicitly, or the document
        // would commit the release point while the brick sat at the stale one.
        view?.setPosition(d.pos.x, d.pos.y);
        if (d.hasAnchored) {
          this.#shiftAnchoredAnnotations(
            d.id,
            d.pos.x - d.origin.x,
            d.pos.y - d.origin.y,
          );
        }
        this.#emitDocChanged("move part");
      } else {
        view?.setPosition(d.origin.x, d.origin.y);
        this.#wireLayer.render();
        if (d.hasAnchored) this.#annotationLayer.render(); // snap labels back
      }
      return;
    }

    if (!d.active) {
      // Plain click: a slide switch, toggle button, or DIP switch bank
      // position flips (always interactive).
      const comp = this.#doc.getComponent(d.id);
      if (clickTogglingPart(comp?.ref)) {
        this.#toggleClickPart(d.id, d.switchIndex ?? null);
      }
      return;
    }
    // THE headline of this whole gesture: re-seat at the RELEASE point. The
    // move handler leaves d.legal false whenever its sample fell off-board or
    // off-row while KEEPING d.seat at the last good seat — so a fast release,
    // whose final coalesced move caught the part mid-flight over the trench,
    // used to revert an otherwise-perfect reseat with no cue but the snap-back.
    // It flips legality both ways: a release over bare desk after a legal last
    // move must not commit either.
    if (!cancelled) {
      this.#resolvePartSeat(d, releaseWorld(this.#deskView, e, d.lastWorld));
    }
    const moved =
      d.seat.board !== d.origin.board || d.seat.anchor !== d.origin.anchor;
    // A chip flipped mid-drag commits its half-lap even if it lands back where
    // it started (the footprint maps onto itself, so it's always legal).
    const flipped = !cancelled && d.flip === true;
    if (flipped) this.#doc.rotateComponent(d.id);
    if (!cancelled && d.legal && moved) {
      // An Option-drag commits the part AND everything riding it as ONE
      // mutation, so ⌘Z restores them together — they were never two edits. A
      // plain drag takes the same path with nothing to carry.
      if (d.riding || d.ridingParts) {
        this.#doc.moveComponentWithWires(
          d.id,
          d.seat.board,
          d.seat.anchor,
          d.plan,
        );
      } else {
        this.#doc.moveComponent(d.id, d.seat.board, d.seat.anchor);
      }
      view?.updatePlacement(this.#doc.getBoard(d.seat.board), d.seat.anchor);
      this.#restoreLeadRiders(d); // now the document's own positions
      if (d.hasAnchored) {
        const shift = this.#anchorDelta(d.origin, d.seat);
        if (shift) this.#shiftAnchoredAnnotations(d.id, shift.dx, shift.dy);
      }
      this.#emitDocChanged("move part");
    } else {
      if (flipped) this.#emitDocChanged("flip chip");
      else if (d.hasAnchored) this.#annotationLayer.render(); // snap labels back
      view?.updatePlacement(
        this.#doc.getBoard(d.origin.board),
        d.origin.anchor,
      );
      this.#restoreLeadRiders(d); // an illegal drop wrote nothing
    }
    // Sync the drawn orientation to the document (undoes a cancelled preview).
    if (d.flip) view?.updateParams(this.#doc.getComponent(d.id)?.params ?? {});
  };

  /** Every part's context menu is the SAME three items, always, in this
      order — no more per-kind branching: a picker (PSU volts, clock/
      oscillator rate, LCD colour, ROM programming, memory inspection…) is a
      Properties-dialog field now, never a menu item of its own (see
      #propertyFieldsFor). Properties… is always enabled — every part has at
      least Name/Description. Items that don't currently apply otherwise stay
      PRESENT but `disabled`, so the menu's shape never changes, only its
      enabled state. */
  #onPartContextMenu(id, e) {
    e.preventDefault();
    if (this.#probe.armed) return; // right-click names the net (viewport handler)
    if (this.#mode) return;
    this.selectComponent(id);
    const comp = this.#doc.getComponent(id);
    const def = partDef(comp?.ref);
    const rows = this.#pinoutRows(def);
    const items = [
      {
        label: t("desk.menu.pinAssignment"),
        disabled: rows == null,
        onSelect: () => this.#onOpenPinout?.(comp.ref, rows, comp.params?.rot),
      },
      { separator: true },
      {
        label: t("desk.menu.properties"),
        onSelect: () => this.#onOpenProperties(id),
      },
      { separator: true },
      {
        label: t("desk.menu.deleteComponent"),
        danger: true,
        disabled: this.#editingLocked,
        onSelect: () => this.removeComponent(id),
      },
    ];
    PopupManager.menu({ x: e.clientX, y: e.clientY, items });
  }

  // ── Annotation gestures (labels & notes, Feature 120) ───────────────────

  #onAnnotationPointerDown(id, e) {
    if (e.button !== 0) return;
    if (e.shiftKey) return; // shift-drag is the viewport's marquee
    // No annotation drags while placing/dragging, probing (clicks pin nets),
    // or running (topology + decoration frozen).
    if (this.#mode || this.#probe.armed || this.#editingLocked) return;
    // An annotation cannot join a multi-selection (it is none of the three
    // sets a marquee builds), so the additive chord leaves the selection
    // alone here rather than trading it for the note. A plain click selects.
    if (isToggleSelectEvent(e, IS_MAC)) {
      e.stopPropagation();
      return;
    }
    this.#hideHover();
    this.selectAnnotation(id);
    const ann = this.#doc.getAnnotation(id);
    if (!ann) return;
    const box = e.currentTarget;
    const start = this.#deskView.worldFromEvent(e);
    this.#mode = {
      kind: "drag-annotation",
      id,
      elem: box, // the gesture's capture target (its teardown needs it)
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startWorld: start,
      lastWorld: start,
      origin: { x: ann.x, y: ann.y },
      pos: { x: ann.x, y: ann.y },
      active: false,
      teardown: null,
    };
    this.#viewport.classList.add("desk-viewport--dragging");
    this.#mode.teardown = beginPointerGesture(box, e.pointerId, {
      onMove: this.#onAnnotationPointerMove,
      onEnd: this.#onAnnotationPointerUp,
    });
  }

  /** A label follows the pointer freely — no lattice, no legality. Shared by
      the live drag and the release. */
  #resolveAnnotationPos(d, world) {
    d.pos = {
      x: d.origin.x + (world.x - d.startWorld.x),
      y: d.origin.y + (world.y - d.startWorld.y),
    };
  }

  #onAnnotationPointerMove = (e) => {
    const d = this.#mode;
    if (d?.kind !== "drag-annotation" || e.pointerId !== d.pointerId) return;
    if (!d.active) {
      const travel = Math.hypot(
        e.clientX - d.startClientX,
        e.clientY - d.startClientY,
      );
      if (travel < DRAG_THRESHOLD) return;
      d.active = true;
    }
    const w = this.#deskView.worldFromEvent(e);
    d.lastWorld = w;
    this.#resolveAnnotationPos(d, w);
    this.#annotationLayer.setPosition(d.id, d.pos.x, d.pos.y);
  };

  #onAnnotationPointerUp = (e) => {
    const d = this.#mode;
    if (d?.kind !== "drag-annotation" || e.pointerId !== d.pointerId) return;
    this.#mode = null;
    this.#viewport.classList.remove("desk-viewport--dragging");
    d.teardown?.();
    if (!d.active) return; // plain click — the press already selected it
    // A drag that spans Run (editing locked mid-gesture) reverts, never
    // commits — the teardown above already ran, so this only skips the mutation.
    const cancelled = e.type === "pointercancel" || this.#editingLocked;
    // Land where the pointer was LET GO, not where the last (coalesced)
    // pointermove said it was.
    if (!cancelled) {
      this.#resolveAnnotationPos(
        d,
        releaseWorld(this.#deskView, e, d.lastWorld),
      );
    }
    const moved = d.pos.x !== d.origin.x || d.pos.y !== d.origin.y;
    if (!cancelled && moved) {
      this.#doc.updateAnnotation(d.id, { x: d.pos.x, y: d.pos.y });
      this.#emitDocChanged("move annotation");
    } else {
      this.#annotationLayer.render(); // snap back from the document
    }
  };

  #onAnnotationContextMenu(id, e) {
    e.preventDefault();
    // While probing, the viewport handler names the net under the cursor.
    if (this.#probe.armed || this.#mode || this.#editingLocked) return;
    this.selectAnnotation(id);
    PopupManager.menu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: t("desk.menu.editText"),
          onSelect: () => this.#annotationLayer.beginEdit(id),
        },
        {
          label: t("desk.menu.remove"),
          danger: true,
          onSelect: () => this.removeAnnotation(id),
        },
      ],
    });
  }

  // ── Marquee selection (shift-drag anywhere) ─────────────────────────────

  /** Components whose EVERY pin/terminal lies inside the world-unit rect. */
  #componentsWithin(rect) {
    return componentsInRect(this.#doc.boards, this.#doc.components, rect);
  }

  /** Boards lying WHOLLY inside the world-unit rect (Feature 240). */
  #boardsWithin(rect) {
    return boardsInRect(this.#doc.boards, rect);
  }

  /** Wires with BOTH endpoints inside the world-unit rect. */
  #wiresWithin(rect) {
    return wiresInRect(
      this.#doc.boards,
      this.#doc.components,
      this.#doc.wires,
      rect,
    );
  }

  #beginMarquee(e) {
    this.#hideHover();
    this.#viewport.classList.add("desk-viewport--selecting"); // crosshair
    const world = this.#deskView.worldFromEvent(e);
    this.#marquee = el("div", { class: "marquee" });
    this.#layers.overlay.append(this.#marquee);
    this.#mode = {
      kind: "marquee",
      pointerId: e.pointerId,
      startWorld: world,
      lastWorld: world,
      rect: { minX: world.x, minY: world.y, maxX: world.x, maxY: world.y },
      teardown: null,
    };
    this.#mode.teardown = beginPointerGesture(this.#viewport, e.pointerId, {
      onMove: this.#onMarqueePointerMove,
      onEnd: this.#onMarqueePointerUp,
    });
  }

  /** The rubber-band rect from the press point to `world` — shared by the
      live preview and the release, so the box drawn and the box selected
      from can never disagree. */
  #marqueeRect(m, world) {
    return {
      minX: Math.min(m.startWorld.x, world.x),
      minY: Math.min(m.startWorld.y, world.y),
      maxX: Math.max(m.startWorld.x, world.x),
      maxY: Math.max(m.startWorld.y, world.y),
    };
  }

  #onMarqueePointerMove = (e) => {
    const m = this.#mode;
    if (m?.kind !== "marquee" || e.pointerId !== m.pointerId) return;
    const w = this.#deskView.worldFromEvent(e);
    m.lastWorld = w;
    m.rect = this.#marqueeRect(m, w);
    const box = this.#marquee;
    if (!box) return;
    box.style.left = `${m.rect.minX * PX_PER_UNIT}px`;
    box.style.top = `${m.rect.minY * PX_PER_UNIT}px`;
    box.style.width = `${(m.rect.maxX - m.rect.minX) * PX_PER_UNIT}px`;
    box.style.height = `${(m.rect.maxY - m.rect.minY) * PX_PER_UNIT}px`;
  };

  #onMarqueePointerUp = (e) => {
    const m = this.#mode;
    if (m?.kind !== "marquee" || e.pointerId !== m.pointerId) return;
    this.#mode = null;
    m.teardown?.();
    this.#marquee?.remove();
    this.#marquee = null;
    this.#viewport.classList.remove("desk-viewport--selecting");
    // A marquee that spans Run applies no selection into the frozen state.
    if (e.type === "pointercancel" || this.#editingLocked) return;
    // Re-band from the RELEASE point, not the last pointermove — a fast
    // rubber-band that ends a few pitches short would otherwise silently drop
    // whatever sat at the edge of the box, with no snap-back to hint at it.
    m.rect = this.#marqueeRect(m, releaseWorld(this.#deskView, e, m.lastWorld));
    this.#sel.setMulti(
      this.#componentsWithin(m.rect),
      this.#wiresWithin(m.rect),
      this.#boardsWithin(m.rect),
    );
  };

  /**
   * Delete every marquee-selected component in ONE step (a single
   * doc-changed). Bricks cascade their attached wires, so that's confirmed
   * once for the whole batch rather than per part.
   */
  removeSelectedComponents() {
    const ids = [...this.#sel.parts];
    const wireIds = [...this.#sel.wires];
    const boardIds = [...this.#sel.boards];
    if (
      ids.length + wireIds.length + boardIds.length === 0 ||
      this.#editingLocked
    ) {
      return;
    }
    // Bricks cascade their attached wires, and a board cascades everything
    // seated on it. What the marquee already picked is going anyway, so only
    // the EXTRA casualties need confirming.
    const wires = new Set();
    const parts = new Set();
    for (const id of ids) {
      for (const w of this.#doc.wiresTouching(id)) {
        if (!this.#sel.wires.has(w.id)) wires.add(w.id);
      }
    }
    for (const bid of boardIds) {
      for (const c of this.#doc.componentsOnBoard(bid)) {
        if (!this.#sel.parts.has(c.id)) parts.add(c.id);
      }
      for (const w of this.#doc.wiresTouching(bid)) {
        if (!this.#sel.wires.has(w.id)) wires.add(w.id);
      }
    }
    if (wires.size === 0 && parts.size === 0) {
      this.#doRemoveSelected(ids, wireIds, boardIds);
      return;
    }
    const count = (n, kind) => t(`desk.count.${kind}`, { count: n });
    const what = [
      boardIds.length && count(boardIds.length, "boards"),
      ids.length && count(ids.length, "parts"),
      wireIds.length && count(wireIds.length, "wires"),
    ]
      .filter(Boolean)
      .join(", ");
    const extra = [
      parts.size && count(parts.size, "moreParts"),
      wires.size && count(wires.size, "moreWires"),
    ]
      .filter(Boolean)
      .join(t("desk.count.and"));
    PopupManager.confirm({
      title: t("desk.remove.selectionTitle", { what }),
      message: t("desk.remove.selectionMessage", { extra }),
      confirmLabel: t("desk.remove.confirm"),
      confirmClass: "btn--danger",
      onConfirm: () => this.#doRemoveSelected(ids, wireIds, boardIds),
    });
  }

  #doRemoveSelected(ids, wireIds = [], boardIds = []) {
    this.#sel.clearMulti();
    for (const id of ids) {
      const comp = this.#doc.getComponent(id);
      if (!comp) continue; // already cascaded away
      this.#releaseMemory(comp); // a ROM's backing file goes with it
      this.#doc.removeComponent(id);
      this.#partViews.get(id)?.remove();
      this.#partViews.delete(id);
    }
    for (const id of wireIds) {
      if (this.#doc.getWire(id)) this.#doc.removeWire(id); // may have cascaded
    }
    // Boards last: each cascades whatever is still seated on it, so the parts
    // and wires already removed above simply aren't there to remove twice.
    this.#tearDownBoards(boardIds);
    this.#hideHover();
    this.#emitDocChanged("delete selection");
  }

  // ── Viewport-level pointer handling ─────────────────────────────────────

  #onViewportPointerDown = (e) => {
    this.#lastDown = { x: e.clientX, y: e.clientY };
    if (this.#mode || e.button !== 0) return; // busy (tool/drag) or non-left
    // A wire and a bus are toggled from HERE rather than from their own click
    // listeners, so that every kind of item joins the selection on the press,
    // as a part and a board do.
    const toggling = isToggleSelectEvent(e, IS_MAC);
    if (toggling) {
      const wireId = e.target?.closest?.(".wire")?.dataset.wireId;
      // A wire's own hit stroke sits ABOVE the bus band, so whichever the
      // press landed on is what the event target already says.
      const busId = wireId
        ? null
        : e.target?.closest?.(".bus-band")?.dataset.busId;
      if (wireId || busId) {
        this.#hideHover();
        if (wireId) this.toggleWireSelection(wireId);
        else this.toggleBusSelection(busId);
        return;
      }
    }
    // Shift-drag anywhere rubber-bands a multi-selection (never a pan — DeskView
    // skips shift-left too). Not while probing or running.
    if (e.shiftKey && !this.#probe.armed && !this.#editingLocked) {
      this.#beginMarquee(e);
      return;
    }
    // The additive chord is a SELECT, never a drag — so the wire and bus grabs
    // below stand down for it (the toggle above has already had its say).
    // Not while probing (clicks pin nets) or running (topology frozen). A
    // press near a wire cap re-routes its end; on the body, translates it; on a
    // bundle band (below the wires), it drags the whole bus.
    if (!this.#probe.armed && !this.#editingLocked && !toggling) {
      const world = this.#deskView.worldFromEvent(e);
      if (this.#wire.tryBeginDrag(e, world)) return;
      if (this.#bus.tryBeginDrag(e, world)) return;
    }
    // Click on truly empty desk (the viewport itself — layers are zero-size
    // and overlay children are pointer-inert) deselects. Held modifier and it
    // does not: an ADD that landed on nothing has nothing to add, which is not
    // the same as asking for the selection to be cleared.
    if (e.target === this.#viewport && !toggling) this.deselect();
  };

  #onViewportClick = (e) => {
    const m = this.#mode;
    if (
      !this.placementArmed &&
      m?.kind !== "wire" &&
      m?.kind !== "bus" &&
      !this.#probe.armed
    )
      return;
    // A pan that started while armed still ends in a click — suppress it.
    if (
      this.#lastDown &&
      Math.hypot(e.clientX - this.#lastDown.x, e.clientY - this.#lastDown.y) >=
        DRAG_THRESHOLD
    ) {
      return;
    }
    if (this.#probe.armed) {
      this.#probe.commitClick(this.#deskView.worldFromEvent(e));
      return;
    }
    if (m.kind === "wire") {
      this.#wire.commitClick(e);
      return;
    }
    if (m.kind === "bus") {
      this.#bus.commitClick(e);
      return;
    }
    if (m.kind === "place-cluster") {
      this.#place.trackClusterGhost(e); // shading reflects the exact click point
      if (m.legalCount === 0) return; // nothing seats here — stay armed
      this.#place.commitClusterPaste();
      return;
    }
    if (m.kind === "place-design") {
      this.#place.trackDesignGhost(e); // the tint reflects the exact click point
      if (!m.legal) return; // half a design is no design — stay armed
      this.#place.commitDesignPaste();
      return;
    }
    this.#place.track(e); // ensure the seat reflects the click point
    if (!m.legal) return; // stay armed, the tint explains why
    this.cancelPlacement();
    if (m.kind === "place") {
      this.addKitAt(m.kit, m.pos.x, m.pos.y, m.rot, m.flipRails);
    } else if (m.kind === "place-brick") {
      this.addBrickAt(m.ref, m.pos.x, m.pos.y, m.params);
    } else if (m.kind === "place-annotation") {
      this.addAnnotationAt(m.annKind, m.pos.x, m.pos.y, m.anchor);
    } else if (m.kind === "place-part") {
      this.addComponentAt(
        m.ref,
        m.board,
        m.anchor,
        m.turns ? { ...m.params, rot: 90, end: m.end } : m.params,
      );
    } else {
      this.addComponentAt(m.ref, m.board, m.anchor, m.params);
    }
  };

  #onViewportPointerMove = (e) => {
    const m = this.#mode;
    if (this.placementArmed) {
      this.#place.track(e);
      return;
    }
    if (m?.kind === "wire") {
      this.#wire.trackMove(e);
      return;
    }
    if (m?.kind === "bus") {
      this.#bus.trackMove(e);
      return;
    }
    if (this.#probe.armed) {
      this.#probe.trackMove(this.#deskView.worldFromEvent(e));
      return;
    }
    if (m) return; // dragging — hover stays hidden

    const world = this.#deskView.worldFromEvent(e);
    // Hover addressing: suppressed below the zoom floor.
    if (this.#deskView.camera.zoom < HOVER_MIN_ZOOM) {
      this.#hideHover();
      return;
    }
    const hit = this.#hitTest(world);
    if (!hit) {
      this.#hideHover();
      return;
    }
    if (hit.key === this.#hoverKey) return; // shown or pending already
    this.#hideHover();
    this.#hoverKey = hit.key;
    this.#hoverTimer = setTimeout(() => this.#showHover(hit), HOVER_DWELL_MS);
  };

  // ── Hover addressing (holes, part pins, PSU terminals — pure math) ──────

  /** The board + hole under a world point — see occupancy.js holeAtWorld(),
      the one authority (this used to be a second, subtly different scan). */
  #holeAtWorld(world) {
    return holeAtWorld(this.#doc.boards, world.x, world.y);
  }

  /**
   * What the pointer is over — a part pin/terminal (they sit above) or a bare
   * hole — as `{ key, label, address, x, y }`. See model/part-geometry.js.
   */
  #hitTest(world) {
    return hoverHitAt(this.#doc.boards, this.#doc.components, world);
  }

  #showHover({ label, x, y }) {
    const wx = x * PX_PER_UNIT;
    const wy = y * PX_PER_UNIT;

    const r = RING_RADIUS * PX_PER_UNIT;
    this.#ring.style.left = `${wx - r}px`;
    this.#ring.style.top = `${wy - r}px`;
    this.#ring.hidden = false;

    this.#tooltip.textContent = label;
    this.#tooltip.style.left = `${wx}px`;
    this.#tooltip.style.top = `${wy}px`;
    // Counter-scale so the label reads the same at every zoom.
    this.#tooltip.style.setProperty(
      "--inv-zoom",
      String(1 / this.#deskView.camera.zoom),
    );
    this.#tooltip.hidden = false;
  }

  #hideHover() {
    clearTimeout(this.#hoverTimer);
    this.#hoverTimer = null;
    this.#hoverKey = null;
    this.#ring.hidden = true;
    this.#ring.classList.remove("hole-ring--illegal");
    this.#tooltip.hidden = true;
    // The bus tool rings a SET of holes instead of the one ring above; the
    // pointer leaving is over nothing for either of them.
    this.#bus?.hideRings();
  }

  /**
   * The single commit seam (Feature 200): every document mutation funnels
   * through here, so this is where a labelled snapshot is pushed to the undo
   * history. A `restore` replay sets `#restoring` so it doesn't re-record, and
   * history is frozen while the circuit runs. `opts.coalesce` merges a rapid
   * same-label burst (a param nudge) into one undo step.
   *
   * @param {string} [label] - a short verb for the edit ("move board", …).
   * @param {{coalesce?: boolean}} [opts]
   */
  #emitDocChanged(label = "edit", opts = {}) {
    // Boards may have moved, been torn out of a group, or been deleted —
    // re-trace the highlighter before anyone renders from the new document.
    this.#sel.refreshBoardOutline();
    // The same for the Option hint: a wire it rings may have just been deleted,
    // moved, or laid. No-ops unless Option is actually down.
    this.#sel.refreshRidePreview();
    if (!this.#restoring) {
      const dropped = this.#history.record(
        this.#doc.snapshot(),
        label,
        Date.now(),
        opts,
      );
      this.#reconcileMemoryFiles(dropped);
      this.#notifyHistoryState();
    }
    window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  }

  /**
   * Release a ROM chip's backing file once its GUID has fallen out of EVERY
   * snapshot the undo/redo history still retains (a redo-future truncation or
   * a depth-limit eviction) — otherwise placing a ROM, undoing it, then
   * making any other edit leaks its `.bin` file forever (the doc no longer
   * references the GUID, but nothing ever told main to delete it).
   * @param {object[]} droppedSnapshots
   */
  #reconcileMemoryFiles(droppedSnapshots) {
    if (!droppedSnapshots?.length || !this.#onRemoveMemoryFile) return;
    const droppedGuids = this.#romGuidsIn(droppedSnapshots);
    if (!droppedGuids.size) return;
    const retainedGuids = this.#romGuidsIn(this.#history.snapshots());
    for (const guid of droppedGuids) {
      if (!retainedGuids.has(guid)) this.#onRemoveMemoryFile(guid);
    }
  }

  /** Every ROM chip GUID referenced across a set of document snapshots. */
  #romGuidsIn(snapshots) {
    const guids = new Set();
    for (const snap of snapshots) {
      for (const comp of snap?.components ?? []) {
        const guid = comp?.params?.storage?.guid;
        if (guid && isRomChip(partDef(comp.ref))) guids.add(guid);
      }
    }
    return guids;
  }

  // ── Undo / redo (Feature 200) ────────────────────────────────────────────

  /** Whether an undo is currently available (false while running). */
  get canUndo() {
    return !this.#editingLocked && this.#history.canUndo;
  }

  /** Whether a redo is currently available (false while running). */
  get canRedo() {
    return !this.#editingLocked && this.#history.canRedo;
  }

  /** Restore the previous snapshot. @returns {boolean} true when it acted. */
  undo() {
    if (this.#editingLocked) return false; // history frozen during a run
    const snapshot = this.#history.undo();
    if (snapshot == null) return false;
    this.#restoreSnapshot(snapshot);
    return true;
  }

  /** Restore the next snapshot. @returns {boolean} true when it acted. */
  redo() {
    if (this.#editingLocked) return false;
    const snapshot = this.#history.redo();
    if (snapshot == null) return false;
    this.#restoreSnapshot(snapshot);
    return true;
  }

  /**
   * Swap the desk for ANOTHER DOCUMENT entirely — a project tab switch, or a
   * file loaded into the active tab (Feature 240). It rides the same
   * restore + `#rebuildScene` path undo/redo uses, which is exactly why a tab
   * switch needs no page reload: that path IS the in-process teardown.
   *
   * The document is untrusted (it came from a file), so it goes in through
   * `DeskDoc.load` — normalized — not `restore`.
   *
   * Each tab owns its own undo history, handed in here: switching away and
   * back leaves ⌘Z undoing THAT desk's last edit, not the other one's. A store
   * with no entries yet is seeded with the loaded document as its baseline.
   * The copy buffers are deliberately NOT cleared — carrying a design from one
   * desktop to another is the whole point of the feature.
   *
   * @param {object} raw - a document as loaded from a file.
   * @param {{history?: import('../model/history-store.js').HistoryStore}} [opts]
   */
  loadDocument(raw, { history = null } = {}) {
    this.cancelPlacement();
    this.disarmWireTool();
    this.disarmBusTool();
    this.disarmProbe();
    this.#restoring = true; // a load is not an edit — never record it
    try {
      this.#doc.load(raw);
      this.#adoptUnbackedMemories();
      if (history) this.#history = history;
      if (this.#history.size === 0) this.#history.clear(this.#doc.snapshot());
      this.#rebuildScene();
      window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
    } finally {
      this.#restoring = false;
    }
    this.#notifyHistoryState();
  }

  /**
   * Swap the whole document for a history snapshot and rebuild the scene from
   * it — the same full teardown + remount New/Open would do, never a partial,
   * drift-prone re-mount. `#restoring` keeps the resulting doc-changed from
   * re-recording the restore as a fresh edit.
   */
  #restoreSnapshot(snapshot) {
    this.#restoring = true;
    try {
      this.#doc.restore(snapshot);
      this.#rebuildScene();
      // Announce so autosave, the title/dirty marker, the sim, and the probe
      // all reconcile — but not through the recording seam.
      window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
    } finally {
      this.#restoring = false;
    }
    this.#notifyHistoryState();
  }

  /**
   * Tear down every mounted view and remount the whole scene from the current
   * document — the reusable full-rebuild path (undo/redo restore). Selection is
   * dropped; wires and the board outline re-render from the shared DeskDoc.
   */
  #rebuildScene() {
    // A drag in flight must die HERE, before its views do. The gesture's
    // listeners live on `window` (see pointer-gesture.js), so unlike the old
    // element-scoped ones they SURVIVE the unmount below — a release arriving
    // afterwards would commit against #views/#partViews entries that no longer
    // exist. Undo/redo mid-drag and a tab switch mid-drag both land here.
    if (this.#dragGestureActive) this.#cancelDragGesture();
    // Drop all selection state first (the views it points at are about to go).
    this.#sel.forgetAll();
    this.#hideHover();
    // Unmount every board and part view (keep the Map objects — collaborators
    // hold references to them).
    for (const view of this.#views.values()) view.remove();
    this.#views.clear();
    for (const view of this.#partViews.values()) view.remove();
    this.#partViews.clear();
    // Remount from the restored document.
    for (const board of this.#doc.boards) this.#mountBoard(board);
    for (const component of this.#doc.components) this.#mountPart(component);
    this.#wireLayer.render();
    this.#sel.refreshBoardOutline();
  }

  /** Push the current undo/redo availability to the Edit menu. */
  #notifyHistoryState() {
    this.#onHistoryChange?.({ canUndo: this.canUndo, canRedo: this.canRedo });
  }
}

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
import { t, tf } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import { PX_PER_UNIT, clampZoom } from "../desk/desk-geometry.js";
import {
  ROTATIONS,
  anchorColumn,
  columnAt,
  parseAddress,
  spec,
} from "../model/breadboard.js";
import { holeAtWorld, partPinAddresses } from "../model/occupancy.js";
import { partSeatAt, seatGrabDy } from "../model/seating.js";
import { seatsWide, withSeat } from "../model/footprints.js";
import { turnedVeroKey } from "../model/vero-presets.js";
import {
  WIRE_END_GRAB_RADIUS,
  addressWorld,
  boardsInRect,
  componentPoints,
  componentsInRect,
  connectionPointAt,
  deskBounds,
  hoverHitAt,
  nearestLegalPoint,
  partPinsWorld,
  wireEndNear,
  wirePointNear,
  wiresInRect,
} from "../model/part-geometry.js";
import {
  LEAD_LEG,
  LEAD_WIRE_END,
  clusterDelta,
  mergeLeadRiders,
} from "../model/cluster-move.js";
import {
  DeskDoc,
  WIRE_COLORS,
  WIRE_LAYOUTS,
  busWidthForKey,
} from "../model/desk-doc.js";
import {
  isLeadToggleEvent,
  isToggleSelectEvent,
} from "../model/selection-toggle.js";
import { DATA_GLYPH, parseTagId } from "../model/integration.js";
import { SKIP_BUS_MEMBER, routeDeskAsync, routePlan } from "../model/autoroute.js"; // prettier-ignore
import { wireRunMm } from "../model/wire-length.js";
import { HistoryStore } from "../model/history-store.js";
import {
  LEG_ENDS,
  endOfPin,
  hasFreeLegs,
  legSeat,
  legsBent,
  pinOfEnd,
  straightSeatOf,
} from "../model/free-legs.js";
import { partDef } from "../catalog/index.js";
import {
  MAX_DESCRIPTION,
  MAX_NAME,
  isCustomRef,
  isValidPartName,
} from "../model/custom-chip.js";
import { kitLabel, partTitle } from "../catalog/labels.js";
import { supplyText } from "../catalog/families.js";
import {
  isCpu,
  isMemory,
  isRomChip,
  isTimed,
  memoryConfig,
} from "../sim/chip-eval.js";
import { buildNetlist } from "../sim/netlist.js";
import { timingOf } from "../sim/rc-trace.js";
import { normalizeSpiceConfig } from "../sim/spice/config.js";
import {
  timingDescription,
  timingProblemSentences,
} from "../model/timing-summary.js";
import { BreadboardView } from "./breadboard-view.js";
import { RouteDebugLayer } from "./route-debug-layer.js";
import { ChipView, buildChipSvg } from "./chip-view.js";
import { programmedPatch } from "../model/rom-binding.js";
import { DiscreteView, buildDiscreteSvg } from "./discrete-view.js";
import { partBodyBox } from "./part-body-box.js";
import { PsuView } from "./psu-view.js";
import { ClockView } from "./clock-view.js";
import { LoadView } from "./load-view.js";
import { AcView } from "./ac-view.js";
import { TransformerView } from "./transformer-view.js";
import { AdapterView } from "./adapter-view.js";
import { MeterView } from "./meter-view.js";
import { MeterProbeLayer, tipFromGrip } from "./meter-probe-layer.js";
import { MeterBench } from "./meter-bench.js";
import {
  MAX_METERS,
  METER_COMPACT,
  METER_LOOKS,
  METER_SELECT,
  PROBES,
  RED_JACKS,
  isCompact,
  selectionAt,
} from "../catalog/meter.js";
import {
  jackOf,
  jackWorld,
  meterRect,
  meterSpot,
} from "../model/meter-probes.js";
import { boardRect } from "../model/mating.js";
import { ScopeGroundMarker } from "./scope-ground-marker.js";
import { LcdView } from "./lcd-view.js";
import { WireLayer } from "./wire-layer.js";
import { PartPropertiesDialog, fieldLabel } from "./part-properties-dialog.js";
import { SliderWindows } from "./slider-windows.js";
import { AnnotationLayer } from "./annotation-layer.js";
import { SignalLayer } from "./signal-layer.js";
import { IntegrationLayer } from "./integration-layer.js";
import { IntegrationTools } from "./integration-tools.js";
import {
  MAX_SIGNALS,
  SIGNAL_COLORS,
  nextFlagRotation,
  signalSeq,
} from "../model/signals.js";
import { SimOverlay } from "./sim-overlay.js";
import { ProbeInspector } from "./probe-inspector.js";
import { WireTools } from "./wire-tools.js";
import { BusTools } from "./bus-tools.js";
import { CutTools } from "./cut-tools.js";
import { beginPointerGesture, releaseWorld } from "./pointer-gesture.js";
import { aimRing } from "./hole-rings.js";
import { DeskSelection } from "./desk-selection.js";
import { voltsText } from "./part-symbols.js";
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

/** How long a meter's button is held for its second job (RANGE back to
    auto-ranging, SELECT the backlight, REC out, HOLD Relative Zero), ms —
    the manual's "1 second or more". */
const BUTTON_HOLD_MS = 1000;

/** Put `elements` (nulls skipped) in this order after the first of them,
    moving only those out of place — and nothing else in the parent (a
    placement ghost keeps its place). Ordered within each PARENT apart: a
    meter's view lives in `.layer-meters`, every other part's in
    `.layer-parts`, and one running order across both moved the meter in
    under the wires at every rebuild (2026-10-27). */
function inDocumentOrder(elements) {
  const prevOf = new Map();
  for (const el of elements) {
    const parent = el?.parentNode;
    if (!parent) continue;
    const prev = prevOf.get(parent);
    if (prev && prev.nextSibling !== el) {
      parent.insertBefore(el, prev.nextSibling);
    }
    prevOf.set(parent, el);
  }
}

/** Whether a key press is an EDIT of the desk (refused while running, and
    told so): Delete/Backspace, the bare tool and part keys (W B R F), and
    paste, cut and duplicate. Every other key is nobody's business here. */
function isEditKey(e) {
  if (e.key === "Delete" || e.key === "Backspace") return true;
  const k = e.key?.toLowerCase();
  const accel = (e.metaKey || e.ctrlKey) && !e.altKey;
  if (accel) return k === "v" || k === "x" || k === "d";
  return !e.altKey && "wbkrf".includes(k ?? "-") && k?.length === 1;
}

/** The drags the part/brick pointer handlers own — ONE list for the move and
    the release, which used to carry a copy each. */
const PART_DRAG_KINDS = new Set([
  "drag-part",
  "drag-brick",
  "drag-resistor",
  "drag-resistor-end",
  "drag-leg",
]);

/** The document changes a RUN makes as part of running — a switch flipped on
    the bench. Every OTHER change recorded while the desk is locked is an edit
    the running desk still allowed (an analyzer channel, a net name, a
    schematic nudge, an annotation's text, a part's Properties), which at Stop
    becomes an undo step of its own rather than being folded into the
    baseline. (Damage latches never reach the history at all.) */
const RUN_VOLATILE_LABELS = new Set(["toggle switch", "set data pin"]);

/** The edits that cannot press anything into a board hole or take anything
    out of one — no board, seat, wire end, flag or tag moves — so the commit
    skips `pressProbesOff` and its whole-desk occupancy (+3 ms an edit on a
    busy desk, a slider dragged or a bus pin clicked while running). A params
    edit says so case by case instead (`seatsKept`, DeskDoc.seatKey).
    Kept by hand, and held to its edits by seat-neutral-labels.test.js: each
    label is written at ONE call site in the source (reuse one for another
    edit and the test fails until that edit is weighed), and a real edit
    through the controller recording it must leave every part's seatKey, the
    desk's occupancy and the probes in their holes unchanged — a label added
    here needs its edit added there. */
const SEAT_NEUTRAL_LABELS = new Set([
  "set data pin",
  "move symbol",
  "auto-layout schematic",
  "name net",
  "clear net name",
  "add analyzer channel",
  "remove analyzer channel",
  "reorder analyzer channel",
  "update analyzer channel",
  "place analyzer ground",
  "remove analyzer ground",
  "add annotation",
  "edit annotation",
  "delete annotation",
  "move annotation",
  "recolor wire",
  "set wire properties",
  "set wire layout",
  "set board properties",
]);

/** A document's CONTENT as a comparable string — its `next*Id` counters left
    out, since they only ever count up (an analyzer channel added and removed
    again moves one, and is still no change). */
const contentKey = (doc) =>
  JSON.stringify(doc, (key, value) => (/^next[A-Z]\w*Id$/.test(key) ? undefined : value)); // prettier-ignore

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
/**
 * A signal's Type and Default choices. FUNCTIONS, not consts: `t()` must never
 * run at module scope — the catalog is not loaded yet, and a top-level call
 * would freeze the English into the module for the life of the process.
 */
function signalTypeOptions() {
  return [
    { value: "momentary", label: t("properties.option.momentary") },
    { value: "toggle", label: t("properties.option.toggle") },
  ];
}

function signalRestOptions() {
  return [
    { value: "low", label: t("properties.option.low") },
    { value: "high", label: t("properties.option.high") },
  ];
}

function clickTogglingPart(ref) {
  return typeof partDef(ref)?.clickToggle === "function";
}

export class DeskController {
  #viewport;
  #deskView;
  #doc;
  #layers;
  /** The auto-router's own view of the desk, drawn on demand (Feature 360). */
  #routeDebug = null;
  #views = new Map(); // boardId → BreadboardView
  #partViews = new Map(); // componentId → ChipView | DiscreteView | PsuView
  #probeLayer = null; // every multimeter's probes and leads (meter-probe-layer.js)
  #meterBench = null; // the meters on a stopped bench, and their beepers
  #defaultMeterLook = "volthippo"; // what a meter taken out wears (settings `meterLook`)
  #wireLayer;
  #annotationLayer; // AnnotationLayer: labels + notes (Feature 120)
  #signalLayer; // SignalLayer: planted signal flags (Feature 370)
  #integrationLayer; // IntegrationLayer: planted Output/Input tags
  #integration; // IntegrationTools: the elements' drags, menus, Properties
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
  //   { kind: "place-signal", ghost, pos }                       (Feature 370)
  //   { kind: "place-integration", integrationKind, ghost, pos } (Output/Input/data)
  //   { kind: "drag-integration-tag", elementId, key, … }     (a tag)
  //   { kind: "drag-annotation", id, … }                      (label / note)
  //   { kind: "wire", from, hover }                           (wire tool)
  #mode = null;
  #wire; // WireTools: the wire tool + endpoint/whole-wire drags (shares #mode)
  #bus; // BusTools: the bus tool + whole-bus drag (Feature 130, shares #mode)
  #cut; // CutTools: a veroboard's Cut Track tool (shares #mode)
  #busName = "D[7:0]"; // the name the bus tool reads (the toolbar badge/digits)
  #defaultWireLayout = "direct"; // what a NEW wire gets (Settings ▸ Appearance)
  #spiceLite = false; // Settings ▸ Spice Lite is on: its own Properties show
  #lastDown = null; // last viewport pointerdown client pos (click-vs-pan)
  #pressWentThrough = false; // this running press flipped a switch under a wire
  #pinHeld = false; // Option/Alt is down: pin-targeting mode (setPinMode)
  #lastPointerWorld = null; // where the pointer last hovered, for a key change
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
  #onEditRefused; // an edit was tried while the run holds the desk
  /** An edit the run allowed was made since Run (see RUN_VOLATILE_LABELS). */
  #editedWhileRunning = false;
  /** The document as it stood at Run, while running. */
  #runBaseline = null;
  /** The parts whose switches the run flipped (RUN_VOLATILE_LABELS). */
  #runToggled = new Set();
  /** The Properties sliders floated in windows of their own
      (slider-windows.js). */
  #floats;
  /** The part a floated slider is pointed at or focused on — lit on the
      desk, and lit again when the slider remounts it. */
  #floatTarget = null;
  #marquee = null; // the rubber-band element while shift-dragging
  #simOverlay; // live LEDs / badges / clock lamps + net-level lookups
  // Undo/redo (Feature 200): a bounded snapshot history the doc-changed choke
  // point feeds. `#restoring` suppresses re-recording while a restore replays.
  #history = new HistoryStore();
  #restoring = false;
  #onHistoryChange;
  #onPartPlaced; // a part was placed from the tray (app.js: the capacitor note)
  #onAddNetToAnalyzer; // shared with the probe: one analyzer entry point
  #onClockToggle;
  #onClockPause;
  #onOpenPinout;
  #onOpenMemory;
  #onProgramMemory;
  #onCreateMemoryFile;
  #onRemoveMemoryFile;
  #onBusNameChange;
  #onWireFadeChange;
  #onSignalSelect;
  #onIntegrationSelect;
  #getConnections;
  #onOpenSettings;
  #onOpenConnectionWindow;
  #onOpenChipDesigner;
  #onOpenCpuMonitor;
  #putCustomChip;
  #onPartSelect;
  #chipDebug;
  #lastChipDebug = null; // re-applied to a part view mounted afterwards
  // ROM chips whose inspector holds edits not yet saved — "edited, not saved"
  // on the chip (#mountPart re-applies it to a view mounted afterwards).
  #unsavedMemory = new Set();

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
   * @param {(id: string) => void} [opts.onClockPause] - a free-running
   *   clock's own pause button, pressed while running: pause or resume that
   *   one clock and nothing else.
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
   * @param {(id: string|null) => void} [opts.onSignalSelect] - the selected
   *   signal flag changed (or cleared); the rail highlights that signal's
   *   button, which app.js owns.
   * @param {(id: string|null) => void} [opts.onIntegrationSelect] - the
   *   selected Output/Input TAG changed; the rail lights that element's card.
   * @param {() => Array} [opts.getConnections] - the configured serial
   *   connections (settings), for an element's Properties and its default.
   * @param {(tab: string) => void} [opts.onOpenSettings] - open Settings on a
   *   tab (an element's "Manage connections…").
   * @param {(connectionId: string) => void} [opts.onOpenConnectionWindow] -
   *   an element's "Open Connection Window".
   * @param {(compId: string) => void} [opts.onOpenChipDesigner] - a custom
   *   chip's "Open in Chip Designer".
   * @param {(compId: string) => void} [opts.onOpenCpuMonitor] - a CPU's
   *   "Open CPU Monitor".
   * @param {(chip: object) => {ok: boolean, code?: string}} [opts.putCustomChip]
   *   - change a custom chip's design (ProjectWorkspace.putCustomChip): its
   *   Properties card's Name and Description ARE the chip's part number and
   *   description, so an edit there is an edit of the design.
   * @param {(sel: {kind: string, id: string}|null) => void} [opts.onPartSelect]
   *   - the single pick changed (the designer focuses a custom chip's tab).
   * @param {object} [opts.chipDebug] - the chip debugger
   *   (components/chip-debugger.js): its arming, for a custom chip's menu.
   */
  constructor({
    viewport,
    deskView,
    deskDoc,
    onWireStateChange,
    onBusStateChange,
    onCutStateChange,
    onBusNameChange,
    onProbeStateChange,
    onWireFadeChange,
    onAddNetToAnalyzer,
    onEditRefused,
    onClockToggle,
    onClockPause,
    onOpenPinout,
    onOpenMemory,
    onProgramMemory,
    onCreateMemoryFile,
    onRemoveMemoryFile,
    onHistoryChange,
    onSignalSelect,
    onIntegrationSelect,
    getConnections,
    onOpenSettings,
    onOpenConnectionWindow,
    onOpenChipDesigner,
    onOpenCpuMonitor,
    sliderBridge,
    onSliderRunToggle,
    putCustomChip,
    onPartSelect,
    chipDebug,
    onPartPlaced,
    netlist,
    wiringNetlist,
  }) {
    this.#viewport = viewport;
    this.#onPartPlaced = onPartPlaced;
    this.#deskView = deskView;
    this.#doc = deskDoc;
    this.#onAddNetToAnalyzer = onAddNetToAnalyzer;
    this.#onEditRefused = onEditRefused;
    this.#onClockToggle = onClockToggle;
    this.#onClockPause = onClockPause;
    this.#onOpenPinout = onOpenPinout;
    this.#onOpenMemory = onOpenMemory;
    this.#onProgramMemory = onProgramMemory;
    this.#onCreateMemoryFile = onCreateMemoryFile;
    this.#onRemoveMemoryFile = onRemoveMemoryFile;
    this.#onHistoryChange = onHistoryChange;
    this.#onBusNameChange = onBusNameChange;
    this.#onWireFadeChange = onWireFadeChange;
    this.#onSignalSelect = onSignalSelect;
    this.#onIntegrationSelect = onIntegrationSelect;
    this.#getConnections = getConnections ?? (() => []);
    this.#onOpenSettings = onOpenSettings;
    this.#onOpenConnectionWindow = onOpenConnectionWindow;
    this.#onOpenChipDesigner = onOpenChipDesigner;
    this.#onOpenCpuMonitor = onOpenCpuMonitor;
    this.#putCustomChip = putCustomChip;
    this.#onPartSelect = onPartSelect;
    this.#chipDebug = chipDebug ?? null;
    // The chip debugger's verdicts on the board: an armed chip's badge, a
    // paused chip's pulsing outline.
    window.addEventListener("chiphippo:chip-debug", (e) =>
      this.#applyChipDebug(e.detail),
    );

    // Layer order (established for every later stage): boards under parts
    // under wires under the interaction overlay. All are zero-size anchors —
    // children position absolutely in world px. The multimeter floats over
    // all of the circuit (`meters`) — an instrument sitting on the desk, in
    // the way of whatever is under it — with only its probes and their
    // leads (in `signals`) above it.
    const surface = deskView.surface;
    this.#layers = {
      boards: el("div", { class: "layer-boards" }),
      parts: el("div", { class: "layer-parts" }),
      wires: el("div", { class: "layer-wires" }),
      annotations: el("div", { class: "layer-annotations" }),
      meters: el("div", { class: "layer-meters" }),
      signals: el("div", { class: "layer-signals" }),
      overlay: el("div", { class: "layer-overlay" }),
    };
    surface.append(
      this.#layers.boards,
      this.#layers.parts,
      this.#layers.wires,
      this.#layers.annotations,
      this.#layers.meters,
      this.#layers.signals,
      this.#layers.overlay,
    );

    // Hover ring + address tooltip live in the overlay (inert to pointers).
    this.#ring = el("div", { class: "hole-ring", hidden: true });
    this.#tooltip = el("div", { class: "desk-tooltip", hidden: true });
    this.#layers.overlay.append(this.#ring, this.#tooltip);

    // What is SELECTED (components/desk-selection.js), and the two overlays
    // that are pure functions of it: the board highlighter and the picked
    // lead's ring. Same host arrangement as WireTools / BusTools below —
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
        get signalLayer() {
          return sel.#signalLayer;
        },
        get integrationLayer() {
          return sel.#integrationLayer;
        },
        addressWorld: (address) => this.#addressWorld(address),
        leadWorld: (pick) => this.#leadWorld(pick),
        onSelect: (picked) => this.#onPartSelect?.(picked),
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
        refuseEdit: () => sel.#refuseEdit(),
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
        disarmCutTool: () => this.disarmCutTool(),
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
        trackSignalGhost: (e) => this.#trackSignalGhost(e),
        trackIntegrationGhost: (e) => this.#trackSignalGhost(e),
      },
      this.#layers.overlay,
    );

    // All wires render into one SVG in the wires layer.
    this.#wireLayer = new WireLayer(this.#layers.wires, deskDoc, {
      // While EDITING a wire and a bus are selected on the PRESS, by the one
      // press rule every object answers to (#press — a click is a drag that
      // didn't travel); a click arriving afterwards has nothing to add, and
      // acting on it would collapse a group the press just dragged. While
      // RUNNING nothing can be pressed into a drag, but a wire still
      // highlights on a click — tracing a run is the one thing left to do with
      // it — unless that press went through it to flip a switch beneath.
      onSelect: (id) => {
        if (this.#editingLocked && !this.#pressWentThrough) this.selectWire(id);
      },
      onContextMenu: (id, e) => this.#wire.onContextMenu(id, e),
      onHover: (id) => this.#probe.onWireHover(id),
      onSelectBus: (id) => {
        if (this.#editingLocked && !this.#pressWentThrough) this.selectBus(id);
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

    // External signals (Feature 370): the planted flags, above the wires and
    // below the interaction overlay. The BUTTONS live on the viewport rail
    // (components/signal-rail.js), which app.js owns — this is the desk half.
    this.#signalLayer = new SignalLayer(this.#layers.signals, deskDoc, {
      onPointerDown: (id, e) => this.#onSignalPointerDown(id, e),
      onContextMenu: (id, e) => this.#onSignalContextMenu(id, e),
      // Every path that highlights a flag goes through the layer's
      // setSelected, so its report is the one place the rail can learn of it.
      onSelect: (id) => this.#onSignalSelect?.(id),
    });

    // The Arduino serial integration's tags: the same layer div as the flags
    // (a second SVG, after theirs), since a tag is the same kind of thing — a
    // bench lead plugged into one hole. The CARDS live on the rail beside the
    // signal buttons (components/integration-rail.js), which app.js owns.
    this.#integrationLayer = new IntegrationLayer(
      this.#layers.signals,
      deskDoc,
      {
        onPointerDown: (id, key, e) =>
          this.#integration.onTagPointerDown(id, key, e),
        onContextMenu: (id, key, e) =>
          this.#integration.onTagContextMenu(id, key, e),
        onSelect: (id) => this.#onIntegrationSelect?.(id),
      },
    );
    // The multimeters' probes and leads: the same layer div again (a third
    // SVG), since a probe is a bench lead touching one hole. A probe takes
    // no hole, so the occupancy, the netlist's wiring and the build never
    // see it (catalog/meter.js).
    this.#probeLayer = new MeterProbeLayer(this.#layers.signals, deskDoc, {
      onPointerDown: (id, which, e) => this.#onProbePointerDown(id, which, e),
      onContextMenu: (id, which, e) => this.#onPartContextMenu(id, e),
    });
    this.#meterBench = new MeterBench(deskDoc, this.#partViews, {
      onLamps: (lamps) => this.#simOverlay?.setBenchLamps(lamps),
    });
    const ctl = this;
    this.#integration = new IntegrationTools({
      get mode() {
        return ctl.#mode;
      },
      set mode(v) {
        ctl.#mode = v;
      },
      get editingLocked() {
        return ctl.#editingLocked;
      },
      get probeArmed() {
        return ctl.#probe.armed;
      },
      get selectedTag() {
        const s = ctl.#sel.single;
        return s?.kind === "tag" ? parseTagId(s.id) : null;
      },
      doc: deskDoc,
      deskView,
      viewport,
      layer: this.#integrationLayer,
      ring: this.#ring,
      holeAtWorld: (w) => this.#holeAtWorld(w),
      selectTag: (id) => this.#sel.selectTag(id),
      recordSelection: () => this.#recordSelection(),
      forgetTag: () => this.#sel.select(null),
      emitDocChanged: (label, opts) => this.#emitDocChanged(label, opts),
      hideHover: () => this.#hideHover(),
      connections: () => this.#getConnections(),
      openSettings: (tab) => this.#onOpenSettings?.(tab),
      openConnectionWindow: (id) => this.#onOpenConnectionWindow?.(id),
      addNetToAnalyzer: (address, opts) =>
        this.#onAddNetToAnalyzer?.(address, opts),
    });

    // Live simulation state (Feature 90): LEDs, chip badges, clock lamps —
    // and the net-level lookups the probe tints with. Renders from published
    // state, never the engine.
    this.#simOverlay = new SimOverlay(this.#doc, this.#partViews);

    // A Properties slider floated in a window of its own: it reads the part
    // through the same fields its Properties card shows and writes through
    // the same #setComponentProperty, so turning it is exactly turning that
    // one.
    this.#floats = new SliderWindows({
      bridge: sliderBridge,
      read: (id, key) => this.#floatSubject(id, key),
      apply: (id, key, value) => this.#setComponentProperty(id, key, value),
      onHover: (id, on) => {
        if (on) this.#setFloatTarget(id);
        else if (this.#floatTarget === id) this.#setFloatTarget(null);
      },
      anchorOf: (id) => this.#floatAnchor(id),
      onRunToggle: onSliderRunToggle,
    });

    // The analyzer's ground lead, drawn on its hole (the probe's menu puts
    // it there; the analyzer's header takes it off).
    new ScopeGroundMarker(this.#layers.overlay, () => {
      const lead = this.#doc.scopeGround;
      return lead ? this.#addressWorld(lead) : null;
    });

    // Connectivity inspector (Feature 70): owns its netlist cache + net
    // highlight; borrows the shared hover ring and the controller's geometry.
    this.#probe = new ProbeInspector({
      doc: deskDoc,
      // It shows and names the WIRED net; the live one only lends its level.
      netlist: wiringNetlist,
      liveNetlist: netlist,
      overlay: this.#layers.overlay,
      viewport,
      ring: this.#ring,
      simOverlay: this.#simOverlay,
      hitTest: (world) => this.#hitTest(world),
      addressWorld: (address) => this.#addressWorld(address),
      wirePathOf: (wireId) => this.#wireLayer.restingPath(wireId),
      onStateChange: onProbeStateChange,
      onNameNet: (address, name, stale) => this.nameNet(address, name, stale),
      onClearNetNames: (addresses) => this.clearNetNames(addresses),
      onAddToScope: onAddNetToAnalyzer
        ? (address) => onAddNetToAnalyzer(address)
        : null,
      // The analyzer's ground lead, beside "Add to analyzer" — offered
      // where there is an analyzer.
      onSetScopeGround: onAddNetToAnalyzer
        ? (address) => this.setScopeGround(address)
        : null,
      coordinate: {
        cancelPlacement: () => this.cancelPlacement(),
        disarmWireTool: () => this.disarmWireTool(),
        disarmBusTool: () => this.disarmBusTool(),
        disarmCutTool: () => this.disarmCutTool(),
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
      refuseEdit: () => self.#refuseEdit(),
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
      disarmCutTool: () => this.disarmCutTool(),
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
      refuseEdit: () => self.#refuseEdit(),
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
      disarmCutTool: () => this.disarmCutTool(),
      clearSelectionIfBus: (id) => this.#sel.clearIfBus(id),
      onStateChange: onBusStateChange,
    });

    // Cut Track (veroboard): a click at a hole cuts the copper there or puts
    // a cut back. Shares `#mode` like the wire and bus tools.
    this.#cut = new CutTools({
      get mode() {
        return self.#mode;
      },
      set mode(v) {
        self.#mode = v;
      },
      get editingLocked() {
        return self.#editingLocked;
      },
      refuseEdit: () => self.#refuseEdit(),
      doc: deskDoc,
      deskView,
      viewport,
      ring: this.#ring,
      emitDocChanged: (label) => this.#emitDocChanged(label),
      hideHover: () => this.#hideHover(),
      deselect: () => this.deselect(),
      cancelPlacement: () => this.cancelPlacement(),
      disarmProbe: () => this.disarmProbe(),
      disarmWireTool: () => this.disarmWireTool(),
      disarmBusTool: () => this.disarmBusTool(),
      // Only the copper is redrawn — the board keeps its holes and its view.
      get hasVeroboard() {
        return self.hasVeroboard;
      },
      setBoardCuts: (id) =>
        this.#views.get(id)?.setCuts(this.#doc.getBoard(id)?.cuts),
      onStateChange: onCutStateChange,
    });

    // The probe's readout — a pinned net, or the one the cursor rests on —
    // follows edits, switch flips, and each sim tick (it self-guards when it
    // shows nothing).
    window.addEventListener("chiphippo:doc-changed", () => {
      this.#probe.refresh();
      // A meter's fuse is a run latch the run writes into the document
      // (SimController #checkFuses) — and mends at Stop — with no view told.
      for (const c of this.#doc.components) {
        if (c.kind === "meter") this.#partViews.get(c.id)?.syncFuses?.(c.params); // prettier-ignore
      }
    });
    window.addEventListener("chiphippo:part-state", () =>
      this.#probe.refresh(),
    );
    window.addEventListener("chiphippo:sim-state", (e) => {
      this.#simOverlay.apply(e.detail);
      this.#viewport.classList.toggle(
        "desk-viewport--flat-lamps",
        !this.#simOverlay.glowing,
      );
      this.#probe.refresh(); // re-tint the net it shows
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
    return Boolean(kind === "marquee" || kind?.startsWith("drag-"));
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
      case "drag-cluster":
        this.#onGroupPointerUp(fake);
        break;
      case "drag-part":
      case "drag-brick":
      case "drag-resistor":
      case "drag-resistor-end":
      case "drag-leg":
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
      case "drag-integration-tag":
        this.#integration.cancelDrag();
        break;
      case "drag-signal-flag":
        this.#onSignalPointerUp(fake);
        break;
      case "drag-meter-probe":
        this.#onProbePointerUp(fake);
        break;
    }
  }

  // ── Selection ───────────────────────────────────────────────────────────
  // All of it lives in DeskSelection (components/desk-selection.js), including
  // the board highlighter and the picked lead's ring. What stays here is
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

  /** The picked leads in the multi-selection, as `leadKey` strings
      (`wire-end:w3:to`, `lead:c2:a`) — empty when none. */
  get multiSelectedLeads() {
    return [...this.#sel.leads];
  }

  selectAll() {
    const any = this.#sel.selectAll();
    if (any) this.#recordSelection();
    return any;
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

  /** Option/Alt+⌘/Ctrl-click a lead — `{kind: "lead"|"wire-end", id, end}`:
      in or out of the selection. */
  toggleLeadSelection(pick) {
    this.#sel.toggleLeadSelection(pick);
  }

  /**
   * Option/Alt is down (or up): the desk's PIN-TARGETING mode (CLAUDE.md →
   * "Selection"). Bodies go inert and the one hole under the pointer holding an
   * independently movable lead — a wire end, a two-terminal part's leg — is
   * ringed red; a click there picks that lead alone, a drag moves it. A fixed
   * pin of a rigid package is never a target: it cannot move apart from its
   * chip. The selection is left alone while the key is merely held.
   *
   * The state is PUSHED IN from app.js rather than read off a keydown here:
   * `handleKeyDown`'s contract is "did I CONSUME this key" and a modifier must
   * not, and a keyup is not the only way it ends — app.js drops it on `blur`
   * too, since a modifier released outside the window never fires our keyup.
   */
  setPinMode(on) {
    const next = Boolean(on);
    if (next === this.#pinHeld) return;
    this.#pinHeld = next;
    this.#refreshPinMode();
  }

  /** Re-derive pin mode's look from what is true now — the viewport class
      and the red ring under the last pointer position. Inert while anything
      owns the pointer, while probing and while the circuit runs. */
  #refreshPinMode(world = this.#lastPointerWorld) {
    const on =
      this.#pinHeld &&
      !this.#mode &&
      !this.#probe?.armed &&
      !this.#editingLocked;
    this.#viewport.classList.toggle("desk-viewport--pin-mode", on);
    if (!on) {
      if (this.#ring.classList.contains("hole-ring--pin")) aimRing(this.#ring, null); // prettier-ignore
      return;
    }
    this.#hideHover();
    const target = world
      ? (this.#pinTargetAt(world) ?? this.#wire.bendTargetAt(world))
      : null;
    aimRing(this.#ring, target);
    if (target) this.#ring.classList.add("hole-ring--pin");
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
  #partSeatAt(world, ref, grabOffsetCols, params = null, opts = {}) {
    return partSeatAt(
      this.#doc.boards,
      ref,
      world,
      grabOffsetCols,
      params,
      opts,
    );
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
      this.#partViews.get(m.id)?.updateParams(this.#dragParams(m));
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
    // Placing a veroboard: R turns it a quarter lap by placing its TURNED
    // size — W × H becomes H × W, the strips running the other way across it
    // (they always run down the desk; board-types.js `veroSpec`).
    if (m?.kind === "place" && turnedVeroKey(m.kit)) {
      m.kit = turnedVeroKey(m.kit);
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
    // A `def.turns` part (the speaker) steps its quarter turns the same way,
    // about its pin 1.
    if (
      m?.kind === "place-part" &&
      (partDef(m.ref)?.can || partDef(m.ref)?.turns)
    ) {
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
    // it BEFORE dropping rather than after. A DIP-packaged discrete (the
    // 7-segment display, the bar array, a DIP switch bank) turns its half lap
    // the same way — its footprint maps onto itself, as a chip's does.
    if (
      m?.kind === "place-part" &&
      (partDef(m.ref)?.reversible || partDef(m.ref)?.package)
    ) {
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
      if (
        def?.rotatable ||
        def?.can ||
        def?.package ||
        def?.reversible ||
        def?.turns
      ) {
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

  /** A part's params at `seat`: a DIP's with the e/i marker the seat says
      (footprints.js `withSeat`), any other part's as they are — through the
      def's own contract after, as DeskDoc's #seatParams (an `alwaysWide`
      digit keeps its marker in every seat). */
  #seatedParams(ref, params, seat) {
    const def = partDef(ref);
    if (!def?.package || !seat?.anchor || seat.wide === undefined) return params; // prettier-ignore
    const seated = withSeat(def.package, params, seat.anchor.charAt(0), seat.wide); // prettier-ignore
    return def.normalizeParams ? def.normalizeParams(seated) : seated;
  }

  /** What a dragged part is DRAWN with: its params at the seat in hand, a
      chip's mid-drag flip (R) included. */
  #dragParams(d) {
    return this.#seatedParams(
      d.ref,
      this.#flippedParams(d.params, d.flip === true),
      d.seat,
    );
  }

  /**
   * The drag state for a placed resistor: it translates RIGIDLY (both ends
   * together, snapped to the 0.1-in lattice) and can be rotated freely mid-drag
   * with R. Returns null when its pins don't resolve (then a press just
   * selects). Works for both forms — the horizontal footprint and the two-end
   * span — since pin holes are always derived.
   *
   * IT CARRIES ITS WIRING (CLAUDE.md → "Selection": a move takes the wires
   * whose ends are on what moves). A body drag moves both leads by one delta,
   * which is the same rigid move a footprint part makes, so the ride rule
   * applies unchanged. The END drag (#resistorEndDragMode, an Option/Alt
   * press) deliberately carries nothing: that lead lands at any hole, at any
   * angle, on any strip, so there is no column delta for a rider to follow.
   * Nor does a SHIFT-drag (#ridersOf): the part moves bare.
   */
  #resistorDragMode(comp, ends, e, world) {
    const { attached, legs, flags } = this.#ridersOf([comp.id], e);
    const riding = attached.length > 0 ? attached : null;
    const ridingParts = legs.length > 0 ? legs : null;
    const ridingFlags = flags.length > 0 ? flags : null;
    return {
      kind: "drag-resistor",
      id: comp.id,
      ref: comp.ref,
      riding,
      ridingParts,
      ridingFlags,
      checkBatch:
        riding || ridingParts || ridingFlags
          ? this.#doc.prepareClusterMove({
              componentIds: [comp.id, ...legs.map((r) => r.id)],
              wireIds: attached.map((r) => r.wireId),
              flags,
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
      // The lead vector at the grab — a drop back where it started with the
      // same bend (R not pressed) is no move, and records nothing.
      orient0: { dx: ends.b.x - ends.a.x, dy: ends.b.y - ends.a.y },
      hasAnchored: this.#hasAnchored(comp.id),
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

  /** Where each of a part's INDEPENDENTLY movable leads sits, keyed by end —
      `{a, b}` for a two-terminal part, `{a, b, c}` for a TO-92 (free-legs.js)
      — or null when it has none (a chip, a TO-220) or won't resolve. */
  #leadEnds(comp) {
    if (comp?.board == null) return null;
    if (partDef(comp.ref)?.rotatable) return this.#resistorEndPoints(comp);
    if (!hasFreeLegs(comp)) return null;
    const pins = this.#partPins(comp);
    if (!pins) return null;
    const ends = {};
    for (const p of pins) {
      const end = endOfPin(p.pin);
      if (end) ends[end] = { x: p.x, y: p.y };
    }
    return ends;
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
      from: ends[grabbed], // where the moving lead was — a drop there is no move
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

  /**
   * Option/Alt press on a TO-92's leg (free-legs.js): that one leg is the
   * selection, and the press is its drag — it lands in any hole the part can
   * have it in, the other two staying exactly where they are, and the part
   * comes out bent, or straight again when the three are back in a row.
   */
  #beginLegDrag(comp, end, e, world) {
    const view = this.#partViews.get(comp.id);
    const pin = pinOfEnd(end);
    if (!view || pin == null) return;
    this.#sel.selectLead(comp.id, end);
    this.#recordSelection();
    this.#mode = {
      kind: "drag-leg",
      id: comp.id,
      ref: comp.ref,
      pin,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      lastWorld: world,
      seat: null, // { id, board, anchor, params } while the drop is legal
      legal: false,
      active: false,
      teardown: null,
    };
    this.#viewport.classList.add("desk-viewport--dragging");
    this.#mode.teardown = beginPointerGesture(view.element, e.pointerId, {
      onMove: this.#onPartPointerMove,
      onEnd: this.#onPartPointerUp,
    });
    this.#refreshPinMode();
  }

  /** The seat a leg drag would commit with its leg in `hole` (a
      nearestLegalPoint candidate), or null when the part can't stand so. */
  #legSeatAt(d, hole) {
    const comp = this.#doc.getComponent(d.id);
    const seat =
      comp && legSeat(this.#doc, comp, new Map([[d.pin, hole.address]]));
    if (!seat) return null;
    const fits = this.#doc.canPlacePart(d.ref, seat.board, seat.anchor, {
      ignoreId: d.id,
      params: seat.params,
      occupancy: (d.occupancy ??= this.#doc.occupancyIndex()), // one a gesture
    });
    return fits ? seat : null;
  }

  /** Live leg drag — the wire end's rule and its ring: the leg snaps to the
      nearest hole in reach it may have, and the part is drawn as it would
      stand; with nothing in reach the leg rides the cursor, red. */
  #trackLegDrag(d = this.#mode) {
    const { point, accepted } = nearestLegalPoint(
      this.#doc.boards,
      null,
      d.lastWorld,
      (p) => this.#legSeatAt(d, p),
    );
    d.seat = accepted;
    d.legal = Boolean(point);
    const under = point ? null : this.#holeAtWorld(d.lastWorld);
    aimRing(this.#ring, point ?? under, d.legal);
    const view = this.#partViews.get(d.id);
    const comp = this.#doc.getComponent(d.id);
    if (!view || !comp) return;
    if (d.seat) {
      this.#placePartView(view, { ...comp, ...d.seat }, this.#doc.getBoard(d.seat.board)); // prettier-ignore
    } else {
      // Bent to wherever the cursor is: the other legs where they are.
      const tip = under ?? d.lastWorld;
      const pins = (this.#partPins(comp) ?? []).map((p) =>
        p.pin === d.pin ? { pin: p.pin, x: tip.x, y: tip.y } : p,
      );
      if (pins.length === 3) {
        view.updateLegsWorld([...pins].sort((a, b) => a.pin - b.pin));
      }
    }
    view.setIllegal(!d.legal);
  }

  /** Live single-end drag: the moving lead snaps to the nearest hole in reach
      it may have (the wire end's rule, and its ring), the other stays. What
      it leaves in d.target/d.legal is what the release commits, unresolved. */
  #trackResistorEndDrag(d = this.#mode) {
    const { point, accepted } = nearestLegalPoint(
      this.#doc.boards,
      null,
      d.lastWorld,
      (p) => this.#leadEndSeat(d, p),
    );
    d.target = accepted;
    const legal = Boolean(point);
    d.legal = legal;
    // The moving end rides the snapped hole; with nothing in reach it may have,
    // the hole under the cursor (red — THAT hole is the one refused), else the
    // raw cursor.
    const under = point ? null : this.#holeAtWorld(d.lastWorld);
    const at = point ?? under;
    aimRing(this.#ring, at, legal);
    const tip = at ? { x: at.x, y: at.y } : d.lastWorld;
    const view = this.#partViews.get(d.id);
    view?.updateSpanWorld(
      d.moving === "a" ? tip : d.fixed,
      d.moving === "a" ? d.fixed : tip,
    );
    view?.setIllegal(!legal);
  }

  /**
   * The seat a single-end drag would commit with its moving lead in `hole` (a
   * nearestLegalPoint candidate), or null when the part can't be placed so.
   *
   * Pin 1 SEATS in a hole; pin 2 is a bend measured from it. So dragging pin 1
   * re-seats the part (onto another strip if that's where it landed) while
   * dragging pin 2 only re-bends the lead — either way the pair is rewritten as
   * one anchor plus one offset.
   */
  #leadEndSeat(d, hole) {
    const parsed = parseAddress(hole.address);
    if (!parsed) return null;
    const movingA = d.moving === "a";
    const boardId = movingA ? parsed.boardId : d.boardId;
    const anchor = movingA ? parsed.hole : d.anchor;
    const from = movingA ? hole : d.fixed;
    const to = movingA ? d.fixed : hole;
    // Both points are resolved HOLES, so the bend is exactly the vector between
    // them — no rounding, or the lead would be drawn short of the hole it
    // landed in (a rail's rows are not on the pin-board's lattice).
    const end = { dx: to.x - from.x, dy: to.y - from.y };
    // canPlacePart enforces free + distinct + the minimum lead span.
    const fits = this.#doc.canPlacePart(d.ref, boardId, anchor, {
      ignoreId: d.id,
      params: { rot: 90, end },
      occupancy: (d.occupancy ??= this.#doc.occupancyIndex()), // one a gesture
    });
    return fits ? { boardId, anchor, end, at: { x: hole.x, y: hole.y } } : null;
  }

  /** Live resistor drag: rigid lattice-snapped translation, both ends checked.
      Pin 1 seats in the nearest hole in reach where the part fits; the lead
      keeps its bend, so the far end may reach a NEIGHBOURING strip's rail. */
  #trackResistorDrag(d = this.#mode) {
    // ONE delta moves both ends, so length and angle never change.
    //
    // Pin 1 lands on the NEAREST hole in snap reach of where it actually is
    // (the raw travel, not a rounded one) at which the whole part fits — both
    // leads, and every rider it carries — the wire end's rule, so a
    // near-miss is forgiven by one hole rather than thrown back. The raw point
    // is what makes a spanned run work: rounding the travel assumes a lattice,
    // and there is only one HORIZONTALLY — the next pin-board of a spanned run
    // sits 17.52 pitch down, so a rounded dy put pin 1 0.48 off the hole it
    // aimed at and the part could not be dropped on the other board at all.
    const tx = d.lastWorld.x - d.startWorld.x;
    const ty = d.lastWorld.y - d.startWorld.y;
    const raw = { x: d.p1.x + tx, y: d.p1.y + ty };
    const snapped = { x: d.p1.x + Math.round(tx), y: d.p1.y + Math.round(ty) };
    // The bend is carried through a rigid translation untouched — rounding it
    // here would quietly re-bend a lead every time the part was dragged.
    const end = { dx: d.orient.dx, dy: d.orient.dy };
    // EVERY param the part has, in the two-free-ends form: the plan, the batch
    // check and the commit all read this one object, and a bare `{rot, end}`
    // reset a resistor's ohms and an LED's colour and polarity on the drop.
    const params = { ...d.origin.params, rot: 90, end };
    const { point, accepted } = nearestLegalPoint(
      this.#doc.boards,
      null,
      raw,
      (p) => this.#bodySeat(d, p, params),
    );
    d.holes = accepted?.holes ?? null;
    // The rider plan is re-derived on EVERY sample, including the ones with
    // nowhere to land — that is what the null is for. This part is drawn at the
    // raw cursor whatever the position (unlike a footprint drag, which stops at
    // its last good seat), so leaving a stale plan in place left the riders
    // frozen at a hole the part had long since left: drag an LED over the gap
    // between two boards and its wiring simply stopped following it. With no
    // plan they draw from the DOCUMENT instead — where they actually are — in
    // red, which is the truth: nothing is moving.
    d.plan = accepted?.plan ?? null;
    const legal = Boolean(point);
    // Drawn from the HOLE it seats in, so the preview is the seat that will be
    // committed; refused, from the hole under pin 1 (the rounded point is the
    // fallback for the sliver between two rows, nearest to nothing); over bare
    // desk there is none, and it follows the cursor.
    const at =
      point ?? this.#holeAtWorld(raw) ?? this.#holeAtWorld(snapped) ?? snapped;
    const p1 = { x: at.x, y: at.y };
    const p2 = { x: p1.x + d.orient.dx, y: p1.y + d.orient.dy };
    d.legal = legal;
    const view = this.#partViews.get(d.id);
    view?.updateSpanWorld(p1, p2);
    view?.setIllegal(!legal);
    if (d.riding) this.#wireLayer.setPartDrag(this.#ridingWirePreview(d));
    if (d.ridingParts) this.#applyLeadRiders(d);
    if (d.ridingFlags) this.#applyFlagRiders(d);
    // Labels anchored to it ride live, by its middle's travel — the point
    // #carryAnchoredLabels shifts them by on the drop (an R mid-drag swings
    // the body round pin 1, so pin 1's own travel would not say where it went).
    if (d.hasAnchored) {
      this.#annotationLayer.render({
        anchorIds: new Set([d.id]),
        dx: p1.x + d.orient.dx / 2 - (d.p1.x + d.orient0.dx / 2),
        dy: p1.y + d.orient.dy / 2 - (d.p1.y + d.orient0.dy / 2),
      });
    }
  }

  /**
   * The seat a body drag would commit with pin 1 in `hole` (a
   * nearestLegalPoint candidate) — `{ holes, plan }` — or null when the part,
   * or anything riding it, can't land there. canPlacePart resolves the bent
   * lead against the whole desk, so it is the one authority on whether the far
   * end found a free hole.
   *
   * A part carrying wiring plans its riders for THIS seat and checks the whole batch as
   * one, exactly as a footprint part's does — one refusal, one visual language.
   * The plan is told the FORM the part is landing in: a body drag rewrites a
   * footprint-form part into the two-free-ends one, and the ride rule has to
   * read the pins it will actually have.
   */
  #bodySeat(d, hole, params) {
    const parsed = parseAddress(hole.address);
    if (!parsed) return null;
    const { boardId, hole: anchor } = parsed;
    const fits = this.#doc.canPlacePart(d.ref, boardId, anchor, {
      ignoreId: d.id,
      params,
      occupancy: (d.occupancy ??= this.#doc.occupancyIndex()), // one a gesture
    });
    if (!fits) return null;
    const holes = { boardId, anchor, end: params.end };
    if (!(d.riding || d.ridingParts || d.ridingFlags)) {
      return { holes, plan: null };
    }
    const plan = this.#doc.planPartMove(d.id, {
      board: boardId,
      anchor,
      params,
      riding: d.riding,
      ridingParts: d.ridingParts,
      ridingFlags: d.ridingFlags,
    });
    const placements = plan && [
      { id: d.id, board: boardId, anchor, params },
      ...plan.parts,
    ];
    return plan?.resolved &&
      d.checkBatch(placements, plan.moves, null, plan.flags)
      ? { holes, plan }
      : null;
  }

  /** Rebuild a part's view from the document — the horizontal SVG and the
      two-end span differ, so a shape change needs a fresh mount. Also the
      canonical "snap back to where it was" after an illegal drop. */
  #remountPart(id) {
    const comp = this.#doc.getComponent(id);
    if (!comp) return;
    // Lit as the single pick OR as a member of a multi-selection.
    const selected =
      (this.#sel.single?.kind === "part" && this.#sel.single.id === id) ||
      this.#sel.parts.has(id);
    // The fresh view takes the OLD one's place in its layer: re-appended, the
    // stacking order would follow the edit history (a rotate lifted the part
    // over its neighbours) while an undo restores document order.
    const old = this.#partViews.get(id)?.element;
    const parent = old?.parentNode ?? null;
    const next = old?.nextSibling ?? null;
    this.#partViews.get(id)?.remove();
    this.#partViews.delete(id);
    this.#mountPart(comp);
    const view = this.#partViews.get(id);
    const el = view?.element;
    if (parent && el?.parentNode === parent && next?.parentNode === parent) {
      parent.insertBefore(el, next);
    }
    if (selected) view?.setSelected(true);
  }

  /**
   * A custom chip's design changed (the chip designer): redraw every part
   * that is one — its marking, its pinout and its behaviour all come from its
   * def, which the catalog now holds anew. `ids` narrows it to those chips;
   * null redraws every custom chip on the desk. Not an edit of the desk (the
   * design is the project's), so nothing is recorded.
   */
  refreshCustomChips(ids = null) {
    const wanted = ids ? new Set(ids) : null;
    let any = false;
    for (const comp of this.#doc.components) {
      if (!isCustomRef(comp.ref)) continue;
      if (wanted && !wanted.has(comp.ref)) continue;
      this.#remountPart(comp.id);
      any = true;
    }
    if (any) window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
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
    const before = { ...this.#doc.getComponent(id) };
    try {
      this.#doc.rotateComponent(id);
    } catch {
      return; // nowhere free to rotate into — leave it as-is
    }
    // A can spins about its middle, a bent TO-92 swaps pins 1 and 3: either
    // can move the anchor its labels hang from.
    this.#carryAnchoredLabels(id, before);
    this.#remountPart(id);
    this.#emitDocChanged("rotate part");
  }

  // ── Wire tool (Feature 50) ───────────────────────────────────────────────
  // The wire subsystem lives in WireTools; these are the public shims app.js /
  // keyboard drive it through. It shares `#mode` via the host in the ctor.

  get wireToolArmed() {
    return this.#wire.armed;
  }

  /** A wire or bus is half laid: its first end placed, its second not yet —
      what Space must not run the circuit over (Run would throw it away). */
  get layingInProgress() {
    return this.#wire.pending || this.#bus.pending;
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

  /** The look a meter taken out wears (settings `meterLook`: the last one
      picked in a meter's Properties ▸ Look) — the Volt Hippo for anything
      else. Applies to nothing already on the desk. */
  setDefaultMeterLook(look) {
    this.#defaultMeterLook = METER_LOOKS.includes(look) ? look : "volthippo";
  }

  /**
   * Whether Spice Lite is on (Settings ▸ Spice Lite). A part's `spiceOnly`
   * Properties — the figures only Spice Lite simulates with, an inductor's
   * Winding — are offered only while it is (#propertyFieldsFor); switching it
   * off HIDES them and keeps what they store. Read when a card opens.
   * @param {unknown} config - `settings.spiceLite`
   */
  setSpiceLite(config) {
    this.#spiceLite = normalizeSpiceConfig(config).enabled;
    this.#meterBench?.setSpiceLite(this.#spiceLite, normalizeSpiceConfig(config)); // prettier-ignore
    // A clock's glyph shows the wave it runs: its own only under Spice Lite.
    for (const view of this.#partViews.values()) {
      view.setSpiceLite?.(this.#spiceLite);
    }
  }

  /**
   * How many wires Auto-route would take up: every wire on the desk bar the
   * bus members, whose shape belongs to their ribbon (the router's own
   * `SKIP_BUS_MEMBER`). It is what the confirmation states BEFORE a run; the
   * toast after it reports what actually happened, since a wire with no legal
   * path is left as it was. With a selection it is the TOTAL the question
   * states the selected count against (`3/9 wires…`).
   */
  get routableWireCount() {
    const members = new Set(this.#doc.buses.flatMap((b) => b.members));
    return this.#doc.wires.filter((w) => !members.has(w.id)).length;
  }

  /**
   * The wires a selection asks Auto-route to take up, or null when nothing is
   * selected (route them all). Every other wire stays terrain the router steers
   * around. It is what the selection would MOVE: the wires selected in their
   * own right (a picked bus's members among them), the passengers of a
   * selected board — so banding a whole board routes its wiring — and a wire
   * whose end is picked. Bus members drop out, as from `routableWireCount`. A
   * selection holding none of these is an EMPTY set: there is a selection, and
   * it names nothing to route.
   * @returns {Set<string>|null}
   */
  get routeSelection() {
    const single = this.#sel.single;
    if (!single && this.#sel.size() === 0) return null;
    const sets = this.#sel.movingSets();
    const ids = new Set(sets.wires);
    if (sets.boards.size) {
      for (const wire of this.#doc.wires) {
        if (this.#sel.isPassengerWire(wire.id, sets.boards)) ids.add(wire.id);
      }
    }
    for (const pick of sets.leads) {
      if (pick.kind === "wire-end") ids.add(pick.id);
    }
    if (single?.kind === "wire-end") ids.add(single.id);
    for (const bus of this.#doc.buses) {
      for (const id of bus.members) ids.delete(id);
    }
    return ids;
  }

  /**
   * Auto-route every wire on the desk (Feature 360): each one becomes a routed
   * wire whose waypoints run inside the boards, around the parts and clear of
   * the other wires. ONE document mutation, so ONE ⌘Z puts the whole desk back.
   *
   * The netlist does not move. Waypoints are a drawing, and the addresses the
   * router does change it changes within one electrical node: a power lead slid
   * along its rail (`model/rail-reseat.js`, which proves it against the netlist
   * before proposing it) and a signal wire slid within its own five-hole
   * tie-point strip (`swapEnds`, where the five holes ARE the node and there is
   * nothing to prove). That is what makes a one-click rewrite of every wire on
   * the desk a safe thing to offer.
   *
   * Refused while the circuit runs, like every other topology edit. Bus members
   * are left to their ribbon, and a wire the router could not place keeps
   * exactly the layout — and exactly the holes — it had.
   *
   * **It routes in slices and can be cancelled.** A large desk is seconds of
   * solid computation, so the work yields to the host between slices and the
   * caller gets progress to show and a signal to stop it with. Nothing is
   * written until the very end, so a cancel has nothing to undo: the wiring was
   * never touched. For the same reason the document is checked for edits made
   * WHILE it ran — routes computed against a desk that has since moved describe
   * a desk that no longer exists, so they are dropped rather than applied.
   *
   * @param {{only?: Set<string>, debug?: boolean, signal?: AbortSignal,
   *   onProgress?: (p:object) => void}} [opts]
   * @returns {Promise<{routed:number, moved:number, unrouted:number,
   *   skipped:Array, diagnostics:object}|{cancelled:true}|{stale:true}|null>}
   *   null when the desk is frozen or there was nothing to route.
   */
  async autoRouteWires(opts = {}) {
    if (this.#editingLocked) return null;
    const json = this.#doc.toJSON();
    const before = JSON.stringify(json);
    const result = await routeDeskAsync(json, {
      bodyBox: partBodyBox,
      only: opts.only ?? null,
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
    if (!result) return { cancelled: true };
    // The desk is live while this runs — a board drag, an undo, a tab switch.
    // A plan describes the document it was computed from and nothing else, so
    // if that document has moved on, the plan goes in the bin. (`applyRoutes`
    // would refuse an impossible one anyway; this catches the possible-but
    // wrong ones, where the waypoints are drawn around parts that have since
    // been dragged away.)
    if (JSON.stringify(this.#doc.toJSON()) !== before) return { stale: true };
    // Nor if the circuit started running meanwhile: Space and ⌘R reach the
    // transport mid-route, and starting it changes nothing in the document —
    // so the check above passed, and the plan was written into a running
    // circuit with history frozen, for Stop's re-baseline to fold into the
    // edit before it.
    if (this.#editingLocked) return { stale: true };
    // The debug overlay is a TOGGLE, so a second Option-click puts the desk
    // back rather than redrawing the same thing over itself.
    this.#routeDebug ??= new RouteDebugLayer(this.#layers.overlay);
    if (opts.debug && !this.#routeDebug.visible) {
      this.#routeDebug.show(result.space);
    } else {
      this.#routeDebug.clear();
    }
    const plan = routePlan(result);
    if (plan.length === 0) return null;
    this.#doc.applyRoutes(plan); // throws with nothing applied if it is refused
    this.#wireLayer.render();
    this.#emitDocChanged("auto-route wires");
    return {
      routed: plan.length,
      // Both kinds of address change, counted together: a power lead slid along
      // its rail and a signal wire slid within its own tie-point strip are the
      // same promise to the reader — the connection is the connection, only the
      // hole moved — and a toast that splits them into two numbers explains the
      // implementation instead of the result.
      moved: result.reseats.length + result.swaps.length,
      // A bus member was never a candidate, so it is not a failure to report —
      // only a wire the router genuinely could not place is.
      unrouted: result.skipped.filter((s) => s.reason !== SKIP_BUS_MEMBER)
        .length,
      skipped: result.skipped,
      diagnostics: result.diagnostics,
    };
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

  /** Does the desk hold a veroboard — any copper for Cut Track to cut? */
  get hasVeroboard() {
    return this.#doc.boards.some((b) => {
      try {
        return spec(b.type).kind === "vero";
      } catch {
        return false; // a junk board type is no veroboard
      }
    });
  }

  /** Is the Cut Track tool armed? */
  get cutToolArmed() {
    return this.#cut?.armed ?? false;
  }

  armCutTool() {
    this.#cut.arm();
  }

  disarmCutTool() {
    this.#cut?.disarm();
  }

  toggleCutTool() {
    this.#cut.toggle();
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
   * brick, and label by one delta (DeskDoc.translateAll), which is
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

  /** The analyzer's ground lead (a member address), or null. */
  get scopeGround() {
    return this.#doc.scopeGround;
  }

  /** Put the analyzer's ground lead on a hole or terminal, or take it off
      (null) — one undo step. A floating AC adapter circuit is grounded
      where it goes, so it is a change the simulation sees. */
  setScopeGround(address) {
    let changed;
    try {
      changed = this.#doc.setScopeGround(address);
    } catch {
      return;
    }
    if (changed) this.#emitDocChanged(address ? "place analyzer ground" : "remove analyzer ground"); // prettier-ignore
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

  /**
   * Arm a place-signal ghost. The ghost is the signal's own flag glyph — it is
   * the thing you picked — but where it lands is NOT where the click was: a
   * signal has no desk coordinates, so the click merely says "yes, add it" and
   * the button goes to the next free slot on the rail. Rail order IS document
   * order, so that slot is an append.
   */
  armSignalPlacement() {
    if (this.#editingLocked) return;
    if (this.#doc.signals.length >= MAX_SIGNALS) return;
    const ghost = el("div", { class: "signal-place-ghost", hidden: true }, [
      el("span", { class: "signal-place-ghost-mark", text: "⚑" }),
      el("span", { text: t("palette.signal.item") }),
    ]);
    this.#place.enter({ kind: "place-signal", ghost, pos: null, legal: true });
  }

  /** Place-signal ghost: rides the cursor and says what a click would add. */
  #trackSignalGhost(e) {
    const m = this.#mode;
    const w = this.#deskView.worldFromEvent(e);
    m.pos = { x: w.x, y: w.y };
    m.ghost.hidden = false;
    m.ghost.style.left = `${w.x * PX_PER_UNIT}px`;
    m.ghost.style.top = `${w.y * PX_PER_UNIT}px`;
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

  /** Does `now` differ from the document at Run by more than the switches
      the run flipped and the data-bus levels it set? Each flipped part's
      params, and each data bus's levels, are read as they stood at Run
      before the two are compared. */
  #runEditStands(now) {
    const base = this.#runBaseline;
    if (!base) return true;
    const was = new Map(base.components.map((c) => [c.id, c.params]));
    const drove = new Map(
      base.integrations.filter((e) => e.drive).map((e) => [e.id, e.drive]),
    );
    const masked = {
      ...now,
      components: now.components.map((c) =>
        this.#runToggled.has(c.id) && was.has(c.id)
          ? { ...c, params: was.get(c.id) }
          : c,
      ),
      integrations: now.integrations.map((e) =>
        drove.has(e.id) ? { ...e, drive: drove.get(e.id) } : e,
      ),
    };
    return contentKey(masked) !== contentKey(base);
  }

  /** Freeze/unfreeze editing while the circuit runs (app.js drives this). */
  setEditingLocked(locked) {
    // Called on EVERY transport change (Pause, Resume, Step, a relabel), so
    // the run's bookkeeping starts only on the stopped → running edge.
    if (locked && !this.#editingLocked) {
      this.#editedWhileRunning = false;
      this.#runBaseline = this.#doc.snapshot();
      this.#runToggled = new Set();
    }
    this.#editingLocked = locked;
    this.#viewport.classList.toggle("desk-viewport--running", locked);
    if (locked) {
      // Cancel any armed tool the run supersedes (probe stays allowed).
      this.cancelPlacement();
      this.disarmWireTool();
      this.disarmBusTool();
      this.disarmCutTool();
      // History is frozen for the run — run-volatile effects (12 V damage, a
      // switch flipped live) never become undo steps.
      this.#history.freeze();
    } else {
      // Stop: resume recording and re-baseline the present to the live document
      // so any run-persisted change stays consistent with undo/redo. But an
      // EDIT the run allowed (an analyzer channel, a net name, a schematic
      // nudge, an annotation's text) is the user's, not the run's: folded into
      // the baseline, ⌘Z after Stop undid it together with the edit before
      // Run. Those make the run's changes ONE undo step of their own.
      this.#history.unfreeze();
      const now = this.#doc.snapshot();
      // An edit undone again before Stop (a channel added, then removed)
      // leaves nothing to step back over — and neither does one beside a
      // switch the run flipped: that is the run's, not an edit.
      if (this.#editedWhileRunning && this.#runEditStands(now)) {
        const dropped = this.#history.record(now, "edit while running", Date.now(), { selection: this.#sel.serialize() }); // prettier-ignore
        this.#reconcileMemoryFiles(dropped);
      } else {
        this.#history.sync(now);
      }
      this.#editedWhileRunning = false;
      this.#runBaseline = null;
      this.#runToggled = new Set();
    }
    // Nothing can be picked while running, so pin mode must not offer to.
    this.#refreshPinMode();
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
   * @param {{guid?: string|null}} [opts] - the file a write went to: flag
   *   only the chip that names it (not one placed since under its id)
   * @returns {boolean} whether there was such a ROM chip to flag
   */
  setMemoryProgrammed(id, programmed, binding = {}, { guid = null } = {}) {
    const comp = this.#doc.getComponent(id);
    if (!comp || !isRomChip(partDef(comp.ref))) return false;
    if (guid != null && comp.params?.storage?.guid !== guid) return false;
    const patch = programmedPatch(comp.params, programmed, binding);
    const updated = this.#doc.setComponentParams(id, patch);
    this.#partViews.get(id)?.updateParams(updated.params);
    this.#emitDocChanged("program memory");
    return true;
  }

  /**
   * A memory chip's inspector has edits it has not saved (or no longer has:
   * saved, reloaded, closed). Not a document change — the edits are only in
   * that window — but the chip says so, since the circuit reads its file.
   * @param {string} id
   * @param {boolean} unsaved
   */
  setMemoryUnsaved(id, unsaved) {
    if (unsaved) this.#unsavedMemory.add(id);
    else this.#unsavedMemory.delete(id);
    this.#partViews.get(id)?.setUnsaved?.(unsaved);
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
        ((this.#sel.single?.kind === "wire" ||
          this.#sel.single?.kind === "wire-end") &&
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
      const named = [
        "psu",
        "load",
        "ac",
        "transformer",
        "adapter",
        "meter",
      ].includes(comp.kind);
      const noun = t(`desk.brick.${named ? comp.kind : "clock"}`);
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
      ((this.#sel.single?.kind === "wire" ||
        this.#sel.single?.kind === "wire-end") &&
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
    const seat = this.#doc.seatKey(id);
    const updated = this.#doc.setComponentParams(id, patch);
    this.#partViews.get(id)?.updateParams(updated.params);
    if (this.#editingLocked) this.#runToggled.add(id);
    // pos/on/states lives in params, so the flip rides `doc-changed` alone —
    // which already invalidates the netlist, re-ticks the sim, and refreshes
    // the pinned net. Emitting `part-state` too would double-tick (part-state
    // is reserved for transient view state with no durable param — a held
    // button).
    this.#emitDocChanged("toggle switch", {
      seatsKept: this.#doc.seatKey(id) === seat,
    });
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
    // A field that can MOVE a pin (an inductor's holes between its leads) or
    // SWAP the part (a transistor's Type) is a topology edit, and greyed while
    // the circuit runs like every other.
    // A `spiceOnly` field (an inductor's Winding) chooses figures only Spice
    // Lite simulates with, so it is offered only while Spice Lite is on — and
    // so is a `spiceOnly` OPTION of a select (a clock's triangle), bar the one
    // the part holds, which the select must still be able to say.
    const fields = (def?.properties ?? [])
      .filter((field) => !field.spiceOnly || this.#spiceLite)
      .map((field) =>
        this.#spiceLite || !Array.isArray(field.options)
          ? field
          : {
              ...field,
              options: field.options.filter(
                (opt) =>
                  !opt.spiceOnly || opt.value === comp?.params?.[field.key],
              ),
            },
      )
      .map((field) =>
        (field.movesPins || field.swapsPart) && this.#editingLocked
          ? { ...field, disabledWhen: () => true }
          : field,
      )
      .map((field) => this.#packageField(comp, def, field));
    // A timed part says what it reads its wiring as — astable at what rate, a
    // pulse how long, or why it cannot tell — derived, so a readonly.
    if (isTimed(def))
      fields.push({ key: "timing", type: "readonly", wrap: true });
    if (comp?.kind === "chip" && isMemory(def)) {
      // A volatile SRAM is never loaded from a file, so it never has one.
      if (isRomChip(def)) fields.push({ key: "imageSource", type: "readonly" });
      // (Inspecting is a menu item — it opens a window, as the designer's and
      // the CPU monitor's do — #memoryMenuItems.)
      if (isRomChip(def) && !this.#editingLocked) {
        fields.push({ key: "programMemory", type: "action" });
      }
    }
    return fields;
  }

  /** A transistor's Package field, its every option but the TO-92 greyed —
      saying why — while its legs are bent out of a row: a TO-220's legs are
      a rigid row, so it cannot stand on them (free-legs.js). Any other field
      passes through. */
  #packageField(comp, def, field) {
    if (field.key !== "case" || !def?.transistor || !legsBent(comp)) {
      return field;
    }
    if (straightSeatOf(this.#doc, comp)) return field;
    const why = tf("properties.refused.case", field.refused ?? "");
    return {
      ...field,
      options: field.options.map((opt) =>
        opt.value === "TO-92" ? opt : { ...opt, disabled: true, title: why },
      ),
    };
  }

  /** What a timed part reads its own wiring as, for the Properties card's
      Timing row — taken fresh from the desk as it stands (the same reading
      the engine takes each tick), so it answers before anything has run. */
  #timingLabel(comp) {
    const doc = this.#doc.toJSON();
    return timingDescription(timingOf(doc, buildNetlist(doc), comp));
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
   *     stands at design time too, exactly as ChipView#refresh has it;
   *   • a MOSFET holding its last state on a gate nothing defines (running
   *     only — the amber ring on its lamp).
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
    // A timed part that cannot read its own R and C — the same verdict its
    // triangle shows while it runs (a power fault speaks first there, and here
    // both are listed, as an unprogrammed dead ROM's are).
    const timingProblems = timingProblemSentences(
      this.#simOverlay.timingOf(id),
    );
    if (timingProblems.length) keys.push("timing");
    // A MOSFET whose gate reads undefined is running on the charge its gate
    // holds — the amber ring on its lamp, said in words. Not a fault the
    // simulation makes, but one a real board would: that charge leaks.
    const channel = this.#simOverlay.channelOf(id);
    if (channel?.held) keys.push(channel.on === "H" ? "heldOn" : "heldOff");
    if (
      isRomChip(partDef(comp.ref)) &&
      Boolean(comp.params?.storage?.guid) &&
      comp.params?.programmed !== true
    ) {
      keys.push("unprogrammed");
    }
    // Edits in its inspector that the chip's file has not got yet.
    if (this.#unsavedMemory.has(id)) keys.push("unsaved");
    // The power sentences state the voltage the part saw and the supply it is
    // rated for (its family's, Feature 400); the others ignore both.
    const volts = voltsText(this.#simOverlay.voltsOf(id));
    const rating = supplyText(partDef(comp.ref));
    const problems = timingProblems.join("; ");
    return keys.map((key) =>
      t(`properties.warning.${key}`, { volts, rating, problems }),
    );
  }

  /** Open the shared Properties dialog (context menu → "Properties…") for a
      part — see #propertyFieldsFor. Every part gets Name/Description (the
      dialog itself prepends those), so this is never a no-op. */
  #onOpenProperties(id) {
    const comp = this.#doc.getComponent(id);
    if (!comp) return;
    const def = partDef(comp.ref);
    const fields = this.#propertyFieldsFor(comp, def);
    // A custom chip's Name and Description are its DESIGN's — the part number
    // and description the chip designer edits — so the card shows those, and
    // follows the designer while both are open.
    const custom = def?.custom ? this.#customChipCard(comp.ref) : null;
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
        ...custom?.values,
        ...comp.params,
        // The part itself, for a Type field that swaps it (value-fields.js
        // `partTypeField`).
        ref: comp.ref,
        // A readonly whose value is DERIVED rather than stored — `values` is
        // the established route for one (the project's Location does the same).
        imageSource: this.#memorySourceLabel(comp),
        timing: isTimed(def) ? this.#timingLabel(comp) : undefined,
      },
      onChange: (key, value) => this.#setComponentProperty(id, key, value),
      onPatch: (patch) => this.#setComponentPatch(id, patch),
      onAction: (key, fieldKey) => this.#onPropertyAction(id, key, fieldKey),
      // A CALLBACK, not a list: the dialog re-asks on every sim tick, so a
      // chip that lets its smoke out while the card is open says so.
      warnings: () => this.#partWarnings(id),
      universal: custom?.universal,
      follow: custom?.follow,
    });
  }

  /**
   * What a CUSTOM chip's Properties card says about its Name/Description
   * pair: the design's part number and description, held to the designer's
   * own rules (a part number's length and letters; nothing while the circuit
   * runs, when the design cannot change), and re-read whenever the designs
   * change — the chip designer's window edits the same two fields.
   * @param {string} ref
   */
  #customChipCard(ref) {
    const read = () => {
      const chip = partDef(ref)?.customChip;
      return chip ? { name: chip.name, description: chip.description } : null;
    };
    const locked = this.#editingLocked;
    return {
      values: read() ?? {},
      universal: {
        name: {
          maxLength: MAX_NAME,
          refused: t("chipdesign.form.nameInvalid"),
          disabledWhen: () => locked,
        },
        description: {
          maxLength: MAX_DESCRIPTION,
          disabledWhen: () => locked,
        },
      },
      follow: { event: "chiphippo:custom-chips-changed", values: read },
    };
  }

  /**
   * A custom chip's Name or Description changed on its Properties card: the
   * DESIGN changes (every instance, the tray, the designer's window), not
   * this one component. Answers false — the card puts the box back and says
   * why — for a part number the designer would refuse too.
   */
  #setCustomChipMeta(ref, key, value) {
    const chip = partDef(ref)?.customChip;
    if (!chip || !this.#putCustomChip) return false;
    const text = String(value ?? "");
    let next;
    if (key === "name") {
      const name = text.trim();
      if (!isValidPartName(name)) return false;
      next = { ...chip, name };
    } else {
      // The designer's description is one line; a line break typed here
      // would vanish from its box and then from the design at its next edit.
      next = {
        ...chip,
        description: text.replace(/\s*[\r\n]+\s*/g, " ").trim(),
      };
    }
    return this.#putCustomChip(next)?.ok === true ? undefined : false;
  }

  /** Apply one Properties-dialog field change. Name/Description are universal
      metadata outside a def's own params contract, so they route to
      setComponentMeta; everything else (catalog-declared properties) still
      goes through setComponentParams. Remounting (rather than updateParams
      alone) is correct for every part kind: a rotatable/span part (e.g. the
      LED) only redraws through its span geometry, which updateParams alone
      skips — see DiscreteView.updateParams.

      Answers false — the dialog then puts the control back and says why —
      for a change that would move a pin somewhere it cannot go (an inductor
      grown to three holes between its leads, with the next hole taken). */
  #setComponentProperty(id, key, value) {
    if (key === "ref") {
      this.#swapComponent(id, value);
      return;
    }
    const ref = this.#doc.getComponent(id)?.ref;
    if ((key === "name" || key === "description") && partDef(ref)?.custom) {
      return this.#setCustomChipMeta(ref, key, value);
    }
    if (key === "size" && ref === "meter") {
      // Folded or opened out in place, as its title's double-click does.
      this.#foldMeter(id, value === "compact");
      return;
    }
    if (key === "skin" && ref === "meter" && METER_LOOKS.includes(value)) {
      // The look picked is the one the next meter taken out wears: the
      // app's setting, persisted and applied as a Settings change is.
      window.dispatchEvent(new CustomEvent("chiphippo:settings-changed", { detail: { meterLook: value } })); // prettier-ignore
    }
    // A Position slider dragged, a value typed: most changes move no pin,
    // and then there is no probe to push off (#emitDocChanged).
    const seat = this.#doc.seatKey(id);
    if (key === "name" || key === "description") {
      this.#doc.setComponentMeta(id, { [key]: value });
    } else if (
      key === "case" &&
      value !== "TO-92" &&
      legsBent(this.#doc.getComponent(id))
    ) {
      // Off a TO-92 on bent legs: only where they stand in a row, and then it
      // is stood up straight first (free-legs.js — a TO-220's legs are rigid).
      if (!this.#straightenForPackage(id, value)) return false;
    } else {
      if (!this.#doc.canSetComponentParams(id, { [key]: value })) return false;
      this.#doc.setComponentParams(id, { [key]: value });
    }
    this.#remountPart(id);
    this.#emitDocChanged("set properties", {
      coalesce: true,
      seatsKept: this.#doc.seatKey(id) === seat,
    });
  }

  /** Stand a bent TO-92 straight in the row its legs make and give it package
      `pkg` — false, changing nothing, when they make none. */
  #straightenForPackage(id, pkg) {
    const comp = this.#doc.getComponent(id);
    const seat = comp && legSeat(this.#doc, comp, new Map());
    if (!seat || Array.isArray(seat.params.legs)) return false;
    try {
      this.#doc.moveClusterWithWires(
        [{ ...seat, params: { ...seat.params, case: pkg } }],
        { moves: [] },
      );
    } catch {
      return false;
    }
    return true;
  }

  /** Apply a Properties-dialog PATCH of several params at once — a combo's
      (a Zener's voltage and its part number) or a preset's (a custom grade
      and its figures, which the part's normalizer only keeps TOGETHER). One
      params write, one remount, one undo step. A patch reaching the part's
      identity or its Name/Description goes key by key, as it always did.
      Answers false, as #setComponentProperty does, for a change that would
      move a pin somewhere it cannot go. */
  #setComponentPatch(id, patch) {
    const keys = Object.keys(patch);
    if (keys.some((k) => k === "ref" || k === "name" || k === "description")) {
      for (const key of keys) {
        if (this.#setComponentProperty(id, key, patch[key]) === false) {
          return false;
        }
      }
      return undefined;
    }
    if (!this.#doc.canSetComponentParams(id, patch)) return false;
    const seat = this.#doc.seatKey(id);
    this.#doc.setComponentParams(id, patch);
    this.#remountPart(id);
    this.#emitDocChanged("set properties", {
      coalesce: true,
      seatsKept: this.#doc.seatKey(id) === seat,
    });
    return undefined;
  }

  /**
   * Swap a part for a sibling from its Properties card's Type field — a
   * ceramic for an electrolytic, an NPN for a MOSFET (DeskDoc.setComponentRef:
   * the same holes and wiring, its params carried across). ONE undo step. The
   * card it came from describes the OLD part — a MOSFET has a Package a BJT
   * has not, an electrolytic other common values — so it is closed and the
   * new part's opened in its place, which is also where a value the new type
   * cannot be is shown red.
   */
  #swapComponent(id, ref) {
    try {
      this.#doc.setComponentRef(id, ref);
    } catch {
      return; // not interchangeable — the card is left as it was
    }
    this.#remountPart(id);
    this.#emitDocChanged("change part type");
    PopupManager.close();
    this.#onOpenProperties(id);
  }

  /** Fire a Properties-dialog `"action"` field — the memory chip commands
      (#propertyFieldsFor); the dialog has already closed by the time this
      runs. */
  #onPropertyAction(id, key, fieldKey) {
    if (key === "programMemory") this.#onProgramMemory?.(id);
    if (key === "float") this.#floats.open(id, fieldKey);
  }

  /** The `float: true` sliders a part's Properties card shows — the ones it
      can float (#floatMenuItems, the card's own pop-out icon). */
  #floatableFields(comp) {
    if (!comp) return [];
    return this.#propertyFieldsFor(comp, partDef(comp.ref)).filter(
      (field) => field.type === "range" && field.float,
    );
  }

  /** What a floated slider shows: the part's Name (else what it is), the
      field and its label as its Properties card has them, and the part's
      values — or null once the part, or that field of it, is gone. */
  #floatSubject(id, key) {
    const comp = this.#doc.getComponent(id);
    const field = this.#floatableFields(comp).find((f) => f.key === key);
    if (!field) return null;
    const def = partDef(comp.ref);
    const title = comp.name?.trim() || (def ? partTitle(def) : comp.ref);
    return { title, label: fieldLabel(field), field, values: { ...comp.params } }; // prettier-ignore
  }

  /**
   * Where a floated slider's window opens (SliderWindows' `anchorOf`; main
   * places it, model/float-placement.js): its part in this window, the
   * circuit to keep clear of — every strip and part drawn, wires running
   * between them — and the desk's own area to open within, as plain boxes in
   * client pixels. Null with the part out of sight (the schematic or 3D view
   * showing).
   */
  #floatAnchor(id) {
    const shown = (elem) => {
      const box = elem?.getBoundingClientRect();
      return box && (box.width || box.height)
        ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom } // prettier-ignore
        : null;
    };
    const part = shown(this.#partViews.get(id)?.element);
    if (!part) return null;
    let clear = null;
    for (const view of [...this.#views.values(), ...this.#partViews.values()]) {
      const box = shown(view.element);
      if (!box) continue;
      clear = clear
        ? {
            left: Math.min(clear.left, box.left),
            top: Math.min(clear.top, box.top),
            right: Math.max(clear.right, box.right),
            bottom: Math.max(clear.bottom, box.bottom),
          }
        : { left: box.left, top: box.top, right: box.right, bottom: box.bottom }; // prettier-ignore
    }
    return { part, clear, within: shown(this.#viewport) ?? undefined };
  }

  /** Light the part a floated slider is pointed at (or put it out). */
  #setFloatTarget(id) {
    if (id === this.#floatTarget) return;
    const was = this.#floatTarget;
    this.#floatTarget = id;
    this.#partViews.get(was)?.element?.classList.remove("part--float-target");
    this.#partViews.get(id)?.element?.classList.add("part--float-target");
  }

  // ── Live lamp verdicts (read by the 3D view) ────────────────────────────

  /** An LED's lit/burnt verdict on the last sim-state, or null — the one the
      desk is showing (SimOverlay.ledOf), so a second view never re-decides. */
  ledOf(id) {
    return this.#simOverlay.ledOf(id);
  }

  /** One display segment's verdict on the last sim-state, or null. */
  segmentOf(id, segId) {
    return this.#simOverlay.segmentOf(id, segId);
  }

  /** Whether a part smokes on the last sim-state ("grey" | "brown" | null) —
      the desk's burn, read by the 3D view (SimOverlay.smokeOf). */
  smokeOf(id) {
    return this.#simOverlay.smokeOf(id);
  }

  /** Whether lit lamps keep their halo on this run (SimOverlay.glowing). */
  get lampsGlowing() {
    return this.#simOverlay.glowing;
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
      if (this.#cut.handleEscape()) return true;
      if (this.placementArmed) {
        this.cancelPlacement();
        return true;
      }
      if (this.#sel.single || this.#sel.size() > 0) {
        this.deselect();
        this.#recordSelection();
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
      if (this.cutToolArmed) {
        this.disarmCutTool();
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
    if (this.#editingLocked) {
      if (isEditKey(e)) this.#refuseEdit();
      return false;
    }
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
    if ((e.key === "k" || e.key === "K") && bareKey && !dragging) {
      this.toggleCutTool();
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
      // R also turns a signal flag about its POINT — the anchor is never part
      // of the rotation, so there is nothing to re-resolve.
      if (this.#rotateSelectedSignal()) return true;
      // …and an Output/Input tag, the same way.
      if (this.#integration.rotate()) return true;
    }
    // Delete removes the WHOLE selection at once, no questions — parts,
    // wires and boards together, a board taking its passengers
    // (removeSelectedComponents). The other single picks each remove the
    // thing they name.
    if (
      (e.key === "Delete" || e.key === "Backspace") &&
      !dragging &&
      (this.#sel.size() > 0 ||
        ["part", "wire", "board"].includes(this.#sel.single?.kind))
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
      // A picked LEAD deletes what it belongs to: a part with a leg gone, or
      // a wire with an end gone, would be nothing at all.
      if (kind === "lead") this.#doRemoveSelected([id]);
      else if (kind === "wire-end") this.removeWire(id);
      else if (kind === "bus") this.#bus.removeBus(id, true);
      else if (kind === "annotation") this.removeAnnotation(id);
      // Delete removes the SIGNAL — button and all — as every other single
      // pick removes the thing it names. Unplugging a flag is the drag.
      else if (kind === "signal") this.removeSignal(id);
      // A TAG names a lead, not the element: Delete unplugs it back to its
      // card, and the element's own menu is where it is deleted outright.
      else if (kind === "tag") {
        const tag = parseTagId(id);
        if (tag) this.#integration.unplugTag(tag.elementId, tag.key);
      }
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
      view = new ClockView(this.#layers.parts, component, callbacks, { spiceLite: this.#spiceLite }); // prettier-ignore
    } else if (component.kind === "load") {
      view = new LoadView(this.#layers.parts, component, callbacks);
    } else if (component.kind === "ac") {
      view = new AcView(this.#layers.parts, component, callbacks);
    } else if (component.kind === "transformer") {
      view = new TransformerView(this.#layers.parts, component, callbacks);
    } else if (component.kind === "adapter") {
      view = new AdapterView(this.#layers.parts, component, callbacks);
    } else if (component.kind === "meter") {
      view = new MeterView(this.#layers.meters, component, { ...callbacks, onBeep: (id, on) => this.#meterBench?.beep(id, on), onChirp: (id) => this.#meterBench?.chirp(id) }, { spiceLite: this.#spiceLite }); // prettier-ignore
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
      // A custom chip mounted mid-session wears the debugger's badge at once.
      const debug = this.#lastChipDebug;
      if (debug) {
        const armed = new Map(debug.armed ?? []).get(component.id);
        view.setDebug?.({
          armed: Boolean(armed?.lines || armed?.settled),
          paused: (debug.pausedChips ?? []).includes(component.id),
        });
      }
      if (this.#unsavedMemory.has(component.id)) view.setUnsaved(true);
    }
    if (component.id === this.#floatTarget) {
      view.element?.classList.add("part--float-target");
    }
    this.#partViews.set(component.id, view);
  }

  /** Position a part view: a rotated resistor spans its two ends, every other
      part (chip/discrete) seats at its anchor. `board` may be an override
      origin (live board drag). `boards`, when given, is every strip as the
      document has it (`board` among them) — the pins of a span or bent legs
      are read against it rather than a fresh copy of the desk per part. */
  #placePartView(view, comp, board, boards = null) {
    if (!board) return;
    const pinsOf = () =>
      boards ? partPinsWorld(boards, comp) : this.#partPins(comp, board);
    // Every rotatable part draws as a span between its two derived ends — body
    // centred on the pair and rotated to the lead angle, whichever form it's
    // stored in (footprint or two free ends). The span is pure geometry, so a
    // part whose far strip was pulled away keeps its exact position; only the
    // floating cue marks the connection it lost.
    if (partDef(comp.ref)?.rotatable) {
      const pins = pinsOf();
      if (pins?.length >= 2) {
        view.updateSpanWorld(pins[0], pins[1]);
        view.setFloating?.(pins.some((p) => p.address == null));
        return;
      }
    }
    // A TO-92 on bent legs draws from its three pins' points, pin 1's first
    // (free-legs.js); straight — after a drag put them back in a row, or in
    // the straight form a drag is previewing — it seats like any discrete.
    if (legsBent(comp)) {
      const pins = pinsOf();
      if (pins?.length === 3) {
        view.updateLegsWorld?.([...pins].sort((a, b) => a.pin - b.pin));
        view.setFloating?.(pins.some((p) => p.address == null));
        return;
      }
    } else if (hasFreeLegs(comp)) {
      view.showStraight?.(comp.params);
      view.setFloating?.(false);
    }
    view.updatePlacement(board, comp.anchor, comp.params);
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

  /** Re-place every part seated on `boardIds` from the document: ONE pass
      over the parts with one copy of the strips. Strip by strip, each looked
      its board up, filtered every part on the desk and — for a span or bent
      legs — copied every strip again per part (busy64's drop: ~11 ms). */
  #repositionPartsOn(boardIds) {
    const ids = new Set(boardIds);
    const boards = this.#doc.boards;
    const byId = new Map(boards.map((b) => [b.id, b]));
    for (const comp of this.#doc.components) {
      if (!ids.has(comp.board)) continue;
      const view = this.#partViews.get(comp.id);
      if (view) this.#placePartView(view, comp, byId.get(comp.board), boards);
    }
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

  /**
   * A press on a strip. A board is BACKGROUND to the hand unless it is
   * selected (CLAUDE.md → "Selection"): its bare holes start the rubber band
   * (a click there selects the whole board), ⌘/Ctrl-click toggles its snapped
   * group, and only a strip already IN the selection is grabbed — pressing it
   * drags the whole selection, everything seated on it riding along. All of
   * that is `#press`; this only names what was pressed.
   */
  #onBoardPointerDown(id, e) {
    if (e.button !== 0) return; // middle = pan (DeskView), right = menu
    if (this.#mode || this.#probe.armed || this.#editingLocked) return;
    if (this.#press(e, { kind: "board", id })) e.stopPropagation();
  }

  /** The waypoint shift a group drag previews AND commits with: the bends its
      strips and bricks carry (frozen at pointer-down), and the delta they
      travel by — null when the set carries no routing, the usual case. */
  #pointRide(d, { dx, dy }) {
    const points = this.#carriedPoints(d);
    return points.size > 0 ? { points, dx, dy } : null;
  }

  /** The frozen carried bends (`d.ridingPoints`) less any wire the riders'
      plan translates whole this sample — one wire, one shift, never two. */
  #carriedPoints(d) {
    const planned = d.plan?.points ?? [];
    if (planned.length === 0) return d.ridingPoints;
    const skip = new Set(planned.map((p) => p.id));
    return new Map([...d.ridingPoints].filter(([id]) => !skip.has(id)));
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
   * Make a group drag's strips and their passengers ride ONE transform per
   * layer (`d.carry`, applied by #applyBoardShift). Whichever is the smaller
   * set moves house for the gesture: the riders into a wrapper inside their
   * layer (the wrapper is transformed), or — when most of the layer rides, as
   * on a Select-All drag — everything else into a still sibling just after
   * the layer, and the layer itself is transformed. Each moved element's
   * place is recorded and given back by #endCarry. A passenger whose pins
   * are not all in the moving strips stays put among the still ones (`live`):
   * its drawing — a lead reaching a still strip, floating or landing — is
   * worked out per frame, as before; so is every member (#applyClusterPreview).
   *
   * The carry also wears the strips' drag look: their carrier — the boards
   * layer or its wrapper — fades as ONE element (`--lifted`) rather than
   * each strip taking `board--dragging`. An opacity on each of 123 strips
   * sent the accessibility tree through every hole of every one (busy64:
   * ~35 ms of the drag's first frame); one on their carrier does not. (The
   * parts riding are passengers, unlit, so their layer never fades.)
   */
  #beginCarry(d) {
    if (d.boardIds.length === 0 || d.carry) return;
    const moving = new Set(d.boardIds);
    const boards = this.#doc.boards;
    const boardById = new Map(boards.map((b) => [b.id, b]));
    // With every strip on the desk moving, nothing a lead can reach stays
    // put, so no passenger needs its pins looked at.
    const everything = boards.every((b) => moving.has(b.id));
    const riders = new Set();
    const live = [];
    const docJson = { boards, components: [] };
    for (const id of d.boardIds) {
      const el = this.#views.get(id)?.element;
      if (el) riders.add(el);
    }
    // One pass over the parts (not one per strip).
    for (const comp of this.#doc.components) {
      if (!moving.has(comp.board)) continue;
      const view = this.#partViews.get(comp.id);
      if (!view?.element) continue;
      const spans =
        !everything &&
        (partDef(comp.ref)?.rotatable || legsBent(comp) || hasFreeLegs(comp));
      const pins = spans ? partPinAddresses(docJson, comp) : null;
      const rigid =
        !spans ||
        Boolean(
          pins?.every(
            (p) =>
              p.address != null && moving.has(parseAddress(p.address)?.boardId),
          ),
        );
      if (rigid) riders.add(view.element);
      else live.push({ comp, view, board: boardById.get(comp.board) });
    }
    const moved = []; // [element, parent, nextSibling] in the order moved
    const box = (cls) => {
      const w = document.createElement("div");
      w.className = cls;
      w.style.cssText = "position:absolute;left:0;top:0";
      return w;
    };
    const carryLayer = (layer, lift) => {
      const kids = []; // walked, not `[...layer.children]` (a live collection)
      for (let el = layer.firstElementChild; el; el = el.nextElementSibling) {
        kids.push(el);
      }
      const ride = kids.filter((el) => riders.has(el));
      const stay = kids.filter((el) => !riders.has(el));
      const rehouse = (els, into) => {
        for (const el of els) {
          moved.push([el, el.parentNode, el.nextSibling]);
          into.append(el);
        }
      };
      if (ride.length <= stay.length) {
        const wrap = box("desk-drag-carry");
        wrap.style.willChange = "transform";
        if (lift) wrap.classList.add("desk-drag-carry--lifted");
        layer.append(wrap);
        rehouse(ride, wrap);
        return { shifted: wrap, extra: wrap, lifted: null };
      }
      // Nothing staying needs no still box (a strip-wide group: every strip).
      let still = null;
      if (stay.length > 0) {
        still = box("desk-drag-still");
        layer.after(still);
        rehouse(stay, still);
      }
      const lifted = lift ? `${layer.classList[0]}--lifted` : null;
      if (lifted) layer.classList.add(lifted);
      return { shifted: layer, extra: still, lifted };
    };
    d.carry = {
      layers: [
        carryLayer(this.#layers.boards, true),
        carryLayer(this.#layers.parts, false),
      ],
      moved,
      live,
    };
  }

  /** Put every element #beginCarry moved back in its own place (in reverse,
      so each one's recorded neighbour is already home), and the wrappers
      away. The caller then positions them from the document. */
  #endCarry(d) {
    const carry = d.carry;
    if (!carry) return;
    d.carry = null;
    for (let i = carry.moved.length - 1; i >= 0; i -= 1) {
      const [el, parent, next] = carry.moved[i];
      if (next && next.parentNode !== parent) parent.append(el);
      else parent.insertBefore(el, next);
    }
    for (const { shifted, extra, lifted } of carry.layers) {
      shifted.style.transform = "";
      if (lifted) shifted.classList.remove(lifted);
      extra?.remove(); // a wrapper takes its lift with it
    }
  }

  /**
   * Move every dragged strip's view (and its seated parts — the passengers)
   * by a delta from the drag origins. Returns the board → position overrides
   * for WireLayer, so a wire ending on one rides it live.
   *
   * Under a live group drag (`d.carry`, #beginCarry) the strips and the
   * passengers that simply translate ride ONE wrapper per layer, moved by a
   * single transform: re-placing every strip and every part view each frame
   * restyled and repainted the whole desk on a big drag (review 2026-10-26).
   * Only a passenger whose drawing depends on what is NOT moving (a lead
   * reaching a still strip, which may float or land) is placed per frame.
   */
  #applyBoardShift(d, { dx, dy }) {
    const overrides = new Map();
    const carry = d.carry;
    if (carry) {
      const shift = `translate(${dx * PX_PER_UNIT}px, ${dy * PX_PER_UNIT}px)`;
      for (const { shifted } of carry.layers) shifted.style.transform = shift;
    }
    for (const m of d.boardOrigins) {
      const pos = { x: m.ox + dx, y: m.oy + dy };
      overrides.set(m.id, pos);
      if (carry) continue;
      const view = this.#views.get(m.id);
      view?.setPosition(pos.x, pos.y);
      this.#repositionBoardParts(m.id, pos.x, pos.y);
    }
    for (const { comp, view, board } of carry?.live ?? []) {
      const pos = overrides.get(board.id);
      this.#placePartView(view, comp, { ...board, x: pos.x, y: pos.y });
    }
    // The flags and tags planted on the strips go with them.
    for (const f of d.stripFlags ?? []) {
      const at = { x: f.at.x + dx, y: f.at.y + dy };
      if (f.kind === "tag") {
        this.#integrationLayer.setPreview(f.id, f.key, { at, rot: f.rot });
      } else this.#signalLayer.setPreview(f.id, { at, rot: f.rot });
    }
    // The highlighter rides the set and reddens on an illegal drop — one
    // shape for the whole unit, so no seams appear between flush strips.
    this.#sel.refreshBoardOutline(overrides);
    return overrides;
  }

  #onBoardContextMenu(id, e) {
    e.preventDefault();
    if (this.#probe.armed) return; // right-click names the net (viewport handler)
    if (this.#editingLocked) this.#refuseEdit();
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
    if (this.#doc.getComponent(id)?.kind === "meter") {
      this.#onMeterPointerDown(id, e);
      return;
    }
    if (e.button !== 0) return;
    if (this.#mode || this.#probe.armed) return; // no part drags while probing
    const toggling = isToggleSelectEvent(e, IS_MAC);
    // While running, only click-toggle parts stay interactive (click to
    // flip); every other part is frozen in place.
    if (this.#editingLocked) {
      // A modifier-press is a SELECT, and selection is refused while running —
      // it must not fall through and flip a switch instead. Option/Alt alone
      // is the pan, which a run does not stop.
      if (toggling || e.altKey) {
        e.stopPropagation();
        if (e.altKey && !toggling) this.#altPan(e);
        return;
      }
      // While running, only live interactions remain: a slide switch or
      // toggle button flips, a manual clock toggles one edge, and a
      // free-running clock's own button pauses or resumes it. That button is
      // drawn only while running, so it is never the target of an edit-time
      // press (which drags the brick).
      const comp = this.#doc.getComponent(id);
      if (comp?.kind === "clock" && e.target?.closest?.(".part-clock-pause")) {
        e.stopPropagation();
        this.#onClockPause?.(id);
      } else if (clickTogglingPart(comp?.ref)) {
        e.stopPropagation();
        this.#toggleClickPart(id, switchIndexFromEvent(e));
      } else if (comp?.kind === "clock" && comp.params?.hz === "manual") {
        e.stopPropagation();
        this.#onClockToggle?.(id);
      } else {
        // Anything else is frozen: a drag of it is told why.
        this.#refuseDragFrom(e);
      }
      return;
    }
    if (this.#press(e, { kind: "part", id })) e.stopPropagation();
  }

  /**
   * THE PRESS RULE — every primary-button press on the desk while editing
   * comes through here, whatever it landed on (CLAUDE.md → "Selection"). The
   * whole model is one idea: A CLICK IS A DRAG THAT DIDN'T TRAVEL. Press an
   * object and you have picked it up; let go where you pressed and it is set
   * back down on its own hole — a no-op move whose one lasting effect is that
   * the object is now the selection. There is no separate "select click" to
   * tell apart from a "drag click", only whether the pointer travelled.
   *
   *   - Option/Alt: pin-targeting mode — only an independently movable lead
   *     answers (#pinPress), or failing one a routed wire's bend, and the pick
   *     REPLACES the selection; with ⌘/Ctrl too it toggles that lead in or out
   *     of the set instead.
   *   - ⌘/Ctrl: toggle the object pressed in or out; on bare desk, nothing.
   *   - Plain, on the BACKGROUND — bare desk, or a strip that is not selected
   *     (its holes count as background): the rubber band. A click on bare
   *     desk clears; a click on a strip selects its whole snapped group.
   *   - Plain, on a member of a multi-object selection (anything selected in
   *     its own right, a selected strip's bare holes, or a picked lead's ring):
   *     the whole selection drags as one; a click collapses it to what was
   *     pressed.
   *   - Plain, on anything else — a PASSENGER riding a selected board
   *     included: it becomes the selection and the press drags it alone.
   *   - Shift is no chord of its own: it rides any of the plain presses
   *     above, and makes the part drag they begin a BARE one (#ridersOf) —
   *     the parts move and their wiring stays where it is.
   *
   * Pan is DeskView's — Space-drag and the middle button — and an Option/Alt
   * drag that picks no lead or bend (#pinPress) hands it the press.
   *
   * @param {PointerEvent} e
   * @param {{kind: "part"|"board"|"wire"|"bus"|"bus-handle", id: string}|null}
   *   hit - what the press landed on; null for the bare desk.
   * @returns {boolean} whether the press was claimed.
   */
  #press(e, hit) {
    if (e.button !== 0 || this.#mode || this.#probe.armed) return false;
    if (this.#editingLocked) return false; // the callers own the running press
    const world = this.#deskView.worldFromEvent(e);
    this.#hideHover();
    if (e.altKey) {
      // With ⌘/Ctrl too it ADDS the lead to the set (or takes it out); alone
      // it picks that lead and nothing else.
      if (isLeadToggleEvent(e, IS_MAC)) this.#toggleLeadAt(world);
      else this.#pinPress(e, world);
      return true;
    }
    // A picked lead in a multi-selection is a MEMBER: pressing its ring drags
    // the whole selection by it (its hole is otherwise the wire's or the
    // part's, body on top — but the ring is what the user is aiming at).
    const lead = this.#sel.size() > 1 ? this.#selectedLeadNear(world) : null;
    if (lead && !isToggleSelectEvent(e, IS_MAC)) {
      this.#beginGroupDrag({ kind: "lead", pick: lead }, e, world);
      return true;
    }
    // A wire's end cap sits ON a hole and is no pointer target, so a press on
    // it lands on the board (or bare desk) beneath; so can one on a routed
    // wire's bend knob. The wire is what was aimed at — the body on top wins
    // over the board under it.
    if (hit == null || hit.kind === "board") {
      const capWire =
        this.#wire.wireIdNear(world) ??
        wirePointNear(this.#doc.wires, world)?.wireId;
      if (capWire) hit = { kind: "wire", id: capWire };
    }
    if (isToggleSelectEvent(e, IS_MAC)) {
      if (hit?.kind === "part") this.toggleComponentSelection(hit.id);
      else if (hit?.kind === "wire") this.toggleWireSelection(hit.id);
      else if (hit?.kind === "bus" || hit?.kind === "bus-handle") {
        this.toggleBusSelection(hit.id);
      } else if (hit?.kind === "board") this.toggleBoardSelection(hit.id);
      // Bare desk: a miss, not a request to clear — nothing changes.
      this.#recordSelection();
      return true;
    }
    if (
      !hit ||
      (hit.kind === "board" && !this.#sel.selectedBoards().has(hit.id))
    ) {
      this.#beginMarquee(e, hit?.id ?? null);
      return true;
    }
    if (this.#inGroup(hit)) {
      // Refused (a member that won't resolve): the press is absorbed and the
      // selection left exactly as it was — collapsing it is the one thing a
      // refusal must not do.
      this.#beginGroupDrag(hit, e, world);
      return true;
    }
    switch (hit.kind) {
      case "part":
        this.selectComponent(hit.id);
        this.#recordSelection();
        // A TO-92 on bent legs has no footprint to re-seat: it moves as a
        // one-part selection does, pin 1 snapping to a hole and every leg
        // keeping its bend (cluster-move.js's "lead" form).
        if (legsBent(this.#doc.getComponent(hit.id))) {
          this.#beginGroupDrag(hit, e, world);
        } else this.#beginPartDrag(hit.id, e);
        break;
      case "wire":
        if (this.#isRoutedWire(hit.id)) {
          // A routed wire is ONE piece, its bends a group with its ends (Jason,
          // 2026-10-20): the plain drag carries the lot by the one delta, the
          // ends seating as a selected wire's do in a group drag. Bending it
          // — laying a waypoint, moving one — is the Option/Alt press's.
          this.selectWire(hit.id);
          this.#recordSelection();
          this.#beginGroupDrag(hit, e, world);
          break;
        }
        this.#wire.beginBodyDrag(hit.id, e); // selects it, then drags
        this.#recordSelection();
        break;
      case "bus":
      case "bus-handle":
        this.#bus.beginDrag(e, world); // selects it, then drags
        this.#recordSelection();
        break;
      case "board":
        // A selected strip outside any group drag — only reachable with a
        // board picked and nothing else, which #inGroup already takes.
        break;
    }
    return true;
  }

  /** Is `id` a ROUTED wire of its own — a bus member never is, whatever its
      layout says (its middle belongs to the ribbon). */
  #isRoutedWire(id) {
    const wire = this.#doc.getWire(id);
    return wire?.layout === "routed" && !this.#doc.busOfWire(id);
  }

  /**
   * Does a plain press on `hit` drag the WHOLE selection? When the selection
   * holds more than one thing (or any board), and `hit` is selected in its
   * own right — a selected strip by its bare holes. A bus counts when every
   * one of its members does; an end handle never does (it moves one end of
   * its own bus, which is a different gesture). A PASSENGER does not: it is
   * not selected, so pressing it is a plain press on that one object, which
   * then becomes the selection — the board is grabbed by its own holes.
   */
  #inGroup(hit) {
    const sets = this.#sel.movingSets();
    const total =
      sets.parts.size + sets.wires.size + sets.boards.size + sets.leads.length;
    if (sets.boards.size === 0 && total < 2) return false;
    const wireIn = (id) => sets.wires.has(id);
    switch (hit.kind) {
      case "part":
        return sets.parts.has(hit.id);
      case "wire":
        return wireIn(hit.id);
      case "bus": {
        const members = this.#doc.getBus(hit.id)?.members ?? [];
        return members.length > 0 && members.every(wireIn);
      }
      case "board":
        return sets.boards.has(hit.id);
      default:
        return false;
    }
  }

  /**
   * Option/Alt press — PIN-TARGETING mode. Bodies are inert; the only targets
   * are the holes holding an independently movable lead: a wire end, or a leg
   * of a two-terminal part (a fixed pin of a rigid package can't move apart
   * from its chip, so it is never one). A press on one REPLACES the selection
   * with that lead alone — never additive — and is that lead's drag: let go in
   * place and it is simply picked, travel and it lands in a new hole. A press
   * on nothing lightable PANS the desk (Jason, 2026-10-14) — its drag does; a
   * click there does nothing at all.
   *
   * Short of a lead, a ROUTED wire answers too (Jason, 2026-10-20): a press on
   * one of its waypoints drags that bend, and anywhere else along its run lays
   * a new one there (WireTools.bendTargetAt) — the same bend a plain body
   * press makes, reachable from pin mode. The wire becomes the selection.
   */
  #pinPress(e, world) {
    const target = this.#pinTargetAt(world);
    if (!target) {
      const bend = this.#wire.bendTargetAt(world);
      if (bend) {
        aimRing(this.#ring, null);
        this.#wire.beginBend(bend, e); // selects it, then drags
        this.#recordSelection();
        this.#refreshPinMode();
      } else this.#altPan(e);
      return;
    }
    aimRing(this.#ring, null);
    if (target.kind === "wire-end") {
      this.#sel.selectWireEnd(target.id, target.end);
      this.#recordSelection();
      this.#wire.beginEndDrag(
        { wireId: target.id, end: target.end, origin: target.origin },
        e,
      );
      this.#refreshPinMode();
      return;
    }
    const comp = this.#doc.getComponent(target.id);
    if (hasFreeLegs(comp)) {
      this.#beginLegDrag(comp, target.end, e, world);
      return;
    }
    const ends = comp && this.#resistorEndPoints(comp);
    const view = this.#partViews.get(target.id);
    if (!ends || !view) return;
    this.#sel.selectLead(comp.id, target.end);
    this.#recordSelection();
    this.#mode = this.#resistorEndDragMode(comp, ends, target.end, e, world);
    this.#viewport.classList.add("desk-viewport--dragging");
    this.#mode.teardown = beginPointerGesture(view.element, e.pointerId, {
      onMove: this.#onPartPointerMove,
      onEnd: this.#onPartPointerUp,
    });
    this.#refreshPinMode();
  }

  /** An Option/Alt drag that picked no lead pans the desk (DeskView's own
      pan, after the click threshold): beside Space-drag and the middle
      button, the one-handed way. Whether it began one. */
  #altPan(e) {
    return this.#deskView.beginPan?.(e) ?? false;
  }

  /**
   * Option/Alt+⌘/Ctrl press — the lead under the pointer (the target
   * pin-targeting mode rings) goes into the selection, or back out. A click,
   * not a drag: nothing moves, and a press on nothing lightable changes
   * nothing — a miss is not a request to clear.
   */
  #toggleLeadAt(world) {
    const target = this.#pinTargetAt(world);
    if (!target) return;
    this.#sel.toggleLeadSelection({
      kind: target.kind,
      id: target.id,
      end: target.end,
    });
    this.#recordSelection();
  }

  /** The picked lead of the multi-selection whose ring `world` is on (within
      WIRE_END_GRAB_RADIUS, nearest wins), as `{kind, id, end}`, or null. */
  #selectedLeadNear(world) {
    let best = null;
    for (const pick of this.#sel.movingSets().leads) {
      const at = this.#leadWorld(pick);
      if (!at) continue;
      const dist = Math.hypot(world.x - at.x, world.y - at.y);
      if (dist <= WIRE_END_GRAB_RADIUS && (!best || dist < best.dist)) {
        best = { pick, dist };
      }
    }
    return best?.pick ?? null;
  }

  /**
   * The lead pin-targeting mode would pick at `world` — the nearest within
   * WIRE_END_GRAB_RADIUS of a wire end or a two-terminal part's leg — as
   * `{ kind: "wire-end"|"lead", id, end, x, y, origin? }`, or null. A bus
   * member's cap right on its own bus's end handle is the handle's, not a
   * lead (WireTools.endGrabbable).
   */
  #pinTargetAt(world) {
    const doc = this.#doc;
    let best = null;
    const grab = wireEndNear(doc.boards, doc.components, doc.wires, world);
    if (grab && this.#wire.endGrabbable(grab.wireId, world)) {
      const at = this.#addressWorld(grab.origin);
      if (at) {
        best = {
          kind: "wire-end",
          id: grab.wireId,
          end: grab.end,
          origin: grab.origin,
          x: at.x,
          y: at.y,
          dist: grab.dist,
        };
      }
    }
    for (const comp of doc.components) {
      if (comp.board == null) continue;
      const ends = this.#leadEnds(comp);
      if (!ends) continue;
      for (const end of LEG_ENDS) {
        const p = ends[end];
        if (!p) continue;
        const dist = Math.hypot(world.x - p.x, world.y - p.y);
        if (dist > WIRE_END_GRAB_RADIUS || (best && dist >= best.dist)) {
          continue;
        }
        best = { kind: "lead", id: comp.id, end, x: p.x, y: p.y, dist };
      }
    }
    return best;
  }

  /** Where a picked lead sits now (world units), or null — what the lead
      ring is drawn at. */
  #leadWorld(pick) {
    if (pick?.kind === "lead") {
      const comp = this.#doc.getComponent(pick.id);
      return (comp && this.#leadEnds(comp)?.[pick.end]) ?? null;
    }
    if (pick?.kind === "wire-end") {
      return this.#addressWorld(this.#doc.getWire(pick.id)?.[pick.end]);
    }
    return null;
  }

  /**
   * Begin the drag of ONE part — it is already the selection. It carries its
   * wiring: every wire end in a node one of its pins occupies, and the leads of
   * the two-terminal parts plugged in there (CLAUDE.md → "Moving parts and
   * clusters"). A two-terminal part moves by its BODY here, both leads
   * together; one leg alone is an Option/Alt press (#pinPress).
   */
  #beginPartDrag(id, e) {
    const comp = this.#doc.getComponent(id);
    const view = this.#partViews.get(id);
    const w = this.#deskView.worldFromEvent(e);

    if (!comp || !view) return;
    // A two-terminal part drags RIGIDLY by both ends (either may be a rail),
    // and rotates freely mid-drag with R — never through the footprint
    // reseat. Pressed anywhere on it — a lead included: the body wins, and
    // one leg alone is pin-targeting mode's.
    if (partDef(comp.ref)?.rotatable) {
      const ends = this.#resistorEndPoints(comp);
      if (!ends) return; // unresolvable pins — the press just selected it
      this.#mode = this.#resistorDragMode(comp, ends, e, w);
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
      const seatCol = anchorColumn(board.type, comp.anchor);
      if (seatCol == null) return;
      const cursorCol = columnAt(board.type, w.x - board.x);
      // THE WIRING COMES WITH IT (Feature 290, the default since the
      // selection & drag model) — the wires in the nodes this part's pins
      // occupy, and the LEADS of the two-terminal parts in them. All of it is
      // read ONCE, here, and frozen for the gesture: the riding sets, because
      // recomputing them per sample would grow and shrink them as the part slid
      // over other holes (so the drop would depend on the path taken to it),
      // and the batch check, because the reduced-occupancy build it hoists is
      // precisely what a prepared check exists to keep out of a live drag's
      // loop. A part with nothing attached is a plain re-seat — hence the
      // empty sets collapsing to null.
      const { attached, legs, flags } = this.#ridersOf([id], e);
      const riding = attached.length > 0 ? attached : null;
      const ridingParts = legs.length > 0 ? legs : null;
      const ridingFlags = flags.length > 0 ? flags : null;
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
        grabOffsetCols: seatCol - cursorCol,
        // A 600-mil chip moves between its wide seats by the pointer's travel,
        // from wherever on it the grab began (seating.js `seatGrabDy`).
        grabDy: seatGrabDy(this.#doc.boards, comp, w),
        origin: {
          board: comp.board,
          anchor: comp.anchor,
          wide: seatsWide(comp.params),
        },
        seat: {
          board: comp.board,
          anchor: comp.anchor,
          wide: seatsWide(comp.params),
        },
        hasAnchored: this.#hasAnchored(id),
        riding,
        ridingParts,
        ridingFlags,
        // A part carrying wiring is a one-member cluster, so it is checked by
        // the one predicate that understands wires, parts and flags.
        checkBatch:
          riding || ridingParts || ridingFlags
            ? this.#doc.prepareClusterMove({
                componentIds: [id, ...legs.map((r) => r.id)],
                wireIds: attached.map((r) => r.wireId),
                flags,
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
    // Closed hand from the moment the part is grabbed (before any drag).
    this.#viewport.classList.add("desk-viewport--dragging");
    this.#mode.teardown = beginPointerGesture(view.element, e.pointerId, {
      onMove: this.#onPartPointerMove,
      onEnd: this.#onPartPointerUp,
    });
  }

  /**
   * What rides a part drag of `ids` (one part, or a `cluster`'s members) —
   * the wires in the nodes their pins
   * occupy and the two-terminal parts with a leg there — read at the press.
   * A SHIFT-drag moves the parts BARE (CLAUDE.md → "Moving parts and
   * clusters"): nothing rides, every wire and leg stays in the hole it is in,
   * and the move is the plain re-seat a part with nothing attached makes —
   * the stationary wiring is ordinary occupancy, so a pin landing on one of
   * those holes is refused like any other taken hole. What is intrinsic to
   * the part still goes with it: a wire on a brick's terminal, its labels.
   */
  #ridersOf(ids, e, { cluster = false } = {}) {
    if (e.shiftKey || ids.length === 0) {
      return { attached: [], legs: [], flags: [] };
    }
    if (!cluster) {
      return {
        attached: this.#doc.wiresRidingPart(ids[0]),
        legs: this.#doc.partsRidingPart(ids[0]),
        flags: this.#doc.flagsRidingPart(ids[0]),
      };
    }
    return {
      attached: this.#doc.wiresRidingCluster(ids),
      legs: this.#doc.partsRidingCluster(ids),
      flags: this.#doc.flagsRidingCluster(ids),
    };
  }

  /**
   * Begin dragging the WHOLE selection as one unit (CLAUDE.md → "Moving parts
   * and clusters"): the selected boards with everything seated on them, the
   * independently selected parts with the wiring riding them, and the
   * selected wires. Returns false — and starts nothing — when a member won't
   * resolve, which would make a gesture that is red wherever it goes.
   *
   * ONE SNAP VECTOR. The delta is the GRABBED thing's own, resolved once per
   * sample and applied to everything (model/cluster-move.js): a part answers
   * through its own seat resolver, a board (or anything riding one) by the
   * board lattice with the magnetic mate, a wire by snapping its nearest end
   * to a hole. Everything sits on the one hole lattice with its spacing kept
   * by construction, so the delta that lands the reference pin lands the rest.
   *
   * Wires follow their ENDS: a wire whose ends are both on what moves moves
   * rigidly; one with an end left behind STRETCHES — the moving end follows
   * its part or board to its new hole, the other stays, and no connection is
   * silently broken. That is also how a strip is peeled off its rails: band
   * the strip and its parts but not the rail, drag, and every wire into the
   * rail stretches across the new gap.
   */
  #beginGroupDrag(hit, e, world) {
    const sets = this.#sel.movingSets();
    const boardIds = [...sets.boards];
    const boardSet = sets.boards;
    const partIds = [...sets.parts];
    const memberIds = new Set(partIds);
    const members = partIds.length > 0 ? this.#doc.clusterMembers(partIds) : [];
    if (!members) return false;
    const wireIds = [...sets.wires].filter(
      (id) => !this.#sel.isPassengerWire(id, boardSet),
    );
    const wireSet = new Set(wireIds);

    // The grab's own lattice decides the one delta (see the header).
    let grab;
    const member =
      hit.kind === "part" ? members.find((m) => m.id === hit.id) : null;
    const leadAt = hit.kind === "lead" ? this.#leadWorld(hit.pick) : null;
    if (hit.kind === "lead" && !leadAt) return false;
    if (leadAt) {
      // A picked lead is grabbed as a wire end is: it is the reference pin,
      // snapped to the hole it lands on.
      grab = { kind: "wire", refWorld: { x: leadAt.x, y: leadAt.y } };
    } else if (member) {
      // The grab column keeps the pressed point under the finger for a
      // footprint member, exactly as the solo drag does; the other two forms
      // track their own anchor and need no offset.
      let grabOffsetCols = 0;
      if (member.form === "footprint") {
        const board = this.#doc.getBoard(member.board);
        const seatCol = board && anchorColumn(board.type, member.anchor);
        if (seatCol == null) return false;
        grabOffsetCols = seatCol - columnAt(board.type, world.x - board.x);
      }
      grab = {
        kind: "member",
        form: member.form,
        ref: member.ref,
        params: member.params,
        // A chip's anchor row is the width it keeps on the move.
        anchor: member.anchor,
        anchorWorld: member.anchorWorld,
        grabOffsetCols,
        startWorld: world,
      };
    } else if (boardIds.length > 0) {
      grab = { kind: "board" };
    } else {
      // A wire (or a bus, by its member nearest the press) — its nearest END
      // is the reference pin.
      const wireId =
        hit.kind === "wire" ? hit.id : this.#nearestBusMember(hit.id, world);
      const refWorld = this.#nearestWireEnd(wireId, world);
      if (!refWorld) return false;
      grab = { kind: "wire", refWorld };
    }

    // What rides the parts — read ONCE and frozen for the gesture, for the
    // reason the solo drag reads it once. A wire selected in its own right
    // moves rigidly instead (it is not a rider), and a two-terminal part
    // seated on a moving board is that board's passenger, not a rider.
    const ridersOf = this.#ridersOf(members.length > 0 ? partIds : [], e, {
      cluster: true,
    });
    // The PICKED LEADS join the riders, following the group's delta instead
    // of a member's node (cluster-move.js mergeLeadRiders) — a Shift drag
    // included: a picked lead was selected, so it is never left behind.
    const { riding, ridingParts: legs } = mergeLeadRiders(
      ridersOf.attached.filter((r) => !wireSet.has(r.wireId)),
      ridersOf.legs.filter(
        (r) => !boardSet.has(this.#doc.getComponent(r.id)?.board),
      ),
      sets.leads,
    );
    // An end stays put in its address when what it is plugged into moves by
    // itself — a hole of a moving board, a terminal of a moving brick.
    const keeps = (address) => {
      const owner = parseAddress(address)?.boardId;
      return boardSet.has(owner) || memberIds.has(owner);
    };
    const wires = [];
    for (const id of wireIds) {
      const wire = this.#doc.getWire(id);
      const fromWorld = this.#addressWorld(wire?.from);
      const toWorld = this.#addressWorld(wire?.to);
      if (!fromWorld || !toWorld) return false;
      wires.push({
        id,
        from: wire.from,
        to: wire.to,
        fromWorld,
        toWorld,
        keepFrom: keeps(wire.from),
        keepTo: keeps(wire.to),
        hasPoints: (wire.points?.length ?? 0) > 0,
      });
    }
    // Labels hung on anything that moves ride the one delta — the members',
    // and those of the parts seated on a moving board.
    const anchorIds = new Set(
      members.filter((m) => this.#hasAnchored(m.id)).map((m) => m.id),
    );
    for (const bid of boardIds) {
      for (const c of this.#doc.componentsOnBoard(bid)) {
        if (this.#hasAnchored(c.id)) anchorIds.add(c.id);
      }
    }
    const view =
      hit.kind === "part"
        ? this.#partViews.get(hit.id)
        : hit.kind === "board"
          ? this.#views.get(hit.id)
          : hit.kind === "lead" && hit.pick.kind === "lead"
            ? this.#partViews.get(hit.pick.id)
            : this.#wireLayer;
    if (!view?.element) return false;
    this.#mode = {
      kind: "drag-cluster",
      hit,
      grab,
      members,
      byId: new Map(members.map((m) => [m.id, m])),
      boardIds,
      boardOrigins: boardIds.map((id) => {
        const b = this.#doc.getBoard(id);
        return { id, ox: b.x, oy: b.y };
      }),
      wires,
      riding: riding.length > 0 ? riding : null,
      ridingParts: legs.length > 0 ? legs : null,
      ridingFlags: ridersOf.flags.length > 0 ? ridersOf.flags : null,
      // The flags and tags PLANTED on a moving strip: their addresses ride it
      // for nothing, but their drawing has to be told (#applyBoardShift).
      stripFlags: this.#flagsOnBoards(boardIds),
      // What a picked lead keeps its address on — anything moving by itself
      // (cluster-move.js leadShift); null when no lead is picked.
      leadMoving:
        sets.leads.length > 0 ? new Set([...boardIds, ...memberIds]) : null,
      // Every part the batch check re-seats (members and riding legs).
      movers: new Set([...partIds, ...legs.map((r) => r.id)]),
      checkBatch: this.#doc.prepareClusterMove({
        componentIds: [...partIds, ...legs.map((r) => r.id)],
        wireIds: [...riding.map((r) => r.wireId), ...wireIds],
        flags: ridersOf.flags,
      }),
      // The routed bends the moving strips and bricks carry — every bend of a
      // wire whose two ends both ride them, and over a moving strip the bends
      // of one stretched off it — read once, as everything else is
      // (DeskDoc.wirePointsOverBoards). A selected wire moves its own bends.
      ridingPoints:
        boardIds.length > 0 || memberIds.size > 0
          ? this.#doc.wirePointsOverBoards(boardIds, {
              owners: memberIds,
              exclude: wireSet,
            })
          : new Map(),
      anchorIds,
      plan: null,
      targets: [],
      wireMoves: [],
      delta: { dx: 0, dy: 0 },
      // Read NOW: pointer capture retargets every later event to the grabbed
      // element, so a switch-bank click resolved at pointerup would always see
      // the body, never an actuator.
      switchIndex: switchIndexFromEvent(e),
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startWorld: world,
      lastWorld: world,
      legal: true,
      active: false,
      teardown: null,
    };
    // The strips light up on mouse-down, before any travel, so it is clear
    // what is about to move (and what is about to be left behind).
    for (const id of boardIds) this.#views.get(id)?.setDragSet(true);
    this.#sel.refreshBoardOutline();
    this.#viewport.classList.add("desk-viewport--dragging");
    this.#mode.teardown = beginPointerGesture(view.element, e.pointerId, {
      onMove: this.#onGroupPointerMove,
      onEnd: this.#onGroupPointerUp,
    });
    return true;
  }

  /** The member of bus `busId` whose wire end is nearest `world`. */
  #nearestBusMember(busId, world) {
    let best = null;
    for (const id of this.#doc.getBus(busId)?.members ?? []) {
      const p = this.#nearestWireEnd(id, world);
      const dist = p ? Math.hypot(world.x - p.x, world.y - p.y) : Infinity;
      if (!best || dist < best.dist) best = { id, dist };
    }
    return best?.id ?? null;
  }

  /** The world point of `wireId`'s end nearest `world`, or null. */
  #nearestWireEnd(wireId, world) {
    const wire = this.#doc.getWire(wireId);
    const ends = [wire?.from, wire?.to]
      .map((address) => this.#addressWorld(address))
      .filter(Boolean);
    let best = null;
    for (const p of ends) {
      if (!best || Math.hypot(world.x - p.x, world.y - p.y) < Math.hypot(world.x - best.x, world.y - best.y)) best = p; // prettier-ignore
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  /**
   * Where the whole selection lands for a pointer at `world`, writing
   * d.delta / d.targets / d.plan / d.wireMoves / d.legal. Shared by the live
   * drag and the release, so the preview and the drop can never disagree.
   *
   * ONE `legal` for the lot, deliberately — the drop is ATOMIC: every moving
   * part, every moved or stretched wire end and every moving strip must land
   * where it may (the holes the movers vacate count as open), or nothing
   * moves and the whole selection springs back. A drop that seated some of it
   * and left the rest would be a silent edit of the arrangement the user
   * built. Re-mating a dragged board is the same check: the magnetic pull is
   * only taken when it is legal.
   *
   * A delta of null (the grab is over bare desk) KEEPS the last good one, as
   * #resolvePartSeat keeps its last good seat: the group carries on drawing
   * somewhere sane while the drop reddens.
   */
  #resolveGroupMove(d, world) {
    const boards = this.#doc.boards;
    const travel = {
      dx: world.x - d.startWorld.x,
      dy: world.y - d.startWorld.y,
    };
    let delta = null;
    if (d.grab.kind === "member") {
      delta = clusterDelta(boards, d.grab, world, d.members);
    } else if (d.grab.kind === "board") {
      delta = this.#pullToMate(d.boardIds, {
        dx: Math.round(travel.dx),
        dy: Math.round(travel.dy),
      });
    } else {
      // The reference wire end rides the travel and snaps to the hole it
      // lands on — tried at the raw travel first, for the reason clusterDelta
      // does (the vertical lattice is measured, not whole).
      const p = d.grab.refWorld;
      const hole =
        holeAtWorld(boards, p.x + travel.dx, p.y + travel.dy) ??
        holeAtWorld(
          boards,
          p.x + Math.round(travel.dx),
          p.y + Math.round(travel.dy),
        );
      delta = hole ? { dx: hole.x - p.x, dy: hole.y - p.y } : null;
    }
    if (delta) d.delta = delta;
    const moving = new Set(d.boardIds);
    const { targets, resolved } =
      d.members.length > 0
        ? this.#doc.resolveClusterTargets(d.members, d.delta)
        : { targets: [], resolved: true };
    d.targets = targets;
    // A part carried onto a strip that is itself moving would land in a hole
    // that is about to leave — refused rather than guessed at.
    const ontoMoving = targets.some((t) => t.board != null && moving.has(t.board)); // prettier-ignore
    // The picked leads ride the delta itself (re-made per sample, as the
    // delta is); everything else follows its member.
    const presetShifts = d.leadMoving
      ? new Map([
          [LEAD_WIRE_END, this.#doc.leadShift(d.delta, d.leadMoving)],
          [
            LEAD_LEG,
            this.#doc.leadShift(d.delta, d.leadMoving, { holesOnly: true }),
          ],
        ])
      : null;
    const shift = this.#groupBoardShift(d);
    d.boardShift = shift ? { ids: new Set(d.boardIds), ...shift } : null;
    d.plan =
      d.riding || d.ridingParts || d.ridingFlags
        ? this.#doc.planClusterRiders(
            d.members,
            targets,
            d.riding,
            d.ridingParts,
            presetShifts,
            { ridingFlags: d.ridingFlags, boardShift: d.boardShift },
          )
        : null;
    d.wireMoves = this.#groupWireMoves(d);
    // The strips and the bricks travel TOGETHER: each is judged against the
    // other's landing, not where it stands now — or a circuit dragged whole
    // with its PSU beside a board was refused for the PSU landing where the
    // board used to be.
    const brickTargets = new Map(
      d.targets
        .filter((t) => t.form === "brick")
        .map((t) => [t.id, { x: t.x, y: t.y }]),
    );
    const boardsOk =
      d.boardIds.length === 0 ||
      (shift != null &&
        this.#doc.canMoveBoardsBy(d.boardIds, shift.dx, shift.dy, {
          brickTargets,
          movers: d.movers,
        }));
    d.legal =
      Boolean(delta) &&
      resolved &&
      !ontoMoving &&
      (d.plan?.resolved ?? true) &&
      d.wireMoves != null &&
      boardsOk &&
      d.checkBatch(
        this.#clusterPlacements(d),
        [...(d.plan?.moves ?? []), ...d.wireMoves],
        d.boardShift,
        d.plan?.flags ?? [],
      );
  }

  /** The strips' share of the delta — whole pitches across, the 0.01 grid
      down — or null when the delta is off that lattice (the selection's parts
      and its boards then share no rigid move). */
  #groupBoardShift(d) {
    if (d.boardIds.length === 0) return null;
    const dx = Math.round(d.delta.dx);
    const dy = Math.round(d.delta.dy * 100) / 100;
    if (Math.abs(dx - d.delta.dx) > 1e-6 || Math.abs(dy - d.delta.dy) > 1e-6) {
      return null;
    }
    return { dx, dy };
  }

  /** Each selected wire's `{id, from, to}` under the delta: an end plugged
      into something that moves by itself keeps its address (it rides); every
      other end is translated to whatever point it lands on. Null when an end
      lands on nothing. */
  #groupWireMoves(d) {
    const { dx, dy } = d.delta;
    // An end landing ON something that is itself moving — a moving strip's
    // hole, a moving brick's terminal — is refused, as a member landing on a
    // moving strip is: that point is about to leave, and the wire would ride
    // it a second delta away from where it was dropped.
    const moving = new Set([...d.boardIds, ...d.members.map((m) => m.id)]);
    const at = (p) => {
      const address =
        connectionPointAt(this.#doc.boards, this.#doc.components, {
          x: p.x + dx,
          y: p.y + dy,
        })?.address ?? null;
      return address && !moving.has(parseAddress(address)?.boardId)
        ? address
        : null;
    };
    const moves = [];
    for (const w of d.wires) {
      const from = w.keepFrom ? w.from : at(w.fromWorld);
      const to = w.keepTo ? w.to : at(w.toWorld);
      if (!from || !to) return null;
      moves.push({ id: w.id, from, to });
    }
    return moves;
  }

  /** The bends of the selected wires, translated whole with them — a
      selected wire moves rigidly, so every bend comes along (the strips'
      carried set leaves them out, so none is shifted twice). */
  #groupWirePoints(d) {
    return d.wires
      .filter((w) => w.hasPoints)
      .map((w) => ({ id: w.id, dx: d.delta.dx, dy: d.delta.dy }));
  }

  /** Everything the cluster's commit moves, in the order `prepareClusterMove`
      was prepared with: the members, then the parts riding them. */
  #clusterPlacements(d) {
    return [...d.targets, ...(d.plan?.parts ?? [])];
  }

  /** The wire layer's riding-wire preview for a part or cluster drag in
      flight, or null for a plain one. Every riding wire gets an entry — one with no addresses when the plan
      didn't resolve, so a refused drop tints the wires it would have carried
      rather than leaving them looking uninvolved. */
  #ridingWirePreview(d) {
    const own = d.wires ?? []; // a group drag's selected wires
    if (!d.riding && own.length === 0) return null;
    const shifts = new Map();
    for (const { wireId } of d.riding ?? []) shifts.set(wireId, {});
    for (const { id } of own) shifts.set(id, {});
    for (const move of [...(d.plan?.moves ?? []), ...(d.wireMoves ?? [])]) {
      const entry = shifts.get(move.id);
      if (entry) {
        entry.from = move.from;
        entry.to = move.to;
      }
    }
    const points = [...(d.plan?.points ?? [])];
    if (d.wireMoves) points.push(...this.#groupWirePoints(d));
    for (const { id, dx, dy } of points) {
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
    // The TRAVEL is whole pitches; a brick already on a fractional row
    // (recentred with its desk) keeps that fraction.
    d.pos = {
      x: Math.round(d.origin.x + (world.x - d.startWorld.x)),
      y: Math.round((d.origin.y + Math.round(world.y - d.startWorld.y)) * 100) / 100, // prettier-ignore
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
    const seat = this.#partSeatAt(world, d.ref, d.grabOffsetCols, d.params, {
      grabDy: d.grabDy ?? 0,
    });
    const riding = Boolean(d.riding || d.ridingParts || d.ridingFlags);
    if (seat) {
      d.seat = seat;
      // With riders the BATCH check below is the whole verdict: it seats the
      // part against the document with every mover lifted out, riders
      // included. Asked alone, the part would still see a rider in the hole it
      // is about to leave — and a 600-mil chip re-seating at its true width
      // covers rows e–g, where a rider of its narrow seat may be standing until
      // the plan carries it out from under the body.
      d.legal =
        riding ||
        this.#doc.canPlacePart(d.ref, seat.board, seat.anchor, {
          ignoreId: d.id,
          params: this.#seatedParams(d.ref, d.params, seat),
          occupancy: (d.occupancy ??= this.#doc.occupancyIndex()), // one a gesture
        });
    } else {
      d.legal = false; // off-board / off-row: stay at the last seat
    }
    // A part carrying wiring re-plans its riders for THIS seat and checks the whole
    // batch as one. They ride the same `d.legal` the part's own tint reads, so
    // an unseatable wire (or a resistor leg with nowhere to bend to) reddens the
    // drop exactly as an unseatable pin does — one refusal, one visual language.
    // Planned against `d.seat` even when the pointer fell off-board, so the
    // riders keep drawing where the part does.
    if (riding) {
      const params = this.#seatedParams(d.ref, d.params, d.seat);
      d.plan = this.#doc.planPartMove(d.id, {
        board: d.seat.board,
        anchor: d.seat.anchor,
        params,
        riding: d.riding,
        ridingParts: d.ridingParts,
        ridingFlags: d.ridingFlags,
      });
      const placements = [
        { id: d.id, board: d.seat.board, anchor: d.seat.anchor, params },
        ...d.plan.parts,
      ];
      if (!(
        d.plan.resolved &&
        d.checkBatch(placements, d.plan.moves, null, d.plan.flags)
      )) {
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

  /** Every signal flag and Output/Input/Data tag planted on one of `boardIds`,
      with where it is drawn now and its turn — null when there is none. */
  #flagsOnBoards(boardIds) {
    if (boardIds.length === 0) return null;
    const moving = new Set(boardIds);
    const on = (anchor) =>
      typeof anchor === "string" && moving.has(parseAddress(anchor)?.boardId);
    const out = [];
    for (const sig of this.#doc.signals) {
      if (!on(sig.flag?.anchor)) continue;
      const at = this.#addressWorld(sig.flag.anchor);
      if (at) out.push({ kind: "signal", id: sig.id, at, rot: sig.flag.rot ?? 0 }); // prettier-ignore
    }
    for (const el of this.#doc.integrations) {
      for (const [key, tag] of Object.entries(el.tags ?? {})) {
        if (!on(tag?.anchor)) continue;
        const at = this.#addressWorld(tag.anchor);
        if (at) out.push({ kind: "tag", id: el.id, key, at, rot: tag.rot ?? 0 }); // prettier-ignore
      }
    }
    return out.length > 0 ? out : null;
  }

  /** Draw every planted flag and Output/Input tag riding a drag where the plan
      lands it, tinted on the one verdict — or, where the plan placed none
      (refused, or no plan this sample), where the DOCUMENT has it, as for a
      riding leg. */
  #applyFlagRiders(d) {
    const landed = new Map(
      (d.plan?.flags ?? []).map((f) => [
        `${f.kind}|${f.id}|${f.key}`,
        f.anchor,
      ]),
    );
    for (const f of d.ridingFlags ?? []) {
      const anchor = landed.get(`${f.kind}|${f.id}|${f.key}`) ?? f.address;
      const at = this.#addressWorld(anchor);
      if (!at) continue;
      if (f.kind === "tag") {
        const rot = this.#doc.getIntegration(f.id)?.tags?.[f.key]?.rot ?? 0;
        this.#integrationLayer.setPreview(f.id, f.key, { at, rot, illegal: !d.legal }); // prettier-ignore
      } else {
        const rot = this.#doc.getSignal(f.id)?.flag?.rot ?? 0;
        this.#signalLayer.setPreview(f.id, { at, rot, illegal: !d.legal });
      }
    }
  }

  /** Put every riding flag back where the DOCUMENT has it — after a refused
      drop, and after a committed one (which the document now says). */
  #restoreFlagRiders(d) {
    for (const f of [...(d.ridingFlags ?? []), ...(d.stripFlags ?? [])]) {
      if (f.kind === "tag") this.#integrationLayer.clearPreview(f.id, f.key);
      else this.#signalLayer.clearPreview(f.id);
    }
  }

  #onPartPointerMove = (e) => {
    const d = this.#mode;
    if (!PART_DRAG_KINDS.has(d?.kind) || e.pointerId !== d.pointerId) {
      return;
    }
    if (!d.active) {
      const travel = Math.hypot(
        e.clientX - d.startClientX,
        e.clientY - d.startClientY,
      );
      if (travel < DRAG_THRESHOLD) return;
      d.active = true;
      this.#partViews.get(d.id)?.setDragging(true);
    }
    const view = this.#partViews.get(d.id);
    const w = this.#deskView.worldFromEvent(e);
    // Recorded for every kind — it is the fallback the release-point resolve
    // falls back to when the "release" is a positionless synthetic abort.
    d.lastWorld = w;

    if (d.kind === "drag-resistor") {
      this.#trackResistorDrag();
      return;
    }
    if (d.kind === "drag-resistor-end") {
      this.#trackResistorEndDrag();
      return;
    }
    if (d.kind === "drag-leg") {
      this.#trackLegDrag();
      return;
    }

    if (d.kind === "drag-brick") {
      this.#resolveBrickPos(d, w);
      view?.setPosition(d.pos.x, d.pos.y);
      view?.setIllegal(!d.legal);
      // Wires on this PSU's terminals follow it live, and a meter's leads.
      this.#wireLayer.render(new Map([[d.id, d.pos]]));
      this.#probeLayer?.render(new Map([[d.id, d.pos]]));
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
    if (seat) {
      view?.updatePlacement(
        this.#doc.getBoard(seat.board),
        seat.anchor,
        this.#dragParams(d),
      );
    }
    view?.setIllegal(!d.legal);
    // The wires riding it follow live (a part with none never touches the layer).
    if (d.riding) this.#wireLayer.setPartDrag(this.#ridingWirePreview(d));
    // …and so do the legs of the parts attached to it, and its flags.
    if (d.ridingParts) this.#applyLeadRiders(d);
    if (d.ridingFlags) this.#applyFlagRiders(d);
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

  /** After a part was reshaped from `before` (the component as it was): carry
      the labels anchored to it by the travel of its pins' middle — what a
      chip drag and a group drag already did by the anchor (a rigid move, so
      the same delta), and a lead, leg, two-lead body or turn left behind. The
      middle, not pin 1: a lead dragged alone moves the body half as far, and
      a can spun about its centre or a bent TO-92 turned end for end moves
      pin 1 without moving the part at all. */
  #carryAnchoredLabels(id, before) {
    const now = this.#doc.getComponent(id);
    if (!now || !this.#hasAnchored(id)) return;
    const from = this.#pinsMiddle(before);
    const to = this.#pinsMiddle(now);
    const shift =
      from && to
        ? { dx: to.x - from.x, dy: to.y - from.y }
        : this.#anchorDelta(before, now);
    if (shift && (shift.dx || shift.dy)) {
      this.#shiftAnchoredAnnotations(id, shift.dx, shift.dy);
    }
  }

  /** The mean of a seated part's pin positions, or null. */
  #pinsMiddle(comp) {
    const pins = comp?.ref ? partPinsWorld(this.#doc.boards, comp) : null;
    if (!pins?.length) return null;
    const sum = pins.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), {
      x: 0,
      y: 0,
    });
    return { x: sum.x / pins.length, y: sum.y / pins.length };
  }

  #onPartPointerUp = (e) => {
    const d = this.#mode;
    if (!PART_DRAG_KINDS.has(d?.kind) || e.pointerId !== d.pointerId) {
      return;
    }
    // Read before the teardown's DOM writes, as the group drop's is.
    const releaseAt = d.legal ? null : releaseWorld(this.#deskView, e, d.lastWorld); // prettier-ignore
    this.#mode = null;
    this.#viewport.classList.remove("desk-viewport--dragging");
    aimRing(this.#ring, null); // a lead drag's target marker, on every exit

    d.teardown?.();
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
    this.#restoreFlagRiders(d); // …and the riding flags' previews

    // A drag that spans Run (editing locked mid-gesture) reverts, never
    // commits — the teardown above already ran, so this only skips the mutation.
    // The multimeter is the exception: it is moved about a running bench.
    const meterMove = d.kind === "drag-brick" && d.ref === "meter";
    const cancelled = e.type === "pointercancel" || (this.#editingLocked && !meterMove); // prettier-ignore

    if (d.kind === "drag-resistor-end") {
      if (!d.active) return; // plain click — the press already selected it
      // The drop is the seat the last move SHOWED, ringed — never re-resolved
      // at the release point (see the wire end's #onEndpointUp). No ring, or
      // a red one, left d.legal false, and the lead springs back. A lead put
      // back in its own hole is no move: nothing written, no undo step.
      const moved =
        d.target &&
        Math.hypot(d.target.at.x - d.from.x, d.target.at.y - d.from.y) > 1e-6;
      if (!cancelled && d.legal && moved) {
        this.#doc.movePartEnds(
          d.id,
          d.target.boardId,
          d.target.anchor,
          d.target.end,
        );
        this.#carryAnchoredLabels(d.id, { ref: d.ref, ...d.origin });
        this.#emitDocChanged("move part");
      }
      // Redraw from the document — an illegal drop wrote nothing, so the lead
      // springs back to where it was — and the picked lead's ring with it.
      this.#remountPart(d.id);
      this.#sel.refreshLeadRing();
      this.#refreshPinMode();
      return;
    }

    if (d.kind === "drag-leg") {
      if (!d.active) return; // plain click — the press already picked the leg
      // The drop is the seat the last move SHOWED, ringed — never re-resolved
      // at the release point, as for every single-point drag.
      const was = this.#doc.getComponent(d.id);
      const moved =
        d.seat &&
        (d.seat.board !== was?.board ||
          d.seat.anchor !== was?.anchor ||
          JSON.stringify(d.seat.params) !== JSON.stringify(was?.params));
      if (!cancelled && d.legal && moved) {
        this.#doc.moveClusterWithWires([d.seat], { moves: [] });
        this.#carryAnchoredLabels(d.id, was);
        this.#emitDocChanged("move part");
      }
      this.#remountPart(d.id);
      this.#sel.refreshLeadRing();
      this.#refreshPinMode();
      return;
    }

    if (d.kind === "drag-resistor") {
      if (!d.active) return; // plain click — the press already selected it
      // Pin 1 carries the body by the single-point rule, so as with the end
      // drag the drop is the seat the last move SHOWED (the part drawn in it),
      // never re-resolved at the release point — a release out of every
      // hole's reach would throw back a seat the screen had promised.
      const moved =
        d.holes &&
        (d.holes.boardId !== d.origin.board ||
          d.holes.anchor !== d.origin.anchor ||
          d.orient.dx !== d.orient0.dx ||
          d.orient.dy !== d.orient0.dy);
      if (!cancelled && d.legal && moved) {
        // A part carrying wiring commits it AND everything riding it as ONE
        // mutation (the same transaction a footprint part's does); one with
        // nothing attached takes the two-ends path.
        if (d.riding || d.ridingParts || d.ridingFlags) {
          this.#doc.moveClusterWithWires(
            [
              {
                id: d.id,
                board: d.holes.boardId,
                anchor: d.holes.anchor,
                params: { ...d.origin.params, rot: 90, end: d.holes.end },
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
        this.#carryAnchoredLabels(d.id, { ref: d.ref, ...d.origin });
        this.#emitDocChanged("move part");
      } else if (d.hasAnchored) {
        this.#annotationLayer.render(); // the labels snap back with it
      }
      // Commit or not, redraw from the document — an illegal drop leaves the
      // document untouched, so this snaps the resistor back to its origin.
      this.#remountPart(d.id);
      this.#restoreLeadRiders(d);
      return;
    }

    if (d.kind === "drag-brick") {
      if (!d.active) {
        // A click on a meter's title: folded down, or opened out.
        if (d.title && !cancelled) this.#foldMeter(d.id);
        return;
      }
      // The drop is where the last move SHOWED it, legal — reused, never
      // recomputed; only with nothing legal showing does the release point
      // get a say (pointer-gesture.js's releaseWorld).
      if (!cancelled && !d.legal) {
        this.#resolveBrickPos(d, releaseAt);
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
        this.#probeLayer?.render();
        if (d.hasAnchored) this.#annotationLayer.render(); // snap labels back
      }
      return;
    }

    if (!d.active) {
      // An ABORTED press (Escape, a lost capture, a blur, a scene rebuild, Run
      // starting under it) is no click: nothing flips.
      if (cancelled) return;
      // Plain click: a slide switch, toggle button, or DIP switch bank
      // position flips (always interactive).
      const comp = this.#doc.getComponent(d.id);
      if (clickTogglingPart(comp?.ref)) {
        this.#toggleClickPart(d.id, d.switchIndex ?? null);
      }
      return;
    }
    // The drop is the seat the last move SHOWED, when that seat was legal —
    // reused as it stands, never recomputed, so a seat the screen promised is
    // the seat committed (CLAUDE.md → "Selection"). Only when the last sample
    // showed nothing legal — it fell off-board or off-row while KEEPING d.seat
    // at the last good seat — does the release point get a say, through the
    // same resolver: a fast release whose final coalesced move caught the part
    // mid-flight over the trench must not revert a perfectly good reseat.
    if (!cancelled && !d.legal) {
      this.#resolvePartSeat(d, releaseAt);
    }
    // A 600-mil chip dragged from the narrow e/f seat to the wide e/i one
    // keeps its anchor and still moves.
    const moved =
      d.seat.board !== d.origin.board ||
      d.seat.anchor !== d.origin.anchor ||
      (d.seat.wide ?? false) !== (d.origin.wide ?? false);
    // A chip flipped mid-drag commits its half-lap even if it lands back where
    // it started (the footprint maps onto itself, so it's always legal).
    const flipped = !cancelled && d.flip === true;
    if (flipped) this.#doc.rotateComponent(d.id);
    if (!cancelled && d.legal && moved) {
      // A part carrying wiring commits it AND everything riding it as ONE
      // mutation, so ⌘Z restores them together — they were never two edits.
      if (d.riding || d.ridingParts || d.ridingFlags) {
        this.#doc.moveComponentWithWires(
          d.id,
          d.seat.board,
          d.seat.anchor,
          d.plan,
          { wide: d.seat.wide },
        );
      } else {
        this.#doc.moveComponent(d.id, d.seat.board, d.seat.anchor, {
          wide: d.seat.wide,
        });
      }
      view?.updatePlacement(
        this.#doc.getBoard(d.seat.board),
        d.seat.anchor,
        this.#doc.getComponent(d.id)?.params,
      );
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
        this.#doc.getComponent(d.id)?.params,
      );
      this.#restoreLeadRiders(d); // an illegal drop wrote nothing
    }
    // Sync the drawn orientation to the document (undoes a cancelled preview).
    if (d.flip) view?.updateParams(this.#doc.getComponent(d.id)?.params ?? {});
  };

  #onGroupPointerMove = (e) => {
    const d = this.#mode;
    if (d?.kind !== "drag-cluster" || e.pointerId !== d.pointerId) return;
    if (!d.active) {
      const travel = Math.hypot(
        e.clientX - d.startClientX,
        e.clientY - d.startClientY,
      );
      if (travel < DRAG_THRESHOLD) return;
    }
    // Read BEFORE the drag's first frame writes to the DOM: read after, the
    // viewport's rect forced a style and layout pass over the classes just
    // toggled (busy64: ~10 ms of the threshold frame).
    const w = this.#deskView.worldFromEvent(e);
    if (!d.active) {
      d.active = true;
      // The members are lit one by one; the strips fade with their carrier
      // (#beginCarry).
      for (const m of d.members) this.#partViews.get(m.id)?.setDragging(true);
      this.#sel.refreshLeadRing(); // the picked leads' rings stand down
      this.#beginCarry(d);
    }
    // Recorded for the fallback the release resolves from when nothing legal
    // was showing, and for a positionless synthetic abort.
    d.lastWorld = w;
    this.#resolveGroupMove(d, w);
    this.#applyClusterPreview(d);
    if (d.ridingFlags) this.#applyFlagRiders(d);
    // The strips (and their passengers) ride the delta; their overrides and
    // the members' bricks share the one map the wire layer reads.
    const overrides =
      d.boardIds.length > 0 ? this.#applyBoardShift(d, d.delta) : new Map();
    for (const [id, pos] of this.#clusterBrickOverrides(d) ?? []) {
      overrides.set(id, pos);
    }
    this.#wireLayer.setPartDrag(
      this.#ridingWirePreview(d),
      overrides.size > 0 ? overrides : null,
      this.#pointRide(d, d.delta),
    );
    // …and the meters' probes and leads, on what they ride.
    if (overrides.size > 0) this.#probeLayer?.render(overrides);
    // Every label hung on anything moving rides the one delta.
    if (d.anchorIds.size > 0) {
      this.#annotationLayer.render({
        anchorIds: d.anchorIds,
        dx: d.delta.dx,
        dy: d.delta.dy,
      });
    }
  };

  #onGroupPointerUp = (e) => {
    const d = this.#mode;
    if (d?.kind !== "drag-cluster" || e.pointerId !== d.pointerId) return;
    // Where it was let go, read BEFORE the teardown writes to the DOM — read
    // after, the viewport's rect forced a layout of the whole desk (busy64:
    // 80–85 ms on a refused drop). Only a drop with nothing legal shown needs it.
    const releaseAt = d.legal ? null : releaseWorld(this.#deskView, e, d.lastWorld); // prettier-ignore
    this.#mode = null;
    this.#viewport.classList.remove("desk-viewport--dragging");
    d.teardown?.();
    for (const m of d.members) {
      const view = this.#partViews.get(m.id);
      view?.setDragging(false);
      view?.setIllegal(false);
    }
    for (const id of d.boardIds) this.#views.get(id)?.setDragSet(false);
    // Put the wire preview away BEFORE any mutation (a revert is then already
    // drawn; a commit re-renders through #emitDocChanged).
    this.#wireLayer.setPartDrag(null);
    this.#probeLayer?.render();
    this.#restoreFlagRiders(d);

    // A drag that spans Run (editing locked mid-gesture) reverts, never
    // commits — the teardown above already ran, so this only skips the mutation.
    const cancelled = e.type === "pointercancel" || this.#editingLocked;
    if (!d.active) {
      // A click — a drag that didn't travel — puts the selection down on what
      // was pressed: the one object, everything else cancelled. An ABORTED
      // press is no click, and leaves the selection as it was.
      this.#restoreGroupViews(d);
      if (!cancelled) this.#collapseTo(d);
      return;
    }
    // The drop is what the last move SHOWED, when that was legal — reused,
    // never recomputed. Only with nothing legal showing does the release point
    // get a say, through the same resolver.
    if (!cancelled && !d.legal) this.#resolveGroupMove(d, releaseAt);
    const moved = d.delta.dx !== 0 || d.delta.dy !== 0;
    const committed =
      !cancelled && d.legal && moved && this.#commitGroupMove(d);
    this.#restoreGroupViews(d); // the document's own positions, either way
    this.#sel.refreshLeadRing(); // …and the picked leads' rings back on them
    if (committed) {
      this.#emitDocChanged("move selection");
    } else {
      this.#wireLayer.render();
      if (d.anchorIds.size > 0) this.#annotationLayer.render();
    }
  };

  /**
   * Write a group drop — every member and rider, every selected wire, every
   * moving strip — as ONE mutation, so ⌘Z restores the whole arrangement (it
   * was never several edits). Validated as a whole by `moveClusterWithWires`
   * and `canMoveBoardsBy` first; anything thrown puts the document back
   * exactly as it was. Returns whether it wrote.
   */
  #commitGroupMove(d) {
    const before = this.#doc.snapshot();
    try {
      const placements = this.#clusterPlacements(d);
      const moves = [...(d.plan?.moves ?? []), ...d.wireMoves];
      // The carried bends are the ones the preview drew, frozen at the press —
      // never re-read from a document the cluster write has already moved.
      const carried = this.#carriedPoints(d);
      const boards = d.boardIds.length > 0;
      if (placements.length > 0 || moves.length > 0 || d.ridingFlags) {
        this.#doc.moveClusterWithWires(placements, {
          moves,
          points: [...(d.plan?.points ?? []), ...this.#groupWirePoints(d)],
          flags: d.plan?.flags ?? [],
          boardShift: d.boardShift,
          carried: boards ? null : { points: carried, ...d.delta },
        });
      }
      if (boards) {
        const shift = this.#groupBoardShift(d);
        // Moving only part of a group tears the snap — desk-doc re-derives
        // the groups on both sides of the break.
        this.#doc.moveBoardsBy(d.boardIds, shift.dx, shift.dy, { carried });
        // Landing flush against a strip it dovetails with mates the two, as
        // dropping the real parts side by side does.
        this.#mateStrips(d.boardIds);
      }
      if (d.anchorIds.size > 0) {
        this.#shiftAnchoredAnnotations(d.anchorIds, d.delta.dx, d.delta.dy);
      }
      return true;
    } catch (err) {
      console.error("[renderer] a group move was refused:", err);
      this.#doc.restore(before);
      return false;
    }
  }

  /** Redraw everything a group drag moved from the DOCUMENT — the snap-back
      after a refused drop, and the settle after a committed one. */
  #restoreGroupViews(d) {
    this.#endCarry(d);
    this.#restoreClusterViews(d);
    if (d.boardIds.length > 0) {
      const moving = new Set(d.boardIds);
      for (const board of this.#doc.boards) {
        if (moving.has(board.id)) {
          this.#views.get(board.id)?.setPosition(board.x, board.y);
        }
      }
      this.#repositionPartsOn(d.boardIds);
    }
    this.#sel.refreshBoardOutline();
  }

  /** A group press that never travelled: the selection becomes what was
      pressed (a switch under the finger still flips). A pressed strip keeps
      the selected strips of its own group — a board is one thing to the hand. */
  #collapseTo(d) {
    const { hit } = d;
    if (hit.kind === "part") {
      this.selectComponent(hit.id);
      const comp = this.#doc.getComponent(hit.id);
      if (clickTogglingPart(comp?.ref)) {
        this.#toggleClickPart(hit.id, d.switchIndex ?? null);
      }
    } else if (hit.kind === "wire") {
      this.selectWire(hit.id);
    } else if (hit.kind === "bus") {
      this.selectBus(hit.id);
    } else if (hit.kind === "lead") {
      if (hit.pick.kind === "lead")
        this.#sel.selectLead(hit.pick.id, hit.pick.end); // prettier-ignore
      else this.#sel.selectWireEnd(hit.pick.id, hit.pick.end);
    } else if (hit.kind === "board") {
      const group = new Set(this.#doc.groupMembers(hit.id).map((b) => b.id));
      const keep = d.boardIds.filter((id) => group.has(id));
      // The whole snapped group is what a single board pick stands for.
      if (keep.length === Math.max(group.size, 1)) this.selectBoard(hit.id);
      else this.#sel.setMulti([], [], keep.length > 0 ? keep : [hit.id]);
    }
    this.#recordSelection();
  }

  /** Every part's context menu is the SAME three items, always, in this
      order — no more per-kind branching: a picker (PSU volts, clock/
      oscillator rate, LCD colour, ROM programming…) is a Properties-dialog
      field now, never a menu item of its own (see #propertyFieldsFor). The
      exceptions are the parts with a WINDOW of their own — a custom chip's
      designer, a CPU's monitor, a memory chip's inspector — which open from
      a group of their own below Properties…. Properties… is always enabled — every part has at
      least Name/Description. Items that don't currently apply otherwise stay
      PRESENT but `disabled`, so the menu's shape never changes, only its
      enabled state. */
  #onPartContextMenu(id, e) {
    e.preventDefault();
    if (this.#probe.armed) return; // right-click names the net (viewport handler)
    if (this.#mode) return;
    const comp = this.#doc.getComponent(id);
    if (comp?.kind === "meter") {
      // The bench's instrument, not the circuit: its Properties and Put
      // Away (allowed while running, as taking it out is), never selected.
      e.stopPropagation();
      PopupManager.menu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: t("desk.menu.properties"), onSelect: () => this.#onOpenProperties(id) }, // prettier-ignore
          { separator: true },
          { label: t("desk.menu.putMeterAway"), onSelect: () => this.putMeterAway(id) }, // prettier-ignore
        ],
      });
      return;
    }
    this.selectComponent(id);
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
      ...(def?.custom ? this.#customChipMenuItems(id) : []),
      ...(isCpu(def) ? this.#cpuMenuItems(id) : []),
      ...(comp?.kind === "chip" && isMemory(def)
        ? this.#memoryMenuItems(id)
        : []),
      ...this.#floatMenuItems(comp),
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

  /**
   * A CUSTOM chip's own group in its menu — the designer, and the debugger
   * bar's Break-on-Settled toggle mirrored (the chip designer spec asks for
   * both places; a breakpoint on a LINE is set on its line, in the code). The
   * one deliberate exception to the menu's one shape: a part the user wrote
   * the behaviour of is the only kind there is anything to debug in.
   */
  #customChipMenuItems(id) {
    const armed = this.#chipDebug?.armedOf(id) ?? {
      lines: false,
      settled: false,
    };
    return [
      { separator: true },
      {
        label: t("desk.menu.openChipDesigner"),
        onSelect: () => this.#onOpenChipDesigner?.(id),
      },
      {
        label: t("desk.menu.breakOnSettled"),
        checked: armed.settled,
        disabled: !this.#chipDebug,
        onSelect: () => this.#chipDebug?.toggleArmed(id, "settled"),
      },
    ];
  }

  /**
   * A CPU's own group in its menu: the CPU monitor. The second exception to
   * the menu's one shape, for the same reason as a custom chip's — a CPU is
   * the one built-in part with a program running inside it to watch.
   */
  #cpuMenuItems(id) {
    return [
      { separator: true },
      {
        label: t("desk.menu.openCpuMonitor"),
        onSelect: () => this.#onOpenCpuMonitor?.(id),
      },
    ];
  }

  /**
   * A memory chip's own group in its menu: the inspector — a window of its
   * own, opened from the top level of the menu as the CPU monitor and the
   * chip designer are.
   */
  #memoryMenuItems(id) {
    return [
      { separator: true },
      {
        label: t("desk.menu.inspectMemory"),
        onSelect: () => this.#onOpenMemory?.(id),
      },
    ];
  }

  /**
   * A part with a slider that floats (a potentiometer's Position) gets its
   * opener at the top level too, as the parts with a window of their own do:
   * at run time, turning the knob is the one thing wanted, and the slider's
   * card is one click away instead of through Properties….
   */
  #floatMenuItems(comp) {
    const fields = this.#floatableFields(comp);
    if (!fields.length) return [];
    return [
      { separator: true },
      ...fields.map((field) => ({
        label: t("desk.menu.floatSlider", { field: fieldLabel(field) }),
        onSelect: () => this.#floats.open(comp.id, field.key),
      })),
    ];
  }

  /** The debugger's state on the board: badges and pulses (custom chips). */
  #applyChipDebug(state) {
    const armed = new Map(state?.armed ?? []);
    const paused = new Set(state?.pausedChips ?? []);
    for (const [id, view] of this.#partViews) {
      view.setDebug?.({
        armed: Boolean(armed.get(id)?.lines || armed.get(id)?.settled),
        paused: paused.has(id),
      });
    }
    this.#lastChipDebug = state;
  }

  // ── Annotation gestures (labels & notes, Feature 120) ───────────────────

  #onAnnotationPointerDown(id, e) {
    if (e.button !== 0) return;
    // Option/Alt is pin-targeting mode, where a label is inert: the press goes
    // on to the viewport, which looks for a lead under it.
    if (e.altKey) return;
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
    // A click is a selection step like any other (CLAUDE.md → "Selection"):
    // unrecorded, the history's selection went stale and the next click on
    // the part selected before compared equal to it and was skipped.
    this.#recordSelection();
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

  // ── Signal gestures (external signals, Feature 370) ─────────────────────

  /**
   * Grab a flag. TWO entry points reach the ONE `drag-signal-flag`: the rail's
   * unplaced chip (`origin` null) and a planted polygon (`origin` its flag).
   * They are the same gesture because "drag it onto a board" and "move it to
   * another hole" are the same act, and one gesture means one resolver and one
   * commit. The rail chip is not a coordinate-space problem: `worldFromEvent`
   * reads client coordinates off any event at all.
   */
  beginSignalFlagDrag(id, e) {
    this.#onSignalPointerDown(id, e, { fromRail: true });
  }

  #onSignalPointerDown(id, e, { fromRail = false } = {}) {
    if (e.button !== 0) return;
    // A planted flag is inert in Option/Alt's pin-targeting mode (the press
    // goes on to the viewport); one dragged off the rail is not on the desk.
    if (e.altKey && !fromRail) return;
    if (this.#mode || this.#probe.armed || this.#editingLocked) return;
    // A signal is none of the three multi sets, so the additive chord leaves
    // the selection alone — the annotation rule, verbatim.
    if (isToggleSelectEvent(e, IS_MAC)) {
      e.stopPropagation();
      return;
    }
    const sig = this.#doc.getSignal(id);
    if (!sig) return;
    e.stopPropagation();
    this.#hideHover();
    this.selectSignal(id);
    this.#recordSelection(); // a click is a selection step
    const start = this.#deskView.worldFromEvent(e);
    const elem = fromRail ? this.#viewport : e.currentTarget;
    this.#mode = {
      kind: "drag-signal-flag",
      id,
      elem,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      lastWorld: start,
      origin: sig.flag ? { ...sig.flag } : null,
      rot: sig.flag?.rot ?? 0,
      // A drag off the rail has nothing on the desk yet, so it must show the
      // ghost from the very first sample rather than after the 4 px threshold.
      active: fromRail,
      // …but only a press that TRAVELLED is a drop: a click on the rail's
      // chip planted the flag in whatever hole lay under it (the regrade,
      // 2026-10-23).
      moved: false,
      address: null,
      holeFree: false,
      inReach: false,
      refused: false,
      at: null,
      teardown: null,
    };
    this.#viewport.classList.add("desk-viewport--dragging");
    this.#mode.teardown = beginPointerGesture(elem, e.pointerId, {
      onMove: this.#onSignalPointerMove,
      onEnd: this.#onSignalPointerUp,
    });
    if (fromRail) this.#resolveSignalFlag(this.#mode, start);
  }

  /**
   * Where the flag would land: the live drag's answer, which the release
   * commits as it stands.
   *
   * The apex snaps to the NEAREST free hole in reach (the wire end's rule, and
   * its ring), so a near-miss beside a taken hole lands one hole along rather
   * than being thrown back. With no free hole in reach the drop is one of two
   * things, and the difference is the whole reason they are not one "not a
   * valid target" case: aimed at a board (some hole in reach, all taken) it is
   * a MISS, which changes nothing; clear of every hole it is BARE DESK, which
   * is the UNPLUG.
   */
  #resolveSignalFlag(d, world) {
    const { point, inReach } = nearestLegalPoint(
      this.#doc.boards,
      null,
      world,
      (p) => this.#doc.canPlaceSignalFlag(d.id, p.address),
    );
    d.address = point?.address ?? null;
    d.holeFree = Boolean(point);
    d.inReach = inReach;
    // THE FLAG NEVER LEAVES THE CURSOR. It snaps to a hole it can actually
    // have, and rides the raw pointer everywhere else — so moving off a target
    // no longer flings it back to where the drag started. A drop is the only
    // thing that reverts anything.
    d.at = point ? { x: point.x, y: point.y } : world;
    // Red exactly when a drop HERE would achieve nothing: a board with no free
    // hole in reach, or bare desk with no planted flag to pull out. Bare desk
    // under a PLANTED flag is deliberately not red — dropping there unplugs it,
    // which is a real action and the only way to put one back on the rail.
    d.refused = inReach ? !point : !d.origin;
    // The ring marks the hole it lands in — or, on a miss, the taken hole
    // under the cursor, in red.
    const under = point || !inReach ? null : this.#holeAtWorld(world);
    aimRing(this.#ring, point ?? under, Boolean(point));
    this.#signalLayer.setPreview(d.id, {
      at: d.at,
      rot: d.rot,
      illegal: d.refused,
    });
  }

  #onSignalPointerMove = (e) => {
    const d = this.#mode;
    if (d?.kind !== "drag-signal-flag" || e.pointerId !== d.pointerId) return;
    if (!d.moved) {
      const travel = Math.hypot(
        e.clientX - d.startClientX,
        e.clientY - d.startClientY,
      );
      if (travel >= DRAG_THRESHOLD) d.moved = true;
      else if (!d.active) return;
      d.active = true;
    }
    const w = this.#deskView.worldFromEvent(e);
    d.lastWorld = w;
    this.#resolveSignalFlag(d, w);
  };

  #onSignalPointerUp = (e) => {
    const d = this.#mode;
    if (d?.kind !== "drag-signal-flag" || e.pointerId !== d.pointerId) return;
    this.#mode = null;
    this.#viewport.classList.remove("desk-viewport--dragging");
    d.teardown?.();
    aimRing(this.#ring, null);
    if (!d.active || !d.moved) {
      this.#signalLayer.clearPreview(d.id); // plain click — the press selected it
      return;
    }
    // A drag that spans Run reverts, never commits.
    const cancelled = e.type === "pointercancel" || this.#editingLocked;
    // The drop is what the last move SHOWED — never re-resolved at the release
    // point (see the wire end's #onEndpointUp): the ringed hole plants it; a
    // red ring (a miss) reverts; bare desk with no ring is the unplug the
    // flag was already previewing.
    if (cancelled) {
      this.#signalLayer.clearPreview(d.id);
      return;
    }
    try {
      if (d.address && d.holeFree) {
        const same = d.origin?.anchor === d.address && d.origin?.rot === d.rot;
        if (same) {
          this.#signalLayer.clearPreview(d.id);
          return;
        }
        this.#doc.plantSignalFlag(d.id, d.address, d.rot);
        this.#emitDocChanged("connect signal");
      } else if (!d.inReach && d.origin) {
        // Dropped clear of every hole: the UNPLUG — the same act as the menu's
        // Remove Signal.
        this.unplugSignal(d.id);
      } else {
        this.#signalLayer.clearPreview(d.id); // a miss changes nothing
      }
    } catch {
      this.#signalLayer.clearPreview(d.id);
    }
  };

  // ── Multimeters (catalog/meter.js) ──────────────────────────────────────
  // A meter is worked by hand while it runs — its dial, its buttons, its
  // plug, its probes — as the analyzer is: these are the bench's
  // instruments, not the circuit, so they are the deliberate exception to
  // "a drag that spans Run reverts". A dial turn, a SELECT, a plug or a probe
  // moved is an edit (an undo step) the running circuit takes as it takes a
  // switch thrown; RANGE and HOLD are the display's own (meter-view.js).

  /** How many multimeters the desk has out (the toolbar segment offers
      another while it is under `MAX_METERS`). */
  get meterCount() {
    return this.#doc.components.filter((c) => c.kind === "meter").length;
  }

  /**
   * The toolbar's multimeter: take another one out, up to `MAX_METERS` — at
   * full size, at the right of the view (`meterSpot`), left of any meter
   * already there, floating over whatever is there, its probes lying beside
   * it. An edit like any other (one undo step), and allowed while the
   * circuit runs: a meter is the bench's, taken out to a live circuit.
   * Returns the new meter's id, or null at the limit.
   */
  addMeter() {
    const out = this.#doc.components.filter((c) => c.kind === "meter");
    if (out.length >= MAX_METERS) return null;
    const rect = this.#viewport.getBoundingClientRect();
    const { cx, cy, zoom } = this.#deskView.camera;
    const k = PX_PER_UNIT * zoom;
    const view = { x: cx - rect.width / 2 / k, y: cy - rect.height / 2 / k, width: rect.width / k, height: rect.height / k }; // prettier-ignore
    let right = 0;
    for (const b of this.#doc.boards) {
      const r = boardRect(b);
      right = Math.max(right, r.x + r.width);
    }
    for (const c of this.#doc.components) {
      const size = c.board == null && c.kind !== "meter" ? partDef(c.ref)?.size : null; // prettier-ignore
      if (size) right = Math.max(right, c.x + size.width);
    }
    const at = meterSpot(view, right, out.map(meterRect));
    const meter = this.#doc.addBrick("meter", at.x, at.y, { skin: this.#defaultMeterLook }); // prettier-ignore
    this.#mountPart(meter);
    this.#emitDocChanged("take out meter");
    return meter.id;
  }

  /** Put one multimeter away (its menu's Put Away) — one undo step, allowed
      while the circuit runs, as taking it out is. */
  putMeterAway(id) {
    if (this.#doc.getComponent(id)?.kind !== "meter") return;
    this.#doc.removeComponent(id);
    this.#partViews.get(id)?.remove();
    this.#partViews.delete(id);
    if (this.#sel.single?.id === id) this.#sel.forget();
    this.#hideHover();
    this.#probeLayer?.render();
    this.#emitDocChanged("put meter away");
  }

  /**
   * A press on the multimeter. It is no part of the circuit and no part of
   * the selection: an instrument lying on the desk OVER whatever is under it,
   * so the press goes no further whatever it was for (a tool's click, a band,
   * a pin pick — the meter is in the way). Its front panel is worked by hand;
   * the rest of its body drags it — stopped or running, a tool armed or not
   * (the tool simply gets nothing), never selecting it.
   */
  #onMeterPointerDown(id, e) {
    e.stopPropagation();
    if (e.button !== 0 || this.#probe.armed) return;
    if (this.#onMeterControl(id, e)) return;
    if (this.#mode) return;
    this.#hideHover();
    this.#beginPartDrag(id, e);
    // Its title (the name band, the Volt Hippo's logo with it) drags it like
    // the rest of the body — and a CLICK on it, a press that never travelled,
    // folds it down or opens it out (#onPartPointerUp).
    if (
      this.#mode?.kind === "drag-brick" &&
      e.target?.closest?.("[data-meter-title]")
    ) {
      // prettier-ignore
      this.#mode.title = true;
    }
  }

  /**
   * A press on a meter's front panel: its dial's stops, its buttons, its
   * red jacks. Returns whether it was one (and so is no drag).
   * @param {string} id
   * @param {PointerEvent} e
   */
  #onMeterControl(id, e) {
    const comp = this.#doc.getComponent(id);
    if (comp?.kind !== "meter") return false;
    const target = e.target?.closest?.("[data-meter-position], [data-meter-button], [data-meter-jack]"); // prettier-ignore
    if (!target) return false;
    e.stopPropagation();
    e.preventDefault?.();
    this.#hideHover();
    const view = this.#partViews.get(id);
    const position = target.getAttribute("data-meter-position");
    const button = target.getAttribute("data-meter-button");
    const jack = target.getAttribute("data-meter-jack");
    if (position && position !== comp.params.dial) {
      view?.updateParams(
        this.#doc.setComponentParams(id, { dial: position }).params,
      );
      this.#emitDocChanged("turn meter dial");
    } else if (
      jack &&
      RED_JACKS.includes(jack) &&
      jack !== (comp.params.jack ?? "v")
    ) {
      // prettier-ignore
      view?.updateParams(this.#doc.setComponentParams(id, { jack }).params);
      this.#emitDocChanged("plug meter lead");
    } else if (button) {
      // A button acts on its RELEASE: held a second it is another press
      // (the manual's) — SELECT the backlight, RANGE back to auto, REC out
      // of recording, HOLD Relative Zero.
      const pressed = performance.now();
      const done = (up) => {
        window.removeEventListener("pointerup", done, true);
        window.removeEventListener("pointercancel", done, true);
        if (up.type === "pointercancel") return;
        this.#pressMeterButton(id, button, performance.now() - pressed >= BUTTON_HOLD_MS); // prettier-ignore
      };
      window.addEventListener("pointerup", done, true);
      window.addEventListener("pointercancel", done, true);
    }
    return true;
  }

  /** One of a meter's buttons pressed — `long` held a second. SELECT's
      press is the one that changes the document (its choice is kept, as
      the real meter keeps it); the rest are its display's own. */
  #pressMeterButton(id, button, long) {
    const comp = this.#doc.getComponent(id);
    const view = this.#partViews.get(id);
    if (comp?.kind !== "meter") return;
    if (button === "select") {
      if (long) {
        view?.toggleBacklight?.();
        return;
      }
      const list = METER_SELECT[comp.params.dial];
      if (!list) return;
      const next = list[(list.indexOf(selectionAt(comp.params, comp.params.dial)) + 1) % list.length]; // prettier-ignore
      view?.updateParams(this.#doc.setComponentParams(id, { sel: { ...comp.params.sel, [comp.params.dial]: next } }).params); // prettier-ignore
      this.#emitDocChanged("meter select");
    } else if (button === "range") {
      view?.pressRange?.(long);
    } else if (button === "rec") {
      view?.pressRec?.(long);
    } else if (button === "hold") {
      view?.pressHold?.(long);
    } else if (button === "hz") {
      view?.pressHz?.();
    }
  }

  /** Fold a meter down to its screen and jacks (`compact`), or open it out
      again — its title clicked (the other way, by default), or its
      Properties ▸ Size — the screen staying where it was (catalog/meter.js
      `METER_COMPACT.origin`), and a probe lying loose where it lies. One
      undo step, stopped or running; nothing when it is that size already. */
  #foldMeter(id, compact = !isCompact(this.#doc.getComponent(id)?.params)) {
    const comp = this.#doc.getComponent(id);
    if (comp?.kind !== "meter" || isCompact(comp.params) === compact) return;
    const sign = compact ? 1 : -1;
    const dx = sign * METER_COMPACT.origin.x;
    const dy = sign * METER_COMPACT.origin.y;
    const patch = { size: compact ? "compact" : "full" };
    for (const which of PROBES) {
      const probe = comp.params[which];
      if (Number.isFinite(probe?.dx)) patch[which] = { dx: probe.dx - dx, dy: probe.dy - dy }; // prettier-ignore
    }
    const { params } = this.#doc.setComponentParams(id, patch);
    const moved = this.#doc.moveBrick(id, comp.x + dx, comp.y + dy);
    const view = this.#partViews.get(id);
    view?.setPosition(moved.x, moved.y);
    view?.updateParams(params);
    this.#probeLayer?.render();
    this.#emitDocChanged(compact ? "fold meter" : "open meter");
  }

  /**
   * Grab a meter's probe: the single-point drag every lead takes
   * (`nearestLegalPoint`, the shared ring, the drop the last move showed) —
   * onto ANY real hole or brick terminal, taken or free, since a probe is no
   * lead and claims nothing. Dropped clear of every point it lies loose on
   * the desk where it was let go. Allowed while running.
   */
  #onProbePointerDown(id, which, e) {
    if (e.button !== 0) return;
    // Option/Alt is pin-targeting: the press goes THROUGH the probe to the
    // lead in the hole under it (the viewport's press), as a probe resting on
    // a lead must not hide it.
    if (e.altKey) return;
    if (this.#mode || this.#probe.armed) return;
    if (isToggleSelectEvent(e, IS_MAC)) {
      e.stopPropagation();
      return;
    }
    const meter = this.#doc.getComponent(id);
    if (meter?.kind !== "meter") return;
    e.stopPropagation();
    this.#hideHover();
    const start = this.#deskView.worldFromEvent(e);
    this.#mode = {
      kind: "drag-meter-probe",
      id,
      which,
      // The holes under the chips' bodies, which no probe tip can reach —
      // read once for the gesture, not per candidate per move.
      covered: this.#doc.coveredAddresses(),
      elem: e.currentTarget,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      lastWorld: start,
      origin: { ...meter.params[which] },
      moved: false,
      address: null,
      inReach: false,
      at: null,
      teardown: null,
    };
    this.#viewport.classList.add("desk-viewport--dragging");
    this.#mode.teardown = beginPointerGesture(e.currentTarget, e.pointerId, {
      onMove: this.#onProbePointerMove,
      onEnd: this.#onProbePointerUp,
    });
  }

  /** Where a probe would land: the nearest real point in reach, or the raw
      desk point clear of every one (where it lies loose). */
  #resolveProbe(d, world) {
    const { point, inReach } = nearestLegalPoint(
      this.#doc.boards,
      this.#doc.components,
      world,
      (p) => this.#doc.canProbeAt(p.address, { covered: d.covered }),
    );
    d.address = point?.address ?? null;
    d.inReach = inReach;
    d.at = point ? { x: point.x, y: point.y } : world;
    aimRing(this.#ring, point, Boolean(point));
    this.#probeLayer.setPreview(d.id, d.which, { at: d.at });
  }

  #onProbePointerMove = (e) => {
    const d = this.#mode;
    if (d?.kind !== "drag-meter-probe" || e.pointerId !== d.pointerId) return;
    if (!d.moved) {
      const travel = Math.hypot(e.clientX - d.startClientX, e.clientY - d.startClientY); // prettier-ignore
      if (travel < DRAG_THRESHOLD) return;
      d.moved = true;
    }
    const w = this.#deskView.worldFromEvent(e);
    d.lastWorld = w;
    // The hand holds the probe by the top of its body, just behind the
    // guard (meter-probe-layer.js `PROBE.grip`), so what the tip touches is
    // in sight: the tip — and the snap, and its ring — is down the body from
    // the pointer.
    const meter = this.#doc.getComponent(d.id);
    const tip = meter ? tipFromGrip(w, jackWorld(meter, jackOf(meter.params, d.which))) : w; // prettier-ignore
    this.#resolveProbe(d, tip);
  };

  #onProbePointerUp = (e) => {
    const d = this.#mode;
    if (d?.kind !== "drag-meter-probe" || e.pointerId !== d.pointerId) return;
    this.#mode = null;
    this.#viewport.classList.remove("desk-viewport--dragging");
    d.teardown?.();
    aimRing(this.#ring, null);
    if (!d.moved || e.type === "pointercancel") {
      this.#probeLayer.clearPreview(d.id, d.which);
      return;
    }
    // The drop is what the last move SHOWED: the ringed point, or — clear of
    // every one — the desk point it was drawn at.
    try {
      if (d.address) {
        if (d.origin?.at === d.address) {
          this.#probeLayer.clearPreview(d.id, d.which);
          return;
        }
        this.#doc.setMeterProbe(d.id, d.which, { at: d.address });
      } else {
        this.#doc.setMeterProbe(d.id, d.which, d.at);
      }
      this.#emitDocChanged("move meter probe");
    } catch {
      this.#probeLayer.clearPreview(d.id, d.which);
    }
  };

  /** R while a planted flag is picked. Returns whether it consumed the key. */
  #rotateSelectedSignal() {
    const d = this.#mode;
    if (d?.kind === "drag-signal-flag") {
      // Mid-drag R spins the GHOST, the way it spins a board placement ghost.
      d.rot = nextFlagRotation(d.rot);
      this.#resolveSignalFlag(d, d.lastWorld);
      return true;
    }
    const sel = this.#sel.single;
    if (sel?.kind !== "signal") return false;
    const sig = this.#doc.getSignal(sel.id);
    if (!sig?.flag) return false;
    this.#doc.rotateSignalFlag(sel.id);
    this.#emitDocChanged("rotate signal flag");
    return true;
  }

  #onSignalContextMenu(id, e) {
    e.preventDefault();
    e.stopPropagation();
    this.openSignalMenu(id, e.clientX, e.clientY);
  }

  /**
   * A signal's context menu, at a point. ONE menu wherever you right-click the
   * signal — the flag on the desk, or its button on the rail. The rail needs it
   * because an UNPLACED signal has no flag to right-click and no way to be
   * selected, so without this there was no route to Delete at all: you had to
   * plant it somewhere first just to throw it away.
   *
   * Two ways to be rid of a flag, and the words keep them apart: **Remove
   * Signal** takes the flag off the board and back to its button (the signal
   * stays), **Delete Signal** throws the whole signal away — the same thing
   * the Delete key does. Like Add to analyzer, Remove stays PRESENT but
   * disabled for an unplaced signal, so the menu's shape never changes.
   */
  openSignalMenu(id, x, y) {
    if (this.#probe.armed || this.#mode || this.#editingLocked) return;
    const sig = this.#doc.getSignal(id);
    if (!sig) return;
    if (sig.flag) this.selectSignal(id); // only a planted flag can be selected
    PopupManager.menu({
      x,
      y,
      items: [
        {
          label: t("desk.menu.properties"),
          onSelect: () => this.openSignalProperties(id),
        },
        {
          label: t("probe.addToAnalyzer"),
          disabled: !sig?.flag,
          onSelect: () =>
            this.#onAddNetToAnalyzer?.(sig.flag.anchor, {
              color: sig.color,
              label: sig.name || sig.id,
            }),
        },
        {
          label: t("desk.menu.removeSignal"),
          disabled: !sig?.flag,
          onSelect: () => this.unplugSignal(id),
        },
        {
          label: t("desk.menu.deleteSignal"),
          danger: true,
          onSelect: () => this.removeSignal(id),
        },
      ],
    });
  }

  // ── Signal document actions ─────────────────────────────────────────────

  /** The desk's signals, in rail order — what the digit keys index into. */
  get signals() {
    return this.#doc.signals;
  }

  /** Pick a signal's flag (single pick — signals join no multi set). */
  selectSignal(id) {
    this.#sel.selectSignal(id);
  }

  /**
   * The shared Properties dialog for a signal — a HAND-BUILT field list, since
   * a signal is not a component and has no catalog def to declare one (the
   * project and desktop cards are driven the same way).
   *
   * Type and Default are `segmented` rather than `select`: both are short,
   * closed either/ors that should be readable without opening anything. There
   * is no `warnings` callback because a signal cannot fault.
   */
  openSignalProperties(id) {
    const sig = this.#doc.getSignal(id);
    if (!sig) return;
    PartPropertiesDialog.open({
      title: t("desk.signalPropertiesTitle", {
        signal: sig.name || sig.id,
      }),
      fields: [
        {
          key: "color",
          type: "color",
          // Every signal colour, whoever else holds it — colours may repeat,
          // since the KEY is what ties a flag to its button.
          options: SIGNAL_COLORS,
        },
        { key: "type", type: "segmented", options: signalTypeOptions() },
        { key: "rest", type: "segmented", options: signalRestOptions() },
      ],
      values: {
        name: sig.name,
        description: sig.description,
        color: sig.color,
        type: sig.type,
        rest: sig.rest,
      },
      onChange: (key, value) => this.#setSignalProperty(id, key, value),
    });
  }

  #setSignalProperty(id, key, value) {
    try {
      if (key === "name" || key === "description") {
        this.#doc.setSignalMeta(id, { [key]: value });
      } else {
        this.#doc.updateSignal(id, { [key]: value });
      }
    } catch {
      return; // a refused colour/value leaves the card as it was
    }
    // No explicit re-render: the rail and the flag layer both rebuild from
    // `chiphippo:doc-changed`, so this ONE seam is the whole repaint path (and
    // the one undo step, coalesced across a burst of nudges).
    this.#emitDocChanged("set signal properties", { coalesce: true });
  }

  /**
   * Add a signal. The desk POSITION a placement click reported is discarded on
   * purpose: a signal has no desk coordinates at all — its button goes to the
   * rail, and rail order IS document order, so "the next free slot" is an
   * append. Returns the new signal, or null when every key has a signal.
   */
  addSignal() {
    if (this.#editingLocked) return null;
    let sig;
    try {
      sig = this.#doc.addSignal({});
    } catch {
      return null; // SIGNALS_FULL — every digit key has a signal
    }
    // Named from the ID's own sequence, never the rail's length: ids never
    // repeat and lengths do, so a length-based default hands out a second
    // "Signal 4" the moment one is deleted. Set before the commit below, so
    // the add and its name are ONE undo step.
    this.#doc.setSignalMeta(sig.id, {
      name: t("desk.signal.untitled", { n: signalSeq(sig.id) }),
    });
    sig = this.#doc.getSignal(sig.id);
    this.#emitDocChanged("add signal");
    return sig;
  }

  /**
   * Take a signal's flag off the board and back to its button on the rail —
   * the signal survives, it just stops driving anything. The flag comes back
   * with no position at all (anchor AND rotation go), so the next drag starts
   * from scratch. Its selection goes with it: only a planted flag can be
   * selected, and a lingering one would leave its rail button lit.
   */
  unplugSignal(id) {
    if (this.#editingLocked) return;
    if (!this.#doc.getSignal(id)?.flag) return;
    this.#doc.unplantSignalFlag(id);
    if (this.#sel.single?.kind === "signal" && this.#sel.single.id === id) {
      this.#sel.select(null);
    }
    this.#emitDocChanged("disconnect signal");
  }

  /** Delete a signal outright — button, flag and all. */
  removeSignal(id) {
    if (this.#editingLocked) return;
    try {
      this.#doc.removeSignal(id);
    } catch {
      return;
    }
    if (this.#sel.single?.kind === "signal" && this.#sel.single.id === id) {
      this.#sel.forget();
    }
    this.#emitDocChanged("delete signal");
  }

  /** Is the desk frozen for a run? The rail asks before a reorder drag. */
  get editingLocked() {
    return this.#editingLocked;
  }

  /** A signal's button dragged to another place on the rail — and so to
      another key, since a signal's key is its place. One undo step. */
  moveSignal(id, index) {
    if (this.#editingLocked) return;
    let moved;
    try {
      moved = this.#doc.moveSignal(id, index);
    } catch {
      return;
    }
    if (moved) this.#emitDocChanged("reorder signals");
  }

  /** An element's card dragged to another place among the cards. */
  moveIntegration(id, index) {
    if (this.#editingLocked) return;
    let moved;
    try {
      moved = this.#doc.moveIntegration(id, index);
    } catch {
      return;
    }
    if (moved) this.#emitDocChanged("reorder elements");
  }

  // ── Serial integration: Output and Input elements ───────────────────────
  // The desk half (tags, drags, menus, Properties) is IntegrationTools; these
  // are the entry points the rail and the palette reach it through.

  /**
   * Arm a place-integration ghost for an Output, an Input or a data bus.
   * Like a signal, the click only says "yes, add one" — the card goes on the
   * rail — and for an Output or Input that is where its width is asked for.
   */
  armIntegrationPlacement(kind) {
    if (this.#editingLocked) return;
    if (kind === "data" ? this.#integration.dataFull : this.#integration.full) {
      return;
    }
    const ghost = el("div", { class: "signal-place-ghost", hidden: true }, [
      el("span", {
        class: "signal-place-ghost-mark",
        text: kind === "data" ? DATA_GLYPH : kind === "output" ? "→" : "←",
      }),
      el("span", { text: t(`palette.integration.${kind}`) }),
    ]);
    this.#place.enter({
      kind: "place-integration",
      integrationKind: kind,
      ghost,
      pos: null,
      legal: true,
    });
  }

  /** Add an element outright (tests; the placement click goes via the width
      popover). */
  addIntegration(kind, width) {
    return this.#integration.add(kind, width);
  }

  /** A press on a card's waiting tag chip — the tag drag, from the rail. */
  beginIntegrationTagDrag(id, key, e) {
    this.#integration.beginDragFromCard(id, key, e);
  }

  /** The element's menu (from its card on the rail). */
  openIntegrationMenu(id, x, y) {
    this.#integration.openMenu(id, x, y);
  }

  /** A click on a data bus's planted pin, on its card: its next level. */
  cycleDataPin(id, key) {
    this.#integration.cycleDataPin(id, key);
  }

  /** The element's Properties card. */
  openIntegrationProperties(id) {
    if (this.#editingLocked) return;
    this.#integration.openProperties(id);
  }

  /** Is the rail full of Outputs/Inputs? */
  get integrationsFull() {
    return this.#integration.full;
  }

  /** Is the rail full of data buses? */
  get dataFull() {
    return this.#integration.dataFull;
  }

  // ── The rubber band (a drag from the background) ───────────────────────

  /** Components lying WHOLLY inside the world-unit rect — every pin and the
      drawn body (part-geometry.js componentsInRect). */
  #componentsWithin(rect) {
    return componentsInRect(
      this.#doc.boards,
      this.#doc.components,
      rect,
      partBodyBox,
    );
  }

  /** Boards lying WHOLLY inside the world-unit rect (Feature 240). */
  #boardsWithin(rect) {
    return boardsInRect(this.#doc.boards, rect);
  }

  /** Wires lying wholly inside the world-unit rect — both ends, every bend. */
  #wiresWithin(rect) {
    return wiresInRect(
      this.#doc.boards,
      this.#doc.components,
      this.#doc.wires,
      rect,
    );
  }

  /**
   * A plain press on the BACKGROUND — the bare desk, or the holes of a strip
   * that is not selected (CLAUDE.md → "Selection"). Dragged, it rubber-bands:
   * the release REPLACES the selection with everything the band wholly
   * encloses. Released where it was pressed it is a click: on bare desk that
   * clears the selection, on a strip (`boardId`) it selects the whole board —
   * the strip's snapped group, everything seated on it riding as passengers.
   * The band only appears once the pointer travels.
   */
  #beginMarquee(e, boardId = null) {
    this.#hideHover();
    const world = this.#deskView.worldFromEvent(e);
    this.#mode = {
      kind: "marquee",
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startWorld: world,
      lastWorld: world,
      boardId,
      rect: { minX: world.x, minY: world.y, maxX: world.x, maxY: world.y },
      active: false,
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
    if (!m.active) {
      const travel = Math.hypot(
        e.clientX - m.startClientX,
        e.clientY - m.startClientY,
      );
      if (travel < DRAG_THRESHOLD) return; // still a click
      m.active = true;
      this.#viewport.classList.add("desk-viewport--selecting"); // crosshair
      this.#marquee = el("div", { class: "marquee" });
      this.#layers.overlay.append(this.#marquee);
    }
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
    // A band that spans Run applies no selection into the frozen state.
    if (e.type === "pointercancel" || this.#editingLocked) return;
    if (!m.active) {
      // A click on a strip picks the board (a single board pick stands for
      // its whole snapped group); a click on bare desk picks nothing.
      if (m.boardId && this.#doc.getBoard(m.boardId)) {
        this.selectBoard(m.boardId);
      } else this.deselect();
      this.#recordSelection();
      return;
    }
    // Re-band from the RELEASE point, not the last pointermove — a fast
    // rubber-band that ends a few pitches short would otherwise silently drop
    // whatever sat at the edge of the box, with no snap-back to hint at it.
    m.rect = this.#marqueeRect(m, releaseWorld(this.#deskView, e, m.lastWorld));
    // Enclosure decides membership; a board wholly inside takes its parts as
    // passengers, which setMulti drops from the independent sets.
    this.#sel.setMulti(
      this.#componentsWithin(m.rect),
      this.#wiresWithin(m.rect),
      this.#boardsWithin(m.rect),
    );
    this.#recordSelection();
  };

  /**
   * Delete the WHOLE selection in one go — one doc-changed, one undo step, no
   * questions (CLAUDE.md → "Selection": the selection is the unit of action,
   * and undo is the way back). A selected board takes its passengers with it,
   * and a wire left with an end on nothing — an end in a deleted board's hole
   * or on a deleted brick's terminal — goes too: a half-wire would be debris.
   */
  removeSelectedComponents() {
    if (this.#editingLocked) return;
    const sets = this.#sel.movingSets();
    const ids = [...sets.parts];
    const wireIds = [...sets.wires];
    const boardIds = [...sets.boards];
    // A picked lead deletes what it belongs to, as a single picked lead does:
    // a part with a leg gone, or a wire with an end gone, would be nothing.
    for (const { kind, id } of sets.leads) {
      if (kind === "lead") ids.push(id);
      else wireIds.push(id);
    }
    if (ids.length + wireIds.length + boardIds.length === 0) return;
    this.#doRemoveSelected(ids, wireIds, boardIds);
  }

  #doRemoveSelected(ids, wireIds = [], boardIds = []) {
    this.#sel.deselect();
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
    this.#pressWentThrough = false;
    if (this.#mode || e.button !== 0) return; // busy (tool/drag) or non-left
    if (this.#editingLocked) {
      // While RUNNING a wire is frozen and a switch is the one thing a click
      // is for — but the wires draw ABOVE the parts, so a lead laid across a
      // slide switch (a generated layout does it readily) swallowed every
      // press aimed at the knob, and the switch could not be flipped at all.
      // So a plain press on a wire or bus band goes through to a
      // click-toggling part under it.
      if (
        !this.#probe.armed &&
        !isToggleSelectEvent(e, IS_MAC) &&
        !e.altKey &&
        e.target?.closest?.(".wire, .bus-band")
      ) {
        const under = this.#togglePartUnder(e);
        if (under) {
          this.#pressWentThrough = true; // its click selects nothing
          this.#toggleClickPart(under.id, switchIndexFromEvent(under));
        }
      }
      // Option/Alt alone pans — a run stops editing, not looking around.
      if (
        e.altKey &&
        !isToggleSelectEvent(e, IS_MAC) &&
        !this.#probe.armed &&
        this.#hitFromTarget(e.target) !== undefined
      ) {
        this.#altPan(e);
      }
      return;
    }
    if (this.#probe.armed) return; // the click pins a net (#onViewportClick)
    // Boards and parts answer their own presses (and stop them); what reaches
    // here is the bare desk, a wire or bus drawn above everything, or a press
    // an element let through (Option/Alt held over a label or a flag).
    const hit = this.#hitFromTarget(e.target);
    if (hit === undefined) return; // chrome inside the viewport, not the desk
    this.#press(e, hit);
  };

  /** What a press that reached the viewport landed on: a wire, a bus (band or
      end handle), null for the desk itself — or undefined for something that
      isn't the desk at all (the zoom cluster, the rails, the padlock). */
  #hitFromTarget(target) {
    const surface = this.#deskView.surface;
    if (target === this.#viewport || target === surface) return null;
    if (!surface?.contains?.(target)) return undefined;
    const handle = target.closest?.(".bus-end-handle");
    if (handle) return { kind: "bus-handle", id: handle.dataset.busId };
    const wireId = target.closest?.(".wire")?.dataset.wireId;
    if (wireId) return { kind: "wire", id: wireId };
    const busId = target.closest?.(".bus-band")?.dataset.busId;
    if (busId) return { kind: "bus", id: busId };
    return null;
  }

  /**
   * The click-toggling part beneath a press that landed on something drawn
   * over the parts, as `{ id, target }` (the element hit, which says which
   * position of a DIP bank) — or null when the topmost part there is not one.
   */
  #togglePartUnder(e) {
    const stack = document.elementsFromPoint?.(e.clientX, e.clientY) ?? [];
    for (const target of stack) {
      const partEl = target.closest?.(".part");
      if (!partEl) continue;
      for (const [id, view] of this.#partViews) {
        if (view.element !== partEl) continue;
        const comp = this.#doc.getComponent(id);
        return clickTogglingPart(comp?.ref) ? { id, target } : null;
      }
      return null;
    }
    return null;
  }

  #onViewportClick = (e) => {
    const m = this.#mode;
    if (
      !this.placementArmed &&
      m?.kind !== "wire" &&
      m?.kind !== "bus" &&
      m?.kind !== "cut" &&
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
    if (m.kind === "cut") {
      this.#cut.commitClick(e);
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
    } else if (m.kind === "place-signal") {
      this.addSignal(); // the click point is deliberately discarded
    } else if (m.kind === "place-integration") {
      // The desk position is discarded, as a signal's is: the card goes on
      // the rail. The click is where an Output's or Input's width is asked
      // for; a data bus is always a byte, so it lands at once.
      if (m.integrationKind === "data") this.#integration.add("data");
      else {
        this.#integration.promptWidth(m.integrationKind, e.clientX, e.clientY);
      }
    } else if (m.kind === "place-part") {
      this.addComponentAt(
        m.ref,
        m.board,
        m.anchor,
        m.turns ? { ...m.params, rot: 90, end: m.end } : m.params,
      );
      this.#onPartPlaced?.(m.ref);
    } else {
      this.addComponentAt(m.ref, m.board, m.anchor, m.params);
      this.#onPartPlaced?.(m.ref);
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
    if (m?.kind === "cut") {
      this.#cut.trackMove(e);
      return;
    }
    if (this.#probe.armed) {
      this.#probe.trackMove(this.#deskView.worldFromEvent(e));
      return;
    }
    if (m) return; // dragging — hover stays hidden
    // Over the multimeter nothing under it is in reach: no hole or pin answers.
    if (e.target?.closest?.(".part-meter")) {
      this.#hideHover();
      if (this.#pinHeld) this.setPinMode(false);
      return;
    }

    const world = this.#deskView.worldFromEvent(e);
    this.#lastPointerWorld = world;
    // Option/Alt is pin-targeting mode — the event's own modifier is the
    // truth, which also mends a key change the window never heard.
    if (e.altKey !== this.#pinHeld) this.setPinMode(e.altKey);
    if (this.#pinHeld) {
      this.#refreshPinMode(world);
      return;
    }
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
  /** An edit was tried while the run holds the desk: say why, and how to
      get it back (app.js shows one toast, its key collapsing repeats). Every
      refusal used to be silent — the press, the key, the ⌘Z just did
      nothing. */
  #refuseEdit() {
    this.#onEditRefused?.();
  }

  /** A press on something frozen while running: refused as an edit only if
      it becomes a DRAG (past the usual threshold) — a plain click stays a
      look, and says nothing. */
  #refuseDragFrom(e) {
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev) => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD) return; // prettier-ignore
      done();
      this.#refuseEdit();
    };
    const done = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", done, true);
      window.removeEventListener("pointercancel", done, true);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", done, true);
    window.addEventListener("pointercancel", done, true);
  }

  #emitDocChanged(label = "edit", { seatsKept = false, ...opts } = {}) {
    // A meter probe in a hole the edit pressed a body or a lead into is
    // pushed off — in this step, so ⌘Z puts both back (DeskDoc
    // pressProbesOff). An edit that moved no lead (SEAT_NEUTRAL_LABELS, or
    // a params edit that kept its part's seat) has nothing to push.
    if (!this.#restoring && !seatsKept && !SEAT_NEUTRAL_LABELS.has(label)) {
      this.#doc.pressProbesOff();
    }
    // Boards may have moved, been torn out of a group, or been deleted —
    // re-trace the highlighter before anyone renders from the new document.
    this.#sel.refreshBoardOutline();
    // The same for the picked lead's ring and the Option/Alt hover: a lead may
    // have just moved, or the hole under the pointer changed hands.
    this.#sel.refreshLeadRing();
    this.#refreshPinMode();
    if (this.#editingLocked && !RUN_VOLATILE_LABELS.has(label)) {
      this.#editedWhileRunning = true;
    }
    if (!this.#restoring) {
      // The selection rides along with the step, so ⌘Z back to it puts back
      // what was picked as well as what was there.
      const dropped = this.#history.record(
        this.#doc.snapshot(),
        label,
        Date.now(),
        { ...opts, selection: this.#sel.serialize() },
      );
      this.#reconcileMemoryFiles(dropped);
      this.#notifyHistoryState();
    }
    window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
    this.#floats.refresh();
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

  /** Step back one entry — an edit, or a change of selection. @returns
      {boolean} true when it acted. */
  undo() {
    if (this.#editingLocked) {
      this.#refuseEdit(); // history frozen during a run
      return false;
    }
    // Nor mid-drag: the menu's ⌘Z reaches here while a gesture is live, and
    // the document it would restore may not hold what the drag is holding.
    if (this.#dragGestureActive) return false;
    return this.#step(() => this.#history.undo());
  }

  /** Step forward one entry. @returns {boolean} true when it acted. */
  redo() {
    if (this.#editingLocked) {
      this.#refuseEdit();
      return false;
    }
    if (this.#dragGestureActive) return false;
    return this.#step(() => this.#history.redo());
  }

  /**
   * Walk the history one entry (`move` is its undo or redo) and put the desk
   * where that entry says. The SELECTION is part of every entry, so it always
   * comes back; the DOCUMENT is restored only when the entry holds another
   * version of it — a step across a change of selection alone touches
   * nothing else (no rebuild, no doc-changed, nothing for the dirty marker).
   */
  #step(move) {
    const version = this.#history.version;
    const snapshot = move();
    if (snapshot == null) return false;
    if (this.#history.version !== version) this.#restoreSnapshot(snapshot);
    this.#sel.restore(this.#history.selection);
    this.#notifyHistoryState();
    return true;
  }

  /**
   * A change of selection the USER made — a click, a band, a ⌘/Ctrl or
   * Option/Alt pick, Escape, Select All — becomes a step of its own in the
   * undo history, so "I didn't mean that" is ⌘Z rather than any hidden
   * memory of what was selected before (CLAUDE.md → "Selection"). A no-op when
   * nothing actually changed, so a click on what is already picked records
   * nothing. Selections made on the way to an edit are not recorded here: the
   * edit's own step carries them.
   */
  #recordSelection() {
    if (this.#restoring || this.#editingLocked) return;
    const now = this.#sel.serialize();
    const was = this.#history.selection;
    const empty = (sel) =>
      !sel?.single &&
      !sel?.parts?.length &&
      !sel?.wires?.length &&
      !sel?.boards?.length &&
      !sel?.leads?.length;
    if (empty(now) && empty(was)) return;
    if (JSON.stringify(now) === JSON.stringify(was)) return;
    const dropped = this.#history.recordSelection(now, Date.now());
    this.#reconcileMemoryFiles(dropped);
    this.#notifyHistoryState();
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
    // A drag in flight is cancelled against the document it BEGAN on, before
    // that document is swapped out: its revert reads the origin board back out
    // of `#doc`, and the incoming document need not have one (a chip dragged on
    // a board a tab switch or New/Open takes away threw inside the rebuild).
    if (this.#dragGestureActive) this.#cancelDragGesture();
    this.cancelPlacement();
    this.disarmWireTool();
    this.disarmBusTool();
    this.disarmCutTool();
    this.disarmProbe();
    // Another desktop's parts: a slider floated for this one's closes (the
    // same id may well name some other part over there).
    this.#floats.closeAll();
    this.#restoring = true; // a load is not an edit — never record it
    const loadedFrom = this.#doc.toJSON();
    try {
      this.#doc.load(raw);
      // Another document's chips: its inspectors are closing with it.
      this.#unsavedMemory.clear();
      this.#adoptUnbackedMemories();
      if (history) this.#history = history;
      if (this.#history.size === 0) this.#history.clear(this.#doc.snapshot());
      // Another document: its BOARDS may be the very strips already shown (a
      // kit where every desktop has one), and those are kept; its parts are
      // all mounted afresh — they belong to another circuit.
      this.#rebuildScene({ shown: loadedFrom });
      // A different DOCUMENT, not an edit of this one: whatever was keyed by
      // component id (the chip debugger's arming) belongs to the last one.
      window.dispatchEvent(new CustomEvent("chiphippo:desk-loaded"));
      window.dispatchEvent(new CustomEvent("chiphippo:doc-changed", { detail: { replaced: true } })); // prettier-ignore
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
    // As `loadDocument`: cancel against the document the gesture began on.
    if (this.#dragGestureActive) this.#cancelDragGesture();
    // …and a wire or bus tool's anchored first end: the hole it holds may be
    // one the step puts something back into.
    this.#wire.cancelPending();
    this.#bus.cancelPending();
    this.#restoring = true;
    try {
      // What the views show now — the document they were mounted from and
      // kept in step with — so the restore remounts only what it changes.
      const shown = this.#doc.toJSON();
      this.#doc.restore(snapshot);
      this.#rebuildScene({ shown, parts: true });
      // Announce so autosave, the title/dirty marker, the sim, and the probe
      // all reconcile — but not through the recording seam. `replaced`: the
      // whole document was swapped, which a gesture elsewhere (the schematic's
      // symbol drag) must not outlive.
      window.dispatchEvent(new CustomEvent("chiphippo:doc-changed", { detail: { replaced: true } })); // prettier-ignore
      // A floated slider follows the step (or closes, its part undone away).
      this.#floats.refresh();
    } finally {
      this.#restoring = false;
    }
    this.#notifyHistoryState();
  }

  /**
   * Bring every mounted view in line with the current document — undo/redo,
   * a desktop switch, New/Open. Selection is dropped; wires and the board
   * outline re-render from the shared DeskDoc.
   *
   * Given `shown` (the document the views were showing), a board whose data
   * is unchanged keeps its view, and with `parts` so does every part whose
   * data is unchanged ON boards that are unchanged — a one-wire undo remounts
   * nothing. Remounting every strip (hundreds of nodes each) and every part
   * on every ⌘Z was most of an undo's cost on a big desk. Without `shown`,
   * everything is torn down and mounted afresh.
   * @param {{shown?: object, parts?: boolean}} [opts]
   */
  #rebuildScene({ shown = null, parts = false } = {}) {
    // A drag in flight must die HERE, before its views do. The gesture's
    // listeners live on `window` (see pointer-gesture.js), so unlike the old
    // element-scoped ones they SURVIVE the unmount below — a release arriving
    // afterwards would commit against #views/#partViews entries that no longer
    // exist. Undo/redo mid-drag and a tab switch mid-drag both land here.
    if (this.#dragGestureActive) this.#cancelDragGesture();
    // Drop all selection state first (the views it points at are about to go).
    this.#sel.forgetAll();
    this.#hideHover();
    // Unmount every view the document no longer describes as shown (keep
    // the Map objects — collaborators hold references to them).
    const key = (x) => JSON.stringify(x);
    // A strip's drawing is everything about it but WHERE it is: one that
    // only moved keeps its view and is moved (an undo of a board drag, which
    // remounted every strip and every part on a big desk).
    const look = ({ x: _x, y: _y, ...rest }) => key(rest);
    const wasBoard = new Map((shown?.boards ?? []).map((b) => [b.id, look(b)]));
    const wasPart = new Map((shown?.components ?? []).map((c) => [c.id, key(c)])); // prettier-ignore
    const boards = this.#doc.boards;
    const components = this.#doc.components;
    const boardKeys = new Map(boards.map((b) => [b.id, look(b)]));
    const wasAt = new Map((shown?.boards ?? []).map((b) => [b.id, b]));
    const movedBoards = new Set(
      boards
        .filter((b) => {
          const was = wasAt.get(b.id);
          return was && (was.x !== b.x || was.y !== b.y);
        })
        .map((b) => b.id),
    );
    // A part is drawn against the strips under it (a bent lead resolves
    // against whatever lies there), so a part is kept only while EVERY board
    // is as it was — or only moved, when it is re-placed below.
    const boardsSame =
      wasBoard.size === boardKeys.size &&
      [...boardKeys].every(([id, k]) => wasBoard.get(id) === k);
    const partKeys = new Map(components.map((c) => [c.id, key(c)]));
    for (const [id, view] of this.#views) {
      if (wasBoard.get(id) === boardKeys.get(id)) continue;
      view.remove();
      this.#views.delete(id);
    }
    const replace = [];
    for (const [id, view] of this.#partViews) {
      if (parts && boardsSame && wasPart.get(id) === partKeys.get(id)) {
        if (movedBoards.size > 0) replace.push(id);
        continue;
      }
      view.remove();
      this.#partViews.delete(id);
    }
    for (const id of movedBoards) {
      const board = boards.find((b) => b.id === id);
      if (board) this.#views.get(id)?.setPosition(board.x, board.y);
    }
    // A kept part on a moved strip — or with a lead that may reach one — is
    // placed again against the strips as they stand now.
    if (replace.length > 0) {
      const boardById = new Map(boards.map((b) => [b.id, b]));
      const compById = new Map(components.map((c) => [c.id, c]));
      for (const id of replace) {
        const comp = compById.get(id);
        if (!comp || comp.board == null) continue;
        const spans =
          partDef(comp.ref)?.rotatable || legsBent(comp) || hasFreeLegs(comp);
        if (!spans && !movedBoards.has(comp.board)) continue;
        const view = this.#partViews.get(id);
        if (view) {
          this.#placePartView(view, comp, boardById.get(comp.board), boards);
        }
      }
    }
    // Mount what is missing, then put every view in document order (a
    // remounted one was appended last; a fresh rebuild is in order already).
    for (const board of boards) {
      if (!this.#views.has(board.id)) this.#mountBoard(board);
    }
    for (const component of components) {
      if (!this.#partViews.has(component.id)) this.#mountPart(component);
    }
    inDocumentOrder(boards.map((b) => this.#views.get(b.id)?.element));
    inDocumentOrder(components.map((c) => this.#partViews.get(c.id)?.element));
    // forgetAll dropped the selection WITHOUT un-highlighting (its views were
    // meant to go) — but an unchanged view is kept now, so its lit state has
    // to be put out here or it stays lit beside the selection restored next.
    for (const view of this.#views.values()) view.setSelected?.(false);
    for (const view of this.#partViews.values()) view.setSelected?.(false);
    this.#wireLayer.render();
    this.#probeLayer?.render();
    this.#sel.refreshBoardOutline();
  }

  /** Push the current undo/redo availability to the Edit menu. */
  #notifyHistoryState() {
    this.#onHistoryChange?.({ canUndo: this.canUndo, canRedo: this.canRedo });
  }
}

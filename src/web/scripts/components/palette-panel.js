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

// palette-panel.js — the left parts palette: the board selector pinned at the
// top (complete breadboards + loose pin-boards / power rails), then chips,
// discrete parts, and power bricks grouped by function, with a filter box
// matching id/title/blurb. Clicking an entry arms placement mode (reported via
// the constructor callback with the click event — the ghost belongs to
// DeskController; a coloured part arms with the "Default LED color" setting).
//
// The tray carries its OWN open/close control rather than a toolbar button:
// a chevron in the header's top-right corner shuts it, and the tray shuts down
// to a narrow RAIL (palette-rail.js) rather than to nothing — the reopen
// chevron on the header's own line, so the control reads as one thing sliding
// into the wall, and under it one icon per top-level section. An icon opens
// the tray on that section alone (see #openSection).
//
// It shows ONE LOGIC FAMILY, or both (Feature 400; Settings ▸ Data Sheets ▸
// Chip family, `settings.logicFamily`). With one, the tray is exactly what it
// always was — function groups straight under CHIPS, holding that family's
// chips. With both, CHIPS gains a tier: a `74LS` and a `CD4000` folder, each
// holding the same function groups for its own parts. A family the open
// PROJECT uses is always shown (as if Combined), so a CD4000 project opened in
// 74LS mode still offers the parts on its desk. The family-less chip groups
// (Interface, PROCESSOR) and Memory show in every mode.
//
// Its WIDTH is the user's: the tray's right edge is a drag handle, exactly as
// the analyzer's top edge is, and the width it is left at is persisted
// (`settings.paletteWidth`) so it survives a relaunch — and a close/reopen for
// free, since shutting the tray HIDES the panel rather than rebuilding it, so
// the applied width simply stays on it. How much of the desk a permanent left
// column may eat is a judgement only the person looking at it can make: a long
// part title elides at the default width, and a wide desk has room to spare.

import { clear, el } from "../dom.js";
import { t, tf } from "../i18n.js";
import { partTitle, kitLabel } from "../catalog/labels.js";
import { beginPointerGesture } from "./pointer-gesture.js";
import { PaletteRail } from "./palette-rail.js";
import { SECTION_ICONS } from "./palette-icons.js";
import { buildInfoMark } from "./info-button.js";
import { PALETTE_DEFS, chipMarking, customChipDefs } from "../catalog/index.js";
import {
  DEFAULT_FAMILY_MODE,
  LOGIC_FAMILIES,
  familiesShown,
  familyOf,
  normalizeFamilyMode,
} from "../catalog/families.js";
import {
  BREADBOARD_KITS,
  KIT_KEYS,
  STRIP_KIT_KEYS,
} from "../model/board-types.js";
import { canRotate } from "../model/breadboard.js";
import { MAX_SIGNALS } from "../model/signals.js";

/** Every logic-chip group nests one level under this top-level folder. It
    collapses like a group, and no group shares its name. */
const CHIPS_FOLDER = "CHIPS";

/** Memory chips are pulled OUT of the CHIPS folder into their own top-level
    group, below COMPONENTS (they're chips, but a distinct category). */
const MEMORY_GROUP = "Memory";

/** Every non-chip part (switches, resistors, LEDs, displays, power) nests under
    this top-level folder, one level down in a function sub-group. */
const COMPONENTS_FOLDER = "COMPONENTS";

/** The order the COMPONENTS sub-groups render in (catalog order is by first
    appearance, which reads oddly; this is the intended shelf order). It is
    also WHAT the shelf holds: a group named here is a COMPONENTS group
    whatever its members are, so a chip given one of these groups would be
    shelved here rather than under CHIPS. */
const COMPONENT_ORDER = [
  "Switches",
  "Resistors",
  "Capacitors",
  "Inductors",
  "Diodes",
  "Transistors",
  "Relays",
  "LEDs",
  "Displays",
  "Oscillators",
  "Regulators",
  "Power",
];

/** The groups whose parts do only part of what the real thing does — the
    discretes (catalog/discretes.js: capacitors, inductors, diodes,
    transistors), each placed for the export and a complete design more than
    for what it simulates — and so carry a red (i) whose tooltip says so. That
    is the DIGITAL engine's caveat: Spice Lite simulates all four, so while it
    is on the mark is not drawn (`setSpiceLite`). DERIVED from the parts (`countsAsConnection`, the mark
    every one of them carries), so a new one is marked with nothing to add
    here. */
const LIMITED_GROUPS = new Set(
  PALETTE_DEFS.filter((def) => def.countsAsConnection).map((def) => def.group),
);

/** Is `group` shelved under COMPONENTS? Every group COMPONENT_ORDER names,
    plus any other group whose parts are not chips. */
const isComponentGroup = (group, members) =>
  COMPONENT_ORDER.includes(group) || members[0]?.kind !== "chip";

/** The order the chip groups render in, in EVERY family: where each group
    first appears in the whole catalog. 74LS parts lead the catalog, so this is
    the 74LS tray's order, and a CD4000 tray lists its groups the same way
    (NAND before NOR) rather than in its own part-number order, which would put
    the CD4001B's NOR first. A group only CD4000 has falls after the 74LS ones,
    and the family-less groups after those — exactly where they sat before. */
const CHIP_GROUP_RANK = new Map(
  [...new Set(PALETTE_DEFS.map((def) => def.group))].map((group, i) => [
    group,
    i,
  ]),
);

/** The board selector's foldable section name (pinned at the top). Folds like
    any section, and starts shut with the rest. */
const BOARDS_FOLDER = "BOARDS";

/** Tray sizing, in CSS px. The default matches the `.palette-panel` fallback;
    the minimum is what the header still reads at (the filter box beside the
    close chevron), and the tray may never take more than half the window —
    the same ceiling the bottom-docked panels honour, so no dockable panel can
    ever crowd the desk out entirely. */
const DEFAULT_TRAY_W = 232;
const MIN_TRAY_W = 180;
const MAX_TRAY_FRAC = 0.5;

/** The annotations section pinned at the BOTTOM (labels + notes). Not catalog
    parts — hardcoded here like the boards folder — so it folds like any
    section and is hidden while the parts filter is active. */
const ANNOTATIONS_FOLDER = "ANNOTATIONS";

/** External signals (Feature 370), below ANNOTATIONS and hardcoded for the
    same reason: a signal is NOT a catalog part — no footprint, no def, no BOM
    line — so it must not enter PALETTE_DEFS. One entry, since every signal is
    the same thing until it is named and coloured — plus the Arduino serial
    integration's Output and Input, which are bench leads of the same kind
    (they go on the same rail) and so share the folder rather than adding one. */
const SIGNALS_FOLDER = "SIGNALS";

/** The chips the user DESIGNED (the chip designer) — the open project's own
    parts, shelved INSIDE the CHIPS folder as a sibling of the family folders
    (74LS, CD4000): a custom chip is a chip, of a family of its own. Not in
    PALETTE_DEFS: they come and go with the project (catalog/index.js
    `customChipDefs`), so the folder is hardcoded like the boards folder, and
    holds the "New chip…" row that makes one. */
const CUSTOM_FOLDER = "CUSTOM";

/** The `</>` glyph a custom chip's row carries in the tray — the mark it
    wears on the desk (chip-view.js), so the two are recognisably one part. */
const CUSTOM_GLYPH =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 10" width="1.1em" ' +
  'height="0.7em" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4 1 1 5l3 4M7.5 9l1-8M12 1l3 4-3 4"/></svg>';

/** The TOP-LEVEL entries, in the order the tray lists them — the shut tray's
    rail shows one icon each, on the row that entry's header occupies. `id` is
    the section's identity (its collapse key); `key` names its icon and its
    `palette.rail.*` label; `group` marks the one that is a catalog GROUP
    rather than a folder, whose header is a text size smaller. */
const RAIL_SECTIONS = [
  { id: BOARDS_FOLDER, key: "boards" },
  { id: CHIPS_FOLDER, key: "chips" },
  { id: COMPONENTS_FOLDER, key: "components" },
  { id: MEMORY_GROUP, key: "memory", group: true },
  { id: ANNOTATIONS_FOLDER, key: "annotations" },
  { id: SIGNALS_FOLDER, key: "signals" },
];

/** The tray's own open/close chevron. Its own copy of the app's line-icon
    idiom (16 px box, round-capped strokes) — the toolbar's constants live in
    app.js and aren't exported. */
function chevron(points) {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" ' +
    'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    `<polyline points="${points}"/></svg>`
  );
}
/** ‹ — closing pushes the tray back into the left wall. */
const CHEVRON_LEFT = chevron("15 6 9 12 15 18");
/** › — opening pulls it back out of the rail. */
const CHEVRON_RIGHT = chevron("9 6 15 12 9 18");

/** The platform-correct modifier glyph for the toggle's tooltips. Read when the
    panel is built, not at import: the jsdom tests install `window` after the
    module graph has already loaded. */
function modKey() {
  return globalThis.window?.chiphippo?.platform === "darwin" ? "⌘" : "Ctrl";
}

const ANNOTATION_KINDS = [
  { kind: "label", glyph: "T" },
  { kind: "note", glyph: "≡" },
];

/**
 * A section's DISPLAY name, translated — while the English name it is derived
 * from stays the section's IDENTITY (the collapse-state key, the grouping key,
 * and what `#toggleGroup` is called with). Translating the identity would make
 * a section forget whether it was open the moment the language changed.
 *
 * The leaf is derived rather than mapped ("Shift register" → `shiftregister`),
 * so a new catalog group needs no second table here — only a catalog entry,
 * which `tests/i18n-catalog.test.js` requires. Falling back to the English name
 * means a group added without one still reads correctly, just untranslated.
 * @param {string} name the catalog group / folder name
 * @returns {string}
 */
function sectionLabel(name) {
  const leaf = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return tf(`palette.group.${leaf}`, name);
}

/**
 * The identity of a function group INSIDE a family folder (Combined mode):
 * `CD4000/NAND`. Single-family mode keeps the bare `NAND` — the tray it has
 * always had — so the two layouts each remember their own open/closed state,
 * and the two NAND groups of a Combined tray never open and shut together.
 * @param {string} family
 * @param {string} group
 */
const familyGroupKey = (family, group) => `${family}/${group}`;

/**
 * Every collapsible section name — the boards folder, the chips folder, the
 * annotations folder, every group in the catalog, the family folders, and
 * every family's own copy of its groups. The palette opens with ALL of them
 * shut: the full list is long enough that a wall of parts buries the
 * structure, and the filter box is the fast path to a specific one anyway.
 */
function allSections() {
  return new Set([
    BOARDS_FOLDER,
    CHIPS_FOLDER,
    COMPONENTS_FOLDER,
    CUSTOM_FOLDER,
    ANNOTATIONS_FOLDER,
    SIGNALS_FOLDER,
    ...PALETTE_DEFS.map((def) => def.group),
    ...LOGIC_FAMILIES,
    ...PALETTE_DEFS.filter((def) => familyOf(def)).map((def) =>
      familyGroupKey(def.family, def.group),
    ),
  ]);
}

/**
 * The folders a section is shelved under, innermost first — `CD4000/NAND`
 * sits in `CD4000`, which sits in CHIPS; a bare chip group in CHIPS, a
 * component group in COMPONENTS — or none for anything that is itself
 * top-level (the folders, BOARDS, ANNOTATIONS, SIGNALS, and Memory, which is
 * pulled OUT of CHIPS). The same bucketing `#render` does, stated for one name.
 * @param {string} name a section's identity
 * @returns {string[]}
 */
function foldersOf(name) {
  if (LOGIC_FAMILIES.includes(name) || name === CUSTOM_FOLDER) {
    return [CHIPS_FOLDER];
  }
  const slash = name.indexOf("/");
  if (slash > 0) return [name.slice(0, slash), CHIPS_FOLDER];
  if (name === MEMORY_GROUP) return [];
  const members = PALETTE_DEFS.filter((d) => d.group === name);
  if (!members.length) return [];
  return [isComponentGroup(name, members) ? COMPONENTS_FOLDER : CHIPS_FOLDER];
}

export class PalettePanel {
  #el;
  #list;
  #filterInput;
  #reopen; // the reopen chevron, heading the rail
  #rail; // what the tray shuts down to (palette-rail.js)
  #resize; // the draggable right edge
  #onToggle;
  #onPickChip;
  #onPickBoard;
  #onPickAnnotation;
  #onPickSignal;
  #signalItem = null; // the SIGNALS folder's one row (see setSignalsFull)
  #signalsFull = false;
  #onPickIntegration;
  #onNewCustomChip;
  #onCustomChipMenu;
  #integrationItems = []; // the Output and Input rows (see setIntegrationsFull)
  #integrationsFull = false;
  #onWidthChange;
  #width = DEFAULT_TRAY_W;
  #dragStartX = null; // pointer X at drag start (null = not resizing)
  #dragStartW = 0; // tray width at drag start
  #endDrag = null; // the pointer gesture's teardown
  #filter = "";
  #autoClose = false; // Settings ▸ Appearance ▸ Auto-close tray folders
  #familyMode = DEFAULT_FAMILY_MODE; // Settings ▸ Data Sheets ▸ Chip family
  #spiceLite = false; // Settings ▸ Spice Lite — drops the limited-group (i)
  #projectFamilies = new Set(); // families the open project uses (sticky)
  // Every section starts shut, every launch. What the user opens lasts for
  // the session only — deliberately NOT persisted, so the panel always opens
  // in the same known state.
  #collapsed = allSections();

  /**
   * @param {HTMLElement} container - mounted as the desk row's left panel.
   * @param {object} callbacks
   * @param {(ref: string, e: MouseEvent) => void} callbacks.onPickChip
   * @param {(kit: string) => void} callbacks.onPickBoard - a board kit key
   *   (assembled breadboard or loose strip) was picked; app.js arms placement.
   * @param {() => void} callbacks.onPickSignal - arm signal placement.
   * @param {(kind: "output"|"input") => void} [callbacks.onPickIntegration] -
   *   arm an Arduino serial Output / Input placement.
   * @param {(kind: "label"|"note") => void} callbacks.onPickAnnotation - a
   *   label/note was picked; app.js arms annotation placement.
   * @param {() => void} [callbacks.onNewCustomChip] - the CUSTOM folder's
   *   "New chip…" row: design a new chip (app.js opens the designer).
   * @param {(id: string, x: number, y: number) => void} [callbacks.onCustomChipMenu]
   *   - a custom chip's row was right-clicked: its Edit / Duplicate / Delete
   *   menu, at the pointer.
   * A custom chip's row arms its placement through `onPickChip`, exactly as
   * a catalog chip's does — its ref is a catalog ref like any other.
   * @param {() => void} callbacks.onToggle - the header chevron or the
   *   rail's was clicked, or a rail icon asked for the tray. The panel does NOT
   *   flip itself: app.js owns the one toggle that also persists
   *   `paletteOpen`, exactly as the ⌘P shortcut does.
   * @param {number} [callbacks.width] - restored tray width in CSS px.
   * @param {(width: number) => void} [callbacks.onWidthChange] - persist the
   *   width after a resize drag settles (app.js writes `paletteWidth`, the
   *   same division of labour the open flag has).
   */
  constructor(
    container,
    {
      onPickChip,
      onPickBoard,
      onPickAnnotation,
      onPickSignal,
      onPickIntegration,
      onNewCustomChip,
      onCustomChipMenu,
      onToggle,
      width,
      onWidthChange,
    } = {},
  ) {
    this.#onPickChip = onPickChip;
    this.#onNewCustomChip = onNewCustomChip;
    this.#onCustomChipMenu = onCustomChipMenu;
    this.#onPickBoard = onPickBoard;
    this.#onPickAnnotation = onPickAnnotation;
    this.#onPickSignal = onPickSignal;
    this.#onPickIntegration = onPickIntegration;
    this.#onWidthChange = onWidthChange;
    this.#onToggle = onToggle;

    this.#filterInput = el("input", {
      class: "palette-filter",
      type: "search",
      placeholder: t("palette.filterPlaceholder"),
      "aria-label": t("palette.filter"),
      onInput: (e) => {
        this.#filter = e.target.value;
        this.#render();
      },
    });

    const mod = modKey();
    const collapseBtn = el("button", {
      class: "palette-collapse",
      type: "button",
      title: t("palette.hideTitle", { mod }),
      "aria-label": t("palette.hide"),
      onClick: () => onToggle?.(),
    });
    collapseBtn.innerHTML = CHEVRON_LEFT;

    this.#list = el("div", { class: "palette-list" });

    // The draggable right edge. Absolutely positioned rather than a flex row
    // of its own (the panel is a column, and the seam runs the other way), so
    // it straddles the border without taking a pixel from the list beside it.
    this.#resize = el("div", {
      class: "palette-resize",
      title: t("palette.resize"),
      "aria-hidden": "true",
    });
    this.#resize.addEventListener("pointerdown", (e) => this.#onResizeDown(e));

    this.#el = el(
      "aside",
      {
        class: "palette-panel",
        "aria-label": t("palette.label"),
        hidden: true,
      },
      [
        el("div", { class: "palette-header" }, [
          this.#filterInput,
          collapseBtn,
        ]),
        this.#list,
        this.#resize,
      ],
    );
    this.#applyWidth(Number.isFinite(width) ? width : DEFAULT_TRAY_W);

    // The rail: a sibling of the tray, not a child — the tray itself is
    // display:none when shut. Its reopen chevron sits on the same line as the
    // header chevron above, so the two read as one control.
    this.#reopen = el("button", {
      class: "palette-rail-toggle",
      type: "button",
      title: t("palette.showTitle", { mod }),
      "aria-label": t("palette.show"),
      onClick: () => onToggle?.(),
    });
    this.#reopen.innerHTML = CHEVRON_RIGHT;
    this.#rail = new PaletteRail({
      toggle: this.#reopen,
      sections: RAIL_SECTIONS,
      onOpen: (id) => this.#openSection(id),
    });

    container.append(this.#el, this.#rail.element);
    this.#render();
  }

  get element() {
    return this.#el;
  }

  get visible() {
    return !this.#el.hidden;
  }

  get width() {
    return this.#width;
  }

  setVisible(on) {
    this.#el.hidden = !on;
    // Exactly one of the two is ever showing: the tray, or the rail it shuts
    // down to. The rail is a layout column, so the desk (and its tab strip)
    // simply starts to the right of whichever it is.
    this.#rail.setVisible(!on);
  }

  /**
   * Settings ▸ Appearance ▸ Auto-close tray folders (`paletteAutoClose`). On,
   * opening a section closes every section that is not on the way to it (see
   * `#openOnly`), so the tray only ever shows the shelf being worked in.
   * Switching it on closes nothing by itself: which of several open sections
   * is "the" one is only known when the next one is opened.
   * @param {boolean} on
   */
  setAutoClose(on) {
    this.#autoClose = on === true;
  }

  /**
   * Settings ▸ Data Sheets ▸ Chip family (`logicFamily`): which family the
   * tray shows — "74LS", "CD4000" or "combined". Applied live; an unknown
   * value reads as the default. Each section keeps its remembered state.
   * @param {string} mode
   */
  setFamilyMode(mode) {
    const next = normalizeFamilyMode(mode);
    if (next === this.#familyMode) return;
    this.#familyMode = next;
    this.#render();
  }

  /**
   * Settings ▸ Spice Lite (`spiceLite`): which engine the next Run uses. On,
   * the discretes are simulated for real, so their groups lose the red (i)
   * that says they are not. Applied live. Takes the stored config, read as
   * the desk controller reads it: on only when `enabled` is exactly true.
   * @param {{enabled?: boolean}} [config]
   */
  setSpiceLite(config) {
    const next = config?.enabled === true;
    if (next === this.#spiceLite) return;
    this.#spiceLite = next;
    this.#render();
  }

  /**
   * The families the OPEN PROJECT uses, which the tray shows whatever the mode
   * — so a CD4000 project opened in 74LS mode still offers the parts on its
   * desk. STICKY until `resetProjectFamilies`: deleting the last CD4000 part
   * mid-session must not make its folder vanish under the user. Derived from
   * the project, never stored.
   * @param {Iterable<string>} families
   */
  noteProjectFamilies(families) {
    let grew = false;
    for (const family of families) {
      if (
        !LOGIC_FAMILIES.includes(family) ||
        this.#projectFamilies.has(family)
      ) {
        continue;
      }
      this.#projectFamilies.add(family);
      grew = true;
    }
    if (grew) this.#render();
  }

  /** The families the open project uses (a copy — see noteProjectFamilies). */
  get projectFamilies() {
    return new Set(this.#projectFamilies);
  }

  /**
   * A different project is open: forget the last one's families and start
   * from `families` (the new project's).
   * @param {Iterable<string>} [families]
   */
  resetProjectFamilies(families = []) {
    this.#projectFamilies = new Set();
    this.noteProjectFamilies(families);
    this.#render();
  }

  /** The families showing right now (the mode, widened by the project). */
  #shownFamilies() {
    return familiesShown(this.#familyMode, this.#projectFamilies);
  }

  /** Is `def` in a family the tray is showing? Family-less parts always are. */
  #familyShown(def, shown = this.#shownFamilies()) {
    const family = familyOf(def);
    return family === null || shown.has(family);
  }

  /**
   * Open `name` and shut EVERYTHING else — every folder and every group,
   * nested ones included — bar the folders it is shelved under, which are
   * what is showing it. The auto-close rule, shared by a header click and a
   * rail icon.
   * @param {string} name a section's identity
   */
  #openOnly(name) {
    this.#collapsed = allSections();
    this.#collapsed.delete(name);
    for (const folder of foldersOf(name)) this.#collapsed.delete(folder);
  }

  /**
   * A rail icon asked for one section: open the tray on it ALONE. Every other
   * top-level entry is shut, so what comes into view is the shelf that was
   * asked for rather than wherever it falls in a long list — while the groups
   * INSIDE it keep whatever this session left them at, unless auto-close is on,
   * which shuts those too (`#openOnly`). A live filter goes: it hides BOARDS /
   * ANNOTATIONS / SIGNALS outright and forces every group open, so the tray
   * would show anything but the one section asked for.
   *
   * Focus follows to that section's header: the icon that had it has just
   * been hidden, and a keyboard user should land where they asked to go.
   * @param {string} id the section's identity (a `RAIL_SECTIONS` id)
   */
  #openSection(id) {
    if (this.#autoClose) {
      this.#openOnly(id);
    } else {
      for (const section of RAIL_SECTIONS) this.#collapsed.add(section.id);
      this.#collapsed.delete(id);
    }
    this.#filter = "";
    this.#filterInput.value = "";
    this.#render();
    // The rail only shows while the tray is shut, so asking app.js for the
    // one toggle (the one that persists `paletteOpen`) is asking to open it.
    if (!this.visible) this.#onToggle?.();
    const header = this.#list.querySelector(`[data-section="${id}"]`);
    header?.focus({ preventScroll: true });
    header?.scrollIntoView?.({ block: "nearest" });
  }

  // ── Sizing (drag the right edge; the tray docks along the window's left) ────

  /** The widest the tray may grow to: half the window, floored at the min. */
  #maxWidth() {
    const half = Math.floor((window.innerWidth || 0) * MAX_TRAY_FRAC);
    return Math.max(MIN_TRAY_W, half);
  }

  /** Clamp a pixel width to [min, half-window] and apply it; returns applied. */
  #applyWidth(w) {
    const clamped = Math.round(
      Math.min(this.#maxWidth(), Math.max(MIN_TRAY_W, w)),
    );
    this.#width = clamped;
    this.#el.style.width = `${clamped}px`;
    return clamped;
  }

  #onResizeDown(e) {
    e.preventDefault();
    this.#dragStartX = e.clientX;
    // The applied width, not a measured rect: the panel is `flex: 0 0 auto` at
    // exactly what #applyWidth set, and reading the box back would round the
    // drag's own start point against it.
    this.#dragStartW = this.#width;
    this.#resize.classList.add("palette-resize--active");
    // Window-level, capture-phase plumbing (see pointer-gesture.js): the drag
    // ends on the release wherever it lands — over the desk, over another
    // window — rather than depending on the pointer capture alone.
    this.#endDrag = beginPointerGesture(this.#resize, e.pointerId, {
      onMove: (ev) => this.#onResizeMove(ev),
      onEnd: () => this.#onResizeEnd(),
    });
  }

  #onResizeMove(e) {
    if (this.#dragStartX == null) return;
    // Dragging the handle RIGHT (a positive delta) grows the left-docked tray.
    this.#applyWidth(this.#dragStartW + (e.clientX - this.#dragStartX));
  }

  /** End the drag and persist wherever it was left — including an abort (a
      yanked capture, the window losing focus), since the tray is already
      showing that width and quietly reverting it would be the surprise. */
  #onResizeEnd() {
    if (this.#dragStartX == null) return;
    this.#dragStartX = null;
    this.#endDrag?.();
    this.#endDrag = null;
    this.#resize.classList.remove("palette-resize--active");
    this.#onWidthChange?.(this.#width);
  }

  #matches(def) {
    const q = this.#filter.trim().toLowerCase();
    if (!q) return true;
    // The TRANSLATED title is searched alongside the English one: a French user
    // types what the row in front of them says, and an English part number is
    // still the fastest way in whatever the UI is speaking.
    return [def.id, def.title, partTitle(def), def.blurb, def.marking]
      .filter((s) => typeof s === "string")
      .some((s) => s.toLowerCase().includes(q));
  }

  #render() {
    clear(this.#list);
    // While a filter is active, force everything open so matches stay visible;
    // the remembered collapse state only governs the unfiltered list.
    const filtering = this.#filter.trim() !== "";
    // The board selector is pinned at the very top of the palette; the filter
    // box targets the parts list below, so hide the boards while filtering.
    if (!filtering) this.#appendBoards();

    const shown = this.#shownFamilies();
    const matching = PALETTE_DEFS.filter((def) => this.#matches(def));
    const defs = matching.filter((def) => this.#familyShown(def, shown));
    const customs = customChipDefs().filter((def) => this.#matches(def));
    if (defs.length === 0 && !(filtering && customs.length)) {
      this.#list.append(
        el("p", {
          class: "palette-empty",
          text: this.#hiddenFamilyHint(matching) ?? t("palette.noMatches"),
        }),
      );
      return;
    }
    // Group by function (ordered below — chip groups by CHIP_GROUP_RANK). With
    // more than one family showing, a family's chips group under a key of
    // their own (`CD4000/NAND`), so each family folder gets its own NAND.
    const tiered = shown.size > 1;
    const groups = new Map();
    for (const def of defs) {
      const family = tiered ? familyOf(def) : null;
      const key = family ? familyGroupKey(family, def.group) : def.group;
      if (!groups.has(key)) {
        groups.set(key, { key, group: def.group, family, members: [] });
      }
      groups.get(key).members.push(def);
    }

    // Three top-level buckets: logic chips nest under the CHIPS folder; memory
    // chips are pulled out into their own group below it; every non-chip part
    // nests under the COMPONENTS folder. A group is a chip group when its
    // members are chips (the catalog stamps `kind: "chip"`) — unless it is one
    // of the COMPONENTS shelf's own (isComponentGroup).
    const chipGroups = [];
    const componentGroups = [];
    let memoryMembers = null;
    for (const entry of groups.values()) {
      if (isComponentGroup(entry.group, entry.members)) {
        componentGroups.push(entry);
      } else if (entry.group === MEMORY_GROUP) memoryMembers = entry.members;
      else chipGroups.push(entry);
    }
    componentGroups.sort(
      (a, b) =>
        COMPONENT_ORDER.indexOf(a.group) - COMPONENT_ORDER.indexOf(b.group),
    );
    chipGroups.sort(
      (a, b) => CHIP_GROUP_RANK.get(a.group) - CHIP_GROUP_RANK.get(b.group),
    );

    // The project's own chips: always offered (the folder holds the row that
    // makes one) unless a filter matched none of them. They shelve beside the
    // family folders — after the last of them in a Combined tray, and after
    // the groups in a single-family one, where there is no family tier.
    const chipChildren = this.#withFamilyTier(chipGroups);
    if (!filtering || customs.length) {
      const lastFamily = chipChildren.findLastIndex((c) => c.groups);
      chipChildren.splice(
        lastFamily >= 0 ? lastFamily + 1 : chipChildren.length,
        0,
        { custom: customs },
      );
    }

    // Chips lead, then every other component, then memory (its own group).
    this.#appendFolder(CHIPS_FOLDER, chipChildren, filtering);
    this.#appendFolder(COMPONENTS_FOLDER, componentGroups, filtering);
    if (memoryMembers) {
      this.#appendGroup(this.#list, MEMORY_GROUP, memoryMembers, filtering);
    }

    // Labels + notes live at the very bottom (not catalog parts, so the chip
    // filter hides them, exactly like the boards folder up top).
    if (!filtering) this.#appendAnnotations();
    if (!filtering) this.#appendSignals();
  }

  /**
   * The CUSTOM folder, inside CHIPS beside the family folders (and drawn as
   * one): "New chip…", then the project's designed chips. A chip's row places
   * it like any chip (a click arms the ghost); its right-click is its own menu
   * — Edit, Duplicate, Delete — since a chip the user designed is also a
   * design they can change.
   */
  #appendCustom(container, defs, filtering) {
    const collapsed = !filtering && this.#collapsed.has(CUSTOM_FOLDER);
    const rows = [];
    if (!filtering) {
      rows.push(
        el(
          "button",
          {
            class: "palette-custom-new",
            type: "button",
            title: t("palette.custom.newHint"),
            onClick: () => this.#onNewCustomChip?.(),
          },
          [
            el("span", { class: "palette-item-id", text: "+" }),
            el("span", {
              class: "palette-item-title",
              text: t("palette.custom.new"),
            }),
          ],
        ),
      );
    }
    for (const def of defs) {
      const id = el("span", {
        class: "palette-item-id palette-item-id--custom",
      });
      const glyph = el("span", {
        class: "palette-custom-glyph",
        "aria-hidden": "true",
      });
      glyph.innerHTML = CUSTOM_GLYPH;
      id.append(glyph, chipMarking(def));
      rows.push(
        el(
          "button",
          {
            class: "palette-item palette-item--custom",
            type: "button",
            title: def.blurb || t("palette.custom.rowHint"),
            dataset: { ref: def.id },
            onClick: (e) => this.#onPickChip?.(def.id, e),
            onContextmenu: (e) => {
              e.preventDefault();
              this.#onCustomChipMenu?.(def.id, e.clientX, e.clientY);
            },
          },
          [
            id,
            el("span", {
              class: "palette-item-title",
              text: def.title,
            }),
          ],
        ),
      );
    }
    const header = this.#sectionHeader("palette-group", CUSTOM_FOLDER, collapsed); // prettier-ignore
    // Not `palette-family`: it stands beside the families, and is not one —
    // a single-family tray (no family tier) still has it.
    header.classList.add("palette-custom-folder");
    container.append(
      header,
      el("div", { class: "palette-group-items", hidden: collapsed }, rows),
    );
  }

  /** The open project's designed chips changed: show the new set. */
  refreshCustomChips() {
    this.#render();
  }

  /**
   * The annotations section (labels + notes), pinned at the bottom. Each entry
   * arms annotation placement via onPickAnnotation — the same kinds the old
   * header Annotate split-button offered.
   */
  #appendAnnotations() {
    const collapsed = this.#collapsed.has(ANNOTATIONS_FOLDER);
    this.#list.append(
      // Its own folder class (like the boards folder) so it isn't counted among
      // the catalog `.palette-group`s.
      this.#sectionHeader(
        "palette-annotations-folder",
        ANNOTATIONS_FOLDER,
        collapsed,
      ),
      el(
        "div",
        { class: "palette-group-items", hidden: collapsed },
        ANNOTATION_KINDS.map(({ kind, glyph }) =>
          el(
            "button",
            {
              class: "palette-annotation-item",
              type: "button",
              title: t(`palette.annotation.${kind}Hint`),
              dataset: { annotation: kind },
              onClick: () => this.#onPickAnnotation?.(kind),
            },
            [
              el("span", { class: "palette-item-id", text: glyph }),
              el("span", {
                class: "palette-item-title",
                text: t(`palette.annotation.${kind}`),
              }),
            ],
          ),
        ),
      ),
    );
  }

  /**
   * The external-signals section, pinned below ANNOTATIONS. One entry: pick it,
   * click the desk, and a signal button lands on the viewport's right-edge
   * rail. It goes DISABLED once every digit key has a signal (`MAX_SIGNALS`) —
   * a disabled row that says why beats a click that silently does nothing.
   */
  #appendSignals() {
    const collapsed = this.#collapsed.has(SIGNALS_FOLDER);
    this.#signalItem = el(
      "button",
      {
        class: "palette-signal-item",
        type: "button",
        dataset: { signal: "signal" },
        onClick: () => this.#onPickSignal?.(),
      },
      [
        el("span", { class: "palette-item-id", text: "⚑" }),
        el("span", {
          class: "palette-item-title",
          text: t("palette.signal.item"),
        }),
      ],
    );
    this.setSignalsFull(this.#signalsFull);
    // Output (←, pointing OUT of its label: it leaves the board) and Input
    // (→, pointing IN: it comes in) — the arrows the element's rail card
    // carries too.
    this.#integrationItems = [
      ["output", "←"],
      ["input", "→"],
    ].map(([kind, glyph]) =>
      el(
        "button",
        {
          class: "palette-signal-item palette-integration-item",
          type: "button",
          dataset: { integration: kind },
          onClick: () => this.#onPickIntegration?.(kind),
        },
        [
          el("span", { class: "palette-item-id", text: glyph }),
          el("span", {
            class: "palette-item-title",
            text: t(`palette.integration.${kind}`),
          }),
        ],
      ),
    );
    this.setIntegrationsFull(this.#integrationsFull);
    this.#list.append(
      this.#sectionHeader("palette-signals-folder", SIGNALS_FOLDER, collapsed),
      el("div", { class: "palette-group-items", hidden: collapsed }, [
        this.#signalItem,
        ...this.#integrationItems,
      ]),
    );
  }

  /** Is the rail full of Output/Input elements? Both rows go disabled and say
      why, as the signal row does. */
  setIntegrationsFull(full) {
    this.#integrationsFull = Boolean(full);
    for (const item of this.#integrationItems) {
      const kind = item.dataset.integration;
      item.disabled = this.#integrationsFull;
      item.title = this.#integrationsFull
        ? t("palette.integration.full")
        : t(`palette.integration.${kind}Hint`);
    }
  }

  /**
   * Every digit key taken? One signal per key is the cap — and a disabled row
   * that says why beats a click that silently does nothing. A targeted toggle
   * rather than a re-render because app.js calls it on every doc change and the
   * list is long.
   */
  setSignalsFull(full) {
    this.#signalsFull = Boolean(full);
    if (!this.#signalItem) return;
    this.#signalItem.disabled = this.#signalsFull;
    this.#signalItem.title = this.#signalsFull
      ? t("palette.signal.full", { count: MAX_SIGNALS })
      : t("palette.signal.hint");
  }

  /**
   * The board selector, pinned at the top of the palette: the assembled
   * breadboards (Full / Half / Tiny) then the loose strips (bare pin-boards +
   * power rails). Each entry arms board placement via onPickBoard — the same
   * kit keys the old header split-button used.
   */
  #appendBoards() {
    const collapsed = this.#collapsed.has(BOARDS_FOLDER);
    const item = (key) => {
      const kit = BREADBOARD_KITS[key];
      // A kit made purely of rails can stand on end as a signal bus (R spins
      // the ghost) — flag it in the tooltip, or nobody finds R.
      const rotates = kit.strips.every((s) => canRotate(s.type));
      const label = kitLabel(key, kit);
      return el(
        "button",
        {
          class: "palette-board-item",
          type: "button",
          title: rotates
            ? t("palette.board.titleRotates", {
                label,
                points: kit.tiePoints,
              })
            : t("palette.board.title", { label, points: kit.tiePoints }),
          dataset: { kit: key },
          onClick: () => this.#onPickBoard?.(key),
        },
        [
          el("span", { class: "palette-item-id", text: String(kit.tiePoints) }),
          el("span", { class: "palette-item-title", text: label }),
        ],
      );
    };
    this.#list.append(
      this.#sectionHeader("palette-boards-folder", BOARDS_FOLDER, collapsed),
      el("div", { class: "palette-boards-items", hidden: collapsed }, [
        ...KIT_KEYS.map(item),
        ...STRIP_KIT_KEYS.map(item),
      ]),
    );
  }

  /** A collapsible section header (folder or group). `name` is the IDENTITY —
      the collapse-state key `#toggleGroup` is called with — and the label shown
      is its translation, so a language change cannot make a section forget
      whether it was open. The caret glyph is a CSS pseudo-element.

      A TOP-LEVEL section's header carries its icon between the caret and the
      label: the glyph its button on the shut tray's rail shows, so the two
      read as the same thing. `label` overrides the shown text when the
      identity is not a translatable name (`CD4000/NAND`, a family). */
  #sectionHeader(baseClass, name, collapsed, label = sectionLabel(name)) {
    const key = RAIL_SECTIONS.find((s) => s.id === name)?.key;
    let icon = null;
    if (key) {
      icon = el("span", {
        class: "palette-section-icon",
        "aria-hidden": "true",
      });
      icon.innerHTML = SECTION_ICONS[key];
    }
    return el(
      "button",
      {
        class: collapsed ? `${baseClass} ${baseClass}--collapsed` : baseClass,
        type: "button",
        "aria-expanded": collapsed ? "false" : "true",
        dataset: { section: name },
        onClick: () => this.#toggleGroup(name),
      },
      [
        el("span", { class: "palette-group-caret", "aria-hidden": true }),
        icon,
        el("span", {
          class: "palette-group-label",
          text: label,
        }),
      ].filter(Boolean),
    );
  }

  /**
   * The sentence the tray shows when the filter matched NOTHING it is showing
   * but did match parts of a hidden family — so "4011" in 74LS mode says where
   * the CD4011B is rather than "No matches". Null when no hidden part matched.
   * The switch lives in Settings, not the tray, which is why this has to.
   * @param {object[]} matching - every def the filter matched, shown or not.
   * @returns {string|null}
   */
  #hiddenFamilyHint(matching) {
    if (!this.#filter.trim()) return null;
    const hidden = matching.filter((def) => familyOf(def));
    if (hidden.length === 0) return null;
    const family = familyOf(hidden[0]);
    return hidden.length === 1
      ? t("palette.hiddenFamilyOne", { part: hidden[0].id, family })
      : t("palette.hiddenFamilyMany", { count: hidden.length, family });
  }

  /**
   * Fold the family-keyed chip groups into the CHIPS folder's children: in
   * Combined mode one family folder per family (in tray order, empty ones
   * omitted) holding its groups, then the family-less groups; otherwise the
   * groups as they are.
   * @param {Array<{key,group,family,members}>} chipGroups
   */
  #withFamilyTier(chipGroups) {
    if (!chipGroups.some((g) => g.family)) return chipGroups;
    const children = [];
    for (const family of LOGIC_FAMILIES) {
      const groups = chipGroups.filter((g) => g.family === family);
      if (groups.length) children.push({ key: family, family, groups });
    }
    return [...children, ...chipGroups.filter((g) => !g.family)];
  }

  /** Append a top-level folder (CHIPS / COMPONENTS) wrapping its sub-groups. A
      no-op when it has no groups (e.g. the filter hid them all). A child with
      `groups` is a family folder (Combined mode), nesting its own groups; one
      with `custom` is the CUSTOM folder, the project's own chips. */
  #appendFolder(folderName, groupEntries, filtering) {
    if (groupEntries.length === 0) return;
    const collapsed = !filtering && this.#collapsed.has(folderName);
    this.#list.append(
      this.#sectionHeader("palette-folder", folderName, collapsed),
    );
    const body = el("div", {
      class: "palette-folder-groups",
      hidden: collapsed,
    });
    for (const entry of groupEntries) {
      if (entry.custom) this.#appendCustom(body, entry.custom, filtering);
      else if (entry.groups) this.#appendFamily(body, entry, filtering);
      else {
        this.#appendGroup(
          body,
          entry.group,
          entry.members,
          filtering,
          entry.key,
        );
      }
    }
    this.#list.append(body);
  }

  /** Append one family folder (Combined mode) and its function groups. Its
      label is the family's name, which is a part-number prefix and is never
      translated. */
  #appendFamily(container, { key, family, groups }, filtering) {
    const collapsed = !filtering && this.#collapsed.has(key);
    const header = this.#sectionHeader("palette-group", key, collapsed, family);
    header.classList.add("palette-family");
    const body = el("div", {
      class: "palette-folder-groups",
      hidden: collapsed,
    });
    for (const entry of groups) {
      this.#appendGroup(body, entry.group, entry.members, filtering, entry.key);
    }
    container.append(header, body);
  }

  /** Append one group's header + item list to `container`. `key` is the
      section's identity when it differs from the group's name (a family's own
      copy of a group in Combined mode). */
  #appendGroup(container, group, members, filtering, key = group) {
    const collapsed = !filtering && this.#collapsed.has(key);
    const header = this.#sectionHeader(
      "palette-group",
      key,
      collapsed,
      sectionLabel(group),
    );
    // A group of limited parts says so beside its name: the app's (i) in
    // red, whose tooltip is the explanation. A mark, not a control — the
    // header is already the button that folds the group. Not under Spice
    // Lite, which simulates what the note says is missing.
    if (LIMITED_GROUPS.has(group) && !this.#spiceLite) {
      header.append(
        buildInfoMark({ label: t("palette.limitedNote"), variant: "danger" }),
      );
    }
    container.append(
      header,
      el(
        "div",
        { class: "palette-group-items", hidden: collapsed },
        members.map((def) =>
          el(
            "button",
            {
              class: "palette-item",
              type: "button",
              // The blurb is the part's DATASHEET prose and stays English (see
              // CLAUDE.md → "Language support"); its title is translated.
              title: def.blurb,
              dataset: { ref: def.id },
              onClick: (e) => this.#onPickChip?.(def.id, e),
            },
            [
              el("span", { class: "palette-item-id", text: def.id }),
              el("span", {
                class: "palette-item-title",
                text: partTitle(def),
              }),
            ],
          ),
        ),
      ),
    );
  }

  /**
   * Re-render in the new language (see app.js's `relabelChrome`). The tray's
   * whole body is derived from the catalog on every `#render()`, so the list
   * needs nothing but a redraw — only the header and rail controls, which are
   * built once in the constructor, have to be relabelled by hand.
   */
  relocalize() {
    const mod = modKey();
    this.#filterInput.placeholder = t("palette.filterPlaceholder");
    this.#filterInput.setAttribute("aria-label", t("palette.filter"));
    const collapse = this.#el.querySelector(".palette-collapse");
    collapse.title = t("palette.hideTitle", { mod });
    collapse.setAttribute("aria-label", t("palette.hide"));
    this.#resize.title = t("palette.resize");
    this.#el.setAttribute("aria-label", t("palette.label"));
    this.#reopen.title = t("palette.showTitle", { mod });
    this.#reopen.setAttribute("aria-label", t("palette.show"));
    this.#rail.relocalize();
    this.#render();
  }

  /** A header was clicked. Closing is always just that; OPENING, with
      auto-close on, also shuts every section not on the way to this one. */
  #toggleGroup(group) {
    if (!this.#collapsed.has(group)) this.#collapsed.add(group);
    else if (this.#autoClose) this.#openOnly(group);
    else this.#collapsed.delete(group);
    this.#render();
  }
}

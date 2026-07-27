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

// palette-panel.js — the left parts palette: the board selector pinned at the
// top (complete breadboards + loose pin-boards / power rails), then chips,
// discrete parts, and power bricks grouped by function, with a filter box
// matching id/title/blurb. Clicking an entry arms placement mode (reported via
// the constructor callback with the click event, so app.js can pop the LED
// color swatches — the ghost belongs to DeskController).
//
// The tray carries its OWN open/close control rather than a toolbar button:
// a chevron in the header's top-right corner shuts it, and a flap pinned to
// the desk's left edge — the same vertical line, so the control reads as one
// thing sliding into the wall — opens it again. The flap floats over the desk
// (the `.project-tabs` shape), so a closed tray costs no layout width at all.

import { clear, el } from "../dom.js";
import { PALETTE_DEFS } from "../catalog/index.js";
import {
  BREADBOARD_KITS,
  KIT_KEYS,
  STRIP_KIT_KEYS,
} from "../model/board-types.js";
import { canRotate } from "../model/breadboard.js";
import { hasBehavior } from "../sim/chip-eval.js";

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
    appearance, which reads oddly; this is the intended shelf order). */
const COMPONENT_ORDER = [
  "Switches",
  "Resistors",
  "LEDs",
  "Displays",
  "Oscillators",
  "Power",
];

/** The board selector's foldable section name (pinned at the top). Folds like
    any section, and starts shut with the rest. */
const BOARDS_FOLDER = "BOARDS";

/** The annotations section pinned at the BOTTOM (labels + notes). Not catalog
    parts — hardcoded here like the boards folder — so it folds like any
    section and is hidden while the parts filter is active. */
const ANNOTATIONS_FOLDER = "ANNOTATIONS";
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
/** › — opening pulls it back out over the desk. */
const CHEVRON_RIGHT = chevron("9 6 15 12 9 18");

/** The platform-correct modifier glyph for the toggle's tooltips. Read when the
    panel is built, not at import: the jsdom tests install `window` after the
    module graph has already loaded. */
function modKey() {
  return globalThis.window?.chiphippo?.platform === "darwin" ? "⌘" : "Ctrl";
}

const ANNOTATION_KINDS = [
  { kind: "label", glyph: "T", label: "Label", hint: "a one-line caption" },
  { kind: "note", glyph: "≡", label: "Note", hint: "a multi-line note box" },
];

/**
 * Every collapsible section name — the boards folder, the chips folder, the
 * annotations folder, and every group in the catalog. The palette opens with
 * ALL of them shut: the full list is long enough that a wall of parts buries
 * the structure, and the filter box is the fast path to a specific one anyway.
 */
function allSections() {
  return new Set([
    BOARDS_FOLDER,
    CHIPS_FOLDER,
    COMPONENTS_FOLDER,
    ANNOTATIONS_FOLDER,
    ...PALETTE_DEFS.map((def) => def.group),
  ]);
}

export class PalettePanel {
  #el;
  #list;
  #container;
  #flap;
  #onPickChip;
  #onPickBoard;
  #onPickAnnotation;
  #filter = "";
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
   * @param {(kind: "label"|"note") => void} callbacks.onPickAnnotation - a
   *   label/note was picked; app.js arms annotation placement.
   * @param {() => void} callbacks.onToggle - the header chevron or the
   *   desk-edge flap was clicked. The panel does NOT flip itself: app.js owns
   *   the one toggle that also persists `paletteOpen`, exactly as the ⌘P
   *   shortcut does.
   */
  constructor(
    container,
    { onPickChip, onPickBoard, onPickAnnotation, onToggle } = {},
  ) {
    this.#container = container;
    this.#onPickChip = onPickChip;
    this.#onPickBoard = onPickBoard;
    this.#onPickAnnotation = onPickAnnotation;

    const filterInput = el("input", {
      class: "palette-filter",
      type: "search",
      placeholder: "Filter parts…",
      "aria-label": "Filter parts",
      onInput: (e) => {
        this.#filter = e.target.value;
        this.#render();
      },
    });

    const mod = modKey();
    const collapseBtn = el("button", {
      class: "palette-collapse",
      type: "button",
      title: `Hide the parts tray (${mod}+P)`,
      "aria-label": "Hide the parts tray",
      onClick: () => onToggle?.(),
    });
    collapseBtn.innerHTML = CHEVRON_LEFT;

    this.#list = el("div", { class: "palette-list" });
    this.#el = el(
      "aside",
      { class: "palette-panel", "aria-label": "Parts palette", hidden: true },
      [
        el("div", { class: "palette-header" }, [filterInput, collapseBtn]),
        this.#list,
      ],
    );

    // The reopen flap: a sibling of the tray, not a child — the tray itself is
    // display:none when shut. It floats over the desk's left edge on the same
    // line as the header chevron above, so the two read as one control.
    this.#flap = el("button", {
      class: "palette-flap",
      type: "button",
      title: `Show the parts tray (${mod}+P)`,
      "aria-label": "Show the parts tray",
      onClick: () => onToggle?.(),
    });
    this.#flap.innerHTML = CHEVRON_RIGHT;

    container.append(this.#el, this.#flap);
    this.#render();
  }

  get element() {
    return this.#el;
  }

  get visible() {
    return !this.#el.hidden;
  }

  setVisible(on) {
    this.#el.hidden = !on;
    // Exactly one of the two chevrons is ever showing.
    this.#flap.hidden = !!on;
    // The flap overlays the desk's top-left corner, which is where the
    // desktop tab strip starts — the modifier insets the tabs past it.
    this.#container?.classList.toggle("app-main--tray-closed", !on);
  }

  #matches(def) {
    const q = this.#filter.trim().toLowerCase();
    if (!q) return true;
    return [def.id, def.title, def.blurb].some((s) =>
      s.toLowerCase().includes(q),
    );
  }

  #render() {
    clear(this.#list);
    // While a filter is active, force everything open so matches stay visible;
    // the remembered collapse state only governs the unfiltered list.
    const filtering = this.#filter.trim() !== "";
    // The board selector is pinned at the very top of the palette; the filter
    // box targets the parts list below, so hide the boards while filtering.
    if (!filtering) this.#appendBoards();

    const defs = PALETTE_DEFS.filter((def) => this.#matches(def));
    if (defs.length === 0) {
      this.#list.append(
        el("p", { class: "palette-empty", text: "No matching parts." }),
      );
      return;
    }
    // Group by function, preserving catalog order of first appearance.
    const groups = new Map();
    for (const def of defs) {
      if (!groups.has(def.group)) groups.set(def.group, []);
      groups.get(def.group).push(def);
    }

    // Three top-level buckets: logic chips nest under the CHIPS folder; memory
    // chips are pulled out into their own group below it; every non-chip part
    // nests under the COMPONENTS folder. A group is a chip group when its
    // members are chips (the catalog stamps `kind: "chip"`).
    const chipGroups = [];
    const componentGroups = [];
    let memoryMembers = null;
    for (const [group, members] of groups) {
      if (members[0]?.kind !== "chip") componentGroups.push([group, members]);
      else if (group === MEMORY_GROUP) memoryMembers = members;
      else chipGroups.push([group, members]);
    }
    componentGroups.sort(
      (a, b) => COMPONENT_ORDER.indexOf(a[0]) - COMPONENT_ORDER.indexOf(b[0]),
    );

    // Chips lead, then every other component, then memory (its own group).
    this.#appendFolder(CHIPS_FOLDER, chipGroups, filtering);
    this.#appendFolder(COMPONENTS_FOLDER, componentGroups, filtering);
    if (memoryMembers) {
      this.#appendGroup(this.#list, MEMORY_GROUP, memoryMembers, filtering);
    }

    // Labels + notes live at the very bottom (not catalog parts, so the chip
    // filter hides them, exactly like the boards folder up top).
    if (!filtering) this.#appendAnnotations();
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
        ANNOTATION_KINDS.map(({ kind, glyph, label, hint }) =>
          el(
            "button",
            {
              class: "palette-annotation-item",
              type: "button",
              title: hint,
              dataset: { annotation: kind },
              onClick: () => this.#onPickAnnotation?.(kind),
            },
            [
              el("span", { class: "palette-item-id", text: glyph }),
              el("span", { class: "palette-item-title", text: label }),
            ],
          ),
        ),
      ),
    );
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
      const hint = rotates ? " (R to rotate)" : "";
      return el(
        "button",
        {
          class: "palette-board-item",
          type: "button",
          title: `${kit.label} — ${kit.tiePoints} tie points${hint}`,
          dataset: { kit: key },
          onClick: () => this.#onPickBoard?.(key),
        },
        [
          el("span", { class: "palette-item-id", text: String(kit.tiePoints) }),
          el("span", { class: "palette-item-title", text: kit.label }),
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

  /** A collapsible section header (folder or group), keyed by `name`. The caret
      glyph is a CSS pseudo-element, so textContent stays exactly `name`. */
  #sectionHeader(baseClass, name, collapsed) {
    return el(
      "button",
      {
        class: collapsed ? `${baseClass} ${baseClass}--collapsed` : baseClass,
        type: "button",
        "aria-expanded": collapsed ? "false" : "true",
        onClick: () => this.#toggleGroup(name),
      },
      [
        el("span", { class: "palette-group-caret", "aria-hidden": true }),
        el("span", { class: "palette-group-label", text: name }),
      ],
    );
  }

  /** Append a top-level folder (CHIPS / COMPONENTS) wrapping its sub-groups. A
      no-op when it has no groups (e.g. the filter hid them all). */
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
    for (const [group, members] of groupEntries) {
      this.#appendGroup(body, group, members, filtering);
    }
    this.#list.append(body);
  }

  /** Append one group's header + item list to `container`. */
  #appendGroup(container, group, members, filtering) {
    const collapsed = !filtering && this.#collapsed.has(group);
    container.append(
      this.#sectionHeader("palette-group", group, collapsed),
      el(
        "div",
        { class: "palette-group-items", hidden: collapsed },
        members.map((def) =>
          el(
            "button",
            {
              class: "palette-item",
              type: "button",
              title: def.blurb,
              dataset: { ref: def.id },
              onClick: (e) => this.#onPickChip?.(def.id, e),
            },
            [
              el("span", { class: "palette-item-id", text: def.id }),
              el("span", { class: "palette-item-title", text: def.title }),
              // "sim-ready" badge for chips whose behavior is defined —
              // combinational (Feature 80) or sequential (Feature 100).
              hasBehavior(def) &&
                el("span", {
                  class: "palette-item-badge",
                  text: "sim",
                  title: "Behavior defined — ready for the simulator",
                }),
            ],
          ),
        ),
      ),
    );
  }

  #toggleGroup(group) {
    if (this.#collapsed.has(group)) this.#collapsed.delete(group);
    else this.#collapsed.add(group);
    this.#render();
  }
}

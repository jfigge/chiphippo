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

// chip-package-form.js — the chip designer's package editor: a custom chip's
// part number and description (the universal Name/Description pair every
// Properties card leads with), then what is particular to it — logic family,
// body width, pins per side, how many units, the power pins, and the module's
// PORTS, each row carrying its PIN MAP: which pin every bit of it is on, in
// every unit. A bus's bits are listed under its row, one per line.
//
// The pin columns grow with the units, so the table scrolls SIDEWAYS on its
// own when the pane is too narrow for them — the port's name, direction and
// width stay put at the left, and its remove button at the right, while the
// pins slide between (the window's divider gives the package more room).
// Built on the Properties dialog's own row classes, so it reads as one. (The
// rule a Properties card draws after the pair is the window's instead: the
// line between the package drawing, which stays put, and this form, which
// scrolls under it.)
//
// It edits a COPY: every change produces a new chip record (through the pure
// helpers in model/custom-chip.js) and reports it (`onChange`); the host owns
// the project and answers with the chip as it now stands. A package that is
// PLACED keeps its size and width (its pins are in holes), so those two are
// greyed with the reason beside them.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { buildSegmented } from "./segmented-picker.js";
import { buildInfoButton } from "./info-button.js";
import {
  CUSTOM_FAMILIES,
  MAX_PER_SIDE,
  MAX_PORT_WIDTH,
  MAX_UNITS,
  MIN_PER_SIDE,
  autoAssign,
  bitLabel,
  isValidPartName,
  resizeCustomChip,
  setPorts,
  setUnitCount,
} from "../model/custom-chip.js";

/** Ids for the note cards, which their (i)'s `aria-controls` points at. */
let noteSeq = 0;

export class ChipPackageForm {
  #root;
  #placed = 0;
  #onChange;
  #rendered = ""; // the chip + flags the form was last drawn for
  #openNote = null; // the row label whose note is open, kept across redraws

  /** @param {{onChange: (chip: object) => void}} opts */
  constructor({ onChange }) {
    this.#onChange = onChange;
    this.#root = el("div", { class: "cd-form" });
  }

  get element() {
    return this.#root;
  }

  /**
   * Show a chip. Redrawn only when something it shows changed — and with
   * the focus and caret put back, since the host answers every edit with the
   * chip as it now stands and a redraw must not take the field being typed in.
   * @param {object|null} chip
   * @param {{placed?: number, readOnly?: boolean}} [opts]
   */
  render(chip, { placed = 0, readOnly = false } = {}) {
    const key = JSON.stringify([chip, placed, readOnly]);
    if (key === this.#rendered) return;
    this.#rendered = key;
    this.#placed = placed;
    const focused = this.#root.contains(document.activeElement)
      ? document.activeElement
      : null;
    const field = focused?.dataset?.field ?? null;
    const caret = focused && "selectionStart" in focused ? [focused.selectionStart, focused.selectionEnd] : null; // prettier-ignore
    // The ports table scrolls sideways on its own; a redraw (every echo of an
    // edit) must leave it where the reader had it.
    const across = this.#root.querySelector(".cd-ports")?.scrollLeft ?? 0;
    this.#root.replaceChildren(...(chip ? this.#build(chip, readOnly) : []));
    const ports = this.#root.querySelector(".cd-ports");
    if (ports && across) ports.scrollLeft = across;
    this.#root.classList.toggle("cd-form--readonly", readOnly);
    // A redraw (every echo of an edit is one) must not shut a note that is
    // being read: open it again, through its own button, so its dismissal
    // listeners come with it.
    if (this.#openNote) {
      const again = [...this.#root.querySelectorAll(".cd-row .info-btn")].find(
        (b) => b.dataset.note === this.#openNote,
      );
      if (again) again.click();
      else this.#openNote = null;
    }
    if (field) {
      const again = this.#root.querySelector(`[data-field="${CSS.escape(field)}"]`); // prettier-ignore
      if (again) {
        again.focus({ preventScroll: true });
        if (caret && "setSelectionRange" in again) {
          try {
            again.setSelectionRange(caret[0], caret[1]);
          } catch {
            // A <select> or a number input has no caret to restore.
          }
        }
      }
    }
  }

  #emit(next) {
    this.#onChange?.(next);
  }

  #build(chip, readOnly) {
    const nodes = [];
    // The universal pair: part number, description.
    const nameInput = el("input", {
      class: "cd-input",
      type: "text",
      value: chip.name,
      maxLength: 16,
      disabled: readOnly,
      dataset: { field: "name" },
      "aria-label": t("chipdesign.form.name"),
    });
    const nameError = el("div", { class: "cd-field-error", hidden: true });
    nameInput.addEventListener("change", () => {
      const value = nameInput.value.trim();
      if (!isValidPartName(value)) {
        nameError.textContent = t("chipdesign.form.nameInvalid");
        nameError.hidden = false;
        nameInput.setAttribute("aria-invalid", "true");
        return;
      }
      nameError.hidden = true;
      nameInput.removeAttribute("aria-invalid");
      this.#emit({ ...chip, name: value });
    });
    nodes.push(this.#row(t("chipdesign.form.name"), [nameInput, nameError]));
    const desc = el("input", {
      class: "cd-input",
      type: "text",
      value: chip.description,
      maxLength: 200,
      disabled: readOnly,
      dataset: { field: "description" },
      "aria-label": t("chipdesign.form.description"),
    });
    desc.addEventListener("change", () =>
      this.#emit({ ...chip, description: desc.value.trim() }),
    );
    nodes.push(this.#row(t("chipdesign.form.description"), [desc]));

    // Family and width.
    nodes.push(
      this.#row(
        t("chipdesign.form.family"),
        [
          this.#segmented(
            // A family's name is a part-number prefix, never translated.
            CUSTOM_FAMILIES.map((family) => ({ value: family, label: family })),
            chip.family,
            (family) => this.#emit({ ...chip, family }),
            readOnly,
            t("chipdesign.form.family"),
          ),
        ],
        t("chipdesign.form.familyNote"),
      ),
    );
    const locked = this.#placed > 0;
    const lockedNote = t("chipdesign.form.lockedPlaced", { count: this.#placed }); // prettier-ignore
    nodes.push(
      this.#row(
        t("chipdesign.form.width"),
        [
          this.#segmented(
            [
              { value: false, label: t("chipdesign.form.width300") },
              { value: true, label: t("chipdesign.form.width600") },
            ],
            chip.wide,
            (wide) => this.#emit({ ...chip, wide }),
            readOnly || locked,
            t("chipdesign.form.width"),
          ),
        ],
        locked ? lockedNote : null,
      ),
    );

    // Pins per side and units.
    const per = el("input", {
      class: "cd-input cd-input--number",
      type: "number",
      min: MIN_PER_SIDE,
      max: MAX_PER_SIDE,
      step: 1,
      value: String(chip.pinsPerSide),
      disabled: readOnly || locked,
      dataset: { field: "pinsPerSide" },
      "aria-label": t("chipdesign.form.pinsPerSide"),
    });
    per.addEventListener("change", () => {
      const n = Number(per.value);
      if (!Number.isInteger(n) || n < MIN_PER_SIDE || n > MAX_PER_SIDE) {
        per.value = String(chip.pinsPerSide);
        return;
      }
      this.#emit(resizeCustomChip(chip, n));
    });
    nodes.push(
      this.#row(
        t("chipdesign.form.pinsPerSide"),
        [
          per,
          el("span", {
            class: "cd-hint",
            text: t("chipdesign.form.pinsTotal", {
              count: chip.pinsPerSide * 2,
            }),
          }),
        ],
        locked ? lockedNote : null,
      ),
    );
    const units = this.#select(
      Array.from({ length: MAX_UNITS }, (_v, i) => [
        String(i + 1),
        String(i + 1),
      ]),
      String(chip.units.length),
      (value) => this.#emit(setUnitCount(chip, Number(value))),
      readOnly,
      "units",
      t("chipdesign.form.units"),
    );
    nodes.push(
      this.#row(
        t("chipdesign.form.units"),
        [units],
        t("chipdesign.form.unitsNote"),
      ),
    );

    // Power pins.
    const pinOptions = (blank) => [
      ...(blank ? [["0", "—"]] : []),
      ...Array.from({ length: chip.pinsPerSide * 2 }, (_v, i) => [String(i + 1), String(i + 1)]), // prettier-ignore
    ];
    nodes.push(
      this.#row(t("chipdesign.form.power"), [
        el("span", { class: "cd-hint", text: chip.family === "CD4000" ? "VDD" : "VCC" }), // prettier-ignore
        this.#select(pinOptions(true), String(chip.vcc), (v) => this.#emit({ ...chip, vcc: Number(v) }), readOnly, "vcc", "VCC"), // prettier-ignore
        el("span", { class: "cd-hint", text: chip.family === "CD4000" ? "VSS" : "GND" }), // prettier-ignore
        this.#select(pinOptions(true), String(chip.gnd), (v) => this.#emit({ ...chip, gnd: Number(v) }), readOnly, "gnd", "GND"), // prettier-ignore
      ]),
    );

    // Ports, each with its pins.
    const head = el("div", { class: "cd-subhead-row" }, [
      el("h3", { class: "cd-subhead", text: t("chipdesign.form.ports") }),
      el("button", {
        class: "cd-button",
        type: "button",
        text: t("chipdesign.form.autoAssign"),
        title: t("chipdesign.form.autoAssignHint"),
        disabled: readOnly,
        onClick: () => this.#emit(autoAssign(chip)),
      }),
    ]);
    nodes.push(head, ...this.#portsTable(chip, readOnly, pinOptions(true)));
    return nodes;
  }

  /**
   * The ports, one row each — name, direction, width, then the pin each unit
   * puts it on, then its remove button — and under a bus, a row per bit with
   * that bit's pins. The pin columns sit in a sideways scroller between the
   * port and its remove button (both `position: sticky` in app.css).
   */
  #portsTable(chip, readOnly, options) {
    const pinCells = (port, bit) =>
      chip.units.map((map, u) =>
        this.#select(
          options,
          String(map[port.name]?.[bit] ?? 0),
          (value) => {
            const units = chip.units.map((m, k) => {
              if (k !== u) return m;
              const pins = [...(m[port.name] ?? [])];
              pins[bit] = Number(value);
              return { ...m, [port.name]: pins };
            });
            this.#emit({ ...chip, units });
          },
          readOnly,
          `map-${u}-${port.name}-${bit}`,
          t("chipdesign.form.mapCell", {
            unit: u + 1,
            name: bitLabel(port, bit),
          }),
        ),
      );
    const blankPins = () => chip.units.map(() => el("span"));
    const rows = [];
    chip.ports.forEach((port, i) => {
      const name = el("input", {
        class: "cd-input cd-input--port",
        type: "text",
        value: port.name,
        maxLength: 32,
        disabled: readOnly,
        dataset: { field: `port-${i}` },
        "aria-label": t("chipdesign.form.portName"),
      });
      name.addEventListener("change", () => {
        const value = name.value.trim();
        if (!value || value === port.name) {
          name.value = port.name;
          return;
        }
        this.#emit(
          setPorts(
            chip,
            chip.ports.map((p, k) => (k === i ? { ...p, name: value, from: p.name } : p)), // prettier-ignore
          ),
        );
      });
      const dir = this.#select(
        [
          ["input", t("chipdesign.form.dirInput")],
          ["output", t("chipdesign.form.dirOutput")],
          ["inout", t("chipdesign.form.dirInout")],
        ],
        port.dir,
        (value) =>
          this.#emit(
            setPorts(chip, chip.ports.map((p, k) => (k === i ? { ...p, dir: value } : p))), // prettier-ignore
          ),
        readOnly,
        `port-dir-${i}`,
        t("chipdesign.form.portDir"),
      );
      const width = this.#select(
        Array.from({ length: MAX_PORT_WIDTH }, (_v, k) => [String(k + 1), String(k + 1)]), // prettier-ignore
        String(port.width),
        (value) =>
          this.#emit(
            setPorts(chip, chip.ports.map((p, k) => (k === i ? { ...p, width: Number(value) } : p))), // prettier-ignore
          ),
        readOnly,
        `port-width-${i}`,
        t("chipdesign.form.portWidth"),
      );
      const remove = el("button", {
        class: "cd-icon-button",
        type: "button",
        text: "×",
        title: t("chipdesign.form.removePort", { name: port.name }),
        "aria-label": t("chipdesign.form.removePort", { name: port.name }),
        disabled: readOnly,
        onClick: () =>
          this.#emit(
            setPorts(
              chip,
              chip.ports.filter((_p, k) => k !== i),
            ),
          ),
      });
      const bus = port.width > 1;
      rows.push(
        el("div", { class: "cd-port-row" }, [
          el("div", { class: "cd-port-cell cd-port-cell--port" }, [name, dir, width]), // prettier-ignore
          ...(bus ? blankPins() : pinCells(port, 0)),
          el("div", { class: "cd-port-cell cd-port-cell--remove" }, [remove]),
        ]),
      );
      if (!bus) return;
      for (let bit = 0; bit < port.width; bit++) {
        rows.push(
          el("div", { class: "cd-port-row cd-port-row--bit" }, [
            el("div", { class: "cd-port-cell cd-port-cell--port" }, [
              el("span", {
                class: `cd-map-port cd-map-port--${port.dir}`,
                text: bitLabel(port, bit),
              }),
            ]),
            ...pinCells(port, bit),
            el("div", { class: "cd-port-cell cd-port-cell--remove" }),
          ]),
        );
      }
    });
    const add = el("button", {
      class: "cd-button",
      type: "button",
      text: t("chipdesign.form.addPort"),
      disabled: readOnly,
      onClick: () => {
        const taken = new Set(chip.ports.map((p) => p.name));
        let n = 1;
        while (taken.has(`P${n}`)) n += 1;
        this.#emit(
          autoAssign(
            setPorts(chip, [...chip.ports, { name: `P${n}`, dir: "input", width: 1 }]), // prettier-ignore
          ),
        );
      },
    });
    // One unit: its column is just the pin. Several: each is named.
    const unitHeads = chip.units.map((_m, u) =>
      el("span", {
        class: "cd-port-unit",
        text:
          chip.units.length > 1
            ? t("chipdesign.form.unit", { n: u + 1 })
            : t("chipdesign.form.pinColumn"),
      }),
    );
    const table = el("div", { class: "cd-port-table" }, [
      el("div", { class: "cd-port-row cd-port-row--head" }, [
        el("div", { class: "cd-port-cell cd-port-cell--port" }, [
          el("span", { class: "cd-port-head-name", text: t("chipdesign.form.portName") }), // prettier-ignore
          el("span", { class: "cd-port-head-dir", text: t("chipdesign.form.portDir") }), // prettier-ignore
          el("span", { class: "cd-port-head-width", text: t("chipdesign.form.portWidth") }), // prettier-ignore
        ]),
        ...unitHeads,
        el("div", { class: "cd-port-cell cd-port-cell--remove" }),
      ]),
      ...rows,
    ]);
    // The column count is ONE custom property on the table, which every row
    // inherits (a custom property needs `setProperty`; `style` objects can't
    // hold one).
    table.style.setProperty("--cd-units", chip.units.length);
    return [el("div", { class: "cd-ports" }, [table]), add];
  }

  /**
   * A label and its controls. A NOTE — why a field is what it is, or why it
   * cannot change — goes behind an (i) at the end of the controls, as in
   * Settings: worth having, not worth a line under every row. The card floats
   * over the rows below rather than pushing them down (info-button.js).
   */
  #row(label, controls, note = null) {
    let info = null;
    let card = null;
    if (note) {
      card = el(
        "div",
        { class: "cd-note", id: `cd-note-${++noteSeq}`, role: "note", hidden: true }, // prettier-ignore
        [el("p", { class: "cd-note-text", text: note })],
      );
      info = buildInfoButton({
        target: card,
        label: t("chipdesign.form.noteToggle", { label }),
        onToggle: (shown) => {
          if (shown) this.#openNote = label;
          else if (this.#openNote === label) this.#openNote = null;
        },
      });
      info.dataset.note = label;
    }
    return el("div", { class: "cd-row" }, [
      el("span", { class: "cd-label", text: label }),
      el("div", { class: "cd-row-controls" }, [...controls, info].filter(Boolean)), // prettier-ignore
      card,
    ]);
  }

  #segmented(options, value, onPick, disabled, label) {
    const picker = buildSegmented({ options, value, onPick, ariaLabel: label });
    if (disabled) {
      for (const b of picker.querySelectorAll("button")) b.disabled = true;
    }
    return picker;
  }

  #select(options, value, onPick, disabled, field, label) {
    const select = el(
      "select",
      {
        class: "cd-select",
        disabled,
        dataset: { field },
        "aria-label": label,
      },
      options.map(([v, text]) => el("option", { value: v, text })),
    );
    select.value = value;
    select.addEventListener("change", () => onPick(select.value));
    return select;
  }
}

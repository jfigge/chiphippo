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

// chip-pinout.js — draws a part's pin/terminal map as a wiring reference,
// rendered into the standalone pin-assignments OS window (web/pinout.html),
// opened by double-clicking ANY component. Three layouts, one per catalog
// shape: DIP chips (`buildChipPinout` — the physical two-column layout, notch
// at top, pin 1 top-left wrapping to pin N top-right); discrete parts
// (`buildDiscretePinout` — a linear list keyed to the anchor-hole offsets); and
// desk-level bricks with terminals (`buildTerminalPinout` — PSU / clock). Pure
// DOM from the catalog def — no electrical logic, no modal chrome (the native
// window frame owns the title bar + close).

import { el } from "../dom.js";

/** A line-drawn document (file + text lines) glyph for the "open datasheet
    PDF" header button — a datasheet reads as a spec sheet, not a book. */
const DATASHEET_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
  '<polyline points="14 2 14 8 20 8"/>' +
  '<line x1="16" y1="13" x2="8" y2="13"/>' +
  '<line x1="16" y1="17" x2="8" y2="17"/>' +
  '<polyline points="10 9 9 9 8 9"/>' +
  "</svg>";

/**
 * The header "open datasheet PDF" button (a line-drawn book), shown top-right
 * of the pinout window when the user's datasheet folder holds a PDF for this
 * part. Pure DOM + a callback — the bridge call that actually opens the PDF is
 * wired by the caller (pinout.js), keeping this module electrical-logic-free.
 * @param {() => void} onOpen - invoked on click.
 * @returns {HTMLButtonElement}
 */
export function datasheetButton(onOpen) {
  const btn = el("button", {
    class: "pinout-datasheet-btn",
    type: "button",
    title: "Open the datasheet PDF",
    "aria-label": "Open the datasheet PDF",
    onClick: () => onOpen?.(),
  });
  btn.innerHTML = DATASHEET_SVG;
  return btn;
}

/** Short role tag shown beside each pin/terminal name. */
const ROLE_TAG = Object.freeze({
  input: "in",
  output: "out",
  io: "I/O",
  vcc: "pwr",
  gnd: "gnd",
  nc: "n/c",
  anode: "anode",
  cathode: "cathode",
  contact: "contact",
  common: "common",
});

/** Descriptions for desk-brick terminals (no board pins — labelled by id). */
const TERMINAL_INFO = Object.freeze({
  psu: {
    "+": { name: "+V", role: "vcc", detail: "positive supply rail" },
    "-": { name: "GND", role: "gnd", detail: "0 V return / ground" },
  },
  clock: {
    out: { name: "OUT", role: "output", detail: "square-wave clock signal" },
    gnd: { name: "GND", role: "gnd", detail: "ground reference" },
  },
  lcd: {
    VSS: { name: "VSS", role: "gnd", detail: "0 V ground" },
    VDD: { name: "VDD", role: "vcc", detail: "+5 V supply" },
    V0: { name: "V0", role: "nc", detail: "contrast (cosmetic here)" },
    RS: {
      name: "RS",
      role: "input",
      detail: "register select — 0 cmd / 1 data",
    },
    RW: { name: "R/W", role: "input", detail: "0 = write, 1 = read" },
    E: {
      name: "E",
      role: "input",
      detail: "enable strobe — latches on falling edge",
    },
    DB0: { name: "DB0", role: "io", detail: "data bus bit 0 (LSB)" },
    DB1: { name: "DB1", role: "io", detail: "data bus bit 1" },
    DB2: { name: "DB2", role: "io", detail: "data bus bit 2" },
    DB3: { name: "DB3", role: "io", detail: "data bus bit 3" },
    DB4: {
      name: "DB4",
      role: "io",
      detail: "data bus bit 4 (low nibble in 4-bit mode)",
    },
    DB5: { name: "DB5", role: "io", detail: "data bus bit 5" },
    DB6: { name: "DB6", role: "io", detail: "data bus bit 6" },
    DB7: {
      name: "DB7",
      role: "io",
      detail: "data bus bit 7 (MSB / busy flag)",
    },
    A: { name: "A", role: "nc", detail: "backlight anode (cosmetic here)" },
    K: { name: "K", role: "nc", detail: "backlight cathode (cosmetic here)" },
  },
});

/** The offset of a discrete pin from its anchor hole, as a label. */
const offsetLabel = (offset) =>
  offset === 0 ? "anchor hole" : `+${offset} hole${offset === 1 ? "" : "s"}`;

/** The role-colored name span (label + short role tag). */
function nameSpan(name, role) {
  return el("span", { class: `chip-pinout-name chip-pinout-name--${role}` }, [
    el("span", { class: "chip-pinout-label", text: name }),
    el("span", { class: "chip-pinout-role", text: ROLE_TAG[role] ?? role }),
  ]);
}

/** The outer popup shell: header (id · title) + subtitle + body [+ extra]. */
function pinoutShell(def, subtitle, body, extra) {
  return el(
    "div",
    {
      class: "popup chip-pinout",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": `${def.id} pin assignments`,
    },
    [
      el("div", { class: "popup-header" }, [
        el("span", { class: "popup-title", text: `${def.id} · ${def.title}` }),
      ]),
      el("div", { class: "chip-pinout-sub", text: subtitle }),
      body,
      extra,
    ],
  );
}

/**
 * The manufacturer-datasheet figure: the connection diagram / function-table
 * crop for this part, committed to web/datasheets/<id>.png by `make datasheets`.
 * The image loads lazily and the whole figure REMOVES ITSELF if there is no
 * crop for this part (the handful of chips with no datasheet on file), so the
 * caller can add it unconditionally.
 * @param {object} def - a catalog def with an `id`.
 * @returns {HTMLElement}
 */
function datasheetFigure(def) {
  const figure = el("figure", { class: "chip-pinout-datasheet" }, [
    el("figcaption", {
      class: "chip-pinout-datasheet-cap",
      text: "Datasheet — internal diagram & function table",
    }),
    el("img", {
      class: "chip-pinout-datasheet-img",
      src: `datasheets/${encodeURIComponent(def.id)}.png`,
      alt: `${def.id} datasheet connection diagram and function table`,
      loading: "lazy",
      onerror: () => figure.remove(),
    }),
  ]);
  return figure;
}

/** One DIP pin cell: a numbered badge and the role-colored name (mirrored). */
function pinCell(pinDef, side) {
  const badge = el("span", {
    class: "chip-pinout-num",
    text: String(pinDef.n),
  });
  const name = nameSpan(pinDef.name, pinDef.role);
  return el("div", { class: `chip-pinout-pin chip-pinout-pin--${side}` }, [
    side === "left" ? badge : name,
    side === "left" ? name : badge,
  ]);
}

/**
 * DIP chip layout: pin 1 top-left down the left side, wrapping up the right
 * side to pin N top-right, with the notch cue at the top of the body.
 * @param {object} def - a catalog chip def ({ id, title, package, pins }).
 * @returns {HTMLElement}
 */
export function buildChipPinout(def) {
  const byPin = new Map(def.pins.map((p) => [p.n, p]));
  const count = def.pins.length;
  const half = count / 2;

  const rows = [];
  for (let i = 1; i <= half; i++) {
    rows.push(
      el("div", { class: "chip-pinout-row" }, [
        pinCell(byPin.get(i), "left"),
        el("div", { class: "chip-pinout-body" }),
        pinCell(byPin.get(count + 1 - i), "right"),
      ]),
    );
  }

  return pinoutShell(
    def,
    `${def.package} · pin assignments`,
    el("div", { class: "chip-pinout-dip" }, [
      el("div", { class: "chip-pinout-notch", "aria-hidden": "true" }),
      el("div", { class: "chip-pinout-grid" }, rows),
    ]),
    datasheetFigure(def),
  );
}

/** One row of the single-column list layout (badge · name/role · detail). */
function listRow({ tag, name, role, detail }) {
  return el(
    "div",
    { class: "part-pinout-line" },
    [
      el("span", { class: "chip-pinout-num", text: String(tag) }),
      nameSpan(name, role),
      detail && el("span", { class: "part-pinout-detail", text: detail }),
    ].filter(Boolean),
  );
}

/**
 * Discrete part layout: a linear list of pins keyed to their anchor-hole
 * offsets (a discrete seats along one grid row, pin 1 at the anchor).
 * @param {object} def - a discrete def ({ id, title, pins, footprint }).
 * @returns {HTMLElement}
 */
export function buildDiscretePinout(def) {
  const offsets = def.footprint.offsets;
  const span = offsets[offsets.length - 1] + 1;
  const rows = def.pins.map((p, i) =>
    listRow({
      tag: p.n,
      name: p.name,
      role: p.role,
      detail: offsetLabel(offsets[i]),
    }),
  );
  return pinoutShell(
    def,
    `${span} holes along one grid row · pin assignments`,
    el("div", { class: "part-pinout-list" }, rows),
  );
}

/**
 * Desk-brick layout (PSU / clock): a list of terminals with descriptions.
 * @param {object} def - a def with `terminals` ({ id, title, terminals }).
 * @returns {HTMLElement}
 */
export function buildTerminalPinout(def) {
  const info = TERMINAL_INFO[def.id] ?? {};
  const rows = def.terminals.map((t) => {
    const meta = info[t.id] ?? { name: t.id, role: "input", detail: "" };
    return listRow({
      tag: t.id,
      name: meta.name,
      role: meta.role,
      detail: meta.detail,
    });
  });
  return pinoutShell(
    def,
    "terminal assignments",
    el("div", { class: "part-pinout-list" }, rows),
  );
}

/**
 * Build the pin/terminal map for ANY catalog def, dispatching on its shape.
 * @param {object} def
 * @returns {HTMLElement|null}
 */
export function buildPartPinout(def) {
  if (!def) return null;
  if (def.package) return buildChipPinout(def);
  if (def.footprint) return buildDiscretePinout(def);
  if (def.terminals) return buildTerminalPinout(def);
  return null;
}

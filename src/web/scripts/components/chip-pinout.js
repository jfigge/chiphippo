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

/** The outer popup shell: header (id · title) + subtitle + a body element. */
function pinoutShell(def, subtitle, body) {
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
    ],
  );
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

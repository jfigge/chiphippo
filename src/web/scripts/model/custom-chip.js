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

// custom-chip.js — a CUSTOM chip as the project stores it (the chip
// designer), and everything derived from it: its package, its pinout, and the
// problems with either. Pure and DOM-free — the designer window and the main
// renderer both read it, and so does every test.
//
// A custom chip is a PACKAGE (pins per side, body width, logic family, the
// VCC and GND pins) and a MODULE (a port list and a Verilog body, scripts/
// hdl/) joined by a PIN MAP: which physical pin each port bit lands on, for
// each of up to six UNITS — the same module replicated across separate pin
// groups, as a quad NAND is four NANDs. A unit's input may share a pin with
// another unit's (a common clock); an output or an inout never shares.
//
//     { id: "custom-1a2b3c4d", name: "MY74", description,
//       family: "74LS"|"CD4000", pinsPerSide: 7, wide: false,
//       ports: [{name, dir: "input"|"output"|"inout", width}],
//       units: [{ <port>: [pin per bit, LSB first; 0 = not on a pin] }],
//       vcc: 14, gnd: 7, code: "assign Y = ~(A & B);" }
//
// The `id` is the catalog ref every placed instance carries, minted once and
// never changed — renaming the part changes what is printed on it, not what
// the desk calls it. Pin NAMES are derived (the port name, with a unit number
// in front once there are several units), which is what keeps the package and
// the code's names from ever disagreeing.

import { isIdentifier } from "../hdl/lexer.js";
import { MAX_CUSTOM_PINS, MIN_CUSTOM_PINS, packageName } from "./footprints.js";

/** How many units (replicated modules) a package may hold. */
export const MAX_UNITS = 6;
/** The widest port — a vector of pins. */
export const MAX_PORT_WIDTH = 16;
/** The ports one module may have. */
export const MAX_PORTS = 38;
/** How many custom chips one stored list may hold — a project's, or the
    machine's library (app/store/custom-chips.js holds main to the same). */
export const MAX_CUSTOM_CHIPS = 256;
/** A part number's length (it is printed on the package). */
export const MAX_NAME = 16;
/** A description's length. */
export const MAX_DESCRIPTION = 200;
/** A module body's length, in characters. */
export const MAX_CODE = 64 * 1024;
/** Pins per side, from a DIP-4 to a DIP-40. */
export const MIN_PER_SIDE = MIN_CUSTOM_PINS / 2;
export const MAX_PER_SIDE = MAX_CUSTOM_PINS / 2;

export const CUSTOM_FAMILIES = Object.freeze(["74LS", "CD4000"]);

/** A port's direction: an inout pin is read AND driven (a data bus). */
export const PORT_DIRS = Object.freeze(["input", "output", "inout"]);

/** What a custom chip's id looks like — and so what its ref does. */
export const CUSTOM_ID_RE = /^custom-[0-9a-f]{8}$/;
/** What a part number may be. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** Port names the pinout keeps for itself. */
const RESERVED_PORTS = new Set(["VCC", "GND", "VDD", "VSS", "NC"]);

/** Is this a part number a chip may carry (printed on it; ≤ 16 characters,
    letters, digits, `-` and `_`, starting with a letter or digit)? */
export const isValidPartName = (name) =>
  typeof name === "string" && name.length <= MAX_NAME && NAME_RE.test(name);

/** Is this ref a custom chip's? */
export const isCustomRef = (ref) => typeof ref === "string" && CUSTOM_ID_RE.test(ref); // prettier-ignore

/** A fresh, random custom chip id. */
export function mintCustomId(taken = new Set()) {
  for (;;) {
    const bytes = new Uint8Array(4);
    globalThis.crypto.getRandomValues(bytes);
    const id = `custom-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`; // prettier-ignore
    if (!taken.has(id)) return id;
  }
}

const int = (v, lo, hi, fallback) =>
  Number.isInteger(v) && v >= lo && v <= hi ? v : fallback;

/**
 * Bring a stored (or hand-edited, or older) custom chip to the current shape,
 * or null when there is no chip in it at all. Lenient where it can be — a
 * pin out of range becomes "not on a pin", a bad port is dropped — because a
 * chip that loads with a problem the designer shows beats one that vanishes.
 * @param {object} raw
 * @returns {object|null}
 */
export function normalizeCustomChip(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!isCustomRef(raw.id)) return null;
  const pinsPerSide = int(raw.pinsPerSide, MIN_PER_SIDE, MAX_PER_SIDE, 7);
  const pinCount = pinsPerSide * 2;
  const name =
    typeof raw.name === "string" && NAME_RE.test(raw.name.trim())
      ? raw.name.trim().slice(0, MAX_NAME)
      : "CUSTOM";
  const ports = [];
  const seen = new Set();
  for (const p of Array.isArray(raw.ports) ? raw.ports : []) {
    if (!p || typeof p !== "object" || typeof p.name !== "string") continue;
    const portName = p.name.trim();
    if (!portName || seen.has(portName) || ports.length >= MAX_PORTS) continue;
    seen.add(portName);
    ports.push({
      name: portName.slice(0, 32),
      dir: PORT_DIRS.includes(p.dir) ? p.dir : "input",
      width: int(p.width, 1, MAX_PORT_WIDTH, 1),
    });
  }
  const pinOk = (n) => int(n, 1, pinCount, 0);
  const rawUnits = Array.isArray(raw.units) && raw.units.length ? raw.units : [{}]; // prettier-ignore
  const units = rawUnits.slice(0, MAX_UNITS).map((u) => {
    const map = {};
    for (const p of ports) {
      const pins = Array.isArray(u?.[p.name]) ? u[p.name] : [];
      map[p.name] = Array.from({ length: p.width }, (_v, b) => pinOk(pins[b]));
    }
    return map;
  });
  return {
    id: raw.id,
    name,
    description:
      typeof raw.description === "string"
        ? raw.description.trim().slice(0, MAX_DESCRIPTION)
        : "",
    family: CUSTOM_FAMILIES.includes(raw.family) ? raw.family : "74LS",
    pinsPerSide,
    wide: raw.wide === true,
    ports,
    units,
    vcc: pinOk(raw.vcc),
    gnd: pinOk(raw.gnd),
    code: typeof raw.code === "string" ? raw.code.slice(0, MAX_CODE) : "",
  };
}

/** A list of custom chips, normalised, ids unique, at most `limit` (the
    stored lists' cap unless the caller says otherwise). */
export function normalizeCustomChips(list, { limit = MAX_CUSTOM_CHIPS } = {}) {
  const out = [];
  const ids = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const chip = normalizeCustomChip(raw);
    if (!chip || ids.has(chip.id) || out.length >= limit) continue;
    ids.add(chip.id);
    out.push(chip);
  }
  return out;
}

/** The package name (footprints.js) a chip seats as. */
export function customPackage(chip) {
  return packageName(chip.pinsPerSide * 2, chip.wide ? 600 : 300);
}

/** What the power pins are called in a family: VCC/GND, or CMOS's VDD/VSS. */
export const powerNames = (family) =>
  family === "CD4000" ? { vcc: "VDD", gnd: "VSS" } : { vcc: "VCC", gnd: "GND" };

/**
 * A port bit's name as a pin label: the port's name, with its bit number
 * when it is a vector (`Q3`), as a 74xx datasheet names a bus.
 */
export const bitLabel = (port, bit) =>
  port.width > 1 ? `${port.name}${bit}` : port.name;

/**
 * Who uses each physical pin: `Map<pin, Array<{unit, port, bit}>>`, port being
 * the port record.
 */
export function pinUses(chip) {
  const uses = new Map();
  chip.units.forEach((map, unit) => {
    for (const port of chip.ports) {
      (map[port.name] ?? []).forEach((pin, bit) => {
        if (!pin) return;
        if (!uses.has(pin)) uses.set(pin, []);
        uses.get(pin).push({ unit, port, bit });
      });
    }
  });
  return uses;
}

/**
 * The chip's pinout, pin 1 to 2N, as a catalog def's `pins`: power, then
 * every port bit where the map puts it (an output's or inout's pin is its
 * own; inputs may share), and NC wherever nothing is. An inout's pin is an
 * `io` pin, read and driven as a memory's data bus is. A pin two things claim in a way
 * that cannot be (an output shared, a port bit on a power pin) is still
 * listed — named for its first claimant — and `customChipProblems` says why.
 * @returns {Array<{n: number, name: string, role: string, uses: object[]}>}
 */
export function customPins(chip) {
  const uses = pinUses(chip);
  const power = powerNames(chip.family);
  const many = chip.units.length > 1;
  const pins = [];
  for (let n = 1; n <= chip.pinsPerSide * 2; n++) {
    if (n === chip.vcc) {
      pins.push({ n, name: power.vcc, role: "vcc", uses: [] });
      continue;
    }
    if (n === chip.gnd) {
      pins.push({ n, name: power.gnd, role: "gnd", uses: [] });
      continue;
    }
    const here = uses.get(n) ?? [];
    if (!here.length) {
      pins.push({ n, name: "NC", role: "nc", uses: [] });
      continue;
    }
    const first = here[0];
    const role = here.some((u) => u.port.dir === "inout") ? "io" : here.some((u) => u.port.dir === "output") ? "output" : "input"; // prettier-ignore
    const label = bitLabel(first.port, first.bit);
    // One unit: the port's own name. Several: the unit's number in front,
    // unless every unit shares this one pin for the same port bit (a common
    // clock is `CLK`, as on a 74LS175), or a subset does (`12CLK`).
    let name = label;
    if (many) {
      const sameBit = here.every((u) => u.port.name === first.port.name && u.bit === first.bit); // prettier-ignore
      const unitsHere = [...new Set(here.map((u) => u.unit + 1))];
      if (!(sameBit && unitsHere.length === chip.units.length)) {
        name = `${sameBit ? unitsHere.join("") : first.unit + 1}${label}`;
      }
    }
    pins.push({ n, name, role, uses: here });
  }
  return pins;
}

/**
 * What a chip's pin-assignments window shows of it: the part number and
 * description it is headed with, its package, and each pin's number, name
 * and role — plain data, since that window is a renderer of its own with no
 * catalog of the user's chips, and main carries it there.
 * @param {object} chip - a normalised custom chip.
 * @returns {{marking: string, description: string, package: string,
 *   pins: Array<{n: number, name: string, role: string}>}}
 */
export function customPinoutOf(chip) {
  return {
    marking: chip.name,
    description: chip.description,
    package: customPackage(chip),
    pins: customPins(chip).map(({ n, name, role }) => ({ n, name, role })),
  };
}

/**
 * What is wrong with a chip's PACKAGE side — a list of
 * `{code, args, severity}` (`chipdesign.problem.<code>` in the locales). The
 * Verilog side's diagnostics are the compiler's (hdl/compile.js). Errors stop
 * the chip simulating; warnings are said and left.
 */
export function customChipProblems(chip) {
  const problems = [];
  const err = (code, args = {}) => problems.push({ code, args, severity: "error" }); // prettier-ignore
  const warn = (code, args = {}) => problems.push({ code, args, severity: "warning" }); // prettier-ignore
  if (!chip.vcc) err("noVcc");
  if (!chip.gnd) err("noGnd");
  if (chip.vcc && chip.vcc === chip.gnd) err("powerSamePin", { pin: chip.vcc });
  const names = new Set();
  for (const port of chip.ports) {
    if (!isIdentifier(port.name)) err("badPortName", { name: port.name });
    else if (RESERVED_PORTS.has(port.name.toUpperCase())) {
      err("reservedPortName", { name: port.name });
    }
    if (names.has(port.name)) err("duplicatePort", { name: port.name });
    names.add(port.name);
  }
  if (!chip.ports.length) warn("noPorts");
  for (const [pin, here] of pinUses(chip)) {
    if (pin === chip.vcc || pin === chip.gnd) {
      err("portOnPower", { pin, name: bitLabel(here[0].port, here[0].bit) });
      continue;
    }
    if (here.length > 1 && here.some((u) => u.port.dir !== "input")) {
      err("outputShared", { pin });
    }
  }
  chip.units.forEach((map, unit) => {
    for (const port of chip.ports) {
      (map[port.name] ?? []).forEach((pin, bit) => {
        if (pin) return;
        warn("bitUnassigned", { unit: unit + 1, name: bitLabel(port, bit) });
      });
    }
  });
  return problems;
}

/** Does any of these problems stop the chip simulating? */
export const hasErrors = (problems) =>
  problems.some((p) => p.severity === "error");

/**
 * Put every port bit that has no pin yet on the next free pin, unit by unit
 * in port order — the 74xx habit of running each unit's pins together. A pin
 * already in use (or power) is never taken, so it only ever fills gaps.
 * @returns {object} a new chip.
 */
export function autoAssign(chip) {
  const taken = new Set([chip.vcc, chip.gnd, ...pinUses(chip).keys()]);
  const free = [];
  for (let n = 1; n <= chip.pinsPerSide * 2; n++) if (!taken.has(n)) free.push(n); // prettier-ignore
  const units = chip.units.map((map) => {
    const next = {};
    for (const port of chip.ports) {
      next[port.name] = (map[port.name] ?? []).map((pin) => pin || free.shift() || 0); // prettier-ignore
    }
    return next;
  });
  return { ...chip, units };
}

/**
 * The conventional power pins for a package: GND the last pin of the lower
 * row, VCC the last of the upper (pin 7 and 14 on a DIP-14), as nearly every
 * 74xx and CD4000 part has them.
 */
export function defaultPower(pinsPerSide) {
  return { gnd: pinsPerSide, vcc: pinsPerSide * 2 };
}

/**
 * A new chip to start from: a 2-input NAND on a DIP-14, named CUSTOM<n> with
 * the first free number.
 * @param {object[]} existing - the project's chips (for a free id and name).
 */
export function newCustomChip(existing = []) {
  const names = new Set(existing.map((c) => c.name));
  let n = 1;
  while (names.has(`CUSTOM${n}`)) n += 1;
  return {
    id: mintCustomId(new Set(existing.map((c) => c.id))),
    name: `CUSTOM${n}`,
    description: "",
    family: "74LS",
    pinsPerSide: 7,
    wide: false,
    ports: [
      { name: "A", dir: "input", width: 1 },
      { name: "B", dir: "input", width: 1 },
      { name: "Y", dir: "output", width: 1 },
    ],
    units: [{ A: [1], B: [2], Y: [3] }],
    ...defaultPower(7),
    code: "assign Y = ~(A & B);\n",
  };
}

/** A copy under a new id and a free "<name>-2" style name. */
export function duplicateCustomChip(chip, existing = []) {
  const names = new Set(existing.map((c) => c.name));
  const base = chip.name.replace(/-\d+$/, "").slice(0, MAX_NAME - 3);
  let n = 2;
  while (names.has(`${base}-${n}`)) n += 1;
  return {
    ...structuredClone(chip),
    id: mintCustomId(new Set(existing.map((c) => c.id))),
    name: `${base}-${n}`,
  };
}

/**
 * Change the package size or width. Pins past the new end come off whatever
 * used them; the power pins keep their numbers when they still exist and
 * otherwise move to the new package's conventional ones.
 */
export function resizeCustomChip(chip, pinsPerSide) {
  const per = int(pinsPerSide, MIN_PER_SIDE, MAX_PER_SIDE, chip.pinsPerSide);
  const count = per * 2;
  const keep = (pin) => (pin && pin <= count ? pin : 0);
  const power = defaultPower(per);
  let vcc = keep(chip.vcc) || power.vcc;
  let gnd = keep(chip.gnd) || power.gnd;
  if (vcc === gnd) [vcc, gnd] = [power.vcc, power.gnd];
  const units = chip.units.map((map) => {
    const next = {};
    for (const port of chip.ports) next[port.name] = (map[port.name] ?? []).map(keep); // prettier-ignore
    return next;
  });
  return { ...chip, pinsPerSide: per, vcc, gnd, units };
}

/** Change the number of units: new units start with no pins (Auto-assign
    fills them); units past the new count go. */
export function setUnitCount(chip, count) {
  const n = int(count, 1, MAX_UNITS, chip.units.length);
  const units = chip.units.slice(0, n);
  while (units.length < n) {
    const map = {};
    for (const port of chip.ports) map[port.name] = Array(port.width).fill(0);
    units.push(map);
  }
  return { ...chip, units };
}

/**
 * Replace the port list. A port that KEEPS its name keeps its pins (by bit,
 * as far as its new width reaches); one renamed is matched by `from`, the
 * name it had — so a rename never drops its wiring.
 * @param {object} chip
 * @param {Array<{name, dir, width, from?}>} ports
 */
export function setPorts(chip, ports) {
  const units = chip.units.map((map) => {
    const next = {};
    for (const p of ports) {
      const old = map[p.from ?? p.name] ?? [];
      next[p.name] = Array.from({ length: p.width }, (_v, b) => old[b] ?? 0);
    }
    return next;
  });
  return {
    ...chip,
    ports: ports.map(({ name, dir, width }) => ({ name, dir, width })),
    units,
  };
}

/** The ports a module is compiled against (hdl/compile.js's shape). */
export const modulePorts = (chip) =>
  chip.ports.map((p) => ({ name: p.name, dir: p.dir, width: p.width }));

/**
 * Two stored chips that say the same thing? (An import keeps one copy of a
 * chip the project already holds, and renames one that differs.)
 */
export function sameCustomChip(a, b) {
  return JSON.stringify(normalizeCustomChip(a)) === JSON.stringify(normalizeCustomChip(b)); // prettier-ignore
}

/** The refs of the custom chips a desk document places. */
export function customRefsIn(doc) {
  const refs = new Set();
  for (const comp of doc?.components ?? []) {
    if (isCustomRef(comp?.ref)) refs.add(comp.ref);
  }
  return refs;
}

/** The project chips a desk document places — what a desktop snapshot
    carries with it. */
export function customChipsUsedBy(doc, chips) {
  const refs = customRefsIn(doc);
  return (chips ?? []).filter((c) => refs.has(c.id));
}

/**
 * The custom chips the catalog knows while a project is open: the machine's
 * LIBRARY, with the project's own copy of any chip it carries standing in for
 * the library's (that copy is what the project's design was built with — the
 * library's may have been changed since, from another project), and any chip
 * only the project holds after them.
 * @param {object[]} library - the machine's chips (app/store/custom-chips.js).
 * @param {object[]} projectChips - the chips the open project's file carries.
 * @returns {object[]}
 */
export function chipRegistry(library, projectChips) {
  const own = new Map((projectChips ?? []).map((c) => [c.id, c]));
  const list = (library ?? []).map((c) => own.get(c.id) ?? c);
  const known = new Set(list.map((c) => c.id));
  for (const chip of projectChips ?? []) {
    if (!known.has(chip.id)) list.push(chip);
  }
  return list;
}

/**
 * The chips a project brought that the library does not hold — what joins the
 * library when it opens. A chip the library already holds is NOT replaced,
 * even when the project's copy differs: the project keeps using its own
 * (`chipRegistry`), and the library keeps what it was given last.
 * @param {object[]} library
 * @param {object[]} projectChips
 * @returns {object[]}
 */
export function chipsMissingFrom(library, projectChips) {
  const known = new Set((library ?? []).map((c) => c.id));
  return (projectChips ?? []).filter((c) => !known.has(c.id));
}

/**
 * Bring the chips a desktop arrived with (an Import) into a project's. A chip
 * the project already holds unchanged is taken as it is; one with the same id
 * that SAYS something else — designed on from a common ancestor in another
 * project — comes in as a chip of its own, under a new id, and the arriving
 * document's parts are pointed at it. Only chips the document places come in.
 *
 * @param {object[]} existing - every chip the project can use (its own and
 *   the library's — what an arriving id is checked against).
 * @param {object[]} incoming - the chips that arrived.
 * @param {object} doc - the arriving desk document (not modified).
 * @param {{room?: number}} [opts] - how many more chips the PROJECT can hold
 *   (its own count against MAX_CUSTOM_CHIPS — a full library is no full
 *   project); `existing`'s length when not given.
 * @returns {{chips: object[], doc: object, added: number, refused: object[]}}
 *   `refused`: the chips a full project could not take (their parts left out).
 */
export function mergeCustomChips(existing, incoming, doc, { room } = {}) {
  const chips = [...(existing ?? [])];
  const byId = new Map(chips.map((c) => [c.id, c]));
  const used = customRefsIn(doc);
  const remap = new Map();
  // Chips that could not come in (the project is full). Their parts are LEFT
  // OUT of the arriving document: an id the project already holds as a
  // DIFFERENT design would otherwise bind them silently to that one.
  const refused = [];
  let added = 0;
  const space = room ?? MAX_CUSTOM_CHIPS - chips.length;
  for (const raw of normalizeCustomChips(incoming)) {
    if (!used.has(raw.id)) continue;
    const have = byId.get(raw.id);
    if (have && sameCustomChip(have, raw)) continue;
    if (added >= space) {
      refused.push(raw);
      continue;
    }
    const chip = have
      ? { ...raw, id: mintCustomId(new Set(byId.keys())) }
      : raw;
    if (have) remap.set(raw.id, chip.id);
    chips.push(chip);
    byId.set(chip.id, chip);
    added += 1;
  }
  if (!remap.size && !refused.length) return { chips, doc, added, refused };
  const out = new Set(refused.map((c) => c.id));
  return {
    chips,
    doc: {
      ...doc,
      components: (doc.components ?? [])
        .filter((comp) => !out.has(comp.ref))
        .map((comp) =>
          remap.has(comp.ref) ? { ...comp, ref: remap.get(comp.ref) } : comp,
        ),
    },
    added,
    refused,
  };
}

/** What is printed on a stored chip (its part number). */
export const chipMarkingOf = (chip) => chip?.name ?? "";

/**
 * The pins a code reference names: every pin carrying port `name` (bit
 * `bit` only, when given) in any unit — or just `unit`'s, when given. What
 * the package lights when the code's pointer is over a name.
 * @returns {number[]}
 */
export function pinsForName(chip, name, bit = null, unit = null) {
  const port = chip?.ports.find((p) => p.name === name);
  if (!port) return [];
  const out = new Set();
  chip.units.forEach((map, u) => {
    if (unit != null && u !== unit) return;
    (map[name] ?? []).forEach((pin, b) => {
      if (!pin) return;
      if (bit != null && b !== bit) return;
      out.add(pin);
    });
  });
  return [...out];
}

/**
 * What a pin carries in the code: `{name, bit}` per port bit on it (bit null
 * for a 1-bit port), for every unit — or `unit`'s only. What the code lights
 * when the pointer is over a pin.
 */
export function namesForPin(chip, pin, unit = null) {
  const out = [];
  for (const use of pinUses(chip).get(pin) ?? []) {
    if (unit != null && use.unit !== unit) continue;
    out.push({ name: use.port.name, bit: use.port.width > 1 ? use.bit : null });
  }
  return out;
}

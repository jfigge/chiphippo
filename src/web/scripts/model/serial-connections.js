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

// serial-connections.js — the NAMED CONNECTIONS the Arduino serial
// integration talks over, as pure data: their shape, their defaults, and the
// arithmetic of carrying them between a machine and a project. DOM-free.
//
// A connection lives in TWO places, deliberately:
//
//   · SETTINGS (settings.json's `serialConnections`) — the machine's truth.
//     The port is a fact about THIS computer (/dev/cu.usbserial-1410 means
//     nothing on another one), so this is where a run reads what to open, and
//     where Settings ▸ Serial I/O edits it.
//   · the PROJECT file (`connections`) — every connection its elements name,
//     WITHOUT a port, so a project carried to another machine arrives knowing
//     what it needs: a connection missing from that machine's settings is
//     added from the project's copy, port blank and flagged `needsConfig`.
//     Pressing Apply on it is what clears the flag.
//
// Elements reference a connection by ID, never by name: renaming a
// connection must not orphan the elements that use it.
//
// And one connection lives in NEITHER place: the built-in MOCK
// (model/mock-connection.js), which every installation has. It is offered
// first wherever a connection is chosen (`knownConnections`), needs no port
// and so is never a problem before a run, never travels in a project file,
// and is never in settings — a stored user connection claiming its id is
// dropped, and one may not take its name.

import {
  MOCK_ID,
  MOCK_NAME,
  isMockId,
  isReservedConnectionName,
} from "./mock-connection.js";

export { MOCK_ID, MOCK_NAME, isMockId, isReservedConnectionName };

/** The built-in Mock as a connection record: no port, no serial settings. */
export const MOCK_CONNECTION = Object.freeze({
  id: MOCK_ID,
  name: MOCK_NAME,
  builtin: true,
});

/** Baud rates offered, the Arduino-common ones included. */
export const BAUD_RATES = Object.freeze([
  300, 1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 57600, 115200,
  230400, 250000, 460800, 500000, 921600, 1000000, 2000000,
]);

/** Always 8: every frame is binary — CRCs, signatures and values use all
    eight bits of a byte, which 5, 6 or 7 data bits cannot carry. A stored
    other value normalizes to 8 (and main opens 8 whatever settings say). */
export const DATA_BITS = Object.freeze([8]);
export const PARITIES = Object.freeze(["none", "even", "odd", "mark", "space"]);
export const STOP_BITS = Object.freeze([1, 1.5, 2]);
/** Never software (XON/XOFF): 0x11 and 0x13 are ordinary bytes on this link
    — 0x11 is the INBOUND frame type — and a port doing XON/XOFF swallows
    them (serial-protocol.md §2). A stored "software" normalizes to "none". */
export const FLOW_CONTROLS = Object.freeze(["none", "hardware"]);

/** What Generate writes a connection's board code in: `cpp` — an Arduino
    header (ChipHippo.h) — or `python` — one module (chiphippo.py) for
    MicroPython and CircuitPython boards. A fact about the board's code, not
    this machine, so it travels with a project like the framing does. */
export const LANGUAGES = Object.freeze(["cpp", "python"]);

/** Everything but the identity: 8 / None / 1 / no flow control — a Nano's
    defaults — at 115 200 baud. (How long to wait for an ACK is not a
    connection's to choose: it is the protocol's, in serial-wire.js.) */
export const CONNECTION_DEFAULTS = Object.freeze({
  port: "",
  baud: 115200,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  flowControl: "none",
  language: "cpp",
});

/** The settings a PROJECT carries — everything but the port. */
const PORTABLE_KEYS = Object.freeze([
  "baud",
  "dataBits",
  "parity",
  "stopBits",
  "flowControl",
  "language",
]);

/** What a connection id may look like (main checks the same pattern). */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;

/** The longest connection name kept (it titles a window and a header). */
const MAX_NAME = 40;

/** A fresh, unguessable connection id. */
export function newConnectionId() {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return `conn-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const pick = (list, value, fallback) =>
  list.includes(value) ? value : fallback;

/**
 * Coerce one stored connection, or null when it has no usable identity.
 * `needsConfig` is kept only while true (omit-when-default).
 */
export function normalizeConnection(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!ID_RE.test(id) || isMockId(id)) return null;
  const name =
    typeof raw.name === "string" && raw.name.trim()
      ? raw.name.trim().slice(0, MAX_NAME)
      : id;
  return {
    id,
    name,
    port: typeof raw.port === "string" ? raw.port : "",
    baud:
      Number.isInteger(raw.baud) && raw.baud > 0
        ? raw.baud
        : CONNECTION_DEFAULTS.baud,
    dataBits: pick(DATA_BITS, raw.dataBits, CONNECTION_DEFAULTS.dataBits),
    parity: pick(PARITIES, raw.parity, CONNECTION_DEFAULTS.parity),
    stopBits: pick(STOP_BITS, raw.stopBits, CONNECTION_DEFAULTS.stopBits),
    flowControl: pick(
      FLOW_CONTROLS,
      raw.flowControl,
      CONNECTION_DEFAULTS.flowControl,
    ),
    language: pick(LANGUAGES, raw.language, CONNECTION_DEFAULTS.language),
    ...(raw.needsConfig === true ? { needsConfig: true } : {}),
  };
}

/** A whole list, junk dropped and ids de-duplicated (first wins). */
export function normalizeConnections(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const c = normalizeConnection(raw);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/** The connection with this id, or null. */
export function findConnection(list, id) {
  return (list ?? []).find((c) => c?.id === id) ?? null;
}

/** Every connection this machine can use: the Mock first, then the ones its
    settings configure. What a Connection list offers, and what a run reads. */
export function knownConnections(settingsList) {
  return [MOCK_CONNECTION, ...normalizeConnections(settingsList)];
}

/**
 * A name nobody in `list` has: `base`, then `base 2`, `base 3`…
 * @param {Array<{name: string}>} list
 * @param {string} base the translated default ("Arduino")
 */
export function uniqueConnectionName(list, base) {
  const taken = new Set([MOCK_NAME, ...(list ?? []).map((c) => c.name)]);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }
}

/** A new connection with the defaults, flagged — it has no port yet. */
export function createConnection(list, name) {
  return normalizeConnection({
    id: newConnectionId(),
    name: uniqueConnectionName(list, name),
    ...CONNECTION_DEFAULTS,
    needsConfig: true,
  });
}

/**
 * The copies a project file carries for `ids`: the settings' own values, port
 * dropped. An id the settings no longer know keeps the copy the project
 * already had (`previous`), so saving a project on a machine that never
 * configured one of its connections does not lose it.
 *
 * @param {string[]} ids the connections the project's elements use
 * @param {Array} settingsList
 * @param {Array} [previous] the project's stored copies
 * @returns {Array<object>}
 */
export function projectConnections(ids, settingsList, previous = []) {
  const out = [];
  for (const id of ids ?? []) {
    if (isMockId(id)) continue; // every installation has it
    const source =
      findConnection(settingsList, id) ?? findConnection(previous, id);
    if (!source) continue;
    const record = { id: source.id, name: source.name };
    for (const key of PORTABLE_KEYS) record[key] = source[key];
    const clean = normalizeConnection(record);
    if (clean) {
      delete clean.port;
      delete clean.needsConfig;
      out.push(clean);
    }
  }
  return out;
}

/**
 * A project arrived: every connection it names that this machine's settings
 * do not have is ADDED — from the project's copy, with no port, flagged
 * `needsConfig` so the first Run asks for it to be verified.
 *
 * @returns {{list: Array, added: string[]}} the new settings list (the same
 *   array when nothing was added) and the ids that were added
 */
export function mergeProjectConnections(settingsList, projectList) {
  const list = normalizeConnections(settingsList);
  const added = [];
  for (const raw of Array.isArray(projectList) ? projectList : []) {
    const c = normalizeConnection({ ...raw, port: "", needsConfig: true });
    if (!c || findConnection(list, c.id)) continue;
    list.push(c);
    added.push(c.id);
  }
  return { list: added.length ? list : settingsList, added };
}

/**
 * The USB interface a port is, when the OS says: Windows names it in the
 * PnP id (`…&MI_02…`), Linux in the by-id name (`…-if02`). macOS says
 * nothing, and there a board's ports sort by path instead (its usbmodem
 * names end in the interface number plus one). Null when unknown.
 */
export function portInterface(port) {
  const m = /(?:MI_|-if)([0-9a-f]{2})\b/i.exec(port?.pnpId ?? "");
  return m ? parseInt(m[1], 16) : null;
}

/**
 * Which of its board's ports each scanned port is. A board with several —
 * CircuitPython's REPL and the data port boot.py turns on — shows them as
 * identical entries otherwise, and the REPL is the one people pick. Ports
 * share a board when they share a serial number, else a USB location; they
 * are ordered by interface where the OS reports one, else by path, so the
 * REPL (interface 0) is always first.
 *
 * @param {Array<object>} ports the scan
 * @returns {Array<object>} each port, in the scan's order, with `n` (its
 *   place, from 1) and `count` (its board's ports) — both 1 for a port on
 *   its own
 */
export function portPositions(ports) {
  const groups = new Map();
  for (const p of ports ?? []) {
    const key = p.serialNumber || p.locationId || "";
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const place = new Map();
  for (const members of groups.values()) {
    const known = members.every((p) => portInterface(p) != null);
    members.sort((a, b) =>
      known
        ? portInterface(a) - portInterface(b)
        : String(a.path).localeCompare(String(b.path), "en", {
            numeric: true,
          }),
    );
    members.forEach((p, i) =>
      place.set(p, { n: i + 1, count: members.length }),
    );
  }
  return (ports ?? []).map((p) => ({
    ...p,
    ...(place.get(p) ?? { n: 1, count: 1 }),
  }));
}

/**
 * What is wrong with a connection before a run, or null when it can open.
 * `presentPorts` is a live scan; pass null to skip that half.
 * @returns {null|"missing"|"unconfigured"|"no-port"|"port-missing"}
 */
export function connectionProblem(connection, presentPorts) {
  if (!connection) return "missing";
  if (connection.builtin) return null; // the Mock needs no port

  if (connection.needsConfig) return "unconfigured";
  if (!connection.port) return "no-port";
  if (presentPorts && !presentPorts.includes(connection.port)) {
    return "port-missing";
  }
  return null;
}

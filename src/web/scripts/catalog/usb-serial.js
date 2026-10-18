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

// usb-serial.js — the USB-serial adapter (Feature 420): an FTDI-style
// breakout whose six-pin header plugs into the breadboard and whose USB cable
// is the Terminal window. Pure data; its behaviour is sim/usb-serial.js.
//
// It is a SEATED part, as the LCD module is, not a desk brick: the engine runs
// behaviour only for parts on a board (sim/engine.js `fixedFacts` passes the
// PSU and the clock over by kind), and on a real bench the breakout's header
// is plugged straight into the breadboard.
//
// The header is the FTDI TTL-232R cable's order — GND, CTS#, VCC, TXD, RXD,
// RTS# — and the names are the ADAPTER's: TXD is what it sends (wire it to
// the circuit's receive input), RXD what it listens to.
//
// Its USB 5 V is not modelled: VCC is a no-connect, and the adapter has no
// supply pins at all, so the engine treats it as always powered (`passive`).
// GND is the line's REFERENCE — a passive terminal the logic never reads —
// and the engine warns when it is not on the circuit's ground
// (`no-common-ground`), the commonest serial mistake there is.

import { pin, passive } from "./pin-builders.js";
import { BAUD_RANGE, BAUD_RATES, DATA_BITS, PARITIES } from "../sim/uart.js";
import { usbSerialUnit } from "../sim/usb-serial.js";

/** The header's pins, by number. */
export const USB_SERIAL_PINS = Object.freeze({
  gnd: 1,
  cts: 2,
  vcc: 3,
  txd: 4,
  rxd: 5,
  rts: 6,
});

/** The stop bits the card offers: 1.5 is a 5-bit UART's, and no terminal
    asks for it. */
const STOP_CHOICES = Object.freeze([1, 2]);
const FLOWS = Object.freeze(["none", "rtscts"]);
/** What the Enter key sends. */
export const ENTER_KEYS = Object.freeze(["cr", "lf", "crlf"]);
/** What the Backspace key sends: BS (0x08) or DEL (0x7F). */
export const BACKSPACE_KEYS = Object.freeze(["bs", "del"]);
export const TERMINAL_COLUMNS = Object.freeze([40, 80, 132]);

/** Every setting's default — stored only when it differs, so a fresh
    adapter's params are `{}`. */
export const USB_SERIAL_DEFAULTS = Object.freeze({
  baud: 9600,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  flow: "none",
  enter: "cr",
  crIn: "cr",
  backspace: "bs",
  echo: "off",
  columns: 80,
});

/** A stored baud rate: any whole rate in BAUD_RANGE. */
function baudOf(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return USB_SERIAL_DEFAULTS.baud;
  return Math.min(BAUD_RANGE.max, Math.max(BAUD_RANGE.min, Math.round(n)));
}

/**
 * The adapter's params, each held to its choices and stored only when it is
 * not the default.
 * @param {object} raw
 */
export function usbSerialParams(raw = {}) {
  const pick = (key, choices) => {
    const v = raw?.[key];
    return choices.includes(v) ? v : USB_SERIAL_DEFAULTS[key];
  };
  const values = {
    baud: raw?.baud == null ? USB_SERIAL_DEFAULTS.baud : baudOf(raw.baud),
    dataBits: pick("dataBits", DATA_BITS),
    parity: pick("parity", PARITIES),
    stopBits: pick("stopBits", STOP_CHOICES),
    flow: pick("flow", FLOWS),
    enter: pick("enter", ENTER_KEYS),
    crIn: pick("crIn", ["cr", "crlf"]),
    backspace: pick("backspace", BACKSPACE_KEYS),
    echo: pick("echo", ["off", "on"]),
    columns: pick("columns", TERMINAL_COLUMNS),
  };
  const out = {};
  for (const [key, v] of Object.entries(values)) {
    if (v !== USB_SERIAL_DEFAULTS[key]) out[key] = v;
  }
  return out;
}

/** Every setting, the defaults filled in. */
export function usbSerialSettings(params) {
  return { ...USB_SERIAL_DEFAULTS, ...usbSerialParams(params) };
}

/** The Baud field: the usual rates, then Custom… for any other. */
const BAUD_FIELD = Object.freeze({
  key: "baud",
  label: "Baud",
  type: "preset",
  default: USB_SERIAL_DEFAULTS.baud,
  options: Object.freeze(
    BAUD_RATES.map((baud) => Object.freeze({ value: baud, label: `${baud}` })),
  ),
  customValue: "custom",
  customLabel: "Custom…",
  figures: Object.freeze([
    Object.freeze({
      key: "customBaud",
      label: "Custom baud",
      unit: "ratio",
      range: BAUD_RANGE,
    }),
  ]),
  selected(values) {
    const baud = usbSerialSettings(values).baud;
    return BAUD_RATES.includes(baud) ? baud : "custom";
  },
  figuresOf(values) {
    return { customBaud: usbSerialSettings(values).baud };
  },
  pick(values, value) {
    if (value === "custom") return { baud: this.figuresOf(values).customBaud };
    const baud = BAUD_RATES.find((b) => String(b) === String(value));
    return { baud: baud ?? USB_SERIAL_DEFAULTS.baud };
  },
  setFigure(_values, _key, baud) {
    return { baud: Math.round(baud) };
  },
});

const segmented = (key, label, options) =>
  Object.freeze({
    key,
    label,
    type: "segmented",
    default: USB_SERIAL_DEFAULTS[key],
    options: Object.freeze(
      options.map(([value, text]) => Object.freeze({ value, label: text })),
    ),
  });

export const USB_SERIAL_DEF = Object.freeze({
  id: "usb-serial",
  kind: "discrete",
  title: "USB-serial adapter (FTDI, 5 V)",
  blurb:
    "An FTDI-style USB-to-serial breakout: plug its six-pin header into the " +
    "board and its USB cable is the Terminal window (right-click ▸ Open " +
    "Terminal…). Header, left to right: GND, CTS#, VCC, TXD, RXD, RTS#. TXD " +
    "is what the adapter SENDS — wire it to your circuit's receive input — and " +
    "RXD is what it listens to. Logic-level serial (TTL, idle HIGH), set on " +
    "this card: baud, data bits, parity, stop bits. With RTS/CTS flow " +
    "control it sends only while CTS# is LOW. Its GND must be your circuit's " +
    "ground. VCC is the USB's 5 V and is not modelled — power the board " +
    "from a supply.",
  group: "I/O",
  // Six holes along one row; the breakout stands ABOVE them (see
  // discrete-view.js), so every hole below the row stays free for wiring.
  footprint: Object.freeze({
    offsets: Object.freeze([0, 1, 2, 3, 4, 5]),
  }),
  // The hook every consumer branches on — never an id.
  serialPort: Object.freeze({ ...USB_SERIAL_PINS }),
  pins: Object.freeze([
    Object.freeze({
      ...passive(USB_SERIAL_PINS.gnd, "GND"),
      detail: "ground — the serial line's reference; join it to the circuit's",
    }),
    Object.freeze({
      ...pin(USB_SERIAL_PINS.cts, "CTS#", "input"),
      detail: "clear to send — with RTS/CTS on, the adapter sends while LOW",
    }),
    Object.freeze({
      ...pin(USB_SERIAL_PINS.vcc, "VCC", "nc"),
      detail: "USB 5 V — not modelled; power the board from a supply",
    }),
    Object.freeze({
      ...pin(USB_SERIAL_PINS.txd, "TXD", "output"),
      detail:
        "transmit data OUT of the adapter — to the circuit's receive input",
    }),
    Object.freeze({
      ...pin(USB_SERIAL_PINS.rxd, "RXD", "input"),
      detail:
        "receive data INTO the adapter — from the circuit's transmit output",
    }),
    Object.freeze({
      ...pin(USB_SERIAL_PINS.rts, "RTS#", "output"),
      detail: "request to send — held LOW: the terminal is always ready",
    }),
  ]),
  properties: Object.freeze([
    BAUD_FIELD,
    segmented("dataBits", "Data bits", [
      [5, "5"],
      [6, "6"],
      [7, "7"],
      [8, "8"],
    ]),
    segmented("parity", "Parity", [
      ["none", "None"],
      ["even", "Even"],
      ["odd", "Odd"],
    ]),
    segmented("stopBits", "Stop bits", [
      [1, "1"],
      [2, "2"],
    ]),
    segmented("flow", "Flow control", [
      ["none", "None"],
      ["rtscts", "RTS/CTS"],
    ]),
    segmented("enter", "Enter sends", [
      ["cr", "CR"],
      ["lf", "LF"],
      ["crlf", "CR LF"],
    ]),
    segmented("crIn", "Received CR", [
      ["cr", "CR"],
      ["crlf", "CR LF"],
    ]),
    segmented("backspace", "Backspace sends", [
      ["bs", "BS"],
      ["del", "DEL"],
    ]),
    segmented("echo", "Local echo", [
      ["off", "Off"],
      ["on", "On"],
    ]),
    segmented("columns", "Columns", [
      [40, "40"],
      [80, "80"],
      [132, "132"],
    ]),
  ]),
  normalizeParams: usbSerialParams,
  internalBridges() {
    return [];
  },
  logic: usbSerialUnit({
    txd: USB_SERIAL_PINS.txd,
    rxd: USB_SERIAL_PINS.rxd,
    cts: USB_SERIAL_PINS.cts,
    rts: USB_SERIAL_PINS.rts,
  }),
});

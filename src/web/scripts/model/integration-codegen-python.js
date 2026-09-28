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

// integration-codegen-python.js — the board side of the serial integration
// for a connection whose language is PYTHON: one module, chiphippo.py, that
// runs unchanged on MICROPYTHON and CIRCUITPYTHON (and on desktop Python,
// which is how it is tested), plus the example programs that use it.
// Pure: strings in, strings out.
//
// It is integration-codegen.js's C++ header said again, line for line: the
// same protocol (every number written from serial-wire.js), the same session
// rules, the same ACK-after-the-handler, the same log chunking — so the
// tests that hold the header to the real SerialLink hold this module to it
// too (app/tests/serial-python-module.test.js, under python3 AND the real
// MicroPython interpreter). What differs is only what Python makes natural:
//
//   · names are snake_case, from the SAME identifier plan (`planIdentifiers`
//     with PY_NAMING): the Output "Digit" is `link.digit_in`, the Input
//     "Segments" is `link.segments_out`, a setter is `set_pattern`;
//   · an Output's handler is REGISTERED with a decorator (`@link.digit_in`)
//     rather than defined under a name the header declares, and one left
//     unregistered is acknowledged and ignored;
//   · a handler that RAISES is caught, told to the connection window, and
//     its Output acknowledged anyway — on a board, an uncaught exception ends
//     the program where nobody can see it, since the port it would be
//     printed on is Chip Hippo's;
//   · the PORT is found at `begin()`: CircuitPython's second USB serial port
//     (`usb_cdc.data`, which boot.py turns on), MicroPython's REPL port
//     (stdin/stdout, with Ctrl-C switched off — a 0x03 byte in a frame would
//     otherwise stop the program), desktop Python's stdin/stdout; or any
//     stream handed to it (a machine.UART, a busio.UART, a pyserial Serial).
//
// Kept to what MicroPython and CircuitPython both run: no f-strings, no
// typing, no dataclasses, no keyword arguments to built-ins that lack them.

import { hashHex, designHash, planIdentifiers } from "./integration-codegen.js";
import { layoutSignature, layoutString } from "./integration.js";
import {
  ACK_TIMEOUT_MS,
  CRC16_INIT,
  CRC16_POLY,
  CRC_BYTES,
  DATA_PAYLOAD,
  ESC,
  ESC_XOR,
  FRAME,
  HEADER_BYTES,
  HELLO_PAYLOAD,
  MAX_SENDS,
  PROTOCOL_VERSION,
  START,
} from "./serial-wire.js";

/** The module's file name, and the example programs' — MicroPython runs
    main.py at boot, CircuitPython code.py (after boot.py). */
export const PYTHON_MODULE_FILE = "chiphippo.py";
export const MICROPYTHON_MAIN = "main.py";
export const CIRCUITPYTHON_MAIN = "code.py";
export const CIRCUITPYTHON_BOOT = "boot.py";

/** What MicroPython's REPL port runs at on a board whose USB is a separate
    serial chip — fixed by the firmware. */
export const REPL_BAUD = 115200;
export const REPL_FORMAT = "8N1";

/** The device's log chunk — the C++ header's number, for the same reason. */
const LOG_CHUNK = 60;

// ── Identifiers ────────────────────────────────────────────────────────────

/** What a Python name may not be: the keywords, and what the module and its
    example programs already use. */
const PY_RESERVED = new Set(
  (
    "False None True and as assert async await break class continue def del " +
    "elif else except finally for from global if import in is lambda " +
    "nonlocal not or pass raise return try while with yield " +
    // The module, the example programs and what they import.
    "link chiphippo self sys os time micropython usb_cdc select supervisor " +
    "send_inputs " +
    // The link's own members, and an Input's.
    "begin poll connected on_connect print send bits"
  ).split(/\s+/),
);

/**
 * A name as a snake_case Python identifier: words split at spaces,
 * punctuation and camelCase humps, lower-cased and joined by `_`, never
 * starting with a digit — "Output 1" → `output_1`, "DataIn" → `data_in`,
 * "7-seg" → `_7_seg`. Idempotent, so an identifier passes through as itself.
 */
export function pyIdentifier(name, fallback = "x") {
  const words = String(name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // "ç" → "c", not "c" and a word break
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const id = words.join("_").toLowerCase() || fallback;
  return /^[0-9]/.test(id) ? `_${id}` : id;
}

/** An element's identifier from the board's side, as C++'s: an Output
    ARRIVES (`_in`), an Input is SENT (`_out`) — not doubled when the name
    already ends that way. */
export function pyElementIdentifier(name, fallback, kind) {
  const suffix = kind === "input" ? "_out" : "_in";
  const base = pyIdentifier(name, fallback);
  return base.endsWith(suffix) ? base : `${base}${suffix}`;
}

/** Python's spelling, for `planIdentifiers`. */
export const PY_NAMING = Object.freeze({
  identifier: pyIdentifier,
  element: pyElementIdentifier,
  setter: (param) => `set_${param}`,
  reserved: PY_RESERVED,
  setterReserved: PY_RESERVED,
  type: Object.freeze({ bit: "bool", byte: "int", word: "int" }),
});

// ── Text helpers ───────────────────────────────────────────────────────────

/** A user's text for a `#` comment: never onto a line of its own. */
const comment = (s) => String(s ?? "").replace(/[\r\n]+/g, " ");

/** A user's text as a Python string literal (double-quoted, escaped). */
const pyString = (s) =>
  `"${[...String(s ?? "")]
    .map((c) => (c < " " || c === "\x7f" ? " " : c))
    .join("")
    .replace(/[\\"]/g, "\\$&")}"`;

const hex2 = (n) => `0x${n.toString(16).toUpperCase().padStart(2, "0")}`;
const hex4 = (n) => `0x${n.toString(16).toUpperCase().padStart(4, "0")}`;

/** "pins 1-8 value (int)" — what a field is, for a comment. */
const describeField = (f) =>
  `${f.first === f.last ? `pin ${f.first}` : `pins ${f.first}-${f.last}`} ${f.param} (${f.cType})`;

/** An Output's fields unpacked from the value `v`, as a Python tuple body. */
function unpack(o) {
  const parts = o.fields.map((f) => {
    const shift = f.first - 1;
    const shifted = shift ? `(v >> ${shift})` : "v";
    if (f.type === "bit") return `(${shifted} & 1) != 0`;
    return `${shifted} & ${f.type === "word" ? "0xFFFF" : "0xFF"}`;
  });
  return parts.length === 1 ? `${parts[0]},` : parts.join(", ");
}

/** A block of Python source written inline, without its first and last
    newline — the caller's `out()` owns the spacing between blocks. */
const block = (text) => text.replace(/^\n/, "").replace(/\n$/, "");

/** One Input's setter methods, a blank line before each. */
function inputSetters(i) {
  return i.fields.flatMap((f) => {
    const shift = f.first - 1;
    if (f.type === "bit") {
      return [
        "",
        `    def ${f.setter}(self, on):`,
        `        if on:`,
        `            self._bits |= ${1 << shift}`,
        `        else:`,
        `            self._bits &= ${hex4(0xffff & ~(1 << shift))}`,
      ];
    }
    const mask = (f.type === "word" ? 0xffff : 0xff) << shift;
    return [
      "",
      `    def ${f.setter}(self, value):`,
      `        self._bits = (self._bits & ${hex4(0xffff & ~mask)}) | ((int(value) << ${shift}) & ${hex4(mask)})`,
    ];
  });
}

// ── The module ─────────────────────────────────────────────────────────────

/**
 * The module for one connection.
 *
 * @param {object} opts
 * @param {object} opts.connection the settings record
 * @param {Array} opts.elements the desk's elements (this picks the
 *   connection's own)
 * @param {string} [opts.projectName]
 * @param {string} [opts.desktopName]
 * @param {string} [opts.appVersion]
 * @returns {{name: string, text: string, hash: number, signature: number,
 *   warnings: Array, outputs: number, inputs: number}}
 */
export function generatePythonModule({
  connection,
  elements,
  projectName = "",
  desktopName = "",
  appVersion = "",
}) {
  const connectionId = connection?.id ?? null;
  const hash = designHash(connection, elements);
  const signature = layoutSignature(elements, connectionId);
  const layout = layoutString(elements, connectionId);
  const plan = planIdentifiers(connectionId, elements, PY_NAMING);
  const firstOut = plan.outputs[0];
  const firstIn = plan.inputs[0];
  const baud = connection?.baud ?? 115200;
  const format = `${connection?.dataBits ?? 8}${
    { none: "N", even: "E", odd: "O", mark: "M", space: "S" }[
      connection?.parity ?? "none"
    ] ?? "N"
  }${connection?.stopBits ?? 1}`;
  const framing = `${baud} baud, ${format}`;
  // A board whose USB is a separate serial chip (a classic ESP32 DevKit)
  // runs MicroPython's REPL port — the link's — at 115200 baud, 8N1, and
  // cannot be told otherwise; a board with USB built in ignores the rate.
  // Only the first kind breaks, and silently, so it is said up front.
  const warnings = [...plan.warnings];
  if (baud !== REPL_BAUD || format !== REPL_FORMAT) {
    warnings.push({ code: "python-framing", baud, format });
  }

  const L = [];
  const out = (...lines) => L.push(...lines);

  out(
    `# ${PYTHON_MODULE_FILE} — generated by Chip Hippo${appVersion ? ` ${comment(appVersion)}` : ""} for the connection ${comment(JSON.stringify(String(connection?.name ?? "")))}.`,
    "#",
    ...(projectName ? [`#   Project:  ${comment(projectName)}`] : []),
    ...(desktopName ? [`#   Desktop:  ${comment(desktopName)}`] : []),
    `#   Design:   ${hashHex(hash)}`,
    `#   Layout:   ${hashHex(signature)} (${layout || "empty"})`,
    `#   Protocol: v${PROTOCOL_VERSION}`,
    "#",
    "# Do not edit this file: regenerate it from Chip Hippo (the Generate button)",
    "# whenever this connection's Outputs or Inputs change. It runs on MicroPython",
    "# and CircuitPython alike. Your program imports `link` from it, registers a",
    "# function per Output, then calls link.begin() once and link.poll() in its",
    "# loop:",
    "#",
    "#   from chiphippo import link",
    "#",
    "# Names read from the board's side. An Output of the circuit ARRIVES here:",
    "# decorate the function that handles it with link.<its name>_in; its fields",
    "# are the parameters, in order.",
  );
  if (firstOut) {
    out(
      "#",
      `#   @link.${firstOut.id}  # the Output ${comment(JSON.stringify(firstOut.display))}`,
      `#   def ${firstOut.id}(${firstOut.fields.map((f) => f.param).join(", ")}):`,
      "#       ...",
    );
  }
  out(
    "#",
    "# An Input of the circuit is SENT from here, as link.<its name>_out: set what",
    "# changed, then send() the whole group as one value.",
  );
  if (firstIn) {
    const f = firstIn.fields[0];
    out(
      "#",
      `#   link.${firstIn.id}.${f.setter}(${f.type === "bit" ? "True" : "42"})  # the Input ${comment(JSON.stringify(firstIn.display))}`,
      `#   link.${firstIn.id}.send()`,
    );
  }
  out(
    "#",
    "# send() returns False while no run is listening (link.connected()). An Input",
    "# drives nothing until its first send(), so give each one its starting value",
    "# from a function decorated @link.on_connect: poll() runs it at the start of",
    "# every run, whether or not the board reset when the port opened.",
    "#",
    `# Example programs that use this module — receiving, sending and logging —`,
    `# are ${MICROPYTHON_MAIN} (MicroPython) and ${CIRCUITPYTHON_MAIN} with ${CIRCUITPYTHON_BOOT} (CircuitPython): in`,
    "# Chip Hippo, Generate shows them beside this module.",
    "#",
    "# Call poll() often and keep Output functions short. While an Output is being",
    "# handled the circuit waits for it, so every sleep() is time it stands still",
    `# — Chip Hippo resends after ${ACK_TIMEOUT_MS} ms and stops the circuit after ${MAX_SENDS} tries. Log`,
    "# with link.print(), never print(): on MicroPython the link IS the port",
    "# print() writes to. A function that raises is reported the same way, and",
    "# the circuit carries on.",
    "#",
    "# THE PORT. MicroPython: the board's USB serial port (its REPL's). Ctrl-C",
    "# is off inside a frame, where a 0x03 byte is data, but still stops the",
    "# program between frames — so Thonny and mpremote can always get in to",
    "# replace these files. CircuitPython: the SECOND USB serial port, which",
    "# boot.py turns on — point the connection at that one. Or pass any stream",
    `# to begin(): a machine.UART or busio.UART opened at ${framing}.`,
    "",
    "import sys",
    "",
    `PROTOCOL_VERSION = ${PROTOCOL_VERSION}`,
    `LAYOUT_SIGNATURE = ${hashHex(signature)}`,
    `ACK_TIMEOUT_MS = ${ACK_TIMEOUT_MS}`,
    `MAX_SENDS = ${MAX_SENDS}`,
    "",
    `_START = ${hex2(START)}`,
    `_ESC = ${hex2(ESC)}`,
    `_ESC_XOR = ${hex2(ESC_XOR)}`,
    `_HELLO = ${hex2(FRAME.HELLO)}`,
    `_HELLO_ACK = ${hex2(FRAME.HELLO_ACK)}`,
    `_ACK = ${hex2(FRAME.ACK)}`,
    `_NAK = ${hex2(FRAME.NAK)}`,
    `_OUTPUT = ${hex2(FRAME.OUTPUT)}`,
    `_INBOUND = ${hex2(FRAME.INBOUND)}`,
    `_LOG = ${hex2(FRAME.LOG)}`,
    `_HEADER = ${HEADER_BYTES}`,
    `_CRC_LEN = ${CRC_BYTES}`,
    `_DATA_LEN = ${DATA_PAYLOAD}`,
    `_HELLO_LEN = ${HELLO_PAYLOAD}`,
    "# The longest frame this side is ever sent: anything longer is damage.",
    `_RX_MAX = ${Math.max(DATA_PAYLOAD, HELLO_PAYLOAD)}`,
    `_LOG_CHUNK = ${LOG_CHUNK}`,
    "_R_NONE = 0",
    "_R_ACK = 1",
    "_R_NAK = 2",
    "",
    "# Each Output, by its index on the wire: (width, name, unpack).",
    "_OUTPUTS = (",
    ...plan.outputs.map(
      (o) =>
        `    (${o.width}, ${pyString(o.id)}, lambda v: (${unpack(o)})),  # ${comment(o.display)}: ${o.fields.map(describeField).join(", ")}`,
    ),
    ")",
    "",
    "",
  );

  out(
    block(String.raw`
# ── Time: MicroPython, CircuitPython, desktop Python ────────────────────────
try:
    from time import ticks_ms as _ticks_ms, ticks_diff as _ticks_diff
except ImportError:
    try:
        from supervisor import ticks_ms as _ticks_ms

        def _ticks_diff(a, b):  # supervisor.ticks_ms wraps every 2**29 ms
            d = (a - b) & 0x1FFFFFFF
            return ((d + 0x10000000) & 0x1FFFFFFF) - 0x10000000

    except ImportError:
        from time import monotonic as _monotonic

        def _ticks_ms():
            return int(_monotonic() * 1000)

        def _ticks_diff(a, b):
            return a - b


# Milliseconds for your own program, read the same way on every board:
# ticks_diff(ticks_ms(), then) is how many milliseconds ago 'then' was.
ticks_ms = _ticks_ms
ticks_diff = _ticks_diff


# ── Ports: each reads what has arrived (never waiting) and writes a frame ───
class _UsbCdcData:
    # CircuitPython: the second USB serial port, which boot.py turns on.
    def __init__(self):
        import usb_cdc

        port = usb_cdc.data
        if port is None:
            raise RuntimeError(
                "chiphippo: the data port is off - boot.py must call "
                "usb_cdc.enable(console=True, data=True), then reset the board"
            )
        port.timeout = 0
        self._port = port

    def read(self):
        n = self._port.in_waiting
        return self._port.read(n) if n else b""

    def write(self, data):
        self._port.write(data)


class _Stdio:
    # MicroPython: the USB serial port the REPL uses, as stdin/stdout.
    #
    # Ctrl-C is off while the link runs — a 0x03 in a frame is data — but a
    # lone 0x03 BETWEEN frames can only be a tool (Thonny, mpremote) asking to
    # stop the program so it can reach the REPL: Chip Hippo sends nothing but
    # whole frames. The link hands it back as the KeyboardInterrupt the tool
    # is waiting for, so a board running this is never locked out.
    def __init__(self):
        import micropython
        import select

        self._micropython = micropython
        micropython.kbd_intr(-1)  # a 0x03 in a frame is data, not Ctrl-C
        self._in = sys.stdin.buffer
        self._out = sys.stdout.buffer
        self._poll = select.poll()
        self._poll.register(sys.stdin, select.POLLIN)

    def read(self):
        data = bytearray()
        while len(data) < 64 and self._poll.poll(0):
            b = self._in.read(1)
            if not b:
                raise EOFError  # the far end has gone (only off a board)
            data.extend(b)
            if b[0] == 0x03:
                break  # maybe a tool's Ctrl-C: leave what follows it unread
        return data

    def interrupt(self):
        self._micropython.kbd_intr(3)
        raise KeyboardInterrupt

    def write(self, data):
        self._out.write(data)


class _Pipe:
    # Desktop Python: stdin/stdout, unbuffered.
    def __init__(self):
        import os

        self._os = os
        os.set_blocking(0, False)

    def read(self):
        try:
            data = self._os.read(0, 256)
        except BlockingIOError:
            return b""
        if not data:
            raise EOFError
        return data

    def write(self, data):
        view = memoryview(bytes(data))
        while view:
            view = view[self._os.write(1, view):]


class _Stream:
    # Any stream begin() is given: machine.UART, busio.UART, pyserial.
    def __init__(self, io):
        self._io = io

    def read(self):
        io = self._io
        if hasattr(io, "any"):
            n = io.any()
        elif hasattr(io, "in_waiting"):
            n = io.in_waiting
        else:
            n = 64
        return (io.read(n) or b"") if n else b""

    def write(self, data):
        self._io.write(data)


def _default_port():
    name = sys.implementation.name
    if name == "circuitpython":
        return _UsbCdcData()
    if name == "micropython":
        return _Stdio()
    return _Pipe()


def _crc16(data, n):
    crc = ${hex4(CRC16_INIT)}
    for i in range(n):
        crc ^= data[i] << 8
        for _ in range(8):
            crc = ((crc << 1) ^ ${hex4(CRC16_POLY)}) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


# ── Inputs: set what changed, then send() the whole group as one frame ─────
class _Input:
    def __init__(self, link, index, width):
        self._link = link
        self._index = index
        self._width = width
        self._bits = 0

    def bits(self):
        return self._bits

    def send(self):
        # True once Chip Hippo has it; False if it is not listening (the
        # circuit is not running, or the cable is out).
        return self._link._send_input(self._index, self._width, self._bits)
`),
  );

  for (const i of plan.inputs) {
    out(
      "",
      "",
      `class _Input_${i.id}(_Input):`,
      `    # ${comment(i.display)}: ${i.fields.map(describeField).join(", ")}`,
      `    def __init__(self, link):`,
      `        _Input.__init__(self, link, ${i.index}, ${i.width})`,
      ...inputSetters(i),
    );
  }

  out(
    "",
    "",
    "class _Link:",
    "    def __init__(self):",
    ...plan.inputs.map(
      (i) =>
        `        self.${i.id} = _Input_${i.id}(self)  # the Input ${comment(JSON.stringify(i.display))}`,
    ),
    "        self._handlers = [None] * len(_OUTPUTS)",
    "        self._on_connect = None",
    "        self._io = None",
    "        self._reset()",
    "",
    "    # ── Outputs: decorate the function that handles each one ──────────────",
  );
  if (plan.outputs.length === 0) out("    # (this connection has no Outputs)");
  plan.outputs.forEach((o, n) => {
    out(
      ...(n ? [""] : []),
      `    def ${o.id}(self, fn):`,
      `        # The Output ${comment(JSON.stringify(o.display))}: fn(${o.fields.map((f) => f.param).join(", ")})`,
      `        self._handlers[${o.index}] = fn`,
      "        return fn",
    );
  });

  out(
    "",
    block(String.raw`
    # ── The link ──────────────────────────────────────────────────────────
    def on_connect(self, fn):
        # Run fn from poll() at the start of every run, once Chip Hippo has
        # greeted the program. The place to send your Inputs' starting
        # values. Use it as a decorator, or call it with None to stop.
        self._on_connect = fn
        return fn

    def begin(self, port=None):
        # Open the link and announce the program. Call once. With no port it
        # finds the board's own (see THE PORT, above).
        self._io = _Stream(port) if port is not None else _default_port()
        self._reset()
        # Session 0 says "I have just started": a circuit that was running
        # learns this program has forgotten it, and stops rather than go deaf.
        self._send_hello_ack(0)

    def poll(self):
        # Service the link: runs Output functions, answers Chip Hippo. Call
        # it from your loop, as often as you can.
        if self._io is None:
            return
        self._pump(False, 0)
        if self._connect_pending and not self._dispatching:
            self._connect_pending = False
            if self._on_connect is not None:
                self._call("on_connect", self._on_connect, ())
        if self._pending is not None and not self._dispatching:
            index, seq, width, value = self._pending
            self._pending = None
            self._dispatch(index, seq, width, value)
        self._flush_log(False)

    def connected(self):
        # True from Chip Hippo's HELLO until a send it never acknowledged:
        # while it is False, an Input's send() returns False at once.
        return self._greeted

    def print(self, *args, sep=" ", end="\n"):
        # Log text, to Chip Hippo's connection window.
        if self._io is None:
            return
        for b in (sep.join([str(a) for a in args]) + end).encode("utf-8"):
            if len(self._log) == _LOG_CHUNK:
                self._flush_log(False)
                if len(self._log) == _LOG_CHUNK:
                    self._flush_log(True)  # no character to cut at
            self._log.append(b)
            if b == 0x0A:
                self._flush_log(True)

    # ── Everything below is the protocol ──────────────────────────────────
    def _reset(self):
        self._inbuf = b""
        self._at = 0
        self._rx = bytearray()
        self._in_frame = False
        self._esc = False
        self._greeted = False
        self._session = 0
        self._tx_seq = 0
        self._rx_seq = 0
        self._dispatching = False
        self._busy_seq = 0
        self._busy_session = 0
        self._pending = None
        self._connect_pending = False
        self._log = bytearray()

    def _send_input(self, index, width, value):
        # Waits for Chip Hippo's ACK, resending on a NAK or a timeout, and
        # keeps the link serviced while it waits.
        if self._io is None or not self._greeted:
            return False
        self._flush_log(False)
        payload = bytes((index, width, value & 0xFF, (value >> 8) & 0xFF))
        self._tx_seq = self._tx_seq % 255 + 1
        seq = self._tx_seq
        session = self._session
        for _ in range(MAX_SENDS):
            self._send_frame(_INBOUND, seq, payload)
            start = _ticks_ms()
            while _ticks_diff(_ticks_ms(), start) < ACK_TIMEOUT_MS:
                r = self._pump(True, seq)
                if r == _R_ACK:
                    return True
                if r == _R_NAK:
                    break
                if not self._greeted or self._session != session:
                    return False  # a new run
        # Nobody is listening: stop waiting on every send until Chip Hippo
        # greets the program again.
        self._greeted = False
        return False

    def _call(self, name, fn, args):
        # A function that raises is told to the connection window — on a
        # board nobody else would see it — and the link carries on.
        try:
            fn(*args)
        except Exception as e:  # noqa: BLE001 — anything the function did
            self.print("chiphippo:", name, "raised", repr(e))

    def _send_frame(self, kind, seq, payload=b""):
        body = bytes((kind, seq, len(payload))) + bytes(payload)
        crc = _crc16(body, len(body))
        out = bytearray((_START,))
        for b in body + bytes((crc & 0xFF, crc >> 8)):
            if b == _START or b == _ESC:
                out.append(_ESC)
                out.append(b ^ _ESC_XOR)
            else:
                out.append(b)
        self._io.write(out)

    def _ack(self, seq):
        self._send_frame(_ACK, seq)

    def _send_hello_ack(self, seq):
        # This program's protocol version and layout — answered to every
        # HELLO, matching or not: only Chip Hippo judges, so only it explains.
        s = LAYOUT_SIGNATURE
        self._send_frame(
            _HELLO_ACK,
            seq,
            bytes((PROTOCOL_VERSION, s & 0xFF, (s >> 8) & 0xFF, (s >> 16) & 0xFF, (s >> 24) & 0xFF)),
        )

    def _whole_chars(self):
        # How much of the log ends on a whole UTF-8 character: a LOG frame
        # never splits one.
        log = self._log
        i = len(log)
        tail = 0
        while i > 0 and tail < 3 and (log[i - 1] & 0xC0) == 0x80:
            i -= 1
            tail += 1
        if i == 0:
            return len(log)
        lead = log[i - 1]
        need = 4 if lead >= 0xF0 else 3 if lead >= 0xE0 else 2 if lead >= 0xC0 else 1
        return i - 1 if need > tail + 1 else len(log)

    def _flush_log(self, everything):
        # Log text is never acknowledged, so it goes whether or not anyone is
        # listening — and never keeps the program waiting.
        if self._io is None or not self._log:
            return
        n = len(self._log) if everything else self._whole_chars()
        if n == 0:
            return
        self._send_frame(_LOG, 0, self._log[:n])
        self._log = self._log[n:]

    def _pump(self, waiting, wait_seq):
        # Read what has arrived. Returns _R_ACK/_R_NAK when waiting and the
        # frame waited on was answered; frames for anyone else are handled
        # here, and what arrived after the answer stays for the next call.
        while True:
            if self._at >= len(self._inbuf):
                self._inbuf = self._io.read()
                self._at = 0
                if not self._inbuf:
                    return _R_NONE
            b = self._inbuf[self._at]
            self._at += 1
            if b == _START:
                self._in_frame = True
                self._esc = False
                self._rx = bytearray()
                continue
            if not self._in_frame:
                if b == 0x03 and hasattr(self._io, "interrupt"):
                    self._io.interrupt()  # a tool's Ctrl-C (see _Stdio)
                continue
            if self._esc:
                self._esc = False
                b ^= _ESC_XOR
                if b != _START and b != _ESC:
                    self._damaged()
                    continue
            elif b == _ESC:
                self._esc = True
                continue
            self._rx.append(b)
            if len(self._rx) < _HEADER:
                continue
            n = self._rx[2]
            if n > _RX_MAX:
                self._damaged()
                continue
            if len(self._rx) < _HEADER + n + _CRC_LEN:
                continue
            self._in_frame = False
            r = self._handle(n, waiting, wait_seq)
            if waiting and r != _R_NONE:
                return r

    def _damaged(self):
        # A frame arrived damaged: ask for a resend at once — unless it was
        # one that is never resent, or nothing has greeted this program yet.
        self._in_frame = False
        kind = self._rx[0] if self._rx else 0
        if self._greeted and kind != _ACK and kind != _NAK and kind != _HELLO:
            self._send_frame(_NAK, 0)

    def _handle(self, n, waiting, wait_seq):
        rx = self._rx
        kind = rx[0]
        seq = rx[1]
        crc = rx[_HEADER + n] | (rx[_HEADER + n + 1] << 8)
        if _crc16(rx, _HEADER + n) != crc:
            self._damaged()
            return _R_NONE
        if kind == _HELLO:
            if n == _HELLO_LEN:
                self._on_hello(seq)
            return _R_NONE
        if not self._greeted:
            return _R_NONE  # nothing counts before a HELLO
        if kind == _ACK:
            return _R_ACK if waiting and seq == wait_seq else _R_NONE
        if kind == _NAK:
            return _R_NAK if waiting else _R_NONE
        if kind == _OUTPUT:
            # Intact but unreadable: ACK and drop — a resend would be the same.
            if n == _DATA_LEN:
                self._on_output(seq, waiting)
            else:
                self._ack(seq)
        return _R_NONE

    def _on_hello(self, session):
        # HELLO's SEQ is the run's SESSION. Only a new one resets what this
        # side remembers — a repeat of the current one (the host asks until
        # it hears) is answered and nothing more.
        if not self._greeted or session != self._session:
            self._session = session
            self._greeted = True
            self._tx_seq = 0
            self._rx_seq = 0
            self._pending = None
            self._connect_pending = True  # a new run: poll() runs on_connect
        self._send_hello_ack(session)

    def _on_output(self, seq, waiting):
        # A resend of one already handled: its ACK was lost. ACK, act once.
        if seq == self._rx_seq:
            self._ack(seq)
            return
        # A resend of the one being handled, or held, right now: its ACK
        # follows when the handler returns.
        if self._dispatching and seq == self._busy_seq and self._busy_session == self._session:
            return
        if self._pending is not None and seq == self._pending[1]:
            return
        rx = self._rx
        index = rx[_HEADER]
        width = rx[_HEADER + 1]
        value = rx[_HEADER + 2] | (rx[_HEADER + 3] << 8)
        if waiting or self._dispatching:
            # Never run a handler inside send() or inside another handler:
            # hold it for poll(). Chip Hippo sends one Output at a time.
            self._pending = (index, seq, width, value)
            return
        self._dispatch(index, seq, width, value)

    def _dispatch(self, index, seq, width, value):
        # Run an Output's function, then ACK — so Chip Hippo, which waits for
        # the ACK, knows the program has acted on it, and has everything the
        # function sent (its Inputs, its log) ahead of it.
        self._dispatching = True
        self._busy_seq = seq
        self._busy_session = self._session
        try:
            if index < len(_OUTPUTS) and width == _OUTPUTS[index][0]:
                fn = self._handlers[index]
                if fn is not None:
                    self._call(_OUTPUTS[index][1], fn, _OUTPUTS[index][2](value))
        finally:
            self._dispatching = False
        if self._busy_session != self._session:
            return  # a new run began meanwhile
        self._rx_seq = seq
        self._flush_log(False)
        self._ack(seq)


# The one link.
link = _Link()
`),
    "",
  );

  return {
    name: PYTHON_MODULE_FILE,
    text: L.join("\n"),
    hash,
    signature,
    warnings,
    outputs: plan.outputs.length,
    inputs: plan.inputs.length,
  };
}

// ── The examples ───────────────────────────────────────────────────────────

/**
 * The example program for the module — the header's example said in Python:
 * RECEIVE (a logging function per Output), SEND (every Input its starting
 * value at the start of every run, then the first Input's first field
 * counting up — a bit: toggling — once a second from the loop) and LOG, each
 * labelled where it happens. The timer uses the module's own `ticks_ms` /
 * `ticks_diff`, the one clock that reads the same on MicroPython,
 * CircuitPython and desktop Python. MicroPython's main.py and CircuitPython's
 * code.py are the same program — only the file a board runs at boot differs,
 * and what the opening comment says — plus CircuitPython's boot.py, which
 * turns on the second USB serial port the module talks over.
 *
 * @param {object} opts
 * @param {object} opts.connection
 * @param {Array} opts.elements
 * @returns {Array<{name: string, text: string}>} main.py, code.py, boot.py
 */
export function generatePythonExamples({ connection, elements }) {
  const plan = planIdentifiers(connection?.id ?? null, elements, PY_NAMING);
  const who = comment(JSON.stringify(String(connection?.name ?? "")));
  // What the loop sends: the first Input's first field.
  const input = plan.inputs[0] ?? null;
  const field = input?.fields[0] ?? null;
  const bit = field?.type === "bit";
  const value = bit ? "level" : "counter";
  const body = [
    input
      ? "from chiphippo import link, ticks_diff, ticks_ms"
      : "from chiphippo import link",
  ];
  if (input) {
    body.push(
      "",
      `# SEND: every SEND_EVERY_MS, the loop sends the Input ${comment(JSON.stringify(input.display))} its next value.`,
      "SEND_EVERY_MS = 1000",
      "last_send = 0",
      `${value} = ${bit ? "False" : "0"}`,
    );
  }
  if (!plan.outputs.length) {
    body.push(
      "",
      "",
      "# RECEIVE: this connection has no Outputs. Give it one and generate again,",
      "# and each time it fires it arrives in a function of its own here,",
      "# decorated @link.<its name>_in.",
    );
  }
  plan.outputs.forEach((o, n) => {
    const params = o.fields.map((f) => f.param);
    body.push(
      "",
      "",
      ...(n
        ? []
        : [
            "# RECEIVE: each Output arrives in a function of its own, each time it",
            "# fires, its fields the parameters. The circuit waits until it returns,",
            "# so keep it short.",
          ]),
      `@link.${o.id}  # the Output ${comment(JSON.stringify(o.display))} arrives here`,
      `def ${o.id}(${params.join(", ")}):`,
      ...(n ? [] : ["    # LOG: what arrived, to the connection window."]),
      `    link.print(${[pyString(`${o.display}:`), ...params.map((p) => `${pyString(`${p}=`)} + str(${p})`)].join(", ")})`,
    );
  });
  body.push(
    "",
    "",
    "# Runs at the start of every run, whether or not the board reset.",
    "@link.on_connect",
    "def run_started():",
    ...(input ? [`    global last_send, ${value}`] : []),
    `    link.print("Run started")  # LOG`,
  );
  if (plan.inputs.length) {
    body.push(
      "    # SEND each Input its starting value: an Input drives nothing until its",
      "    # first send().",
    );
    for (const i of plan.inputs) {
      body.push(`    # The Input ${comment(JSON.stringify(i.display))}.`);
      for (const f of i.fields) {
        body.push(
          `    link.${i.id}.${f.setter}(${f.type === "bit" ? "False" : "0"})`,
        );
      }
      body.push(`    link.${i.id}.send()`);
    }
    body.push(
      `    ${value} = ${bit ? "False" : "0"}`,
      "    last_send = ticks_ms()",
    );
  }
  if (input) {
    const wrap = field.type === "word" ? 65536 : 256;
    body.push(
      "",
      "",
      "# SEND: stands in for whatever your program reads — a switch, a sensor. Set",
      "# what changed, then send() the Input whole.",
      "def send_next():",
      `    global ${value}`,
      bit
        ? `    ${value} = not ${value}`
        : `    ${value} = (${value} + 1) % ${wrap}`,
      `    link.${input.id}.${field.setter}(${value})`,
      `    if link.${input.id}.send():`,
      `        link.print(${pyString(`Sent ${input.display}:`)}, ${pyString(`${field.param}=`)} + str(${value}))  # LOG`,
    );
  }
  body.push(
    "",
    "",
    "link.begin()",
    "while True:",
    "    link.poll()  # runs the Output functions: call it as often as you can",
    ...(input
      ? [
          "    if link.connected() and ticks_diff(ticks_ms(), last_send) >= SEND_EVERY_MS:",
          "        last_send = ticks_ms()",
          "        send_next()",
        ]
      : [
          "    # SEND: this connection has no Inputs. Give it one and generate again to",
          "    # send values into the circuit from here.",
        ]),
    "",
  );

  const program = (file, runtime, extra) =>
    [
      `# ${file} — an example ${runtime} program for the ${PYTHON_MODULE_FILE} generated for`,
      `# the connection ${who}. Copy ${PYTHON_MODULE_FILE} and this file to the board${extra}.`,
      "#",
      "# It shows the three things a program does with Chip Hippo:",
      "#   RECEIVE  each Output of the circuit arrives in a function of its own;",
      "#   SEND     set an Input's fields, then send() it into the circuit;",
      "#   LOG      link.print() writes to Chip Hippo's connection window. Never",
      "#            use print(): on MicroPython the link IS the port it writes to.",
      "",
      ...body,
    ].join("\n");

  return [
    {
      name: MICROPYTHON_MAIN,
      text: program(MICROPYTHON_MAIN, "MicroPython", ""),
    },
    {
      name: CIRCUITPYTHON_MAIN,
      text: program(
        CIRCUITPYTHON_MAIN,
        "CircuitPython",
        `, with ${CIRCUITPYTHON_BOOT}`,
      ),
    },
    {
      name: CIRCUITPYTHON_BOOT,
      text: [
        `# ${CIRCUITPYTHON_BOOT} — CircuitPython only: turns on the second USB serial port that`,
        `# ${PYTHON_MODULE_FILE} talks over, leaving the first for the REPL. Takes effect`,
        "# after the board resets. Point the connection's Port at the NEW port that",
        "# appears then, not the REPL's.",
        "",
        "import usb_cdc",
        "",
        "usb_cdc.enable(console=True, data=True)",
        "",
      ].join("\n"),
    },
  ];
}

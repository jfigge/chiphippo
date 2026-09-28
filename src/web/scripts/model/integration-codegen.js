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

// integration-codegen.js — the Arduino side of the serial integration, as a
// GENERATED HEADER, plus the DESIGN HASH that says when it is out of date.
// Pure: strings in, a string out.
//
// ONE HEADER PER CONNECTION PER DESKTOP. Each Arduino sees only its own
// connection's elements, and only the desktop on screen ever runs, so that is
// the scope Run has too. The header is a header ONLY: the user's sketch
// includes it and implements the Output functions it declares, so
// regenerating never touches a line the user wrote.
//
// What it holds:
//   · the DEVICE side of the serial protocol v1
//     (src/web/docs/serial-protocol.md): 0x7E framing with 0x7D escaping,
//     CRC-16/CCITT-FALSE, the HELLO / HELLO_ACK session (joined only when
//     the HELLO's version and layout are the sketch's own), ACK/NAK/retry,
//     SEQ de-duplication, and the OUTPUT ACK sent only once its handler
//     returns.
//     Every protocol number in it is WRITTEN FROM serial-wire.js — the module
//     main's own protocol.js reads — so the two ends cannot drift;
//   · `ChipHippo.begin()` / `ChipHippo.poll()` for setup() / loop(), and
//     `ChipHippo.onConnect(fn)`, which poll() runs at the start of EVERY run —
//     the one signal a board that does not reset when the port opens (a
//     Leonardo, most native-USB boards) gets that a new run has begun, since
//     `connected()` never goes false between two runs nobody sent in;
//   · one DECLARATION per Output, named after the element + `In`, one
//     parameter per field named after it (bool / uint8_t / uint16_t) — the
//     user defines it;
//   · per Input, a member of `ChipHippo` named after the element + `Out`,
//     with a setter per field and a `send()` that sends the whole group as
//     one frame;
//   · `ChipHippo.print()` / `println()` — the Link IS a Print, so every
//     overload Serial has works — carried as LOG frames;
//   · the LAYOUT SIGNATURE (integration.js's `layoutSignature`, the same
//     function a run's handshake calls) in HELLO_ACK, so a run refuses a
//     sketch built for a different layout instead of misrouting its data;
//   · the DESIGN HASH, in a comment — what the Generate button's staleness
//     dot compares; it moves with names too, which the signature never does.
//
// NAMES ARE THE SKETCH'S, SO THEY READ FROM THE ARDUINO'S SIDE. The elements
// are named from the circuit's (an Output leaves the circuit), but their
// identifiers only ever appear in the sketch, where an Output ARRIVES — so an
// Output's function ends in `In` and an Input's member in `Out`
// (`elementIdentifier`): `void DigitIn(…)` receives, `SegmentsOut.send()`
// sends, as `pinMode(pin, INPUT)` is the board's view. The header's comment
// and the example bridge the two ("the Output "Digit" arrives as DigitIn").
//
// NAMES BECOME C IDENTIFIERS, and that can collide. An Output and an Input
// cannot: the two suffixes differ, which matters because the Output's function
// is CALLED from inside the class that holds the Inputs, where a member of the
// same name would win and the header would not compile. What still can —
// two Outputs called "Status", a field called "delay" — is changed (a suffix)
// and REPORTED, a warning list the Generate dialog shows, never silently
// mangled.
//
// Beside the header, `generateExample` writes an EXAMPLE SKETCH that header
// works in — receiving (a logging function per Output), sending (every Input
// its starting value from `onConnect`, then a value counting up from loop())
// and logging — as the reference the Generate dialog shows and the header's
// comment points at. It is built from the same identifier plan, so the two
// cannot disagree about a name.
//
// This file has a twin, and they must agree byte for byte on the wire:
// app/tests/serial-arduino-header.test.js compiles this output with the host's
// C++ compiler against a stub Arduino core and talks to it with the real
// main-process link.

import {
  FIELD_PINS,
  elementsFor,
  fieldSpans,
  layoutSignature,
  layoutString,
  pinCount,
} from "./integration.js";
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
  HELLO_PREFIX,
  MAX_HOST_PAYLOAD,
  MAX_SENDS,
  MAX_SEQ,
  NOT_NAKED,
  PROTOCOL_VERSION,
  START,
} from "./serial-wire.js";

/** How much log text the sketch gathers before sending it as one LOG frame.
    The protocol allows 255; this is the DEVICE's choice — a Nano has 2 KB of
    RAM and a 64-byte serial buffer, and a line is rarely longer. */
const LOG_CHUNK = 60;

/** The generated code's own revision. Part of the design hash, so once a
    release is out, a header written before the code it generates changed
    shape reads as out of date. 1 until the first release: nothing written
    before it needs telling. */
const HEADER_REVISION = 1;

/** The header's file name — what the sketch #includes. */
export const HEADER_FILE = "ChipHippo.h";

/** The example sketch's file name (an Arduino sketch lives in a folder of the
    same name). The header's comment names it. */
export const EXAMPLE_FILE = "ChipHippoExample.ino";
// ── The design hash ────────────────────────────────────────────────────────

/** FNV-1a, 32-bit, over a string's UTF-8 bytes. */
export function fnv1a32(text) {
  const bytes = new TextEncoder().encode(String(text));
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** `0x1A2B3C4D` — how the hash is written, in the header and in the UI. */
export function hashHex(hash) {
  return `0x${(hash >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

/** What of an element the Arduino's code depends on — never its colour, its
    tags or its trigger, which are the circuit's business. */
const elementShape = (e) => ({
  name: e.name ?? e.id,
  fields: (e.fields ?? []).map((f) => [f.type, f.name]),
});

/**
 * The integration-relevant design for ONE connection: its Outputs and Inputs
 * (order, names, field shapes), the serial settings the header bakes in, and
 * the revision of the code that bakes them. Anything that changes the
 * generated code changes this; nothing else does.
 *
 * @param {object} connection the settings record (name, baud, …)
 * @param {Array} elements the desk's elements
 * @returns {number} an unsigned 32-bit hash
 */
export function designHash(connection, elements) {
  const id = connection?.id ?? null;
  return fnv1a32(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      g: HEADER_REVISION,
      connection: connection
        ? {
            name: connection.name,
            baud: connection.baud,
            dataBits: connection.dataBits,
            parity: connection.parity,
            stopBits: connection.stopBits,
            // Omitted for C++, the default, so a C++ header's hash is what
            // it was before a connection had a language to choose.
            ...(connection.language && connection.language !== "cpp"
              ? { language: connection.language }
              : {}),
          }
        : null,
      outputs: elementsFor(elements, id, "output").map(elementShape),
      inputs: elementsFor(elements, id, "input").map(elementShape),
    }),
  );
}

// ── Identifiers ────────────────────────────────────────────────────────────

/**
 * Words an identifier may not be: C++ keywords, the Arduino core's macros and
 * functions a sketch expects to find, and what this header itself defines.
 */
const RESERVED = new Set(
  (
    "alignas alignof and and_eq asm auto bitand bitor bool break case catch char " +
    "char16_t char32_t class compl const constexpr const_cast continue decltype " +
    "default delete do double dynamic_cast else enum explicit export extern " +
    "false float for friend goto if inline int long mutable namespace new " +
    "noexcept not not_eq nullptr operator or or_eq private protected public " +
    "register reinterpret_cast return short signed sizeof static static_assert " +
    "static_cast struct switch template this thread_local throw true try " +
    "typedef typeid typename union unsigned using virtual void volatile wchar_t " +
    "while xor xor_eq " +
    // GNU's own keyword: the Arduino toolchains build as gnu++11.
    "typeof " +
    // The Arduino core.
    "HIGH LOW INPUT OUTPUT INPUT_PULLUP LED_BUILTIN PI HALF_PI TWO_PI DEG_TO_RAD " +
    "RAD_TO_DEG SERIAL DISPLAY LSBFIRST MSBFIRST CHANGE FALLING RISING " +
    "setup loop main Serial Serial1 Serial2 Serial3 String Stream Print " +
    "boolean byte word bit abs min max round sq constrain map radians degrees " +
    "delay delayMicroseconds millis micros pinMode digitalWrite digitalRead " +
    "analogRead analogWrite analogReference tone noTone shiftIn shiftOut pulseIn " +
    "attachInterrupt detachInterrupt interrupts noInterrupts random randomSeed " +
    "lowByte highByte bitRead bitWrite bitSet bitClear yield " +
    "uint8_t uint16_t uint32_t int8_t int16_t int32_t size_t " +
    // This header: the link's members (an Input becomes one, and an Output's
    // function is CALLED from inside the class, where a member of the same
    // name would win) and its constants.
    "ChipHippo ChipHippoLink chiphippo begin poll print println write flush " +
    "sendInput connected onConnect bits pump handle damaged onHello onOutput " +
    "dispatch sendFrame putEscaped crcStep crc16 ack helloPayload flushLog " +
    "wholeChars io_ rx_ rxLen_ inFrame_ esc_ greeted_ session_ txSeq_ rxSeq_ " +
    "onConnect_ connectPending_ " +
    "dispatching_ busySeq_ pending_ pendingIndex_ pendingSeq_ " +
    "pendingWidth_ pendingValue_ log_ logLen_ bits_ K_START K_ESC K_ESC_XOR " +
    "F_HELLO F_HELLO_ACK F_ACK F_NAK F_OUTPUT F_INBOUND F_LOG R_NONE R_ACK " +
    "R_NAK HEADER CRC_LEN DATA_LEN HELLO_LEN HELLO_MIN RX_MAX LOG_CHUNK " +
    "OUTPUT_COUNT INPUT_COUNT"
  ).split(/\s+/),
);

/**
 * A name reduced to a valid C identifier: letters, digits and underscores,
 * not starting with a digit, never empty — "Output 1" → `Output1`,
 * "7-seg" → `_7seg`. Case is kept; everything else is dropped.
 */
export function cIdentifier(name, fallback = "x") {
  const ascii = String(name ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_]/g, "");
  const id = ascii || fallback;
  return /^[0-9]/.test(id) ? `_${id}` : id;
}

/**
 * Hands out identifiers from one namespace, changing (and reporting) any that
 * collide with a reserved word or with one already handed out. `clean` turns
 * a name into the language's identifier; `macroLike`, where given, marks one
 * that may be a macro's name and so is changed the same way.
 */
function identifierPool(
  warnings,
  reserved = RESERVED,
  clean = cIdentifier,
  macroLike = null,
) {
  const used = new Set();
  return (name, fallback, context) => {
    const base = clean(name, fallback);
    let id = base;
    let reason = null;
    if (reserved.has(id)) {
      reason = "reserved";
      id = `${base}_`;
    } else if (macroLike?.(id)) {
      reason = "macro";
      id = `${base}_`;
    }
    for (let n = 2; used.has(id); n++) {
      reason ??= "duplicate";
      id = `${base}_${n}`;
    }
    used.add(id);
    if (reason)
      warnings.push({ code: reason, name, identifier: id, ...context });
    return id;
  };
}

/**
 * An element's identifier, in the SKETCH's terms: its name as a C
 * identifier, then `In` for an Output (it arrives at the Arduino) or `Out`
 * for an Input (the Arduino sends it) — not doubled when the name already
 * ends that way ("DataIn" stays `DataIn`). The suffix is what keeps an Output
 * and an Input of the same name apart: an identifier ending `In` never ends
 * `Out`.
 */
export function elementIdentifier(name, fallback, kind) {
  const suffix = kind === "input" ? "Out" : "In";
  const base = cIdentifier(name, fallback);
  return base.endsWith(suffix) ? base : `${base}${suffix}`;
}

/** The C type a field is passed as. */
const C_TYPE = Object.freeze({
  bit: "bool",
  byte: "uint8_t",
  word: "uint16_t",
});

/** `setValue` from `value` — the setter for a field. */
const setterName = (id) => `set${id.charAt(0).toUpperCase()}${id.slice(1)}`;

/**
 * How a language spells things — what `planIdentifiers` is told, so one plan
 * (one set of collision rules, one warning list) serves every language
 * Generate writes. This is C++'s; integration-codegen-python.js has
 * Python's.
 */
export const CPP_NAMING = Object.freeze({
  identifier: cIdentifier,
  element: elementIdentifier,
  setter: setterName,
  reserved: RESERVED,
  setterReserved: new Set([...RESERVED, "send"]),
  type: C_TYPE,
  // An Output's parameter spelled in capitals (`SP`, `HEX`, `B0`, `BIT0`) gains
  // an underscore: the cores define object-like macros under ordinary names,
  // in capitals by convention, and a parameter spelled like one does not
  // compile. No list of them could be complete; the convention is the rule.
  // An Input's fields are only ever part of a setter's name (`setSP`), and an
  // element's name gains In/Out, so neither can be one.
  macroLike: (id) => /[A-Z]/.test(id) && !/[a-z]/.test(id) && !id.endsWith("_"),
});

/**
 * Work out every identifier the generated code uses, for one connection's
 * elements, in one language's spelling (`naming`, C++ by default).
 * @returns {{outputs: Array, inputs: Array, warnings: Array}}
 */
export function planIdentifiers(connectionId, elements, naming = CPP_NAMING) {
  const warnings = [];
  const pool = (reserved = naming.reserved, macroLike = null) =>
    identifierPool(warnings, reserved, naming.identifier, macroLike);
  const fnName = pool();
  const memberName = pool();
  const plan = (e, names, index) => {
    const display = e.name || e.id;
    // A warning names the element as the user wrote it, not its identifier.
    const id = names(naming.element(display, e.id, e.kind), e.id, {
      element: display,
      name: display,
    });
    const paramName = pool(
      naming.reserved,
      e.kind === "output" ? naming.macroLike : null,
    );
    const setters = pool(naming.setterReserved);
    const fields = fieldSpans(e.fields).map((span) => {
      const param = paramName(span.name, `${span.type}${span.first - 1}`, {
        element: display,
      });
      return {
        ...span,
        param,
        setter: setters(naming.setter(param), "set", { element: display }),
        cType: naming.type[span.type],
      };
    });
    return {
      element: e,
      index,
      display,
      id,
      fields,
      width: pinCount(e.fields),
    };
  };
  return {
    outputs: elementsFor(elements, connectionId, "output").map((e, i) =>
      plan(e, fnName, i),
    ),
    inputs: elementsFor(elements, connectionId, "input").map((e, i) =>
      plan(e, memberName, i),
    ),
    warnings,
  };
}

// ── The header ─────────────────────────────────────────────────────────────

/** The Arduino `SERIAL_xyz` constant for a connection's framing, or null for
    the core's default (8N1). 1.5 stop bits has no constant anywhere. */
export function serialConfigConstant(connection) {
  const bits = connection?.dataBits ?? 8;
  const parity = { none: "N", even: "E", odd: "O" }[
    connection?.parity ?? "none"
  ];
  const stop = connection?.stopBits ?? 1;
  if (bits === 8 && parity === "N" && stop === 1) return null;
  if (!parity || (stop !== 1 && stop !== 2)) return undefined; // unsupported
  return `SERIAL_${bits}${parity}${stop}`;
}

/** A value as a C string literal, for the comment lines that quote names. */
const quoted = (s) => JSON.stringify(String(s ?? ""));

/** A comment line, never letting a user's text close the comment or break
    onto a line of code. */
const comment = (s) => String(s ?? "").replace(/[\r\n]+/g, " ");

/** A protocol byte / word as a C hex literal. */
const hex2 = (n) => `0x${n.toString(16).toUpperCase().padStart(2, "0")}`;
const hex4 = (n) => `0x${n.toString(16).toUpperCase().padStart(4, "0")}`;

/** The header's name for each frame type — its F_ enum. */
const F_NAMES = new Map(
  Object.entries(FRAME).map(([name, value]) => [value, `F_${name}`]),
);

/** The C condition "a NAK is owed for a damaged frame of `type`": it is none
    of the frames that are never resent (serial-wire.js's NOT_NAKED). */
const OWES_NAK = NOT_NAKED.map((t) => `type != ${F_NAMES.get(t)}`).join(" && ");

/** The bit mask of a field, as a hex literal. */
const maskOf = (type) =>
  type === "word" ? "0xFFFFu" : type === "byte" ? "0xFFu" : "1u";

/** An Output's call: each field unpacked from the value `v`. */
function outputCall(o) {
  const args = o.fields.map((f) => {
    const shift = f.first - 1;
    const shifted = shift ? `(v >> ${shift})` : "v";
    if (f.type === "bit") return `((${shifted} & 1u) != 0)`;
    return `(${f.cType})(${shifted} & ${maskOf(f.type)})`;
  });
  return `${o.id}(${args.join(", ")})`;
}

/** One Input's setter lines. */
function inputSetters(i) {
  return i.fields.map((f) => {
    const shift = f.first - 1;
    if (f.type === "bit") {
      const bit = `(uint16_t)(1u << ${shift})`;
      return (
        `  void ${f.setter}(bool on) { if (on) bits_ |= ${bit}; ` +
        `else bits_ &= (uint16_t)~${bit}; }`
      );
    }
    if (f.type === "word") {
      return `  void ${f.setter}(uint16_t v) { bits_ = v; }`;
    }
    const mask = `(uint16_t)(0xFFu << ${shift})`;
    return (
      `  void ${f.setter}(uint8_t v) { bits_ = (uint16_t)((bits_ & (uint16_t)~${mask}) | ` +
      `((uint16_t)v << ${shift})); }`
    );
  });
}

/** What a field is, for a comment: "pins 1–8 data (uint8_t)". */
function describeField(f) {
  const pins =
    f.first === f.last ? `pin ${f.first}` : `pins ${f.first}-${f.last}`;
  return `${pins} ${f.param} (${f.cType})`;
}

/**
 * The header for one connection.
 *
 * @param {object} opts
 * @param {object} opts.connection the settings record
 * @param {Array} opts.elements the desk's elements (all of them — this picks
 *   the connection's own)
 * @param {string} [opts.projectName]
 * @param {string} [opts.desktopName]
 * @param {string} [opts.appVersion]
 * @returns {{text: string, hash: number, signature: number, warnings: Array,
 *   outputs: number, inputs: number}}
 */
export function generateHeader({
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
  const plan = planIdentifiers(connectionId, elements);
  const config = serialConfigConstant(connection);
  const warnings = [...plan.warnings];
  if (config === undefined) {
    warnings.push({ code: "serial-config", name: connection?.name ?? "" });
  }
  const baud = connection?.baud ?? 115200;
  const first = {
    output: plan.outputs[0],
    input: plan.inputs[0],
  };

  const L = [];
  const out = (...lines) => L.push(...lines);

  out(
    `// ChipHippo.h — generated by Chip Hippo${appVersion ? ` ${comment(appVersion)}` : ""} for the connection ${comment(quoted(connection?.name ?? ""))}.`,
    "//",
    ...(projectName ? [`//   Project:  ${comment(projectName)}`] : []),
    ...(desktopName ? [`//   Desktop:  ${comment(desktopName)}`] : []),
    `//   Design:   ${hashHex(hash)}`,
    `//   Layout:   ${hashHex(signature)} (${layout || "empty"})`,
    `//   Protocol: v${PROTOCOL_VERSION}`,
    "//",
    "// Do not edit this file: regenerate it from Chip Hippo (the Generate button)",
    "// whenever this connection's Outputs or Inputs change. Your sketch includes it",
    "// — from the .ino only — calls ChipHippo.begin() in setup() and",
    "// ChipHippo.poll() in loop(), and defines one function per Output.",
    "//",
    "// Names read from the Arduino's side. An Output of the circuit ARRIVES",
    "// here, so its function is its name + In, its fields the parameters; an",
    "// Input of the circuit is SENT from here, as ChipHippo.<its name + Out>.",
  );
  if (first.output) {
    const o = first.output;
    out(
      "//",
      `//   void ${o.id}(${o.fields.map((f) => `${f.cType} ${f.param}`).join(", ")}) { … }  // the Output ${comment(quoted(o.display))}`,
    );
  }
  if (first.input) {
    const i = first.input;
    const f = i.fields[0];
    const sample = f.type === "bit" ? "true" : "42";
    out(
      "//",
      "// Set what changed, then send() the whole group as one value:",
      "//",
      `//   ChipHippo.${i.id}.${f.setter}(${sample});  // the Input ${comment(quoted(i.display))}`,
      `//   ChipHippo.${i.id}.send();`,
      "//",
      "// send() returns false while no run is listening (ChipHippo.connected()).",
      "// An Input drives nothing until its first send(), so give each one its",
      "// starting value from ChipHippo.onConnect(fn): poll() runs fn at the start",
      "// of every run, whether or not the board reset when the port opened.",
    );
  }
  out(
    "//",
    `// ${EXAMPLE_FILE} is an example sketch that uses this header — receiving,`,
    "// sending and logging: in Chip Hippo, Generate shows it beside this header.",
  );
  out(
    "//",
    "// Call poll() often and keep Output functions short. While an Output is",
    "// being handled the circuit waits for it, so every delay() is time the",
    `// circuit stands still — Chip Hippo resends after ${ACK_TIMEOUT_MS} ms and stops the`,
    `// circuit after ${MAX_SENDS} tries. Log with ChipHippo.print()/println(), never`,
    "// Serial: Chip Hippo owns the port while the circuit runs.",
    "",
    "#ifndef CHIPHIPPO_H",
    "#define CHIPHIPPO_H",
    "",
    "#include <Arduino.h>",
    "",
    `#define CHIPHIPPO_PROTOCOL_VERSION ${PROTOCOL_VERSION}`,
    `#define CHIPHIPPO_LAYOUT_SIGNATURE ${hashHex(signature)}UL`,
    `#define CHIPHIPPO_BAUD ${baud}UL`,
    `#define CHIPHIPPO_ACK_TIMEOUT_MS ${ACK_TIMEOUT_MS}UL`,
    `#define CHIPHIPPO_MAX_SENDS ${MAX_SENDS}`,
    "",
  );

  out(
    "// ── Outputs: the circuit calls these. Implement each one in your sketch. ──",
  );
  if (plan.outputs.length === 0) out("// (this connection has no Outputs)");
  for (const o of plan.outputs) {
    out(
      `// ${comment(o.display)}: ${o.fields.map(describeField).join(", ")}`,
      `void ${o.id}(${o.fields.map((f) => `${f.cType} ${f.param}`).join(", ")});`,
    );
  }
  out("");

  out(
    "class ChipHippoLink;",
    "extern ChipHippoLink ChipHippo;",
    "",
    "// ── Inputs: set what changed, then send() the whole group as one frame. ──",
  );
  if (plan.inputs.length === 0) out("// (this connection has no Inputs)");
  for (const i of plan.inputs) {
    out(
      `// ${comment(i.display)}: ${i.fields.map(describeField).join(", ")}`,
      `class ChipHippo_${i.id} {`,
      " public:",
      ...inputSetters(i),
      "  // Send the whole group. True once Chip Hippo has it; false if it is not",
      "  // listening (the circuit is not running, or the cable is out).",
      "  bool send();",
      "  uint16_t bits() const { return bits_; }",
      "",
      " private:",
      "  uint16_t bits_ = 0;",
      "};",
      "",
    );
  }

  out(
    "class ChipHippoLink : public Print {",
    " public:",
    ...plan.inputs.map((i) => `  ChipHippo_${i.id} ${i.id};`),
    ...(plan.inputs.length ? [""] : []),
    "  // Open the serial port and announce the sketch. Call once, from setup().",
    "  void begin(unsigned long baud = CHIPHIPPO_BAUD) {",
    config ? `    Serial.begin(baud, ${config});` : "    Serial.begin(baud);",
    "    begin(Serial);",
    "  }",
    "",
    "  // The same, over a port you have already begun.",
    "  void begin(Stream& io) {",
    "    io_ = &io;",
    "    inFrame_ = false;",
    "    esc_ = false;",
    "    rxLen_ = 0;",
    "    greeted_ = false;",
    "    session_ = 0;",
    "    txSeq_ = 0;",
    "    rxSeq_ = 0;",
    "    dispatching_ = false;",
    "    pending_ = false;",
    "    connectPending_ = false;",
    "    logLen_ = 0;",
    '    // Session 0 says "I have just started": a circuit that was running',
    "    // learns this sketch has forgotten it, and stops rather than go deaf.",
    "    sendHelloAck(0, 0);",
    "  }",
    "",
    "  // Service the link: runs Output functions, answers Chip Hippo. Call it",
    "  // from loop(), as often as you can.",
    "  void poll() {",
    "    if (!io_) return;",
    "    pump(false, 0);",
    "    if (connectPending_ && !dispatching_) {",
    "      connectPending_ = false;",
    "      if (onConnect_) onConnect_();",
    "    }",
    "    if (pending_ && !dispatching_) {",
    "      pending_ = false;",
    "      dispatch(pendingIndex_, pendingSeq_, pendingWidth_, pendingValue_);",
    "    }",
    "    flushLog(false);",
    "  }",
    "",
    "  // True from Chip Hippo's HELLO (for this design) until a send it never",
    "  // acknowledged: while it is false, an Input's send() fails at once.",
    "  bool connected() const { return greeted_; }",
    "",
    "  // Run `fn` from poll() at the start of every run, once Chip Hippo has",
    "  // greeted the sketch — whether or not the board reset when the port",
    "  // opened (connected() alone cannot say so: between two runs it stays",
    "  // true until a send fails). The place to send your Inputs' starting",
    "  // values. Call it from setup(); 0 turns it off.",
    "  void onConnect(void (*fn)()) { onConnect_ = fn; }",
    "",
    "  // Log text: ChipHippo.print()/println() reach Chip Hippo's log window.",
    "  size_t write(uint8_t b) {",
    "    if (!io_) return 0;",
    "    if (logLen_ == LOG_CHUNK) {",
    "      flushLog(false);",
    "      if (logLen_ == LOG_CHUNK) flushLog(true);  // no character to cut at",
    "    }",
    "    log_[logLen_++] = b;",
    "    if (b == '\\n') flushLog(true);",
    "    return 1;",
    "  }",
    "  using Print::write;",
    "",
    "  // Used by the Inputs' send(). Waits for Chip Hippo's ACK, resending on",
    "  // a NAK or a timeout, and keeps the link serviced while it waits.",
    "  bool sendInput(uint8_t index, uint8_t width, uint16_t value) {",
    "    // Not in a session — or inside a handler whose session has ended.",
    "    if (!io_ || !greeted_ || (dispatching_ && !busySeq_)) return false;",
    "    flushLog(false);",
    "    const uint8_t payload[DATA_LEN] = {index, width, (uint8_t)(value & 0xFF),",
    "                                       (uint8_t)(value >> 8)};",
    `    txSeq_ = (uint8_t)(txSeq_ % ${MAX_SEQ} + 1);`,
    "    const uint8_t seq = txSeq_;",
    "    for (uint8_t n = 0; n < CHIPHIPPO_MAX_SENDS; n++) {",
    "      sendFrame(F_INBOUND, seq, payload, DATA_LEN);",
    "      unsigned long start = millis();",
    "      while ((unsigned long)(millis() - start) < CHIPHIPPO_ACK_TIMEOUT_MS) {",
    "        uint8_t r = pump(true, seq);",
    "        if (txSeq_ != seq) return false;  // a new session reset txSeq_",
    "        if (r == R_ACK) return true;",
    "        if (r == R_NAK) break;",
    "      }",
    "    }",
    "    // Nobody is listening: leave the session — nothing more of it goes out,",
    "    // not even a held or running Output's ACK — and say so, as begin() does.",
    "    greeted_ = false;",
    "    busySeq_ = 0;",
    "    pending_ = false;",
    "    sendHelloAck(0, 0);",
    "    return false;",
    "  }",
    "",
    " private:",
    `  enum { K_START = ${hex2(START)}, K_ESC = ${hex2(ESC)}, K_ESC_XOR = ${hex2(ESC_XOR)} };`,
    `  enum { F_HELLO = ${hex2(FRAME.HELLO)}, F_HELLO_ACK = ${hex2(FRAME.HELLO_ACK)}, F_ACK = ${hex2(FRAME.ACK)}, F_NAK = ${hex2(FRAME.NAK)},`,
    `         F_OUTPUT = ${hex2(FRAME.OUTPUT)}, F_INBOUND = ${hex2(FRAME.INBOUND)}, F_LOG = ${hex2(FRAME.LOG)} };`,
    "  enum { R_NONE = 0, R_ACK = 1, R_NAK = 2 };",
    `  enum { HEADER = ${HEADER_BYTES}, CRC_LEN = ${CRC_BYTES}, DATA_LEN = ${DATA_PAYLOAD}, HELLO_LEN = ${HELLO_PAYLOAD}, HELLO_MIN = ${HELLO_PREFIX} };`,
    "  // The longest frame this side is ever sent: anything longer is damage.",
    `  enum { RX_MAX = ${MAX_HOST_PAYLOAD}, LOG_CHUNK = ${LOG_CHUNK} };`,
    `  enum { OUTPUT_COUNT = ${plan.outputs.length}, INPUT_COUNT = ${plan.inputs.length} };`,
    "",
    "  // CRC-16/CCITT-FALSE, a bit at a time: no table, so no flash spent on one.",
    "  static uint16_t crcStep(uint16_t crc, uint8_t b) {",
    "    crc ^= (uint16_t)((uint16_t)b << 8);",
    "    for (uint8_t i = 0; i < 8; i++) {",
    `      crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ ${hex4(CRC16_POLY)}) : (uint16_t)(crc << 1);`,
    "    }",
    "    return crc;",
    "  }",
    "",
    "  static uint16_t crc16(const uint8_t* p, uint8_t n) {",
    `    uint16_t crc = ${hex4(CRC16_INIT)};`,
    "    while (n--) crc = crcStep(crc, *p++);",
    "    return crc;",
    "  }",
    "",
    "  void putEscaped(uint8_t b) {",
    "    if (b == K_START || b == K_ESC) {",
    "      io_->write((uint8_t)K_ESC);",
    "      io_->write((uint8_t)(b ^ K_ESC_XOR));",
    "    } else {",
    "      io_->write(b);",
    "    }",
    "  }",
    "",
    "  void sendFrame(uint8_t type, uint8_t seq, const uint8_t* payload,",
    "                 uint8_t len) {",
    `    uint16_t crc = ${hex4(CRC16_INIT)};`,
    "    io_->write((uint8_t)K_START);",
    "    const uint8_t head[HEADER] = {type, seq, len};",
    "    for (uint8_t i = 0; i < HEADER; i++) {",
    "      crc = crcStep(crc, head[i]);",
    "      putEscaped(head[i]);",
    "    }",
    "    for (uint8_t i = 0; i < len; i++) {",
    "      crc = crcStep(crc, payload[i]);",
    "      putEscaped(payload[i]);",
    "    }",
    "    putEscaped((uint8_t)(crc & 0xFF));",
    "    putEscaped((uint8_t)(crc >> 8));",
    "  }",
    "",
    "  // An Output's ACK: its SEQ is the one a resend is recognised by.",
    "  void ack(uint8_t seq) {",
    "    rxSeq_ = seq;",
    "    sendFrame(F_ACK, seq, 0, 0);",
    "  }",
    "",
    "  // This sketch's version, `session` and layout, to any HELLO: only Chip",
    "  // Hippo judges. True if the HELLO in rx_ was these 7 bytes: joinable.",
    "  bool sendHelloAck(uint16_t session, uint8_t len) {",
    "    const unsigned long s = CHIPHIPPO_LAYOUT_SIGNATURE;",
    "    const uint8_t p[HELLO_LEN] = {",
    "        CHIPHIPPO_PROTOCOL_VERSION,  (uint8_t)(session & 0xFF),",
    "        (uint8_t)(session >> 8),     (uint8_t)(s & 0xFF),",
    "        (uint8_t)((s >> 8) & 0xFF),  (uint8_t)((s >> 16) & 0xFF),",
    "        (uint8_t)((s >> 24) & 0xFF)};",
    "    sendFrame(F_HELLO_ACK, 0, p, HELLO_LEN);",
    "    uint8_t i = 0;",
    "    while (i < HELLO_LEN && rx_[HEADER + i] == p[i]) i++;",
    "    return len == HELLO_LEN && i == HELLO_LEN;",
    "  }",
    "",
    "  // How much of the log ends on a whole UTF-8 character: a LOG frame never",
    "  // splits one.",
    "  uint8_t wholeChars() const {",
    "    uint8_t i = logLen_, tail = 0;",
    "    while (i > 0 && tail < 3 && (log_[i - 1] & 0xC0) == 0x80) {",
    "      i--;",
    "      tail++;",
    "    }",
    "    if (i == 0) return logLen_;",
    "    const uint8_t lead = log_[i - 1];",
    "    const uint8_t need = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1;",
    "    return need > tail + 1 ? (uint8_t)(i - 1) : logLen_;",
    "  }",
    "",
    "  // Send what the log holds (up to its last whole character, unless `all`).",
    "  // Log text is never acknowledged, so it goes whether or not anyone is",
    "  // listening — and never keeps the sketch waiting.",
    "  void flushLog(bool all) {",
    "    if (!io_ || logLen_ == 0) return;",
    "    const uint8_t n = all ? logLen_ : wholeChars();",
    "    if (n == 0) return;",
    "    sendFrame(F_LOG, 0, log_, n);",
    "    for (uint8_t i = n; i < logLen_; i++) log_[i - n] = log_[i];",
    "    logLen_ = (uint8_t)(logLen_ - n);",
    "  }",
    "",
    "  // Read what has arrived. Returns R_ACK/R_NAK when `waiting` and the frame",
    "  // it waits on was answered; frames for someone else are handled here.",
    "  uint8_t pump(bool waiting, uint8_t waitSeq) {",
    "    while (io_->available() > 0) {",
    "      uint8_t b = (uint8_t)io_->read();",
    "      if (b == K_START) {",
    "        inFrame_ = true;",
    "        esc_ = false;",
    "        rxLen_ = 0;",
    "        continue;",
    "      }",
    "      if (!inFrame_) continue;",
    "      if (esc_) {",
    "        esc_ = false;",
    "        b ^= K_ESC_XOR;",
    "        if (b != K_START && b != K_ESC) {",
    "          damaged();",
    "          continue;",
    "        }",
    "      } else if (b == K_ESC) {",
    "        esc_ = true;",
    "        continue;",
    "      }",
    "      rx_[rxLen_++] = b;",
    "      if (rxLen_ < HEADER) continue;",
    "      const uint8_t len = rx_[2];",
    "      if (len > RX_MAX) {",
    "        damaged();",
    "        continue;",
    "      }",
    "      if (rxLen_ < (uint8_t)(HEADER + len + CRC_LEN)) continue;",
    "      inFrame_ = false;",
    "      uint8_t r = handle(len, waiting, waitSeq);",
    "      if (waiting && r != R_NONE) return r;",
    "    }",
    "    return R_NONE;",
    "  }",
    "",
    "  // A frame arrived damaged: ask for a resend at once — unless it was one",
    "  // that is never resent, or this sketch is in no session.",
    "  void damaged() {",
    "    inFrame_ = false;",
    "    const uint8_t type = rxLen_ ? rx_[0] : 0;",
    `    if (greeted_ && ${OWES_NAK}) {`,
    "      sendFrame(F_NAK, 0, 0, 0);",
    "    }",
    "  }",
    "",
    "  uint8_t handle(uint8_t len, bool waiting, uint8_t waitSeq) {",
    "    const uint8_t type = rx_[0], seq = rx_[1];",
    "    const uint16_t crc =",
    "        (uint16_t)(rx_[HEADER + len] | ((uint16_t)rx_[HEADER + len + 1] << 8));",
    "    if (crc16(rx_, (uint8_t)(HEADER + len)) != crc) {",
    "      damaged();",
    "      return R_NONE;",
    "    }",
    "    if (type == F_HELLO) {",
    "      onHello(len);",
    "      return R_NONE;",
    "    }",
    "    if (!greeted_) return R_NONE;  // nothing counts before a HELLO",
    "    switch (type) {",
    "      case F_ACK:",
    "        return (waiting && seq == waitSeq) ? R_ACK : R_NONE;",
    "      case F_NAK:",
    "        return waiting ? R_NAK : R_NONE;",
    "      case F_OUTPUT:",
    "        if (!seq) return R_NONE;  // SEQ 0 is never a data frame's",
    "        // Intact but unreadable: ACK and drop — a resend would be the same.",
    "        if (len == DATA_LEN) onOutput(seq, waiting);",
    "        else ack(seq);",
    "        return R_NONE;",
    "      default:",
    "        return R_NONE;",
    "    }",
    "  }",
    "",
    "  // A HELLO names the run's SESSION (never 0). Only a new one resets what",
    "  // this side remembers — a repeat of the last (the host asks until it",
    "  // hears) is answered and nothing more, or it would rewind the SEQs.",
    "  void onHello(uint8_t len) {",
    "    const uint16_t session =",
    "        (uint16_t)(rx_[HEADER + 1] | ((uint16_t)rx_[HEADER + 2] << 8));",
    "    if (len < HELLO_MIN || session == 0) return;",
    "    const bool join = sendHelloAck(session, len);",
    "    if (session == session_) return;",
    "    session_ = session;",
    "    greeted_ = join;",
    "    connectPending_ = join;  // a new run: poll() runs onConnect",
    "    txSeq_ = 0;",
    "    rxSeq_ = 0;",
    "    busySeq_ = 0;  // an Output being handled is the old run's: no ACK",
    "    pending_ = false;",
    "  }",
    "",
    "  void onOutput(uint8_t seq, bool waiting) {",
    "    // A resend of one already handled: its ACK was lost. ACK, act once.",
    "    if (seq == rxSeq_) {",
    "      ack(seq);",
    "      return;",
    "    }",
    "    // A resend of the one being handled, or held, right now: its ACK",
    "    // follows when the handler returns — an ACK now would let the circuit",
    "    // run on before the handler's own Inputs had reached it.",
    "    if (dispatching_ && seq == busySeq_) return;",
    "    if (pending_ && seq == pendingSeq_) return;",
    "    const uint8_t index = rx_[HEADER], width = rx_[HEADER + 1];",
    "    const uint16_t value =",
    "        (uint16_t)(rx_[HEADER + 2] | ((uint16_t)rx_[HEADER + 3] << 8));",
    "    if (waiting || dispatching_) {",
    "      // Never run a handler inside send() or inside another handler: hold",
    "      // it for poll(). Chip Hippo sends one Output at a time, so one slot.",
    "      pending_ = true;",
    "      pendingIndex_ = index;",
    "      pendingSeq_ = seq;",
    "      pendingWidth_ = width;",
    "      pendingValue_ = value;",
    "      return;",
    "    }",
    "    dispatch(index, seq, width, value);",
    "  }",
    "",
    "  // Run an Output's function, then ACK — so Chip Hippo, which waits for",
    "  // the ACK, knows the sketch has acted on it, and has everything the",
    "  // function sent (its Inputs, its log) ahead of it.",
    "  void dispatch(uint8_t index, uint8_t seq, uint8_t width, uint16_t v) {",
    "    dispatching_ = true;",
    "    busySeq_ = seq;",
    "    switch (index) {",
    ...plan.outputs.flatMap((o) => [
      `      case ${o.index}:`,
      `        if (width == ${o.width}) ${outputCall(o)};`,
      "        break;",
    ]),
    "      default:",
    "        (void)v;",
    "        (void)width;",
    "        break;",
    "    }",
    "    dispatching_ = false;",
    "    if (busySeq_ != seq) return;  // a new session began meanwhile",
    "    flushLog(false);",
    "    ack(seq);",
    "  }",
    "",
    "  Stream* io_ = 0;",
    "  uint8_t rx_[HEADER + RX_MAX + CRC_LEN];",
    "  uint8_t rxLen_ = 0;",
    "  bool inFrame_ = false;",
    "  bool esc_ = false;",
    "  bool greeted_ = false;",
    "  uint16_t session_ = 0;",
    "  uint8_t txSeq_ = 0;",
    "  uint8_t rxSeq_ = 0;",
    "  bool dispatching_ = false;",
    "  uint8_t busySeq_ = 0;",
    "  bool pending_ = false;",
    "  uint8_t pendingIndex_ = 0, pendingSeq_ = 0, pendingWidth_ = 0;",
    "  uint16_t pendingValue_ = 0;",
    "  uint8_t log_[LOG_CHUNK];",
    "  uint8_t logLen_ = 0;",
    "  void (*onConnect_)() = 0;",
    "  bool connectPending_ = false;",
    "};",
    "",
    ...plan.inputs.map(
      (i) =>
        `inline bool ChipHippo_${i.id}::send() { return ChipHippo.sendInput(${i.index}, ${i.width}, bits_); }`,
    ),
    ...(plan.inputs.length ? [""] : []),
    "// The one link. Defined here, so include this header from the .ino only.",
    "ChipHippoLink ChipHippo;",
    "",
    "#endif  // CHIPHIPPO_H",
    "",
  );

  return {
    text: L.join("\n"),
    hash,
    signature,
    warnings,
    outputs: plan.outputs.length,
    inputs: plan.inputs.length,
  };
}

// ── The example ────────────────────────────────────────────────────────────

/** A user's text as a C string literal: quotes and backslashes escaped,
    control characters dropped, and no `??` left to read as a trigraph. */
const cString = (s) =>
  `"${[...String(s ?? "")]
    .map((c) => (c < " " || c === "\x7f" ? " " : c))
    .join("")
    .replace(/[\\"]/g, "\\$&")
    .replace(/\?\?/g, "?\\?")}"`;

/**
 * The example sketch for one connection's header, showing the three things a
 * sketch does with the link, each labelled where it happens:
 *
 *   · RECEIVE — one function per Output, logging what arrived;
 *   · SEND    — every Input its starting value from `onConnect`, and then
 *               the first Input's first field counting up (a bit: toggling)
 *               once a second from loop(), standing in for a switch or a
 *               sensor — set what changed, then send();
 *   · LOG     — a line at the start of every run, one per Output that
 *               arrives, one per value sent.
 *
 * A connection with no Outputs (or no Inputs) says so where that code would
 * be, so the example still shows where it goes. Built from the header's own
 * identifier plan, so every name in it is one the header declares, and the
 * sketch's own globals cannot collide with one: an Output's function always
 * ends in `In`. English, like the header: it is code.
 *
 * @param {object} opts
 * @param {object} opts.connection the settings record
 * @param {Array} opts.elements the desk's elements (this picks the
 *   connection's own)
 * @returns {{name: string, text: string}}
 */
export function generateExample({ connection, elements }) {
  const plan = planIdentifiers(connection?.id ?? null, elements);
  // What loop() sends: the first Input's first field.
  const input = plan.inputs[0] ?? null;
  const field = input?.fields[0] ?? null;
  const bit = field?.type === "bit";
  const value = bit ? "level" : "counter";
  const L = [
    `// ${EXAMPLE_FILE} — an example sketch for the ChipHippo.h generated for`,
    `// the connection ${comment(quoted(connection?.name ?? ""))}. Put ChipHippo.h in this sketch's folder.`,
    "//",
    "// It shows the three things a sketch does with Chip Hippo:",
    "//   RECEIVE  each Output of the circuit arrives in a function of its own;",
    "//   SEND     set an Input's fields, then send() it into the circuit;",
    "//   LOG      ChipHippo.print() / println() write to Chip Hippo's connection",
    "//            window. Never use Serial: Chip Hippo owns the port.",
    "",
    '#include "ChipHippo.h"',
  ];
  if (input) {
    L.push(
      "",
      `// SEND: every SEND_EVERY_MS, loop() sends the Input ${comment(quoted(input.display))} its next value.`,
      "const unsigned long SEND_EVERY_MS = 1000;",
      "unsigned long lastSend = 0;",
      `${field.cType} ${value} = ${bit ? "false" : "0"};`,
    );
  }
  if (!plan.outputs.length) {
    L.push(
      "",
      "// RECEIVE: this connection has no Outputs. Give it one and generate again,",
      "// and each time it fires Chip Hippo calls a function of its own here:",
      "//   void <its name>In(<its fields>) { … }",
    );
  }
  plan.outputs.forEach((o, n) => {
    L.push(
      "",
      ...(n
        ? [
            `// RECEIVE: each time the Output ${comment(quoted(o.display))} fires.`,
          ]
        : [
            `// RECEIVE: Chip Hippo calls this each time the Output ${comment(quoted(o.display))} fires,`,
            "// its fields the parameters. The circuit waits until it returns, so keep",
            "// it short.",
          ]),
      `void ${o.id}(${o.fields.map((f) => `${f.cType} ${f.param}`).join(", ")}) {`,
      ...(n ? [] : ["  // LOG: what arrived, to the connection window."]),
      ...o.fields.flatMap((f, k) => [
        `  ChipHippo.print(${cString(`${k ? " " : `${o.display}: `}${f.param}=`)});`,
        `  ChipHippo.print(${f.param});`,
      ]),
      "  ChipHippo.println();",
      "}",
    );
  });
  L.push(
    "",
    "// Runs at the start of every run, whether or not the board reset.",
    "void runStarted() {",
    '  ChipHippo.println("Run started");  // LOG',
  );
  if (plan.inputs.length) {
    L.push(
      "  // SEND each Input its starting value: an Input drives nothing until its",
      "  // first send().",
    );
    for (const i of plan.inputs) {
      L.push(`  // The Input ${comment(quoted(i.display))}.`);
      for (const f of i.fields) {
        L.push(
          `  ChipHippo.${i.id}.${f.setter}(${f.type === "bit" ? "false" : "0"});`,
        );
      }
      L.push(`  ChipHippo.${i.id}.send();`);
    }
    L.push(`  ${value} = ${bit ? "false" : "0"};`, "  lastSend = millis();");
  }
  L.push("}");
  if (input) {
    L.push(
      "",
      "// SEND: stands in for whatever your sketch reads — a switch, a sensor. Set",
      "// what changed, then send() the Input whole.",
      "void sendNext() {",
      bit ? `  ${value} = !${value};` : `  ${value}++;`,
      `  ChipHippo.${input.id}.${field.setter}(${value});`,
      `  if (ChipHippo.${input.id}.send()) {`,
      `    ChipHippo.print(${cString(`Sent ${input.display}: ${field.param}=`)});  // LOG`,
      `    ChipHippo.println(${value});`,
      "  }",
      "}",
    );
  }
  L.push(
    "",
    "void setup() {",
    "  ChipHippo.onConnect(runStarted);",
    "  ChipHippo.begin();",
    "}",
    "",
    "void loop() {",
    "  ChipHippo.poll();  // runs the Output functions: call it as often as you can",
    ...(input
      ? [
          "  if (ChipHippo.connected() && millis() - lastSend >= SEND_EVERY_MS) {",
          "    lastSend = millis();",
          "    sendNext();",
          "  }",
        ]
      : [
          "  // SEND: this connection has no Inputs. Give it one and generate again to",
          "  // send values into the circuit from here.",
        ]),
    "}",
    "",
  );
  return { name: EXAMPLE_FILE, text: L.join("\n") };
}

/** How many pins a field type takes (re-exported for the dialog's summary). */
export { FIELD_PINS };

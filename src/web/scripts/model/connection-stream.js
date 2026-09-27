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

// connection-stream.js — what a CONNECTION WINDOW's stream says
// (docs/chiphippo-connection-window.md). Main records each connection's stream
// as FACTS (app/serial/connection-stream.js: codes, numbers, times); this
// turns one entry into the line the window prints and Save… writes. Pure —
// no DOM — so both, and the tests, format exactly alike.
//
// Every line is one of four kinds, told apart by a fixed-width PREFIX column
// and a colour:
//
//   log       (no prefix)  what the device printed
//   data      →  or  ←     a value that crossed: → leaves Chip Hippo (an
//                          OUTPUT), ← arrives (an INBOUND) — Chip Hippo's
//                          point of view in every window, the Mock's included
//   protocol  ·            the protocol's own traffic and a run's milestones
//   error     !            a resend, a damaged frame, a failure — ALWAYS shown,
//                          whatever the filters say
//
// The protocol's NOTATION — frame names (OUTPUT, HELLO_ACK), `seq`, `sig`,
// `v1` — is written as the protocol document writes it and never translated,
// the way a format name is not. The sentences around it are the catalog's.
//
// Timestamps count from the RUN's start (`t0`): `+  12.345` — elapsed time is
// what lines a frame up with the log output it caused; the wall clock is not.

import { t } from "../i18n.js";
import { describeFields } from "./integration.js";
import { FRAME, PROTOCOL_VERSION } from "./serial-wire.js";

/** The four kinds, in the order the filters are offered (errors have none). */
export const STREAM_KINDS = Object.freeze(["log", "data", "protocol", "error"]);

/** The three a filter can hide. Errors are always shown. */
export const FILTERED_KINDS = Object.freeze(["log", "data", "protocol"]);

/** A frame type's name, as the protocol writes it. */
const FRAME_NAMES = new Map(
  Object.entries(FRAME).map(([name, value]) => [value, name]),
);

const hex8 = (n) =>
  (Number(n) >>> 0).toString(16).toUpperCase().padStart(8, "0");

/** Which of the four kinds an entry is, or null for one this build does not
    know (a newer main's). */
export function streamKind(entry) {
  switch (entry?.kind) {
    case "text":
      return "log";
    case "data":
      return "data";
    case "proto":
      return "protocol";
    case "error":
      return "error";
    default:
      return null;
  }
}

/** The prefix column's one character. */
export function streamPrefix(entry) {
  switch (streamKind(entry)) {
    case "data":
      return entry.dir === "out" ? "→" : "←";
    case "protocol":
      return "·";
    case "error":
      return "!";
    default:
      return "";
  }
}

/**
 * Time since the run began, seconds to the millisecond: `+  12.345`. Blank
 * when there is no run to count from.
 */
export function streamTime(entry, t0) {
  if (t0 == null || !Number.isFinite(entry?.t)) return "";
  const s = Math.max(0, entry.t - t0) / 1000;
  return `+${s.toFixed(3).padStart(8)}`;
}

/** The bytes a data frame went on the wire as: `7E 10 01 04 …`. */
export function streamRaw(entry) {
  if (!Array.isArray(entry?.raw)) return null;
  return entry.raw
    .map((b) => (b & 0xff).toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");
}

/** A value, in the design's words when the entry carries its element. */
function dataText(entry) {
  const head = entry.dir === "out" ? "OUTPUT " : "INBOUND";
  const value = Number(entry.value) >>> 0;
  const element = entry.element;
  const body = element?.fields?.length
    ? `${element.name}  ${describeFields(element.fields, value)}`
    : `#${entry.index}  0x${value.toString(16).toUpperCase()} (${entry.width})`;
  return `${head}  ${body}`;
}

const say = (key, params) => t(`integration.log.event.${key}`, params);

function protocolText(e) {
  switch (e.event) {
    case "open":
      return e.port ? say("openPort", { port: e.port }) : say("open");
    case "close":
      return say("close");
    case "hello":
      return `→ HELLO v${e.version} sig ${hex8(e.signature)} session ${e.session}`;
    case "hello-ack":
      return `← HELLO_ACK v${e.version} sig ${hex8(e.signature)} session ${e.session}`;
    case "handshake":
      return say("handshake", {
        version: e.version,
        signature: hex8(e.signature),
      });
    case "announce":
      return `← HELLO_ACK session 0 — ${say("announce")}`;
    case "ack-in":
      return `← ACK seq ${e.seq}`;
    case "ack-out":
      return `→ ACK seq ${e.seq}`;
    case "stale-ack":
      return `← ACK seq ${e.seq} — ${say("staleAck")}`;
    case "nak-idle":
      return `← NAK — ${say("nakIdle")}`;
    default:
      return e.event ?? "";
  }
}

function errorText(e) {
  switch (e.event) {
    case "resend":
      return e.cause === "nak"
        ? `← NAK — ${say("resend", e)}`
        : say("noAck", e);
    case "failed":
      return say("failed", e);
    case "damaged": {
      const frame = FRAME_NAMES.get(e.type) ?? say("frame");
      const params = { frame, error: say(`damage.${e.error ?? "crc"}`) };
      return say(e.nak ? "damagedNak" : "damagedDropped", params);
    }
    case "duplicate":
      return `← INBOUND seq ${e.seq} — ${say("duplicate")}`;
    case "unusable":
      return `← INBOUND seq ${e.seq} — ${say("unusable")}`;
    case "no-response":
      return say("noResponse", { seconds: Math.round((e.ms ?? 0) / 1000) });
    case "version":
      return say("version", { version: e.version, host: PROTOCOL_VERSION });
    case "signature":
      return say("signature", {
        signature: hex8(e.signature),
        expected: hex8(e.expected),
      });
    case "restart":
      return say("restart");
    case "dropped":
      return e.detail ? say("droppedDetail", { detail: e.detail }) : say("dropped"); // prettier-ignore
    case "open-failed":
      return say("openFailed", { detail: e.detail ?? "" });
    default:
      return e.event ?? "";
  }
}

/** What an entry says, after its prefix. */
export function streamText(entry) {
  switch (streamKind(entry)) {
    case "log":
      return String(entry.text ?? "");
    case "data":
      return dataText(entry);
    case "protocol":
      return protocolText(entry);
    case "error":
      return errorText(entry);
    default:
      return "";
  }
}

/**
 * One entry as a window line: its kind (and a data line's direction), time
 * column, prefix, text, and the raw bytes a data line shows on hover.
 */
export function formatEntry(entry, t0) {
  const kind = streamKind(entry);
  return {
    kind,
    dir: kind === "data" ? (entry.dir === "out" ? "out" : "in") : null,
    time: streamTime(entry, t0),
    prefix: streamPrefix(entry),
    text: streamText(entry),
    raw: streamRaw(entry),
  };
}

/** Is a line of this kind shown under these filters? Errors always are. */
export function isShown(kind, filters) {
  if (kind === "error") return true;
  return filters?.[kind] !== false;
}

/**
 * The whole stream as a text file — what Save… writes: every entry of every
 * kind, WITH its time, whatever the window is showing, then the unfinished
 * last line of log text if there is one.
 */
export function streamFile(entries, { t0 = null, partial = "" } = {}) {
  const line = (entry) => {
    const f = formatEntry(entry, t0);
    return [f.time || "", (f.prefix || " ").padEnd(1), f.text]
      .filter((part, i) => i > 0 || part)
      .join("  ");
  };
  const lines = (entries ?? []).filter((e) => streamKind(e)).map(line);
  if (partial) {
    lines.push(line({ kind: "text", t: Date.now(), text: partial }));
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

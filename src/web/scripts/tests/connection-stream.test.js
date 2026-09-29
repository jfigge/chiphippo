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

// Tests for model/connection-stream.js — what each stream entry SAYS in a
// connection window: its kind and prefix (Chip Hippo's arrows, · for the
// protocol, ! for errors), the time since the run began, a data value in the
// design's words, every protocol and error event in the catalog's words
// around the protocol's own notation, errors never filtered out, and the
// Save… text. Read through the real English catalog (jsdom-setup installs
// it), so a missing key would show as a raw one.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

resetDom(); // the real English catalog

const {
  formatEntry,
  isShown,
  streamFile,
  streamKind,
  streamPrefix,
  streamRaw,
  streamText,
  streamTime,
} = await import("../model/connection-stream.js");
const { FRAME, PROTOCOL_VERSION } = await import("../model/serial-wire.js");

const say = (entry) => streamText(entry);

test("four kinds, each with its prefix — and nothing for a kind it does not know", () => {
  const cases = [
    [{ kind: "text", text: "hi" }, "log", ""],
    [{ kind: "data", dir: "out" }, "data", "→"],
    [{ kind: "data", dir: "in" }, "data", "←"],
    [{ kind: "proto", event: "close" }, "protocol", "·"],
    [{ kind: "error", event: "restart" }, "error", "!"],
    [{ kind: "someday" }, null, ""],
  ];
  for (const [entry, kind, prefix] of cases) {
    assert.equal(streamKind(entry), kind);
    assert.equal(streamPrefix(entry), prefix);
  }
});

test("time counts from the run's start, to the millisecond; blank with no run", () => {
  assert.equal(streamTime({ t: 12_345 }, 0), "+  12.345");
  assert.equal(streamTime({ t: 5 }, 10), "+   0.000", "never negative");
  assert.equal(streamTime({ t: 5 }, null), "");
});

test("a data value reads in the design's words, or raw without them", () => {
  const element = {
    name: "Bus",
    fields: [
      { type: "byte", name: "addr" },
      { type: "bit", name: "rw" },
    ],
  };
  assert.equal(
    say({
      kind: "data",
      dir: "out",
      index: 0,
      width: 9,
      value: 0x13f,
      element,
    }),
    "OUTPUT   Bus  addr=0x3F rw=1",
  );
  assert.equal(
    say({ kind: "data", dir: "in", index: 2, width: 4, value: 0xa }),
    "INBOUND  #2  0xA (4)",
  );
  assert.equal(streamRaw({ raw: [0x7e, 0x5, 0xab] }), "7E 05 AB");
  assert.equal(streamRaw({}), null);
});

test("protocol lines: the protocol's notation, the catalog's words", () => {
  assert.equal(say({ kind: "proto", event: "open", port: "/dev/x" }), "Port /dev/x opened"); // prettier-ignore
  assert.equal(say({ kind: "proto", event: "open", port: null }), "Connection opened"); // prettier-ignore
  assert.equal(say({ kind: "proto", event: "close" }), "Port closed");
  assert.equal(
    say({ kind: "proto", event: "hello", version: 1, signature: 0xf8acb506, session: 17 }), // prettier-ignore
    "→ HELLO v1 sig F8ACB506 session 17",
  );
  assert.equal(
    say({ kind: "proto", event: "hello-ack", version: 1, signature: 0xa, session: 17 }), // prettier-ignore
    "← HELLO_ACK v1 sig 0000000A session 17",
  );
  assert.equal(
    say({ kind: "proto", event: "handshake", version: 1, signature: 0xf8acb506 }), // prettier-ignore
    "Handshake OK: protocol v1, signature F8ACB506",
  );
  assert.equal(say({ kind: "proto", event: "ack-in", seq: 3 }), "← ACK seq 3");
  assert.equal(say({ kind: "proto", event: "ack-out", seq: 4 }), "→ ACK seq 4");
  assert.equal(say({ kind: "proto", event: "stale-ack", seq: 9 }), "← ACK seq 9 — stale, ignored"); // prettier-ignore
  assert.match(say({ kind: "proto", event: "announce" }), /^← HELLO_ACK session 0 — /); // prettier-ignore
});

test("error lines say what went wrong, and why a frame is being resent", () => {
  assert.equal(
    say({ kind: "error", event: "resend", cause: "nak", seq: 12, attempt: 2, max: 3 }), // prettier-ignore
    "← NAK — resending seq 12 (attempt 2/3)",
  );
  assert.equal(
    say({ kind: "error", event: "resend", cause: "timeout", seq: 12, attempt: 3, max: 3 }), // prettier-ignore
    "No ACK for seq 12 — resending (attempt 3/3)",
  );
  assert.equal(
    say({ kind: "error", event: "failed", seq: 12, attempts: 3 }),
    "Delivery of seq 12 failed after 3 attempts",
  );
  assert.equal(
    say({ kind: "error", event: "damaged", type: FRAME.INBOUND, error: "crc", nak: true }), // prettier-ignore
    "Damaged INBOUND (bad CRC) — NAK sent",
  );
  assert.equal(
    say({ kind: "error", event: "damaged", type: null, error: "escape", nak: false }), // prettier-ignore
    "Damaged frame (bad escape) — dropped",
  );
  assert.match(say({ kind: "error", event: "duplicate", seq: 5 }), /^← INBOUND seq 5 — /); // prettier-ignore
  assert.equal(say({ kind: "error", event: "no-response", ms: 5000 }), "No answer to HELLO in 5 s"); // prettier-ignore
  assert.equal(
    say({ kind: "error", event: "version", version: 2 }),
    `The device speaks protocol v2; Chip Hippo speaks v${PROTOCOL_VERSION}`,
  );
  assert.equal(
    say({ kind: "error", event: "signature", signature: 1, expected: 2 }),
    "The device was built for layout 00000001, not 00000002",
  );
  assert.equal(
    say({ kind: "error", event: "restart" }),
    "The device left the session (it restarted, or stopped hearing Chip Hippo)",
  );
  assert.equal(say({ kind: "error", event: "dropped", detail: "" }), "Connection dropped"); // prettier-ignore
  assert.equal(say({ kind: "error", event: "dropped", detail: "ENXIO" }), "Connection dropped: ENXIO"); // prettier-ignore
});

test("filters hide log, data and protocol lines — never errors", () => {
  const off = { log: false, data: false, protocol: false };
  for (const kind of ["log", "data", "protocol"]) {
    assert.equal(isShown(kind, off), false);
    assert.equal(isShown(kind, { [kind]: true }), true);
  }
  assert.equal(isShown("error", off), true);
});

test("formatEntry puts it all together", () => {
  assert.deepEqual(
    formatEntry({ kind: "data", dir: "in", index: 0, width: 1, value: 1, raw: [0x7e], t: 1500 }, 1000), // prettier-ignore
    {
      kind: "data",
      dir: "in",
      time: "+   0.500",
      prefix: "←",
      text: "INBOUND  #0  0x1 (1)",
      raw: "7E",
    },
  );
});

test("the Save… text: every entry with its time, then the partial line", () => {
  const text = streamFile(
    [
      { kind: "proto", event: "close", t: 2000 },
      { kind: "text", text: "hello", t: 2500 },
      { kind: "someday", t: 3000 },
    ],
    { t0: 1000, partial: "" },
  );
  assert.equal(text, "+   1.000  ·  Port closed\n+   1.500     hello\n");
  assert.equal(streamFile([], {}), "");
  assert.equal(
    streamFile([{ kind: "text", text: "a", t: 1 }], { t0: null }),
    "   a\n",
    "no run: no time column",
  );
});

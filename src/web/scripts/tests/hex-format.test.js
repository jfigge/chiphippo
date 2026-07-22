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

// Tests for hex-format.js — Intel HEX ⇄ bytes (Feature 190). Round-trips raw
// images, validates record checksums (parse rejects a corrupted line), handles
// EOF + extended-linear-address records past 64 KiB, and matches a hand-written
// canonical record byte-for-byte.

import test from "node:test";
import assert from "node:assert/strict";

import { parseIntelHex, emitIntelHex } from "../model/hex-format.js";

test("emit produces the canonical record for a known payload", () => {
  // ":10 0000 00 <16 bytes> CC" — the classic first line of a HEX dump.
  const bytes = Uint8Array.from({ length: 16 }, (_, i) => i);
  const hex = emitIntelHex(bytes);
  const first = hex.split("\n")[0];
  assert.equal(first, ":10000000000102030405060708090A0B0C0D0E0F78");
  assert.ok(hex.trimEnd().endsWith(":00000001FF"), "ends with the EOF record");
});

test("parse + emit round-trips an arbitrary image exactly", () => {
  const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 7 + 3) & 0xff);
  const round = parseIntelHex(emitIntelHex(bytes));
  assert.deepEqual([...round], [...bytes]);
});

test("parse fills sparse gaps with zeros and sizes to the top address", () => {
  const hex = [
    ":0100000041BE", // addr 0 = 0x41
    ":01000A00FFF6", // addr 0x0A = 0xFF
    ":00000001FF",
  ].join("\n");
  const bytes = parseIntelHex(hex);
  assert.equal(bytes.length, 0x0b);
  assert.equal(bytes[0], 0x41);
  assert.equal(bytes[0x0a], 0xff);
  assert.equal(bytes[5], 0, "the gap is zero-filled");
});

test("parse rejects a record with a bad checksum", () => {
  const hex = ":10000000000102030405060708090A0B0C0D0E0F00\n:00000001FF";
  assert.throws(
    () => parseIntelHex(hex),
    (e) => e.code === "HEX_PARSE",
  );
});

test("parse rejects a line that does not start with ':'", () => {
  assert.throws(
    () => parseIntelHex("100000000001...\n:00000001FF"),
    (e) => e.code === "HEX_PARSE",
  );
});

test("extended linear address records carry past 64 KiB", () => {
  const bytes = new Uint8Array(0x10002); // 65538 bytes
  bytes[0] = 0xaa;
  bytes[0x10000] = 0xbb; // the byte that needs a type-04 base
  bytes[0x10001] = 0xcc;
  const hex = emitIntelHex(bytes);
  assert.ok(
    !hex.includes(":020000040000FA"),
    "no type-04 record for the 0-base span",
  );
  assert.ok(
    hex.includes(":020000040001F9"),
    "a type-04 record sets the upper 16 bits",
  );
  const round = parseIntelHex(hex);
  assert.equal(round[0], 0xaa);
  assert.equal(round[0x10000], 0xbb);
  assert.equal(round[0x10001], 0xcc);
});

test("emit of an empty image is just the EOF record", () => {
  assert.equal(emitIntelHex(new Uint8Array(0)).trim(), ":00000001FF");
});

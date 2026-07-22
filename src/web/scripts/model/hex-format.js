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

// hex-format.js — pure Intel HEX ⇄ byte-array parse/emit for the memory
// inspector's Import / Export (Feature 190). Intel HEX is the format assembler
// toolchains emit, so supporting it makes loading a ROM program trivial. Raw
// `.bin` needs no module — the bytes ARE the image — so this file is only the
// HEX side; the inspector decides bin-vs-hex by file extension.
//
// A record is `:LL AAAA TT <data…> CC` in ASCII hex: byte count, 16-bit
// address, record type, data, and a two's-complement checksum over every byte.
// Types handled: 00 data, 01 EOF, 02 extended segment address (×16), 04
// extended linear address (upper 16 bits, for images past 64 KiB); 03/05 start
// addresses are accepted and ignored.

/** Throw a tagged parse error (the inspector surfaces `.message` inline). */
function hexError(message) {
  const err = new Error(message);
  err.code = "HEX_PARSE";
  return err;
}

/** Parse a run of hex-pair bytes; validates even length + hex digits. */
function hexPairs(s, lineNo) {
  if (s.length % 2 !== 0) throw hexError(`line ${lineNo}: odd hex-digit count`);
  const out = [];
  for (let i = 0; i < s.length; i += 2) {
    const b = Number.parseInt(s.slice(i, i + 2), 16);
    if (Number.isNaN(b)) throw hexError(`line ${lineNo}: non-hex digits`);
    out.push(b);
  }
  return out;
}

/**
 * Parse Intel HEX text into a dense Uint8Array (sparse gaps zero-filled, sized
 * to the highest written address + 1). Throws a `HEX_PARSE` error on a
 * malformed record, a bad checksum, or an unknown record type.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function parseIntelHex(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  let base = 0; // running base from an extended-address record
  let maxAddr = -1;
  const writes = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i].trim();
    if (line === "") continue;
    if (line[0] !== ":")
      throw hexError(`line ${lineNo}: record must start with ':'`);
    const bytes = hexPairs(line.slice(1), lineNo);
    if (bytes.length < 5) throw hexError(`line ${lineNo}: record too short`);
    const len = bytes[0];
    const addr = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    if (bytes.length !== 5 + len) {
      throw hexError(
        `line ${lineNo}: byte count ${len} disagrees with the record`,
      );
    }
    if ((bytes.reduce((a, b) => a + b, 0) & 0xff) !== 0) {
      throw hexError(`line ${lineNo}: bad checksum`);
    }
    const data = bytes.slice(4, 4 + len);
    if (type === 0x00) {
      for (let k = 0; k < len; k++) {
        const a = base + addr + k;
        writes.push([a, data[k]]);
        if (a > maxAddr) maxAddr = a;
      }
    } else if (type === 0x01) {
      break; // end of file
    } else if (type === 0x02) {
      base = ((data[0] << 8) | data[1]) << 4; // segment × 16
    } else if (type === 0x04) {
      base = ((data[0] << 8) | data[1]) * 0x10000; // upper 16 bits
    } else if (type === 0x03 || type === 0x05) {
      /* start-address records carry no image data — ignore */
    } else {
      throw hexError(
        `line ${lineNo}: unsupported record type 0x${type.toString(16)}`,
      );
    }
  }
  const out = new Uint8Array(maxAddr + 1);
  for (const [a, v] of writes) out[a] = v;
  return out;
}

/** Assemble one Intel HEX record line (with its checksum). */
function record(type, addr, data) {
  const head = [data.length, (addr >> 8) & 0xff, addr & 0xff, type, ...data];
  const sum = (0x100 - (head.reduce((a, b) => a + b, 0) & 0xff)) & 0xff;
  return (
    ":" +
    [...head, sum]
      .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
      .join("")
  );
}

/**
 * Emit a byte array as Intel HEX text: `bytesPerRecord` data bytes per line
 * (16 is canonical), an extended-linear-address (type 04) record whenever the
 * address crosses a 64 KiB boundary, and a terminating EOF record.
 * @param {number[]|Uint8Array} bytes
 * @param {{bytesPerRecord?: number}} [opts]
 * @returns {string}
 */
export function emitIntelHex(bytes, { bytesPerRecord = 16 } = {}) {
  const data = bytes ?? [];
  const step = Math.max(1, Math.min(255, bytesPerRecord | 0));
  const lines = [];
  let upper = 0; // current upper-16-bits base (0 needs no record)
  for (let addr = 0; addr < data.length; addr += step) {
    const hi = Math.floor(addr / 0x10000);
    if (hi !== upper) {
      upper = hi;
      lines.push(record(0x04, 0, [(hi >> 8) & 0xff, hi & 0xff]));
    }
    const chunk = [];
    for (let k = 0; k < step && addr + k < data.length; k++) {
      chunk.push(data[addr + k] & 0xff);
    }
    lines.push(record(0x00, addr & 0xffff, chunk));
  }
  lines.push(":00000001FF"); // EOF
  return lines.join("\n") + "\n";
}

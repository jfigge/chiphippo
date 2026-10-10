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

/** The largest image parseIntelHex will allocate (matches mem-store's cap). */
const MAX_HEX_BYTES = 1 << 24; // 16 MiB — far above any modelled memory

/** Parse a run of hex-pair bytes; validates even length + hex digits. */
function hexPairs(s, lineNo) {
  if (s.length % 2 !== 0) throw hexError(`line ${lineNo}: odd hex-digit count`);
  // Validate the WHOLE run up front: `parseInt("4G", 16)` returns 4 (it stops
  // at the first non-hex char), so a bad LOW nibble would otherwise slip
  // through as a wrong byte and surface later as a misleading checksum error.
  if (!/^[0-9a-fA-F]*$/.test(s))
    throw hexError(`line ${lineNo}: non-hex digits`);
  const out = [];
  for (let i = 0; i < s.length; i += 2) {
    out.push(Number.parseInt(s.slice(i, i + 2), 16));
  }
  return out;
}

/**
 * Parse Intel HEX text into a dense Uint8Array. The image is rebased to its
 * LOWEST written address (like `objcopy -O binary`): a firmware `.hex` based at
 * a nonzero flash origin (e.g. an extended-address record putting data at
 * 0x08000000) flattens to offset 0 instead of allocating a gigabyte-long zero
 * prefix — the caller pads/truncates to the target ROM size. Sparse interior
 * gaps are zero-filled. Throws a `HEX_PARSE` error on a malformed record, a bad
 * checksum, an unknown record type, or an image spanning more than 16 MiB.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function parseIntelHex(text) {
  const { writes, minAddr, maxAddr } = parseIntelHexWrites(text);
  if (maxAddr < 0) return new Uint8Array(0); // no data records
  const size = maxAddr - minAddr + 1;
  if (size > MAX_HEX_BYTES) {
    throw hexError(
      `image spans ${size} bytes (max ${MAX_HEX_BYTES}) — check the address records`,
    );
  }
  const out = new Uint8Array(size);
  for (const [a, v] of writes) out[a - minAddr] = v;
  return out;
}

/**
 * Lay a HEX file's bytes into a ROM of `byteLength` AT THEIR OWN ADDRESSES,
 * modulo the ROM's size — the EPROM programmer's convention, and the only one
 * that works for a ROM mapped high: a 6502 program `.org $E000` with its
 * vectors at $FFFA, into a 32 KiB ROM decoded at $8000, belongs at offset
 * $6000 with the vectors at $7FFA (rebased to its lowest address, the reset
 * vector landed at $1FFA and the CPU booted into garbage). Bytes the file
 * does not mention keep what `current` holds. Null when the data spans more
 * than the ROM holds — then there is no one place for it, and the caller
 * falls back to `parseIntelHex`'s rebase.
 * @param {{writes: Array<[number, number]>, minAddr: number, maxAddr: number}} parsed
 * @param {number} byteLength
 * @param {Uint8Array|number[]} [current]
 * @returns {Uint8Array|null}
 */
export function placeHexWrites(parsed, byteLength, current = []) {
  if (parsed.maxAddr < 0 || parsed.maxAddr - parsed.minAddr >= byteLength) {
    return null;
  }
  const out = new Uint8Array(byteLength);
  out.set(Array.from(current ?? []).slice(0, byteLength));
  for (const [a, v] of parsed.writes) out[a % byteLength] = v;
  return out;
}

/**
 * Parse Intel HEX text into its data writes, each at its ABSOLUTE address
 * (extended-address records applied), with the lowest and highest address
 * written (`maxAddr` -1 when there are none). Throws `HEX_PARSE` as
 * `parseIntelHex` does.
 * @param {string} text
 * @returns {{writes: Array<[number, number]>, minAddr: number, maxAddr: number}}
 */
export function parseIntelHexWrites(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  let base = 0; // running base from an extended-address record
  let minAddr = Infinity;
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
        if (a < minAddr) minAddr = a;
        if (a > maxAddr) maxAddr = a;
      }
    } else if (type === 0x01) {
      break; // end of file
    } else if (type === 0x02) {
      if (len !== 2)
        throw hexError(`line ${lineNo}: extended-segment record needs 2 bytes`);
      base = ((data[0] << 8) | data[1]) << 4; // segment × 16
    } else if (type === 0x04) {
      if (len !== 2)
        throw hexError(`line ${lineNo}: extended-linear record needs 2 bytes`);
      base = ((data[0] << 8) | data[1]) * 0x10000; // upper 16 bits
    } else if (type === 0x03 || type === 0x05) {
      /* start-address records carry no image data — ignore */
    } else {
      throw hexError(
        `line ${lineNo}: unsupported record type 0x${type.toString(16)}`,
      );
    }
  }
  return { writes, minAddr, maxAddr };
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

/**
 * A typed hex field's value — digits only, an optional `0x` or `$` before
 * them — or null for anything else, blank included. `parseInt(…, 16)` reads
 * the leading digits of anything ("8OOO" with letter O is 8), which a memory
 * tool must never act on.
 * @param {string} text
 * @returns {number|null}
 */
export function parseHexStrict(text) {
  const m = /^(?:0x|\$)?([0-9a-f]+)$/i.exec(String(text ?? "").trim());
  return m ? Number.parseInt(m[1], 16) : null;
}

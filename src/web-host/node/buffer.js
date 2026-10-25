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

// buffer.js — the slice of Node's `Buffer` that main's code uses, for the web
// build. A Buffer IS a Uint8Array here, as it is in Node, so anything that only
// reads bytes (structured clone across the bridge, `fs.writeFileSync`, the
// serial link's frame parser) cannot tell the difference.
//
// What main calls (grep `Buffer\.` under src/app): `from` (bytes, an
// ArrayBuffer, or a string in utf8 / base64 / hex / latin1), `alloc`,
// `byteLength`, `isBuffer`, `concat`, and on an instance `toString(encoding)`,
// `copy`, `equals`, and Node's `slice` — which is a VIEW in Node, not the copy a
// Uint8Array's is, so it is overridden.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function normalizeEncoding(enc) {
  const e = String(enc ?? "utf8").toLowerCase();
  if (e === "utf-8") return "utf8";
  if (e === "binary") return "latin1";
  if (e === "ucs2" || e === "ucs-2" || e === "utf-16le") return "utf16le";
  return e;
}

function base64ToBytes(str) {
  const clean = String(str)
    .replace(/[^A-Za-z0-9+/\-_]/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = clean + "===".slice((clean.length + 3) % 4);
  const bin = atob(padded.length % 4 === 0 ? padded : clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function stringToBytes(str, enc) {
  switch (normalizeEncoding(enc)) {
    case "base64":
    case "base64url":
      return base64ToBytes(str);
    case "hex": {
      const s = String(str);
      const out = new Uint8Array(Math.floor(s.length / 2));
      for (let i = 0; i < out.length; i++) {
        const v = parseInt(s.substr(i * 2, 2), 16);
        if (Number.isNaN(v)) return out.subarray(0, i);
        out[i] = v;
      }
      return out;
    }
    case "latin1":
    case "ascii": {
      const s = String(str);
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
      return out;
    }
    case "utf16le": {
      const s = String(str);
      const out = new Uint8Array(s.length * 2);
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        out[i * 2] = c & 0xff;
        out[i * 2 + 1] = c >> 8;
      }
      return out;
    }
    default:
      return encoder.encode(String(str));
  }
}

export class Buffer extends Uint8Array {
  static from(value, encodingOrOffset, length) {
    if (typeof value === "string") {
      const bytes = stringToBytes(value, encodingOrOffset);
      const out = new Buffer(bytes.length);
      out.set(bytes);
      return out;
    }
    // Node shares an ArrayBuffer's memory rather than copying it.
    if (value instanceof ArrayBuffer) {
      const offset = encodingOrOffset ?? 0;
      return new Buffer(value, offset, length ?? value.byteLength - offset);
    }
    if (ArrayBuffer.isView(value)) {
      const src = new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      );
      const out = new Buffer(src.length);
      out.set(src);
      return out;
    }
    if (value && typeof value === "object" && value.type === "Buffer") {
      return Buffer.from(value.data ?? []);
    }
    if (value && typeof value.length === "number") {
      const out = new Buffer(value.length);
      for (let i = 0; i < value.length; i++) out[i] = Number(value[i]) & 0xff;
      return out;
    }
    throw new TypeError(
      "The first argument must be a string, Buffer, ArrayBuffer or array",
    );
  }

  static alloc(size, fill = 0) {
    const out = new Buffer(size);
    if (fill) out.fill(typeof fill === "string" ? fill.charCodeAt(0) : fill);
    return out;
  }

  static allocUnsafe(size) {
    return new Buffer(size);
  }

  static byteLength(value, enc) {
    if (typeof value === "string") return stringToBytes(value, enc).length;
    return value?.byteLength ?? 0;
  }

  static isBuffer(value) {
    return value instanceof Buffer;
  }

  static concat(list, total) {
    const length = total ?? list.reduce((n, b) => n + b.length, 0);
    const out = new Buffer(length);
    let at = 0;
    for (const b of list) {
      if (at >= length) break;
      const part = b.length > length - at ? b.subarray(0, length - at) : b;
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  // Node's slice is a view onto the same memory.
  slice(start, end) {
    return this.subarray(start, end);
  }

  toString(enc, start = 0, end = this.length) {
    const view = this.subarray(start, end);
    switch (normalizeEncoding(enc)) {
      case "base64":
        return bytesToBase64(view);
      case "base64url":
        return bytesToBase64(view)
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
      case "hex":
        return Array.from(view, (b) => b.toString(16).padStart(2, "0")).join(
          "",
        );
      case "latin1":
      case "ascii": {
        let s = "";
        for (const b of view) s += String.fromCharCode(b);
        return s;
      }
      case "utf16le": {
        let s = "";
        for (let i = 0; i + 1 < view.length; i += 2) {
          s += String.fromCharCode(view[i] | (view[i + 1] << 8));
        }
        return s;
      }
      default:
        return decoder.decode(view);
    }
  }

  toJSON() {
    return { type: "Buffer", data: Array.from(this) };
  }

  equals(other) {
    if (!other || other.length !== this.length) return false;
    for (let i = 0; i < this.length; i++)
      if (this[i] !== other[i]) return false;
    return true;
  }

  copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
    const part = this.subarray(sourceStart, sourceEnd);
    const room = Math.max(0, target.length - targetStart);
    const n = Math.min(part.length, room);
    target.set(part.subarray(0, n), targetStart);
    return n;
  }

  readUInt8(offset = 0) {
    return this[offset];
  }

  readUInt16LE(offset = 0) {
    return this[offset] | (this[offset + 1] << 8);
  }

  readUInt16BE(offset = 0) {
    return (this[offset] << 8) | this[offset + 1];
  }

  readUInt32LE(offset = 0) {
    return (
      (this[offset] | (this[offset + 1] << 8) | (this[offset + 2] << 16)) +
      this[offset + 3] * 0x1000000
    );
  }

  writeUInt8(value, offset = 0) {
    this[offset] = value;
    return offset + 1;
  }

  writeUInt16LE(value, offset = 0) {
    this[offset] = value & 0xff;
    this[offset + 1] = (value >> 8) & 0xff;
    return offset + 2;
  }
}

export default { Buffer };

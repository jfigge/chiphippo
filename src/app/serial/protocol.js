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

/**
 * protocol.js — the bytes of the Arduino serial protocol v1
 * (src/web/docs/serial-protocol.md, which is normative). Pure: bytes in,
 * frames out, no port and no timer — `link.js` owns those.
 *
 *     0x7E  TYPE  SEQ  LEN  PAYLOAD…  CRC_LO  CRC_HI
 *
 * HDLC-style framing. 0x7E opens a frame; every byte after it — the CRC
 * included — is escaped, a 0x7E or 0x7D going out as 0x7D then the byte XOR
 * 0x20, so an unescaped 0x7E can only ever be the start of a frame. That is
 * what lets a receiver that joined mid-stream (a Nano's bootloader chatter, a
 * torn frame) resync on the next one without a second marker.
 *
 *   · TYPE  what the frame is (FRAME in serial-wire.js).
 *   · SEQ   a data frame's sequence number; for an ACK, the one acknowledged;
 *           0 in every other frame (a session travels in HELLO's payload).
 *   · LEN   payload bytes BEFORE escaping, 0–255.
 *   · CRC   CRC-16/CCITT-FALSE over TYPE SEQ LEN PAYLOAD, unescaped, LE.
 *
 * Every number here — the markers, the types, the payload sizes — comes from
 * web/scripts/model/serial-wire.js, the one place the protocol's constants
 * live; the generated header is written from the same module.
 */
"use strict";

const wire = require("../../web/scripts/model/serial-wire.js");

const {
  START,
  ESC,
  ESC_XOR,
  HEADER_BYTES,
  CRC_BYTES,
  MAX_PAYLOAD,
  DATA_PAYLOAD,
  HELLO_PAYLOAD,
  HELLO_PREFIX,
  MAX_WIDTH,
  NOT_NAKED,
  crc16,
} = wire;

/** Append one byte, escaped when it would read as START or ESC. */
function pushEscaped(out, byte) {
  if (byte === START || byte === ESC) out.push(ESC, byte ^ ESC_XOR);
  else out.push(byte);
}

/**
 * One frame, ready to write — START, then everything else escaped.
 * @param {{type: number, seq?: number, payload?: ArrayLike<number>}} frame
 * @returns {Buffer}
 */
function encodeFrame({ type, seq = 0, payload = [] }) {
  if (payload.length > MAX_PAYLOAD) {
    throw new RangeError(
      `payload of ${payload.length} bytes exceeds ${MAX_PAYLOAD}`,
    );
  }
  const body = [type & 0xff, seq & 0xff, payload.length];
  for (let i = 0; i < payload.length; i++) body.push(payload[i] & 0xff);
  const crc = crc16(body);
  body.push(crc & 0xff, crc >> 8);
  const out = [START];
  for (const byte of body) pushEscaped(out, byte);
  return Buffer.from(out);
}

/**
 * A streaming decoder: feed it whatever the port delivered, get back every
 * frame that finished in it. A frame split across chunks is carried over;
 * bytes outside a frame are dropped (they are someone else's — a bootloader's,
 * or a stray `Serial.print`), and a START mid-frame drops the partial frame
 * and starts again.
 *
 * A damaged frame is REPORTED rather than swallowed, because the receiver may
 * owe a NAK for it (§3.5) — carrying TYPE and SEQ as they arrived, which the
 * caller may trust only as far as a damaged frame deserves, and `null` for
 * any it never got to. A frame cut short by a START is not damaged: it is
 * dropped without a report, and the sender's timeout covers it.
 *
 * Its memory is bounded by construction: the frame in hand is never more
 * than TYPE SEQ LEN + `maxPayload` + CRC bytes, since a LEN past the limit
 * is damage the moment it is read, and a frame is complete (or damaged) the
 * moment its last CRC byte arrives.
 */
class FrameDecoder {
  #max;
  #buf = [];
  #inFrame = false;
  #escaped = false;

  /** @param {{maxPayload?: number}} [opts] - the receiver's payload limit
      (§3.2): the longest payload it accepts, at most 255. A frame whose LEN
      is past it is damaged. */
  constructor({ maxPayload = MAX_PAYLOAD } = {}) {
    if (
      !Number.isInteger(maxPayload) ||
      maxPayload < 0 ||
      maxPayload > MAX_PAYLOAD
    ) {
      throw new RangeError(`bad payload limit ${maxPayload}`);
    }
    this.#max = maxPayload;
  }

  /**
   * @param {ArrayLike<number>} chunk
   * @returns {Array<{ok: true, type: number, seq: number, payload: Buffer} |
   *   {ok: false, error: "crc"|"escape"|"length", type: number|null,
   *   seq: number|null}>}
   */
  push(chunk) {
    const frames = [];
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i] & 0xff;
      if (byte === START) {
        // A START always begins a new frame — mid-frame, the one before it
        // was torn, and there is nothing to be done with half a frame.
        this.#buf = [];
        this.#inFrame = true;
        this.#escaped = false;
        continue;
      }
      if (!this.#inFrame) continue;
      if (this.#escaped) {
        this.#escaped = false;
        const value = byte ^ ESC_XOR;
        if (value !== START && value !== ESC) {
          frames.push(this.#fail("escape"));
          continue;
        }
        this.#buf.push(value);
      } else if (byte === ESC) {
        this.#escaped = true;
        continue;
      } else {
        this.#buf.push(byte);
      }
      const frame = this.#complete();
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /** Abandon the frame in hand and report what is known of it. */
  #fail(error) {
    const [type = null, seq = null] = this.#buf;
    this.#inFrame = false;
    this.#buf = [];
    return { ok: false, error, type, seq };
  }

  /** The frame now finished in the buffer, if one is — and back to hunting. */
  #complete() {
    const buf = this.#buf;
    if (buf.length < HEADER_BYTES) return null;
    const len = buf[2];
    if (len > this.#max) return this.#fail("length");
    const total = HEADER_BYTES + len + CRC_BYTES;
    if (buf.length < total) return null;
    const [type, seq] = buf;
    const got = buf[total - 2] | (buf[total - 1] << 8);
    if (crc16(buf.slice(0, HEADER_BYTES + len)) !== got) {
      return this.#fail("crc");
    }
    this.#inFrame = false;
    this.#buf = [];
    return {
      ok: true,
      type,
      seq,
      payload: Buffer.from(buf.slice(HEADER_BYTES, HEADER_BYTES + len)),
    };
  }
}

/**
 * An OUTPUT / INBOUND payload (§4.2): `[index][width][lo][hi]`, the value
 * right-aligned — bit 0 is the element's pin 1 — and masked to its width, so
 * a caller can never smuggle a bit past the pins that exist.
 * @returns {number[]}
 */
function encodeData(index, width, value) {
  if (!Number.isInteger(width) || width < 1 || width > MAX_WIDTH) {
    throw new RangeError(`bad width ${width}`);
  }
  const v = (value >>> 0) & ((1 << width) - 1);
  return [index & 0xff, width, v & 0xff, (v >> 8) & 0xff];
}

/**
 * A data payload back, or null when it is not one — the wrong length, or a
 * width out of range. Bits at or above the width are masked off (§4.2).
 * @param {ArrayLike<number>} payload
 * @returns {{index: number, width: number, value: number}|null}
 */
function decodeData(payload) {
  if (!payload || payload.length !== DATA_PAYLOAD) return null;
  const width = payload[1];
  if (width < 1 || width > MAX_WIDTH) return null;
  const value = (payload[2] | (payload[3] << 8)) & ((1 << width) - 1);
  return { index: payload[0], width, value };
}

/**
 * A HELLO / HELLO_ACK payload (§4.1):
 * `[version][session lo][session hi][signature ×4, LE]`.
 * @param {{version: number, session: number, signature: number}} hello
 */
function encodeHello({ version, session, signature }) {
  const s = signature >>> 0;
  return [
    version & 0xff,
    session & 0xff,
    (session >>> 8) & 0xff,
    s & 0xff,
    (s >>> 8) & 0xff,
    (s >>> 16) & 0xff,
    (s >>> 24) & 0xff,
  ];
}

/**
 * A HELLO / HELLO_ACK payload back. Its first three bytes — version, session
 * — are read whatever the length, so a device of another version is named as
 * that; the signature only from a payload that is exactly v1's seven bytes
 * (`null` otherwise). Null for anything shorter than those three: ignored.
 * @param {ArrayLike<number>} payload
 * @returns {{version: number, session: number, signature: number|null}|null}
 */
function decodeHello(payload) {
  if (!payload || payload.length < HELLO_PREFIX) return null;
  const signature =
    payload.length === HELLO_PAYLOAD
      ? (payload[3] |
          (payload[4] << 8) |
          (payload[5] << 16) |
          (payload[6] << 24)) >>>
        0
      : null;
  return {
    version: payload[0],
    session: payload[1] | (payload[2] << 8),
    signature,
  };
}

/**
 * Is a NAK owed for a damaged frame whose TYPE read as `type` (null: it never
 * arrived)? Yes unless it is one never resent in answer to one (§3.5) — the
 * caller adds the other condition, that its side is in a session.
 */
function owesNak(type) {
  return !NOT_NAKED.includes(type);
}

module.exports = {
  ...wire,
  encodeFrame,
  FrameDecoder,
  encodeData,
  decodeData,
  encodeHello,
  decodeHello,
  owesNak,
};

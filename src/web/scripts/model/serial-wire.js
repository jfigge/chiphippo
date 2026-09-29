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

// serial-wire.js — the Arduino serial protocol's NUMBERS, stated once
// (src/web/docs/serial-protocol.md is the normative text). Pure and
// dependency-free, because it is read from BOTH sides of the bridge:
//
//   · the generator (integration-codegen.js) imports it and WRITES the
//     generated header's constants from it;
//   · main's app/serial/protocol.js `require()`s it (require(esm) — Electron's
//     Node loads a dependency-free ES module synchronously, asar included).
//
// So the protocol version, the byte values, the timeouts and the retry count
// exist in exactly one place, and the C++ on the Arduino cannot drift from the
// host that talks to it. The protocol page's Constants table names these
// exports and a test holds the two to each other. Anything here is a WIRE
// fact: change one after release and PROTOCOL_VERSION goes up with it.

/** The protocol this build speaks. Exchanged in HELLO / HELLO_ACK. */
export const PROTOCOL_VERSION = 1;

/** Opens a frame. Never escaped, so it never appears anywhere else. */
export const START = 0x7e;
/** Escapes the next byte, which is sent XOR ESC_XOR. */
export const ESC = 0x7d;
export const ESC_XOR = 0x20;

/** Frame types (§4). None is 0x00, 0x7D, 0x7E or 0xFF. */
export const FRAME = Object.freeze({
  HELLO: 0x01, // host → device: version, session, layout signature
  HELLO_ACK: 0x02, // device → host: ITS version, the session, ITS signature
  ACK: 0x06, // either way: SEQ received (and, for an OUTPUT, handled)
  NAK: 0x15, // either way: a frame arrived damaged — resend yours now
  OUTPUT: 0x10, // host → device: an Output fired              (ACKed)
  INBOUND: 0x11, // device → host: an Input's whole new value  (ACKed)
  LOG: 0x20, // device → host: log text               (never ACKed)
});

/** The frames never resent in answer to a NAK, so a damaged one is never
    NAKed (§3.5): a NAK for an ACK or a NAK would echo forever, LOG is never
    resent at all, and the handshake resends on its own clock. */
export const NOT_NAKED = Object.freeze([
  FRAME.HELLO,
  FRAME.HELLO_ACK,
  FRAME.ACK,
  FRAME.NAK,
  FRAME.LOG,
]);

/** Bytes before the payload, after START: TYPE SEQ LEN. */
export const HEADER_BYTES = 3;
/** Bytes after it: the CRC-16, little-endian. */
export const CRC_BYTES = 2;
/** LEN is one byte. */
export const MAX_PAYLOAD = 255;
/** The longest frame, unescaped and without START: TYPE SEQ LEN, 255
    payload bytes, the CRC — 260. */
export const MAX_FRAME_BODY = HEADER_BYTES + MAX_PAYLOAD + CRC_BYTES;
/** The most bytes one frame can take on the wire: START, then every body
    byte escaped — 521. */
export const MAX_WIRE_FRAME = 1 + 2 * MAX_FRAME_BODY;

/** An OUTPUT / INBOUND payload: element index, width, value lo, value hi. */
export const DATA_PAYLOAD = 4;
/** A v1 HELLO / HELLO_ACK payload: version, session ×2, signature ×4 (all
    little-endian). */
export const HELLO_PAYLOAD = 7;
/** A v1 HELLO / HELLO_ACK's first bytes — version, session: all a device
    needs to answer a HELLO, and all the host needs to judge a HELLO_ACK's
    version. Shorter is ignored. */
export const HELLO_PREFIX = 3;
/** The longest payload the host ever sends: all a device need buffer. */
export const MAX_HOST_PAYLOAD = Math.max(DATA_PAYLOAD, HELLO_PAYLOAD);

/** Sessions are 16 bits. 0 is never a run's: a HELLO_ACK for session 0 is a
    device announcing that it has just started. */
export const ANNOUNCE_SESSION = 0;
export const MAX_SESSION = 0xffff;
/** Data SEQs run 1…255 and wrap to 1; 0 is every other frame's. */
export const MAX_SEQ = 255;

/** The widest element: a value is a uint16_t on the wire. */
export const MAX_WIDTH = 16;
/** How many bits (pins) each kind of field is. */
export const FIELD_PINS = Object.freeze({ bit: 1, byte: 8, word: 16 });

/** The host sends HELLO this often while it waits for HELLO_ACK… */
export const HELLO_INTERVAL_MS = 250;
/** …and gives up on the device after this long. */
export const HELLO_WINDOW_MS = 5000;
/** How long a sender waits for a data frame's ACK before resending. */
export const ACK_TIMEOUT_MS = 500;
/** How many times a data frame is sent in all before it is given up on. */
export const MAX_SENDS = 3;

/** The frame CRC's polynomial and initial value (CRC-16/CCITT-FALSE). */
export const CRC16_POLY = 0x1021;
export const CRC16_INIT = 0xffff;

/**
 * CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final XOR.
 * Check value for ASCII "123456789" is 0x29B1. Bitwise, not tabled — the C++
 * transcription is the same loop, and a Nano has no flash to spare for a table.
 * @param {ArrayLike<number>} bytes
 * @returns {number}
 */
export function crc16(bytes) {
  let crc = CRC16_INIT;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= (bytes[i] & 0xff) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc =
        crc & 0x8000 ? ((crc << 1) ^ CRC16_POLY) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/**
 * CRC-32 (IEEE 802.3): reflected poly 0xEDB88320, init and final XOR
 * 0xFFFFFFFF. Check value for "123456789" is 0xCBF43926; "" is 0. Only the
 * HOST computes one (the layout signature is baked into the header as a
 * number), so it never has to fit on a Nano.
 * @param {ArrayLike<number>} bytes
 * @returns {number} unsigned
 */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] & 0xff;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

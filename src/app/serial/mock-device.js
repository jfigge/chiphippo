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

/**
 * mock-device.js — the built-in MOCK connection's device
 * (docs/chiphippo-mock-connection.md): the DEVICE side of the serial protocol
 * v1, in JavaScript, behind the same four-method port a real serial port is
 * adapted to (`write`, `onData`, `onClose`, `close` — see ports.js).
 *
 * THE SAME CODE PATH AS A REAL BOARD. The mock replaces the serial port at
 * the BYTE-STREAM level and nowhere above it: SerialLink cannot tell it from
 * a USB cable. Frames are built, escaped, CRC'd, parsed, acknowledged and
 * resent exactly as they are for an Arduino, so if the mock works, the host's
 * protocol stack works. Its rules are the generated header's, transcribed:
 *
 *   · opening the port is the board RESETTING — the session is forgotten and
 *     the start is announced (HELLO_ACK for session 0);
 *   · its layout signature is the design on screen's — the run hands it
 *     over as it opens the port — so it never needs regenerating; HELLO is
 *     answered with protocol v1 and that signature, a NEW session resets the
 *     SEQs and is joined only if the HELLO matches (v1, that signature), and
 *     a repeat of the one it last saw changes nothing;
 *   · an OUTPUT is acknowledged at once (there is no handler to wait for), a
 *     resend of the last one acknowledged is re-ACKed and not reported twice;
 *   · an Input value is sent stop-and-wait, resent on a NAK or a timeout, and
 *     after the last send the mock goes OFFLINE — leaves the session, and
 *     announces that it has, as it does at start-up — until a NEW session;
 *   · a data frame with SEQ 0 is no data frame at all, and is ignored;
 *   · log text goes as unacknowledged LOG frames, never split inside a UTF-8
 *     character.
 *
 * FAULTS are one-shot and outlive a run (they can be armed while stopped):
 *   drop-ack        the next OUTPUT's ACK is swallowed — a timeout and resend
 *   corrupt         the next ACK or INBOUND it sends is damaged — a NAK
 *   ignore-hello    the next run's HELLOs go unanswered — "No answer"
 *   wrong-signature the next session is answered for another layout, and so
 *                   never joined
 *
 * It reports what happened through ONE callback — `output` and `input`
 * values (for the window's data lines) and `state` whenever its open /
 * connected / armed-fault state changes — and knows nothing of windows,
 * settings or Electron.
 */
"use strict";

const {
  START,
  ESC,
  FRAME,
  PROTOCOL_VERSION,
  ACK_TIMEOUT_MS,
  MAX_SENDS,
  MAX_SEQ,
  MAX_HOST_PAYLOAD,
  ANNOUNCE_SESSION,
  encodeFrame,
  FrameDecoder,
  encodeData,
  decodeData,
  encodeHello,
  decodeHello,
  owesNak,
} = require("./protocol");

/** The one-shot faults, in the order the window offers them. */
const FAULTS = Object.freeze([
  "drop-ack",
  "corrupt",
  "ignore-hello",
  "wrong-signature",
]);

/** How much log text one LOG frame carries — what the generated header
    sends, so the mock's log path looks like a board's. */
const LOG_CHUNK = 60;

/**
 * A copy of an encoded frame with one bit of its LAST byte flipped — the CRC
 * (or its escape), so the damage is caught and the TYPE still reads. The bit
 * is chosen so the byte never becomes a START or an ESC, which would tear the
 * frame instead of damaging it.
 */
function damage(buf) {
  const out = Buffer.from(buf);
  const i = out.length - 1;
  for (const mask of [0x01, 0x02, 0x04, 0x08]) {
    const v = out[i] ^ mask;
    if (v !== START && v !== ESC) {
      out[i] = v;
      break;
    }
  }
  return out;
}

class MockDevice {
  #timers;
  #onEvent;
  #faults = new Set();
  #port = null; // the open run's port: { dataCb, closeCb, closed }
  #decoder = null;
  #ignoreHello = false; // this run's handshake goes unanswered
  #greeted = false; // in a session (ACTIVE)
  #session = ANNOUNCE_SESSION; // the last session a HELLO carried
  #layout = null; // this run's layout signature (null: take the HELLO's)
  #signature = 0; // what this session's HELLO_ACK says
  #txSeq = 0;
  #rxSeq = 0;
  #queue = []; // Input values waiting: { index, width, value, resolve }
  #current = null; // the one in flight: { frame, seq, tries, timer, resolve }

  /**
   * @param {object} [opts]
   * @param {{setTimeout: Function, clearTimeout: Function}} [opts.timers]
   * @param {(kind: "output"|"input"|"state", data: object) => void} [opts.onEvent]
   * @param {number} [opts.timeoutMs] - the ACK timeout; the protocol's own
   *   unless a test shortens it.
   */
  constructor({
    timers = globalThis,
    onEvent,
    timeoutMs = ACK_TIMEOUT_MS,
  } = {}) {
    this.#timers = timers;
    this.#onEvent = onEvent;
    this.timeoutMs = timeoutMs;
  }

  /** What the window shows: is a run's port open, has it been greeted, and
      which faults are armed. */
  get state() {
    return {
      open: this.#port != null,
      connected: this.#greeted,
      faults: FAULTS.filter((f) => this.#faults.has(f)),
    };
  }

  /**
   * Arm (or disarm) one fault. Returns false for a name that is not one.
   * @param {string} fault
   * @param {boolean} on
   */
  arm(fault, on) {
    if (!FAULTS.includes(fault)) return false;
    if (on) this.#faults.add(fault);
    else this.#faults.delete(fault);
    this.#changed();
    return true;
  }

  /**
   * A port for one run. Opening it is the board resetting: everything the
   * last run left is forgotten, and the start is announced.
   * @param {{signature?: number}} [opts] - the layout signature the mock is
   *   "built for": the design the run was started from. Without one it takes
   *   whatever the HELLO asks for.
   */
  openPort({ signature } = {}) {
    if (this.#port) this.#closePort(this.#port);
    const port = { dataCb: null, closeCb: null, closed: false };
    this.#port = port;
    this.#decoder = new FrameDecoder({ maxPayload: MAX_HOST_PAYLOAD });
    this.#greeted = false;
    this.#session = ANNOUNCE_SESSION;
    this.#layout = signature == null ? null : signature >>> 0;
    this.#txSeq = 0;
    this.#rxSeq = 0;
    this.#ignoreHello = this.#faults.delete("ignore-hello");
    this.#changed();
    // Announced the way a sketch's begin() does — after the link has had
    // the chance to listen, since bytes on a wire do not wait for anyone.
    this.#announce(port);
    return {
      write: (buf) => this.#receive(port, buf),
      onData: (cb) => (port.dataCb = cb),
      onClose: (cb) => (port.closeCb = cb),
      close: () => this.#closePort(port),
    };
  }

  /**
   * Send an Input's whole value. Resolves `{ok: true}` once the host has
   * acknowledged it, or `{ok: false, code}` — `offline` (no run has greeted
   * the mock), `delivery` (never acknowledged: the mock is offline now) or
   * `closed` (the run ended first).
   */
  sendInput(index, width, value) {
    if (!this.#port || !this.#greeted) {
      return Promise.resolve({ ok: false, code: "offline" });
    }
    return new Promise((resolve) => {
      this.#queue.push({ index, width, value, resolve });
      this.#pump();
    });
  }

  /** Log text, as LOG frames. False when no run has the port open. */
  log(text) {
    const port = this.#port;
    if (!port) return false;
    const bytes = Buffer.from(String(text ?? ""), "utf8");
    for (let at = 0; at < bytes.length;) {
      let end = Math.min(at + LOG_CHUNK, bytes.length);
      // Never inside a character: back up over its continuation bytes.
      while (end < bytes.length && end > at + 1 && (bytes[end] & 0xc0) === 0x80)
        end--;
      this.#deliver(
        port,
        encodeFrame({ type: FRAME.LOG, payload: bytes.subarray(at, end) }),
      );
      at = end;
    }
    return true;
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  #pump() {
    if (this.#current || this.#queue.length === 0) return;
    const next = this.#queue.shift();
    this.#txSeq = (this.#txSeq % MAX_SEQ) + 1;
    this.#current = {
      frame: encodeFrame({
        type: FRAME.INBOUND,
        seq: this.#txSeq,
        payload: encodeData(next.index, next.width, next.value),
      }),
      seq: this.#txSeq,
      tries: 0,
      timer: null,
      resolve: next.resolve,
    };
    this.#onEvent?.("input", {
      index: next.index,
      width: next.width,
      value: next.value & ((1 << next.width) - 1),
    });
    this.#transmit();
  }

  #transmit() {
    const cur = this.#current;
    if (!cur) return;
    if (cur.tries >= MAX_SENDS) {
      // Nobody is listening: leave the session, and say so, as the header
      // does — offline until a NEW session.
      this.#greeted = false;
      this.#finish({ ok: false, code: "delivery" });
      this.#failAll("delivery");
      this.#announce(this.#port);
      this.#changed();
      return;
    }
    cur.tries++;
    this.#timers.clearTimeout(cur.timer);
    cur.timer = this.#timers.setTimeout(() => this.#transmit(), this.timeoutMs);
    this.#deliver(this.#port, this.#fault(FRAME.INBOUND, cur.frame));
  }

  #finish(result) {
    const cur = this.#current;
    if (!cur) return;
    this.#timers.clearTimeout(cur.timer);
    this.#current = null;
    cur.resolve(result);
    if (result.ok) this.#pump();
  }

  #failAll(code) {
    this.#finish({ ok: false, code });
    for (const q of this.#queue.splice(0)) q.resolve({ ok: false, code });
  }

  /** HELLO_ACK for session 0: "I am in no session" — at start-up, and on
      leaving one. */
  #announce(port) {
    this.#deliver(
      port,
      encodeFrame({
        type: FRAME.HELLO_ACK,
        payload: encodeHello({
          version: PROTOCOL_VERSION,
          session: ANNOUNCE_SESSION,
          signature: this.#layout ?? 0,
        }),
      }),
    );
  }

  #send(frame) {
    this.#deliver(this.#port, this.#fault(frame.type, encodeFrame(frame)));
  }

  /** The `corrupt` fault, spent on the next ACK or INBOUND to go out. */
  #fault(type, buf) {
    if (type !== FRAME.ACK && type !== FRAME.INBOUND) return buf;
    if (!this.#faults.delete("corrupt")) return buf;
    this.#changed();
    return damage(buf);
  }

  /** Bytes on the wire towards the host — arriving later, as bytes do. */
  #deliver(port, buf) {
    if (!port || port.closed) return;
    setImmediate(() => {
      if (!port.closed) port.dataCb?.(buf);
    });
  }

  // ── Receiving ────────────────────────────────────────────────────────────

  #receive(port, buf) {
    if (port !== this.#port || port.closed) return;
    for (const frame of this.#decoder.push(buf)) {
      if (!frame.ok) {
        if (this.#greeted && owesNak(frame.type)) {
          this.#send({ type: FRAME.NAK });
        }
        continue;
      }
      this.#handle(frame);
    }
  }

  #handle(frame) {
    if (frame.type === FRAME.HELLO) {
      this.#onHello(frame);
      return;
    }
    if (!this.#greeted) return; // nothing counts before a HELLO
    switch (frame.type) {
      case FRAME.ACK:
        if (this.#current && frame.seq === this.#current.seq) {
          this.#finish({ ok: true });
        }
        return;
      case FRAME.NAK:
        if (this.#current) this.#transmit();
        return;
      case FRAME.OUTPUT:
        if (frame.seq !== 0) this.#onOutput(frame); // 0 is no data frame's
        return;
      default:
        return;
    }
  }

  #onHello(frame) {
    if (this.#ignoreHello) return;
    const hello = decodeHello(frame.payload);
    // Too short to name a session, or session 0 — never a run's, and its
    // answer would read as the mock announcing a restart.
    if (!hello || hello.session === ANNOUNCE_SESSION) return;
    if (hello.session !== this.#session) {
      // A new session: forget the last one's SEQs and anything it was
      // sending, and join it if the HELLO is what this mock answers — v1,
      // and its layout, unless a fault says otherwise.
      this.#failAll("closed");
      this.#session = hello.session;
      this.#signature = this.#layout ?? hello.signature ?? 0;
      if (this.#faults.delete("wrong-signature")) {
        this.#signature = (this.#signature ^ 0xffffffff) >>> 0;
      }
      this.#greeted =
        hello.version === PROTOCOL_VERSION &&
        hello.signature === this.#signature;
      this.#txSeq = 0;
      this.#rxSeq = 0;
      this.#changed();
    }
    this.#send({
      type: FRAME.HELLO_ACK,
      payload: encodeHello({
        version: PROTOCOL_VERSION,
        session: hello.session,
        signature: this.#signature,
      }),
    });
  }

  #onOutput(frame) {
    // An ACK makes its SEQ the last one acknowledged — the one a resend is
    // recognised by.
    const ack = () => {
      this.#rxSeq = frame.seq;
      this.#send({ type: FRAME.ACK, seq: frame.seq });
    };
    // Intact but unreadable: ACK and drop — a resend would be the same.
    const data = decodeData(frame.payload);
    if (!data) return ack();
    // A resend of the last one: its ACK was lost. ACK, report once.
    if (frame.seq === this.#rxSeq) return ack();
    this.#rxSeq = frame.seq;
    this.#onEvent?.("output", data);
    if (this.#faults.delete("drop-ack")) {
      this.#changed(); // swallowed: the host times out and resends
      return;
    }
    ack();
  }

  // ── The port ─────────────────────────────────────────────────────────────

  #closePort(port) {
    if (port.closed) return;
    port.closed = true;
    if (this.#port !== port) return;
    this.#port = null;
    this.#greeted = false;
    this.#ignoreHello = false;
    this.#failAll("closed");
    this.#changed();
  }

  #changed() {
    this.#onEvent?.("state", this.state);
  }
}

module.exports = { MockDevice, FAULTS };

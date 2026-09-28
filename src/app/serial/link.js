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
 * link.js — ONE connection's conversation with its device, over whatever port
 * it is handed: the HOST half of the serial protocol v1's session and
 * reliability rules (src/web/docs/serial-protocol.md §5–§6; protocol.js is
 * the bytes). It runs the HELLO / HELLO_ACK handshake a run waits for,
 * delivers Output frames stop-and-wait with ACK/NAK/retry, acknowledges and
 * de-duplicates Input frames, and passes log text on.
 *
 * It knows nothing about serialport, Electron or the renderer. The port is a
 * four-method object (`write`, `onData`, `onClose`, `close` — see ports.js),
 * so the whole state machine runs under `node --test` against a scripted
 * device, and against the REAL generated header compiled on the host
 * (tests/serial-arduino-header.test.js).
 *
 * THE SESSION. Every handshake picks a fresh 16-bit session number (1–65535)
 * and sends it in HELLO; the device echoes it in HELLO_ACK and resets its
 * sequence state only when the session CHANGES. So the host may resend HELLO
 * as often as the bootloader makes it, and a second copy arriving after the
 * device has started talking cannot rewind the device's SEQ counter — which
 * would make its next Input look like a duplicate and be dropped without a
 * word. Sixteen bits, because a board that does not reset between runs
 * remembers the last session it saw, and a restarted Chip Hippo that happened
 * to pick that one again would be taken for a late copy of the old run's
 * HELLO. A HELLO_ACK for any other session is stale and ignored, bar one:
 * session 0 is the device ANNOUNCING that it is in no session — its sketch
 * has (re)started, or given up on this one after an Input went unanswered —
 * which mid-run means it will ignore everything until greeted again.
 *
 * WHY STOP-AND-WAIT. The board stalls at a settle boundary until every frame
 * it sent has been acknowledged (the "integration settle"), and the device
 * ACKs an Output only once its handler has RETURNED — so an ACK means "the
 * device has acted on it", which is the whole point of stalling. One frame in
 * flight per connection is then not a limitation but the definition, and it
 * is also what lets a NAK carry no more information than "resend": there is
 * only ever one frame it can be about.
 *
 * WHAT NEVER LIGHTS A LAMP: an ACK, a NAK, a resend. The lamps are an honest
 * indicator of DATA — with the clock paused, a flickering TX/RX means a
 * feedback loop — so this module reports only first transmissions and
 * delivered frames upward (`onInbound`), and keeps the protocol's own chatter
 * out of that channel.
 *
 * …but not out of SIGHT. Everything the link does is also reported, as FACTS,
 * through `onTrace` — the stream a connection window shows
 * (connection-stream.js): each value that crosses (`data`, with its SEQ and
 * the exact bytes), the protocol's traffic (`proto`: HELLO, HELLO_ACK, ACKs
 * both ways) and what went wrong (`error`: a resend and why, a damaged frame,
 * a failed delivery, a refused handshake, a restart). A resend is an error
 * line, never a second data line, so a retried value appears once as data.
 */
"use strict";

const { randomInt } = require("crypto");
const { StringDecoder } = require("string_decoder");

const {
  FRAME,
  PROTOCOL_VERSION,
  ACK_TIMEOUT_MS,
  MAX_SENDS,
  HELLO_INTERVAL_MS,
  HELLO_WINDOW_MS,
  ANNOUNCE_SESSION,
  MAX_SESSION,
  MAX_SEQ,
  encodeFrame,
  FrameDecoder,
  encodeData,
  decodeData,
  encodeHello,
  decodeHello,
  owesNak,
} = require("./protocol");

/** The session after `session`: 1…65535, wrapping to 1 — 0 is never a
    run's (it is the device's start-up announcement). */
const followingSession = (session) => (session % MAX_SESSION) + 1;

/** The next session number: process-wide and counting, so two runs in a row
    never share one (a device that did not reset between them would keep the
    old run's SEQs). Seeded at random so a restarted app is unlikely — one in
    65535 — to reuse the one a still-running device remembers. */
let lastSession = randomInt(1, MAX_SESSION + 1);
function nextSession() {
  lastSession = followingSession(lastSession);
  return lastSession;
}

/** A data frame's next SEQ: 1…255, wrapping to 1 — 0 is every other frame's. */
const nextSeq = (seq) => (seq % MAX_SEQ) + 1;

class SerialLink {
  #port;
  #timers;
  #timeoutMs;
  #attempts;
  #helloTimeoutMs;
  #helloIntervalMs;
  #sessions;
  #decoder = new FrameDecoder();
  #text = new StringDecoder("utf8");
  #onInbound;
  #onLog;
  #onRestart;
  #onClosed;
  #onTrace;

  #session = null; // this run's session, once a handshake has begun
  #greeted = false; // ACTIVE: the device has answered this session's HELLO
  #failure = null; // FAILED: why the session ended ("delivery", "restart")
  #handshake = null; // the handshake in progress: (hello) => void
  #txSeq = 0; // the last SEQ this side sent
  #lastInSeq = 0; // the last Input SEQ acknowledged (0: none yet)
  #queue = []; // waiting Output frames: { index, width, value, resolve }
  #current = null; // the frame in flight: { frame, seq, tries, timer, resolve }
  #closed = false;

  /**
   * @param {object} opts
   * @param {{write: (buf: Buffer) => void, onData: (cb: (chunk: Buffer) => void) => void,
   *   onClose: (cb: (err?: Error|null) => void) => void, close: () => any}} opts.port
   * @param {number} [opts.timeoutMs] - the ACK timeout; the protocol's own
   *   unless a test shortens it.
   * @param {number} [opts.attempts]
   * @param {number} [opts.helloTimeoutMs]
   * @param {number} [opts.helloIntervalMs]
   * @param {{setTimeout: Function, clearTimeout: Function, setInterval: Function,
   *   clearInterval: Function}} [opts.timers] - injectable for tests.
   * @param {() => number} [opts.sessions] - the session each handshake uses;
   *   the process-wide counter unless a test names its own.
   * @param {(data: {index: number, width: number, value: number}) => void} [opts.onInbound]
   * @param {(text: string) => void} [opts.onLog]
   * @param {() => void} [opts.onRestart] - the device announced a restart
   *   after the handshake.
   * @param {(info: {unexpected: boolean, error: Error|null}) => void} [opts.onClosed]
   * @param {(entry: object) => void} [opts.onTrace] - everything the link
   *   does, as stream entries (see the header).
   */
  constructor({
    port,
    timeoutMs = ACK_TIMEOUT_MS,
    attempts = MAX_SENDS,
    helloTimeoutMs = HELLO_WINDOW_MS,
    helloIntervalMs = HELLO_INTERVAL_MS,
    timers = globalThis,
    sessions = nextSession,
    onInbound,
    onLog,
    onRestart,
    onClosed,
    onTrace,
  }) {
    this.#port = port;
    this.#timers = timers;
    this.#timeoutMs = Math.max(10, Number(timeoutMs) || ACK_TIMEOUT_MS);
    this.#attempts = Math.max(1, Number(attempts) || MAX_SENDS);
    this.#helloTimeoutMs = helloTimeoutMs;
    this.#helloIntervalMs = helloIntervalMs;
    this.#sessions = sessions;
    this.#onInbound = onInbound;
    this.#onLog = onLog;
    this.#onRestart = onRestart;
    this.#onClosed = onClosed;
    this.#onTrace = onTrace;
    port.onData((chunk) => this.#receive(chunk));
    port.onClose((err) => this.#portClosed(err ?? null));
  }

  get closed() {
    return this.#closed;
  }

  /**
   * Greet the device: HELLO every so often until it answers for THIS session
   * (a bootloader may swallow the first few), then judge its answer — the
   * version first, read whatever the answer's length, so a sketch from
   * another version is named as that rather than as silence.
   * The device judges too (it joins only a HELLO that matches it), but only
   * the host has to say what is wrong.
   *
   * @param {number} signature - the layout signature this run expects.
   * @returns {Promise<{ok: true, device: {version: number, signature: number}} |
   *   {ok: false, code: "no-response"|"version"|"signature"|"closed",
   *   device?: {version: number, signature: number|null}}>} - a device of
   *   another version may not have said a signature this side can read.
   */
  handshake(signature) {
    if (this.#closed) return Promise.resolve({ ok: false, code: "closed" });
    const session = this.#sessions();
    this.#session = session;
    this.#greeted = false;
    this.#failure = null;
    return new Promise((resolve) => {
      const t = this.#timers;
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        t.clearInterval(ask);
        t.clearTimeout(giveUp);
        this.#handshake = null;
        resolve(result);
      };
      this.#handshake = (hello) => {
        if (!hello) return finish({ ok: false, code: "closed" });
        const device = { version: hello.version, signature: hello.signature };
        if (device.version !== PROTOCOL_VERSION) {
          this.#trace({
            kind: "error",
            event: "version",
            version: device.version,
          });
          return finish({ ok: false, code: "version", device });
        }
        if (device.signature >>> 0 !== signature >>> 0) {
          this.#trace({
            kind: "error",
            event: "signature",
            signature: device.signature >>> 0,
            expected: signature >>> 0,
          });
          return finish({ ok: false, code: "signature", device });
        }
        this.#greeted = true;
        this.#txSeq = 0;
        this.#lastInSeq = 0;
        this.#trace({
          kind: "proto",
          event: "handshake",
          version: device.version,
          signature: device.signature >>> 0,
        });
        finish({ ok: true, device });
      };
      const hello = () => {
        this.#trace({
          kind: "proto",
          event: "hello",
          session,
          version: PROTOCOL_VERSION,
          signature: signature >>> 0,
        });
        this.#write({
          type: FRAME.HELLO,
          payload: encodeHello({
            version: PROTOCOL_VERSION,
            session,
            signature,
          }),
        });
      };
      const ask = t.setInterval(hello, this.#helloIntervalMs);
      const giveUp = t.setTimeout(() => {
        this.#trace({
          kind: "error",
          event: "no-response",
          ms: this.#helloTimeoutMs,
        });
        finish({ ok: false, code: "no-response" });
      }, this.#helloTimeoutMs);
      hello();
    });
  }

  /**
   * Deliver one Output frame. Resolves `{ok: true}` once the device has ACKed
   * it (its handler has returned), or `{ok: false, code}` after the last
   * attempt — "delivery" — or when the port went away — "closed". Never
   * rejects: a failed delivery is an answer, and the caller stops the run on it.
   * Data frames go only while the session is ACTIVE (§5.2): before the
   * handshake nothing is sent, and after a failure the failure answers again.
   */
  send(index, width, value) {
    if (this.#closed) return Promise.resolve({ ok: false, code: "closed" });
    if (!this.#greeted) {
      return Promise.resolve({ ok: false, code: this.#failure ?? "closed" });
    }
    return new Promise((resolve) => {
      this.#queue.push({ index, width, value, resolve });
      this.#pump();
    });
  }

  /** Let go of the port. Everything still waiting answers "closed". */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll("closed");
    try {
      await this.#port.close();
    } catch {
      /* already gone — the point was to be rid of it */
    }
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  #pump() {
    if (this.#current || this.#closed) return;
    const next = this.#queue.shift();
    if (!next) return;
    this.#txSeq = nextSeq(this.#txSeq);
    const seq = this.#txSeq;
    const payload = encodeData(next.index, next.width, next.value);
    const frame = encodeFrame({ type: FRAME.OUTPUT, seq, payload });
    this.#current = {
      frame,
      seq,
      tries: 0,
      timer: null,
      resolve: next.resolve,
    };
    this.#trace({ kind: "data", dir: "out", seq, ...decodeData(payload), raw: [...frame] }); // prettier-ignore
    this.#transmit();
  }

  /**
   * (Re)send the frame in flight and arm its timeout. `cause` says why this
   * is a RESEND — "timeout" or "nak" — and is absent for the first send.
   */
  #transmit(cause = "timeout") {
    const cur = this.#current;
    if (!cur) return;
    if (cur.tries >= this.#attempts) {
      this.#trace({
        kind: "error",
        event: "failed",
        seq: cur.seq,
        attempts: cur.tries,
      });
      this.#finish({ ok: false, code: "delivery" });
      return;
    }
    if (cur.tries > 0) {
      this.#trace({
        kind: "error",
        event: "resend",
        cause,
        seq: cur.seq,
        attempt: cur.tries + 1,
        max: this.#attempts,
      });
    }
    cur.tries++;
    this.#timers.clearTimeout(cur.timer);
    cur.timer = this.#timers.setTimeout(
      () => this.#transmit(),
      this.#timeoutMs,
    );
    this.#writeRaw(cur.frame);
  }

  #finish(result) {
    const cur = this.#current;
    if (!cur) return;
    this.#timers.clearTimeout(cur.timer);
    this.#current = null;
    cur.resolve(result);
    // One failure ends the run, so a frame queued behind it is not worth
    // trying — and trying would only hold the stall open three times longer.
    if (!result.ok) this.#fail(result.code);
    else this.#pump();
  }

  /** The session has FAILED (§5.2): nothing more is sent or accepted but
      log text, and everything waiting answers `code`. */
  #fail(code) {
    this.#greeted = false;
    this.#failure = code;
    this.#failAll(code);
  }

  #failAll(code) {
    const cur = this.#current;
    if (cur) {
      this.#timers.clearTimeout(cur.timer);
      this.#current = null;
      cur.resolve({ ok: false, code });
    }
    for (const q of this.#queue.splice(0)) q.resolve({ ok: false, code });
    this.#handshake?.(null);
  }

  #write(frame) {
    this.#writeRaw(encodeFrame(frame));
  }

  #trace(entry) {
    try {
      this.#onTrace?.(entry);
    } catch (err) {
      console.error("[serial] trace listener failed:", err);
    }
  }

  #writeRaw(buf) {
    if (this.#closed) return;
    try {
      this.#port.write(buf);
    } catch {
      // A write into a port that has just gone is answered by its close
      // event, which is where the run learns of it.
    }
  }

  // ── Receiving ────────────────────────────────────────────────────────────

  #receive(chunk) {
    for (const frame of this.#decoder.push(chunk)) {
      if (!frame.ok) {
        // The fast fail: NAK at once rather than let the sender wait out its
        // timeout — for anything that would be resent (§3.5). Damage before
        // the session is a bootloader's noise, not worth a line.
        if (!this.#greeted) continue;
        const nak = owesNak(frame.type);
        this.#trace({
          kind: "error",
          event: "damaged",
          error: frame.error,
          type: frame.type,
          seq: frame.seq,
          nak,
        });
        if (nak) this.#write({ type: FRAME.NAK });
        continue;
      }
      this.#handle(frame);
    }
  }

  #handle(frame) {
    switch (frame.type) {
      case FRAME.HELLO_ACK:
        return this.#onHelloAck(frame);
      case FRAME.LOG: {
        const text = this.#text.write(frame.payload);
        if (text) this.#onLog?.(text);
        return;
      }
      default:
        break;
    }
    // Everything else belongs to a session: until the device has answered
    // this one, it is left over from before (or not for us at all).
    if (!this.#greeted) return;
    switch (frame.type) {
      case FRAME.ACK:
        // One that does not match the frame in flight is stale.
        if (this.#current && frame.seq === this.#current.seq) {
          this.#trace({ kind: "proto", event: "ack-in", seq: frame.seq });
          this.#finish({ ok: true });
        } else {
          this.#trace({ kind: "proto", event: "stale-ack", seq: frame.seq });
        }
        return;
      case FRAME.NAK:
        // Only ever about the one frame in flight; resend it now.
        if (this.#current) this.#transmit("nak");
        else this.#trace({ kind: "proto", event: "nak-idle" });
        return;
      case FRAME.INBOUND: {
        // Acknowledged as soon as it is here, whatever the run is doing — a
        // stalled board still receives, it just does not APPLY until the stall
        // is over — so the device's send() returns promptly. A resend of the
        // last one acknowledged (our ACK was lost) is ACKed again and dropped;
        // one that is intact but unusable is acknowledged and dropped (§4.2).
        if (frame.seq === 0) return; // no data frame's: ignored, not ACKed
        this.#write({ type: FRAME.ACK, seq: frame.seq });
        if (frame.seq === this.#lastInSeq) {
          this.#trace({ kind: "error", event: "duplicate", seq: frame.seq });
          this.#trace({ kind: "proto", event: "ack-out", seq: frame.seq });
          return;
        }
        this.#lastInSeq = frame.seq;
        const data = decodeData(frame.payload);
        this.#trace(
          data
            ? { kind: "data", dir: "in", seq: frame.seq, ...data, raw: [...encodeFrame(frame)] } // prettier-ignore
            : { kind: "error", event: "unusable", seq: frame.seq },
        );
        this.#trace({ kind: "proto", event: "ack-out", seq: frame.seq });
        if (data) this.#onInbound?.(data);
        return;
      }
      default:
        return; // a type this side never receives
    }
  }

  #onHelloAck(frame) {
    const hello = decodeHello(frame.payload);
    if (!hello) return;
    if (hello.session === ANNOUNCE_SESSION) {
      // The sketch is in no session. During the handshake that is expected
      // (opening the port reset the board) — it answers the next HELLO. After
      // it, the device has restarted, or given this session up.
      if (this.#greeted) {
        this.#trace({ kind: "error", event: "restart" });
        this.#fail("restart");
        this.#onRestart?.();
      } else if (this.#handshake) {
        this.#trace({ kind: "proto", event: "announce" });
      }
      return;
    }
    // Stale (another session's), or a repeat of this one's after the fact.
    if (!this.#handshake || hello.session !== this.#session) return;
    // A v1 answer that is not v1's seven bytes is no answer at all; another
    // version's is judged on its version alone.
    if (hello.version === PROTOCOL_VERSION && hello.signature === null) {
      return;
    }
    this.#trace({
      kind: "proto",
      event: "hello-ack",
      session: hello.session,
      version: hello.version,
      ...(hello.signature === null ? {} : { signature: hello.signature >>> 0 }),
    });
    this.#handshake(hello);
  }

  #portClosed(error) {
    if (this.#closed) return; // we closed it — nothing to report
    this.#closed = true;
    this.#failAll("closed");
    // Not every way a device goes leaves the port shut behind it (an
    // end-of-file does not), and a port left open is one the Arduino IDE
    // cannot have back to reflash the board.
    Promise.resolve()
      .then(() => this.#port.close())
      .catch(() => {});
    this.#onClosed?.({ unexpected: true, error });
  }
}

module.exports = { SerialLink, followingSession };

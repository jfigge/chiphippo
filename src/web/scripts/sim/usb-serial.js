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

// usb-serial.js — the USB-serial adapter's behaviour (Feature 420): an FTDI
// breakout's UART, its far side the Terminal window. Pure and DOM-free; the
// standard sequential contract plus `lineWakeAt`.
//
//   TXD  the adapter's OUTPUT — the bytes the Terminal sends, as frames
//   RXD  its INPUT — frames the circuit sends, decoded for the Terminal
//   CTS# with hardware flow control on, the adapter sends only while it is LOW
//   RTS# always LOW: the PC end is always ready (its buffer is the window's)
//
// THE LINE IS LEVELS (sim/uart.js). Transmitting, the adapter's state holds
// the frame in flight and the level it puts on TXD; `step` moves that level
// on when `now` reaches the next bit edge, and `lineWakeAt` asks for a tick
// exactly there — an EXACT wake, which SimController does not hold to the
// 0.5 ms floor every other timed wake keeps (a 19 200-baud bit is 52 µs).
// Receiving, it records the moment of every change it is stepped through
// (the line moves only at ticks, so that record IS the line) and decodes the
// frame from it at the middle of the first stop bit — one wake a frame.
//
// `step` is idempotent at one `now` (the engine steps a part several times a
// tick) and returns its state VERBATIM when nothing moved, which is what lets
// the tick's state fixpoint settle.
//
// The line settings are the PART's params (catalog/usb-serial.js), handed in
// as `env.params`. The bytes to send arrive in the state itself
// (`queueBytes`, which SimController's `queueSerial` swaps in); what was
// received leaves it in `log`, a short window numbered by `seq` that
// SimController reads after every tick (a publish shows only a batch's last).

import { H, L } from "./levels.js";
import {
  bitTime,
  decodeFrame,
  frameAt,
  frameBits,
  levelAt,
  lineFormat,
  sampleEnd,
} from "./uart.js";

/** How many bytes the adapter holds waiting to go: a paste larger than this
    waits in the Terminal window and is fed as it drains (`txFree`). */
export const TX_QUEUE = 256;

/** How many received frames the state remembers — enough for every frame one
    tick could finish many times over (each frame's end is a wake). */
export const RX_LOG = 32;

const EPS = 1e-9;

/** The line settings out of a part's params (catalog/usb-serial.js's
    normalizer has already held each to its choices). */
export function lineSettings(params = {}) {
  return {
    baud: Number.isFinite(params.baud) && params.baud > 0 ? params.baud : 9600,
    format: lineFormat(params),
    flow: params.flow === "rtscts" ? "rtscts" : "none",
  };
}

/** An adapter's state with `bytes` added to its send queue, as far as there
    is room: `{state, taken}`. A NEW object, so the engine sees the change. */
export function queueBytes(state, bytes) {
  const s = state ?? initialAdapterState();
  const room = Math.max(0, TX_QUEUE - s.queue.length);
  const take = [...bytes].slice(0, room).map((b) => b & 0xff);
  if (!take.length) return { state: s, taken: 0 };
  return { state: { ...s, queue: [...s.queue, ...take] }, taken: take.length };
}

/** Room left in the send queue. */
export function txFree(state) {
  return TX_QUEUE - (state?.queue.length ?? 0);
}

/** Whether the adapter is sending or has bytes waiting. */
export function txBusy(state) {
  return Boolean(state?.tx) || (state?.queue.length ?? 0) > 0;
}

/** The frames received after `seq`: what SimController hands the Terminal. */
export function receivedSince(state, seq) {
  return (state?.log ?? []).filter((r) => r.seq > seq);
}

export function initialAdapterState() {
  return {
    queue: [], // bytes waiting to be sent
    tx: null, // {bits, t0, bt, stop}: the frame on TXD
    txLevel: 1, // TXD's level, 0/1
    // RXD as last seen, 0/1 — null before the first look. A receiver hears a
    // start bit only as the line FALLING from idle, so a line already LOW at
    // Run (a shift register powering up full of zeros) is no frame: it is
    // listened to once it has been seen HIGH.
    rxLevel: null,
    rx: null, // {t0, bt, format, changes}: the frame arriving on RXD
    rxArmed: false, // listening for a start bit (RXD seen HIGH since)
    seq: 0, // frames received since Run
    log: [], // the last RX_LOG of them: {seq, byte, framingError, parityError, brk}
    wake: null, // the next moment the line moves or a frame completes
  };
}

/** The earliest of the moments a state is waiting for, seen from `now`. */
function wakeOf(s, now) {
  let at = null;
  const later = (t) => {
    if (t != null && Number.isFinite(t)) at = at == null ? t : Math.min(at, t);
  };
  if (s.tx) {
    const f = frameAt(s.tx.bits, s.tx.t0, s.tx.bt, now, s.tx.stop);
    later(f.nextChange ?? f.end);
  }
  if (s.rx) later(sampleEnd(s.rx.t0, s.rx.bt, s.rx.format));
  return at;
}

/**
 * The adapter's logic block, its pins named by number.
 * @param {{txd: number, rxd: number, cts: number, rts: number}} pins
 */
export function usbSerialUnit({ txd, rxd, cts, rts }) {
  return {
    state0: initialAdapterState,

    step(state, ins, _prev, env) {
      const now = env?.now ?? 0;
      const { baud, format, flow } = lineSettings(env?.params);
      const bt = bitTime(baud);
      let s = state;
      const edit = (patch) => {
        s = { ...s, ...patch };
      };

      // ── Receive: record the line, and decode a frame whose end is here.
      const line = ins.get(rxd) === L ? 0 : 1;
      if (line !== s.rxLevel) {
        if (s.rx) {
          // Back HIGH before the start bit's middle: a glitch, not a frame.
          if (line === 1 && now < s.rx.t0 + s.rx.bt / 2 - EPS) {
            edit({ rxLevel: 1, rx: null });
          } else {
            edit({ rxLevel: line, rx: { ...s.rx, changes: [...s.rx.changes, [now, line]] } }); // prettier-ignore
          }
        } else if (line === 0 && s.rxArmed) {
          edit({ rxLevel: 0, rx: { t0: now, bt, format, changes: [] } });
        } else {
          edit({ rxLevel: line, rxArmed: s.rxArmed || line === 1 });
        }
      }
      if (s.rx && now + EPS >= sampleEnd(s.rx.t0, s.rx.bt, s.rx.format)) {
        const { t0, changes } = s.rx;
        const got = decodeFrame((t) => levelAt(changes, 0, t), t0, s.rx.bt, s.rx.format); // prettier-ignore
        if (got.glitch) {
          edit({ rx: null });
        } else {
          const seq = s.seq + 1;
          const entry = { seq, byte: got.byte, framingError: got.framingError, parityError: got.parityError, brk: got.brk }; // prettier-ignore
          edit({
            rx: null,
            // A frame that ended LOW (a framing error, a break) needs the
            // line back HIGH before another start bit can be seen.
            rxArmed: s.rxLevel === 1,
            seq,
            log: [...s.log, entry].slice(-RX_LOG),
          });
        }
      }

      // ── Transmit: move the frame on, then start the next one if allowed.
      if (s.tx) {
        const f = frameAt(s.tx.bits, s.tx.t0, s.tx.bt, now, s.tx.stop);
        if (f.done) edit({ tx: null, txLevel: 1 });
        else if (f.level !== s.txLevel) edit({ txLevel: f.level });
      }
      const clear = flow !== "rtscts" || ins.get(cts) === L;
      if (!s.tx && s.queue.length && clear) {
        const [byte, ...rest] = s.queue;
        const bits = frameBits(byte, format);
        edit({
          queue: rest,
          tx: { bits, t0: now, bt, stop: format.stopBits },
          txLevel: bits[0],
        });
      }

      // Nothing moved: the wake asked for last time still stands (it is the
      // next CHANGE, so no tick in between can have reached it).
      if (s === state) return state;
      const wake = wakeOf(s, now);
      return wake === s.wake ? s : { ...s, wake };
    },

    outputs(state) {
      const out = new Map();
      out.set(txd, (state?.txLevel ?? 1) ? H : L);
      out.set(rts, L);
      return out;
    },

    /** The next moment the line must move or a frame completes — an EXACT
        wake (sim/engine.js `lineWakeAt`). */
    lineWakeAt(state) {
      return state?.wake ?? null;
    },
  };
}

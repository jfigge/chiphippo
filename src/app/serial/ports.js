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
 * ports.js — the ONE place the `serialport` package is touched: listing what
 * is plugged in, and opening one port as the four-method object link.js talks
 * to. Everything above it (link.js, serial-manager.js) is testable without a
 * device because of this seam.
 *
 * `require("serialport")` is deliberately LAZY, the way updater.js loads
 * electron-updater: the package carries a native binding, and a main.js that
 * is merely READ by `node --test` (ipc-parity, the i18n scanner) must not have
 * to load it. It also means a build whose binding failed to load degrades to
 * "no ports" instead of failing to start.
 */
"use strict";

/** The serialport module, or null when its native binding cannot load. */
function serialport() {
  try {
    return require("serialport");
  } catch (err) {
    console.error("[main] serialport unavailable:", err?.message ?? err);
    return null;
  }
}

/**
 * Every serial port the OS reports right now.
 * @returns {Promise<Array<{path: string, manufacturer: string, serialNumber:
 *   string, vendorId: string, productId: string, locationId: string,
 *   pnpId: string}>>}
 */
async function listPorts() {
  const sp = serialport();
  if (!sp) return [];
  const raw = await sp.SerialPort.list();
  return raw
    .filter((p) => typeof p?.path === "string" && p.path)
    .map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer ?? "",
      serialNumber: p.serialNumber ?? "",
      vendorId: p.vendorId ?? "",
      productId: p.productId ?? "",
      // What tells a board's SEVERAL ports apart (CircuitPython's REPL and
      // data): the USB location they share, and where the OS says it, the
      // interface each one is (Windows' "…&MI_02…", Linux's "…-if02").
      locationId: p.locationId ?? "",
      pnpId: p.pnpId ?? "",
    }));
}

/**
 * The four-method object link.js talks to, over an OPEN SerialPort.
 *
 * A device that goes away reaches this side in THREE shapes, and every one is
 * the same news — the board has gone — so all three end the link:
 *
 * - `close` with a DisconnectedError: a read or write failed, which is how a
 *   USB-serial adapter being pulled arrives (ENXIO on the read);
 * - `error`: the SAME failed write, raised a second time on the stream because
 *   link.js writes without a callback. Unlistened, an `error` event is an
 *   uncaught exception in MAIN, raised by the first frame sent to a board
 *   that has gone;
 * - `end`: a binding that reports end-of-file ends the stream WITHOUT closing
 *   it, which would leave a run waiting on a port that can never answer.
 *
 * link.js reports only the FIRST of them (and none after its own close).
 *
 * One way a device can go is NOT seen until the next frame: the macOS binding
 * re-reads a zero-byte read rather than reporting it, so a far end that simply
 * shuts (a pseudo-terminal, in testing) is silent until a write fails. A real
 * USB unplug raises ENXIO at once, and an Output sent in the meantime fails
 * its write — so the run stops either way, only later.
 */
function adaptPort(port) {
  return {
    write: (buf) => port.write(buf),
    onData: (cb) => port.on("data", cb),
    onClose: (cb) => {
      port.on("close", (e) => cb(e ?? null));
      port.on("end", () => cb(null));
      port.on("error", (e) => cb(e ?? null));
    },
    close: () =>
      new Promise((done) => {
        if (!port.isOpen) {
          done();
          return;
        }
        port.close(() => done());
      }),
  };
}

/**
 * The driver's options for a connection's settings. The link is BINARY
 * (serial-protocol.md §2), so two settings are not the connection's to choose,
 * whatever settings.json holds (it is read raw, and may predate the rule):
 * always 8 data bits — CRCs, signatures and values use every bit of a byte —
 * and never XON/XOFF, which would swallow every 0x11 (the INBOUND frame type)
 * and 0x13 the device sends.
 *
 * @param {{port: string, baud: number, parity: string, stopBits: number,
 *   flowControl: string}} config
 */
function portOptions(config) {
  return {
    path: config.port,
    baudRate: config.baud,
    dataBits: 8,
    parity: config.parity,
    stopBits: config.stopBits,
    rtscts: config.flowControl === "hardware",
    xon: false,
    xoff: false,
    xany: false,
    autoOpen: false,
  };
}

/**
 * Open a port with a connection's settings (`portOptions`).
 *
 * Resolves to `adaptPort`'s object; rejects with the driver's own error when
 * the port cannot be opened (missing, busy in another app, permission).
 *
 * @param {{port: string, baud: number, parity: string, stopBits: number,
 *   flowControl: string}} config
 */
function openPort(config) {
  const sp = serialport();
  if (!sp) return Promise.reject(new Error("serial support is unavailable"));
  return new Promise((resolve, reject) => {
    const port = new sp.SerialPort(portOptions(config));
    port.open((err) => {
      if (err) reject(err);
      else resolve(adaptPort(port));
    });
  });
}

module.exports = { listPorts, openPort, adaptPort, portOptions };

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

// serialport.js — the `serialport` package's SerialPort for the web build,
// over the Web Serial API (Chromium). app/serial/ports.js is the one module
// that touches it, and only through `SerialPort.list()`, the constructor,
// `open`, `write`, `close`, `isOpen` and the `data` / `close` / `error`
// events, so that is what is here; the link, the protocol and the Mock above
// it run unchanged.
//
// A page may use only the ports the visitor has granted it (`requestPort`,
// from a click — Settings ▸ Serial I/O's "Add USB device…" on the web). Each
// granted port is named by its USB ids, which is what lets a connection's
// saved port find it again next visit.

import { EventEmitter } from "./events.js";
import { Buffer } from "./node/buffer.js";

const hex = (n) => (Number.isInteger(n) ? n.toString(16).padStart(4, "0") : "");

/** Every granted port with the name `list()` gives it. */
async function granted() {
  const serial = globalThis.navigator?.serial;
  if (!serial) return [];
  const ports = await serial.getPorts();
  const seen = new Map();
  return ports.map((port) => {
    const info = port.getInfo?.() ?? {};
    const base = `usb-${hex(info.usbVendorId) || "serial"}${info.usbProductId != null ? `:${hex(info.usbProductId)}` : ""}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { port, info, path: n > 1 ? `${base}#${n}` : base };
  });
}

export class SerialPort extends EventEmitter {
  static async list() {
    return (await granted()).map(({ info, path }) => ({
      path,
      manufacturer: "",
      serialNumber: "",
      vendorId: hex(info.usbVendorId),
      productId: hex(info.usbProductId),
      locationId: "",
      pnpId: "",
    }));
  }

  #opts;
  #port = null;
  #reader = null;
  #writer = null;
  #open = false;
  #closing = false;

  constructor(opts = {}) {
    super();
    this.#opts = opts;
    this.path = opts.path;
  }

  get isOpen() {
    return this.#open;
  }

  open(cb) {
    void (async () => {
      const match = (await granted()).find((p) => p.path === this.#opts.path);
      if (!match)
        throw new Error(`no granted serial port named ${this.#opts.path}`);
      this.#port = match.port;
      await this.#port.open({
        baudRate: this.#opts.baudRate ?? 9600,
        dataBits: this.#opts.dataBits ?? 8,
        stopBits: this.#opts.stopBits ?? 1,
        parity: this.#opts.parity ?? "none",
        flowControl: this.#opts.rtscts ? "hardware" : "none",
        bufferSize: 4096,
      });
      this.#open = true;
      this.#writer = this.#port.writable.getWriter();
      this.#readLoop();
    })().then(
      () => cb?.(null),
      (err) => cb?.(err),
    );
  }

  async #readLoop() {
    try {
      while (this.#open && this.#port?.readable) {
        this.#reader = this.#port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.#reader.read();
            if (done) break;
            if (value?.length) this.emit("data", Buffer.from(value));
          }
        } finally {
          this.#reader.releaseLock();
          this.#reader = null;
        }
      }
      if (!this.#closing) this.#lost(null);
    } catch (err) {
      if (!this.#closing) this.#lost(err);
    }
  }

  #lost(err) {
    if (!this.#open) return;
    this.#open = false;
    const e = err ? Object.assign(err, { disconnected: true }) : null;
    this.emit("close", e);
  }

  write(buf, cb) {
    if (!this.#writer) {
      const err = new Error("the port is not open");
      cb?.(err);
      this.emit("error", err);
      return false;
    }
    this.#writer.write(new Uint8Array(buf)).then(
      () => cb?.(null),
      (err) => {
        cb?.(err);
        this.emit("error", err);
      },
    );
    return true;
  }

  close(cb) {
    void (async () => {
      this.#closing = true;
      this.#open = false;
      try {
        await this.#reader?.cancel();
      } catch {
        // already ended
      }
      try {
        this.#writer?.releaseLock();
      } catch {
        // released
      }
      this.#writer = null;
      try {
        await this.#port?.close();
      } catch {
        // closed
      }
      this.emit("close", null);
    })().then(() => cb?.(null));
  }
}

export default { SerialPort };

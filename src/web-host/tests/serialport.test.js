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

// serialport.test.js — the `serialport` stand-in over Web Serial: a
// non-fatal read error (framing, parity, break, overrun) keeps the port and
// reads on from the fresh stream the spec hands out; a fatal one lets go of
// the port whole, so a reconnect is not refused as "already open".

import test from "node:test";
import assert from "node:assert/strict";

/** A granted port whose reads follow `script`: bytes, or an error's name. */
function fakePort(script) {
  const port = {
    opened: false,
    readable: null,
    writable: null,
    getInfo: () => ({ usbVendorId: 0x2341, usbProductId: 0x0043 }),
    async open() {
      if (port.opened)
        throw Object.assign(new Error("The port is already open."), {
          name: "InvalidStateError",
        });
      port.opened = true;
      let i = 0;
      port.readable = {
        getReader: () => ({
          async read() {
            const step = script[i++];
            if (step === undefined) return new Promise(() => {});
            if (typeof step === "string") {
              if (step === "NetworkError") port.readable = null;
              throw Object.assign(new Error(step), { name: step });
            }
            return { value: new Uint8Array(step), done: false };
          },
          releaseLock() {},
          async cancel() {},
        }),
      };
      port.writable = {
        getWriter: () => ({ write: async () => {}, releaseLock() {} }),
      };
    },
    async close() {
      port.opened = false;
      port.readable = null;
    },
  };
  return port;
}

async function withPorts(ports, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { serial: { getPorts: async () => ports } },
    configurable: true,
  });
  try {
    const { SerialPort } = await import("../serialport.js");
    await fn(SerialPort);
  } finally {
    if (had) Object.defineProperty(globalThis, "navigator", had);
    else delete globalThis.navigator;
  }
}

const opened = (sp) =>
  new Promise((resolve, reject) =>
    sp.open((err) => (err ? reject(err) : resolve())),
  );
const tick = () => new Promise((r) => setTimeout(r, 5));

test("a framing error is not a lost port: reading goes on", () =>
  withPorts([fakePort([[1, 2], "FramingError", [3]])], async (SerialPort) => {
    const [{ path }] = await SerialPort.list();
    const sp = new SerialPort({ path, baudRate: 115200 });
    const data = [];
    let closed = false;
    sp.on("data", (d) => data.push(...d));
    sp.on("close", () => (closed = true));
    await opened(sp);
    await tick();
    assert.deepEqual(data, [1, 2, 3]);
    assert.equal(closed, false);
    assert.equal(sp.isOpen, true);
  }));

test("a lost port is let go of whole, so a reconnect opens", () => {
  const port = fakePort([[1], "NetworkError"]);
  return withPorts([port], async (SerialPort) => {
    const [{ path }] = await SerialPort.list();
    const sp = new SerialPort({ path, baudRate: 115200 });
    const gone = new Promise((r) => sp.on("close", r));
    await opened(sp);
    const err = await gone;
    assert.equal(err?.disconnected, true);
    assert.equal(port.opened, false, "the underlying port was closed");
    await opened(new SerialPort({ path, baudRate: 115200 }));
  });
});

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
 * tests/serial-ports.test.js — the adapter between a `serialport` stream and
 * the link: every shape a vanished device arrives in ends the link, and a
 * dropped port is let go of rather than left open.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { adaptPort, portOptions } = require("../serial/ports");
const { SerialLink } = require("../serial/link");

/** Enough of a SerialPort stream for the adapter. */
function fakeStream() {
  const port = new EventEmitter();
  port.isOpen = true;
  port.closes = 0;
  port.write = () => true;
  port.close = (cb) => {
    port.closes++;
    port.isOpen = false;
    setImmediate(cb);
  };
  return port;
}

const tick = () => new Promise((r) => setImmediate(r));

for (const [shape, raise] of [
  ["close (a disconnect)", (p) => p.emit("close", new Error("disconnected"))],
  ["end (end-of-file, as a pty reports it)", (p) => p.emit("end")],
  ["error (a failed write)", (p) => p.emit("error", new Error("EIO"))],
]) {
  test(`a device that goes away as ${shape} ends the link, once`, async () => {
    const stream = fakeStream();
    const closed = [];
    const link = new SerialLink({
      port: adaptPort(stream),
      timeoutMs: 5000,
      onClosed: (info) => closed.push(info),
    });
    const pending = link.send(0, 8, 1);
    raise(stream);
    stream.emit("close", null); // a later close of the same port is not news
    assert.deepEqual(await pending, { ok: false, code: "closed" });
    assert.equal(closed.length, 1);
    assert.equal(closed[0].unexpected, true);
    await tick();
    assert.equal(stream.isOpen, false, "the port is let go of");
  });
}

test("an error event is always listened for — never an uncaught throw in main", () => {
  const stream = fakeStream();
  new SerialLink({ port: adaptPort(stream) });
  assert.ok(stream.listenerCount("error") > 0);
  assert.doesNotThrow(() => stream.emit("error", new Error("EIO")));
});

test("closing an already-closed port does not call the driver", async () => {
  const stream = fakeStream();
  const adapted = adaptPort(stream);
  stream.isOpen = false;
  await adapted.close();
  assert.equal(stream.closes, 0);
});

test("the port is always 8 data bits and never XON/XOFF — the link is binary", () => {
  // settings.json is read raw and may predate the rule: a stored 7 or
  // "software" must not reach the driver (0x11 is the INBOUND frame type).
  const opts = portOptions({
    port: "/dev/cu.nano",
    baud: 115200,
    dataBits: 7,
    parity: "even",
    stopBits: 1,
    flowControl: "software",
  });
  assert.equal(opts.dataBits, 8);
  assert.equal(opts.xon, false);
  assert.equal(opts.xoff, false);
  assert.equal(opts.xany, false);
  assert.equal(opts.rtscts, false);
  assert.equal(opts.parity, "even", "the rest is the connection's");
  assert.equal(opts.baudRate, 115200);
  assert.equal(
    portOptions({ port: "p", baud: 9600, flowControl: "hardware" }).rtscts,
    true,
  );
});

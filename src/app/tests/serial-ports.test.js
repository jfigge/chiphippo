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
 * tests/serial-ports.test.js — the adapter between a `serialport` stream and
 * the link: every shape a vanished device arrives in ends the link, and a
 * dropped port is let go of rather than left open.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { adaptPort } = require("../serial/ports");
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

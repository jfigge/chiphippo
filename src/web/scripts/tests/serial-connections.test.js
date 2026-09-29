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

// Tests for model/serial-connections.js — named connections as data, and the
// built-in MOCK's place among them: offered first, never a problem before a
// run, never in settings or a project file, and its id and name its own.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONNECTION_DEFAULTS,
  MOCK_CONNECTION,
  MOCK_ID,
  connectionProblem,
  isReservedConnectionName,
  knownConnections,
  mergeProjectConnections,
  normalizeConnection,
  normalizeConnections,
  portInterface,
  portPositions,
  projectConnections,
  uniqueConnectionName,
} from "../model/serial-connections.js";

const nano = {
  id: "conn-ab",
  name: "Nano",
  ...CONNECTION_DEFAULTS,
  port: "/dev/a",
};

test("a stored framing the binary link cannot carry normalizes away", () => {
  // 5-7 data bits cannot carry a CRC byte; XON/XOFF swallows 0x11 (INBOUND).
  const c = normalizeConnection({
    id: "conn-x",
    name: "X",
    dataBits: 7,
    parity: "even",
    flowControl: "software",
  });
  assert.equal(c.dataBits, 8);
  assert.equal(c.flowControl, "none");
  assert.equal(c.parity, "even", "the rest is kept");
  assert.equal(
    normalizeConnection({ id: "conn-x", flowControl: "hardware" }).flowControl,
    "hardware",
  );
});

test("the Mock is offered first, before the machine's own connections", () => {
  assert.deepEqual(
    knownConnections([nano]).map((c) => c.id),
    [MOCK_ID, "conn-ab"],
  );
  assert.deepEqual(knownConnections(undefined), [MOCK_CONNECTION]);
  assert.equal(MOCK_CONNECTION.name, "Mock");
});

test("a stored connection claiming the Mock's id is dropped", () => {
  assert.equal(normalizeConnection({ id: "mock", name: "Impostor" }), null);
  assert.deepEqual(
    normalizeConnections([{ id: "mock", name: "x" }, nano]).map((c) => c.id),
    ["conn-ab"],
  );
  assert.deepEqual(
    knownConnections([{ id: "mock", name: "Impostor", port: "/dev/x" }]),
    [MOCK_CONNECTION],
  );
});

test("the Mock is never a problem before a run — it has no port to miss", () => {
  assert.equal(connectionProblem(MOCK_CONNECTION, null), null);
  assert.equal(connectionProblem(MOCK_CONNECTION, []), null);
  assert.equal(connectionProblem({ ...nano, port: "" }, null), "no-port");
});

test("a project file never carries the Mock, and never adds it to settings", () => {
  assert.deepEqual(
    projectConnections([MOCK_ID, "conn-ab"], knownConnections([nano])).map(
      (c) => c.id,
    ),
    ["conn-ab"],
  );
  const merged = mergeProjectConnections(
    [nano],
    [{ id: "mock", name: "Mock" }],
  );
  assert.deepEqual(merged.added, []);
});

test("the Mock's name is reserved, whatever its case or spacing", () => {
  assert.equal(isReservedConnectionName("Mock"), true);
  assert.equal(isReservedConnectionName("  mOcK "), true);
  assert.equal(isReservedConnectionName("Mockingbird"), false);
  assert.equal(uniqueConnectionName([], "Mock"), "Mock 2");
});

test("a connection's language is C++ unless it says Python, and it travels with a project", () => {
  assert.equal(
    normalizeConnection({ id: "conn-x", name: "X" }).language,
    "cpp",
  );
  assert.equal(
    normalizeConnection({ id: "conn-x", name: "X", language: "rust" }).language,
    "cpp",
    "a language Generate does not write is repaired",
  );
  const pico = { ...nano, id: "conn-py", name: "Pico", language: "python" };
  assert.equal(normalizeConnection(pico).language, "python");

  // The project carries it (a fact about the board's code, not the machine)…
  const [carried] = projectConnections(["conn-py"], [pico]);
  assert.equal(carried.language, "python");
  assert.equal(carried.port, undefined, "never the port");
  // …and a machine that lacks the connection gets it back with the project.
  const { list } = mergeProjectConnections([], [carried]);
  assert.equal(list[0].language, "python");
  assert.equal(list[0].needsConfig, true);
});

test("portInterface: Windows and Linux name a port's USB interface; macOS does not", () => {
  assert.equal(
    portInterface({ pnpId: "USB\\VID_239A&PID_80F4&MI_02\\7&1A2B&0&0002" }),
    2,
  );
  assert.equal(
    portInterface({
      pnpId: "usb-Adafruit_Industries_LLC_Feather_RP2040_DF60-if00",
    }),
    0,
  );
  assert.equal(portInterface({ path: "/dev/cu.usbmodem1101" }), null);
  assert.equal(portInterface({ pnpId: "" }), null);
});

test("portPositions: a board's ports are numbered REPL-first; a port on its own is 1 of 1", () => {
  const scan = [
    { path: "/dev/cu.usbmodem1103", serialNumber: "DF60" },
    { path: "/dev/cu.Bluetooth-Incoming-Port" },
    { path: "/dev/cu.usbmodem1101", serialNumber: "DF60" },
    { path: "/dev/cu.usbserial-10", locationId: "0x14100000" },
  ];
  assert.deepEqual(
    portPositions(scan).map((p) => [p.path, p.n, p.count]),
    [
      ["/dev/cu.usbmodem1103", 2, 2],
      ["/dev/cu.Bluetooth-Incoming-Port", 1, 1],
      ["/dev/cu.usbmodem1101", 1, 2],
      ["/dev/cu.usbserial-10", 1, 1],
    ],
    "the scan's order is kept; the numbers come from the path",
  );

  // Where the OS names the interface, that wins over the path — COM10's
  // interface 0 is the REPL though "COM10" sorts after "COM9".
  const windows = portPositions([
    { path: "COM9", serialNumber: "X", pnpId: "USB\\VID_239A&MI_02\\1" },
    { path: "COM10", serialNumber: "X", pnpId: "USB\\VID_239A&MI_00\\1" },
  ]);
  assert.deepEqual(
    windows.map((p) => [p.path, p.n]),
    [
      ["COM9", 2],
      ["COM10", 1],
    ],
  );

  // Two ports sharing only a USB location are one board too; paths compare
  // numerically, so usbmodem9 comes before usbmodem10.
  const located = portPositions([
    { path: "/dev/cu.usbmodem10", locationId: "L" },
    { path: "/dev/cu.usbmodem9", locationId: "L" },
  ]);
  assert.deepEqual(
    located.map((p) => [p.path, p.n]),
    [
      ["/dev/cu.usbmodem10", 2],
      ["/dev/cu.usbmodem9", 1],
    ],
  );
});

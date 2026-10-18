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

// terminal-bridge.test.js — the main renderer's side of the Terminal windows
// (Feature 420): the screen kept here, received bytes drawn on it, keys and
// pastes paced into the run by the room the adapter publishes.

import test from "node:test";
import assert from "node:assert/strict";
import { resetDom } from "./jsdom-setup.js";
import { TerminalBridge } from "../components/terminal-bridge.js";

const bytes = (s) => [...s].map((c) => c.charCodeAt(0));

function rig({ params = {} } = {}) {
  resetDom();
  const sent = []; // [compId, msg] to the windows
  const queued = []; // [compId, bytes] into the run
  let room = 4;
  const comps = new Map([["c9", { id: "c9", ref: "usb-serial", params }]]);
  const bridge = {
    terminal: {
      open: async () => true,
      toWindow: async (id, msg) => sent.push([id, msg]),
    },
  };
  const sim = {
    queueSerial: (id, list) => {
      const n = Math.min(room, list.length);
      room -= n;
      queued.push([id, list.slice(0, n)]);
      return n;
    },
  };
  const timers = { set: (fn) => (fn(), 1), clear: () => {} };
  const deskDoc = { getComponent: (id) => comps.get(id) ?? null };
  const tb = new TerminalBridge({ bridge, deskDoc, sim, timers });
  const fromWindow = (msg) =>
    window.dispatchEvent(new CustomEvent("chiphippo:terminal-host-inbound", { detail: { compId: "c9", msg } })); // prettier-ignore
  const simState = (mode, free) => {
    room = free;
    window.dispatchEvent(
      new CustomEvent("chiphippo:sim-state", {
        detail: { mode, serialPorts: new Map([["c9", { free, busy: false, seq: 0 }]]) }, // prettier-ignore
      }),
    );
  };
  const received = (list) =>
    window.dispatchEvent(new CustomEvent("chiphippo:serial-rx", { detail: { received: new Map([["c9", list]]) } })); // prettier-ignore
  return { tb, sent, queued, fromWindow, simState, received, comps };
}

test("a window that says ready is sent its adapter's state and the whole screen", () => {
  const r = rig({ params: { baud: 300 } });
  r.tb.open("c9");
  r.received(bytes("HELLO\r\n").map((byte) => ({ byte })));
  r.fromWindow({ kind: "ready" });
  const state = r.sent.find(([, m]) => m.kind === "state")[1];
  assert.equal(state.line, "300 8N1");
  assert.equal(state.running, false);
  const screen = r.sent.filter(([, m]) => m.kind === "screen").at(-1)[1];
  assert.deepEqual(
    screen.lines,
    ["HELLO", ""],
    "what arrived before it opened",
  );
  assert.equal(screen.from, 0);
});

test("keys reach the run only while it runs, paced by the adapter's room", () => {
  const r = rig();
  r.tb.open("c9");
  r.fromWindow({ kind: "ready" });
  r.fromWindow({ kind: "keys", bytes: [0x41] });
  assert.deepEqual(r.queued, [], "stopped: nothing is listening");
  r.simState("running", 4);
  r.fromWindow({ kind: "paste", text: "ABCDEF\nG" });
  assert.deepEqual(r.queued, [["c9", bytes("ABCD")]], "four fit");
  r.simState("running", 10);
  assert.deepEqual(r.queued.at(-1), ["c9", [...bytes("EF"), 0x0d, ...bytes("G")]], "the rest as it drains — the newline sent as Enter"); // prettier-ignore
});

test("with local echo on, typing shows on the screen too; Clear empties it", () => {
  const r = rig({ params: { echo: "on" } });
  r.tb.open("c9");
  r.fromWindow({ kind: "ready" });
  r.simState("running", 16);
  r.fromWindow({ kind: "keys", bytes: bytes("hi") });
  assert.deepEqual(r.tb.screenOf("c9").lines, ["hi"]);
  r.fromWindow({ kind: "clear" });
  assert.deepEqual(r.tb.screenOf("c9").lines, [""]);
});

test("an adapter taken off the desk tells its window so", () => {
  const r = rig();
  r.tb.open("c9");
  r.fromWindow({ kind: "ready" });
  r.comps.delete("c9");
  window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  const state = r.sent.filter(([, m]) => m.kind === "state").at(-1)[1];
  assert.equal(state.present, false);
});

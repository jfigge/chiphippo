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
// Unit tests for model/signal-keys.js — the bare-digit held set (Feature 370).
//
// The point of this module is that SEVERAL signals can be down at once, and
// that a key which went down can never fail to come up. Both are tested here
// rather than through the DOM, because the module is deliberately pure.

import test from "node:test";
import assert from "node:assert/strict";

import { createSignalKeys } from "../model/signal-keys.js";
import { MAX_SIGNALS, SIGNAL_KEYS } from "../model/signals.js";

function harness({
  running = true,
  signals = [{ id: "sig1" }, { id: "sig2" }, { id: "sig3" }],
} = {}) {
  const log = [];
  const state = { running, signals };
  const keys = createSignalKeys({
    isRunning: () => state.running,
    signalsOf: () => state.signals,
    press: (id, on) => log.push(`${id}:${on ? "down" : "up"}`),
  });
  return { keys, log, state };
}

const down = (key, extra = {}) => ({ key, repeat: false, ...extra });

test("several digits are held at once, and each releases on its own", () => {
  const { keys, log } = harness();
  assert.equal(keys.handleKeyDown(down("1")), true);
  assert.equal(keys.handleKeyDown(down("3")), true);
  assert.deepEqual(keys.heldKeys, ["1", "3"]);
  assert.deepEqual(log, ["sig1:down", "sig3:down"]);
  keys.handleKeyUp({ key: "1" });
  assert.deepEqual(keys.heldKeys, ["3"]);
  assert.deepEqual(log, ["sig1:down", "sig3:down", "sig1:up"]);
});

test("auto-repeat is swallowed, never re-fired", () => {
  const { keys, log } = harness();
  keys.handleKeyDown(down("1"));
  assert.equal(
    keys.handleKeyDown({ key: "1", repeat: true }),
    true,
    "consumed",
  );
  assert.equal(
    keys.handleKeyDown(down("1")),
    true,
    "still consumed while held",
  );
  assert.deepEqual(log, ["sig1:down"], "pressed exactly once");
});

test("a modifier chord is not ours — Shift included", () => {
  const { keys, log } = harness();
  for (const mod of ["metaKey", "ctrlKey", "altKey", "shiftKey"]) {
    assert.equal(keys.handleKeyDown(down("1", { [mod]: true })), false, mod);
  }
  assert.deepEqual(log, []);
});

test("a digit with no button behind it is not consumed", () => {
  const { keys, log } = harness(); // three signals
  assert.equal(keys.handleKeyDown(down("6")), false);
  assert.deepEqual(log, []);
});

test("while stopped the digits belong to the wire/bus tools", () => {
  const { keys, log } = harness({ running: false });
  assert.equal(keys.handleKeyDown(down("1")), false);
  assert.deepEqual(log, []);
});

test("keyup is gated on NOTHING — a stuck signal is the worst outcome", () => {
  const { keys, log, state } = harness();
  keys.handleKeyDown(down("2"));
  // The run ended, a dialog opened, a modifier went down after the digit —
  // none of it may stop the release.
  state.running = false;
  assert.equal(keys.handleKeyUp({ key: "2", metaKey: true }), true);
  assert.deepEqual(log, ["sig2:down", "sig2:up"]);
  assert.deepEqual(keys.heldKeys, []);
});

test("a release reaches the signal that was PRESSED, not the digit's current one", () => {
  const { keys, log, state } = harness();
  keys.handleKeyDown(down("2")); // sig2
  // The rail changed underneath: deleting sig1 renumbers the digits, so digit 2
  // now names sig3. The release must still let go of sig2.
  state.signals = [{ id: "sig2" }, { id: "sig3" }];
  keys.handleKeyUp({ key: "2" });
  assert.deepEqual(log, ["sig2:down", "sig2:up"]);
});

test("releaseAll lets go of everything (window blur, transport stop)", () => {
  const { keys, log } = harness();
  keys.handleKeyDown(down("1"));
  keys.handleKeyDown(down("2"));
  keys.releaseAll();
  assert.deepEqual(log, ["sig1:down", "sig2:down", "sig1:up", "sig2:up"]);
  assert.deepEqual(keys.heldKeys, []);
  keys.releaseAll(); // idempotent
  assert.equal(log.length, 4);
});

test("the key range stops where the signals do", () => {
  // A key with no button behind it must not be swallowed from whatever else
  // wants it — `0` included, which names the tenth signal only.
  const { keys } = harness();
  assert.equal(keys.handleKeyDown(down("3")), true, "the last");
  assert.equal(keys.handleKeyDown(down("4")), false, "past the end");
  assert.equal(keys.handleKeyDown(down("0")), false, "no tenth signal yet");
});

test("0 presses the TENTH signal, and releases it", () => {
  const { keys, log } = harness({
    signals: Array.from({ length: MAX_SIGNALS }, (_, i) => ({ id: `sig${i + 1}` })), // prettier-ignore
  });
  assert.equal(SIGNAL_KEYS.at(-1), "0");
  assert.equal(keys.handleKeyDown(down("0")), true);
  assert.equal(keys.handleKeyDown(down("9")), true);
  assert.deepEqual(keys.heldKeys, ["9", "0"], "digit-row order");
  keys.handleKeyUp({ key: "0" });
  assert.deepEqual(log, ["sig10:down", "sig9:down", "sig10:up"]);
});

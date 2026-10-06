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

// The chip designer window's host side (components/chip-design-bridge.js):
// which designs are open as tabs, and the window's three moments the user
// never asks for — a breakpoint brings it up, a run's end leaves the chips it
// was debugging open as designs, and a click on the desk only changes its tab.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { newCustomChip } from "../model/custom-chip.js";
import { setCustomChips } from "../catalog/index.js";

const { ChipDesignBridge } =
  await import("../components/chip-design-bridge.js");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A bridge over fakes: the IPC calls it makes, and the debugger it drives. */
function harness() {
  resetDom();
  const chip = newCustomChip([]);
  setCustomChips([chip]);
  const calls = { open: 0, sent: [], focused: [], breakpoints: [], armed: [] };
  const bridge = {
    chipDesign: {
      open: () => {
        calls.open += 1;
        return Promise.resolve(true);
      },
      toWindow: (msg) => {
        calls.sent.push(msg);
        return Promise.resolve(true);
      },
    },
  };
  const workspace = {
    customChips: [chip],
    customChipUses: () => 1,
    putCustomChip: () => ({ ok: true }),
  };
  const chipDebug = {
    state: { running: false, paused: false, tabs: [], focus: null },
    refOf: (id) => (id === "c1" || id === "c2" ? chip.id : null),
    instancesOf: (ref) => (ref === chip.id ? ["c1", "c2"] : []),
    focusChip: (id) => calls.focused.push(id),
    toggleBreakpoint: (...args) => calls.breakpoints.push(args),
    setArmed: (...args) => calls.armed.push(args),
  };
  const host = new ChipDesignBridge({
    bridge,
    workspace: () => workspace,
    chipDebug,
    notifications: { notify() {} },
  });
  const debug = (detail) =>
    window.dispatchEvent(new CustomEvent("chiphippo:chip-debug", { detail }));
  const fromWindow = (msg) =>
    window.dispatchEvent(
      new CustomEvent("chiphippo:chipdesign-host-inbound", { detail: msg }),
    );
  const lastState = () => calls.sent.filter((m) => m.kind === "state").at(-1);
  return { chip, calls, host, debug, fromWindow, lastState };
}

test("a host that starts over asks the window to announce itself", () => {
  const { calls } = harness();
  assert.deepEqual(calls.sent[0], { kind: "hello" });
});

test("selecting a chip on the desk changes the tab, never raises the window", async () => {
  const { chip, calls, host, fromWindow, lastState } = harness();
  fromWindow({ kind: "ready" });
  host.focusComponent("c1");
  await tick();
  assert.equal(calls.open, 0);
  assert.deepEqual(lastState().open, [chip.id]);
  assert.equal(lastState().focus, chip.id);
});

test("selecting does nothing while no window is there to show it", async () => {
  const { calls, host } = harness();
  host.focusComponent("c1");
  await tick();
  assert.equal(calls.open, 0);
  assert.equal(calls.sent.filter((m) => m.kind === "state").length, 0);
});

test("a breakpoint brings the window up — once per pause, not per step", () => {
  const { calls, debug } = harness();
  const running = { running: true, tabs: [], focus: null };
  debug({ ...running, paused: false });
  assert.equal(calls.open, 0);
  debug({ ...running, paused: true });
  assert.equal(calls.open, 1);
  debug({ ...running, paused: true }); // a step inside the pause
  assert.equal(calls.open, 1);
  debug({ ...running, paused: false });
  debug({ ...running, paused: true }); // the next breakpoint
  assert.equal(calls.open, 2);
});

test("a run's end leaves the debugged chips open as designs", async () => {
  const { chip, debug, fromWindow, lastState } = harness();
  fromWindow({ kind: "ready" });
  const tab = (compId) => ({ compId, ref: chip.id });
  debug({ running: true, paused: false, tabs: [tab("c1"), tab("c2")], focus: "c2" }); // prettier-ignore
  debug({ running: false, paused: false, tabs: [], focus: null });
  await tick();
  const state = lastState();
  assert.equal(state.mode, "design");
  assert.deepEqual(state.open, [chip.id], "two instances, one design");
  assert.equal(state.focus, chip.id);
});

test("Run with a design on screen shows that chip's first instance", () => {
  const { chip, calls, host, debug, fromWindow } = harness();
  fromWindow({ kind: "ready" });
  host.openDesign(chip.id);
  debug({ running: true, paused: false, tabs: [], focus: null });
  assert.deepEqual(calls.focused, ["c1"]);
});

test("Run with no window open focuses nothing", () => {
  const { calls, debug } = harness();
  debug({ running: true, paused: false, tabs: [], focus: null });
  assert.deepEqual(calls.focused, []);
});

test("a line number clicked in the window is a breakpoint on the design", () => {
  const { chip, calls, fromWindow } = harness();
  fromWindow({ kind: "breakpoint", ref: chip.id, line: 4, compId: "c1" });
  fromWindow({ kind: "breakpoint", ref: chip.id, line: 7 });
  fromWindow({ kind: "breakpoint", ref: chip.id, line: "x" }); // not a line
  assert.deepEqual(calls.breakpoints, [
    [chip.id, 4, "c1"],
    [chip.id, 7, null],
  ]);
  // The bar's one toggle is Settled; a pin-change toggle is gone.
  fromWindow({ kind: "arm", compId: "c1", pin: true });
  fromWindow({ kind: "arm", compId: "c1", settled: true });
  assert.deepEqual(calls.armed, [["c1", { settled: true }]]);
});

test("a custom chip's pinout window opens its design", async () => {
  const { chip, calls, lastState, debug, fromWindow } = harness();
  fromWindow({ kind: "ready" });
  const ask = (ref) =>
    window.dispatchEvent(
      new CustomEvent("chiphippo:pinout-host-inbound", {
        detail: { kind: "open-designer", ref },
      }),
    );
  ask("74LS00"); // not a designed chip: nothing to open
  assert.equal(calls.open, 0);
  ask(chip.id);
  await tick();
  assert.equal(calls.open, 1);
  assert.equal(lastState().focus, chip.id);
  // While the circuit runs: its first instance's debugger tab.
  debug({ running: true, paused: false, tabs: [], focus: null });
  ask(chip.id);
  assert.deepEqual(calls.focused.at(-1), "c1");
});

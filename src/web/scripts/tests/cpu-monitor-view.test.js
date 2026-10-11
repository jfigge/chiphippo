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

// cpu-monitor-view.test.js — the CPU monitor window's view
// (components/cpu-monitor-view.js) drawing a real summary, and the main
// renderer's bridge (components/cpu-monitor-bridge.js): which CPU it shows,
// when the simulation is told to build its summary, and what reaches the
// window.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { H, L } from "../sim/levels.js";
import { partDef } from "../catalog/index.js";
import { initialCpu } from "../sim/w65c02.js";
import { cpuOf, cpuSummary, newTrack } from "../sim/cpu-monitor.js";

const { CpuMonitorView } = await import("../components/cpu-monitor-view.js");
const { CpuMonitorBridge, SEND_MS } = await import("../components/cpu-monitor-bridge.js"); // prettier-ignore

/** A W65C02 mid-program: LDA #$42 at $0200 being fetched, Z and C set. */
function summary6502() {
  const mem = new Uint8Array(0x10000);
  mem.set([0xa9, 0x42, 0x8d, 0x10, 0x00], 0x0200);
  const state = {
    ...initialCpu(),
    cur: "instr",
    pc: 0x0200,
    p: 0x20 | 0x02 | 0x01,
    a: 0x11,
    addr: 0x0200,
    rw: "r",
    sync: true,
    log: [],
  };
  const ins = new Map([[37, H], [40, H], [4, H], [6, L], [2, H], [36, H]]); // prettier-ignore
  const track = { ...newTrack(), cycles: 1234, history: [{ pc: 0x01fe, kind: "instr" }] }; // prettier-ignore
  mem.set([0xea], 0x01fe);
  return cpuSummary({
    compId: "c1",
    ref: "W65C02",
    cpu: cpuOf(partDef("W65C02")),
    state,
    ins,
    track,
    read: (a) => (a >= 0x6000 && a < 0x7000 ? null : mem[a]),
  });
}

const CPUS = [{ id: "c1", label: "W65C02 · c1" }];

test("the view draws the summary: memory, pipeline, flags, pins, count", () => {
  resetDom();
  const root = document.createElement("div");
  const view = new CpuMonitorView(root, { send: () => {} });
  view.receive({ kind: "state", cpus: CPUS, compId: "c1", running: true, mode: "running", summary: summary6502() }); // prettier-ignore

  const rows = root.querySelectorAll(".cpumon-mem-row:not(.cpumon-mem-head)");
  assert.equal(rows.length, 16);
  assert.equal(rows[0].querySelector(".cpumon-mem-addr").textContent, "0180");
  const pc = root.querySelector(".cpumon-byte--pc");
  assert.equal(pc.textContent, "A9", "the opcode at PC is marked");
  assert.equal(
    root.querySelectorAll(".cpumon-byte--op").length,
    1,
    "and its operand",
  );

  const lines = root.querySelectorAll(".cpumon-line");
  assert.equal(lines.length, 11, "5 before, the current one, 5 after");
  const current = root.querySelector(".cpumon-line--current");
  assert.equal(
    current.querySelector(".cpumon-line-text").textContent,
    "LDA #$42",
  );
  assert.equal(
    current.querySelector(".cpumon-line-addr").textContent,
    "$0200:",
  );
  assert.equal(current.querySelector(".cpumon-line-mode").textContent, "IMM");
  assert.equal(lines[4].querySelector(".cpumon-line-text").textContent, "NOP", "the recorded one before"); // prettier-ignore

  const on = [...root.querySelectorAll(".cpumon-flag--on")].map((f) => f.textContent); // prettier-ignore
  assert.deepEqual(on, ["-", "Z", "C"]);
  const active = [...root.querySelectorAll(".cpumon-pins .cpumon-pin--active")].map((p) => p.textContent); // prettier-ignore
  assert.ok(active.includes("NMIB"), "NMIB is low: asserted");
  assert.ok(!active.includes("IRQB"));
  assert.equal(root.querySelector(".cpumon-step--on").textContent, "1");
  assert.equal(root.querySelector(".cpumon-count-value").textContent, "1,234");
  assert.equal(root.querySelector(".cpumon-tab-badge").textContent, "Running");
  assert.match(
    root.querySelector(".cpumon-bar-status").textContent,
    /^Running/,
  );
  // The registers, one a line; no buses panel, no cycle table.
  const regs = [...root.querySelectorAll(".cpumon-regs > .cpumon-reg")].map((r) => r.textContent); // prettier-ignore
  assert.deepEqual(regs, ["A11", "X00", "Y00", "S00", "PC0200"]);
  assert.equal(root.querySelector(".cpumon-bus, .cpumon-cycles"), null);
  assert.equal(root.classList.contains("cpumon-root--stale"), false);
});

test("stopped, the last picture stays, marked stale", () => {
  resetDom();
  const root = document.createElement("div");
  const view = new CpuMonitorView(root, { send: () => {} });
  view.receive({ kind: "state", cpus: CPUS, compId: "c1", running: false, mode: "stopped", summary: summary6502() }); // prettier-ignore
  assert.equal(root.classList.contains("cpumon-root--stale"), true);
  assert.equal(root.querySelector(".cpumon-tab-badge"), null, "no run, no badge"); // prettier-ignore
  assert.equal(root.querySelector(".cpumon-bar-status").textContent, "");
  assert.equal(root.querySelectorAll(".cpumon-line").length, 11);
});

test("the empty states say why there is nothing to show", () => {
  resetDom();
  const root = document.createElement("div");
  const view = new CpuMonitorView(root, { send: () => {} });
  view.receive({ kind: "state", cpus: [], compId: null, running: false, mode: "stopped", summary: null }); // prettier-ignore
  assert.equal(root.querySelector(".cpumon-empty").textContent, "There is no CPU on this desktop."); // prettier-ignore
  view.receive({ kind: "state", cpus: CPUS, compId: "c1", running: false, mode: "stopped", summary: null }); // prettier-ignore
  assert.match(root.querySelector(".cpumon-empty").textContent, /Press Run/);
});

test("a tab per CPU; clicking another sends the CPU chosen", () => {
  resetDom();
  const root = document.createElement("div");
  const sent = [];
  const view = new CpuMonitorView(root, { send: (m) => sent.push(m) });
  const cpus = [...CPUS, { id: "c7", label: "Z80A · c7" }];
  const show = (mode) =>
    view.receive({ kind: "state", cpus, compId: "c1", running: mode !== "stopped", mode, summary: null }); // prettier-ignore
  show("paused");
  const tabs = [...root.querySelectorAll(".cpumon-tab-label")];
  assert.deepEqual(tabs.map((b) => b.getAttribute("aria-selected")), ["true", "false"]); // prettier-ignore
  const badge = root.querySelector(".cpumon-tab--active .cpumon-tab-badge");
  assert.equal(badge.textContent, "Paused", "the shown one carries the run's mode"); // prettier-ignore
  assert.ok(badge.classList.contains("cpumon-tab-badge--paused"));
  // The same picture again leaves the tabs alone (a click mid-press survives).
  show("paused");
  assert.equal(root.querySelector(".cpumon-tab-label"), tabs[0]);
  tabs[0].click();
  assert.deepEqual(sent, [], "the one shown already");
  tabs[1].click();
  assert.deepEqual(sent, [{ kind: "select", compId: "c7" }]);
});

// ── The bridge ───────────────────────────────────────────────────────────────

function harness(components, { store, simCalls } = {}) {
  resetDom();
  const toWindow = [];
  let opened = 0;
  const bridge = {
    cpuMonitor: {
      open: () => (opened++, Promise.resolve(true)),
      toWindow: (msg) => (toWindow.push(msg), Promise.resolve(true)),
    },
  };
  const deskDoc = {
    get components() {
      return components;
    },
    getComponent: (id) => components.find((c) => c.id === id) ?? null,
  };
  const watched = [];
  const sim = { monitorCpu: (id) => watched.push(id), ...simCalls };
  let now = 0;
  const pending = [];
  const timers = {
    now: () => now,
    set: (fn, ms) => (pending.push({ fn, at: now + ms }), pending.length),
    clear: () => {},
  };
  const host = new CpuMonitorBridge({ bridge, deskDoc, sim, timers, store });
  const fromWindow = (detail) =>
    window.dispatchEvent(new CustomEvent("chiphippo:cpumonitor-host-inbound", { detail })); // prettier-ignore
  const simState = (detail) =>
    window.dispatchEvent(new CustomEvent("chiphippo:sim-state", { detail }));
  const advance = (ms) => {
    now += ms;
    for (const p of pending.splice(0)) if (p.at <= now) p.fn(); else pending.push(p); // prettier-ignore
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { host, sim, toWindow, watched, fromWindow, simState, advance, tick, opened: () => opened }; // prettier-ignore
}

const chip = (id, ref) => ({ id, kind: "chip", ref, board: "bb1", anchor: "e10", params: {} }); // prettier-ignore

test("the bridge watches a CPU only while the window is open", async () => {
  const h = harness([chip("c2", "74LS00"), chip("c4", "Z80A"), chip("c3", "W65C02")]); // prettier-ignore
  h.toWindow.length = 0; // the constructor's hello
  h.host.focusComponent("c3");
  assert.deepEqual(h.watched, [], "no window: selection does nothing");

  h.fromWindow({ kind: "ready" });
  await h.tick();
  assert.deepEqual(h.watched, ["c3"], "the first CPU by id");
  const first = h.toWindow.at(-1);
  assert.equal(first.kind, "state");
  assert.deepEqual(
    first.cpus.map((c) => c.id),
    ["c3", "c4"],
  );
  assert.equal(first.cpus[1].label, "Z80A · c4");

  h.host.focusComponent("c2");
  assert.deepEqual(h.watched, ["c3"], "not a CPU: ignored");
  h.fromWindow({ kind: "select", compId: "c4" });
  await h.tick();
  assert.deepEqual(h.watched, ["c3", "c4"]);
  assert.equal(h.toWindow.at(-1).compId, "c4");

  h.fromWindow({ kind: "closed" });
  assert.deepEqual(h.watched, ["c3", "c4", null]);
});

test("the bridge forwards the shown CPU's summary, no oftener than SEND_MS", async () => {
  const h = harness([chip("c3", "W65C02")]);
  h.fromWindow({ kind: "ready" });
  await h.tick();
  const sent = h.toWindow.length;
  h.simState({ running: true, mode: "running", cpuMonitor: { compId: "c3", cycles: 1 } }); // prettier-ignore
  h.simState({ running: true, mode: "running", cpuMonitor: { compId: "c3", cycles: 2 } }); // prettier-ignore
  await h.tick();
  assert.equal(h.toWindow.length, sent, "held until SEND_MS has passed");
  h.advance(SEND_MS);
  await h.tick();
  assert.equal(h.toWindow.length, sent + 1, "one trailing send");
  assert.equal(h.toWindow.at(-1).summary.cycles, 2, "with the latest board");

  // Stopped: the last summary stays, no longer running.
  h.advance(SEND_MS);
  h.simState({ running: false, mode: "stopped", cpuMonitor: null });
  await h.tick();
  const last = h.toWindow.at(-1);
  assert.equal(last.running, false);
  assert.equal(last.summary.cycles, 2);
});

test("Open CPU Monitor shows that CPU and opens the window", async () => {
  const h = harness([chip("c3", "W65C02"), chip("c9", "Z80A")]);
  h.host.open("c9");
  assert.equal(h.opened(), 1);
  assert.equal(h.host.compId, "c9");
  h.fromWindow({ kind: "ready" });
  await h.tick();
  assert.deepEqual(h.watched, ["c9"]);
});

// ── Editing and breakpoints ──────────────────────────────────────────────────

function liveView({ running = true, breakpoints = [] } = {}) {
  resetDom();
  const root = document.createElement("div");
  document.body.append(root);
  const sent = [];
  let now = 0;
  const view = new CpuMonitorView(root, { send: (m) => sent.push(m), now: () => now }); // prettier-ignore
  const summary = summary6502();
  const show = (extra = {}) =>
    view.receive({ kind: "state", cpus: CPUS, compId: "c1", running, mode: running ? "paused" : "stopped", summary, breakpoints, ...extra }); // prettier-ignore
  show();
  const cell = (addr) =>
    root.querySelector(`.cpumon-byte[data-addr="${addr}"]`);
  const press = (node, opts = {}) =>
    node.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0, ...opts })); // prettier-ignore
  const key = (k) =>
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); // prettier-ignore
  return {
    root,
    view,
    sent,
    show,
    cell,
    press,
    key,
    advance: (ms) => (now += ms),
  };
}

test("a byte typed over while the run is live is written, and shown at once", () => {
  const v = liveView();
  v.press(v.cell(0x0201));
  assert.ok(v.cell(0x0201).classList.contains("cpumon-byte--selected"));
  v.key("7");
  assert.equal(v.cell(0x0201).textContent, "7_", "the first digit, pending");
  v.key("e");
  assert.deepEqual(v.sent, [{ kind: "poke", compId: "c1", addr: 0x0201, value: 0x7e }]); // prettier-ignore
  assert.equal(
    v.cell(0x0201).textContent,
    "7E",
    "shown before a board says so",
  );
  assert.ok(v.cell(0x0202).classList.contains("cpumon-byte--selected"), "on to the next"); // prettier-ignore
  // A board that still has the old byte does not undo it — for a while.
  v.show();
  assert.equal(v.cell(0x0201).textContent, "7E");
  v.advance(2000);
  v.show();
  assert.equal(v.cell(0x0201).textContent, "42", "then the board wins");
  // Enter writes a lone digit; Escape drops one.
  v.key("4");
  v.key("Enter");
  assert.deepEqual(v.sent.at(-1), { kind: "poke", compId: "c1", addr: 0x0202, value: 0x04 }); // prettier-ignore
  v.key("9");
  v.key("Escape");
  assert.equal(v.sent.length, 2);
});

test("a stopped run cannot be typed over", () => {
  const v = liveView({ running: false });
  v.press(v.cell(0x0200));
  v.key("1");
  v.key("2");
  assert.deepEqual(v.sent, [], "nothing to write into");
});

test("F9, the right-click menu and the line margin set breakpoints; set ones are red", () => {
  const v = liveView();
  v.press(v.cell(0x0200));
  v.key("F9");
  assert.deepEqual(v.sent.at(-1), { kind: "breakpoint", compId: "c1", addr: 0x0200, on: true }); // prettier-ignore
  v.show({ breakpoints: [0x0200] });
  assert.ok(v.cell(0x0200).classList.contains("cpumon-byte--break"), "red");
  const mark = v.root.querySelector(".cpumon-line--current .cpumon-line-mark");
  assert.equal(mark.textContent, "●", "the line at it carries the dot");
  assert.ok(mark.classList.contains("cpumon-line-mark--break"));
  v.press(mark);
  assert.deepEqual(v.sent.at(-1), { kind: "breakpoint", compId: "c1", addr: 0x0200, on: false }); // prettier-ignore

  // The right-click menu: a checked Breakpoint item.
  v.cell(0x0202).dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); // prettier-ignore
  const items = [...document.querySelectorAll(".popup-menu-item")];
  const bp = items.find((b) => b.textContent.trim() === "Breakpoint");
  assert.equal(bp.getAttribute("aria-checked"), "false");
  bp.click();
  assert.deepEqual(v.sent.at(-1), { kind: "breakpoint", compId: "c1", addr: 0x0202, on: true }); // prettier-ignore
});

test("Continue (F8) and Step (F6) — only while paused", () => {
  const v = liveView();
  const btn = (action) => v.root.querySelector(`.cpumon-bar-btn[data-action="${action}"]`); // prettier-ignore
  assert.equal(btn("continue").disabled, false, "paused: offered");
  assert.equal(btn("step").disabled, false);
  assert.equal(v.root.querySelectorAll(".cpumon-bar-btn").length, 2, "no Step Out"); // prettier-ignore
  v.key("F6");
  assert.deepEqual(v.sent, [{ kind: "step", compId: "c1" }], "no byte selected needed"); // prettier-ignore
  v.key("F8");
  assert.deepEqual(v.sent.at(-1), { kind: "continue", compId: "c1" });
  btn("step").click();
  btn("continue").click();
  assert.equal(v.sent.length, 4);
  // A modifier, or a key the window does not use, sends nothing.
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "F6", shiftKey: true, bubbles: true })); // prettier-ignore
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "F8", metaKey: true, bubbles: true })); // prettier-ignore
  v.key("F7");
  assert.equal(v.sent.length, 4);
  // Running or stopped: both greyed out, and their keys with them.
  for (const extra of [{ mode: "running" }, { running: false }]) {
    v.show(extra);
    assert.equal(btn("continue").disabled, true);
    assert.equal(btn("step").disabled, true);
    v.key("F6");
    v.key("F8");
  }
  // Paused with nothing to show yet: Continue, but not Step.
  v.show({ summary: null });
  assert.equal(btn("continue").disabled, false);
  assert.equal(btn("step").disabled, true);
  v.key("F6");
  assert.equal(v.sent.length, 4);
});

test("the bar says where a paused CPU is, and when it is at a breakpoint", () => {
  const v = liveView();
  const status = () => v.root.querySelector(".cpumon-bar-status").textContent;
  assert.equal(status(), "At $0200: LDA #$42");
  v.show({ breakpoints: [0x0200] });
  assert.equal(status(), "At the breakpoint at $0200: LDA #$42");
});

test("the bridge passes Continue and Step on to the sim while paused", async () => {
  const h = harness([chip("c3", "W65C02")]);
  const steps = [];
  let resumed = 0;
  h.sim.stepCpu = (id) => steps.push(id);
  h.sim.resume = () => resumed++;
  h.fromWindow({ kind: "ready" });
  await h.tick();
  h.simState({ running: true, mode: "running", cpuMonitor: null });
  h.fromWindow({ kind: "step", compId: "c3" });
  h.fromWindow({ kind: "continue", compId: "c3" });
  assert.deepEqual(steps, [], "running: nothing to step from");
  assert.equal(resumed, 0, "…or to continue");
  h.simState({ running: true, mode: "paused", cpuMonitor: null });
  h.fromWindow({ kind: "step", compId: "c9" });
  assert.deepEqual(steps, [], "not the CPU shown");
  h.fromWindow({ kind: "step", compId: "c3" });
  assert.deepEqual(steps, ["c3"]);
  h.fromWindow({ kind: "continue", compId: "c3" });
  assert.equal(resumed, 1, "the run's own Resume");
});

test("the bridge keeps the breakpoints, tells the sim, forwards edits while running", async () => {
  const h = harness([chip("c3", "W65C02")]);
  const breaks = [];
  const pokes = [];
  // The sim stand-in grows the two calls this test reads.
  const sim = h.sim;
  sim.setCpuBreakpoints = (id, addrs) => breaks.push([id, addrs]);
  sim.pokeCpuMemory = (id, addr, value) => pokes.push([id, addr, value]);
  h.fromWindow({ kind: "ready" });
  await h.tick();
  h.fromWindow({ kind: "breakpoint", compId: "c3", addr: 0x8005, on: true });
  h.fromWindow({ kind: "breakpoint", compId: "c3", addr: 0x8000, on: true });
  await h.tick();
  assert.deepEqual(breaks.at(-1), ["c3", [0x8000, 0x8005]]);
  assert.deepEqual(h.toWindow.at(-1).breakpoints, [0x8000, 0x8005]);
  h.fromWindow({ kind: "poke", compId: "c3", addr: 0x0010, value: 0x42 });
  assert.deepEqual(pokes, [], "stopped: no run to write into");
  h.simState({ running: true, mode: "paused", cpuMonitor: null });
  h.fromWindow({ kind: "poke", compId: "c3", addr: 0x0010, value: 0x42 });
  assert.deepEqual(pokes, [["c3", 0x0010, 0x42]]);
  // Another document: its c3 is another chip.
  window.dispatchEvent(new CustomEvent("chiphippo:desk-loaded"));
  assert.deepEqual(breaks.at(-1), ["c3", []]);
  assert.deepEqual(h.host.breakpointsOf("c3"), []);
});

test("the breakpoints live in the project: taken up on load, handed back on every change", async () => {
  const comps = [chip("c3", "W65C02"), chip("c4", "74LS00"), chip("c9", "Z80A")]; // prettier-ignore
  // The project's active desktop, as the workspace answers for it.
  let kept = { c3: [0x8021, 0x8005], c4: [1], c7: [2], c9: "junk" };
  const saves = [];
  const told = [];
  const h = harness(comps, {
    store: { load: () => kept, save: (map) => saves.push(map) },
    simCalls: { setCpuBreakpoints: (id, addrs) => told.push([id, addrs]) },
  });
  // Built onto a desktop that has some: only its CPUs' are taken up.
  assert.deepEqual(h.host.breakpointsOf("c3"), [0x8005, 0x8021]);
  assert.deepEqual(h.host.breakpointsOf("c4"), [], "not a CPU");
  assert.deepEqual(told, [["c3", [0x8005, 0x8021]]], "and the sim is told");
  assert.deepEqual(saves, [], "loading is not a change");

  h.fromWindow({ kind: "breakpoint", compId: "c9", addr: 0x0066, on: true });
  assert.deepEqual(saves.at(-1), { c3: [0x8005, 0x8021], c9: [0x0066] });
  h.fromWindow({ kind: "breakpoint", compId: "c3", addr: 0x8021, on: false });
  assert.deepEqual(saves.at(-1), { c3: [0x8005], c9: [0x0066] });

  // A CPU deleted takes its own with it at the next change.
  comps.splice(2, 1);
  h.fromWindow({ kind: "breakpoint", compId: "c3", addr: 0x8000, on: true });
  assert.deepEqual(saves.at(-1), { c3: [0x8000, 0x8005] });

  // Another desktop arrives: the last one's are cleared from the sim, and
  // its own taken up.
  kept = { c3: [0x9000] };
  told.length = 0;
  window.dispatchEvent(new CustomEvent("chiphippo:desk-loaded"));
  assert.deepEqual(told, [
    ["c3", []],
    ["c9", []],
    ["c3", [0x9000]],
  ]);
  assert.deepEqual(h.host.breakpointsOf("c3"), [0x9000]);
});

test("a breakpoint that pauses the run raises the window on its CPU", async () => {
  const h = harness([chip("c3", "W65C02"), chip("c9", "Z80A")]);
  window.dispatchEvent(new CustomEvent("chiphippo:cpu-break", { detail: { compId: "c9", addr: 0x0100, paused: true } })); // prettier-ignore
  assert.equal(h.opened(), 1);
  assert.equal(h.host.compId, "c9");
  // A Step onto one (already paused) does not raise it.
  window.dispatchEvent(new CustomEvent("chiphippo:cpu-break", { detail: { compId: "c3", addr: 0x8000, paused: false } })); // prettier-ignore
  assert.equal(h.opened(), 1);
});

// ── Keeping ROM edits at Stop ────────────────────────────────────────────────

function keepHarness({ keepEdits = false } = {}) {
  resetDom();
  const comps = [
    chip("c1", "W65C02"),
    chip("c2", "AT28C256"), // a ROM
    chip("c3", "HM62256"), // an SRAM
  ];
  const saved = [];
  const persisted = [];
  const toasts = [];
  const toWindow = [];
  const bridge = { cpuMonitor: { open: () => Promise.resolve(true), toWindow: (m) => (toWindow.push(m), Promise.resolve(true)) } }; // prettier-ignore
  const deskDoc = {
    get components() {
      return comps;
    },
    getComponent: (id) => comps.find((c) => c.id === id) ?? null,
  };
  const host = new CpuMonitorBridge({
    bridge,
    deskDoc,
    sim: { monitorCpu() {} },
    keepEdits,
    onKeepEdits: (on) => persisted.push(on),
    saveRom: (id, bytes) => (
      saved.push([id, [...bytes]]),
      Promise.resolve(true)
    ),
    notifications: { notify: (o) => toasts.push(o) },
  });
  const mem = (detail) =>
    window.dispatchEvent(new CustomEvent("chiphippo:mem-state", { detail }));
  const run = () => {
    mem({ running: true, started: true, changes: new Map() });
    // The monitor poked the ROM and the SRAM; the circuit wrote the SRAM.
    mem({ running: true, changes: new Map([["c2", [[5, 0xea]]], ["c3", [[0, 1]]]]) }); // prettier-ignore
  };
  const stop = () =>
    mem({ running: false, images: new Map([["c2", new Uint8Array([0xea])], ["c3", new Uint8Array([1])]]) }); // prettier-ignore
  const fromWindow = (detail) =>
    window.dispatchEvent(new CustomEvent("chiphippo:cpumonitor-host-inbound", { detail })); // prettier-ignore
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { host, saved, persisted, toasts, toWindow, run, stop, fromWindow, tick }; // prettier-ignore
}

test("unticked, ROM edits go with the run", async () => {
  const h = keepHarness();
  h.run();
  h.stop();
  await h.tick();
  assert.deepEqual(h.saved, []);
});

test("the box is offered once a ROM is edited, until Stop — an SRAM edit is not enough", async () => {
  const h = keepHarness();
  const mem = (detail) =>
    window.dispatchEvent(new CustomEvent("chiphippo:mem-state", { detail }));
  h.fromWindow({ kind: "ready" });
  await h.tick();
  assert.equal(h.toWindow.at(-1).romEdited, false);
  mem({ running: true, started: true, changes: new Map() });
  mem({ running: true, changes: new Map([["c3", [[0, 1]]]]) }); // the SRAM
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.toWindow.at(-1).romEdited, false, "RAM is never kept");
  mem({ running: true, changes: new Map([["c2", [[5, 0xea]]]]) }); // the ROM
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.toWindow.at(-1).romEdited, true);
  h.stop();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.toWindow.at(-1).romEdited, false, "Stop has decided it");
});

test("ticked, the ROMs edited during the run are saved at Stop — never an SRAM", async () => {
  const h = keepHarness({ keepEdits: true });
  h.run();
  h.stop();
  await h.tick();
  assert.deepEqual(h.saved, [["c2", [0xea]]]);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].message, /AT28C256 · c2/);
  // The next run starts with nothing edited.
  h.saved.length = 0;
  h.run();
  h.stop();
  await h.tick();
  assert.deepEqual(h.saved, [["c2", [0xea]]], "only what this run edited");
});

test("the window's checkbox sets it, is persisted, and is shown back", async () => {
  const h = keepHarness();
  h.fromWindow({ kind: "ready" });
  await h.tick();
  assert.equal(h.toWindow.at(-1).keepEdits, false);
  h.fromWindow({ kind: "keep-edits", on: true });
  await h.tick();
  assert.deepEqual(h.persisted, [true]);
  assert.equal(h.toWindow.at(-1).keepEdits, true);
  assert.equal(h.host.keepEdits, true);
  // Ticked mid-run: it is read at Stop.
  h.run();
  h.stop();
  await h.tick();
  assert.deepEqual(h.saved, [["c2", [0xea]]]);
});

test("the view's checkbox shows the setting and sends a change", () => {
  const v = liveView();
  const box = v.root.querySelector(".cpumon-keep-box");
  assert.equal(box.closest(".cpumon-keep").hidden, true, "nothing edited yet: not offered"); // prettier-ignore
  v.show({ romEdited: true });
  assert.equal(box.closest(".cpumon-keep").hidden, false, "a ROM edited: offered"); // prettier-ignore
  assert.equal(box.checked, false);
  v.show({ keepEdits: true, romEdited: true });
  assert.equal(box.checked, true);
  box.checked = false;
  box.dispatchEvent(new window.Event("change"));
  assert.deepEqual(v.sent.at(-1), { kind: "keep-edits", on: false });
});

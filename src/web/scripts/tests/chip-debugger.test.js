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

// The chip debugger (the chip designer's debug mode): the pure replay model
// (model/chip-debug.js) and its controller (components/chip-debugger.js)
// driving a REAL SimController over the real engine — put a breakpoint on a
// line of a custom chip's code, and the board stalls on the tick that runs
// it, steps through its Verilog statement by statement, and lets go when the
// replay is done.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { partPinHoles } from "../model/occupancy.js";
import { holesOfNode, nodeOf } from "../model/breadboard.js";
import { newCustomChip } from "../model/custom-chip.js";
import { setCustomChips } from "../catalog/index.js";
import { DebugSession, shiftLines } from "../model/chip-debug.js";
import { powerClocks } from "./clock-power.js";

const { SimController } = await import("../components/sim-controller.js");
const { ChipDebugger } = await import("../components/chip-debugger.js");

let wireSeq = 0;
const wire = (from, to) => ({ id: `w${++wireSeq}`, from, to, color: "black" });
const board = { id: "bb1", type: "pins-full", x: 0, y: 0 };
const mates = (hole) =>
  holesOfNode("pins-full", nodeOf("pins-full", hole)).filter((h) => h !== hole);

/** A NAND custom chip (A=1, B=2 → Y=3) powered, A fed by a manual clock. */
function nandBench(code = "assign Y = ~(A & B);\n", extraChips = []) {
  const chip = { ...newCustomChip([]), code };
  setCustomChips([chip, ...extraChips.map((e) => e.chip)]);
  const holes = new Map(
    partPinHoles(chip.id, "e10").map((p) => [p.pin, p.hole]),
  );
  const s = (pin, i = 0) => `bb1.${mates(holes.get(pin))[i]}`;
  const doc = {
    boards: [board],
    components: [
      {
        id: "psu1",
        kind: "psu",
        ref: "psu",
        x: 80,
        y: 0,
        params: { volts: 5 },
      },
      { id: "clk1", kind: "clock", ref: "clock", x: 90, y: 12, params: { hz: "manual" } }, // prettier-ignore
      { id: "c1", kind: "chip", ref: chip.id, board: "bb1", anchor: "e10", params: {} }, // prettier-ignore
      ...extraChips.map((e) => e.comp),
    ],
    wires: [
      wire("psu1.+", s(14)),
      wire("psu1.-", s(7)),
      wire("clk1.out", s(1)),
      ...extraChips.flatMap((e) => e.wires ?? []),
    ],
  };
  return { chip, doc: powerClocks(doc), s };
}

function fakeDoc(raw) {
  const doc = JSON.parse(JSON.stringify(raw));
  return {
    toJSON: () => doc,
    get components() {
      return doc.components;
    },
    getComponent: (id) => doc.components.find((c) => c.id === id) ?? null,
    setComponentParams(id, patch) {
      const c = doc.components.find((x) => x.id === id);
      c.params = { ...c.params, ...patch };
      return c;
    },
  };
}

const settleTurn = () => new Promise((r) => setTimeout(r, 0));

function rig(raw) {
  resetDom();
  const deskDoc = fakeDoc(raw);
  const debug = new ChipDebugger({ deskDoc });
  const sim = new SimController({ deskDoc, debug });
  debug.setSim(sim);
  const boards = [];
  window.addEventListener("chiphippo:sim-state", (e) => boards.push(e.detail));
  return { sim, debug, boards };
}

test("a breakpoint stalls the tick that runs its line, statement by statement", async () => {
  const { doc, chip } = nandBench();
  const { sim, debug, boards } = rig(doc);
  debug.toggleBreakpoint(chip.id, 1);
  assert.deepEqual(debug.breakpointsOf(chip.id), [1]);
  assert.deepEqual(debug.state.breakpoints, { [chip.id]: [1] });
  sim.start();
  // Time zero: every block runs once, so the chip is paused at its assign.
  assert.equal(sim.stalled, true);
  let st = debug.state;
  assert.equal(st.paused, true);
  assert.equal(st.settled, false);
  assert.deepEqual(st.pausedChips, ["c1"]);
  const tab = st.tabs.find((t) => t.compId === "c1");
  assert.equal(tab.state, "paused");
  assert.equal(tab.loc.line, 1);
  assert.ok(tab.watch.some((r) => r.name === "Y"));
  // Continue runs on to the next pause — a cold start settles from floating
  // nets, so the chip sees its pins change again in the same tick — and,
  // once nothing is left, to the end of the tick: the board publishes.
  const before = boards.length;
  let guard = 0;
  while (debug.state.paused && guard++ < 50) debug.continue();
  await settleTurn();
  st = debug.state;
  assert.equal(st.paused, false);
  assert.equal(st.settled, true);
  assert.equal(sim.stalled, false);
  assert.ok(boards.length > before);
  // A change on pin A (the clock rising) is a new pause …
  sim.manualToggle("clk1");
  assert.equal(sim.stalled, true);
  assert.equal(debug.state.tabs[0].state, "paused");
  // … and stepping its one statement finishes it and releases the board.
  debug.step("c1");
  await settleTurn();
  assert.equal(sim.stalled, false);
  assert.equal(debug.state.tabs[0].state, "idle");
  sim.stop();
  setCustomChips([]);
});

test("no breakpoint, no stall; a breakpoint set mid-run takes a baseline", async () => {
  const { doc, chip } = nandBench();
  const { sim, debug } = rig(doc);
  sim.start();
  assert.equal(sim.stalled, false);
  // Selected before it has a breakpoint, its tab is Detached — nothing would
  // stop it, whether a breakpoint was taken away or never set.
  debug.focusChip("c1");
  assert.equal(debug.state.tabs[0].state, "detached");
  // Set now, the chip's current values are what it is compared with — so a
  // settle that changes nothing on its pins does not stop it.
  debug.toggleBreakpoint(chip.id, 1, "c1");
  assert.equal(debug.state.tabs[0].state, "idle");
  sim.wake();
  assert.equal(sim.stalled, false);
  sim.manualToggle("clk1");
  assert.equal(sim.stalled, true);
  debug.detach("c1");
  await settleTurn();
  assert.equal(sim.stalled, false);
  const tab = debug.state.tabs.find((t) => t.compId === "c1");
  assert.equal(tab.state, "detached");
  assert.deepEqual(debug.armedOf("c1"), { lines: false, settled: false });
  // Detached, it runs freely — the design keeps its breakpoint.
  assert.deepEqual(debug.breakpointsOf(chip.id), [1]);
  sim.manualToggle("clk1");
  assert.equal(sim.stalled, false);
  // A breakpoint set from its tab brings it back.
  debug.toggleBreakpoint(chip.id, 1, "c1");
  debug.toggleBreakpoint(chip.id, 1, "c1");
  assert.deepEqual(debug.armedOf("c1"), { lines: true, settled: false });
  sim.manualToggle("clk1");
  assert.equal(sim.stalled, true);
  sim.stop();
  // Detaching lasts for the run it was made in.
  sim.start();
  assert.equal(sim.stalled, true);
  sim.stop();
  setCustomChips([]);
});

test("break on settled pauses at quiescence with the final board shown", async () => {
  const { doc } = nandBench();
  const { sim, debug } = rig(doc);
  sim.start();
  debug.setArmed("c1", { settled: true });
  sim.manualToggle("clk1");
  assert.equal(sim.stalled, true);
  assert.equal(debug.state.atSettled, true);
  assert.equal(debug.state.settled, true);
  const tab = debug.state.tabs.find((t) => t.compId === "c1");
  assert.equal(tab.waitingAtSettled, true);
  debug.continue();
  await settleTurn();
  assert.equal(sim.stalled, false);
  sim.stop();
  setCustomChips([]);
});

test("To Settled skips the breakpoints and stops at the settled point", async () => {
  const { doc, chip } = nandBench();
  const { sim, debug } = rig(doc);
  debug.toggleBreakpoint(chip.id, 1);
  sim.start();
  assert.equal(debug.state.paused, true);
  debug.toSettled();
  assert.equal(debug.state.atSettled, true);
  assert.equal(sim.stalled, true);
  debug.continue();
  await settleTurn();
  assert.equal(sim.stalled, false);
  sim.stop();
  setCustomChips([]);
});

test("an input event while paused is held, then settled once the board is let go", async () => {
  const { doc, chip } = nandBench();
  const { sim, debug } = rig(doc);
  debug.toggleBreakpoint(chip.id, 1);
  sim.start();
  assert.equal(sim.stalled, true);
  // Toggling the clock while stalled flips its phase but ticks nothing yet.
  sim.manualToggle("clk1");
  assert.equal(debug.state.tabs[0].state, "paused");
  let guard = 0;
  while (debug.state.paused && guard++ < 50) debug.continue();
  await settleTurn();
  // The held tick ran as the stall ended — and it reached the chip, so it is
  // paused again on that change.
  assert.equal(sim.stalled, true);
  debug.continue();
  await settleTurn();
  assert.equal(sim.stalled, false);
  sim.stop();
  setCustomChips([]);
});

test("two input events while paused are two ticks, never merged into none", async () => {
  const { doc, chip } = nandBench();
  const { sim, debug } = rig(doc);
  debug.toggleBreakpoint(chip.id, 1);
  sim.start();
  assert.equal(sim.stalled, true);
  // Up and down again while the board is held. Applied to the live levels
  // at once they would cancel, and the tick after would see no edge at all.
  sim.manualToggle("clk1");
  sim.manualToggle("clk1");
  let stalls = 0;
  for (let round = 0; round < 6; round++) {
    let guard = 0;
    while (debug.state.paused && guard++ < 50) debug.continue();
    await settleTurn();
    if (!sim.stalled) break;
    stalls += 1;
  }
  assert.equal(stalls, 2, "the rise and the fall, each its own tick");
  assert.equal(sim.stalled, false);
  sim.stop();
  setCustomChips([]);
});

test("a clocked chip: the edge block, its non-blocking update, then the reaction", async () => {
  const code = "reg q = 1'b0;\nalways @(posedge A) q <= ~q;\nassign Y = q;\n";
  const { doc, chip } = nandBench(code);
  const { sim, debug } = rig(doc);
  sim.start();
  debug.toggleBreakpoint(chip.id, 2);
  sim.manualToggle("clk1"); // A rises
  // The settle pass reaching A runs no block (nothing combinational reads
  // A), so the first pause is the STEP: the always block. Stepping goes on
  // through the update and into the reaction to it, breakpoint or not.
  let tab = debug.state.tabs[0];
  assert.equal(tab.phase, "edge");
  assert.equal(tab.loc.line, 2);
  debug.step("c1");
  tab = debug.state.tabs[0];
  assert.equal(tab.phase, "nba");
  assert.ok(tab.watch.find((r) => r.name === "q").pending);
  debug.step("c1");
  tab = debug.state.tabs[0];
  assert.equal(tab.phase, "comb");
  assert.equal(tab.loc.line, 3);
  debug.step("c1");
  await settleTurn();
  assert.equal(sim.stalled, false);
  sim.stop();
  setCustomChips([]);
});

test("Stop ends the session and the debugger's tabs", async () => {
  const { doc, chip } = nandBench();
  const { sim, debug } = rig(doc);
  debug.toggleBreakpoint(chip.id, 1);
  sim.start();
  assert.equal(sim.stalled, true);
  sim.stop();
  await settleTurn();
  const st = debug.state;
  assert.equal(st.running, false);
  assert.equal(st.paused, false);
  assert.deepEqual(st.tabs, []);
  // A breakpoint survives a Stop: the next Run stops at time zero again.
  assert.deepEqual(debug.armedOf("c1"), { lines: true, settled: false });
  setCustomChips([]);
});

test("a breakpoint on a line that never runs is kept, and ignored", async () => {
  const { doc, chip } = nandBench("// a NAND\nassign Y = ~(A & B);\n");
  const { sim, debug } = rig(doc);
  debug.toggleBreakpoint(chip.id, 1);
  assert.deepEqual(debug.breakpointsOf(chip.id), [1]);
  assert.deepEqual(debug.armedOf("c1"), { lines: false, settled: false });
  sim.start();
  assert.equal(sim.stalled, false);
  sim.manualToggle("clk1");
  assert.equal(sim.stalled, false);
  sim.stop();
  setCustomChips([]);
});

test("a reaction stops AT its breakpoint, and Continue runs to the next one", async () => {
  const code = [
    "reg t;",
    "always @(*) begin",
    "  t = A & B;",
    "  Y = ~t;",
    "end",
    "",
  ].join("\n");
  const { doc, chip } = nandBench(code);
  const { sim, debug } = rig(doc);
  debug.toggleBreakpoint(chip.id, 4);
  sim.start();
  let tab = debug.state.tabs[0];
  assert.equal(tab.state, "paused");
  assert.equal(
    tab.loc.line,
    4,
    "not the reaction's first statement — its breakpoint",
  );
  assert.deepEqual(tab.progress, { index: 1, count: 2 });
  let guard = 0;
  while (debug.state.paused && guard++ < 50) debug.continue();
  await settleTurn();
  // Two breakpoints in one block: Continue goes from the first to the second
  // without leaving the reaction.
  debug.toggleBreakpoint(chip.id, 3);
  sim.manualToggle("clk1");
  tab = debug.state.tabs[0];
  assert.equal(tab.loc.line, 3);
  debug.continue();
  tab = debug.state.tabs[0];
  assert.equal(tab.state, "paused");
  assert.equal(tab.loc.line, 4);
  debug.continue();
  await settleTurn();
  assert.equal(sim.stalled, false);
  sim.stop();
  setCustomChips([]);
});

test("breakpoints follow their lines through an edit, and go with their design", () => {
  const { doc, chip } = nandBench("assign Y = ~(A & B);\n");
  const { debug } = rig(doc);
  debug.toggleBreakpoint(chip.id, 1);
  const announce = (chips) => {
    setCustomChips(chips);
    window.dispatchEvent(
      new window.CustomEvent("chiphippo:custom-chips-changed", {
        detail: { chips },
      }),
    );
  };
  const edited = { ...chip, code: "// the gate\nassign Y = ~(A & B);\n" };
  announce([edited]);
  assert.deepEqual(debug.breakpointsOf(chip.id), [2]);
  announce([]);
  assert.deepEqual(debug.breakpointsOf(chip.id), []);
  setCustomChips([]);
});

test("shiftLines moves lines below an edit, keeps those above and inside it", () => {
  const ten = Array.from({ length: 10 }, (_v, i) => `line ${i + 1}`);
  const text = (lines) => lines.join("\n");
  const inserted = [...ten.slice(0, 2), "new", ...ten.slice(2)];
  assert.deepEqual(shiftLines(text(ten), text(inserted), [2, 3, 10]), [2, 4, 11]); // prettier-ignore
  const removed = [...ten.slice(0, 2), ...ten.slice(3)];
  assert.deepEqual(shiftLines(text(ten), text(removed), [2, 3, 4, 10]), [2, 3, 9]); // prettier-ignore
  const retyped = ten.map((l, i) => (i === 4 ? "changed" : l));
  assert.deepEqual(shiftLines(text(ten), text(retyped), [5, 6]), [5, 6]);
  // Never past the end of the code.
  assert.deepEqual(shiftLines(text(ten), "one line", [8]), [1]);
});

// ── The pure session ───────────────────────────────────────────────────────

test("a session pauses every chip of a pass at once, and moves on when all finish", () => {
  const frame = (line) => ({ phase: "comb", loc: { line }, vals: [], unit: 0 });
  const rounds = [
    { phase: "settle", levels: new Map([["n", "L"]]), strong: null, evals: [
      { compId: "a", ins: new Map([[1, "L"]]) },
      { compId: "b", ins: new Map([[1, "L"]]) },
    ] },
    { phase: "settle", levels: new Map([["n", "H"]]), strong: new Map(), evals: [
      { compId: "a", ins: new Map([[1, "H"]]) },
      { compId: "b", ins: new Map([[1, "L"]]) },
    ] },
  ]; // prettier-ignore
  const events = [
    { round: 0, compId: "a", frames: [frame(1), frame(2)], units: [] },
    { round: 0, compId: "b", frames: [frame(1)], units: [] },
    { round: 1, compId: "a", frames: [frame(3)], units: [] },
  ];
  const s = new DebugSession({ rounds, events, linesOf: () => new Set([1, 3]) }); // prettier-ignore
  assert.deepEqual(s.chips, ["a", "b"]);
  assert.equal(s.round, 0);
  assert.equal(s.heldOf("a"), 1); // pin 1 reads H next pass
  assert.equal(s.heldOf("b"), 0);
  s.step("b"); // b finishes; a still paused, so the pass stays
  assert.equal(s.round, 0);
  assert.equal(s.isPaused("b"), false);
  s.stepOut("a");
  assert.equal(s.round, 1);
  assert.deepEqual(s.chips, ["a"]);
  assert.equal(s.frameOf("a").loc.line, 3);
  s.step("a");
  assert.equal(s.done, true);
});

test("detach drops a chip's later pauses in the same tick", () => {
  const f = { phase: "comb", loc: { line: 1 }, vals: [], unit: 0 };
  const rounds = [0, 1].map(() => ({ phase: "settle", levels: new Map(), strong: null, evals: [] })); // prettier-ignore
  const s = new DebugSession({
    rounds,
    events: [
      { round: 0, compId: "a", frames: [f], units: [] },
      { round: 1, compId: "a", frames: [f], units: [] },
    ],
    settledFor: ["a"],
    linesOf: () => new Set([1]),
  });
  s.detach("a");
  assert.equal(s.done, true);
});

test("an array's write is pending at the update, and its words are read on demand", async () => {
  const code = [
    "reg [7:0] mem [0:3];", //             1
    "reg [1:0] p = 2'd0;", //              2
    "always @(posedge A) begin", //        3
    "  mem[p] <= 8'h40 + p;", //           4
    "  p <= p + 1;", //                    5
    "end", //                              6
    "wire [7:0] w = mem[0];", //           7
    "assign Y = w[6];", //                 8
  ].join("\n");
  const { doc, chip } = nandBench(code);
  const { sim, debug } = rig(doc);
  sim.start();
  debug.toggleBreakpoint(chip.id, 4);
  sim.manualToggle("clk1"); // A rises
  let tab = debug.state.tabs[0];
  assert.equal(tab.loc.line, 4);
  const row = tab.watch.find((r) => r.name === "mem");
  assert.equal(row.kind, "memory");
  assert.equal(row.value, "[0:3] × 8");
  assert.equal(row.memory.pendingCount, 0);
  debug.step("c1"); // line 5
  debug.step("c1"); // the non-blocking updates
  tab = debug.state.tabs[0];
  assert.equal(tab.phase, "nba");
  const mem = tab.watch.find((r) => r.name === "mem").memory;
  assert.equal(mem.pendingCount, 1);
  assert.deepEqual(mem.pendingWords, [[0, "8'b01000000"]]);
  const range = debug.memoryRange("c1", mem.slot, 0, 4);
  assert.deepEqual(range, { from: 0, words: ["xx", "xx", "xx", "xx"], pending: [[0, "40"]] }); // prettier-ignore
  assert.equal(debug.memoryRange("c1", mem.slot + 99, 0, 4), null);
  while (debug.state.paused) debug.step("c1");
  await settleTurn();
  assert.deepEqual(debug.memoryRange("c1", mem.slot, 0, 2).words, ["40", "xx"]); // prettier-ignore
  sim.stop();
  setCustomChips([]);
});

test("a breakpoint in a loop body stops once per pass, the counter in the watch", async () => {
  const code = [
    "integer i;", //                          1
    "reg [7:0] acc = 8'd0;", //               2
    "always @(posedge A) begin", //           3
    "  for (i = 0; i < 3; i = i + 1)", //     4
    "    acc = acc + i;", //                  5
    "end", //                                 6
    "assign Y = acc[0];", //                  7
  ].join("\n");
  const { doc, chip } = nandBench(code);
  const { sim, debug } = rig(doc);
  sim.start();
  debug.toggleBreakpoint(chip.id, 5);
  sim.manualToggle("clk1");
  const seen = [];
  let guard = 0;
  while (debug.state.paused && guard++ < 10) {
    const tab = debug.state.tabs[0];
    const i = tab.watch.find((r) => r.name === "i");
    assert.equal(i.kind, "integer");
    seen.push([tab.loc.line, i.decimal]);
    debug.continue();
  }
  await settleTurn();
  assert.deepEqual(seen, [
    [5, 0],
    [5, 1],
    [5, 2],
  ]);
  sim.stop();
  setCustomChips([]);
});

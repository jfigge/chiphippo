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

// cpu-monitor.test.js — the CPU monitor's engine half: the address map
// (sim/cpu-memory-map.js) on a decoded 65xx computer, the per-tick record
// and the summary (sim/cpu-monitor.js) over a running program, the Z80's
// summary, and the monitor's Step.
//
// The 65xx bench is the usual minimal computer grown a decode: an 8K ROM at
// $8000 (selected by A15 through a 74LS04) and an 8K RAM below it (selected
// by A15 low), A13/A14 left off so each mirrors through its half. The map
// must find each chip through that logic, never by its ref.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L } from "../sim/levels.js";
import { tick as engineTick, prepareCircuit } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { partDef } from "../catalog/index.js";
import { isCpu } from "../sim/chip-eval.js";
import { CpuMemoryMap } from "../sim/cpu-memory-map.js";
import {
  cpuOf,
  newTrack,
  observeTick,
  cpuSummary,
  STACK_LINES,
} from "../sim/cpu-monitor.js";
import { powerClocks } from "./clock-power.js";
import {
  pinHole,
  boards,
  psu,
  clock,
  chip,
  MEM_A,
  MEM_D,
  z80Doc,
} from "./cpu-fixtures.js";

const CPU_A = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25];
const CPU_D = [33, 32, 31, 30, 29, 28, 27, 26];

/**
 * The decoded 65xx computer. `ramSelect` is the CPU address bit the RAM's
 * /CE hangs on (15: the clean split; 14: overlapping the ROM above $8000
 * and leaving $4000–$7FFF to nothing).
 */
class Computer {
  constructor(rom, { ramSelect = 15 } = {}) {
    const cpu = pinHole("bb1", "pins-full", "W65C02", "e10");
    const romAt = pinHole("bb1", "pins-full", "rom-8k", "e33");
    const ramAt = pinHole("bb1", "pins-full", "ram-8k", "e48");
    const inv = pinHole("bb4", "pins-half", "74LS04", "e5");
    const w = [];
    const push = (from, to) => w.push({ id: `w${w.length}`, from, to });
    let hi = 1;
    let lo = 1;
    const HI = () => `bb2.+${hi++}`;
    const LO = () => `bb3.-${lo++}`;

    push("psu1.+", HI());
    push("psu1.-", LO());
    push("clk1.gnd", LO());
    push(cpu(8), HI());
    push(cpu(21), LO());
    for (const at of [romAt, ramAt]) {
      push(at(28), HI());
      push(at(14), LO());
    }
    push(inv(14), HI());
    push(inv(7), LO());

    for (let i = 0; i < 13; i++) {
      push(cpu(CPU_A[i]), romAt(MEM_A[i]));
      push(cpu(CPU_A[i]), ramAt(MEM_A[i]));
    }
    for (let i = 0; i < 8; i++) {
      push(cpu(CPU_D[i]), romAt(MEM_D[i]));
      push(cpu(CPU_D[i]), ramAt(MEM_D[i]));
    }
    // The decode: A15 → '04 → ROM /CE; RAM /CE straight off an address line.
    push(cpu(25), inv(1));
    push(inv(2), romAt(26));
    push(cpu(CPU_A[ramSelect]), ramAt(26));
    push(romAt(27), LO()); // ROM /OE
    push(ramAt(27), LO()); // RAM /OE
    push(cpu(34), ramAt(20)); // RWB → RAM /WE

    push(cpu(37), "clk1.out");
    for (const p of [40, 36, 2, 4, 6]) push(cpu(p), HI()); // RESB BE RDY IRQB NMIB

    this.doc = powerClocks({
      boards,
      components: [
        psu,
        clock,
        chip("c1", "W65C02", "bb1", "e10"),
        chip("c2", "rom-8k", "bb1", "e33"),
        chip("c3", "ram-8k", "bb1", "e48"),
        chip("c4", "74LS04", "bb4", "e5"),
      ],
      wires: w,
    });
    this.netlist = buildNetlist(this.doc);
    this.context = prepareCircuit(this.doc, this.netlist);
    this.warm = new Map();
    this.state = new Map();
    this.prev = new Map();
    this.ram = new Uint8Array(8192);
    this.images = new Map([
      ["c2", rom],
      ["c3", this.ram],
    ]);
    this.cpu = cpuOf(partDef("W65C02"));
    this.track = newTrack();
    this.phase = L;
  }
  tick(clk) {
    this.phase = clk;
    const r = engineTick({
      document: this.doc,
      netlist: this.netlist,
      warmStart: this.warm,
      state: this.state,
      prevPinLevels: this.prev,
      clockPhase: new Map([["clk1", clk]]),
      images: this.images,
      context: this.context,
    });
    this.warm = r.netLevels;
    this.state = r.state;
    this.prev = r.pinLevels;
    for (const { compId, addr, value } of r.memWrites) {
      this.images.get(compId)[addr] = value;
    }
    observeTick(this.track, this.cpu, this.state.get("c1"), this.prev.get("c1")); // prettier-ignore
  }
  clock(n = 1) {
    for (let i = 0; i < n; i++) {
      this.tick(H);
      this.tick(L);
    }
  }
  reader(map = new CpuMemoryMap()) {
    return map.reader({
      cpuId: "c1",
      cpu: this.cpu,
      doc: this.doc,
      netlist: this.netlist,
      context: this.context,
      state: this.state,
      warm: this.warm,
      clockPhase: new Map([["clk1", this.phase]]),
      images: this.images,
    });
  }
  summary(read = this.reader()) {
    return cpuSummary({
      compId: "c1",
      ref: "W65C02",
      cpu: this.cpu,
      state: this.state.get("c1"),
      ins: this.prev.get("c1"),
      track: this.track,
      read,
    });
  }
}

/** $8000: LDA #$42 ; STA $0010 ; INX ; JMP $8005 — reset vector → $8000. */
function program() {
  const rom = new Uint8Array(8192);
  rom.set([0xa9, 0x42, 0x8d, 0x10, 0x00, 0xe8, 0x4c, 0x05, 0x80], 0);
  rom[0x1ffc] = 0x00;
  rom[0x1ffd] = 0x80;
  return rom;
}

test("the CPUs carry a monitor descriptor; nothing else does", () => {
  assert.equal(isCpu(partDef("W65C02")), true);
  assert.equal(isCpu(partDef("Z80A")), true);
  assert.equal(isCpu(partDef("rom-8k")), false);
  assert.equal(isCpu(partDef("74LS04")), false);
});

test("the address map reads each chip through the decode logic", () => {
  const rom = program();
  const pc = new Computer(rom);
  pc.clock(2);
  pc.ram[0x0010] = 0x5a;
  pc.ram[0x1fff] = 0xa5;
  const read = pc.reader();
  assert.equal(read(0x8000), 0xa9, "ROM at $8000");
  assert.equal(read(0x8001), 0x42);
  assert.equal(read(0xfffc), 0x00, "the reset vector, through the mirror");
  assert.equal(read(0xfffd), 0x80);
  assert.equal(read(0xa000), 0xa9, "A13 is not wired: the ROM mirrors");
  assert.equal(read(0x0010), 0x5a, "RAM below $8000");
  assert.equal(read(0x2010), 0x5a, "and mirrors too");
  assert.equal(read(0x7fff), 0xa5);
  // The image is read live: a write after the page was resolved shows.
  pc.ram[0x0011] = 0x77;
  assert.equal(read(0x0011), 0x77);
});

test("a page no chip answers, or two do, reads as unknown", () => {
  const pc = new Computer(program(), { ramSelect: 14 });
  pc.clock(2);
  const read = pc.reader();
  assert.equal(read(0x4000), null, "$4000–$7FFF: nothing selected");
  assert.equal(read(0x8000), null, "$8000–$BFFF: ROM and RAM both selected");
  assert.equal(read(0xc000), 0xa9, "$C000–: the ROM alone");
  assert.equal(read(0x0000), 0x00, "below $4000: the RAM alone");
});

test("the record follows the program: cycles and history", () => {
  const pc = new Computer(program());
  pc.clock(20);
  const t = pc.track;
  assert.equal(t.cycles, 20, "one bus cycle per PHI2 falling edge");
  assert.equal(pc.ram[0x0010], 0x42, "the program ran");
  const pcs = t.history.filter((h) => h.kind === "instr").map((h) => h.pc);
  // The loop: INX at $8005 and JMP at $8006, over and over.
  assert.ok(pcs.includes(0x8005) && pcs.includes(0x8006), pcs.map((p) => p.toString(16)).join(" ")); // prettier-ignore
});

test("the summary: pipeline, memory block, registers", () => {
  const pc = new Computer(program());
  // Reset (7 cycles), LDA (2), STA (4: fetch, two operands, the write).
  pc.clock(9);
  let s = pc.summary();
  assert.equal(s.kind, "w65c02");
  assert.equal(s.pc, 0x8002, "STA is in flight");
  assert.equal(s.pipeline.current.text, "STA $0010");
  assert.equal(s.pipeline.current.mode, "ABS");
  assert.deepEqual(
    s.pipeline.previous.map((l) => (l.kind === "instr" ? l.text : l.kind)),
    ["reset", "LDA #$42"],
  );
  assert.deepEqual(
    s.pipeline.ahead.map((l) => l.text),
    ["INX", "JMP $8005", "BRK", "BRK", "BRK"],
  );
  assert.equal(s.memory.base, 0x7f80, "PC's row in the middle of sixteen");
  assert.equal(s.memory.bytes.length, 256);
  assert.equal(s.memory.bytes[0x80], 0xa9, "$8000 is the LDA");
  assert.equal(s.view.registers.find((r) => r.name === "A").value, 0x42);
  assert.equal(s.view.status, "running");
  assert.equal(s.view.step.index, 1, "the opcode fetch");
  assert.deepEqual(s.view.access, { addr: 0x8002, write: false });

  // Through the two operand reads to the write.
  pc.clock(3);
  s = pc.summary();
  assert.equal(s.view.step.index, 4);
  assert.deepEqual(s.view.access, { addr: 0x0010, write: true });
  // Live registers: PC is past the operand bytes, though STA is in flight.
  assert.equal(s.pc, 0x8002);
  assert.equal(s.view.registers.find((r) => r.name === "PC").value, 0x8005);
});

test("in reset, the pipeline runs ahead from the reset vector", () => {
  const pc = new Computer(program());
  pc.tick(H);
  const s = pc.summary();
  assert.equal(s.op, "reset");
  assert.equal(s.pipeline.current.kind, "reset");
  assert.equal(s.pipeline.ahead[0].addr, 0x8000);
  assert.equal(s.pipeline.ahead[0].text, "LDA #$42");
});

// ── Z80: real M-cycles ───────────────────────────────────────────────────────
// A Z80A + 8K RAM wired as engine-z80.test.js wires it: /MREQ → /CE, /RD →
// /OE, /WR → /WE, A0–A12 only (the RAM mirrors).

class Z80Computer {
  constructor(ram) {
    this.doc = z80Doc();
    this.netlist = buildNetlist(this.doc);
    this.context = prepareCircuit(this.doc, this.netlist);
    this.warm = new Map();
    this.state = new Map();
    this.prev = new Map();
    this.images = new Map([["c2", ram]]);
    this.cpu = cpuOf(partDef("Z80A"));
    this.track = newTrack();
    this.phase = L;
  }
}
Z80Computer.prototype.tick = Computer.prototype.tick;
Z80Computer.prototype.clock = Computer.prototype.clock;
Z80Computer.prototype.reader = Computer.prototype.reader;

test("Z80: the pipeline, the step and the map through /MREQ", () => {
  const ram = new Uint8Array(8192);
  // LD A,$42 ; LD ($0600),A ; HALT
  ram.set([0x3e, 0x42, 0x32, 0x00, 0x06, 0x76], 0);
  const z = new Z80Computer(ram);
  // Clock until LD ($0600),A is writing.
  let s = null;
  for (let i = 0; i < 60; i++) {
    z.clock(1);
    const st = z.state.get("c1");
    if (st.mk === "WRITE") break;
  }
  const read = z.reader();
  assert.equal(read(0x0000), 0x3e, "RAM through /MREQ and /RD");
  assert.equal(read(0x2001), 0x42, "mirrored");
  s = cpuSummary({
    compId: "c1",
    ref: "Z80A",
    cpu: z.cpu,
    state: z.state.get("c1"),
    ins: z.prev.get("c1"),
    track: z.track,
    read,
  });
  assert.equal(s.kind, "z80");
  assert.equal(s.pipeline.current.text, "LD ($0600),A");
  assert.deepEqual(s.pipeline.previous.map((l) => l.text || l.kind), ["reset", "LD A,$42"]); // prettier-ignore
  assert.equal(s.pipeline.ahead[0].text, "HALT");
  assert.deepEqual(s.view.access, { addr: 0x0600, write: true });
  assert.equal(s.view.step.index, 4);
  assert.match(s.view.step.label, /^WRITE T\d$/);
  assert.ok(s.cycles > 0);
  // The registers are LIVE: the core still holds the instruction's starting
  // ones (PC $0002), but the three bytes are fetched and R has counted the M1.
  const reg = (name) => s.view.registers.find((r) => r.name === name).value;
  assert.equal(z.state.get("c1").pc, 0x0002);
  assert.equal(reg("PC"), 0x0005);
  assert.equal(reg("R"), (z.state.get("c1").r + 1) & 0x7f);
  assert.equal(s.pc, 0x0002, "the pipeline and breakpoints keep the start");
});

test("SimController: the shown CPU's summary rides every sim-state", async () => {
  const { resetDom } = await import("./jsdom-setup.js");
  const { SimController } = await import("../components/sim-controller.js");
  resetDom();
  const doc = z80Doc(); // its RAM reads 0: a program of NOPs
  const deskDoc = {
    toJSON: () => doc,
    getComponent: (id) => doc.components.find((c) => c.id === id) ?? null,
    setComponentParams: () => null,
  };
  const sim = new SimController({ deskDoc, notifications: { notify() {}, dismiss() {} } }); // prettier-ignore
  const events = [];
  window.addEventListener("chiphippo:sim-state", (e) => events.push(e.detail));

  await sim.start();
  assert.equal(events.at(-1).cpuMonitor, null, "no CPU shown");
  for (let i = 0; i < 8; i++) sim.manualToggle("clk1");
  sim.monitorCpu("c1");
  const shown = events.at(-1).cpuMonitor;
  assert.equal(shown?.compId, "c1", "shown at once, without a tick");
  assert.equal(shown.ref, "Z80A");
  assert.equal(shown.cycles, 4, "recorded before it was shown: 4 rising edges");
  assert.equal(shown.pipeline.current.text, "NOP");

  sim.manualToggle("clk1");
  sim.manualToggle("clk1");
  assert.equal(events.at(-1).cpuMonitor.cycles, 5);

  sim.monitorCpu(null);
  assert.equal(events.at(-1).cpuMonitor, null);
  sim.monitorCpu("c1");
  sim.stop();
  assert.equal(events.at(-1).cpuMonitor, null, "stopped: nothing to show");
});

test("pokeWord writes the CPU's bits into the chip's word, and no others", async () => {
  const { pokeWord } = await import("../sim/cpu-memory-map.js");
  const straight = { fromPin: [0, 1, 2, 3, 4, 5, 6, 7] };
  assert.equal(pokeWord(straight, 0x00, 0xa5), 0xa5);
  // A 16-bit chip whose high byte is the CPU's: the low byte is kept.
  const high = { fromPin: [8, 9, 10, 11, 12, 13, 14, 15] };
  assert.equal(pokeWord(high, 0x1234, 0xff), 0xff34);
  // A scrambled data bus: CPU bit 0 on the chip's pin index 7, and so on.
  const reversed = { fromPin: [7, 6, 5, 4, 3, 2, 1, 0] };
  assert.equal(pokeWord(reversed, 0, 0x01), 0x80);
});

test("the address map locates where an edit lands, through the decode", () => {
  const pc = new Computer(program());
  pc.clock(2);
  const map = new CpuMemoryMap();
  const env = {
    cpuId: "c1",
    cpu: pc.cpu,
    doc: pc.doc,
    netlist: pc.netlist,
    context: pc.context,
    state: pc.state,
    warm: pc.warm,
    clockPhase: new Map([["clk1", pc.phase]]),
    images: pc.images,
  };
  assert.deepEqual(
    { ...map.locate(env, 0xa005), fromPin: undefined },
    { compId: "c2", offset: 0x0005, fromPin: undefined },
    "the ROM, through its mirror",
  );
  assert.equal(map.locate(env, 0x2010).compId, "c3");
  assert.equal(map.locate(env, 0x2010).offset, 0x0010);
});

/** A SimController on the Z80 bench (its RAM reads 0 at Run: NOPs), and
    what it dispatches. */
async function z80Controller({ hz = null, clock = null } = {}) {
  const { resetDom } = await import("./jsdom-setup.js");
  const { SimController } = await import("../components/sim-controller.js");
  resetDom();
  const doc = z80Doc();
  // A free-running clock instead of the manual one (a copy: the fixture's
  // brick is shared by every document it builds).
  if (hz != null) {
    doc.components = doc.components.map((c) => (c.id === "clk1" ? { ...c, params: { ...c.params, hz } } : c)); // prettier-ignore
  }
  const deskDoc = {
    toJSON: () => doc,
    getComponent: (id) => doc.components.find((c) => c.id === id) ?? null,
    setComponentParams: () => null,
  };
  const modes = [];
  const sim = new SimController({
    deskDoc,
    notifications: { notify() {}, dismiss() {} },
    onTransportChange: (m) => modes.push(m),
    ...(clock ? { clock } : {}),
  });
  const states = [];
  const breaks = [];
  const mem = [];
  window.addEventListener("chiphippo:sim-state", (e) => states.push(e.detail));
  window.addEventListener("chiphippo:cpu-break", (e) => breaks.push(e.detail));
  window.addEventListener("chiphippo:mem-state", (e) => mem.push(e.detail));
  await sim.start();
  return { sim, states, breaks, mem, modes };
}

test("SimController: a breakpoint pauses the run as its instruction begins", async () => {
  const { sim, states, breaks, modes } = await z80Controller();
  sim.monitorCpu("c1");
  sim.setCpuBreakpoints("c1", [0x0003]);
  // A NOP is one 4-T M1: reset, then $0000, $0001, $0002 … two edges per T.
  for (let i = 0; i < 80 && !breaks.length; i++) sim.manualToggle("clk1");
  assert.deepEqual(breaks, [{ compId: "c1", addr: 0x0003, paused: true }]);
  assert.equal(sim.mode, "paused");
  assert.equal(modes.at(-1), "paused");
  const shown = states.at(-1).cpuMonitor;
  assert.equal(shown.pc, 0x0003, "stopped AT the instruction");
  assert.equal(shown.view.step.index, 1, "before any of it ran");
  assert.match(shown.view.step.label, /^M1 T1$/, "its opcode fetch");
  assert.equal(states.at(-1).mode, "paused");

  // Going on from there does not hit it again until it comes round.
  for (let i = 0; i < 16; i++) sim.manualToggle("clk1");
  assert.equal(breaks.length, 1);
  assert.ok(states.at(-1).cpuMonitor.pc > 0x0003);

  sim.setCpuBreakpoints("c1", []);
  sim.stop();
});

test("SimController: the monitor's Step runs to the CPU's next operation and pauses there", async () => {
  const { sim, states, breaks } = await z80Controller({ hz: 1 });
  sim.pause();
  sim.monitorCpu("c1");
  sim.setCpuBreakpoints("c1", [0x0003]);
  for (let i = 0; i < 80 && !breaks.length; i++) sim.step();
  assert.deepEqual(breaks, [{ compId: "c1", addr: 0x0003, paused: false }]);
  assert.equal(states.at(-1).cpuMonitor.pc, 0x0003);

  const told = states.length;
  assert.equal(sim.stepCpu("c1"), true);
  assert.equal(states.length, told + 1, "the views are told once, at the end");
  const shown = states.at(-1).cpuMonitor;
  assert.equal(shown.pc, 0x0004, "the next NOP, as it begins");
  assert.equal(shown.view.step.index, 1, "before any of it ran");
  assert.match(shown.view.step.label, /^M1 T1$/, "its opcode fetch");
  assert.equal(states.at(-1).mode, "paused");
  assert.equal(sim.mode, "paused");
  assert.equal(sim.stepCpu("c1"), true);
  assert.equal(states.at(-1).cpuMonitor.pc, 0x0005);

  // Not a CPU, or not paused: nothing.
  assert.equal(sim.stepCpu("c2"), false);
  sim.resume();
  assert.equal(sim.stepCpu("c1"), false);
  sim.setCpuBreakpoints("c1", []);
  sim.stop();
});

test("SimController: a breakpoint the monitor's Step lands on is reported", async () => {
  const { sim, states, breaks } = await z80Controller({ hz: 1 });
  sim.pause();
  sim.monitorCpu("c1");
  for (let i = 0; i < 80 && states.at(-1).cpuMonitor?.pc !== 0x0002; i++) sim.step(); // prettier-ignore
  sim.setCpuBreakpoints("c1", [0x0003]);
  assert.equal(sim.stepCpu("c1"), true);
  assert.deepEqual(breaks, [{ compId: "c1", addr: 0x0003, paused: false }]);
  assert.equal(states.at(-1).cpuMonitor.pc, 0x0003);
  sim.setCpuBreakpoints("c1", []);
  sim.stop();
});

test("SimController: with only a manual clock, the monitor's Step has nothing to run", async () => {
  const { sim, states } = await z80Controller();
  sim.monitorCpu("c1");
  for (let i = 0; i < 8; i++) sim.manualToggle("clk1");
  sim.pause();
  const pc = states.at(-1).cpuMonitor.pc;
  assert.equal(sim.stepCpu("c1"), false);
  assert.equal(states.at(-1).cpuMonitor.pc, pc);
  sim.stop();
});

test("SimController: an edit through the monitor lands in the run image", async () => {
  const { sim, states, mem } = await z80Controller();
  sim.monitorCpu("c1");
  for (let i = 0; i < 4; i++) sim.manualToggle("clk1");
  // $2005 mirrors $0005 (A13 is not wired): the edit lands in the RAM there.
  assert.equal(sim.pokeCpuMemory("c1", 0x2005, 0x76), true);
  assert.equal(sim.imageBytesOf("c2")[0x0005], 0x76);
  const changes = mem.at(-1)?.changes?.get("c2");
  assert.deepEqual(changes, [[0x0005, 0x76]], "an open inspector hears of it");
  const shown = states.at(-1).cpuMonitor;
  const at = 0x0005 - shown.memory.base;
  assert.equal(shown.memory.bytes[at], 0x76, "and the monitor shows it");
  sim.stop();
  assert.equal(
    sim.pokeCpuMemory("c1", 0x0005, 0x00),
    false,
    "not while stopped",
  );
});

// ── Where the block is, the stack, the breakpoints' lines ───────────────────

test("the summary: a block gone to, the stack's top, the breakpoints decoded", () => {
  const pc = new Computer(program());
  pc.clock(9); // STA $0010's opcode fetch
  const at = (memAt, breaks = []) =>
    cpuSummary({ compId: "c1", ref: "W65C02", cpu: pc.cpu, state: pc.state.get("c1"), ins: pc.prev.get("c1"), track: pc.track, read: pc.reader(), memAt, breaks }); // prettier-ignore
  let s = at(0x8005, [0x8000, 0x8005]);
  assert.equal(s.memory.base, 0x8000, "the row the address is in");
  assert.equal(s.memory.follow, false);
  assert.equal(s.memory.bytes[5], 0xe8, "INX");
  assert.deepEqual(s.breakLines, [{ addr: 0x8000, text: "LDA #$42" }, { addr: 0x8005, text: "INX" }]); // prettier-ignore
  assert.equal(at(0xfff5).memory.base, 0xff00, "the block stays inside memory");
  assert.equal(at(null).memory.base, 0x7f80, "null: around PC");
  // Reset left S at $FD: two bytes on the stack, to the page's end.
  assert.deepEqual(
    s.stack.entries.map((e) => e.addr),
    [0x01fe, 0x01ff],
  );
  assert.equal(s.stack.width, 1);
  assert.equal(s.pipeline.current.call, false, "STA is not a call");
  assert.equal(s.regsEditable, true, "at its opcode fetch");
  assert.equal(s.io, null, "a 6502 has no I/O space");
  pc.clock(1);
  assert.equal(at(null).regsEditable, false, "an operand read in");
});

test("the descriptors: calls, and register edits only at an instruction's start", async () => {
  const { initialZ80 } = await import("../sim/z80.js");
  const { initialCpu } = await import("../sim/w65c02.js");
  const m6502 = cpuOf(partDef("W65C02"));
  const z80 = cpuOf(partDef("Z80A"));
  assert.equal(m6502.isCall({ bytes: [0x20, 0, 0x30] }), true, "JSR");
  assert.equal(m6502.isCall({ bytes: [0x4c, 0, 0x30] }), false, "JMP");
  for (const op of [0xcd, 0xc4, 0xfc, 0xc7, 0xff]) assert.equal(z80.isCall({ bytes: [op] }), true, op.toString(16)); // prettier-ignore
  for (const op of [0xc3, 0xc9, 0x18, 0x10]) assert.equal(z80.isCall({ bytes: [op] }), false, op.toString(16)); // prettier-ignore

  const start = { ...initialCpu(), cur: "instr", pc: 0x0200, addr: 0x0200, sync: true, log: [] }; // prettier-ignore
  assert.equal(m6502.setRegister(start, "A", 0x7f).a, 0x7f);
  assert.equal(m6502.setRegister(start, "P", 0xff).p, 0xef, "B is not kept, the unused bit is set"); // prettier-ignore
  const moved = m6502.setRegister(start, "PC", 0x3000);
  assert.deepEqual([moved.pc, moved.addr], [0x3000, 0x3000], "the fetch moves with PC"); // prettier-ignore
  assert.equal(m6502.setRegister(start, "A", 0x100), null, "too wide");
  assert.equal(m6502.setRegister(start, "Q", 1), null);
  assert.equal(m6502.setRegister({ ...start, log: [0xa9], sync: false }, "A", 1), null, "mid-instruction"); // prettier-ignore

  const z = { ...initialZ80(), cur: "instr", mk: "M1", t: 1, log: [], pc: 0x10, addr: 0x10 }; // prettier-ignore
  assert.equal(z80.canEdit(z), true);
  const hl = z80.setRegister(z, "HL'", 0x1234);
  assert.deepEqual([hl.h2, hl.l2], [0x12, 0x34]);
  assert.equal(z80.setRegister(z, "IM", 2).im, 2);
  assert.equal(z80.setRegister(z, "IM", 3), null);
  assert.equal(z80.setRegister(z, "IFF1", 1).iff1, 1);
  const r = z80.setRegister({ ...z, i: 0x3f }, "R", 0x05);
  assert.equal(r.rfsh, 0x3f05, "the refresh address is I:R");
  assert.equal(z80.setRegister(z, "PC", 0x0100).addr, 0x0100);
  assert.equal(z80.setRegister({ ...z, t: 2 }, "A", 1), null, "past T1");
  assert.equal(z80.setRegister({ ...z, halted: true }, "PC", 1), null, "a HALT holds PC"); // prettier-ignore
});

test("Z80: what crosses each I/O port is recorded", () => {
  const ram = new Uint8Array(8192);
  // LD A,$5A ; OUT ($10),A ; IN A,($20) ; HALT
  ram.set([0x3e, 0x5a, 0xd3, 0x10, 0xdb, 0x20, 0x76], 0);
  const z = new Z80Computer(ram);
  for (let i = 0; i < 80 && !z.state.get("c1")?.halted; i++) z.clock(1);
  const s = cpuSummary({ compId: "c1", ref: "Z80A", cpu: z.cpu, state: z.state.get("c1"), ins: z.prev.get("c1"), track: z.track, read: z.reader() }); // prettier-ignore
  assert.equal(s.io.length, 2);
  assert.deepEqual(s.io[0], { port: 0x10, in: null, out: 0x5a, last: "out", latest: false }); // prettier-ignore
  assert.equal(s.io[1].port, 0x20);
  assert.equal(s.io[1].last, "in");
  assert.equal(s.io[1].latest, true, "the IN came last");
  assert.equal(typeof s.io[1].in, "number", "whatever the bus floated to");
  assert.equal(s.stack.width, 2, "a Z80's stack is words");
  assert.equal(s.stack.entries.length, STACK_LINES);
});

// ── Step Over and register edits, in the controller ─────────────────────────

/** A wall clock and timer the test drives (sim-controller.test.js's): every
    reading costs `cost` ms, as if the work timed took that long. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  const clock = {
    cost: 0,
    now() {
      const t = now;
      now += clock.cost;
      return t;
    },
    setTimeout(fn, ms) {
      pending.set(++seq, { at: now + Math.max(0, ms), fn });
      return seq;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of pending) {
          if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t];
        }
        if (!due) break;
        pending.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = Math.max(now, end);
    },
  };
  return clock;
}

/**
 * The Z80 bench paused at $0004, on a CALL into a short loop:
 *   $0004 CALL $0020 · $0007 NOP · $0020 LD B,n · $0022 DJNZ $0022 · $0024 RET
 * (n = `loops`, 3 unless a test wants the call to take seconds).
 */
async function atCall({ loops = 3, ...opts } = {}) {
  const z = await z80Controller({ hz: 1000, ...opts });
  const { sim, states, breaks } = z;
  sim.pause();
  sim.monitorCpu("c1");
  const poke = (at, bytes) => bytes.forEach((b, i) => sim.pokeCpuMemory("c1", at + i, b)); // prettier-ignore
  poke(0x0004, [0xcd, 0x20, 0x00, 0x00]);
  poke(0x0020, [0x06, loops, 0x10, 0xfe, 0xc9]);
  sim.setCpuBreakpoints("c1", [0x0004]);
  for (let i = 0; i < 80 && !breaks.length; i++) sim.step();
  assert.equal(states.at(-1).cpuMonitor.pc, 0x0004);
  sim.setCpuBreakpoints("c1", []);
  breaks.length = 0;
  return z;
}

const reg = (s, name) => s.view.registers.find((r) => r.name === name).value;

test("SimController: Step Over runs the call and pauses at the instruction after it", async () => {
  const { sim, states, breaks } = await atCall();
  const at = states.at(-1).cpuMonitor;
  assert.equal(at.pipeline.current.call, true, "CALL: Step Over is offered");
  assert.equal(reg(at, "SP"), 0xffff);
  assert.equal(sim.stepOverCpu("c1"), "done");
  const s = states.at(-1).cpuMonitor;
  assert.equal(s.pc, 0x0007, "the NOP after the CALL, as it begins");
  assert.equal(s.view.step.index, 1);
  assert.equal(reg(s, "SP"), 0xffff, "the stack back where the call found it");
  assert.equal(reg(s, "BC") >> 8, 0, "the loop ran");
  assert.equal(sim.mode, "paused");
  assert.deepEqual(breaks, []);
  assert.equal(s.pipeline.current.call, false);
  assert.equal(sim.stepOverCpu("c1"), false, "not at a call");
  sim.stop();
});

test("SimController: a breakpoint inside the call stops Step Over there", async () => {
  const { sim, states, breaks } = await atCall();
  sim.setCpuBreakpoints("c1", [0x0022]);
  assert.equal(sim.stepOverCpu("c1"), "done");
  assert.equal(states.at(-1).cpuMonitor.pc, 0x0022);
  assert.deepEqual(breaks, [{ compId: "c1", addr: 0x0022, paused: false }]);
  sim.stop();
});

test("SimController: a call that outlasts the budget is handed to the run, which pauses at its return", async () => {
  const clock = fakeClock();
  const { sim, states, breaks, modes } = await atCall({ clock });
  const resumed = [];
  window.addEventListener("chiphippo:cpu-resumed", (e) => resumed.push(e.detail)); // prettier-ignore
  clock.cost = 300; // the edges are slow: the budget runs out at once
  assert.equal(sim.stepOverCpu("c1"), "running");
  clock.cost = 0;
  assert.equal(sim.mode, "running");
  assert.equal(modes.at(-1), "running");
  assert.deepEqual(
    resumed,
    [{ compId: "c1" }],
    "the Worker's host hears of it",
  );
  clock.advance(2000);
  assert.deepEqual(breaks, [{ compId: "c1", addr: 0x0007, over: true, paused: true }]); // prettier-ignore
  assert.equal(sim.mode, "paused");
  assert.equal(states.at(-1).cpuMonitor.pc, 0x0007);
  assert.equal(reg(states.at(-1).cpuMonitor, "SP"), 0xffff);
  sim.stop();
});

test("SimController: Pause cancels a Step Over handed to the run", async () => {
  const clock = fakeClock();
  // 255 loops: seconds of the run, so Pause comes while the call is going.
  const { sim, breaks } = await atCall({ clock, loops: 0xff });
  clock.cost = 300;
  assert.equal(sim.stepOverCpu("c1"), "running");
  clock.cost = 0;
  sim.pause();
  assert.deepEqual(breaks, [], "paused inside the call");
  sim.resume();
  clock.advance(10000);
  assert.deepEqual(breaks, [], "it ran on past the return");
  assert.equal(sim.mode, "running");
  sim.stop();
});

test("SimController: a register edit, paused at an instruction's start", async () => {
  const { sim, states } = await atCall();
  assert.equal(sim.setCpuRegister("c1", "BC", 0x1234), true);
  assert.equal(reg(states.at(-1).cpuMonitor, "BC"), 0x1234);
  // A new PC: the fetch moves there, and the CALL that never ran leaves the
  // record — the instruction there is the one starting now.
  assert.equal(sim.setCpuRegister("c1", "PC", 0x0007), true);
  let s = states.at(-1).cpuMonitor;
  assert.equal(s.pc, 0x0007);
  assert.equal(s.pipeline.current.text, "NOP");
  assert.ok(!s.pipeline.previous.some((l) => l.addr === 0x0004), "no CALL in the record"); // prettier-ignore
  assert.equal(sim.stepCpu("c1"), true);
  s = states.at(-1).cpuMonitor;
  assert.equal(s.pc, 0x0008, "the run went on from there");
  assert.equal(reg(s, "BC"), 0x1234);
  // One edge on, the instruction is under way: no edits.
  sim.step();
  assert.equal(sim.setCpuRegister("c1", "A", 1), false);
  assert.equal(sim.setCpuRegister("c1", "IM", 9), false);
  sim.resume();
  assert.equal(sim.setCpuRegister("c1", "A", 1), false, "not while running");
  sim.stop();
});

test("SimController: the window's block goes where it is sent", async () => {
  const { sim, states } = await atCall();
  sim.monitorCpu("c1", { memAt: 0x0025 });
  assert.equal(states.at(-1).cpuMonitor.memory.base, 0x0020, "shown at once, from its row"); // prettier-ignore
  sim.monitorCpu("c1", null);
  assert.equal(states.at(-1).cpuMonitor.memory.follow, true);
  sim.stop();
});

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

// cpu-monitor.js — the CPU monitor's engine half: what is RECORDED of a CPU
// tick by tick, and the summary the monitor window is shown. PURE and
// DOM-free; generic over the cores through their descriptors
// (sim/cpu-cores.js), so nothing here names a part.
//
// A run's views are told at most every frame, but a CPU's history happens on
// every clock edge, so SimController hands each tick to `observeTick` for
// every CPU on the desk (cheap: a clock level compared, and on a counted edge
// perhaps a history entry). It keeps:
//   · `cycles` — the counted edges since Run: bus cycles on a 6502, T-states
//     on a Z80;
//   · `history` — where each recent operation STARTED, as it happened.
//     Instructions are recorded, never disassembled backwards, which is
//     ambiguous;
//   · `io` — on a core with an I/O space (the Z80), the last byte each port
//     was given by an OUT and gave an IN, and which happened last: an I/O
//     port has no memory to read back, so what crossed it is all there is.
//
// `cpuSummary` builds the window's picture when a board is published: the
// core's view (registers, flags, step, pins), the pipeline — the recorded
// operations before, the one in flight, and the instructions after it decoded
// from memory — 256 bytes of memory (around PC, or wherever the window has
// gone to), the top of the stack and the breakpoints' instructions, all read
// through the address map (sim/cpu-memory-map.js), and the ports.

import { H, L, Z } from "./levels.js";

/** Recorded operations shown before the current one. */
export const HISTORY = 5;
/** Instructions decoded after the current one. */
export const AHEAD = 5;
/** Stack entries listed, from the top (the panel scrolls). */
export const STACK_LINES = 32;
/** Ports shown: the ones used most recently, in port order. */
export const IO_LINES = 6;

/** The CPU descriptor of a def, or null. */
export function cpuOf(def) {
  return def?.logic?.cpu ?? null;
}

/** A fresh record, for a run's start. */
export function newTrack() {
  return { cycles: 0, clock: null, state: null, history: [], io: new Map(), ioSeq: 0 }; // prettier-ignore
}

/** Note a byte crossing an I/O port. */
function noteIo(track, { dir, port, value }) {
  track.io ??= new Map();
  const entry = track.io.get(port) ?? { port, in: null, out: null };
  entry[dir] = value;
  entry.last = dir;
  entry.seq = track.ioSeq = (track.ioSeq ?? 0) + 1;
  track.io.set(port, entry);
}

/** Note an operation starting. */
function noteStart(track, cpu, state, kind) {
  track.history.push({ pc: cpu.pcOf(state), kind });
  if (track.history.length > HISTORY + 1) track.history.shift();
}

/**
 * One tick's view of a CPU: its state and the levels on its input pins as
 * the tick left them. Mutates `track`.
 * @param {object} track - from `newTrack`
 * @param {object} cpu - the core's descriptor
 * @param {object} state - the CPU's state after the tick
 * @param {Map<number, string>} ins - its pin levels after the tick
 * @returns {string|null} the operation a counted edge just STARTED
 *   (`"instr"`, `"irq"`, …), or null — what a breakpoint is tested on
 */
export function observeTick(track, cpu, state, ins) {
  if (!state) return null;
  const level = ins?.get(cpu.clock) ?? Z;
  let started = null;
  if (!track.state) {
    // The first look: an operation that is just starting counts.
    const kind = cpu.startOf(null, state);
    if (kind) noteStart(track, cpu, state, kind);
  } else {
    const was = track.clock;
    const edge =
      cpu.countEdge === "fall"
        ? was === H && level === L
        : was === L && level === H;
    if (edge) {
      track.cycles += 1;
      started = cpu.startOf(track.state, state);
      if (started) noteStart(track, cpu, state, started);
      const io = cpu.ioOf?.(track.state, state);
      if (io) noteIo(track, io);
    }
  }
  track.clock = level;
  track.state = state;
  return started;
}

/** The kind of operation in flight, from the view's status. */
const OPERATION = Object.freeze({
  reset: "reset",
  irq: "irq",
  nmi: "nmi",
  int: "int",
});

/** A pipeline line for an operation that is not an instruction. */
const eventLine = (kind, addr) => ({
  kind,
  addr,
  length: 0,
  bytes: [],
  text: "",
  mode: "",
  illegal: false,
});

/** Where execution goes after a reset or interrupt sequence, or null. */
function vectorTarget(cpu, kind, state, read) {
  const at = cpu.vectorOf?.(kind, state);
  if (at == null) return null;
  if (at.fixed != null) return at.fixed;
  const lo = read(at.vector);
  const hi = read((at.vector + 1) & 0xffff);
  return lo == null || hi == null ? null : lo | (hi << 8);
}

/**
 * The monitor's picture of a CPU.
 * @param {object} opts
 * @param {string} opts.compId
 * @param {string} opts.ref
 * @param {object} opts.cpu - the core's descriptor
 * @param {object} opts.state - its state
 * @param {Map} opts.ins - its pin levels
 * @param {object} opts.track - its record (`observeTick`)
 * @param {(addr: number) => number|null} opts.read - memory, as the CPU sees it
 * @param {number|null} [opts.memAt] - where the memory block starts (a row's
 *   address), or null to follow PC
 * @param {number[]} [opts.breaks] - the CPU's breakpoints, decoded for the
 *   window's list
 */
export function cpuSummary({
  compId,
  ref,
  cpu,
  state,
  ins,
  track,
  read,
  memAt = null,
  breaks = [],
}) {
  // prettier-ignore
  if (!state) return null;
  const view = cpu.view(state, ins);
  const pc = cpu.pcOf(state);
  const op = OPERATION[view.status] ?? "instr";
  const line = (kind, at) =>
    kind === "instr" ? { kind, ...cpu.disassemble(read, at) } : eventLine(kind, at); // prettier-ignore

  const current = line(op, pc);
  if (op === "instr") current.call = cpu.isCall?.(current) === true;
  const history = [...(track?.history ?? [])];
  const last = history.at(-1);
  if (last && last.kind === op && last.pc === pc) history.pop();
  const previous = history.slice(-HISTORY).map((h) => line(h.kind, h.pc));

  const ahead = [];
  let at = op === "instr" ? (pc + current.length) & 0xffff : vectorTarget(cpu, op, state, read); // prettier-ignore
  for (let i = 0; i < AHEAD && at != null; i++) {
    const next = line("instr", at);
    ahead.push(next);
    at = (at + next.length) & 0xffff;
  }

  // 256 bytes: around PC (its row in the middle of sixteen), or from the row
  // the window went to.
  const follow = !Number.isInteger(memAt);
  const base = memBase(follow ? (pc & 0xfff0) - 0x80 : memAt);
  const bytes = [];
  for (let i = 0; i < 256; i++) bytes.push(read(base + i));

  // The stack's top: each entry's address and what is there.
  const top = cpu.stackOf?.(state);
  const stack = top
    ? {
        top: top.top,
        width: top.width,
        entries: Array.from(
          { length: Math.max(0, Math.min(STACK_LINES, top.count)) },
          (_, i) => {
            // prettier-ignore
            const a = (top.top + i * top.width) & 0xffff;
            const lo = read(a);
            if (top.width === 1 || lo == null) return { addr: a, value: lo };
            const hi = read((a + 1) & 0xffff);
            return { addr: a, value: hi == null ? null : lo | (hi << 8) };
          },
        ),
      }
    : null;

  return {
    compId,
    ref,
    kind: cpu.kind,
    cycles: track?.cycles ?? 0,
    countUnit: cpu.countUnit,
    pc,
    op,
    view,
    pipeline: { previous, current, ahead },
    memory: { base, bytes, follow },
    stack,
    io: cpu.ioOf ? portsOf(track) : null,
    breakLines: breaks.map((addr) => ({ addr, text: cpu.disassemble(read, addr).text })), // prettier-ignore
    regsEditable: cpu.canEdit?.(state) === true,
  };
}

/** A memory block's first address: a whole row, the block inside memory. */
export function memBase(addr) {
  return Math.min(0xff00, Math.max(0, Math.trunc(addr))) & 0xfff0;
}

/** The ports used most recently, in port order, the very last one marked. */
function portsOf(track) {
  const all = [...(track?.io?.values() ?? [])];
  const recent = all.sort((a, b) => b.seq - a.seq).slice(0, IO_LINES);
  const latest = recent[0]?.port;
  return recent
    .map(({ port, in: i, out, last }) => ({
      port,
      in: i,
      out,
      last,
      latest: port === latest,
    })) // prettier-ignore
    .sort((a, b) => a.port - b.port);
}

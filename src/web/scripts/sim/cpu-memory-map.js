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

// cpu-memory-map.js — what a CPU would read at an address it has not been
// to yet: the CPU monitor's memory block and the instructions ahead of PC.
// PURE and DOM-free.
//
// A CPU in this app cannot see memory: it reads D0–D7 off the nets, and which
// chip answers is whatever the circuit's own decode logic says ('138s, gates,
// an address line straight to /CE). So the map ASKS the circuit. Per 256-byte
// page, it settles the circuit once with the CPU swapped for a state of the
// core presenting a memory read at the page (the core descriptor's
// `peekState`) and every clock held HIGH (a 65xx RAM is commonly gated on
// PHI2), and looks at which memory chip is then selected and output-enabled.
// That settle is a what-if: nothing is stepped, so a peripheral is never
// clocked and no write is made. The page's last address is settled too, and a
// page two chips (or none) answer, or that changes hands inside itself, reads
// as unknown (null) — an I/O hole, a peripheral, a decode finer than a page.
//
// For the chip that answers, each of its address pins is either on one of the
// CPU's address nets (that bit of the CPU address) or held at a level (a bit
// the decode fixed for the page), and each of the CPU's data bits is on one of
// its data pins; the bytes are then read from the chip's run image, so a
// write the program makes shows at once. A data bus through a buffer, or an
// address pin on neither, is something the map cannot follow, and reads as
// unknown. As a check, the byte the settle put on the CPU's data nets must be
// the one the image gives.
//
// Pages are cached for as long as the document and netlist are the same
// objects (the controller replaces its snapshot on every edit). A bank latch
// the program switches is NOT followed: the page keeps the chip it answered
// with when first read.

import { H, L, Z } from "./levels.js";
import { settle, CHIP_STATUS } from "./engine.js";
import { memoryConfig } from "./chip-eval.js";

/** How one memory chip answers one page: its address bits, data bits and
    image. */
function answerOf(c, levelOf, addrBitOfNet, dataBitOfNet) {
  const m = memoryConfig(c.def);
  const level = (pin) => (pin == null ? Z : levelOf(c.pinNet.get(pin)));
  if (level(m.ceN) !== L || level(m.oeN) !== L) return null;
  if (m.ce2 != null && level(m.ce2) !== H) return null;
  if (m.weN != null && level(m.weN) === L) return null;
  const addrBits = [];
  for (const pin of m.addr) {
    const net = c.pinNet.get(pin);
    const bit = net == null ? undefined : addrBitOfNet.get(net);
    if (bit !== undefined) addrBits.push({ bit });
    else {
      const l = level(pin);
      if (l !== H && l !== L) return { unknown: true };
      addrBits.push({ fixed: l === H ? 1 : 0 });
    }
  }
  // Each of the CPU's eight data bits must come from one of the chip's pins.
  const fromPin = new Array(8).fill(null);
  m.data.forEach((pin, i) => {
    const bit = dataBitOfNet.get(c.pinNet.get(pin));
    if (bit !== undefined && fromPin[bit] == null) fromPin[bit] = i;
  });
  if (fromPin.some((i) => i == null)) return { unknown: true };
  return { compId: c.comp.id, addrBits, fromPin, size: m.size };
}

/** The same chip, read the same way? */
const sameAnswer = (a, b) =>
  a.compId === b.compId &&
  a.addrBits.every((x, i) => x.bit === b.addrBits[i].bit && x.fixed === b.addrBits[i].fixed); // prettier-ignore

/** Where in its chip `answer` puts CPU address `addr`. */
function offsetOf(answer, addr) {
  let offset = 0;
  answer.addrBits.forEach((b, i) => {
    const v = b.bit != null ? (addr >> b.bit) & 1 : b.fixed;
    offset |= v << i;
  });
  return offset & (answer.size - 1);
}

/** The byte `answer` gives at CPU address `addr`, from `images`. */
function readThrough(answer, addr, images) {
  const word = images.get(answer.compId)?.[offsetOf(answer, addr)];
  if (word == null) return null;
  let byte = 0;
  answer.fromPin.forEach((i, bit) => (byte |= ((word >> i) & 1) << bit));
  return byte;
}

/**
 * `word` with the CPU's byte `value` written into the bits its data pins
 * carry (`fromPin`: CPU data bit → the chip's data-pin index), every other
 * bit of a wider word left as it was. Pure.
 * @param {{fromPin: number[]}} where - from `CpuMemoryMap.locate`
 * @param {number} word
 * @param {number} value
 */
export function pokeWord(where, word, value) {
  let out = word;
  where.fromPin.forEach((i, bit) => {
    out = (value >> bit) & 1 ? out | (1 << i) : out & ~(1 << i);
  });
  return out >>> 0;
}

export class CpuMemoryMap {
  #doc = null;
  #netlist = null;
  #cpuId = null;
  #pages = new Map(); // page → answer | null

  /**
   * A reader of CPU addresses for one board, `(addr) => byte | null`.
   * @param {object} env
   * @param {string} env.cpuId - the CPU component
   * @param {object} env.cpu - its descriptor (sim/cpu-cores.js)
   * @param {object} env.doc - the document snapshot the run reads
   * @param {object} env.netlist
   * @param {object} env.context - `prepareCircuit(doc, netlist)`
   * @param {Map} env.state - every part's state, as the last tick left it
   * @param {Map} env.warm - the last tick's net levels
   * @param {Map} [env.clockPhase]
   * @param {Map} [env.signalLevels]
   * @param {Map} env.images - memory compId → its run image
   */
  reader(env) {
    return (addr) => {
      const answer = this.#answer(env, addr);
      return answer ? readThrough(answer, addr & 0xffff, env.images) : null;
    };
  }

  /**
   * Which memory chip answers CPU address `addr`, and where in it — what an
   * edit made through the monitor writes — or null.
   * @param {object} env - as `reader`
   * @param {number} addr
   * @returns {{compId: string, offset: number, fromPin: number[]}|null}
   */
  locate(env, addr) {
    const answer = this.#answer(env, addr);
    if (!answer) return null;
    const offset = offsetOf(answer, addr & 0xffff);
    return { compId: answer.compId, offset, fromPin: answer.fromPin };
  }

  /** The answer for `addr`'s page, resolved once per document + netlist. */
  #answer(env, addr) {
    const same =
      env.doc === this.#doc &&
      env.netlist === this.#netlist &&
      env.cpuId === this.#cpuId;
    if (!same) {
      this.#doc = env.doc;
      this.#netlist = env.netlist;
      this.#cpuId = env.cpuId;
      this.#pages = new Map();
    }
    const page = (addr & 0xffff) >> 8;
    if (!this.#pages.has(page)) this.#pages.set(page, this.#resolve(page, env)); // prettier-ignore
    return this.#pages.get(page);
  }

  /** Forget every page (a new run). */
  clear() {
    this.#doc = null;
    this.#pages = new Map();
  }

  #resolve(page, env) {
    const ctx = env.context;
    const cpuChip = ctx?.chips.find((c) => c.comp.id === env.cpuId);
    if (!cpuChip || cpuChip.status !== CHIP_STATUS.OK) return null;
    const addrBitOfNet = new Map();
    env.cpu.addr.forEach((pin, bit) => {
      const net = cpuChip.pinNet.get(pin);
      if (net != null && !addrBitOfNet.has(net)) addrBitOfNet.set(net, bit);
    });
    const dataBitOfNet = new Map();
    env.cpu.data.forEach((pin, bit) => {
      const net = cpuChip.pinNet.get(pin);
      if (net != null && !dataBitOfNet.has(net)) dataBitOfNet.set(net, bit);
    });
    const first = this.#answerAt(page << 8, env, cpuChip, addrBitOfNet, dataBitOfNet); // prettier-ignore
    if (!first) return null;
    const last = this.#answerAt((page << 8) | 0xff, env, cpuChip, addrBitOfNet, dataBitOfNet); // prettier-ignore
    return last && sameAnswer(first, last) ? first : null;
  }

  /** Settle the board with the CPU reading `addr`: the one chip answering,
      or null. */
  #answerAt(addr, env, cpuChip, addrBitOfNet, dataBitOfNet) {
    const state = new Map(env.state);
    state.set(env.cpuId, env.cpu.peekState(addr));
    const clockPhase = new Map();
    for (const id of env.clockPhase?.keys() ?? []) clockPhase.set(id, H);
    let levels;
    try {
      levels = settle({
        document: env.doc,
        netlist: env.netlist,
        warmStart: env.warm ?? new Map(),
        state,
        clockPhase,
        signalLevels: env.signalLevels ?? new Map(),
        images: env.images,
        context: env.context,
      }).netLevels;
    } catch (err) {
      console.error("[renderer] CPU monitor peek failed:", err);
      return null;
    }
    const levelOf = (net) => (net == null ? Z : (levels.get(net) ?? Z));
    const answers = [];
    for (const c of env.context.chips) {
      if (!c.memory || c.status !== CHIP_STATUS.OK) continue;
      const a = answerOf(c, levelOf, addrBitOfNet, dataBitOfNet);
      if (a) answers.push(a);
    }
    if (answers.length !== 1 || answers[0].unknown) return null;
    const answer = answers[0];
    // The check: the bus carries what the image says it should.
    const want = readThrough(answer, addr, env.images);
    let seen = 0;
    for (let bit = 0; bit < 8; bit++) {
      const l = levelOf(cpuChip.pinNet.get(env.cpu.data[bit]));
      if (l !== H && l !== L) return null;
      if (l === H) seen |= 1 << bit;
    }
    return seen === want ? answer : null;
  }
}

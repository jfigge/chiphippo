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

// w65c02-dormann.test.js — the W65C02 core against Klaus Dormann's functional
// tests (tests/dormann/, provenance in its README): the NMOS instruction set
// with decimal mode, then every 65C02 addition — BBR/BBS, RMB/SMB, TRB/TSB,
// STZ, BRA, the (zp) mode, BIT #, and the undefined opcodes as NOPs of the
// right length. w65c02.test.js holds the cycle counts and bus addresses; this
// holds the RESULTS, exhaustively, which no hand-written program does.
//
// Each image runs on a flat 64 KiB memory, one bus cycle per `cpuCycle`, until
// the program traps itself — an instruction starting at the address the last
// one started at (`JMP *`, `Bxx *`). A pass is the success trap; any other
// trap is the failing check, reported with the test number the program keeps.
// ~67M and ~97M cycles: about 35 s together, so the fast run leaves them out.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { initialCpu, cpuCycle } from "../sim/w65c02.js";
import { FAST, FAST_SKIP } from "./test-depth.js";

const hex = (n, w = 4) => "$" + n.toString(16).toUpperCase().padStart(w, "0");

/**
 * Run a Dormann image to its trap.
 * @param {string} file  the image under tests/dormann/
 * @param {number} limit cycles before giving up (a lost PC never traps)
 * @returns {{trap: number, cycles: number, mem: Uint8Array, state: object}}
 */
function runToTrap(file, limit) {
  const mem = new Uint8Array(readFileSync(new URL(`./dormann/${file}`, import.meta.url))); // prettier-ignore
  assert.equal(mem.length, 0x10000, `${file} is a whole 64 KiB memory`);
  // ROM_vectors = 1 points RESET at a trap; the program itself starts at $0400.
  mem[0xfffc] = 0x00;
  mem[0xfffd] = 0x04;
  const ctl = { reset: false, irq: false, nmi: false, ready: true };
  let state = initialCpu();
  let last = -1;
  for (let cycles = 1; cycles <= limit; cycles++) {
    let busByte = 0;
    if (state.rw === "r") busByte = mem[state.addr];
    else mem[state.addr] = state.dout;
    state = cpuCycle(state, busByte, ctl);
    if (state.cur !== "instr" || !state.sync) continue;
    if (state.addr === last) return { trap: last, cycles, mem, state };
    last = state.addr;
  }
  assert.fail(`${file} ran ${limit} cycles without trapping (last opcode at ${hex(last)})`); // prettier-ignore
}

const SUITES = [
  {
    name: "the 6502 functional test (decimal mode included)",
    file: "6502_functional_test.bin",
    success: 0x3469,
    testCase: 0x0200,
    limit: 150_000_000,
  },
  {
    name: "the 65C02 extended opcodes test (WDC + Rockwell bit ops)",
    file: "65C02_extended_opcodes_test.bin",
    success: 0x24f1,
    testCase: 0x0202,
    limit: 100_000_000,
  },
];

for (const { name, file, success, testCase, limit } of SUITES) {
  test(
    `Dormann: ${name} reaches its success trap`,
    { skip: FAST && FAST_SKIP },
    () => {
      const { trap, cycles, mem, state } = runToTrap(file, limit);
      const { a, x, y, s, p } = state;
      assert.equal(
        trap,
        success,
        `${file} trapped at ${hex(trap)} in test case ${hex(mem[testCase], 2)} after ` +
          `${cycles} cycles (A=${hex(a, 2)} X=${hex(x, 2)} Y=${hex(y, 2)} S=${hex(s, 2)} ` +
          `P=${hex(p, 2)}) — look the address up in the upstream .lst`,
      );
    },
  );
}

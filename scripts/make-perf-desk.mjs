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

// make-perf-desk.mjs — write the TWO-BOARD performance circuit
// (src/web/scripts/bench/two-board-circuit.js) as a project to open in the
// app, after proving it works — so a number is never taken off a dead desk.
//
//   make perf-desk                         → data/perf-two-board.chiphippo
//   PERF_OUT=/tmp/x.chiphippo make perf-desk
//   PERF_HZ=250 make perf-desk             the clock's rate (a CLOCK_HZ value)
//
// Before writing it checks the desk is what it says: the loader drops
// nothing, two pin-boards in ONE snapped group, and then it drives the clock
// through the engine — the digital one and Spice Lite — and checks every
// block against arithmetic each rising edge: the counter counted, the LFSR
// stepped by its taps, the comparator and the adder agree with the values
// they were fed.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { twoBoardDocument, pinBoards } from "../src/web/scripts/bench/two-board-circuit.js"; // prettier-ignore
import { normalizeDocument } from "../src/web/scripts/model/desk-doc.js";
import { partPinAddresses } from "../src/web/scripts/model/occupancy.js";
import { parseAddress } from "../src/web/scripts/model/breadboard.js";
import { partDef } from "../src/web/scripts/catalog/index.js";
import { CLOCK_HZ } from "../src/web/scripts/catalog/parts.js";
import { buildNetlist } from "../src/web/scripts/sim/netlist.js";
import { prepareCircuit } from "../src/web/scripts/sim/engine.js";
import { ENGINES } from "../src/web/scripts/sim/engines.js";
import { H, L } from "../src/web/scripts/sim/levels.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(process.env.PERF_OUT ?? join(ROOT, "data", "perf-two-board.chiphippo")); // prettier-ignore
const HZ = Number(process.env.PERF_HZ ?? 100);
const EDGES = { digital: 600, spice: 200 };

/** Assert the doc survives the loader with nothing dropped. */
function assertClean(doc) {
  const norm = normalizeDocument(doc);
  for (const what of ["boards", "components", "wires"]) {
    const lost = doc[what].length - norm[what].length;
    if (lost) throw new Error(`the loader dropped ${lost} ${what}`);
  }
}

/** Each block's chips, told apart by how they are wired to each other. */
function roles(doc, netlist) {
  const pinNet = (comp, name) => {
    const n = partDef(comp.ref).pins.findIndex((p) => p.name === name) + 1;
    const addr = partPinAddresses(doc, comp).find((p) => p.pin === n).address;
    return netlist.netOfPoint.get(addr);
  };
  // The two of `ref`, low first: the high one's `inPin` is the low one's `outPin`.
  const pair = (ref, outPin, inPin) => {
    const [a, b] = doc.components.filter((c) => c.ref === ref);
    if (!a || !b) throw new Error(`expected two ${ref}s`);
    if (pinNet(b, inPin) === pinNet(a, outPin)) return [a, b];
    if (pinNet(a, inPin) === pinNet(b, outPin)) return [b, a];
    throw new Error(`the two ${ref}s are not chained ${outPin} → ${inPin}`);
  };
  const nets = (comp, names) => names.map((n) => pinNet(comp, n));
  const [cntL, cntH] = pair("74LS161", "RCO", "ENT");
  const [srL, srH] = pair("74LS164", "Q7", "A");
  const [, cmpH] = pair("74LS85", "A=B", "IA=B");
  const [addL, addH] = pair("74LS283", "C4", "C0");
  const q = ["QA", "QB", "QC", "QD"];
  const sr = ["Q0", "Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7"];
  const s = ["S1", "S2", "S3", "S4"];
  return {
    count: [...nets(cntL, q), ...nets(cntH, q)],
    lfsr: [...nets(srL, sr), ...nets(srH, sr)],
    cmp: nets(cmpH, ["A<B", "A=B", "A>B"]),
    sum: [...nets(addL, s), ...nets(addH, s), pinNet(addH, "C4")],
  };
}

const word = (levels, nets) =>
  nets.reduce((v, n, i) => v + (levels.get(n) === H ? 2 ** i : 0), 0);

/** Drive `edges` clock edges on `engine`, checking every block each rising edge. */
function validate(doc, netlist, engine, edges) {
  const { tick } = ENGINES[engine];
  const r = roles(doc, netlist);
  const clockId = doc.components.find((c) => c.kind === "clock").id;
  const clockPhase = new Map([[clockId, L]]);
  const context = prepareCircuit(doc, netlist);
  let warm = new Map();
  let state = new Map();
  let prevPins = new Map();
  let analog = null;
  let rising = 0;
  let lfsr = null;
  const seen = { lfsr: new Set(), cmp: new Set() };
  const started = performance.now();
  for (let e = 0; e <= edges; e++) {
    if (e > 0) clockPhase.set(clockId, clockPhase.get(clockId) === H ? L : H);
    const res = tick({
      document: doc,
      netlist,
      warmStart: warm,
      state,
      prevPinLevels: prevPins,
      clockPhase,
      context,
      ...(engine === "spice" ? { spice: { config: { enabled: true }, analog } } : {}), // prettier-ignore
    });
    if (!res.settled) throw new Error(`${engine}: edge ${e} never settled`);
    [warm, state, prevPins, analog] = [res.netLevels, res.state, res.pinLevels, res.analog ?? null]; // prettier-ignore
    if (e === 0 || clockPhase.get(clockId) !== H) continue;
    rising++;
    const fail = (what) => {
      throw new Error(`${engine}, rising edge ${rising}: ${what}`);
    };
    const count = word(warm, r.count);
    if (count !== rising % 256) fail(`the counter reads ${count}, not ${rising % 256}`); // prettier-ignore
    // Q0 takes the XNOR of taps 16·14·13·11; every other bit shifts up one.
    const now = word(warm, r.lfsr);
    if (lfsr !== null) {
      const bit = (n) => (lfsr >> (n - 1)) & 1;
      const fb = 1 ^ bit(16) ^ bit(14) ^ bit(13) ^ bit(11);
      const want = ((lfsr << 1) & 0xffff) | fb;
      if (now !== want) fail(`the LFSR stepped ${lfsr} → ${now}, not ${want}`);
    }
    lfsr = now;
    seen.lfsr.add(now);
    const low = now & 0xff;
    const cmp = word(warm, r.cmp); // bit 0 A<B, 1 A=B, 2 A>B
    const wantCmp = count < low ? 1 : count === low ? 2 : 4;
    if (cmp !== wantCmp) fail(`the comparator says ${cmp} for ${count} vs ${low}`); // prettier-ignore
    seen.cmp.add(cmp);
    const gray = count ^ (count >> 1);
    const sum = word(warm, r.sum);
    if (sum !== gray + (now >> 8)) fail(`the adder gives ${sum} for ${gray} + ${now >> 8}`); // prettier-ignore
  }
  if (seen.lfsr.size < rising - 1) throw new Error(`${engine}: the LFSR repeated itself`); // prettier-ignore
  if (seen.cmp.size !== 3) throw new Error(`${engine}: the comparator never gave all three answers`); // prettier-ignore
  return { rising, ms: performance.now() - started };
}

function main() {
  if (!CLOCK_HZ.includes(HZ)) {
    const rates = CLOCK_HZ.filter((hz) => typeof hz === "number").join(", ");
    throw new Error(`PERF_HZ=${HZ} is not a clock rate (${rates}).`);
  }
  const doc = twoBoardDocument({ hz: HZ });
  assertClean(doc);
  const pins = pinBoards(doc);
  const groups = new Set(doc.boards.map((b) => b.group));
  if (groups.size !== 1 || groups.has(null)) {
    throw new Error(`the boards are not one snapped group (${[...groups].join(", ")})`); // prettier-ignore
  }
  const pinIds = new Set(pins.map((b) => b.id));
  const boardOf = (addr) => {
    const owner = parseAddress(addr)?.boardId;
    if (pinIds.has(owner)) return owner;
    const comp = doc.components.find((c) => c.id === owner);
    return pinIds.has(comp?.board) ? comp.board : null;
  };
  const crossing = doc.wires.filter((w) => {
    const [a, b] = [boardOf(w.from), boardOf(w.to)];
    return a && b && a !== b;
  }).length;

  const netlist = buildNetlist(doc);
  const runs = Object.entries(EDGES).map(([engine, edges]) => {
    const { rising, ms } = validate(doc, netlist, engine, edges);
    return `${engine} ${rising} rising edges checked (${(ms / edges).toFixed(2)} ms/tick)`; // prettier-ignore
  });

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        version: 5,
        name: "Two-board perf circuit",
        activeTab: "t1",
        nextIndex: 2,
        tabs: [{ id: "t1", name: "Two-board circuit", doc }],
      },
      null,
      2,
    ) + "\n",
  );
  const chips = doc.components.filter((c) => c.kind === "chip").length;
  console.log(
    `perf-desk: ${OUT}\n` +
      `  ${pins.length} pin-boards, ${doc.boards.length} strips in one group; ` +
      `${chips} chips, ${doc.components.length} parts, ${doc.wires.length} wires ` +
      `(${crossing} crossing boards); clock ${HZ} Hz\n` +
      `  validated: ${runs.join("; ")}`,
  );
}

main();

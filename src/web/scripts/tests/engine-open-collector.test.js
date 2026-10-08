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

// engine-open-collector.test.js — open-collector outputs (74LS01/03/05, the
// '47's segment drives, the '181's A=B): an output pulls LOW or lets go, in BOTH engines, so a pull-up
// reads it HIGH and several share a net as a wired-AND — and the spec lint
// and the AI compiler know it.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, Z } from "../sim/levels.js";
import { openCollectorDrive } from "../sim/chip-eval.js";
import { openCollectorPins, partDef } from "../catalog/index.js";
import { switchableOutputs } from "../model/spec-lint.js";
import { compileNetlist } from "../model/autobuild.js";
import { bench, runner } from "./timing-fixtures.js";

const ENGINES = ["digital", "spice"];

test("the open-collector parts say which pins are", () => {
  assert.deepEqual([...openCollectorPins(partDef("74LS05"))], [2, 4, 6, 8, 10, 12]); // prettier-ignore
  assert.deepEqual([...openCollectorPins(partDef("74LS01"))], [1, 4, 10, 13]);
  assert.deepEqual([...openCollectorPins(partDef("74LS03"))], [3, 6, 8, 11]);
  assert.deepEqual([...openCollectorPins(partDef("74LS181"))], [14]);
  assert.deepEqual([...openCollectorPins(partDef("74LS47"))], [9, 10, 11, 12, 13, 14, 15]); // prettier-ignore
  assert.equal(openCollectorPins(partDef("74LS04")).size, 0);
});

test("an open-collector HIGH drives nothing; a LOW still sinks", () => {
  const def = partDef("74LS05");
  const out = openCollectorDrive(
    def,
    new Map([
      [2, H],
      [4, L],
    ]),
  );
  assert.equal(out.get(2), Z);
  assert.equal(out.get(4), L);
  const plain = new Map([[2, H]]);
  assert.equal(
    openCollectorDrive(partDef("74LS04"), plain),
    plain,
    "untouched",
  );
});

/** Two 74LS05 outputs on one net with a 4.7 k pull-up, read by 3A. */
function wiredAnd(in1, in2) {
  const b = bench();
  const u = b.seat("u1", "74LS05", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  (in1 ? b.vcc : b.gnd)(u.get(1));
  (in2 ? b.vcc : b.gnd)(u.get(3));
  b.link(u.get(2), u.get(4));
  const r = b.seat("r1", "resistor", "a40", { ohms: 4700 });
  b.vcc(r.get(1));
  b.link(r.get(2), u.get(2));
  b.link(u.get(2), u.get(5)); // 3A reads the wired-AND
  return { b, u };
}

for (const engine of ENGINES) {
  test(`${engine}: open-collector outputs make a wired-AND, not a fight`, () => {
    for (const [a, c, want] of [
      [false, false, H], // both let go: the pull-up wins
      [true, false, L], // one sinks
      [true, true, L],
    ]) {
      const { b, u } = wiredAnd(a, c);
      const run = runner(b.doc, { engine }).run(0);
      assert.equal(run.level(u.get(2)), want, `inputs ${a} ${c}`);
      assert.equal(run.result.warnings.some((w) => w.type === "conflict"), false); // prettier-ignore
    }
  });
}

test("the spec lint lets open-collector outputs share a net", () => {
  assert.ok(switchableOutputs(partDef("74LS05")).has(2));
  assert.ok(switchableOutputs(partDef("74LS181")).has(14));
  assert.equal(switchableOutputs(partDef("74LS181")).has(9), false, "F0 is totem-pole"); // prettier-ignore
});

test("the AI compiler pulls an open-collector net up, and lets two share it", () => {
  const out = compileNetlist({
    parts: [
      { id: "U1", ref: "74LS05" },
      { id: "U2", ref: "74LS04" },
      { id: "SW", ref: "sw-dip2" },
    ],
    nets: [
      { name: "SRC", members: ["SW.1B", "SW.2B", "VCC"] },
      { name: "A", members: ["SW.1A", "U1.1A"] },
      { name: "B", members: ["SW.2A", "U1.2A"] },
      { name: "WIRED", members: ["U1.1Y", "U1.2Y", "U2.1A"] },
    ],
  });
  assert.equal(out.ok, true, out.errors?.map((e) => e.message).join("; "));
  const pullUps = out.warnings.filter(
    (w) => w.code === "PULL_INSERTED" && /open-collector/.test(w.message),
  );
  assert.equal(pullUps.length, 1);
  assert.match(pullUps[0].message, /"WIRED"/);
});

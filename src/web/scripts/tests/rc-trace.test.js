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

// Capacitors as the netlist, the engine and the validators see them — a
// non-connect everywhere, rails included, yet a connection as far as "is this
// pin wired?" goes — and the shared trace every timing part reads its R and C
// through (sim/rc-trace.js).

import test from "node:test";
import assert from "node:assert/strict";

import { buildNetlist } from "../sim/netlist.js";
import { settle } from "../sim/engine.js";
import { H, L } from "../sim/levels.js";
import { rcTrace, timingOf, timingProbe } from "../sim/rc-trace.js";
import { reviewDesk } from "../model/desk-review.js";
import { buildPlan } from "../model/build-plan.js";
import { bench, runner } from "./timing-fixtures.js";

const netAt = (netlist, address) => netlist.netOfPoint.get(address);

// ── A capacitor joins nothing ────────────────────────────────────────────────

test("a capacitor never joins two nets — two signal nodes stay two", () => {
  for (const ref of ["cap-ceramic", "cap-electrolytic"]) {
    const b = bench();
    const c = b.seat("c1", ref, "a30", { farads: 1e-6 });
    const netlist = buildNetlist(b.doc);
    assert.notEqual(
      netAt(netlist, b.at(c.get(1))),
      netAt(netlist, b.at(c.get(2))),
      ref,
    );
  }
});

test("…not even across the power rails: no short, both rails keep their level", () => {
  const b = bench();
  const c = b.seat("c1", "cap-electrolytic", "a30", { farads: 470e-6 });
  b.vcc(c.get(1));
  b.gnd(c.get(2));
  const netlist = buildNetlist(b.doc);
  const r = settle({ document: b.doc, netlist });
  assert.ok(!r.warnings.some((w) => w.type === "short"), "no short");
  assert.equal(r.netLevels.get(netAt(netlist, b.at(c.get(1)))), H);
  assert.equal(r.netLevels.get(netAt(netlist, b.at(c.get(2)))), L);
});

test("…and drives nothing: a net whose only company is a capacitor floats", () => {
  const b = bench();
  const c = b.seat("c1", "cap-ceramic", "a30", { farads: 1e-6 });
  b.vcc(c.get(1));
  const netlist = buildNetlist(b.doc);
  const r = settle({ document: b.doc, netlist });
  assert.equal(r.netLevels.get(netAt(netlist, b.at(c.get(2)))), "Z");
});

// ── …yet a capacitor-only connection counts as connected ─────────────────────

test("a CMOS input whose only company is a capacitor is not called floating", () => {
  const b = bench();
  const u = b.seat("u1", "CD4069UB", "e10"); // hex inverter, inputs 1 3 5 9 11 13
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  for (const pin of [3, 5, 9, 11, 13]) b.gnd(u.get(pin));
  const c = b.seat("c1", "cap-ceramic", "a30", { farads: 100e-9 });
  b.link(c.get(1), u.get(1)); // input 1A's only company: the capacitor
  b.gnd(c.get(2));
  const netlist = buildNetlist(b.doc);
  const r = settle({ document: b.doc, netlist });
  assert.ok(
    !r.warnings.some((w) => w.type === "floating-input"),
    JSON.stringify(r.warnings),
  );
  // The control: take the capacitor away and the same pin IS floating.
  b.doc.components = b.doc.components.filter((x) => x.id !== "c1");
  const bare = settle({ document: b.doc, netlist: buildNetlist(b.doc) });
  const w = bare.warnings.find((x) => x.type === "floating-input");
  assert.deepEqual(w?.pins, [1]);
});

test("the desk review does not call a TTL input on a capacitor floating", () => {
  const b = bench();
  const u = b.seat("u1", "74LS04", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  for (const pin of [3, 5, 9, 11, 13]) b.gnd(u.get(pin));
  const c = b.seat("c1", "cap-ceramic", "a30", { farads: 100e-9 });
  b.link(c.get(1), u.get(1));
  b.gnd(c.get(2));
  // Give output 1Y something to drive, so gate 1 is in use.
  const led = b.seat("d1", "led", "a40");
  b.link(led.get(1), u.get(2));
  b.gnd(led.get(2));
  const { findings } = reviewDesk(b.doc, buildNetlist(b.doc));
  assert.ok(
    !findings.some((f) => f.code === "INPUT_FLOATING"),
    JSON.stringify(findings.map((f) => f.code)),
  );
  // The control: with the capacitor gone, that input IS reported.
  b.doc.components = b.doc.components.filter((x) => x.id !== "c1");
  const bare = reviewDesk(b.doc, buildNetlist(b.doc)).findings;
  assert.ok(bare.some((f) => f.code === "INPUT_FLOATING"));
});

test("the build guide does not call a pin-and-capacitor net a forgotten one", () => {
  const b = bench();
  const u = b.seat("u1", "74LS04", "e10");
  const c = b.seat("c1", "cap-ceramic", "a30", { farads: 100e-9 });
  b.link(c.get(1), u.get(1));
  const plan = buildPlan(b.doc, buildNetlist(b.doc));
  assert.ok(
    !plan.warnings.some(
      (w) =>
        w.kind === "single-member-net" &&
        w.netId === netAt(buildNetlist(b.doc), b.at(u.get(1))),
    ),
  );
});

// ── The trace ────────────────────────────────────────────────────────────────

test("the trace follows a capacitor to its far net and reads its farads", () => {
  const b = bench();
  const c = b.seat("c1", "cap-electrolytic", "a30", { farads: 22e-6 });
  b.gnd(c.get(2));
  const netlist = buildNetlist(b.doc);
  const trace = rcTrace(b.doc, netlist);
  const near = netAt(netlist, b.at(c.get(1)));
  const far = netAt(netlist, b.at(c.get(2)));
  const [link] = trace.capacitors(near);
  assert.equal(link.id, "c1");
  assert.equal(link.value, 22e-6);
  assert.equal(link.far, far);
  assert.equal(link.polarized, true);
  assert.equal(link.plus, near, "an electrolytic's + is pin 1");
  assert.equal(trace.rail(far), "-", "the far side goes to ground");
  assert.equal(trace.capacitance(near, trace.toRail("-")), 22e-6);
  assert.equal(trace.capacitance(near, trace.toRail("+")), 0);
  assert.equal(trace.hasCapacitor(near), true);
});

test("the trace follows a resistor to its far net and reads its ohms", () => {
  const b = bench();
  const r = b.seat("r1", "resistor", "a30", { ohms: 4700 });
  b.vcc(r.get(2));
  const netlist = buildNetlist(b.doc);
  const trace = rcTrace(b.doc, netlist);
  const near = netAt(netlist, b.at(r.get(1)));
  const [link] = trace.resistors(near);
  assert.equal(link.value, 4700);
  assert.equal(link.far, netAt(netlist, b.at(r.get(2))));
  assert.equal(trace.rail(link.far), "+", "…to the positive rail");
  assert.equal(trace.resistance(near, trace.toRail("+")), 4700);
  assert.equal(trace.resistance(near, trace.toRail("-")), null);
});

test("parts in parallel combine as arithmetic says: C adds, 1/R adds", () => {
  const b = bench();
  const c1 = b.seat("c1", "cap-ceramic", "a10", { farads: 100e-9 });
  const c2 = b.seat("c2", "cap-ceramic", "a20", { farads: 220e-9 });
  const r1 = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
  const r2 = b.seat("r2", "resistor", "a40", { ohms: 10e3 });
  b.link(c1.get(1), c2.get(1));
  b.link(c1.get(2), c2.get(2));
  b.link(r1.get(1), r2.get(1));
  b.link(r1.get(2), r2.get(2));
  const netlist = buildNetlist(b.doc);
  const trace = rcTrace(b.doc, netlist);
  const ca = netAt(netlist, b.at(c1.get(1)));
  const cb = netAt(netlist, b.at(c1.get(2)));
  const ra = netAt(netlist, b.at(r1.get(1)));
  const rb = netAt(netlist, b.at(r1.get(2)));
  assert.ok(Math.abs(trace.capacitance(ca, cb) - 320e-9) < 1e-18);
  assert.equal(trace.resistance(ra, rb), 5e3);
});

test("resistors in series through a bare middle net add", () => {
  const b = bench();
  const r1 = b.seat("r1", "resistor", "a30", { ohms: 1e3 });
  const r2 = b.seat("r2", "resistor", "a40", { ohms: 2.2e3 });
  b.link(r1.get(2), r2.get(1));
  b.vcc(r2.get(2));
  const netlist = buildNetlist(b.doc);
  const trace = rcTrace(b.doc, netlist);
  const start = netAt(netlist, b.at(r1.get(1)));
  assert.ok(Math.abs(trace.resistance(start, trace.toRail("+")) - 3.2e3) < 1e-9); // prettier-ignore
  assert.equal(trace.resistance(start, trace.toRail("-")), null);
});

test("…and any network of bare nets reads as the one resistance it is", () => {
  // 1k into a middle net, then two 2k in parallel to +: 2 kΩ; and a third
  // chain alongside the first, straight to + through 2k: 2k ‖ 2k = 1 kΩ.
  const b = bench();
  const r1 = b.seat("r1", "resistor", "a10", { ohms: 1e3 });
  const r2 = b.seat("r2", "resistor", "a20", { ohms: 2e3 });
  const r3 = b.seat("r3", "resistor", "a30", { ohms: 2e3 });
  const r4 = b.seat("r4", "resistor", "a40", { ohms: 2e3 });
  b.link(r1.get(2), r2.get(1));
  b.link(r1.get(2), r3.get(1));
  b.vcc(r2.get(2));
  b.vcc(r3.get(2));
  b.link(r1.get(1), r4.get(1));
  b.vcc(r4.get(2));
  const netlist = buildNetlist(b.doc);
  const trace = rcTrace(b.doc, netlist);
  const start = netAt(netlist, b.at(r1.get(1)));
  assert.ok(Math.abs(trace.resistance(start, trace.toRail("+")) - 1e3) < 1e-9); // prettier-ignore
});

test("a series path is not followed through a net with anything else on it, or one reaching a third net", () => {
  // An LED's lead in the middle net: no longer one resistance.
  const b = bench();
  const r1 = b.seat("r1", "resistor", "a10", { ohms: 1e3 });
  const r2 = b.seat("r2", "resistor", "a20", { ohms: 1e3 });
  const led = b.seat("d1", "led", "a30");
  b.link(r1.get(2), r2.get(1));
  b.link(r1.get(2), led.get(1));
  b.vcc(r2.get(2));
  let netlist = buildNetlist(b.doc);
  let trace = rcTrace(b.doc, netlist);
  assert.equal(trace.resistance(netAt(netlist, b.at(r1.get(1))), trace.toRail("+")), null); // prettier-ignore

  // A bare middle net that also reaches GND through a third resistor: a
  // divider, not a resistance to +.
  const d = bench();
  const s1 = d.seat("r1", "resistor", "a10", { ohms: 1e3 });
  const s2 = d.seat("r2", "resistor", "a20", { ohms: 1e3 });
  const s3 = d.seat("r3", "resistor", "a30", { ohms: 1e3 });
  d.link(s1.get(2), s2.get(1));
  d.link(s1.get(2), s3.get(1));
  d.vcc(s2.get(2));
  d.gnd(s3.get(2));
  netlist = buildNetlist(d.doc);
  trace = rcTrace(d.doc, netlist);
  const start = netAt(netlist, d.at(s1.get(1)));
  assert.equal(trace.resistance(start, trace.toRail("+")), null);
  assert.equal(trace.resistance(start, trace.toRail("-")), null);
});

/** A 555 astable whose RB is a 1 kΩ resistor in series with a 1 MΩ pot
    (pin 1 to the resistor, wiper to TRIG/THRES, pin 3 open) — Ben Eater's
    clock module's guard against a pot turned to zero — or, `inRa`, whose RA
    is (RB then a plain 1 kΩ). RA/RB otherwise 1 kΩ; 1 µF. */
function potAstable({ position, inRa = false }) {
  const b = bench();
  const u = b.seat("u1", "NE555", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(1));
  b.vcc(u.get(4));
  b.link(u.get(2), u.get(6));
  const cap = b.seat("c1", "cap-electrolytic", "a30", { farads: 1e-6 });
  b.link(cap.get(1), u.get(6));
  b.gnd(cap.get(2));
  const fixed = b.seat("r1", "resistor", "a50", { ohms: 1e3 });
  const guard = b.seat("r2", "resistor", "a40", { ohms: 1e3 });
  const pot = b.seat("p1", "pot", "f40", { ohms: 1e6, position });
  if (inRa) {
    b.link(fixed.get(1), u.get(7));
    b.link(fixed.get(2), u.get(6));
    b.vcc(guard.get(2));
    b.link(guard.get(1), pot.get(1));
    b.link(pot.get(2), u.get(7));
  } else {
    b.link(fixed.get(1), u.get(7));
    b.vcc(fixed.get(2));
    b.link(guard.get(1), u.get(7));
    b.link(guard.get(2), pot.get(1));
    b.link(pot.get(2), u.get(6));
  }
  return b;
}

test("a 555 whose RB or RA is a pot in series with a resistor runs, at the sum", () => {
  for (const inRa of [false, true]) {
    for (const position of [0, 25, 100]) {
      const b = potAstable({ position, inRa });
      const netlist = buildNetlist(b.doc);
      const comp = b.doc.components.find((c) => c.id === "u1");
      const { sections, problems } = timingOf(b.doc, netlist, comp);
      assert.deepEqual(problems, [], `${inRa ? "RA" : "RB"} at ${position} %`);
      const series = 1e3 + (position / 100) * 1e6;
      const [ra, rb] = inRa ? [series, 1e3] : [1e3, series];
      assert.ok(Math.abs(sections[0].ra - ra) < 1e-6 * ra, `RA ${sections[0].ra} vs ${ra}`); // prettier-ignore
      assert.ok(Math.abs(sections[0].rb - rb) < 1e-6 * rb, `RB ${sections[0].rb} vs ${rb}`); // prettier-ignore
    }
  }
});

test("…and it oscillates on the logic engine at that rate", () => {
  // RB = 1k + 250k: high 0.693·(1k + 251k)·1µ = 174.6 ms, low 0.693·251k·1µ.
  const b = potAstable({ position: 25 });
  const r = runner(b.doc);
  const edges = [];
  let was = null;
  for (let t = 0; t <= 1.5; t += 0.001) {
    const level = r.run(t).level("e12"); // OUT (pin 3)
    if (was != null && level !== was) edges.push(t);
    was = level;
  }
  assert.ok(edges.length >= 6, `${edges.length} edges`);
  const period = edges.at(-1) - edges.at(-3);
  const want = 0.693 * (1e3 + 2 * 251e3) * 1e-6;
  assert.ok(Math.abs(period - want) < 0.003, `period ${period} vs ${want}`);
});

test("an element of a bussed array is a resistor of the array's value", () => {
  const b = bench();
  const n = b.seat("rn1", "rnet9", "a30", { ohms: 4700 });
  b.vcc(n.get(1)); // COM to VCC: eight pull-ups
  const netlist = buildNetlist(b.doc);
  const trace = rcTrace(b.doc, netlist);
  const pin5 = netAt(netlist, b.at(n.get(5)));
  assert.equal(trace.resistance(pin5, trace.toRail("+")), 4700);
});

test("a probe answers a part's own pins; timingOf reads it outside a run", () => {
  const b = bench();
  const u = b.seat("u1", "NE555", "e10");
  const netlist = buildNetlist(b.doc);
  const trace = rcTrace(b.doc, netlist);
  const probe = timingProbe(
    trace,
    new Map([[6, netAt(netlist, b.at(u.get(6)))]]),
  );
  assert.equal(probe.net(6), netAt(netlist, b.at(u.get(6))));
  assert.equal(probe.net(7), null);
  assert.equal(
    typeof probe.capacitance,
    "function",
    "the trace's own questions",
  );
  // The same reading the engine takes each tick.
  const read = timingOf(b.doc, netlist, b.doc.components[1]);
  const ticked = runner(b.doc).run(0).result.timing.get("u1");
  assert.deepEqual(read, ticked);
  assert.equal(timingOf(b.doc, netlist, { ref: "74LS00" }), null);
});

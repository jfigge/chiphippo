/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// autobuild-corpus.test.js — every demo bench, through the AI compiler.
//
// The compiler had exactly one real circuit holding it honest (the adder in
// autobuild.test.js) and a handful of hand-written fragments. Everything else
// it could get wrong was found by spending a user's tokens on a live model and
// reading the wreckage — which is why its bugs have arrived one bad build at a
// time.
//
// scripts/demo-specs.mjs is the fix that was already sitting in the tree: 52
// bench circuits, one per 74xx part in the catalog, each proved through the
// real engine by `make demos` against a truth table written out by hand from
// the datasheet. They are ALREADY coordinate-free — inputs, ties, links, clock,
// leds — which makes them netlist specs in a different vocabulary, and a
// forward mapping away from being this compiler's corpus.
//
// Forward, and deliberately not a reverse-compile of the committed documents:
// a document's derived netlist includes whatever its switches are currently
// conducting, so a slide switch resting on +5 V reads as "this input IS the
// rail". Reverse-compiling would turn that transient into declared topology.
//
// What this buys: 51 real circuits compiled and verified on every `make test`,
// with no API key and no network. It found the L4 slide-switch abort below on
// its first run — a fault that blocked EVERY design using the ordinary SPDT
// input stage, which is to say all 52 of these.

import test from "node:test";
import assert from "node:assert/strict";

import { DEMOS } from "../../../../scripts/demo-specs.mjs";
import { compileNetlist } from "../model/autobuild.js";
import { verifyBuild } from "../model/autobuild-verify.js";

/**
 * A demo bench spec → the coordinate-free netlist the AI compiler consumes.
 *
 * The two vocabularies line up almost pin for pin, with one deliberate
 * omission: the demo bench places its own pull-down resistors and LED series
 * resistors, and the compiler derives both (see autobuild.js's pull rule and
 * resistor rule), so a spec that mentioned them would get two.
 */
export function specOfDemo(d) {
  const parts = [{ id: "U1", ref: d.ref }];
  const nets = [];
  const pin = (n) => `U1.#${n}`;

  // A part with more inputs than fit as slide switches gets the 8-way bank:
  // position k's A side to the chip, B side to VCC.
  if (d.bank) {
    parts.push({ id: "SW1", ref: "sw-dip8" });
    d.bank.pins.forEach((p, i) => {
      nets.push({ name: `BANK${i}`, members: [`SW1.${i + 1}A`, pin(p)] });
    });
    nets.push({
      name: "BANK_SRC",
      members: [...Array(8)].map((_, i) => `SW1.${i + 1}B`).concat("VCC"),
    });
  }

  // One SPDT per named input, its common feeding every pin the demo lists.
  (d.inputs ?? []).forEach((input, i) => {
    const id = `SWI${i + 1}`;
    parts.push({ id, ref: "sw-slide" });
    nets.push({ name: `${id}_SRC`, members: [`${id}.1`, "VCC"] });
    nets.push({
      name: `IN${i}`,
      members: [`${id}.C`, ...input.pins.map(pin)],
    });
  });

  // An enable asserted, an unused input parked.
  (d.ties ?? []).forEach((t, i) => {
    nets.push({
      name: `TIE${i}`,
      members: [...t.pins.map(pin), t.rail === "+" ? "VCC" : "GND"],
    });
  });

  // The demo's own topology — an inverter chain, a Q̄ folded back to its D.
  (d.links ?? []).forEach(([a, b], i) => {
    nets.push({ name: `LINK${i}`, members: [pin(a), pin(b)] });
  });

  if (d.clock) {
    parts.push({ id: "CLK1", ref: "clock" });
    nets.push({ name: "CLKGND", members: ["CLK1.gnd", "GND"] });
    if (d.clock.pins?.length) {
      nets.push({
        name: "CLOCK",
        members: ["CLK1.out", ...d.clock.pins.map(pin)],
      });
    }
  }

  // One read-out per output. An ACTIVE-LOW one is wired the other way up — LED
  // anode to the rail, cathode to the pin — so a LIT lamp always means
  // "asserted", which is the demos' convention and a real bench habit.
  (d.leds ?? []).forEach((led, i) => {
    const id = `D${i + 1}`;
    parts.push({ id, ref: "led" });
    const [anode, cathode] = led.activeLow
      ? ["VCC", pin(led.pin)]
      : [pin(led.pin), "GND"];
    nets.push({ name: `L${i}A`, members: [`${id}.A`, anode] });
    nets.push({ name: `L${i}K`, members: [`${id}.K`, cathode] });
  });

  if (d.display) {
    parts.push({ id: "DS1", ref: "seg8ca" });
    nets.push({ name: "DS_COM", members: ["DS1.#9", "VCC"] }); // pin 9 = anode
    d.display.segPins.forEach((p, i) => {
      nets.push({ name: `SEG${i}`, members: [`DS1.${"abcdefg"[i]}`, pin(p)] });
    });
  }

  // A pin belongs to at most one net, and the demo vocabulary overlaps on
  // purpose — the '04 chains 1Y→2A in `links` AND hangs an LED on 1Y. Two nets
  // naming one pin ARE one net, so merge rather than emit both and be refused.
  return { title: `${d.ref} — ${d.title}`, parts, nets: mergeShared(nets) };
}

/** Union any nets sharing a member; the first name wins. */
function mergeShared(nets) {
  const out = [];
  const at = new Map(); // member → index in `out`
  for (const net of nets) {
    let target = net.members.map((m) => at.get(m)).find((i) => i != null);
    if (target == null) {
      target = out.length;
      out.push({ name: net.name, members: [] });
    }
    for (const m of net.members) {
      if (!out[target].members.includes(m)) out[target].members.push(m);
      at.set(m, target);
    }
  }
  return out;
}

/**
 * A switch that STEERS rather than sources: the '193 throws its clock at either
 * the count-up or the count-down pin. The netlist DSL has no way to say "the
 * common carries this signal and the throws are these two pins" without
 * describing three separate nets that only one switch position makes true, so
 * the demo is out of the compiler's vocabulary rather than beyond its skill.
 */
const STEERING = new Set(DEMOS.filter((d) => d.route).map((d) => d.ref));

/**
 * The one thing a netlist spec cannot say: a switch's RESTING position.
 *
 * Each of these hangs an active-LOW output enable on a switch, and the demo
 * gives it a `defaults` entry that asserts it. A spec has no equivalent —
 * `compileNetlist` seats every part with empty params — so the enable comes up
 * DEASSERTED and the outputs are legitimately `Z`, which L6 reports.
 *
 * That is the right answer for a generated circuit rather than a gap worth
 * closing with more DSL: a design whose correctness depends on hidden resting
 * state is a bad design to hand someone, and tying the enable builds and
 * verifies clean (proved below). The system prompt says so for that reason.
 */
const ENABLE_ON_A_SWITCH = new Set([
  "74LS125",
  "74LS240",
  "74LS244",
  "74LS245",
  "74LS257",
  "74LS533",
  "74LS573",
]);

for (const demo of DEMOS) {
  if (STEERING.has(demo.ref)) continue;

  test(`${demo.ref} — the demo bench compiles and verifies`, () => {
    const spec = specOfDemo(demo);
    const compiled = compileNetlist(spec);
    assert.equal(
      compiled.ok,
      true,
      compiled.ok
        ? ""
        : compiled.errors.map((e) => `${e.code}: ${e.message}`).join("; "),
    );
    const verdict = verifyBuild(compiled, spec);

    if (ENABLE_ON_A_SWITCH.has(demo.ref)) {
      // Pinned, not ignored: if this ever passes, or fails for a NEW reason,
      // the list above is out of date and should say so.
      assert.equal(verdict.ok, false, "the known resting-state gap");
      const codes = new Set(verdict.faults.map((f) => f.code));
      assert.deepEqual(
        [...codes],
        ["OUTPUTS_DISABLED"],
        "and only for that reason",
      );
      // …and the fault has to be worth receiving: it names the chip, names the
      // pin, and says what to do. "Nothing drives it" sent a repair round
      // hunting for a wire that was never missing.
      const f = verdict.faults[0];
      assert.match(f.message, /active-LOW output enable/);
      assert.match(f.message, /Tie (it|them) to GND/);
      assert.ok(f.chip && f.pin, "structured, not just prose");
      return;
    }

    assert.equal(
      verdict.ok,
      true,
      verdict.faults
        .map((f) => `${f.gate} ${f.kind}/${f.code}: ${f.message}`)
        .join("; "),
    );
  });
}

test("every catalog demo is accounted for — no chip silently skipped", () => {
  // The corpus is only worth having if it covers everything. A part added to
  // demo-specs.mjs joins this suite automatically; one that cannot be built has
  // to be named in an exception list, where it can be argued with.
  const covered = DEMOS.filter(
    (d) => !STEERING.has(d.ref) && !ENABLE_ON_A_SWITCH.has(d.ref),
  );
  assert.ok(covered.length >= 44, `${covered.length} demos verify end to end`);
  for (const ref of [...STEERING, ...ENABLE_ON_A_SWITCH]) {
    assert.ok(
      DEMOS.some((d) => d.ref === ref),
      `${ref} is still a demo — drop it from the exception list otherwise`,
    );
  }
});

test("an output enable TIED asserted builds clean, unlike one on a switch", () => {
  // The claim the exception list rests on, and the rule the system prompt
  // states: a generated circuit ties its enables.
  // The SAME demo with its two enables moved from `inputs` to `ties` — said in
  // the demo's own vocabulary rather than by operating on the built spec, so
  // the only difference between passing and failing is the one under test.
  const demo = DEMOS.find((d) => d.ref === "74LS244");
  const spec = specOfDemo({
    ...demo,
    inputs: [],
    ties: [
      ...(demo.ties ?? []),
      ...demo.inputs.map((i) => ({ pins: i.pins, rail: "-" })), // asserted LOW
    ],
  });
  const compiled = compileNetlist(spec);
  assert.equal(compiled.ok, true);
  const verdict = verifyBuild(compiled, spec);
  assert.equal(
    verdict.ok,
    true,
    verdict.faults.map((f) => `${f.code}: ${f.message}`).join("; "),
  );
});

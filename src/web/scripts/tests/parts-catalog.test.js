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

// Integrity + contract tests for the discrete/PSU catalog (catalog/parts.js).

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import {
  LED_COLOR_OPTIONS,
  PART_DEFS,
  PSU_VOLTS,
  CLOCK_HZ,
  OSCILLATOR_HZ,
} from "../catalog/parts.js";
import {
  partDef,
  chipDef,
  datasheetCrop,
  PALETTE_DEFS,
} from "../catalog/index.js";
import { packageSpec } from "../model/footprints.js";
import { isOscillator, hasBehavior } from "../sim/chip-eval.js";

test("the part catalog carries the Feature 60 inventory", () => {
  assert.deepEqual(PART_DEFS.map((d) => d.id).sort(), [
    "bar8",
    "bar8iso",
    "clock",
    "lcd16x2",
    "lcd20x4",
    "led",
    "osc-full",
    "osc-half",
    "psu",
    "resistor",
    "rnet9",
    "seg8ca",
    "seg8cc",
    "sw-dip1",
    "sw-dip2",
    "sw-dip4",
    "sw-dip8",
    "sw-push",
    "sw-slide",
    "sw-toggle",
  ]);
  // partDef resolves everything; chipDef stays chips-only.
  assert.ok(partDef("sw-slide"));
  assert.ok(partDef("74LS00"));
  assert.ok(partDef("clock"));
  assert.ok(partDef("lcd16x2"));
  assert.equal(chipDef("sw-slide"), null);
  assert.equal(PALETTE_DEFS.length, 81); // 61 chips (24 + 28 LS + 6 memory + 3 io) + 20 parts
});

for (const def of PART_DEFS.filter((d) => d.kind === "discrete")) {
  test(`part def ${def.id} is internally consistent`, () => {
    assert.ok(def.title.length > 0 && def.blurb.length > 0 && def.group);
    // Geometry: a discrete either lies along ONE grid row (footprint offsets,
    // one per pin, strictly ascending from 0), straddles the trench in a DIP
    // package (the isolated bar array), or is a rigid 4-corner can — never
    // more than one.
    if (def.package) {
      assert.ok(!def.footprint, "a DIP-footprint discrete carries no offsets");
      assert.equal(packageSpec(def.package).pins, def.pins.length);
    } else if (def.can) {
      assert.ok(!def.footprint, "a can carries no row offsets");
      assert.equal(def.pins.length, 4);
      assert.ok(Number.isInteger(def.can.width) && def.can.width > 0);
      assert.ok(Number.isInteger(def.can.height) && def.can.height > 0);
    } else {
      assert.equal(def.footprint.offsets.length, def.pins.length);
      assert.equal(def.footprint.offsets[0], 0);
      for (let i = 1; i < def.footprint.offsets.length; i++) {
        assert.ok(def.footprint.offsets[i] > def.footprint.offsets[i - 1]);
      }
    }
    // Pin numbers unique and 1-based.
    assert.deepEqual(
      def.pins.map((p) => p.n),
      Array.from({ length: def.pins.length }, (_, i) => i + 1),
    );
    // Every bridge references existing pins.
    const pinNumbers = new Set(def.pins.map((p) => p.n));
    for (const state of [undefined, { pressed: true }, { pressed: false }]) {
      for (const params of [
        def.normalizeParams({}),
        def.normalizeParams({ pos: "2" }),
      ]) {
        for (const [a, b] of def.internalBridges(params, state)) {
          assert.ok(pinNumbers.has(a) && pinNumbers.has(b), `${a}-${b}`);
        }
      }
    }
  });
}

test("sw-slide: pos bridges common↔1 or common↔3; params coerce", () => {
  const def = partDef("sw-slide");
  assert.deepEqual(def.internalBridges({ pos: "1" }), [[2, 1]]);
  assert.deepEqual(def.internalBridges({ pos: "2" }), [[2, 3]]);
  assert.deepEqual(def.normalizeParams({ pos: "junk" }), { pos: "1" });
  assert.deepEqual(def.normalizeParams({ pos: "2" }), { pos: "2" });
});

test("sw-push: bridges only while pressed; nothing durable in params", () => {
  const def = partDef("sw-push");
  assert.deepEqual(def.internalBridges({}, { pressed: true }), [[1, 2]]);
  assert.deepEqual(def.internalBridges({}, { pressed: false }), []);
  assert.deepEqual(def.internalBridges({}), []);
  assert.deepEqual(def.normalizeParams({ pressed: true }), {});
});

test("sw-toggle: bridges while on; on persists in params", () => {
  const def = partDef("sw-toggle");
  assert.deepEqual(def.internalBridges({ on: true }), [[1, 2]]);
  assert.deepEqual(def.internalBridges({ on: false }), []);
  assert.deepEqual(def.internalBridges({}), []);
  assert.deepEqual(def.normalizeParams({ on: true }), { on: true });
  assert.deepEqual(def.normalizeParams({ on: "junk" }), { on: false });
  assert.deepEqual(def.normalizeParams({}), { on: false });
});

test("sw-dip1/2/4/8: DIP switch banks — package, pins, and switch-pair bridges", () => {
  for (const [id, n] of [
    ["sw-dip1", 1],
    ["sw-dip2", 2],
    ["sw-dip4", 4],
    ["sw-dip8", 8],
  ]) {
    const def = partDef(id);
    const pins = 2 * n;
    assert.equal(def.kind, "discrete"); // electrically n switches, not a chip…
    assert.equal(def.package, `DIP-${pins}`); // …but seats across the trench.
    assert.ok(!def.footprint, "seats by DIP package, not a row footprint");
    assert.equal(def.switchBank, true);
    assert.equal(def.pins.length, pins);
    assert.ok(
      def.pins.every((p) => p.role === "contact"),
      `${id}: every pin is a plain switch contact`,
    );
    // Switch k's two pins are named "kA"/"kB" so they read as one pair in the
    // Pin Assignment window.
    for (let i = 0; i < n; i++) {
      assert.equal(def.pins[i].name, `${i + 1}A`);
      assert.equal(def.pins[pins - 1 - i].name, `${i + 1}B`);
    }

    // normalizeParams: exactly n booleans, padded/trimmed/coerced; rot only
    // kept at 180 (bar8iso's convention).
    assert.deepEqual(def.normalizeParams({}), {
      states: Array(n).fill(false),
    });
    assert.deepEqual(def.normalizeParams({ states: [true] }), {
      states: Array.from({ length: n }, (_, i) => i === 0),
    });
    assert.deepEqual(def.normalizeParams({ states: Array(n + 3).fill(true) }), {
      states: Array(n).fill(true),
    });
    assert.deepEqual(def.normalizeParams({ states: [1, "yes", null] }), {
      states: Array(n).fill(false),
    });
    assert.deepEqual(def.normalizeParams({ rot: 180 }), {
      states: Array(n).fill(false),
      rot: 180,
    });
    assert.deepEqual(def.normalizeParams({ rot: 90 }), {
      states: Array(n).fill(false),
    });

    // Bridges: switch i (0-based) joins pin i+1 (row e) to pin pins-i (row
    // f) — the pin directly across the trench (model/footprints.js's
    // pinOffset). All-off bridges nothing; each position bridges only its
    // own pair.
    assert.deepEqual(def.internalBridges(def.normalizeParams({})), []);
    const allOn = def.internalBridges({ states: Array(n).fill(true) });
    assert.deepEqual(
      allOn,
      Array.from({ length: n }, (_, i) => [i + 1, pins - i]),
    );
    for (let i = 0; i < n; i++) {
      const states = Array(n).fill(false);
      states[i] = true;
      assert.deepEqual(def.internalBridges({ states }), [[i + 1, pins - i]]);
    }
  }
});

test("osc-full: a rigid 4-corner can, 7 holes by 4 holes; NC/GND/OUT/VCC only", () => {
  const def = partDef("osc-full");
  assert.deepEqual(def.can, { width: 6, height: 3 }); // 7×4 holes
  assert.equal(def.pins.length, 4);
  assert.deepEqual(
    def.pins.map((p) => p.role),
    ["nc", "gnd", "output", "vcc"],
  );
  assert.ok(isOscillator(def));
  assert.ok(hasBehavior(def));
  assert.deepEqual(def.internalBridges(), []); // driven, never a passive bridge
});

test("osc-half: a rigid 4-corner can, 4 holes by 4 holes; NC/GND/OUT/VCC only", () => {
  const def = partDef("osc-half");
  assert.deepEqual(def.can, { width: 3, height: 3 }); // 4×4 holes
  assert.equal(def.pins.length, 4);
  assert.deepEqual(
    def.pins.map((p) => p.role),
    ["nc", "gnd", "output", "vcc"],
  );
  assert.ok(isOscillator(def));
  assert.deepEqual(def.internalBridges(), []);
});

test("osc-full/osc-half: rate picks from OSCILLATOR_HZ (no manual mode); rot + damaged persist", () => {
  assert.deepEqual(
    OSCILLATOR_HZ,
    CLOCK_HZ.filter((hz) => hz !== "manual"),
  );
  for (const id of ["osc-full", "osc-half"]) {
    const def = partDef(id);
    assert.deepEqual(def.normalizeParams({}), { hz: OSCILLATOR_HZ[0], rot: 0 });
    assert.deepEqual(def.normalizeParams({ hz: 5 }), { hz: 5, rot: 0 });
    // "manual" isn't valid for a can — a real crystal has no toggle pin.
    assert.deepEqual(def.normalizeParams({ hz: "manual" }), {
      hz: OSCILLATOR_HZ[0],
      rot: 0,
    });
    // Only a true quarter-turn sticks; junk coerces to 0.
    assert.deepEqual(def.normalizeParams({ hz: 5, rot: 90 }), {
      hz: 5,
      rot: 90,
    });
    assert.deepEqual(def.normalizeParams({ rot: 45 }), {
      hz: OSCILLATOR_HZ[0],
      rot: 0,
    });
    assert.deepEqual(def.normalizeParams({ hz: 5, damaged: true }), {
      hz: 5,
      rot: 0,
      damaged: true,
    });
    assert.deepEqual(def.normalizeParams({ damaged: false }), {
      hz: OSCILLATOR_HZ[0],
      rot: 0,
    });
    // The Properties dialog (context menu → "Properties…") — shared by both
    // can sizes, same field shape as the clock brick's rate.
    assert.deepEqual(def.properties, [
      {
        key: "hz",
        label: "Rate",
        type: "select",
        options: OSCILLATOR_HZ.map((hz) => ({ value: hz, label: `${hz} Hz` })),
      },
    ]);
  }
});

test("led: color/flip coercion and polarity contract", () => {
  const def = partDef("led");
  assert.deepEqual(def.normalizeParams({}), {
    color: "red",
    flip: false,
    rot: 0,
    end: null,
  });
  assert.deepEqual(def.normalizeParams({ color: "blue", flip: true }), {
    color: "blue",
    flip: true,
    rot: 0,
    end: null,
  });
  // Rotatable like the resistor: rot 90 keeps the far lead's {dx, dy} bend.
  assert.equal(def.rotatable, true);
  assert.equal(def.minSpan, 1); // legs may sit side by side
  assert.deepEqual(def.normalizeParams({ rot: 90, end: { dx: 0, dy: -4 } }), {
    color: "red",
    flip: false,
    rot: 90,
    end: { dx: 0, dy: -4 },
  });
  // A legacy hole-id end, a non-integer bend, and a zero bend are all junk.
  assert.equal(def.normalizeParams({ rot: 90, end: "j7" }).end, null);
  // Rotating a bend negates a component; -0 must not reach the document, or
  // a saved desk stops round-tripping under deepStrictEqual.
  const negZero = def.normalizeParams({ rot: 90, end: { dx: -0, dy: 4 } }).end;
  assert.ok(Object.is(negZero.dx, 0), "dx must be +0, not -0");
  assert.ok(
    Object.is(
      def.normalizeParams({ rot: 90, end: { dx: 4, dy: -0 } }).end.dy,
      0,
    ),
  );
  assert.equal(
    def.normalizeParams({ rot: 90, end: { dx: 1.5, dy: 0 } }).end,
    null,
  );
  assert.equal(
    def.normalizeParams({ rot: 90, end: { dx: 0, dy: 0 } }).end,
    null,
  );
  assert.deepEqual(def.normalizeParams({ color: "pink", flip: "yes" }), {
    color: "red",
    flip: false,
    rot: 0,
    end: null,
  });
  assert.deepEqual(def.polarity({ flip: false }), {
    anodePin: 1,
    cathodePin: 2,
  });
  assert.deepEqual(def.polarity({ flip: true }), {
    anodePin: 2,
    cathodePin: 1,
  });
  assert.deepEqual(def.internalBridges({}), []); // a diode never bridges
  // The shared color list (the Properties dialog + the "Default LED color"
  // setting) — every colored discrete (LED, segment/bar displays) picks
  // from this one list.
  assert.deepEqual(LED_COLOR_OPTIONS, [
    "red",
    "green",
    "blue",
    "yellow",
    "white",
  ]);
  assert.deepEqual(def.colors, LED_COLOR_OPTIONS);
  assert.deepEqual(def.normalizeParams({ color: "white" }), {
    color: "white",
    flip: false,
    rot: 0,
    end: null,
  });
  // The Properties dialog (context menu → "Properties…") reads this
  // declarative list — one color field, its options the same LED palette.
  assert.deepEqual(def.properties, [
    { key: "color", label: "Color", type: "color", options: LED_COLOR_OPTIONS },
  ]);
});

test("seg8cc / bar8: common-cathode displays, colour + segment contract", () => {
  for (const id of ["seg8cc", "bar8"]) {
    const def = partDef(id);
    // Nine holes on one row: eight anodes then the shared cathode.
    assert.deepEqual(def.footprint.offsets, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(def.pins.length, 9);
    assert.equal(def.pins[8].role, "cathode"); // pin 9 = common cathode K
    for (let i = 0; i < 8; i++) {
      assert.equal(def.pins[i].role, "anode", `${id} pin ${i + 1}`);
    }
    // Colour coerces to LED_COLOR_OPTIONS (default red); junk → red — same
    // set + Properties-dialog field as the LED (no placement-time popover).
    assert.deepEqual(def.normalizeParams({}), { color: "red" });
    assert.deepEqual(def.normalizeParams({ color: "blue" }), { color: "blue" });
    assert.deepEqual(def.normalizeParams({ color: "white" }), {
      color: "white",
    });
    assert.deepEqual(def.normalizeParams({ color: "mauve" }), { color: "red" });
    assert.deepEqual(def.colors, LED_COLOR_OPTIONS);
    assert.deepEqual(def.properties, [
      {
        key: "color",
        label: "Color",
        type: "color",
        options: LED_COLOR_OPTIONS,
      },
    ]);
    // Eight segments, each an LED to the shared cathode (pin 9); every anode
    // pin referenced exactly once and every referenced pin exists.
    assert.equal(def.segments.length, 8);
    assert.deepEqual(
      def.segments.map((s) => s.anodePin).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    const pinNumbers = new Set(def.pins.map((p) => p.n));
    for (const seg of def.segments) {
      assert.equal(seg.cathodePin, 9, `${id} ${seg.id} shares the cathode`);
      assert.ok(pinNumbers.has(seg.anodePin) && pinNumbers.has(seg.cathodePin));
    }
    // A display's diodes never hard-bridge (like the LED).
    assert.deepEqual(def.internalBridges(def.normalizeParams({})), []);
  }
});

test("seg8ca: common-anode display, colour contract matches the LED's", () => {
  const def = partDef("seg8ca");
  assert.deepEqual(def.normalizeParams({}), { color: "red" });
  assert.deepEqual(def.normalizeParams({ color: "white" }), { color: "white" });
  assert.deepEqual(def.normalizeParams({ color: "mauve" }), { color: "red" });
  assert.deepEqual(def.colors, LED_COLOR_OPTIONS);
  assert.deepEqual(def.properties, [
    { key: "color", label: "Color", type: "color", options: LED_COLOR_OPTIONS },
  ]);
});

test("bar8iso: 16-pin DIP, eight isolated bars (own anode + cathode)", () => {
  const def = partDef("bar8iso");
  assert.equal(def.kind, "discrete"); // electrically LEDs, not a chip…
  assert.equal(def.package, "DIP-16"); // …but seats across the trench.
  assert.ok(!def.footprint, "seats by DIP package, not a row footprint");
  assert.equal(def.pins.length, 16);
  // Pins 1–8 are anodes (row e), 9–16 cathodes (row f).
  for (let i = 0; i < 8; i++) assert.equal(def.pins[i].role, "anode");
  for (let i = 8; i < 16; i++) assert.equal(def.pins[i].role, "cathode");
  // Eight bars, each an LED between its OWN anode and cathode — no shared pin.
  // Bar i sits at anode pin i, cathode pin 17-i (directly across the trench).
  assert.equal(def.segments.length, 8);
  const anodes = new Set();
  const cathodes = new Set();
  for (const seg of def.segments) {
    assert.equal(seg.anodePin + seg.cathodePin, 17, `${seg.id} across trench`);
    assert.notEqual(seg.anodePin, seg.cathodePin);
    anodes.add(seg.anodePin);
    cathodes.add(seg.cathodePin);
  }
  assert.equal(anodes.size, 8, "every bar has a distinct anode");
  assert.equal(cathodes.size, 8, "every bar has a distinct cathode");
  // No pin is shared between anode and cathode duty (the point of "isolated").
  for (const a of anodes) assert.ok(!cathodes.has(a));
  // Colour coercion like the other displays (same set + Properties-dialog
  // field as the LED); diodes never hard-bridge.
  assert.deepEqual(def.normalizeParams({}), { color: "red" });
  assert.deepEqual(def.normalizeParams({ color: "green" }), { color: "green" });
  assert.deepEqual(def.normalizeParams({ color: "white" }), { color: "white" });
  assert.deepEqual(def.normalizeParams({ color: "mauve" }), { color: "red" });
  assert.deepEqual(def.colors, LED_COLOR_OPTIONS);
  assert.deepEqual(def.properties, [
    { key: "color", label: "Color", type: "color", options: LED_COLOR_OPTIONS },
  ]);
  assert.deepEqual(def.internalBridges(def.normalizeParams({})), []);
});

test("resistor: weakly bridges 1↔2, never a hard bridge; ohms coerce", () => {
  const def = partDef("resistor");
  // A resistor is a WEAK coupler: no hard internal bridge (stays two nets)…
  assert.deepEqual(def.internalBridges({ ohms: 220 }), []);
  // …but declares its weakly-coupled pin pair for the simulator's PULL tier.
  assert.deepEqual(def.weakBridges({ ohms: 220 }), [[1, 2]]);
  // Ohms are cosmetic but coerced to a positive number (default 10k); a
  // horizontal resistor carries rot 0 and no far end.
  assert.deepEqual(def.normalizeParams({}), { ohms: 10000, rot: 0, end: null });
  assert.deepEqual(def.normalizeParams({ ohms: 330 }), {
    ohms: 330,
    rot: 0,
    end: null,
  });
  assert.deepEqual(def.normalizeParams({ ohms: -5 }), {
    ohms: 10000,
    rot: 0,
    end: null,
  });
  assert.deepEqual(def.normalizeParams({ ohms: "junk" }), {
    ohms: 10000,
    rot: 0,
    end: null,
  });
  // Rotatable: rot 90 keeps the far lead's {dx, dy} bend; a stray `end`
  // without rot is dropped, and a malformed bend normalizes end→null.
  assert.equal(def.rotatable, true);
  assert.deepEqual(def.normalizeParams({ rot: 90, end: { dx: -5, dy: 4 } }), {
    ohms: 10000,
    rot: 90,
    end: { dx: -5, dy: 4 },
  });
  assert.deepEqual(def.normalizeParams({ end: { dx: -5, dy: 4 } }), {
    ohms: 10000,
    rot: 0,
    end: null,
  });
  // A v1 hole-id end is junk now; the migration converts it before load.
  assert.equal(def.normalizeParams({ rot: 90, end: "j7" }).end, null);
  assert.deepEqual(def.normalizeParams({ rot: 90 }), {
    ohms: 10000,
    rot: 90,
    end: null,
  });
  // Two leads on a 4-hole span (offsets 0 and 3) for the horizontal form.
  assert.deepEqual(def.footprint.offsets, [0, 3]);
});

test("rnet9: bussed array — 8 weak pulls to the common pin, no hard bridge", () => {
  const def = partDef("rnet9");
  assert.equal(def.kind, "discrete");
  // Nine holes on one row; pins 1–8 leads, pin 9 the common bus.
  assert.deepEqual(def.footprint.offsets, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(def.pins.length, 9);
  for (let i = 0; i < 8; i++) assert.equal(def.pins[i].role, "lead");
  assert.equal(def.pins[8].role, "common");
  assert.equal(def.pins[8].name, "COM");
  // Never a hard connection (like the single resistor): the coupling is weak.
  assert.deepEqual(def.internalBridges({ ohms: 220 }), []);
  // Each of pins 1–8 weakly couples to the common bus (pin 9) — eight pulls.
  assert.deepEqual(def.weakBridges({ ohms: 220 }), [
    [1, 9],
    [2, 9],
    [3, 9],
    [4, 9],
    [5, 9],
    [6, 9],
    [7, 9],
    [8, 9],
  ]);
  // Ohms are cosmetic but coerced to a positive number (default 10k).
  assert.deepEqual(def.normalizeParams({}), { ohms: 10000 });
  assert.deepEqual(def.normalizeParams({ ohms: 470 }), { ohms: 470 });
  assert.deepEqual(def.normalizeParams({ ohms: -5 }), { ohms: 10000 });
  assert.deepEqual(def.normalizeParams({ ohms: "junk" }), { ohms: 10000 });
});

test("psu: volts enum, source contract, integer terminal offsets", () => {
  const def = partDef("psu");
  assert.deepEqual(PSU_VOLTS, [3, 5, 12]);
  assert.deepEqual(def.normalizeParams({}), { volts: 5 });
  assert.deepEqual(def.normalizeParams({ volts: 12 }), { volts: 12 });
  assert.deepEqual(def.normalizeParams({ volts: 9 }), { volts: 5 });
  assert.deepEqual(def.source({ volts: 3 }), { plus: 3, minus: 0 });
  assert.deepEqual(
    def.terminals.map((t) => t.id),
    ["+", "-"],
  );
  for (const t of def.terminals) {
    assert.ok(Number.isInteger(t.dx) && Number.isInteger(t.dy), t.id);
    assert.ok(t.dx > 0 && t.dx < def.size.width);
    assert.ok(t.dy > 0 && t.dy < def.size.height);
  }
  // The Properties dialog (context menu → "Properties…") — a live setting.
  assert.deepEqual(def.properties, [
    {
      key: "volts",
      label: "Voltage",
      type: "select",
      options: [
        { value: 3, label: "3 V" },
        { value: 5, label: "5 V" },
        { value: 12, label: "12 V" },
      ],
    },
  ]);
});

test("clock: hz enum (+manual), isAuto contract, Properties field", () => {
  const def = partDef("clock");
  assert.deepEqual(CLOCK_HZ, [1, 2, 5, 10, "manual"]);
  assert.deepEqual(def.normalizeParams({}), { hz: 1 });
  assert.deepEqual(def.normalizeParams({ hz: 10 }), { hz: 10 });
  assert.deepEqual(def.normalizeParams({ hz: "manual" }), { hz: "manual" });
  assert.deepEqual(def.normalizeParams({ hz: 3 }), { hz: 1 });
  assert.equal(def.isAuto({ hz: 5 }), true);
  assert.equal(def.isAuto({ hz: "manual" }), false);
  assert.deepEqual(
    def.terminals.map((t) => t.id),
    ["out", "gnd"],
  );
  assert.deepEqual(def.properties, [
    {
      key: "hz",
      label: "Rate",
      type: "select",
      options: [
        { value: 1, label: "1 Hz" },
        { value: 2, label: "2 Hz" },
        { value: 5, label: "5 Hz" },
        { value: 10, label: "10 Hz" },
        { value: "manual", label: "Manual" },
      ],
    },
  ]);
});

test("lcd: both sizes are seated 16-hole discretes sharing ONE pinout", () => {
  const a = partDef("lcd16x2");
  const b = partDef("lcd20x4");
  for (const def of [a, b]) {
    // A board part, not a brick — this is the whole point of the split.
    assert.equal(def.kind, "discrete");
    assert.ok(!def.size && !def.terminals, "no desk-brick geometry survives");
    assert.ok(!def.package && !def.can, "seats along ONE grid row");
    assert.deepEqual(
      [...def.footprint.offsets],
      Array.from({ length: 16 }, (_, i) => i),
    );
    assert.equal(def.pins.length, 16);
    // The controller is stateful, so the engine must see behavior on it.
    assert.ok(hasBehavior(def));
  }

  // ONE pinout table drives both: the pin assignment is the controller's, not
  // the panel's, so a difference here would be a bug in the shared table.
  const pinout = (def) => def.pins.map((p) => [p.n, p.name, p.role, p.detail]);
  assert.deepEqual(pinout(a), pinout(b));

  // …and ONE datasheet for the same reason, named rather than derived from the
  // id: what a user asks a sheet about here (RS/RW/E, the bus, the address
  // maps) is the controller's, and it is the same document for both sizes.
  assert.equal(datasheetCrop(a), "HD44780");
  assert.equal(datasheetCrop(b), "HD44780");

  // Power roles wire into the sim's power-gating; DB0–7 are the bidirectional
  // bus (io); RS/RW/E are control inputs; V0/A/K are inert.
  const role = (name) => a.pins.find((p) => p.name === name)?.role;
  assert.equal(role("VDD"), "vcc");
  assert.equal(role("VSS"), "gnd");
  assert.equal(role("RS"), "input");
  assert.equal(role("E"), "input");
  assert.equal(role("DB0"), "io");
  assert.equal(role("DB7"), "io");
  assert.equal(role("V0"), "nc");

  // The Properties dialog offers the shared LED colour set — no size field:
  // the size IS the part now.
  assert.deepEqual(a.properties, [
    {
      key: "color",
      label: "Color",
      type: "color",
      options: LED_COLOR_OPTIONS,
    },
  ]);
  assert.deepEqual(a.normalizeParams({}), { color: "green" });
  assert.deepEqual(a.normalizeParams({ color: "puce" }), { color: "green" });
  // Magic smoke persists like a chip — SimController#persistDamage round-trips
  // the 12 V latch through normalizeParams, so dropping it revives the module.
  assert.deepEqual(a.normalizeParams({ color: "blue", damaged: true }), {
    color: "blue",
    damaged: true,
  });
});

test("a def that NAMES a datasheet crop has that file committed", () => {
  // A named crop is the one kind that fails SILENTLY: a def keyed by its own id
  // is checked by every other id assertion here, but a typo'd `datasheet` just
  // renders a figure that removes itself, so the pinout window looks exactly as
  // it did before the sheet was added. (Deliberately only the NAMED ones — a
  // chip whose crop is missing is a known, accepted gap.)
  const named = PALETTE_DEFS.filter((def) => def.datasheet);
  assert.ok(named.length, "at least one def names a sheet (the LCD modules)");
  for (const def of named) {
    const png = new URL(
      `../../datasheets/${datasheetCrop(def)}.png`,
      import.meta.url,
    );
    assert.ok(existsSync(png), `${def.id}: ${def.datasheet}.png is committed`);
  }
});

test("lcd: the characterDisplay drawing is self-consistent", () => {
  // Every rect is stated the same way except `body`, which doubles as the
  // part's discrete-view box and so uses that shape's minX/minY names.
  const contains = (outer, inner) =>
    inner.x >= outer.x - 1e-6 &&
    inner.y >= outer.y - 1e-6 &&
    inner.x + inner.width <= outer.x + outer.width + 1e-6 &&
    inner.y + inner.height <= outer.y + outer.height + 1e-6;

  // The PCB and the module, in MILLIMETRES — the form these were measured in,
  // and the only form a ruler can check them against. Both real modules carry
  // their header along the TOP edge, so both hang below the row they plug into.
  for (const [id, cols, rows, edge, pcbMm, moduleMm] of [
    ["lcd16x2", 16, 2, "top", [80, 36], [71, 24]],
    ["lcd20x4", 20, 4, "top", [98, 60], [97, 40]],
  ]) {
    const cd = partDef(id).characterDisplay;
    assert.equal(cd.cols, cols);
    assert.equal(cd.rows, rows);
    assert.equal(cd.headerEdge, edge);
    const mm = (u) => Math.round(u * 2.54 * 10) / 10;
    assert.deepEqual([mm(cd.body.width), mm(cd.body.height)], pcbMm, id);
    assert.deepEqual([mm(cd.window.width), mm(cd.window.height)], moduleMm, id);
    // body ⊃ window ⊃ screen — the glass is inside the frame is inside the PCB.
    const body = { x: cd.body.minX, y: cd.body.minY, ...cd.body };
    assert.ok(contains(body, cd.window), `${id}: window inside body`);
    assert.ok(contains(cd.window, cd.screen), `${id}: screen inside window`);
    // …and each is CENTRED in the one outside it, which is the whole
    // positioning rule: equal margins on both axes, to the µm.
    for (const [outer, inner, what] of [
      [body, cd.window, "module in PCB"],
      [cd.window, cd.screen, "screen in module"],
    ]) {
      assert.ok(
        Math.abs(inner.x - outer.x - (outer.width - inner.width) / 2) < 1e-4 &&
          Math.abs(inner.y - outer.y - (outer.height - inner.height) / 2) <
            1e-4,
        `${id}: ${what} is centred`,
      );
    }
    // The active area is the character grid with the TRAILING inter-character
    // gap trimmed, so it spans (n-1) full pitches plus one character: strictly
    // between (n-1)·pitch and n·pitch. That is the invariant lcd-view.js sizes
    // its backing buffer from, and it is what makes the cells land on pitch.
    for (const [span, n, pitch, axis] of [
      [cd.screen.width, cols, cd.charPitch.x, "width"],
      [cd.screen.height, rows, cd.charPitch.y, "height"],
    ]) {
      assert.ok(span > (n - 1) * pitch, `${id} ${axis}: ${span}`);
      assert.ok(span < n * pitch, `${id} ${axis}: ${span}`);
    }
    // Pin 1's hole (the local origin) sits just INSIDE the PCB on the declared
    // header edge — which is why neither module draws leg stubs: its own board
    // covers its pins, so there is no gap for a stub to bridge.
    const overhang =
      edge === "bottom" ? cd.body.minY + cd.body.height : -cd.body.minY;
    assert.ok(overhang > 0 && overhang < 2.5, `${id}: overhang ${overhang}`);
  }
});

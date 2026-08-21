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

// parts.js — discrete parts + power bricks: pure data and pure functions.
// Each def carries the part's ELECTRICAL CONTRACT for later stages:
//   - `footprint.offsets` — pin column offsets along ONE grid row (any row
//     a–j; the anchor hole is pin 1's seat).
//   - `internalBridges(params, state)` — which pin pairs are electrically
//     joined right now (Feature 70's netlist consumes this).
//   - `source(params)` — a PSU's terminal potentials (Feature 90 consumes).
//   - `normalizeParams(raw)` — coerce arbitrary stored params to valid ones.
//   - `clickToggle(params, index)` — the params patch ONE plain click makes,
//     or null when that click changes nothing. Declaring it is ALSO what makes
//     a part click-toggling at all: the controller asks whether the function is
//     there rather than consulting a list of refs, so a part that flips under
//     the finger arrives entirely from here. `index` is the sub-position a
//     multi-switch part was clicked on (a bank's actuator), null otherwise.
// No electrical logic lives in views, and none in the netlist yet.

import { hd44780Unit } from "../sim/hd44780.js";
import { MM_PER_UNIT } from "../desk/desk-geometry.js";
import { ROTATIONS } from "../model/breadboard.js";

/** The shared color choices for every colored discrete (LED, and the
    segment/bar displays) — each part's own Properties dialog + the "Default
    LED color" setting all pick from this one list. */
export const LED_COLOR_OPTIONS = Object.freeze([
  "red",
  "green",
  "blue",
  "yellow",
  "white",
]);
export const PSU_VOLTS = Object.freeze([3, 5, 12]);
/** Clock rates (Hz) plus click-to-toggle "manual"; the timer lives in the
    renderer's SimController — the def carries only the pure contract. A 1-2-5
    ladder up two decades: the slow end is for watching an edge land, the fast
    end for letting a counter or a CPU actually get somewhere. The TOP of this
    list is what sets the SimController's timer floor (MIN_HALF_PERIOD_MS is
    derived from it), so a rate offered here is a rate the app really runs —
    adding a faster one means asking whether the engine can still keep up with
    it, not just typing a number. */
export const CLOCK_HZ = Object.freeze([1, 2, 5, 10, 20, 50, 100, "manual"]);
/** An oscillator can is always free-running — a real crystal has no
    click-to-toggle pin — so it picks from CLOCK_HZ minus "manual". */
export const OSCILLATOR_HZ = Object.freeze(
  CLOCK_HZ.filter((hz) => hz !== "manual"),
);

/**
 * The HD44780 module's 16-pin interface, in datasheet order — the ONE table
 * BOTH module sizes read, because the pin assignment is identical across them
 * (it is the controller's, not the panel's). VDD/VSS are real power (the sim
 * power-gates the module like a chip); V0 (contrast) and A/K (backlight) are
 * inert `nc`; RS/RW/E are control inputs; DB0–DB7 are the bidirectional bus.
 *
 * `detail` is the datasheet's own prose for the pin, shown by the pin-
 * assignments window. Untranslated by the standing rule: per-pin datasheet
 * descriptions sit on the reference side of the line CLAUDE.md's "Language
 * support" draws, beside a part's `blurb`.
 *
 * NOTE both real modules run 16 signals through a 2.54 mm header, but neither
 * numbers it the way this app draws it: the 16×2's silkscreen counts
 * 14…1, 15, 16 left to right, and the 20×4's header is 18-way (17/18 are NC).
 * Pin 1 is at the LEFT end here, as it is for every other part in the app.
 */
const LCD_PINOUT = [
  { n: 1, name: "VSS", role: "gnd", detail: "0 V ground" },
  { n: 2, name: "VDD", role: "vcc", detail: "+5 V supply" },
  { n: 3, name: "V0", role: "nc", detail: "contrast (cosmetic here)" },
  {
    n: 4,
    name: "RS",
    role: "input",
    detail: "register select — 0 cmd / 1 data",
  },
  { n: 5, name: "RW", role: "input", detail: "0 = write, 1 = read" },
  {
    n: 6,
    name: "E",
    role: "input",
    detail: "enable strobe — latches on falling edge",
  },
  { n: 7, name: "DB0", role: "io", detail: "data bus bit 0 (LSB)" },
  { n: 8, name: "DB1", role: "io", detail: "data bus bit 1" },
  { n: 9, name: "DB2", role: "io", detail: "data bus bit 2" },
  { n: 10, name: "DB3", role: "io", detail: "data bus bit 3" },
  {
    n: 11,
    name: "DB4",
    role: "io",
    detail: "data bus bit 4 (low nibble in 4-bit mode)",
  },
  { n: 12, name: "DB5", role: "io", detail: "data bus bit 5" },
  { n: 13, name: "DB6", role: "io", detail: "data bus bit 6" },
  {
    n: 14,
    name: "DB7",
    role: "io",
    detail: "data bus bit 7 (MSB / busy flag)",
  },
  { n: 15, name: "A", role: "nc", detail: "backlight anode (cosmetic here)" },
  { n: 16, name: "K", role: "nc", detail: "backlight cathode (cosmetic here)" },
];

/**
 * The datasheet crop BOTH module sizes show, `web/datasheets/HD44780.png` —
 * named here rather than derived from the id, which is why `datasheet` exists
 * at all. A chip's sheet IS its id, but a module has two documents (the maker's
 * and the CONTROLLER's) and the controller's is the one this app wants: the pin
 * assignment, the bus protocol and the address maps are all the HD44780's, and
 * they are identical across the two sizes. So it is ONE file named twice, not
 * two copies of one picture — the same call the download table makes for the
 * PDF (app/datasheets/sources.js).
 */
const LCD_DATASHEET = "HD44780";

/** The 16-way header, as a linear footprint: 16 holes along one grid row. */
const LCD_FOOTPRINT = Object.freeze({
  offsets: Object.freeze(Array.from({ length: 16 }, (_, i) => i)),
});

/*
 * `characterDisplay` — the ONE data hook generic code branches on to recognise
 * a character-LCD module (never a ref or an id test; the same house rule as
 * `switchBank` and `segments`). It carries the character grid AND the module's
 * mechanical drawing, because the view, the placement ghost, the footprint box
 * and the framebuffer all have to agree and there must be exactly one source
 * for them.
 *
 *   cols/rows   the character grid
 *   headerEdge  which PCB edge the 16-way header runs along, and therefore
 *               which way the body reaches off the hole row: "bottom" → it
 *               stands UP (seat it on a top row); "top" → it hangs DOWN (a
 *               bottom row). DERIVED from pin 1, never declared — see below
 *   body        the bare PCB — also the part's box in discrete-view.js
 *   window      the display module bonded to it (the metal frame)
 *   screen      the visible glass; the live character canvas sits exactly here
 *   charPitch   one character cell, centre to centre
 *
 * Every rectangle is in PITCH UNITS with the ORIGIN AT PIN 1's HOLE — the frame
 * components/discrete-view.js draws every seated part in.
 */

/** One HD44780 character cell as the panel lays it out: 5 × 8 dots, with a
    one-dot gap to the next cell. lcd-view.js's backing buffer is the same
    model, which is what keeps the drawn cells on the module's own pitch. */
const LCD_CELL = Object.freeze({ w: 5, h: 8, gap: 1 });

/** Millimetres → pitch units, to the 5 decimals a mechanical drawing is worth
    (0.03 µm — far below anything the desk can express or a ruler can read). */
const mm = (v) => Math.round((v / MM_PER_UNIT) * 1e5) / 1e5;

/**
 * Build a character-LCD module's mechanical drawing from the numbers a RULER
 * gives you — millimetres off the real part, which is the only form these
 * measurements ever arrive in:
 *
 *   pcb     the bare board: the module's outline, and the part's own box
 *   module  the display module bonded to it (the metal frame), CENTRED on it
 *   screen  the visible glass, CENTRED in the module
 *   pin1    the first header hole, in mm from the PCB's TOP-LEFT CORNER
 *
 * CONCENTRIC-AND-CENTRED IS THE WHOLE POSITIONING RULE. There is no fourth
 * offset to measure, and no way for two of the three rectangles to disagree
 * about where they sit — which is exactly what a hand-typed set of coordinates
 * could do (and did: the numbers these replaced were a different, much larger
 * industrial module's, scaled by nothing).
 *
 * Everything is then restated about PIN 1, because that is the origin the rest
 * of the app works in (discrete-view.js draws a seated part about its first
 * hole), so the PCB's own minX/minY come out negative.
 *
 * `pin1.y` is ALSO what says which edge the header runs along — nearer the top
 * of the PCB and the body hangs DOWN off the hole row, nearer the bottom and it
 * stands UP. Deriving `headerEdge` rather than declaring it beside the geometry
 * is what stops a module being drawn one way round and seated the other.
 *
 * `charPitch` is DERIVED, not measured: the active area is the character grid
 * with its own TRAILING inter-character gap trimmed, so a span of n characters
 * is `n · (cell + gap) − gap` dots wide and one cell is `(cell + gap)` of them.
 * That is the same arithmetic lcd-view.js sizes its backing buffer with, which
 * is what lands the drawn dots on the module's pitch instead of near it.
 */
function characterDisplay({ cols, rows, pcb, module: mod, screen, pin1 }) {
  const pitch = (span, n, cell) =>
    mm(
      (span / (n * (cell + LCD_CELL.gap) - LCD_CELL.gap)) *
        (cell + LCD_CELL.gap),
    );
  const modX = (pcb.w - mod.w) / 2;
  const modY = (pcb.h - mod.h) / 2;
  const screenX = modX + (mod.w - screen.w) / 2;
  const screenY = modY + (mod.h - screen.h) / 2;
  return Object.freeze({
    cols,
    rows,
    headerEdge: pin1.y < pcb.h / 2 ? "top" : "bottom",
    body: Object.freeze({
      minX: mm(-pin1.x),
      minY: mm(-pin1.y),
      width: mm(pcb.w),
      height: mm(pcb.h),
    }),
    window: Object.freeze({
      x: mm(modX - pin1.x),
      y: mm(modY - pin1.y),
      width: mm(mod.w),
      height: mm(mod.h),
    }),
    screen: Object.freeze({
      x: mm(screenX - pin1.x),
      y: mm(screenY - pin1.y),
      width: mm(screen.w),
      height: mm(screen.h),
    }),
    charPitch: Object.freeze({
      x: pitch(screen.w, cols, LCD_CELL.w),
      y: pitch(screen.h, rows, LCD_CELL.h),
    }),
  });
}

/** ONE controller drives both module sizes, so the behavior is declared once
    and referenced by both defs. DB0–DB7 are pins 7–14. */
const HD44780_LOGIC = hd44780Unit({
  rs: 4,
  rw: 5,
  e: 6,
  db: [7, 8, 9, 10, 11, 12, 13, 14],
});

/** The Properties dialog field both module sizes share. */
const LCD_PROPERTIES = [
  {
    key: "color",
    label: "Color",
    type: "color",
    options: LED_COLOR_OPTIONS,
  },
];

/**
 * Coerce a character-LCD module's params: the backlight colour, plus the same
 * `damaged` bookkeeping a chip's 12 V magic smoke needs.
 *
 * The damage latch is NOT optional here, unlike every other coloured discrete:
 * the engine power-gates this module like a chip (sim/engine.js powerStatus
 * reads params.damaged), and SimController#persistDamage round-trips the latch
 * back through here. Drop it and a smoked module revives on the next tick.
 */
function normalizeLcdParams(raw) {
  const params = {
    color: LED_COLOR_OPTIONS.includes(raw?.color) ? raw.color : "green",
  };
  if (raw?.damaged === true) params.damaged = true;
  return params;
}

/**
 * Coerce a rotated part's far lead to a `{dx, dy}` PITCH OFFSET from its
 * anchor hole, or null when the shape is junk.
 *
 * A bent lead is geometry, not an address: which hole it touches is resolved
 * from where it lands on the desk (occupancy.js), because the far hole may
 * belong to a DIFFERENT strip — typically a power rail. Storing the offset is
 * what lets a part keep its position when that rail is moved or deleted: the
 * lead simply stops resolving to a hole and floats, exactly as a real leg
 * would when you pull the rail out from under it.
 *
 * Both components must be integers so the lead stays on the 0.1-in lattice,
 * and (0, 0) is rejected — a two-terminal device pinned to one hole is
 * nonsense.
 */
export function normalizeLeadOffset(raw) {
  const q = (n) => Math.round(n * 100) / 100;
  const dx = q(Number(raw?.dx));
  const dy = q(Number(raw?.dy));
  // Two decimals, not whole pitches. A bend is the vector between two HOLES,
  // and since board-types.js started measuring the vertical geometry that is
  // not always a whole number: row a to a dovetailed rail's nearest row is
  // 2.76 (7.0 mm on a real board). Rounding it to 3 drew the lead 0.6 mm past
  // the hole it is electrically in; REFUSING it (which this did) dropped the
  // bend altogether and stood the part back up. Horizontally the vector is
  // still whole, because columns are.
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (dx === 0 && dy === 0) return null;
  // Rotating a bend negates a component, and negating zero gives -0: equal to
  // 0 under ===, distinct under Object.is, so it survives into the saved
  // document and then fails a deepStrictEqual round-trip. Fold it here, the
  // one chokepoint every stored bend passes through.
  return Object.freeze({ dx: dx === 0 ? 0 : dx, dy: dy === 0 ? 0 : dy });
}

/** Shared by both oscillator-can sizes: a simulated rate, the current
    quarter-turn orientation, plus the same `damaged` bookkeeping a chip's
    12 V "magic smoke" needs. */
function normalizeOscillatorParams(raw) {
  const params = {
    hz: OSCILLATOR_HZ.includes(raw?.hz) ? raw.hz : OSCILLATOR_HZ[0],
    rot: ROTATIONS.includes(raw?.rot) ? raw.rot : 0,
  };
  if (raw?.damaged === true) params.damaged = true;
  return params;
}

/**
 * A bank of `n` independent SPST switches in a DIP-2n body, straddling the
 * trench like a chip: switch k bridges pin k (row e) to pin 2n+1-k (row f) —
 * the pin DIRECTLY ACROSS the trench from it (model/footprints.js's
 * pinOffset: pin p ≤ n sits at dcol p-1 in row e, pin p > n at dcol 2n-p in
 * row f, so the two share a column exactly when q = 2n+1-p). Every
 * position's state is durable (params.states[i]) — the CONTROLLER owns the
 * write, the view only draws it (components/discrete-view.js's house rule).
 */
function dipSwitchBankDef(n) {
  const pins = 2 * n;
  return {
    id: `sw-dip${n}`,
    kind: "discrete",
    title: `DIP switch (${n}-position)`,
    blurb:
      `${n}-position DIP switch bank in a ${pins}-pin DIP (DIP-${pins}) — ` +
      `${n} independent SPST switch${n === 1 ? "" : "es"}, each bridging the ` +
      "two pins that face each other across the trench (switch k joins pin " +
      `k in row e to pin ${pins}+1-k in row f). Click a position's actuator ` +
      "to open or close it — it stays where you put it, and stays " +
      "clickable while the simulation runs. Press R with it selected to " +
      "flip it 180° in place, same as a chip.",
    group: "Switches",
    // Seats and derives pins with the same footprint machinery every DIP
    // chip uses (footprints.js) — not a chip, though: electrically it's n
    // independent switches.
    package: `DIP-${pins}`,
    // The data hook generic code (the view's artwork, the controller's
    // per-position click) branches on — never an id-prefix string test.
    switchBank: true,
    pins: [
      ...Array.from({ length: n }, (_, i) => ({
        n: i + 1,
        name: `${i + 1}A`,
        role: "contact",
      })),
      ...Array.from({ length: n }, (_, i) => ({
        n: n + i + 1,
        name: `${n - i}B`, // pin n+1 faces pin n, pin 2n faces pin 1
        role: "contact",
      })),
    ],
    normalizeParams(raw) {
      const raws = Array.isArray(raw?.states) ? raw.states : [];
      return {
        // Exactly n booleans: padded with false, trimmed, junk coerced.
        states: Array.from({ length: n }, (_, i) => raws[i] === true),
        // A chip-style half-lap flip, stored only when set (as bar8iso does).
        ...(raw?.rot === 180 ? { rot: 180 } : {}),
      };
    },
    // A closed position is a HARD bridge (a real switch contact), unlike the
    // resistor's weak coupling: pin i+1 ↔ pin 2n-i, the pair facing each
    // other across the trench.
    internalBridges(params) {
      const states = params?.states;
      if (!Array.isArray(states)) return [];
      const out = [];
      for (let i = 0; i < n; i++) {
        if (states[i] === true) out.push([i + 1, pins - i]);
      }
      return out;
    },
    // A bank is the one part whose click needs the INDEX: the body between two
    // actuators is a drag handle, not a switch, so a press that names no
    // position changes nothing and must say so.
    clickToggle(params, index) {
      const states = params?.states ?? [];
      if (!Number.isInteger(index) || index < 0 || index >= states.length) {
        return null;
      }
      // COPY: the document owns the stored array, and a history snapshot must
      // never alias it.
      const next = [...states];
      next[index] = !next[index];
      return { states: next };
    },
  };
}

/** Shared by both oscillator-can sizes — the Properties dialog's rate field. */
const OSCILLATOR_PROPERTIES = [
  {
    key: "hz",
    label: "Rate",
    type: "select",
    options: OSCILLATOR_HZ.map((hz) => ({ value: hz, label: `${hz} Hz` })),
  },
];

export const PART_DEFS = Object.freeze(
  [
    {
      id: "sw-slide",
      kind: "discrete",
      title: "Slide switch (SPDT)",
      blurb:
        "Single-pole double-throw slide switch — the center pin is common; " +
        "click to flip which side it bridges.",
      group: "Switches",
      footprint: Object.freeze({ offsets: Object.freeze([0, 1, 2]) }),
      pins: [
        { n: 1, name: "1", role: "contact" },
        { n: 2, name: "C", role: "common" },
        { n: 3, name: "2", role: "contact" },
      ],
      normalizeParams(raw) {
        return { pos: raw?.pos === "2" ? "2" : "1" };
      },
      // Common (pin 2) bridges to pin 1 or pin 3 depending on the slider.
      internalBridges(params) {
        return [[2, params?.pos === "2" ? 3 : 1]];
      },
      clickToggle(params) {
        return { pos: params?.pos === "2" ? "1" : "2" };
      },
    },
    {
      id: "sw-push",
      kind: "discrete",
      title: "Push button (momentary)",
      blurb:
        "Momentary SPST tactile button — bridges its two pins only while held.",
      group: "Switches",
      footprint: Object.freeze({ offsets: Object.freeze([0, 2]) }),
      pins: [
        { n: 1, name: "1", role: "contact" },
        { n: 2, name: "2", role: "contact" },
      ],
      normalizeParams() {
        return {}; // nothing durable — pressed state is transient
      },
      internalBridges(params, state) {
        return state?.pressed ? [[1, 2]] : [];
      },
    },
    {
      id: "sw-toggle",
      kind: "discrete",
      title: "Push button (toggle)",
      blurb:
        "Latching SPST push button — click to turn on, click again to " +
        "turn off.",
      group: "Switches",
      footprint: Object.freeze({ offsets: Object.freeze([0, 2]) }),
      pins: [
        { n: 1, name: "1", role: "contact" },
        { n: 2, name: "2", role: "contact" },
      ],
      normalizeParams(raw) {
        return { on: raw?.on === true };
      },
      internalBridges(params) {
        return params?.on ? [[1, 2]] : [];
      },
      clickToggle(params) {
        return { on: !params?.on };
      },
    },
    ...[1, 2, 4, 8].map(dipSwitchBankDef),
    {
      id: "led",
      kind: "discrete",
      title: "LED",
      blurb:
        "Light-emitting diode. Needs a series resistor whenever both legs " +
        "reach strongly driven nets (a supply rail, or a chip output) — " +
        "wired straight across the rails it burns out instead of lighting, " +
        "exactly as it would on a bench. Anode at the anchor hole; press F " +
        "while placing to flip polarity, R to stand it up and pick two free " +
        "ends (rail or column).",
      group: "LEDs",
      // Legs sit in ADJACENT holes — an LED needs no gap between its pins.
      footprint: Object.freeze({ offsets: Object.freeze([0, 1]) }),
      // Rotatable to the two-free-ends form (see the resistor): either leg can
      // move to any free hole, so an LED reaches any rail at any angle.
      rotatable: true,
      // One hole apart is fine — the legs only have to be in different holes.
      minSpan: 1,
      // Any def with a `colors` list arms placement with the "Default LED
      // color" setting instead of a placement-time swatch chooser (see
      // app.js's onPickChip); color is changed afterward via Properties.
      colors: LED_COLOR_OPTIONS,
      // The Properties dialog (context menu → "Properties…") — one control
      // per entry, dispatched generically by part-properties-dialog.js. Any
      // future part just adds its own `properties` list; the dialog and the
      // context-menu wiring never change.
      properties: [
        {
          key: "color",
          label: "Color",
          type: "color",
          options: LED_COLOR_OPTIONS,
        },
      ],
      pins: [
        { n: 1, name: "A", role: "anode" },
        { n: 2, name: "K", role: "cathode" },
      ],
      normalizeParams(raw) {
        const rotated = raw?.rot === 90;
        return {
          color: LED_COLOR_OPTIONS.includes(raw?.color) ? raw.color : "red",
          flip: raw?.flip === true,
          // Orientation: 0 = footprint form, 90 = two free ends.
          rot: rotated ? 90 : 0,
          // Pin 2's lead bend as a {dx, dy} pitch offset from the anchor —
          // only meaningful (and kept) when rotated. Resolved to a hole on
          // whatever strip lies under it; see normalizeLeadOffset.
          end: rotated ? normalizeLeadOffset(raw?.end) : null,
        };
      },
      internalBridges() {
        return []; // a diode is a device, not a bridge — Feature 90's job
      },
      // Which physical pin is the anode/cathode after an optional flip.
      polarity(params) {
        return params?.flip
          ? { anodePin: 2, cathodePin: 1 }
          : { anodePin: 1, cathodePin: 2 };
      },
    },
    {
      id: "seg8cc",
      kind: "discrete",
      title: "8-segment digit (common cathode)",
      blurb:
        "Single-block 7-segment numeric display plus decimal point (8 lit " +
        "segments), common cathode. Drive each segment anode (a–g, dp) HIGH " +
        "to light it; pin 9 (K) is the shared cathode — tie it to ground. " +
        "Comes in red / green / blue / yellow / white.",
      group: "LEDs",
      // Nine holes along one grid row: eight segment anodes then the common
      // cathode. Each segment is an LED and obeys sim/junction.js — a series
      // resistor in the common-cathode leg limits all eight at once.
      footprint: Object.freeze({
        offsets: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8]),
      }),
      pins: [
        { n: 1, name: "a", role: "anode" },
        { n: 2, name: "b", role: "anode" },
        { n: 3, name: "c", role: "anode" },
        { n: 4, name: "d", role: "anode" },
        { n: 5, name: "e", role: "anode" },
        { n: 6, name: "f", role: "anode" },
        { n: 7, name: "g", role: "anode" },
        { n: 8, name: "dp", role: "anode" },
        { n: 9, name: "K", role: "cathode" },
      ],
      // Each segment is an LED between its anode pin and the shared cathode
      // (pin 9). Pure data — the sim-overlay lights each with the LED rule.
      segments: Object.freeze(
        ["a", "b", "c", "d", "e", "f", "g", "dp"].map((id, i) =>
          Object.freeze({ id, anodePin: i + 1, cathodePin: 9 }),
        ),
      ),
      // Same color set + Properties-dialog field as the LED — no placement-
      // time popover; color is changed afterward via the context menu.
      colors: LED_COLOR_OPTIONS,
      properties: [
        {
          key: "color",
          label: "Color",
          type: "color",
          options: LED_COLOR_OPTIONS,
        },
      ],
      normalizeParams(raw) {
        return {
          color: LED_COLOR_OPTIONS.includes(raw?.color) ? raw.color : "red",
        };
      },
      internalBridges() {
        return []; // segments are diodes — devices, not bridges (Feature 90)
      },
    },
    {
      id: "seg8ca",
      kind: "discrete",
      title: "8-segment digit (common anode)",
      blurb:
        "Single-block 7-segment numeric display plus decimal point (8 lit " +
        "segments), common ANODE. Tie pin 9 (A) to VCC; pull each segment " +
        "cathode (a–g, dp) LOW to light it — the form a 74LS47 (active-low " +
        "outputs) drives directly. Comes in red / green / blue / yellow / " +
        "white.",
      group: "LEDs",
      // Nine holes along one grid row: eight segment cathodes then the shared
      // anode. Each segment is an LED and obeys sim/junction.js — a series
      // resistor in the common-anode leg limits all eight at once.
      footprint: Object.freeze({
        offsets: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8]),
      }),
      pins: [
        { n: 1, name: "a", role: "cathode" },
        { n: 2, name: "b", role: "cathode" },
        { n: 3, name: "c", role: "cathode" },
        { n: 4, name: "d", role: "cathode" },
        { n: 5, name: "e", role: "cathode" },
        { n: 6, name: "f", role: "cathode" },
        { n: 7, name: "g", role: "cathode" },
        { n: 8, name: "dp", role: "cathode" },
        { n: 9, name: "A", role: "anode" },
      ],
      // Each segment is an LED from the shared anode (pin 9) to its own cathode
      // pin — the mirror of seg8cc. It lights when pin 9 is HIGH and the segment
      // pin is driven LOW (the LED rule in sim-overlay), which is exactly what a
      // 74LS47's active-low outputs do.
      segments: Object.freeze(
        ["a", "b", "c", "d", "e", "f", "g", "dp"].map((id, i) =>
          Object.freeze({ id, anodePin: 9, cathodePin: i + 1 }),
        ),
      ),
      // Same color set + Properties-dialog field as the LED — no placement-
      // time popover; color is changed afterward via the context menu.
      colors: LED_COLOR_OPTIONS,
      properties: [
        {
          key: "color",
          label: "Color",
          type: "color",
          options: LED_COLOR_OPTIONS,
        },
      ],
      normalizeParams(raw) {
        return {
          color: LED_COLOR_OPTIONS.includes(raw?.color) ? raw.color : "red",
        };
      },
      internalBridges() {
        return []; // segments are diodes — devices, not bridges (Feature 90)
      },
    },
    {
      id: "bar8",
      kind: "discrete",
      title: "8-segment LED bar",
      blurb:
        "Eight-segment LED bar graph, common cathode. Drive each bar's anode " +
        "(1–8) HIGH to light it; pin 9 (K) is the shared cathode — tie it to " +
        "ground. Comes in red / green / blue / yellow / white.",
      group: "LEDs",
      // Nine holes along one grid row: eight bar anodes then the common cathode.
      footprint: Object.freeze({
        offsets: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8]),
      }),
      pins: [
        { n: 1, name: "1", role: "anode" },
        { n: 2, name: "2", role: "anode" },
        { n: 3, name: "3", role: "anode" },
        { n: 4, name: "4", role: "anode" },
        { n: 5, name: "5", role: "anode" },
        { n: 6, name: "6", role: "anode" },
        { n: 7, name: "7", role: "anode" },
        { n: 8, name: "8", role: "anode" },
        { n: 9, name: "K", role: "cathode" },
      ],
      segments: Object.freeze(
        ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((id, i) =>
          Object.freeze({ id, anodePin: i + 1, cathodePin: 9 }),
        ),
      ),
      // Same color set + Properties-dialog field as the LED — no placement-
      // time popover; color is changed afterward via the context menu.
      colors: LED_COLOR_OPTIONS,
      properties: [
        {
          key: "color",
          label: "Color",
          type: "color",
          options: LED_COLOR_OPTIONS,
        },
      ],
      normalizeParams(raw) {
        return {
          color: LED_COLOR_OPTIONS.includes(raw?.color) ? raw.color : "red",
        };
      },
      internalBridges() {
        return []; // each bar is a diode — a device, not a bridge (Feature 90)
      },
    },
    {
      id: "bar8iso",
      kind: "discrete",
      title: "8-segment LED bar (isolated)",
      blurb:
        "Eight-segment LED bar graph in a 16-pin DIP package — each bar is an " +
        "INDEPENDENT LED with its own anode and cathode (no shared pin). It " +
        "straddles the trench like a chip: anodes A1–A8 in row e, cathodes " +
        "K1–K8 in row f. Drive a bar's anode HIGH and pull its cathode LOW to " +
        "light it. Comes in red / green / blue / yellow / white. Press R with it " +
        "selected to flip it 180° in place, same as a chip — the holes it " +
        "occupies never move, only which anode/cathode sits in which; its " +
        "pin dialog updates to match.",
      group: "LEDs",
      // A 16-pin DIP straddling the trench: the anode/cathode of each bar face
      // each other across a column, so it seats and derives pins with the same
      // footprint machinery every DIP chip uses (footprints.js). Not a chip,
      // though — electrically it's eight LEDs, lit by the sim-overlay.
      package: "DIP-16",
      // Anodes A1–A8 are pins 1–8 (row e, left→right); cathodes K8–K1 are pins
      // 9–16 (row f, right→left), so bar i's cathode (pin 17-i) sits directly
      // across the trench from its anode (pin i).
      pins: [
        ...Array.from({ length: 8 }, (_, i) => ({
          n: i + 1,
          name: `A${i + 1}`,
          role: "anode",
        })),
        ...Array.from({ length: 8 }, (_, i) => ({
          n: i + 9,
          name: `K${8 - i}`,
          role: "cathode",
        })),
      ],
      // Each bar is an LED between its own anode pin and its own cathode pin —
      // pure data, lit by the sim-overlay with the same rule as a single LED.
      segments: Object.freeze(
        Array.from({ length: 8 }, (_, i) =>
          Object.freeze({
            id: `s${i + 1}`,
            anodePin: i + 1,
            cathodePin: 16 - i,
          }),
        ),
      ),
      // Same color set + Properties-dialog field as the LED — no placement-
      // time popover; color is changed afterward via the context menu.
      colors: LED_COLOR_OPTIONS,
      properties: [
        {
          key: "color",
          label: "Color",
          type: "color",
          options: LED_COLOR_OPTIONS,
        },
      ],
      // `rot: 180` is a chip-style half-lap flip (model/occupancy.js's
      // `def.package` branch) — same holes, reversed pin numbering; press R
      // with it selected. Preserve it the same way CHIP_DEFS's shared
      // normalizeParams does (catalog/index.js) — this def isn't wrapped by
      // that, since it's a PART_DEFS discrete, not a chip.
      normalizeParams(raw) {
        return {
          color: LED_COLOR_OPTIONS.includes(raw?.color) ? raw.color : "red",
          ...(raw?.rot === 180 ? { rot: 180 } : {}),
        };
      },
      internalBridges() {
        return []; // each bar is a diode — a device, not a bridge (Feature 90)
      },
    },
    {
      id: "resistor",
      kind: "discrete",
      title: "Resistor",
      blurb:
        "Two-terminal resistor. In this logic-level sim it's a WEAK coupler: " +
        "it conducts one end's driven level to the other at a strength below " +
        "any chip output, so it behaves as a pull-up / pull-down / series " +
        "resistor. The ohms value is cosmetic (no analog current here). " +
        "Press R while placing to stand it vertically and pick two free ends " +
        "(e.g. a power rail and a grid column).",
      group: "Resistors",
      footprint: Object.freeze({ offsets: Object.freeze([0, 3]) }),
      // Rotatable to a vertical, two-free-ends form: pin 1 at the anchor hole,
      // pin 2 bent to the `params.end` offset. The seating model switches from
      // footprint-offset to a free lead, so pin 2 can reach ANY hole at any
      // angle — including one on a neighbouring strip, e.g. a power rail.
      rotatable: true,
      // Leads can't be bent closer than the body is long: the two ends must
      // sit at least this far apart (pitch units). 2.5 is a quarter-watt body
      // (~6.3 mm) and NOT the 3 it used to be, which was a lattice artefact:
      // the closest pins across a rail↔pin-board dovetail are 2.76 apart
      // (7.0 mm, measured — board-types.js), so a whole-pitch minimum forbade
      // the commonest bench move there is, taking power off the rail into a
      // row. In-row spans are unaffected: two columns is still 2, still too
      // close, and three is still the shortest that fits.
      minSpan: 2.5,
      pins: [
        { n: 1, name: "1", role: "lead" },
        { n: 2, name: "2", role: "lead" },
      ],
      normalizeParams(raw) {
        const ohms = Number(raw?.ohms);
        const rotated = raw?.rot === 90;
        return {
          ohms: Number.isFinite(ohms) && ohms > 0 ? ohms : 10000,
          // Orientation: 0 = horizontal footprint, 90 = vertical two-end form.
          rot: rotated ? 90 : 0,
          // Pin 2's lead bend as a {dx, dy} pitch offset from the anchor —
          // only meaningful (and kept) when rotated. Resolved to a hole on
          // whatever strip lies under it; see normalizeLeadOffset.
          end: rotated ? normalizeLeadOffset(raw?.end) : null,
        };
      },
      // A resistor is NOT a hard conductor — its two ends stay separate nets
      // (unlike a wire or a closed switch), so it declares no internal bridges.
      internalBridges() {
        return [];
      },
      // …instead the two leads are WEAKLY coupled: the simulator (resolve.js's
      // PULL tier) conducts one end's strong H/L to the other at the weakest
      // drive strength. `weakBridges` lists the coupled pin pairs (data, not a
      // code path) — a resistor could carry more, but this one bridges 1↔2.
      weakBridges() {
        return [[1, 2]];
      },
    },
    {
      id: "rnet9",
      kind: "discrete",
      title: "Resistor array (bussed, 9-pin)",
      blurb:
        "Bussed resistor network in a 9-pin SIP, numbered as the real part " +
        "is: pin 1 (COM) is the shared bus — the end the printed dot marks — " +
        "and pins 2–9 each reach it through their own resistor. Tie COM to " +
        "ground for eight pull-downs, or to +V for eight pull-ups — like the " +
        "single resistor, each element is a WEAK coupler (below any chip " +
        "output), never a hard connection. Press R while placing, or with it " +
        "selected, to turn it end-for-end: the dot, pin 1 and the common bus " +
        "all move to the other end. The ohms value is cosmetic.",
      group: "Resistors",
      // Nine holes along one grid row: the common bus first (pin 1, at the
      // anchor — the marked end), then the eight resistor pins.
      footprint: Object.freeze({
        offsets: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8]),
      }),
      // Turns end-for-end in place (params.rot 180). The holes are evenly
      // spaced, so the flipped part covers the SAME nine — only the numbering
      // reverses, exactly as a DIP's half lap does (model/occupancy.js). The
      // hook is data, so nothing branches on the id; the catalog test holds
      // every `reversible` def to a palindromic offset list, which is what
      // makes "same holes, reversed pins" true.
      reversible: true,
      pins: [
        { n: 1, name: "COM", role: "common" },
        ...Array.from({ length: 8 }, (_, i) => ({
          n: i + 2,
          name: `${i + 2}`,
          // Named for its own pin number, so `rnet9.4` has one reading —
          // model/pin-resolve.js reports an ambiguity when a part's names and
          // numbers disagree, and a bussed SIP's element pins have no other
          // name on any datasheet.
          role: "lead",
        })),
      ],
      normalizeParams(raw) {
        const ohms = Number(raw?.ohms);
        return {
          ohms: Number.isFinite(ohms) && ohms > 0 ? ohms : 10000,
          // Stored only when set (as sw-dip8 and bar8iso do), so an unturned
          // part round-trips byte-identical.
          ...(raw?.rot === 180 ? { rot: 180 } : {}),
        };
      },
      // Like the single resistor, an element never hard-bridges — its two ends
      // stay separate nets (the coupling is weak, below any chip output).
      internalBridges() {
        return [];
      },
      // …instead each of pins 2–9 is WEAKLY coupled to the common bus (pin 1):
      // the simulator's PULL tier conducts COM's strong level out to every free
      // pin at the weakest strength. Eight independent pulls, one shared bus.
      // Stated in PIN numbers, so a flipped part needs nothing here — the pins
      // move, the elements they name do not.
      weakBridges() {
        return Array.from({ length: 8 }, (_, i) => [i + 2, 1]);
      },
    },
    {
      id: "psu",
      kind: "psu",
      title: "Power supply",
      blurb:
        "Bench power brick (3 V / 5 V / 12 V) with addressable + and − " +
        "terminals — wire them into a board's rails.",
      group: "Power",
      // Desk outline (pitch units) and terminal pads at INTEGER offsets so
      // wired terminals land on the global 0.1-in lattice.
      size: Object.freeze({ width: 8, height: 5 }),
      terminals: [
        { id: "+", dx: 2, dy: 4 },
        { id: "-", dx: 6, dy: 4 },
      ],
      // The Properties dialog (context menu → "Properties…") — a live input,
      // so this field applies with no lock/undo-gap even while the sim runs.
      properties: [
        {
          key: "volts",
          label: "Voltage",
          type: "select",
          options: PSU_VOLTS.map((v) => ({ value: v, label: `${v} V` })),
        },
      ],
      normalizeParams(raw) {
        return { volts: PSU_VOLTS.includes(raw?.volts) ? raw.volts : 5 };
      },
      // Terminal potentials for the simulator (Feature 90).
      source(params) {
        return { plus: params?.volts ?? 5, minus: 0 };
      },
    },
    {
      id: "clock",
      kind: "clock",
      title: "Clock source",
      blurb:
        "Square-wave clock (1 / 2 / 5 / 10 / 20 / 50 / 100 Hz, or manual " +
        "click-to-toggle) with an `out` terminal and a `gnd` reference — wire " +
        "it to a chip's clock pin.",
      group: "Power",
      size: Object.freeze({ width: 8, height: 5 }),
      terminals: [
        { id: "out", dx: 2, dy: 4 },
        { id: "gnd", dx: 6, dy: 4 },
      ],
      // The Properties dialog — a live setting, so it applies while running.
      properties: [
        {
          key: "hz",
          label: "Rate",
          type: "select",
          options: CLOCK_HZ.map((hz) => ({
            value: hz,
            label: hz === "manual" ? "Manual" : `${hz} Hz`,
          })),
        },
      ],
      normalizeParams(raw) {
        return { hz: CLOCK_HZ.includes(raw?.hz) ? raw.hz : 1 };
      },
      /** Is this clock free-running (has a rate) rather than manual? */
      isAuto(params) {
        return params?.hz !== "manual";
      },
    },
    {
      id: "osc-full",
      kind: "discrete",
      title: "Oscillator (full can)",
      blurb:
        "Crystal-oscillator can, full size — a rectangular metal can with " +
        "just 4 legs at its corners (7 holes by 4 holes, body overhanging " +
        "half a hole on every side). Seats anywhere, any row — including " +
        "straddling the centre channel; press R while placing to spin the " +
        "ghost a quarter turn at a time, or with it selected to flip an " +
        "already-seated can end-for-end (180°). A free-running square-wave " +
        "source, powered like a chip: NC, GND, OUTPUT, VCC.",
      group: "Oscillators",
      // The rigid footprint's full pitch-unit extents (rot 0): 6 units long
      // (7 holes) by 3 units deep (4 holes) — see model/occupancy.js's
      // `def.can` branch and model/breadboard.js's rotateOffset for how the
      // 4 corner pins derive from this at any quarter-turn.
      can: Object.freeze({ width: 6, height: 3 }),
      pins: [
        { n: 1, name: "NC", role: "nc" },
        { n: 2, name: "GND", role: "gnd" },
        { n: 3, name: "OUT", role: "output" },
        { n: 4, name: "VCC", role: "vcc" },
      ],
      // A self-clocking source: the engine drives the output
      // pin from clockPhase instead of evaluating logic.units.
      logic: Object.freeze({ oscillator: true }),
      properties: OSCILLATOR_PROPERTIES,
      normalizeParams: normalizeOscillatorParams,
      internalBridges() {
        return []; // the output is DRIVEN by the engine, never a passive bridge
      },
    },
    {
      id: "osc-half",
      kind: "discrete",
      title: "Oscillator (half can)",
      blurb:
        "Crystal-oscillator can, half size — a rectangular metal can with " +
        "just 4 legs at its corners (4 holes by 4 holes, body overhanging " +
        "half a hole on every side). Seats anywhere, any row — including " +
        "straddling the centre channel — and turns in 90° steps; press R " +
        "while placing (or with it selected) to spin it. NC, GND, OUTPUT, VCC.",
      group: "Oscillators",
      // 3 pitch-units square (4 holes by 4 holes) at rot 0.
      can: Object.freeze({ width: 3, height: 3 }),
      pins: [
        { n: 1, name: "NC", role: "nc" },
        { n: 2, name: "GND", role: "gnd" },
        { n: 3, name: "OUT", role: "output" },
        { n: 4, name: "VCC", role: "vcc" },
      ],
      logic: Object.freeze({ oscillator: true }),
      properties: OSCILLATOR_PROPERTIES,
      normalizeParams: normalizeOscillatorParams,
      internalBridges() {
        return [];
      },
    },
    {
      id: "lcd16x2",
      kind: "discrete",
      title: "Character LCD 16×2 (HD44780)",
      blurb:
        "Hitachi HD44780 character-LCD module, 16 columns × 2 rows (the " +
        "standard 1602A, 80 × 36 mm). Its 16-way header runs along the " +
        "module's TOP edge and plugs into 16 holes along one row, so the body " +
        "hangs BELOW that row — seat it on a bottom row (a) and it clears the " +
        "board it is plugged into. Wire " +
        "VDD/VSS to a 5 V rail, then drive it over the parallel bus: put a " +
        "command or character code on DB0–DB7, set RS (0 = instruction, " +
        "1 = data) and R/W (0 = write), and pulse E — the byte latches on E's " +
        "falling edge. V0 (contrast) and A/K (backlight) are cosmetic here. " +
        "During a read the module drives DB0–DB7, so tri-state whatever else " +
        "is on the bus.",
      group: "Displays",
      footprint: LCD_FOOTPRINT,
      pins: LCD_PINOUT.map((p) => Object.freeze({ ...p })),
      datasheet: LCD_DATASHEET,
      // Measured off a real 1602A: 80 × 36 mm of PCB, a 71 × 24 mm module, and
      // 65 × 15 mm of visible glass, with pin 1's centre 7.5 mm in from the left
      // edge and 2.5 mm down from the top one.
      characterDisplay: characterDisplay({
        cols: 16,
        rows: 2,
        pcb: { w: 80, h: 36 },
        module: { w: 71, h: 24 },
        screen: { w: 65, h: 15 },
        pin1: { x: 7.5, y: 2.5 },
      }),
      colors: LED_COLOR_OPTIONS,
      properties: LCD_PROPERTIES,
      normalizeParams: normalizeLcdParams,
      internalBridges() {
        return []; // a module is a device, not a bridge — Feature 90's job
      },
      logic: HD44780_LOGIC,
    },
    {
      id: "lcd20x4",
      kind: "discrete",
      title: "Character LCD 20×4 (HD44780)",
      blurb:
        "Hitachi HD44780 character-LCD module, 20 columns × 4 rows (the " +
        "standard 2004A, 98 × 60 mm). The pin assignment is identical to the " +
        "16×2's, and so is the seating: the header is along the module's TOP " +
        "edge, so the body hangs BELOW the row it plugs into — seat it on a " +
        "bottom row (a) and it clears the board. Wire VDD/VSS to a 5 V rail, " +
        "then drive it over " +
        "the parallel bus: put a command or character code on DB0–DB7, set RS " +
        "(0 = instruction, 1 = data) and R/W (0 = write), and pulse E — the " +
        "byte latches on E's falling edge. V0 (contrast) and A/K (backlight) " +
        "are cosmetic here. During a read the module drives DB0–DB7, so " +
        "tri-state whatever else is on the bus.",
      group: "Displays",
      footprint: LCD_FOOTPRINT,
      pins: LCD_PINOUT.map((p) => Object.freeze({ ...p })),
      datasheet: LCD_DATASHEET,
      // Measured off a real 2004A: 98 × 60 mm of PCB, a 97 × 40 mm module (it
      // spans very nearly the full width — the bands the header and the badge
      // live in are the ones above and below it), and 77 × 26 mm of glass. The
      // header sits the SAME 2.5 mm off its edge as the 16×2's: the boards are
      // different sizes, the row of pins is the same part on both.
      characterDisplay: characterDisplay({
        cols: 20,
        rows: 4,
        pcb: { w: 98, h: 60 },
        module: { w: 97, h: 40 },
        screen: { w: 77, h: 26 },
        pin1: { x: 8.5, y: 2.5 },
      }),
      colors: LED_COLOR_OPTIONS,
      properties: LCD_PROPERTIES,
      normalizeParams: normalizeLcdParams,
      internalBridges() {
        return [];
      },
      logic: HD44780_LOGIC,
    },
  ].map(Object.freeze),
);

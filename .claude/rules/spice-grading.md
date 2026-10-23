---
paths:
  - "src/web/scripts/tests/spice-golden*"
  - "scripts/spice-*.mjs"
  - "src/web/scripts/sim/spice/output-stage.js"
  - "src/web/scripts/sim/spice/params.js"
  - "src/web/scripts/tests/spice-ls-*.test.js"
---

## Graded against ngspice

The golden suite (`make spice-golden`), the deck it writes (`scripts/spice-deck.mjs`)
and the areas graded — with the 74LS stage and input tables that grading produced.
Split out of `spice-lite.md` on 2026-10-23.

- **Graded against ngspice** (2026-10-08, `features/done/spice-lite-3-plan.md` Phase 0).
  `tests/spice-golden-cases.js` holds the circuits (built with `timing-fixtures.js`'s
  `bench()`), the rubric (`TOLERANCE`: A 2 % / 20 mV, B 10 % / 50 mV, C 50 %) and each
  area's FLOOR and TARGET; `spice-golden.test.js` runs Spice Lite on each against the
  committed `tests/spice-golden/<area>.json` and prints the scorecard. Below its floor an
  area FAILS (raise the floor when the test says it beat it); below its target it is a
  `todo` until its phase is in `LANDED`. A transient case is re-run with ticks on a grid
  beside its wakes, and an answer that moves by more than `INVARIANCE` (1e-4 — the solve's
  nanoamp tolerance moves a 10 kΩ node 1e-5 V) is held to C. **References come from
  `make spice-golden`** (needs ngspice; `GOLDEN=<case|area>` for some):
  `scripts/spice-deck.mjs` writes a deck from the SAME document through the engine's own
  readers (netlist, `lampTopology`, `capacitorNets`, part pins) — `same` (Spice Lite's
  own models as behavioural sources, read from params/output-stage/leds/diodes/network
  exports, so a model change needs no deck change — a curved stage is a `pwl()` through
  `stageCorners`), `device` (vendor cards and the datasheet fits in `DEVICE_MODELS`; a
  CD4000 output is a level-1 pair per supply and strength, `cmosChannel`: VTO = VDD −
  vov, KP = 2·limit/vov²) or `ideal` (no comparator bias currents — the 555's
  formula). A part with no behavioural block throws `Unsupported`; add a block (gate units
  and the NE555 exist) rather than leaving it out. Deck lessons: a latch or Schmitt memory
  must be REGENERATIVE (`V(m)>0.5?1:0`, not `V(m)`) or it stops part-way; the 555's DISCH
  switches on the latch's SETTLED level or it chatters at THRES = CONT; every node gets
  the engine's GMIN to ground; and an ideal-threshold gate biased at its own threshold
  through a resistor (a 74LS two-gate astable) has no ngspice answer at all. Each JSON
  records its ngspice version: 42 → 44.2 moved nothing but the NE555's `ideal` periods
  (+0.3 %) and the CD40106B pair (0.03 %), measured on the unchanged deck. On
  2026-10-13 EVERY area was regenerated on 44.2 (so all are one version): nothing moved
  but `ne555` (+0.3 %, Spice Lite still A, worst −0.32 %) and `inductors` (3e-9).
  Regenerate an area only when its model moved, and say so.
  A reading can be of a LATER moment than asked: a tick re-linearizes every corner within
  `FAST_WINDOW_S` (10 µs) of the last one past its own target, chained, so a node on a
  curve with close corners shows where it is a few µs on. The 10 V CMOS case's 1.3 % at
  0.4/0.5 ms is that, not the curve (every corner within 0.07 % of the exact square law).
- **74LS stages and mixed circuits are graded too** (2026-10-13, areas `ls-stage` and
  `mixed`, both `device`, both **A**, floor A). In the device flavour a 74LS INV/NAND
  unit is its datasheet schematic transistor by transistor (`spice-deck.mjs` `lsGate`,
  SN74LS04 SDLS029C p. 4: Schottky input diodes into a 20 kΩ phase splitter, the
  8 kΩ / 120 Ω Darlington with 4 kΩ to Y, the 1.5k/3k squaring network), so its input
  current, threshold and both levels are the circuit's own; its devices (`QLS`, `QLSO`,
  `DLS` in `DEVICE_MODELS`) are FITTED to the sheet's typicals at VCC 4.75 V (VOH 3.37 V
  at −0.4 mA, VOL 0.30/0.35 V at 4/8 mA, IIL −0.18 mA, threshold ~0.94 V). They graded
  C against the old line stage (VCC − 1.4 V behind 120 Ω; 0.15 V behind 25 Ω): −14 % at
  100 kΩ, −16 % on a 10 kΩ/1 µF RC, the LS-timed ring's HIGH half +17 %. Two changes
  took both to A:
  - **The 74LS stage is the swept gate's I-V table** (`LS_HIGH_MA`, `LS_LOW_MA`,
    `lsHighTable` in output-stage.js). HIGH: open at VCC − 0.49 V (the same curve at
    4.75–5.25 V, measured from its open level, within 2 mV), a soft knee to 3.6 V by
    0.2 mA, ~120 Ω past it, shorting at 31.8 mA (5 V); the table ends at 24 mA and runs
    on at 8.02 mA/V to the pin at 0 V, then saturates. LOW: open at 0.2044 V, plateau
    18.5 mA (0.6–1.4 V — so a HIGH/LOW fight sits at ~1.54 V, X to a reader, under the
    20 mA warning: the transistor gates meet at 1.57), then 152 mA past 2.6 V above it
    (a LOW shorted to VCC still smokes). The LOW's CURRENTS follow VCC (`lsLowTable`,
    2026-10-13: one corner set, `LS_LOW_D`, swept at 4.75/5/5.25 V — plateau
    16.8/18.5/20.2 mA, open level the same within 0.3 mV — straight lines between,
    held at the nearer outside; cases `ls-low-220-*v` / `ls-high-2k2-*v` grade both
    stages across the range; 220 Ω's load line lies along the plateau, so a chord
    there must stay flat: the corner at 1.238 V). `ohms` stays
    120/25 as a REPRESENTATIVE slope only (`offStageSlope`'s Newton guide). `scale` /
    strength multiply the table's currents, never its volts. Any curved stage is
    `isCurved` (a `vov` or `corners`); `stageCorners`/`cornersOf` return a table's own.
  - **The phase splitter's current** (`splitterAmps`, `SPLITTER_UA`): an LS INV/NAND
    input held LOW above ground (an LS LOW's 0.21 V) leaves the pull-down part-way on —
    a current out of the HIGH output to GND set by the LOWEST input alone (15 µA at
    0.2 V, 54 µA at 0.4 V, held past 0.8 V; independent of the output's volts from 1 to
    4 V and of VCC; ramped to 0 under 0.2 V on the output). Nothing to a mA load, but the
    HIGH's knee 75 mV lower on the ring's 10 kΩ — the last 3.5 %. It is network.js
    device kind **"t"** (`{out, gnd, ins}`), there only while that output is HIGH
    (`deviceBranch`), its inputs read like a MOSFET's gate (`gateUsers` orders/re-solves;
    NOT in `gates`, so a floating TTL input keeps no charge — `settleNet` re-solves on
    `gateUsers` and keeps voltage on `gates`), no join. `splitterUnits(def)` is the one
    predicate (74LS, INV/NAND units, no `outputStage`/`schmitt`/`openCollector`), shared
    with the deck's same flavour (`splitterExpr`, B-source gated by the unit's level).
    A LONE net keeps its fast path: `isLone` admits "t" devices to a rail whose inputs
    are other nets, and `loneStages` adds each as a one-way sink stage
    (`splitterStage`, two corners), booked in lone `flows` by hand.
  - **The 74LS input is the same gate's swept input** (`TTL_INPUT` in params.js, a
    `corners` stage like the outputs'): it was a flat 200 µA to 0.9 V falling to none at
    1.3 V, which read the 470 Ω pull-down case 9 % low (A only by the 20 mV floor); the
    table reads both pull-downs within 0.2 %. Its switch at 1.08–1.1 V is a 20 mV cliff
    (the gate regenerates), so a 10 kΩ pull-down — or a 10k/2.2k divider — rests ON it,
    and a tick runs that corner inside itself; a node charging through it is woken at
    each of its other corners (`spice-engine.test.js` `throughCorners`).
  The same-flavour deck mirrors both exactly (ring and RC identical to Spice Lite in
  ngspice). Cases: `ls-chain` / `ls-nand-chain` grade the splitter (an inverter chain's
  third HIGH 4.10 V into 100 kΩ). Spice Lite still READS a 74LS input by the sheet's
  VIL 0.8 / VIH 2 bands (the transistor gate switches at ~1 V), so a diode-AND on an LS
  LOW through 10 kΩ (0.82 V) reads X. Mind the bench layout in a case: two parts in the
  same column half are one node (the first mixed oscillator shorted its RC that way).
- **Clock waves and bench parts are graded too** (2026-10-13, areas `waves` and
  `bench-parts`, both **A**, floor A — the accuracy review's §5 hand comparisons made
  mechanical). The harness runs clock bricks as SimController does (`measure`'s
  `clocksAt`: edges from Run, LOW first, `clockPhase`/`clockTimes` into each tick via
  `runner.run`'s third argument; edges are ticks). The deck writes a WAVE clock as the
  ideal source Spice Lite makes it (`waveSource`: SIN for the sine, else PWL through every
  corner, one period past `stop` — a float `k·period ≤ stop` once dropped the last
  period); a square/PWM clock throws `Unsupported`. Bench parts are their
  analog-devices.js laws as B-sources in either flavour (`benchBlock`, read through
  `benchDevices`; the chip loop skips `optocoupler`/`opAmps` defs) — `same` cases, since
  no vendor model exists: they grade the SOLVE. A ULN2003A (`arrayBlock`) is device-only:
  its 2.7 kΩ, each channel's Darlington as its `ARRAY_MODELS` figures' cards, its clamp a
  1N4148 to COM. A case's output must reach something or the deck leaves its unit out
  (the Schmitt wave case reads its output across 100 kΩ for that reason).
- **The CD4000 timers are graded too** (2026-10-13, area `cd4000-timers`, `device`,
  **A**, worst 0.25 %). The deck writes each silicon block by hand in `chipBlock` (as the
  555's): the 4060/4541 oscillator's two inverters (input read at the family trigger,
  in-phase output and complement — Fig. 12 / Fig. 2's Cx, Rx, Rs close the loop, the
  input's clamps carrying the junction's swing past the rails); the 4047 astable (RC
  COMMON at ½·VDD, C/OSC in phase, R against, Q a master–slave toggle); and each dual
  monostable section (`def.logic.sections` — the silicon now exports its section pins
  for this — trigger edge = the trigger against its own gate-delayed copy, a discharge
  bit and a Q bit as regenerative `memory`s, the window comparators from
  `def.logic.sense`, the discharge `stageExpr`). Their outputs are the family's MOSFET
  pairs. The monostable cases need ngspice's step at 2 µs: at the period's own step it
  overshot the 5 % comparator by 30 mV through the ~83 Ω discharge (−1.3 %, ngspice's
  error). The harness now ticks every signal-flag switch for `period` cases too (it did
  for `tran` only, so a 1 ms trigger pulse was never seen). The 4541's 2.23·RC against
  its sheet's 2.3 is unchanged: ngspice agrees with the network to 0.06 %, so the gap is
  the sheet's rounded formula (the 4060's sheet says 2.2 for the same network).

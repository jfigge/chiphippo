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
  `bench()`), the rubric (`TOLERANCE`: A 2 % / 20 mV, B 10 % / 50 mV, C 50 %) and the
  areas; `spice-golden.test.js` runs Spice Lite on each against the committed
  `tests/spice-golden/<area>.json` and prints the scorecard. EVERY case is held to A, one
  subtest each (2026-10-26 — the per-area floors, targets and `LANDED` phases are gone;
  see "The golden accuracy guard" below). A transient case is re-run with ticks on a grid
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
  Since phase 7 (2026-10-27) not on an island with no chip on it, nor a wave's, budget or
  not (`cornerWaits`; a 1N4148 clamp read 50 µs late); still on a transistor's — the
  `known` case `coupled-edge-npn-base` (held to its moment it is A, but that desk ran 9 %
  slower, so it waited on Jason — shipped in wave 2b, 2026-10-27, `settlingWaits`, A, no
  `known` left). Wave 2b also regenerated `coupled-stages` and `waves` (a square clock's
  50 Ω in the deck: `coupled-speaker-500hz`, the `coupled-edge-*` cases and the two
  square/PWM low-pass cases moved — the physics of a 50 Ω source; added
  `coupled-edge-diode-clamp`/`-pump`, 1N4148s, read before the pump's falling edge as its
  output just after moves 3 µV with the tick spacing) and `mosfet-on`/`mosfet-threshold`
  (the P grades' fitted body diodes; `pmos-body-TO-92-10k`/`TO-220-1k` added).
- **Phase 7's deck fixes and cases** (2026-10-27): the same flavour's BJT carries the
  base resistance's drop under the COLLECTOR junction's base current as a source to an
  internal base (`BX`, as `bjtAt`'s u + RB·IR/BR = VBE) — it read VBE up to 0.4 V low in
  deep saturation; regenerating every area moved only `relay-flyback`/`relay-kick` (onto
  Spice Lite's values, ≤ 0.02 %). The device flavour draws a discrete MOSFET's body diode
  as its grade's card (`DB…`, `m.body.device`; the level-1 card's bulk junctions off,
  `IS=1e-30`): `mosfet-on`/`mosfet-threshold`/`transistor-circuits` moved ≤ 0.07 %
  (`pmos-power-on-4v` onto Spice Lite's value). New, all A: `coupled-edge-led-clamp`,
  `coupled-edge-led-pump`, `halfwave-1n4148-100u` (three grids), `npn`/`pnp-deep-
  saturation-*`, six `*-body-*` cases (each MOSFET grade's body diode conducting).
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
- **The golden accuracy guard** (2026-10-26, the fix round's phase 5 — Jason: "add more
  tests to the golden rule of being within 2% of ngspice … so we don't drift again").
  - **Nothing passes by being missing** (`spice-golden.test.js`): a case with no
    reference, a reference of another flavour or other readings than its case, a
    reference value that is not a finite number, a JSON holding a case the suite no
    longer has, an area with no cases, a case in no area and two cases of one id all
    FAIL (a missing reference was a `t.todo` that `return`ed out of its area, skipping
    every case after it). A case may carry `known: "<why>"` — a finding waiting on
    Jason: its subtest is a todo while it misses and the area FAILS once it passes (drop
    the field then); `SPICE_GOLDEN_STRICT=1` holds them to A too. A case may instead
    carry `accept: {grade?, invariance?, why}` — an exception JASON accepted: held to
    that worst grade and/or tick-spacing bar in place of A / `INVARIANCE`, failing past
    it AND once it no longer needs it (a ratchet both ways), listed as `ACCEPTED`
    diagnostics, out of its area's grade. Each JSON's `ngspice`
    is checked against `NGSPICE_VERSION` (spice-golden-cases.js, 44.2) — reported, not
    failed; `make spice-golden` warns when the installed ngspice differs.
  - **Coverage** (`tests/spice-golden-coverage.test.js`): every catalog part Spice Lite
    models appears in a case, or `make test` fails naming it. What a part is modelled
    BY is derived from the catalog fields the engine reads and its device tables —
    transistor grades (`BJT_GRADES`/`MOSFET_GRADES`), diode grades (`DIODE_GRADE_SPECS`),
    LED colours (`LED_SPECS`), clock waves (`CLOCK_WAVES`), load modes (`LOAD_MODES`), the
    meter's elements (`METER_ELEMENTS`). Logic-only chips count by FAMILY
    (`stage:74LS`/`stage:CD4000` — which must come from `ls-stage`/`cmos-stage` cases —
    and `stage:none`, the family-less MOS stage); a chip with figures of its own (silicon,
    op-amp, opto, arrays, own output stage, Schmitt thresholds, analog switch channels)
    by part; open collectors by family. `EXEMPT` (hand-kept, each with its reason) is the
    switches alone — ideal contacts; a part matching no rule and not exempt fails.
  - **Deck honesty** (`spice-deck.mjs`): a supply written as an ideal source reports its
    current, and `spice-golden.mjs` fails a case whose reference draws past the
    supply's limit (stored or the 1 A default) — DC by the operating point, a transient
    by the charge past the limit (ignoring the first rows, `uic`'s picofarad spike)
    beyond 1 mV of the supply's own 470 µF; a same-flavour output stage or a clock on a
    supply that can SAG throws `Unsupported` (both are stated from the set volts); a
    Zener in the device flavour throws (no one card is every Zener — its law in `same`);
    a 74LS Schmitt or open-collector part in the device flavour throws (`lsGate` is the
    totem pole); an open-collector output drives no HIGH; an unknown bench device kind
    throws (a meter was written as an electronic load). New blocks: a square/PWM clock
    (an ideal PWL, as a flag), the meter's element ("x": its volts behind its ohms, its
    insulation at the black probe), the relay (its coil the inductor, its contacts a
    regenerative memory on `abs(i(L))` against pull-in/drop-out), analog switch channels
    (`channelOhms`, on per the catalog's own `on` of every control combination), the
    CD4007UB's MOSFETs (device: the family channel's card; same: the same card, `stageChannel`),
    and, for an operating point, any part with no block (a CD4511B, a ROM, an LCD) driven
    at the LOGIC engine's settled levels through its own stage (same flavour only). A
    meter in a supply's lead is its "x" element like any (its shunt the resistor it is;
    phase 7c, 2026-10-27 — the joined `RM`/`IC` blocks are gone). **A chip OFF THE RAILS**
    (`chipBlock`'s `off`: fed through a resistor or such a shunt; same flavour, a gate's
    units only, one ground pin) is stated at `chipVolts[id]` — the volts across its supply
    pins — every reading `V(pin)-V(gnd)`, its HIGH a B-source from its VCC node, its LOW
    one into its ground (a channel, as Spice Lite's `both`), its inputs' stages from its
    ground (the upper clamp from VCC), its splitter into its ground, its ICC `RICC` 5 V /
    ICC across its pins. `scripts/spice-golden.mjs` finds those volts IN THE REFERENCE:
    the case's operating point run with `fedGuess` 5 V, then again on what it put across
    each such chip (`fed`, printed last) until they stand (`FED_ROUNDS`, `FED_EPS_V`).
    Area `meter` grades the lead: `meter-*-lead-supply-side`, `meter-ua-lead-minus`,
    `meter-both-leads-ua-ma-1k`, `meter-ua-lead-ls04-led` / `-minus-ls04-led` /
    `-minus-ls04-sink`, `meter-chained-ua-ma`, `meter-*-limited-0.1a-*` (in time: a supply
    goes on its limit a tick later) and `meter-ua-lead-100u-inrush` — all A, ≤ 0.03 %.
  - **New cases** (148 → 214; new areas `supplies`, `transistor-circuits`,
    `coupled-stages`, `meter`): the ±5 V LM358 follower and inverting amp, a 0.1 A supply
    sagging into 22 Ω (alone and chip-powered), a BJT flasher, a MOSFET RC ring, switch
    transients, a sine-driven NPN, a CE amplifier, a speaker through 100 µF, every meter
    element, the LM358 Schmitt, PC817, LM7809/12/15, LM317 under load, a CC load, the
    relay part with its flyback, the diode grades, Zener shunts, LED strings, every display
    and both LCD backlights, CD4049UB/4050B/4511B/4007UB, the four analog switches, a ROM
    (MOS stage), 74LS05/74LS14/CD4093B, the 555 monostable, square/PWM clocks, an LC ring,
    rnet9 and pot. Regenerating every area moved only the four `lm317-*` references
    (+0.02 %, onto Spice Lite's own value): they predated the deck's `RGD` feedback
    divider (2026-10-21). Phase 5b (same day): the MOSFET ring is A and steady
    (spice-lite.md → "A crossing behind a MOSFET channel"; read at 27 ms, once its
    rhythm has settled, not 12); ACCEPTED by Jason: `psu-sag-22r-0.1a-chip`'s paced
    droop (tick spacing within 1e-3) and `relay-npn-flyback-coil-tail` (B). The CD4007UB's
    channels are now the square law (all three cases exact; they were +10 % / −19 % at
    5 V on the old straight line) — Jason, 2026-10-26: "apply the patch", accepting
    that a CD4007UB in time runs 4–5× slower (a 590 Hz astable 2.2 → 11.4 s a
    simulated second). No `known` case is left.

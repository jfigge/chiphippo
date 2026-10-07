---
paths:
  - "src/web/scripts/sim/spice/**"
  - "src/web/scripts/sim/engines.js"
  - "src/web/scripts/components/settings-spice-panel.js"
  - "src/web/scripts/components/scope-view.js"
  - "src/web/scripts/model/scope-recorder.js"
  - "src/web/docs/spice-lite.md"
  - "src/web/scripts/tests/spice-*.test.js"
  - "src/web/scripts/tests/engine-parity.test.js"
  - "src/web/scripts/tests/scope-*.test.js"
---

## Spice Lite — the second engine

**A more electrical simulation behind one setting, never conditionals in the digital
engine** (plan `features/done/spice-lite.md`, user guide `spice-lite.md`). It is NOT
SPICE: no circuit-wide matrix, no manufacturer models — closed-form curves, Ohm's law and
a per-family table from TI's sheets, every number user-editable. The one matrix is the
small Newton solve round each group of LEDs (below).

- **The seam** (`sim/engines.js`): `ENGINES.digital` IS `engine.js`'s `tick`/`settle`;
  `ENGINES.spice` takes the same options plus `spice: {config, analog}` and returns the
  same result plus `analog` (carried by SimController like `state`), `nodeVolts`,
  `supplies`, `loads`, `sag`. **Only SimController chooses** (at Run); the AI verifier,
  the desk review, `make demos`, the exports import `engine.js` directly, so they are
  digital by construction — exports stay byte-identical, demos validate unchanged.
- **Spice Lite DRIVES the digital engine through `hooks`** (`engine.js`'s header):
  `context`, `curves`, `input`, `outputs`, `levels`, `busy`, `pass`, `maxIterations`,
  `psuVolts`, `chipDrop`. Absent = today's engine byte for byte. It never re-implements a
  settle; a Spice Lite tick is several digital ticks with the analog side between.
- **The oracle**: `tests/engine-parity.test.js` runs every shipped example desktop through
  both engines, 24 ticks, every shared result field deep-equal. An example Spice Lite is
  MEANT to run differently is exempted WITH its reason (today: the two 555 desktops).
- **Time**: a pass is one QUANTUM, the shortest gate delay on the desk
  (`spice/params.js`; CD4000 scaled along SCHS015C's 5/10/15 V points); a slower chip
  HOLDS its outputs `round(delay/quantum)` passes, inertially. One family → every hold
  is 1 → pass for pass the digital engine. The cap is `MAX_ITERATIONS × maxHold`, and the
  slowest gate is at most `MAX_HOLD` (64) quanta — past it the quantum grows — so a
  delay edited absurdly short cannot turn a tick into minutes.
- **Analog nodes are CLOSED-FORM, never stepped** (`spice/rc-curve.js`): a net with a
  capacitor, no strong driver and no timed part owning it (a timed part owns the
  capacitors on its `timing`-role pins ONLY — an RC on a 555's RESET is a node) follows
  V∞ + (V0 − V∞)e^(−t/τ) from its resistors' Thévenin equivalent (`rcTrace`). A HIGH is
  the supply of the chip DRIVING that net (`highOf`; the desk's highest only for a net no
  chip drives), so a 5 V output cannot charge a node toward a 12 V rail. A capacitor's
  far side jumping does not jump the node (no coupling — stated). Each listener reads it through
  its OWN thresholds (`inputThresholds` → `{up, down}`: the VIL/VIH midpoint for both,
  or a Schmitt input's VT+/VT− from `def.schmitt` — the '14, 40106, 4093; one point would
  turn an RC relaxation oscillator straight back) — the `input` hook — and a crossing is
  a one-shot, re-armed only by crossing back through the other. A capacitor whose far
  lead reaches nothing (`trace.connected`) is no part of a node. Each capacitor's CHARGE
  (V(pin 1) − V(pin 2), `analog.caps`, nets from `capacitorNets`) is carried tick to tick,
  so a node merged into a rail by a switch comes back holding what the rail left. The
  next crossing is a logarithm: within `FAST_WINDOW_S` it is settled in the same tick,
  beyond it is `wakeAt`; a late tick catches up in order on its OWN budget
  (`MAX_CATCHUP_EVENTS`, then it jumps to `now` — replayed history is never evidence of a
  fast oscillator, and flips are counted only at the tick's own moment);
  `MAX_ANALOG_EVENTS` caps the live settles and reports a faster-than-the-desk analog
  oscillator as `oscillation` (`analog.oscillating`, after which the next tick does not
  catch up). The settles inside one Spice Lite tick read the memory images with the
  earlier settles' writes to a VOLATILE chip applied (copied, only when a later settle
  needs them). A node nobody listens to never holds a tick; it asks
  for display frames until the gap setting says arrived (measured against the STEP it is
  taking). The 555 times by `CURVE_K` (ln 2 / ln 3) under `probe.curves`, with the long
  first HIGH from an empty capacitor, and reports its capacitor's voltage
  (`logic.nodeVolts`) — and asks for the display frames itself while that moves
  (`logic.curveMoving`: an astable always, a monostable during its pulse). It is no node,
  so without them it ticked only at its thresholds and the analyzer drew straight lines
  from ⅓ to ⅔ VCC. `nodeVolts` reaches the probe's readout and the logic
  analyzer, nothing else.
- **Current**: fan-out is INPUT loads only (`spice/loads.js`, I_IH/I_IL against the
  drivers' source/sink — `outputDrive`: the family's, unless the def states its own
  `drive: {sinkMa, sourceMa, pins}`, as the 74LS bus drivers, the '595 and the
  CD4049UB/CD4050B do; a family-less MOS part's inputs draw `MOS_INPUT_UA`): `brownout`
  past 1×, BROWN SMOKE (`CHIP_STATUS.OVERLOADED`, `params.overloaded` — `damaged`'s exact
  lifecycle) from 2×, one warning per chip (its worst output). A DRIVER is a pin the chip
  is driving H/L right now — the `outputs` hook's `driven` map, never a pin role — so a
  tri-state output switched off is no driver and a bus `io` pin is a driver while it
  drives. The budget REPLACES the digital engine's `ls-fanout` (filtered out of a Spice
  Lite result). Supply demand (`spice/supply.js`) is every chip's ICC (powered or not —
  droop must not flicker) plus every resistor's current (a DIODE at 0.7 V; resistors in
  an LED's network are the LED solve's to book, below),
  a net's voltage read from what DRIVES it (`driven` — what an underpowered chip last
  drove, so a load that pulls its own supply down stays booked and the droop holds
  rather than flickering — then a switch/transistor channel ON to a rail, then the
  strong level); current enters at the driving chip's VCC pin or the channel's rail end
  and returns through a sinking chip's GND pin. Past `currentLimit` (a PSU
  PARAM, 1 A default omitted — no schema bump) V = Vset · Ilimit / Idemand, fed back
  through `psuVolts`. Wire sag (`spice/sag.js`): 24 AWG at `wireCutMm`, draws routed on
  the lowest-resistance path, a chip's Σ I·R over 1 mV fed back through `chipDrop` — to
  its POWER check only: `supplyVolts` (what the boundary warnings compare) stays the
  rail's, since a wire's drop is not a second supply. A moved supply or drop settles again
  the same tick — up to `RESETTLE_ROUNDS` while that changes what a node reads, the
  nodes re-read after each. **Nothing topological is re-derived per tick**: `supplyTopology`,
  `sagTopology` (the graph and every Dijkstra path) and `capacitorNets` are cached in a
  `WeakMap` keyed by the NETLIST, which NetlistCache rebuilds on exactly the changes that
  could move them (the document is cloned every tick, so it cannot be the key).
- **LEDs carry real current** (Jason asked, 2026-10-07; `features/spice-lite-leds.md`).
  `spice/leds.js`: one 5 mm part per colour — Kingbright WP7113ID/YD/GD/QBC-D/QWC-D, every
  number off its own sheet — as V = knee + rd·I (red 1.8 V + 10 Ω; blue/white 2.8 V +
  25 Ω), dark under `LIT_MIN_A` (50 µA), `level` = cube root of I over the sheet's
  normalising current, OVERDRIVEN past its DC rating (warning), BURNT once Ta + RthJA·V·I
  passes Tj max (red 71 mA, blue 39 mA — instant, the package's warm-up is not
  modelled), reverse past VR 5 V (warning). Segments and bars are their colour's LED.
  `spice/output-stage.js`: a chip output as the stage it is — 74LS HIGH VCC − 1.4 V
  behind 120 Ω (SDLS025B's schematic), LOW 0.15 V behind 25 Ω; CD4000 a MOSFET saturating
  at 4.2/16/28 mA (5/10/15 V, CD4029B figs) behind 400/190/200 Ω; a def's own
  `outputStage` (`volts`, `ohms`, `limitMa` table, or a `scale` on the family's) for the
  NE555, CD4511B, CD4049UB/CD4050B; family-less parts take 74LS; a switch channel its
  rON, a discrete transistor 0 Ω (its nets union). `spice/lamps.js` SOLVES each LED's
  network — fixed nets (rails at delivered volts, signals/clocks ideal at the top rail,
  RC nodes at their curve), branches (resistors, LEDs, channels, output stages), Newton
  per network with a dense `gaussSolve`, 2 V step limit and backtracking, warm-started
  from `analog.lampVolts`; a 1 GΩ leak per junction and GMIN keep a floating net
  defined. Burning opens the LED and re-solves until nothing more burns; the set rides
  `analog.burnt` (run-volatile, NOT the document — Stop's `analog = null` restores it).
  A SECOND solve `atSet` (rails and chips at their SET volts, no burning) is what
  `measureSupplies` books (`lamps: {draws, resistors}` — it skips those resistors),
  because demand is measured at the set voltage; the verdicts are at delivered volts, so
  droop dims. Result `lamps` (key `c4` / `c5#a`, `junctionKey`) rides
  `chiphippo:sim-state` (NULL on the digital engine); SimOverlay's `#verdict` uses it
  over the junction rule and hands views `setLevel`/`setSegmentLevel` (`--led-level`,
  rounded to 0.05; the 3D view still reads only lit/burnt). Warnings `led-burnt` (once),
  `led-overdriven`, `led-reverse`, toasts keyed `led:<comp>`. **No part shows a current
  of its own — only a PSU brick its draw; the PROBE reads current** (Jason, 2026-10-07):
  the solve's `currents` (hole address → amps through the lead in it, summed signed so a
  shared lead — a display's K, an rnet9's COM — is right) rides sim-state;
  `SimOverlay.currentAt(address)` (a PSU terminal answers its supply's amps) and the
  probe's readout adds `currentText` (µA/mA/A, `probe.microamps|milliamps|amps`) for the
  hole it is on. Decided: the burn stays INSTANT at Tj max; the LED numbers are NOT
  user-editable; an LED never damages the chip driving it. Not modelled: a diode in the
  network, an LED draining an RC node, a loaded HIGH as INPUTS read it, LS sink
  saturation past IOL.
- **Spikes & decoupling**: a switching output charges its sheet's test load (`loadPf`:
  15 / 50 pF) in its own delay, for one pass, booked to its supply; the worst pass is the
  supply's `peak`. A capacitor from the chip's VCC net straight to a − rail decouples it.
  A peak past the limit is a `supply-spike` WARNING — the logic is not glitched.
- **UI stays thin** (rendering work was going on in parallel): `nodeVolts` →
  `SimOverlay.voltsOfNet` → the probe readout; `supplies` → `PsuView.setSupply` (writes
  only when its text changes); brown smoke reuses the burn overlay in
  `--color-part-smoke-brown`. Nothing new is drawn per tick.
- **The analyzer draws a node's VOLTAGE, not its level** (2026-10-06 — Jason asked why
  a 1.5 kΩ / 1 mF RC jumped L→H instead of curving). `ScopeView` records
  `nodeVolts` beside each net channel's level (`scope-recorder.js` `readVolts`; a
  column's `volts` map, kept only when non-empty) and `#voltsPath` draws those
  columns as a polyline from 0 V to the run's FULL SCALE — the highest supply SET
  (`fullScaleOf` over the broadcast's `supplies`, raised only, reset on Run; never
  auto-ranged, which would turn a creeping node back into a step). Columns without
  volts still step; a flat stretch adds only its ends. The gutter reads `scope.volts`
  to two places. The axis is still TICKS: the display frames (`ANALOG_FRAME_S`) are
  what space a moving curve evenly, and clock edges interleave their own columns —
  stated in the guide, not corrected. The Δ-ms readout (`tickMsFor`) assumes one
  tick per clock half-period, which display frames also break.

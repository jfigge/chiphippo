---
paths:
  - "src/web/scripts/catalog/bench-parts.js"
  - "src/web/scripts/catalog/chips-analog.js"
  - "src/web/scripts/catalog/chips-drivers.js"
  - "src/web/scripts/components/load-view.js"
  - "src/web/scripts/sim/regulators.js"
  - "src/web/scripts/sim/spice/analog-devices.js"
  - "src/web/scripts/sim/spice/bench-parts.js"
  - "src/web/scripts/sim/spice/bench-warnings.js"
  - "src/web/scripts/tests/bench-parts.test.js"
  - "src/web/scripts/tests/uln2003a.test.js"
  - "features/done/chiphippo-bench-parts-feature-request.md"
---

## Bench parts — regulators, relay, load, LM358, ULN2003A, optocouplers

Built 2026-10-09 from `features/done/chiphippo-bench-parts-feature-request.md` (its
completion summary at the end says what was decided and left). Every one is data in the
catalog plus a device in the Spice Lite solve; none has per-part code in the digital
engine beyond the regulator supply rule.

- **Where they live.** `catalog/chips-analog.js` (the LM358, CHIPS ▸ Op-amps — shelved
  BEFORE the 65xx in `CHIP_DEFS` so its group ranks beside Timer), `catalog/chips-drivers.js`
  (ULN2003A, 4N35, PC817 — CHIPS ▸ Interface, all `supplyless`: no vcc/gnd pin, so the
  engine's `passive` rule keeps them always OK, and the catalog test allows it),
  `catalog/bench-parts.js` (the five TO-220 regulators — COMPONENTS ▸ Regulators, not
  CHIPS: they seat like a transistor — the relay, COMPONENTS ▸ Relays, and the load brick).
  All family-less, all out of the AI builder (`catalog-brief.js` `isBenchPart`), and an
  optocoupler's CTR is a chip PARAM (`extraParams` in `catalog/index.js`, stored only off
  its default).
- **The logic engine.** A regulator's OUT is a SUPPLY `+` (`sim/regulators.js`
  `regulatorSupplies`, from `buildContext`) while its IN is one at least its dropout above
  what it holds — chained to a fixpoint, an LM317's volts read off its R1/R2 (`regulatorVolts`,
  `+ IADJ·R2`). **Only without hooks**: under Spice Lite the solve holds OUT, so a desk with
  a regulator powering something keeps a SECOND settle index (`fixed.regulatedIndex`) —
  sharing one with Spice Lite's context made the incremental settle part from the full
  one (the index records which nets are supplies). The relay, the ULN and the optos are
  `logic.channels` (analog-switch joins): relay COM–NO while one coil leg reads H and the
  other L (COM–NC otherwise); ULN channel on while its input is H; opto C–E while A is H and
  K is L. The LM358 is a COMB comparator (X when its inputs agree). The load is inert.
- **Spice Lite devices** (`spice/analog-devices.js`, kinds `o` opto, `a` op-amp unit, `g`
  regulator, `e` load; placed by `spice/bench-parts.js` `benchDevices`, per netlist):
  each a piecewise-linear current law in `network.js`'s device set. An opto carries
  CTR × `optoTransfer(IF)` (2026-10-13): ONE common curve (`OPTO_TRANSFER`, corners in
  IF) — the CTR set holds from 5 mA up and falls below it (0.725 at 2 mA, 0.51 at 1 mA,
  0.32 at 0.5 mA, 0.09 at 0.1 mA: the mean of Vishay 4N35 Fig. 2 and Sharp PC817 Fig. 7,
  each relative to its own 5 mA; above 5 mA the sheets disagree — one rises, one falls —
  so it is flat). Its piece names the transfer chord too. No temperature. **Its LED
  reversed says nothing** (Jason, 2026-10-22: no warning on an optocoupler's reverse
  polarity) — it carries no IF, so C–E stays off, and that is all; past the sheets'
  6 V VR nothing warns or burns, unlike a discrete LED's `led-reverse`. A regulator's
  quiescent current (`regulatorQuiescent`, 2026-10-19) is its figure from
  `QUIESCENT_HEAD_V` (1 V) of headroom up and a straight line through zero below (REF above
  IN carries it back) — NOT from `dropoutV`, where its corner fell on the one where the
  regulator starts to source with OUT still at REF, and the linear model read across both
  ran an unloaded output to 840 V: a
  fixed Iq with GND returning nowhere (a bridge's − not wired to the regulator's GND) had
  no balance, and the solve left GND at Iq / GMIN, +5 GV per tick (cut off at zero
  instead, the floating net was flat to Newton and landed megavolts away); the golden
  deck's `BGQ` writes the same line. Its feedback divider, OUT → REF, is
  `REGULATOR_DIVIDER_S` (1 µS, an assumption; the deck's `RGD`, 2026-10-21): with
  nothing else on it an unloaded OUT had no balance and read 5.75–6.5 V. A regulator and an
  op-amp HOLD their output (`holdsOut`) as a driving output does; an op-amp's OUT pin is
  kept out of the stage drivers (`analogOuts`). The ULN is `bipolarArray` "q" devices on
  internal base nets behind `internals.resistors`, its clamps `internals.junctions` (left
  out when either end's net is unwired), booked as the chip's outputs. The relay coil is
  an inductor (`inductors.js` `coilOf`: a def's `coil` or an inductor's henries), and its
  contacts follow the coil's CURRENT, not a reading: `spice/engine.js` keeps `relayOn`
  (carried in `analog.relays`), flips it with hysteresis at each settle (`syncRelays`),
  times the crossing as a `relay:` entry in `nextCrossing`, and answers the channel's
  control pins through the `input` hook (leg `a` H while pulled in, leg `b` L) — so the
  relay registers no READER and never colours a net's shown level. A pulled-in relay whose
  coil a switch shorted out of the network (`coilsAway`: no curve left to cross) asks for
  a wake at its drop-out in closed form, `at + τ·ln(I₀ / (dropOut·rated))` (2026-10-14 —
  it held its contacts until something else ticked the desk). Contacts are
  `def.contacts.ohms`, booked against `contacts.limits` (warn only: smoke Infinity).
- **Lead order** (2026-10-21): `analogCurrents` answers in `analogTerminals`' order,
  which `analogHoles` follows and voltages.js reads BY PLACE — a regulator's used to
  answer OUT first, so the probe showed OUT's current on IN, IN's on GND, and the
  wire drop routed it so (`bench-parts.test.js` "lead currents"). A FIXED regulator's
  reading `volts` is OUT − its own GND (`reg.adjustable`, from the catalog's
  `regulator.adjustable`): against earth, on a floating DC side, it swung −11…+5.7 V.
  **Its GND (ADJ) wired to NOTHING** (`benchDevices`' `refOpen`: the ref net holds that
  one pin and no terminal; 2026-10-22) is the exception: no current can leave it, the
  solve leaves it up at IN, and OUT rises to IN − dropout as on the bench — read against
  the desk's ground, `dropout`/`starved` false, the reading `open: true` (hover
  `desk.regulator.open`) and a `regulator-open` warning (`sim.regulatorOpen`). It read
  −2 V against its own GND, "in dropout". A GND wired to something that floats (a
  bridge's − on a rail nothing grounds) is not open: that reading stays OUT − GND.
- **Readings and warnings** (`spice/bench-warnings.js`): `report().analog` → `result.bench`
  (→ sim-state `bench` → the load's readout, the regulator's hover) and the
  `regulator-dropout|limit|hot|shutdown|open` and `load-power` warnings (SimController
  `#benchWarning` — through `#warn` since 2026-10-22, said once per part until its words
  change, a danger one sticky; it went straight to `#notify` and re-raised the toast at
  every tick, so one clicked away came back). Thermal shutdown is carried in `analog.thermal` (comp → the moment it
  has cooled): tripped once its HEAT reaches 2 W, off from `TRIP_S` later for `COOL_S`
  (1 s, an assumption), `volt.setThermal` each tick, a wake at both edges — so it cycles.
  The heat (2026-10-19, `analog.heats`: `{heat, watts, at}`) is a first-order lag of the
  watts dissipated since the last tick, `HEAT_TAU_S` 10 s (an assumption), and the tick
  asks for a wake where it will reach the shutdown at the present power (`tripIn` →
  `tripAt`). It was an instant trip past 2 W, so a 10 mF output capacitor charged at the
  1.5 A limit shut a 7805 down the moment the desk ran. `regulator-hot` reads the
  watts at a tick, said only at the SECOND tick running past 1 W (2026-10-21: one
  instant a few millivolts off its target was amps through 0.01 Ω — "14.8 W"). Since 2026-10-21 the stretch between two ticks is booked at the MEAN of
  its two ends' watts, and a heating regulator (`tripIn` finite) is woken at least every
  `HEAT_STEP_S` (0.5 s): ticked only at its own wakes, a 7805 that had just charged
  10 mF read 6 W at the last tick of the charge, was next woken at the trip that power
  predicted four seconds on, and shut down hot carrying 0.25 W.
- **The settling window** (SimController, 2026-10-21, Jason): `regulator-dropout`,
  `regulator-limit` and `regulator-hot` (`SETTLING_WARNINGS`) are not said while the tick
  is under `SETTLE_S` (0.5 s) after Run — a bridge's reservoir filling, a regulator
  charging its own output. One held back sets `#settleCheck`, and `#nextEvent` wakes the
  board at `SETTLE_S`, so a condition that STANDS on a board nothing else ticks is said
  there. `regulator-shutdown` is never held. Tests: `sim-controller-timing.test.js`.
- **A supply ON ITS LIMIT is held by the solve** (2026-10-21, Jason: "fix the supply
  current limit in the solver"). The per-tick droop is booked at the SET volts, where a
  regulator draws its whole 1.5 A for any output short of its own — so a 7805 off a 1 A
  supply charging 1 mF WITH a 100 Ω load locked at 3.98 V (the `starved` secant does
  not reach it: the regulator sources the load), and widened to `dropout` the supply
  flipped 5.99 ↔ 7.99 V every tick. Now a supply whose demand at set passes its limit is
  FREED for the next tick (`measure` → `freeNext`, carried as `analog.free`, a wake
  `FREE_WAKE_S` 1 µs on): its + is no rail in the voltage topology (`voltageTopology`'s
  `free`, cached per free set; `rails`/`plus`/`makePlan` railVolts skip `freeNets`;
  `analyze`'s `rail` and `islandsOf` too) but a net held by analog-devices.js **"p"**
  (`supplyAmps`: min(limit, (set − V(+,−)) / `PSU_SOURCE_OHMS` 0.01 Ω); pieces CV/CC, so
  the corner machinery times the CC→CV moment exactly), everything on it one cluster;
  `createVoltages` starts fresh on a new free set. Its report is `{kind: "psu"}`, and
  `measureSupplies`' `held` takes it as the supply's whole delivery (no ICC or draw
  booked to it again). Back to a rail once it delivers under `FREE_RELEASE` (0.9) of its
  limit in CV. **Only a supply nothing logic-powered hangs off** (`freeSupplies`: no
  part's VCC-role pin, no clock brick's vcc, on its +; not sharing its + with another
  PSU): the logic engine reads those parts' power off the rail, and the droop's
  "as it last drove" booking is what keeps an overloaded chip from flickering
  (spice-current.test.js) — so a 5 V PSU straight into chips still droops. The deck
  writes a PSU with a stored `currentLimit` as that law (`BPSU`); golden
  `lm7805-9v-limited-0.25a-1m` (bench-parts, same) is exact. 1 mF + 100 Ω on a 1 A
  supply: 5 ticks, up at 5.1 ms.
- **A supply on its limit feeding a regulator** (2026-10-19, `spice/supply.js`
  `droopVolts`): the proportional droop V = Vset·Ilimit/Idemand is exact for a resistive
  load, but a regulator charging its output capacitor draws its full current at the SET
  volts and nothing once its input is pulled down to where its output stands — so a 7805 on
  a 1 A, 9 V supply stood at 3.98 V for good. Where a regulator is STARVED (report
  `starved`: input too low to regulate, sourcing nothing), the demand at the DELIVERED
  volts is booked too and the supply put where the straight line between the two meets the
  limit (never deeper than proportional, never above set); and while a regulator is pinched
  (starved or in dropout) and that demand is off the limit by more than `DROOP_SETTLED`
  (1 %), the tick asks for a wake `DROOP_WAKE_S` (0.1 ms) on. Scoped to regulators: a chip
  that turns on as its supply rises (and off as it falls) flickers under it
  (`spice-current.test.js` "stays down: no flicker"). Known: while it charges in dropout the
  regulator still draws its 1.5 A from a 1 A supply (the droop's line is flat there).
- **What the bench parts forced in the solver** (2026-10-09; all in `make test`):
  - `newtonSolve` falls back to a **Gauss–Seidel sweep** (`sweep`, `SWEEPS`) when neither
    Newton step gains, and once more if it ends unbalanced: a Darlington switched off with
    its collector on a load mispredicts the coupled step by amps, and the ULN stayed ON
    with its input at 0 V. This also took a relay kick through a Darlington from 69 s to
    under 0.1 s.
  - `solveRising` is **Brent's method** (Illinois crawled ~30 evaluations per call through
    a Darlington's nested solves, often to the last ulp; it stops at a few ulps now).
  - The stuck-corner **run-on** recognises a group SLIDING among its last `RECENT_PIECES`
    pieces (not only the same piece twice), carries its run across them, is capped at the
    SLOWEST time constant (capped at the fastest — a stuck coil's is the transistor's
    leakage — a relay's kick took 19 000 corners), and never carries a coil's current
    through ZERO (`firstRoot` on the coil's curve — the coils sit at `nc + nw + j`, after
    the waves; reading `nc + j` read a wave's volts and a ramp drove a coil to −39 mA,
    fixed 2026-10-14): past it, the piece pulled the current backwards through the clamp
    that had stopped conducting and the solve ran away. Nor past one e-fold of a GROWING
    mode (`scale.grow`, dynamics.js — a device linearized to a negative slope; with
    `slow` Infinity nothing capped it, and a triangle-driven coil ran to e^4600 → NaN for
    the rest of the run, 2026-10-14).
  - A coil heading the other way than it was read is re-linearized the way it goes, a
    coil's cluster balances to 1e-14 A (`COIL_TOLERANCE_A`; at 1 pA a relay's collector
    rested at 4 V with 5 pA in its coil), and the tick's last solve uses the coils' current
    at the tick's end.
- **The op-amp solver** (2026-10-18, branch `ac-timebase`, forced by the AC examples'
  comparator and Schmitt trigger): an LM358 unit's gain is 1e5, so the band between its
  saturations is tens of µV of input, and a step read a microvolt apart straddled a
  corner. Now: `opAmpSlope` (analog-devices.js) is ANALYTIC per piece — on a corner the
  piece the move enters (`side`), zero past a current limit; `opAmpStepCut` cuts a Newton
  step a hair (`CUT_PAST_V`, 1 µV of raw level) past the first corner it crosses — the
  swing's top or bottom, or a source/sink limit — as SPICE limits a junction's step;
  `newtonSolve` scales each net's residual to what it can be balanced to (per-node
  scaling); and, still out of balance, `swingRetry` stands each op-amp's output (up to
  `MAX_SWING_RETRIES`) at the NEAR edge of its swing, then the far one, solves the rest
  with it held, lets go and runs Newton — a Schmitt trigger that has just crossed a
  threshold has lost the state it was in, and from the corner every step points back
  across the unstable band. Kept only where it balances and is stable. Retries nest at
  most `MAX_SWING_DEPTH` (2) deep (`swingDepth`) and the cap counts only op-amps whose
  output is an unknown of that solve — unbounded, a cluster of several op-amps that
  would not balance ran hundreds of nested solves (2026-10-18). Op-amp inputs are
  no listeners (spice-lite.md → "The AC supply and the transformer"). Unit tests in
  `bench-parts.test.js`; the Schmitt fold proved on the shipped AC examples.
- **Examples** are HAND_BUILT (`scripts/demo-build.mjs`): `demos/{lm358,uln2003a,4n35,
  pc817,lm7805,lm317,relay,load}.chiphippo`, authored by a throwaway DeskDoc script (not
  committed) and validated like the 555's. `ANALOG_GROUPS` (Op-amps) gets no bench. The
  analog ones are exempt from engine parity with their reasons.

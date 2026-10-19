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
  so it is flat). Its piece names the transfer chord too. No temperature. A regulator and an
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
- **Readings and warnings** (`spice/bench-warnings.js`): `report().analog` → `result.bench`
  (→ sim-state `bench` → the load's readout, the regulator's hover) and the
  `regulator-dropout|limit|hot|shutdown` and `load-power` warnings (SimController
  `#benchWarning`). Thermal shutdown is carried in `analog.thermal` (comp → the moment it
  has cooled): tripped past 2 W, off from `TRIP_S` later for `COOL_S` (1 s, an assumption),
  `volt.setThermal` each tick, a wake at both edges — so it cycles.
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

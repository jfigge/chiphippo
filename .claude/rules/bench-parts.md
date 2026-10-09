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
  each a piecewise-linear current law in `network.js`'s device set. A regulator and an
  op-amp HOLD their output (`holdsOut`) as a driving output does; an op-amp's OUT pin is
  kept out of the stage drivers (`analogOuts`). The ULN is `bipolarArray` "q" devices on
  internal base nets behind `internals.resistors`, its clamps `internals.junctions` (left
  out when either end's net is unwired), booked as the chip's outputs. The relay coil is
  an inductor (`inductors.js` `coilOf`: a def's `coil` or an inductor's henries), and its
  contacts follow the coil's CURRENT, not a reading: `spice/engine.js` keeps `relayOn`
  (carried in `analog.relays`), flips it with hysteresis at each settle (`syncRelays`),
  times the crossing as a `relay:` entry in `nextCrossing`, and answers the channel's
  control pins through the `input` hook (leg `a` H while pulled in, leg `b` L) — so the
  relay registers no READER and never colours a net's shown level. Contacts are
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
    through ZERO (`firstRoot` on the coil's curve): past it, the piece pulled the current
    backwards through the clamp that had stopped conducting and the solve ran away.
  - A coil heading the other way than it was read is re-linearized the way it goes, a
    coil's cluster balances to 1e-14 A (`COIL_TOLERANCE_A`; at 1 pA a relay's collector
    rested at 4 V with 5 pA in its coil), and the tick's last solve uses the coils' current
    at the tick's end.
- **Examples** are HAND_BUILT (`scripts/demo-build.mjs`): `demos/{lm358,uln2003a,4n35,
  pc817,lm7805,lm317,relay,load}.chiphippo`, authored by a throwaway DeskDoc script (not
  committed) and validated like the 555's. `ANALOG_GROUPS` (Op-amps) gets no bench. The
  analog ones are exempt from engine parity with their reasons.

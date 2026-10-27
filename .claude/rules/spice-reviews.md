---
paths:
  - "src/web/scripts/sim/spice/engine.js"
  - "src/web/scripts/sim/spice/dynamics.js"
  - "src/web/scripts/sim/spice/rc-curve.js"
  - "src/web/scripts/sim/spice/network.js"
  - "src/web/scripts/sim/spice/voltages.js"
  - "src/web/scripts/sim/spice/transistors.js"
  - "src/web/scripts/tests/spice-appraisal-fixes.test.js"
  - "src/web/scripts/tests/spice-review-fixes.test.js"
  - "src/web/scripts/tests/spice-grade-fixes.test.js"
  - "src/web/scripts/tests/engine-appraisal-fixes.test.js"
---

## Spice Lite reviews & appraisals

The two whole-engine passes of 2026-10-21 — Jason's real-time review of the Regulated 5V
desk and the nine-reviewer appraisal — and what each changed in the dynamic groups
(`runGroup`, `linearizeGroup`, the corner search), the solver and the devices. Split out
of `spice-lite.md` ("Spice Lite — the second engine", where the groups themselves are
described under "Nodes that move TOGETHER") on 2026-10-23.

  - **The 2026-10-21 review** (Jason: "a few components and we fail one real-time
    pass"; four agents read the engine, his Regulated 5V desk — EARTHED 12 V~ → DB105
    whose − floats on a rail strip → 470 µF → 7805 + 100 nF → LED — went ×0.46 →
    ×2.75 headless, ×3.6 with the analyzer off, readings unchanged):
    - **A secant never spans a corner it does not stand on** (`linearizeGroup`,
      `SECANT_SHRINK` 1e-3, `SECANT_SHRINKS` 2): a state's 1 mV nudge that leaves the
      base's pieces (and is not the joint nudge's) is read again 1 µV, then 1 nV, away —
      still across, the state stands ON the corner and enters it; back in the base's
      pieces, that short read is its slope. A lightly loaded 7805 stands 1.7 µV short of
      where it stops sourcing (0.01 Ω × 0.17 mA): read across it, OUT was held while
      GND swung, ended millivolts off its target — amps through 0.01 Ω, "running hot,
      14.8 W" — and flipped on/off every few ns (4 600 stuck run-ons a second). The
      single-node `linearize` was tried with the same rule: no change, left as it was.
    - **A common voltage its networks hardly hold gets a stray capacitance**
      (`runGroup`): a null mode whose conductance mᵀYm is under `FLOATING_S` (1 µS) —
      the floating DC side, held by four junctions' leakage — gives every net of the
      group `STRAY_F` (1 pF, or `STRAY_REL` 1e-9 of its largest capacitor) to earth, so
      the mode is a state, not a `balance` at every corner (a third of the run; with no
      OUT capacitor, ×0.06). STICKY: the curves say `floating: <group key>`, so a
      group once found floating keeps it (the bridge conducting holds the mode for a
      moment each half-cycle; switching back cost what it saved). Given to every null
      mode it moved the coupled oscillators', the 4060's and the flasher's timing
      (resistors hold their modes) — hence the test.
    - **A group's curves run on while nothing changed** (`runGroup`'s `made`): the
      voltage side's `epoch()` STATES what the networks are — plan signature, burnt,
      thermal, free set, every chip's outputs, channels, bench sources, gate volts, and
      "fresh" on a fresh side — rebuilt only after one of them changed (`shape = null`
      at each), never counted, so the incremental and full settles agree; with the
      group's members and each wave's generator (wave, mid, ω, slope, end) it is the
      curve's `made`. Same `made`, `t0 ≤ t < tEnd`, no coupling step or wave jump on
      its nets → the curves stand (`refreshWaves` keeps a wave on its group's curve
      too). Re-run at every replayed start and after every settle, it was two thirds of
      the runs, and the re-anchoring was not harmless: the Zero crossing example's '90
      counted half again too many edges (18 LED rises on 238 flips; 12 now, as
      flips/20 says — its test holds that).
    - **A corner on a wave-driven island wakes no sooner than its frame**
      (`cornerWaits`, `wakeFor`): only corners, every one on an island a RUNNING WAVE
      drives, nothing listening there, no relay, under half `MAX_CORNERS` spent → the
      wake is max(corner, next display frame), the frame is a tick, the tick runs the
      corners in order; and such a corner just past the target is no run-ahead (`ahead`).
      A wave never arrives, so its corners recur forever (a reservoir's ~15 a
      half-cycle, each a whole tick). A transient keeps waking at its corners: clamped
      too, the CMOS-into-1 µF and relay-flyback goldens read ~1e-4 apart between tick
      spacings (a settle's extra quantum at the reading tick) and the flasher timed
      differently.
    - **The corner budget spent past the target stops** (`spent`): the rest are the
      next tick's. Taken as crossings each was a settle that spent the island's event
      budget, capped it and backed it off as a chatter.
    - **An off-rail chip's volts are held within `DROOP_EPS`** (the `chipVolts` hook,
      against `analog.fed`, last tick's): read to the bit, a chip on a rippling supply
      made every tick's context new (`hookKey`), and the analysis with it.
    - **A wave's jump is measured at the tick's own moment** (`refreshWaves`): the
      first look at or past the target compared the wave's value THERE with its old
      inputs' at the target, so a tick whose first look was a corner microseconds on
      (its own settle a quiet replay) took that much of the sine's MOTION as a jump and
      stepped every capacitor on it: 1 V, 1 kHz through 1 µF onto a CD40106B (1 MΩ to
      VDD) stepped its node 19 mV the wrong way at each clamp, and ticked every
      100 µs or less it never charged up to trip.
    - **A driven ring is searched every eighth of a period throughout**
      (`sampleTimes`, `RING_SAMPLES` 2048 — 256 periods — where `RING_PERIODS` 50 was):
      a sine never dies, and past 50 periods a crest clearing VT+ by a hair was looked
      for on the cubic grid only — the same desk ticked at its wakes tripped 17 crests
      late. Now the same at every spacing (`spice-ac.test.js` — since the signal
      generator's removal on a 1 V~ 60 Hz adapter, 0.1704 s).
    - **Phase 3** (same day; Desktop 3 ×2.75 → ×6.7–7.3 headless over 3 s,
      readings within 1.7e-5 V of before — `runGroup`, dynamics.js, rc-curve.js):
      - **A linearization is kept by the pieces it was read on** (`keptModel`,
        `LINEARIZED` by the voltage side's `lineage()` — a `{}` carried by reference,
        new on a fresh side, so two runs never share): key = `members` (the
        `epoch()` statement + nets/waves/coils, NOT the wave generators — their `end`
        moves every half period) + `volt.groupKey` (each cluster's pieces after the
        JOINT nudge, `jointNetwork`, one solve; null for a lone or resting state).
        Kept only when PURE (`linearizeGroup`'s `pure`: read INSIDE those pieces — the
        base already on them, not at a corner, where each secant spans the
        bisection's sliver of the old piece: a Schottky's "off" read at its cut-off,
        4 mS of the conducting slope in it, kept and reused every half-cycle, drained
        the half-wave reservoir at 45 mA (`diode-grades.test.js`) — every state's read
        landed on them, and no curved branch — `CURVED_KINDS` q, m, o: a transistor or an
        opto is curved within its pieces, and a kept BJT read ran a coil to NaN). An
        impure read is a group SLIDING along a corner (the 7805 catching its output):
        kept, it ran the reservoir's charge on the wrong side (IN stuck at 8 V). A
        network with no pieces is kept under `members#linear`. Not while a common mode
        is balanced (`modes`). Same-key reads differ by ≤ 1e-4 relative (solver noise
        on the floating side) — as two fresh reads do. The reservoir comes round ~77
        piece sets; 95 % of runs hit. Capped at `MAX_LINEARIZED` (1024), then cleared.
      - **The system is prepared once per read** (dynamics.js `rcPrepare` → `at(v0,
        t0)`; `rcSystem` is the two together; `complexModal` became `complexPrepare`):
        the eigen-decomposition, null space and mode weights depend on C, Y, i0
        alone, kept per read in `PREPARED` under the stray (floating) and the waves'
        shapes; each start costs only the projection. Same arithmetic, same curves.
      - **The corner search is cheaper**: bisected to `CORNER_REL` (1e-7) of the time
        to the corner, not 1e-15 s (`firstRoot`'s `rel`; crossings keep the old
        precision); the doubling grid stops where the cubic one is as dense
        (`DENSE_FROM`, its third point — for every search); and a group's states are
        read together (`coupledValues`: each mode's exponential once for all its
        states, term for term the same answer).
    - **A group is read off its network's Jacobian** (`linearizeGroup`'s `tangent`,
      network.js `networkSlopes`; same day): where the states enter pieces together
      (`joint`), the read is taken at a point INSIDE them — the base when already
      there, else the joint nudge's — as du/ds = −J⁻¹·∂F/∂s (one small Gaussian solve
      a state, where each secant was a full network solve), each state's current or
      winding voltage differentiated through it, and `s0` moved to that point (the
      model is affine in the piece, so `i0 = g + Y·s0` holds from there). Exact for
      the piece, so such a read is kept at a corner too (`pure`). Secants remain
      (`exact` false, or any `SECANT_KINDS` — q, m, o, curved; p, e, t, sloped
      numerically) for a group SLIDING along a corner (`runGroup`'s `sliding`: a
      run-on after a piece under `SLIDE_S`, 1 µs) — read exactly on either side the
      7805 catching an unloaded output chattered between its pieces a millivolt a
      run and the reservoir never filled; the secants' half-and-half model slides.
      The REGULATOR's slopes are analytic (analog-devices.js `regulatorSlope`, in
      `deviceSlope` beside the op-amp's): read a microvolt apart, a 7805 a microvolt
      from where it stops sourcing gave 2 % of its 100 S and the transformer
      supply's OUT ran to 3 kV (`spice-transformer.test.js`).
    - Tried and dropped (same day): bisecting a corner on the elements that changed
      between its two samples alone (`piecesBy` split into `branchPiece` for it,
      kept) — 4 % for a predicate that could miss an element crossing and back in
      the bracket. Most of the corner search is now its SAMPLES (~35 a search,
      `coupledValues` + the network's pieces each), not the bisection.
    - **The review's smaller findings, fixed** (same day, `spice-review-fixes.test.js`):
      a sum of SINGLE curves is searched as a coupled sum is (`listeners.js`:
      `sampleTimes` from the fastest τ and `firstRoot`'s crest look — on the cubic
      grid alone a 1 µs hump in a 1 s span was never seen); the scalar Newton path
      reads its residual against the per-net floor as the matrix path does (an
      isolated supply's L alone in its network read unbalanced every solve);
      `sharedPieces` compares element by element (network.js `pieceList`) — the
      string's characters slipped wherever a device's fragment changed length; and
      a group's corner search reads how far inside its pieces it stands —
      superseded the same day by every element's (below).
    - **Every element reports its distance to its next piece** (Jason: "every
      part, not just diodes and LEDs … step straight there instead of
      sampling"; same day). network.js `pieceConstraints`: each element's
      piece is a quantity straight in its node voltages between two edges — a
      junction's drop between its table's samples (`junctionEdges`), a
      stage's pin between the kinks where its piece really changes, a
      regulator's dropout/region/Iq headroom, an op-amp's swing edges and
      current limits, a limited supply's and a load's edges
      (analog-devices.js `analogConstraints`). `linearizeGroup`'s
      `constraints(st0, rates)` carries each along the states' affine map
      (q0 + g·(st − st0)); `margin(st)` is how far inside the nearest one
      stands — continuous, so the crest look sees a graze at ANY element,
      and a few multiplications a constraint where the pieces were a pass
      over every network. An element with no such quantity (`rest`: a
      transistor — its pieces are its inner junctions', behind RB and RC —,
      an opto, an off-rail stage "s", a splitter "t") is watched by its piece
      fragment (`branchPiece`): off it, margin −1. **Stepping**: with no
      watched element and no growing mode, `clear(dt)` (voltages.js
      `clearance`) is each constraint's distance over the most it can move
      a second from then on — Σ over modes |its rate along the mode|·e^(k·dt),
      the rates from dynamics.js `curveRates` ((a·λ + r) per term) — and
      `firstRoot`'s new `clear` steps over that stretch unread and lifts a
      bisection's low end past it. Desktop 3: reads per search 58 → 45, but
      the time did not move (×7.9 either way) — the search is now a few % of
      the run (profile flat: `networkShape`, `runGroup`, GC). The NPN sweep
      desk (watched BJT) keeps sampling; its search is ~11 %, its
      LINEARIZATION 30 % (secants — curved). Readings unchanged (sweeps to
      1e-5, Desktop 3 identical); checked during the build against the
      pieces search: 681 corners, none apart past bisection tolerance.
    - **Coarser tables, tried and dropped** (same day; desks that SWEEP a junction:
      a triangle through RC into an LED, into an NPN driving one, a sine into an
      NMOS): an LED table fitted ±10 mV from 10 µA (`fittedJunctionTable`, 9–13
      points for 23) bought ~10 % and moved the RC Fade example's LED out 19 % (6.4 s
      → 5.2 s — the fade's tail is the exponential region, where 10 mV is 20 % of
      the current); a BJT table every ×4 (19 points for 37) bought 18 % on the NPN
      desk and took the ULN2003A's 47 kΩ case to B (−6.5 %, two tables compounding);
      a MOSFET grid ×1.4 with 4 linear sub-pieces bought nothing. The sampling now
      dominates, not the corners.
    - **A plain BJT's piece is straight quantities too** (same day,
      transistors.js `bjtConstraints`): its base–emitter segment is VBE's
      interval, and along it every table column is straight in VBE, so the
      terminal VCE where the internal VBC reaches a base–collector sample
      (x + RC·IC(x) = VCE rising in x, IC the table's own there) is a line in
      VBE — its collector segment is VCE between two such lines; breakdown is
      VCE against VCEO. Checked against `bjtPiece` at 100 000+ points, every
      grade. The search no longer runs the transistor's solve at every
      sample: the transistor suites 1.9 s → 1.5 s, readings identical. A
      Darlington (the middle node is solved), a MOSFET (its saturation edge
      is a square law; its piece is cheap to read anyway), the opto, an
      off-rail stage and the splitter stay watched.
    - **Tangent reads for transistors, tried and dropped** (same day): read
      off the Jacobian at the point, the NPN-into-an-LED sweep desk ran 7 %
      faster and came out 5× further from ngspice (mean 1.6 mV → 7.6 mV,
      77 mV at the edge of a switch) — a curved device's 1 mV secant toward
      where it heads beats its tangent where it stands. `CURVED_KINDS` stay
      in `SECANT_KINDS`.
    - **Bit-identical speed-ups** (same day; Desktop 3 ×7.9 → ×9.0 headless,
      Isolated ×7.7 → ×8.5): `heldAt` with no channel on in its cluster is
      `fixedOf(net, true)` — what the shape says without building one (it
      was 7.5 % of the run, asked of every node at every corner);
      `coupledValues` keeps each curve set's modes (`modesOf`, a WeakMap on
      the curves array) instead of finding them term by term at every read;
      `sampleTimes` merges its three rising grids instead of sorting them;
      the clearance reads each mode's e^(k·dt) as the margin's read left it
      (`curveRates`' `decay`). The clearance itself is worth ~2 % — the
      reads it saves are cheap now.
    - A harness lesson: a caller that keeps ONE `clockTimes` map and re-times
      it in place made every wave edge step an RC node (the next tick's
      history replay read the new edge) — SimController builds a new map per
      tick, so the app never did; `inputs.clockTimes` is now copied like
      `clockPhase`. With that, the fade sweep desk reads ngspice's own deck
      exactly.
  - **The 2026-10-21 appraisal** (Jason: "a complete appraisal … and test the
    system for bugs"; nine reviewers, then "fix the bugs in the order you
    suggested"). Each held in `tests/spice-appraisal-fixes.test.js`:
    - **A common voltage a part DRIVES is never left to the stray** (`runGroup`,
      `FLOATING_A` 1 µA, `FLOATING_V` 10 V): floating needs the mode's current at
      the state, mᵀ(Y·x + i0), under `FLOATING_A` + mᵀYm·`FLOATING_V` — leakage, or
      held and pushed toward a balance a few volts off (Desktop 3's bridge
      conducting: 3.25 mA on 2.1 mS, 1.5 V). A 555's OUT into a capacitor wired to
      nothing hardly holds an unloaded HIGH (floating), then its LOW sinks at its
      limit, slope nothing: on 2 pF a 10¹⁰ V/s ramp, past every corner before a
      search scaled to 1 s read one — −204 V, and at 15 V the Siren without its
      speaker browned out and froze. Still sticky (a group floating before is read
      as the stray holds it, `keptModel`'s read, and let go only if pushed): the
      test every run cost Desktop 3 ×9 → ×2.8.
    - **Curves run on only on the voltage side that made them** (`own.lineage`):
      a fresh side's `epoch()` starts "fresh" whatever its netlist, so two edits at
      one paused moment (each its own netlist, the same chips and sources) stated
      alike, and the second ran on the first's curves.
    - **A tick that frees a supply judges no junction** (`lampsNow(false)`, then
      `measure`, then the burns only if nothing was freed): at its set voltage a
      reservoir through a rectifier drew 94 A from a 1 A supply and burnt the diode
      at Run. The next tick, `FREE_WAKE_S` on, judges each on the limit (a 1N4148
      across the rails still burns there, at 1 A).
    - **A burn shows the voltages after it, and wakes** (`collectVolts` again after
      `lampsNow` burns; `unsettled`): the anode of an LED burnt off 5 V through 10 Ω
      read 3.26 V, and the curves made before the burn ran on with nothing waking
      them (an RC node an LED clamped sat at 2.55 V).
    - **One unknown is bracketed when Newton runs out** (network.js scalar path,
      `solveRising`): `MAX_NEWTON` steps of `LIMIT_V` reach 120 V, so a mains divider
      ticked trough to crest read 120 V of 170.
    - **A straight group stops at a growing mode's e-fold** (`groupCorner`'s
      `model.linear` branch, `scale.grow`): a coil whose only loop a burn opened
      grew to Infinity, then NaN for the rest of the run. (What it then reads — a
      coil at 17 pA, its far end at 17.5 V on a 5 V desk — is still not the 5 V it
      should settle at; left.)
    - **A clipped wave never hands out a piece of no length** (`clipLine`'s
      `there`, `clipSine`'s `soon`, and a return already due is the line/sine): from
      2^k seconds a rail crossing a float's worth from `t` came back as a piece
      ending where it began — each its own settle, a 1 kHz 30 Vpp triangle into an
      RC 15× slower from 1 s on.
    - **Every oscillation is ring-sampled, a sixteenth of a period apart**
      (`scale.oscs`, dynamics.js; `sampleTimes` takes a list; `RING_PERIODS` 256 ×
      `RING_STEPS` 16): a 60 Hz sine in a group with a 159 kHz LC was searched
      only at the LC's period — 1.6 ms of it — and a crest clearing VT+ by a hair
      came a period late at its wakes, on time at a 1 ms grid; and an eighth of a
      1 kHz buzz (125 µs) stepped over an 84 µs excursion, so an unconnected 7 Hz
      clock on the Zero crossing example cost its '90 a count. No measurable cost.
    - **The tick's own frames know an AC supply's period** (`waveKindsNow`, given to
      `nextDisplayFrame` in both of the engine's calls): read as a clock's, a 5 Hz
      supply framed every 2 ms, not 12.5.
    - **A shown level is compared with the digital one wherever it moved**
      (voltages.js `shownMoved`, carried): a net re-read outside a pass (the tick's
      last solve, a capacitor's network) never entered `disagree`, so on a desk
      with an RC node the incremental settle showed L for a whole run where the
      gate read X (and `SPICE_ASSERT_REPLAY` threw on it).
    - **A supply drooped by a moment is woken back** (`droopStale`): a 7805 into
      100 nF drooped its 9 V supply to 5.98 V at Run, charged the capacitor in the
      same tick, and asked for no wake.
    - **A regulator has a feedback divider** (`REGULATOR_DIVIDER_S`, 1 µS OUT → REF,
      an assumption; the deck writes it as `RGD`): sourcing only, an unloaded 7805's
      OUT had no balance and read 5.75–6.5 V. Its reading's `limited` is judged on
      what it SOURCES (`regulatorAmps`), its divider's microamps aside.
    - A series RLC with an ohm or less beside its source lost that ohm (6.015 Ω
      read for 7.015): the one-unknown Newton's MIN_STEP_V floor left the net
      unbalanced; the bracket above settles it.
    - **A saturated BJT's base resistance carries its reverse base current too**
      (transistors.js `bjtAt`, 2026-10-22, Jason: "do 1"): the table folds RB in
      at the FORWARD base current only, so saturated it is read at `u` = VBE −
      RB·IR/BR (`solveRising`; `core` returns `ir`), nested outside the RC solve.
      A 2N3904 through 220 Ω read VB 0.77 V where ngspice reads 0.9545 (now
      0.9539); the NPN sweep desk went from 1.6 mV mean off ngspice to 0.32 mV.
      Saturated (`kc ≥ 0`) behind an RB its base–emitter segment is no longer
      straight in VBE and VCE, so `bjtConstraints` returns null there and it is
      WATCHED (`pieceConstraints`' rest); active, it is as exact as before.
      Transistor suites ~4 % slower. **Solved faster since** (the fourth regrade,
      2026-10-22, Jason: the three performance items): both drops by Newton's
      steps at once along the tables' slopes (`jointDrops`, `coreSlopes`; the RC drop
      alone `internalVce`), the nested brackets only where they do not settle — ~10
      core reads a call where ~47 were, answers within 1e-11 relative; a WATCHED
      saturated transistor is searched for by its distance inside its piece
      (`bjtMargin` → network.js `branchMargin`: its internal VBE's and VBC's to
      their segments' edges, its VCE's to VCEO — continuous where its piece steps),
      and with nothing to step over `firstRoot` closes on a root by Brent's method
      (rc-curve.js `closeOn`), not halving to 1e-7 of the stretch. A transistor
      astable at 100 nF went 12 → 5.7 s a simulated second, at 1 µF 1.3 → 0.65.
    - **A corner reached by the tick is no stuck corner** (`runGroup`'s `repeat`,
      the same day): re-linearized a hair short of the corner it had just reached,
      a group ran on along the OLD piece for twice the whole previous piece (`t −
      prev.t0`) — past the next corner unseen: a relay coil's flyback current through
      its diode came out 0.13 % off ngspice, and differently as ticks fell (the
      golden `relay-flyback` not steady). The first repeat runs twice the hair to
      the corner it found (`corner.tEnd − t`); only a run that was itself stuck
      doubles its piece. Both spacings now read ngspice's value.
    - **`linearize` reads its network's SHAPE, not a free solve** (`networkShape(k,
      {free})` — driven, branches, drivers, fixed nets need no Newton): one solve of
      seven an op-amp oscillator's linearize made; and `farCorner` makes its straight
      guess only when the remembered one did not hold. A 706 Hz LM358 relaxation
      oscillator 1.37 → 1.2 s a simulated second — still behind real time (two ticks
      a period, ~0.85 ms each; drawing cycles slower than the cap at their own rate was
      tried and reverted: periods, speaker pitch and readouts snapped to MIN_SHOWN_S).
    - **A straight group read at a voltage no bench reaches is read again**
      (`runGroup`, `WILD_V` 1 MV, after 50 of its slowest time constants): a coil
      whose only loop a burn opened kicked its far end to 1e11 V, and its read
      there — a difference of numbers eleven places long — settled 12 V off
      (17.5 V on a 5 V desk). Now 5.000 V.
    - **An unbalanced cluster is solved once more, then woken soon, once**
      (voltages.js `solveCluster` retries from where Newton stopped —
      `network(k, {guess})`; `newlyUnsettled()` → a wake `MIN_SHOWN_S` on, only
      for a cluster that was balanced before, so one that never balances does not
      tick the desk every half millisecond).
    - **Found and left**: a Darlington's two bases keep the forward-only RB fold.
      (A fixed regulator whose GND is wired to nothing, left here that morning, was
      fixed the same day — bench-parts.md → `refOpen`.)
    - **In the app** (2026-10-22, Electron on an isolated profile, Spice Lite, ×1,
      8 s each): Desktop 3, the adapter examples, the speaker Tone and Siren, lc
      Ringing and the W65C02 computer all ran at real time, never behind; at ×4
      Desktop 3 held ×4, Ringing ×3.6, Tone ×2.2, Zero crossing ×2.1.
  - **The 2026-10-26 speed round** (Jason: "do the speed round on this desk … see
    what can be pre-calculated and/or cached … quality can't vary by more than
    1–2 % from ngspice"). Desktop 3 had grown an LM339 mains-detect network off the
    adapter's S2 (47k dividers, three units, two with hysteresis; c48 100 nF from
    one unit's open collector to the next one's IN+, c49 clamping that to the 5 V
    rail) and
    ran ×0.31 in the app. Profiled headless through `bench/drive-spice.js`: ~3 600
    corners a second (the bridge's diodes ~2 400, c49 ~840), each re-solving one
    14-net cluster thirteen times. Now ×0.55 → ×2.1–2.3 headless; in the app it
    holds ×1 and reaches ×1.5–1.7 at ×4. Readings within 3e-5 V of before at
    every net (the ngspice `same` deck's errors unchanged), the comparators'
    switching times unchanged, the golden scorecard identical, every shipped
    example's readings bit-identical or within 3e-8 V. In `runGroup` unless said:
    - **A kept read serves a balanced common mode too** (`keptModel` no longer
      refuses `modes`): on the same pieces the balance only moves the states along
      them. c48's plates — joined to nothing fixed — had switched the cache off
      for the whole group.
    - **The read's own balance, checked once** (`balancedAt`): the linear piece's
      start IS the networks' balance where they agree there — one solve of the
      true networks against `BALANCE_V` of the mode's conductance, where the
      search (`balance`) and a second read took a dozen. A comparator's swing
      kicking the plates volts away still searches.
    - **A corner's pieces from the last read** (`known`; `READ_OF` keeps each
      curve's `{members, model, sys}` beside it, out of the carried state, which
      is compared as data): arrived at `last.tEnd` on the same networks with
      nothing stepped, the last read's map carries every element a hair past the
      corner (`groupCorner` ends past it) — `model.piecesAt` there names the
      pieces entered, and the read kept under them (`@` + `model.entered()`, its
      own pieces where it was read) is the read: no `groupKey` solve, no
      `adoptGroupSwing` — unless an op-amp's piece changed (`model.swings`),
      whose swing only the true networks show. Its balance needs no check within
      `KNOWN_BALANCE_V` (1 µV) of where the last piece left the plates.
    - **…or read where the states stand** (`wanted`, `linearizeGroup`'s `here`:
      the tangent at the base, no joint nudge): no read kept for those pieces —
      a bridge's second diode microseconds short of the point its partner has
      just crossed, which `groupKey`'s nudge would carry across too.
    - **Constraint sets kept by the pieces a search starts on** (`constraints`'
      `at`, `keptConstraints`): every quantity is straight in the states.
    - **The clearance knows which way a mode pushes** (`clearance`): a real mode
      one way for good, a decaying one no further than |rate|/|k|; a ringing one
      the way it goes now, turning no faster than |rate|·|λ| (`curveRates`'
      `cos`/`sin`). Read as a speed either way, the mains sine held each search to
      a doubling grid from the nanosecond (22 reads → 11).
    - **A bracketed corner is closed on the one quantity past its edge**
      (`firstRoot`'s `focus`, `constraints`' `past`): Brent's method on it, taken
      where nothing else is past its edge a tolerance short and half a tolerance
      on (as a halving lands on average); else halved as before (20 reads → ~8).
    - **An op-amp's output levels are no part of `epoch()`** (voltages.js): its
      outputs are its devices', never a stage, so a comparator's swing no longer
      made every curve and kept read of its group anew.
    - **The analyzer's statements from the reads** (`model.statement`): a watched
      net a pure read covers is stated off its map (exact on its pieces), not by
      `affine`'s solve a node a tick (9 % of a run with the analyzer recording).
    - **Cluster solves start where the reads put the nets** (`guessAt` →
      voltages.js `guessNets`, used once by the next `solveDirty`): the settle's
      and the tick-end `resolve`'s solves started from the last settle's volts,
      ~3 Newton steps each; from the read's prediction, the answer.
    - **No cycle moment for an island whose running sine settles nowhere**
      (`record`'s `settlesNowhere`): `curveSummary`'s vInf is NaN, near no
      other, so no such moment could begin or end a cycle — and its signature,
      written at every corner, was a tenth of the run.
    - **Tried and dropped**: letting corners on an op-amp island wait for their
      frame (`cornerWaits`) — 5× fewer ticks, 9 % faster, and the regrade's
      switching-time rule broken; Brent's method in `balance` (no fewer reads: a
      clamp's kink at one end of the bracket); a lazy `sampleTimes` (no gain).
    - **Left**: a swing's balance — ~16 solves, each from the pre-swing volts
      (warm-starting them along the search would change which balance a
      bistable network lands on) — is ~17 % of the run now; the hits' corner
      search ~15 %; the settle ~10 %.
    - **Measuring in the app** needs Electron launched with
      `--disable-background-timer-throttling --disable-renderer-backgrounding
      --disable-backgrounding-occluded-windows`: a window behind the terminal is
      throttled to a timer a second and read ×0.2.
  - **The 2026-10-26 review's fix round** (the whole-system grade, Spice Lite
    B+; `tests/spice-review-1026-fixes.test.js`):
    - **A transistor driven far past its knee is solved, not searched**
      (transistors.js `jointDrops`, DAMPED: a step that leaves the two drops
      further out of balance is halved, up to `JOINT_STEPS` 40; balanced to
      the rounding of its own terms is balanced). A coil forcing ~15 A
      through a PNP's base (its flyback diode burnt) put VBE tens of volts
      behind RB, the undamped steps went round a cycle of three, and every
      read fell to the nested Brent search: 17 s and 72 s ticks, the coil
      ending at −824 A; now ~25 ms, the coil at 0.8 A. A sine into an NPN
      switch 30 → 18 s a simulated second. Golden identical, the shipped
      examples bit-identical bar ulps on the two relay desks. No pnjlim, no
      evaluation budget in `newtonSolve` — not needed once the device solve
      converged. Base-junction reverse breakdown NOT added: ngspice's BJT has
      none, so it would move results away from the reference.
    - **The hot work is module-level** (the reviewer saw `into`, `slopes`,
      `vAt`, `err` compiled 63× each in 10 s in the app: a closure's optimized
      code is held weakly by its shared feedback vector, and dies with the
      last copy at a GC between ticks): `newtonSolve` is a class
      (`NewtonSolve`, its steps methods; `vAt`/`vAtOver` the only per-solve
      arrows — `into`'s devices read one net at a trial voltage through
      `overNode`/`overV`, not a closure per device); `report`'s merge is
      `mergeEntries`, `inputFlow`'s body `inputFlowOf`; engine.js
      `collectVoltsInto`, `heatAt`, `junctionVerdict`. Bit-identical.
    - **Allocation** (busy fixture 2.44 → 1.61 MB a tick): `outputStage` kept
      per def/side/strength/supply (`STAGES`, frozen; a drooping supply's
      64 newest), `inputStages` per family/figure/supply (`INPUT_STAGES`) —
      both were rebuilt for every chip at every plan, a 74LS table's corners
      included; `verdicts` builds its dark entry only for a dark junction.
      Busy fixture 0.84 → 0.70 ms a tick.
    - **A capped settle is said** (engine.js `settleAt` → `cappedNets`): only a
      tick's LAST settle's warnings reached its result, so one capped at a
      crossing mid-tick went unsaid (twenty capped in twenty-one ticks); one
      that marked no net (readings, not levels, still turning) is named by
      the nets whose readings changed `RESTLESS_TIMES` (3) times
      (voltages.js `restless`/`takeRestless`). Hysteresis on CONDUCTS_A was
      NOT added: the flip seen was a net held ↔ unheld by an unbalanced
      solve, not a current hovering at the threshold.
    - **A coil's run-on stops looking where its ring can no longer reach
      zero** (dynamics.js `signHeldAfter`: past where the dying modes' summed
      envelope, each at the slowest rate, is half the final value, the curve
      keeps that value's sign; `sampleTimes`' `cut` makes the same list up
      to its first time past it). A 500 kHz ring on 100 µH / 1 nF 123 → 27 s
      a simulated second, bit-identical.
    - **Stacked supplies** (sim/floating-grounds.js `stackedSupplies`; see
      spice-lite.md "A PSU shorted"), in both engines (`buildContext`,
      rc-trace's `rail()`) and the deck. engine.test.js's "opposing supplies
      on one net" now grounds both −s (a + on ground: still a short); the
      same desk without that wire is a stack (its new neighbour test).
    - **Every overloaded supply starts at its set volts** (Jason: "match
      ngspice" — the deck charges every supply's 470 µF, `CPSU … IC=set`): a
      freed one's freeing tick reads what that capacitor holds, a chip-powered
      one is paced down from set (`capDroop`, `pacedVolts`); both sag
      monotonically (bench-parts.md, "A supply ON ITS LIMIT"); golden
      unchanged. spice-current.test.js's six Run-droop tests now tick the sag
      (`sagged`, `monotone`) and assert their figures where it ends. Booking the capacitor at the droop instead
      (tried first) took `lm7805-9v-limited-0.25a-1m` to D.
    - **Op-amp and comparator inputs no longer decide a net's shown level**
      (spice-lite.md "SHOWN level"): the LM358/LM339 examples' input nets now
      show their logic level (X on a divider) where they showed the op-amp's
      reading.
  - **The regrade's phase 7** (2026-10-27, `tests/spice-phase7-fixes.test.js`):
    - **A small-signal diode's die burn is a crossing** (`burnWatch`, `burnDiffs`,
      `restateBurns`, `burnAt`; diodes.js `burnVolts`): tick-spacing independent. NB: a
      1N4148 on an ideal edge through a big capacitor — a clamp, a pump — burns at the
      edge (6 A), as a 1N4007 does (100 A past its 30 A surge): the ideal clock brick had
      no output resistance. Jason (wave 2b, 2026-10-27): the brick's 50 Ω
      (`CLOCK_OHMS`, spice-lite.md → "Clock waves") — 0.1 A, nothing burns; the
      1N4148 clamp and pump are golden cases (`coupled-edge-diode-*`).
    - **No run-ahead past the moment on a chipless or wave island** (`cornerWaits`
      grows `onChip`; `ahead` ignores the half-budget rule, `wakeFor` keeps it). Tried
      for islands of discrete transistors too (`settlingWaits`, nothing heard, no
      growing curve, no coil): A everywhere, astables/flasher/MOSFET ring intact, but a
      coupled base trigger ran 9 % slower — held back, then SHIPPED in wave 2b (Jason,
      2026-10-27) confined to an island a BENCH SOURCE drives: on a flasher no source
      drives, held, every corner became a tick (+25 % ticks, +23 % time on the 10 µF
      fixture), so it is left to run on there. Of 353 desks (every golden case, every
      example, the fixture flashers) only `coupled-edge-npn-base`'s work changed (one
      settle fewer) — now A, its `known` dropped. Its corner is the next tick's own
      wake, never held to a display frame: tried, a flasher's fold came a frame late.
    - **The cost of both, ACCEPTED by Jason (2026-10-27)**: a clock-driven NPN→PNP
      high-side switch at 1 kHz runs +13 % (15.8 → 17.9 s a simulated second; 100 Hz
      noise) — the 50 Ω makes the clock net an unknown of the solve (~+5 % transistor
      evaluations) and the hold costs `farCorner` bisection (~+6 %). Seeding the clock
      net's guess at its stage level won it back there but took the NPN and Darlington
      LED switches +50 %, so it was dropped; junction limiting or a cheaper `farCorner`
      would be the road back.
    - **Waves alone are not corner-searched** (`cornerless`, spice-lite.md).
    - **A solved-unheld transistor reads off** (voltages.js `selfLevel`): repro E 4122
      → 274 passes, no capped settle, and within 0.1 % of ngspice but at the latch's fold.
      Its time is still ~750 s a simulated second: ~250 junction corners each 100 µs
      half-period, a full solve each (two BJTs and two Zeners).
    - Each MOSFET N grade's body diode its card's; `CONDUCTS_OV`; deck `BX`. The P
      grades' (wave 2b): least-squares fits to their sheets' curves — BS250 Vishay
      70209's "Source-Drain Diode Forward Voltage" (axis in mA though labelled A),
      IRF9540N IR PD-91437B Fig. 7 — `DBBS250`/`DBIRF9540N` in the deck; four
      `pmos-body-*` cases, all A.
    - **Per-tick closures (runtime N4) left**: over an 18 s speaker run the named ones
      (`solveShape`, `report`, `fixedOf`, `stageAt`, `nodeOf`, `auth`, `verdictOf`,
      `verdicts`, `pace`, `fedMoved`, `drawnSteady`, `islandOf`, network `vAt`) compile
      0–3 times after warm-up — nothing to gain.
  - **Round 2's solver step control** (2026-10-27, network.js; `spice-network.test.js`'s
    two round-2 tests). Golden scorecard identical, busy fixture unchanged:
    - **A step the line search cuts to a sliver is taken whole and re-balanced**
      (`balancedStep`, past three halvings, no op-amp in the network): each net
      limited to `LIMIT_V` on its own, every net it threw further out of balance
      balanced alone against the rest (two Gauss–Seidel passes), kept where that
      beats the sliver. An NMOS gate through 1 MΩ + 1 kΩ with two diodes cathode to
      cathode to its drain read 3.49 V at Run, creeping to 4.83 V at 1 s; now
      ngspice's 4.995401 V from t = 0. NPN and Darlington LED switches on a 1 kHz
      clock ~2.3× faster (0.45 → 0.19, 0.53 → 0.19 s a simulated second).
    - **A device is read once a Jacobian, once a residual** (`memoSlope`, `into`'s
      memo): its currents at the point, its piece and each terminal nudged — not
      once per net it touches. Bit-identical. With the above, the clock-driven
      NPN→PNP high-side switch 17.3 → 14.5–15.0 s a simulated second at 1 kHz — the
      +13 % of phase 7 won back.
    - **Balanced to its own rounding** (`roundingFloors`, `atRounding`): a step that
      gains nothing where every residual is within sixteen ulps of the network's
      largest volts through its Jacobian row is a balance — two BJTs solved to
      `LINEARIZE_A` stop a femtoamp short (their drops are solved to ulps), and were
      swept and solved again. Finding E 750 → 570 s a simulated second, within
      0.1 % of ngspice as before. Left: its ~250 corners a half-period, ~2.7 solves
      each (`linearizeGroup`'s base, joint and secant solves), are the rest.
    - **Left, for voltages.js**: the net between those two cathodes is still shown
      no voltage (its junctions carry nanoamps, under `CONDUCTS_A`); ngspice's same
      deck reads 4.746666 V, which the solve has exactly.

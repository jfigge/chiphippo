# Spice Lite 2 — implementation plan

The spec is `features/chiphippo-spice-lite-2.md`. This plan is rebased on the Spice Lite
migration of 2026-10-07 (`features/spice-lite-audit.md`, phases B–D), which landed much
of what that spec's section 3 asks Spice Lite to grow.

**Status (2026-10-07): implemented.** Jason accepted every default below (open questions
1–5) and the audit's (a)–(f). Landed: the seam (`def.silicon`, `logicOf`, `stepEnv`),
every RC net a node, per-pin and window listeners, capacitor coupling and lone-capacitor
pairs, the silicon of all seven timing parts, measured readouts, fast-oscillator
schedules, and the LCD backlight/contrast (audit (c)). Measured against the sheets: see
"Results" at the end. Not committed.

## Where Spice Lite stands now

Phases B–D gave Spice Lite one network solve for every net (`spice/voltages.js` over
`spice/network.js`). Against the spec's section 3 and its open questions:

| Spec item                                         | Status after B–D                                                                                                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3.3 Resistor-only junctions                       | **Done.** Every net is solved per pass; DISCH between RA and RB, or φI behind Rs, is just a net of a cluster.                                                                                                                  |
| 3.3 The RC node's Thévenin through such junctions | **Done.** An RC node's curve comes from its whole cluster, linearized where it stands (`linearize`), re-linearized at every corner.                                                                                            |
| 3.3 "The LED does not drain the capacitor"        | **Gone.** An LED, diode or input on an RC node is part of its cluster and loads it.                                                                                                                                            |
| 3.5 Output stages on the far side                 | **Done.** Every output is its stage wherever it drives; an output charging a capacitor is a curve through its own resistance, or a ramp at its saturation current.                                                             |
| Q3 Diodes in the timing network                   | **Answered.** Diodes and Zeners are junctions of the solve, so the 50 %-duty 555 (a diode across RB) needs no timer code.                                                                                                      |
| Q5 An output's current against its rating         | **Answered** (Jason, Q9/Q10 of the audit): `output-current` warns past the family limit and smokes past its maximum. A part with its own `outputStage` (the 555) is exempt from the family pair; the 555 gets its own (below). |
| 3.1 Timing capacitors become nodes                | **Done.**                                                                                                                                                                                                                      |
| 3.2 Per-pin listeners                             | **Done.**                                                                                                                                                                                                                      |
| 3.4 Capacitor coupling                            | **Done.**                                                                                                                                                                                                                      |
| 3.6 Fast oscillators                              | **Done.**                                                                                                                                                                                                                      |

So what remains is the four general extensions, the seam, and the parts.

## 1. The seam: `def.silicon`

- **The on implementation is a second block on the def, `silicon`**, beside `logic`
  (which stays the off implementation, untouched). The name says what it is: the part
  as its silicon behaves.
- **Only Spice Lite reaches it**, through one hook: `hooks.logicOf(c)` answers the
  `logic` block a chip is evaluated with (`chip-eval.js`'s callers, `settle-pass.js`
  `chipOutputs` and `engine.js`'s step loop, read `c.logic` resolved once per context
  instead of `c.def.logic`). Spice Lite answers `def.silicon ?? def.logic`; the digital
  engine never passes the hook. No part's code asks whether Spice Lite is on.
- **A silicon block is the standard sequential contract plus its pins' electrical
  behaviour:**

  ```js
  silicon: {
    state0, step(state, ins, prev, env), outputs(state, ins),  // the digital core, reused
    sense: { [pin]: (vcc, volts) => ({ up, down }) },          // §2 per-pin references
    stages: { [pin]: (vcc, level, state) => stage | null },    // push-pull / open-collector
    internals: { nets: [...], resistors: [...] },              // §3 the package's own parts
    iccMa,                                                     // its own supply current
  }
  ```

  `ins` carries a SENSING pin's comparator verdict (H/L) instead of a logic reading;
  `step`'s `env` keeps `now` (for a part with a counter) but carries no `timing` — there
  is no wiring recognition, and `timing(probe)` is not called for a silicon part under
  Spice Lite.

- **Removed from the 555**: the `probe.curves` branch (`CURVE_K`, the `first` lead
  segment, the back-calculated `nodeVolts`, `curveMoving`). Its off implementation is
  the datasheet constants again, with Spice Lite off exactly as today; the parity
  exemption for the two 555 desktops stays (with the reason reworded: "the 555 is its
  silicon under Spice Lite").
- **Pin roles do not change.** The silicon block states its pins' behaviour itself.
- **Catalog ratchet**: every `isTimed` part has a `silicon` block
  (`tests/parts-catalog.test.js`).

## 2. Per-pin listeners (spec 3.2)

- Today a chip reads an RC node through one `{up, down}` pair per CHIP. A sensing pin
  gets its own: `silicon.sense[pin](vcc, volts)` returns its comparator's trip point(s),
  where `volts(pin)` reads another pin's solved voltage — which is how CONT moves both
  of the 555's references.
- The RC listener (`analyze`'s `cand.listeners`) becomes per (chip, PIN), and its
  thresholds are re-read at every `updateNodes` (CONT can move). A crossing is a one-shot
  exactly as today.
- On a DC net (no capacitor), a sensing pin reads its voltage against the same trip
  point through `voltages.js` — `readNet` grows a per-pin reader for a chip with
  `sense`, nothing else changes.

## 3. The package's own parts

- **Internal nets**: `silicon.internals.nets` names nets inside the package (the 555's
  divider tap below CONT); `voltageTopology` adds them as nets of their own
  (`<compId>#<name>`), which clusters, solves and probes nothing else sees.
- **Internal resistors** between pins and internal nets (the 555's three 5 kΩ) are
  branches like any resistor. A capacitor on CONT is then an RC node in a cluster with
  the divider, and a voltage forced onto CONT moves the references through `sense`.
- **Open-collector stages** (the 555's DISCH, a monostable's Cx discharge): already
  expressible — a stage that only sinks (`{volts: 0, ohms: Ron, sources: false}`) while
  on, `null` while off. `silicon.stages[pin]` returns it per state; the solve, the
  supply booking and `output-current` treat it as any output.
- **The 555's own limits** (SLFS022K abs max: output 225 mA, DISCH as the sheet gives)
  as its own `outputLimits` entry — the one exemption the family pair already makes.
- **ICC from the part's sheet** (`silicon.iccMa`) in place of the family figure
  (`spice/supply.js` and the off-rail chip load both read it).

## 4. Timing capacitors become nodes (spec 3.1)

- `analyze`'s `owned` set is dropped for a part with a silicon block: its RC nets are
  candidates like any other, probed and drawn.

## 5. Capacitor coupling (spec 3.4)

- **For every RC node on the desk** (open question 4's default). When a capacitor's far
  side MOVES between two settles by Δ (its net's solved voltage, or another node's
  curve), the node jumps by Δ·Ck/ΣC — its capacitors' charge conserved — and its curve
  is re-anchored there. A far side that is itself a node is moved together (a
  capacitor between two nodes is one charge).
- The clamp needs nothing new: a CD4000 input's protection diodes are already stages of
  the solve (`CMOS_CLAMP`), so a node driven past a rail is linearized with the clamp's
  200 Ω on it and comes back at that rate. Where the input has a series Rs in front of
  it (the 4060/4541), the swing past the rail happens on the far side of Rs — which is
  what makes 2.2·RC come out.
- The AC-coupled trigger (a button through a capacitor into TRIG) works, and leaves the
  guide's "does not model" list.

## 6. Fast oscillators (spec 3.6)

- A node oscillating faster than the desk can show today hits `MAX_ANALOG_EVENTS` and
  is reported as `oscillation`. For a cycle of exponential segments that REPEATS — the
  same sequence of (curve target, τ, the crossings' verdicts, every part's state) twice
  round — the period and duty are exact: the loop records each crossing's signature,
  and on a repeat it hands the cycle to a schedule (`sim/timing.js` `capSchedule`'s
  shape: drawn at `TIMING_CAP_HZ` with its duty kept, reported at its TRUE rate, no
  warning) until something outside the cycle changes (a reading of anything else, an
  edit).
- The 40106-style RC oscillators get the same treatment (one mechanism for any repeating
  node, not a timer feature).
- The CD4060B/CD4541B counters keep counting their slow stages at the true rate: the
  schedule tells their `step` how many cycles passed (`env.cycles`), as `rebaseCount`
  does today.

## 7. The parts

| Part                      | Internals (source)                                                                                                                                                                                                                                                                                                                                                              | Expected against the sheet                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NE555                     | SLFS022K functional block diagram: 3 × 5 kΩ divider (CONT, internal tap), threshold comparator at CONT, trigger comparator at CONT/2, SR flip-flop (RESET wins), DISCH open-collector, bipolar OUT (`outputStage`, exists), RESET threshold 0.7 V, threshold/trigger input currents.                                                                                            | Astable 0.693·(RA+RB)·C / 0.693·RB·C, first HIGH ln 3 / ln 2 longer; monostable 1.1·RA·C; bistable as today; CONT capacitor harmless; a voltage on CONT moves the frequency; within ~2 %. |
| CD4098B, CD4528B, CD4538B | Per section: RX CX sense, Cx discharge switch (open-drain), trigger/retrigger/reset logic as today's `dualMonostableLogic` core. The comparator reference from the sheet where shown, else DERIVED from its formula and stated as derived (open question 1): ½·Rx·Cx → VDD·(1 − e^(−½))… CX tied to VSS inside the 4098/4538 (an internal connection); the 4528's T1 still not. | ½·RxCx, 0.2·RxCx·ln(VDD), RxCx — exact by construction where derived; retrigger and reset through the node.                                                                               |
| CD4047B                   | SCHS044C logic diagram: the R / C / RC COMMON oscillator (two inverters and the Schmitt it shows) plus the multivibrator core reused.                                                                                                                                                                                                                                           | 4.40·RC astable, 2.48·RC monostable — from the internals or REPORTED as not reproducible (no nudging).                                                                                    |
| CD4060B, CD4541B          | Fig. 12 / Fig. 2: φI an ordinary CMOS input (with its clamps), φ̄O = NOT φI, φO = NOT φ̄O as push-pull stages; the counter core reused; external-clock mode unchanged.                                                                                                                                                                                                            | ≈ 2.2·Rx·Cx, 2.3·Rtc·Ctc with Rs as the sheet recommends; Rs missing or tiny changes the period, visibly.                                                                                 |

Every internal number is cited at its def. If an internal gives a period more than a few
percent from the sheet's formula, implementation stops and reports it.

## 8. What the user sees

- The probe and analyzer show the real THRES/TRIG, DISCH, CONT, RX CX, RC COMMON and
  junction voltages (they are nodes and nets now).
- A timed part's readout, running under Spice Lite, shows the MEASURED frequency or
  width (from the crossings, or the fast-oscillator schedule); the Properties card's
  Timing row, computed from the off implementation, keeps the datasheet figure.
- No new settings. Recognition warnings (`ne555Unrecognised`, "no capacitor") are not
  raised under Spice Lite (open question 2's default): the part does what its pins say.
- Guide: the "Timers" section rewritten; "does not model" loses coupling and the timing
  parts' own circuits. Locales ×7 for any new sentence.

## 9. Phasing

1. The seam (`logicOf`, `def.silicon`, ratchet) with the 555's off implementation
   restored to the datasheet constants.
2. Per-pin listeners and internal nets/resistors (engine-general, tested alone).
3. Capacitor coupling (engine-general, tested alone: charge conserved, the clamp, the
   AC-coupled trigger).
4. NE555 silicon; its astable/monostable/bistable/CONT/RESET tests from its pins.
5. The monostables; then the 4047; then the 4060/4541 (needs 3).
6. Fast oscillators.
7. Docs, locales, parity reasons.

Gates per step: `make test` green; the digital engine's results byte-identical;
`tests/engine-parity.test.js` with only reasoned exemptions; `make bench` within 2× of
the Spice Lite baseline after phase B (1.45–1.55 ms/tick on the busy fixture).

## Open questions for Jason (defaults given)

1. **Formula-only sheets** (4098, 4528, maybe 4538): derive the comparator reference
   from the formula, stated as derived at the def? Default: yes.
2. **Recognition warnings under Spice Lite**: dropped? Default: dropped.
3. **Capacitor coupling for every node on the desk**, not just the timers'. Default:
   yes.
4. **The name `silicon`** for the on-implementation block. Default: yes.
5. **The 555's own output limits**: from SLFS022K's absolute maximum (225 mA output)
   as its own `outputLimits` entry. Default: yes.

## Results (2026-10-07)

Each part from its pins, 5 V unless said, against its sheet's formula:

| Part    | Circuit                        | Measured                                    | Sheet                       |
| ------- | ------------------------------ | ------------------------------------------- | --------------------------- |
| NE555   | astable 10k/10k/10 µF          | HIGH ln 2·τ, LOW +0.5 % (DISCH), 1st ln 3   | 0.693·(RA+RB)·C, 0.693·RB·C |
| NE555   | monostable 10k/10 µF           | 1.0986·RA·C                                 | 1.1·RA·C                    |
| CD4047B | astable 100k/100 nF            | tA/2 2.204·RC (+0.2 %), tM 2.47–2.49·RC     | 2.20, 2.48                  |
| CD4047B | one-shot, one retrigger        | tM, tM + 2.2·RC                             | tRE = t1' + t1 + 2·t2       |
| CD4098B | 100k/100 nF, 5/10/15 V         | +0.7 / +0.5 / +0.5 %                        | ½·RC (references derived)   |
| CD4538B | 100k/100 nF, 5/10/15 V         | +0.5 / +0.3 / +0.3 % (10k/1 µF: +2.3 %)     | RC (references derived)     |
| CD4528B | 100k/100 nF, 5/10/15 V         | +1.2 / +0.6 / +0.4 %                        | 0.2·RC·ln VDD (derived)     |
| CD4060B | Rx 10k, Cx 1 µF, Rs 20k / 100k | 2.233 / 2.257·RxCx (+1.5 / +2.6 %)          | 2.2·RxCx                    |
| CD4541B | Rtc 10k, Ctc 1 µF, Rs 20k      | 2.233·RC (−2.9 %)                           | 2.3·RC                      |
| CD4060B | Rx 1k, Cx 100 nF, Rs 2.2k      | 2.70·RxCx (+23 %: the outputs' ~400 Ω each) | 2.2·RxCx                    |

The 4060 at Rx = 1 kΩ is the one past "a few percent": its two
outputs' resistance (≈400 Ω each at 5 V, the family's stage) sits in series with Rx and
Cx, which the formula leaves out. Reported, not nudged. The 4060 and 4541 share one
network and so one constant (2.23); their sheets disagree (2.2 vs 2.3).

# Spice Lite 3 — fidelity plan

**Status (2026-10-08): done.** Measured against `main` at `4023dda` ("Spice (#5)").
Jason answered questions 3, 5 and 10 on 2026-10-08 (see "Spice-only properties" and the
questions at the end); the others kept their defaults. Every phase landed; see
**Results** (below) for the final scorecard, and each phase's "Landed" note for where the
build differed from the design.

## Results

The final scorecard (`spice-golden.test.js`, every area's floor raised to what it reached):

| Area                                                  | Before | After | Worst case after                                     |
| ----------------------------------------------------- | ------ | ----- | ---------------------------------------------------- |
| Resistive DC                                          | A      | **A** | exact                                                |
| Single-capacitor RC, Schmitt relaxation               | A      | **A** | 0.03 %                                               |
| Multi-capacitor RC networks                           | D      | **A** | 0.01 %, at every tick spacing                        |
| Capacitor-coupled gate oscillators                    | F      | **A** | 0.37 % (the CD4069UB pair without Rs)                |
| NE555 timing                                          | D      | **A** | 0.39 % (1 MΩ / 1 MΩ, its LOW time)                   |
| LEDs (every colour, 100 Ω–10 kΩ)                      | B+     | **A** | 0.24 %                                               |
| Silicon diodes                                        | B      | **A** | 0.17 %                                               |
| CMOS output stage dynamics                            | B+     | **A** | 0.07 % at 5 V, 1.3 % at 10 V (after the plan — below) |
| BJT as a saturated switch (every grade)               | B−     | **A** | 1.3 % (TIP31C)                                       |
| BJT in its active region (every grade)                | D      | **A** | 0.46 %                                               |
| MOSFET fully on (every grade)                         | C / D  | **A** | 0.06 %                                               |
| MOSFET near threshold (every grade)                   | F      | **A** | 0.05 %                                               |
| Inductors (RL, relay ± flyback, series RLC)           | F      | **A** | 0.29 %                                               |
| 74LS input / output stages (against SDLS025, by hand) | (B−)   | **B** | VOH +4 % at −0.4 mA                                  |

**Overall: A** for everything Spice Lite models, against B asked for, with the 74LS stages
at B. (The CMOS output stage finished this plan at B, 6.3 %: two straight lines where the
part is a curve. Afterwards, the same day and with no plan of its own, the stage became the
square law its two figures set, drawn as chords — `spice/output-stage.js` `CURVE_CORNERS` —
and the `device` card the same law per supply: 0.07 % at 5 V, A, and a 10 V case added at
1.3 % — every corner of its curve within 0.07 % of the exact law; the rest is a reading taken
a few µs late, a tick chaining through corners within `FAST_WINDOW_S` of each other past its
own moment. The two-gate CD4069UB pair moved from 0.37 % to 0.7 % with it, still A.) Three things kept the plan honest about what an A means:

- A transistor area grades the ENGINE against each grade's own figures — the vendor card
  where one exists (2N3904, 2N2222A, 2N3906, 2N2907A), else the grade's fit to its sheet,
  stated as a card (`gradeCard`). The fits themselves meet their sheets' points within
  10–20 % (`spice-transistors.test.js`), and a part on the desk whose part number is not
  its grade's representative simulates as the representative.
- An LED area grades the table against each colour's fitted curve; the fits meet their
  Kingbright figures within 27–51 mV.
- The bench held: 3.9 ms per Spice Lite tick on the busy fixture, faster than the
  5.06 ms baseline and well inside the 1.25× gate.

**Phase 5 and 6 (landed).** A gate its own feedback resistor biases into its linear region
says so — `linear-bias`, `spice/linear-bias.js`, in place of the chatter or floating input
its loop raised (a Schmitt part, whose loop is an oscillator, is not one). The guide gained
"How close it is to SPICE" and the scope list; every new string is in all seven locales;
the rules, the roadmap and this plan's home (`features/done/`) are updated.

**The goal.** Spice Lite is not meant to be a full SPICE, and this plan does not try to make
it one. What it does model should be modelled as well as it can be. Concretely:

1. Fix the defects the comparison against ngspice found.
2. Give the inductor, the one catalog part with no electrical model, a real one.
3. Bring every area Spice Lite supports to at least a **B** on a rubric measured against
   ngspice.

Where a B is not feasible, the plan says so and says why.

**The identity this plan keeps.** Spice Lite is a _piecewise-linear switched-system_
simulator: within one linear piece every element is a straight line, the circuit is solved
exactly, and the only events are threshold crossings and corners. That is what makes a
10-second RC cost what a 10-µs one does, and it stays. The core change (Phase 2) makes each
piece's solution exact for ANY number of capacitors and inductors in a cluster. Today it is
exact only for one.

---

## The rubric

A grade is per AREA (a row of the scorecard below). It is measured on that area's golden
circuits (Phase 0) against a pinned ngspice reference.

| Grade | Means                                                                                                                                                                                                                                                                                                |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | Every golden case within **2 %** of the reference (or 20 mV for a voltage under 1 V), and qualitatively identical.                                                                                                                                                                                   |
| **B** | Every case within **10 %** (or 50 mV), qualitatively identical, and **independent of tick spacing** (the same circuit ticked only at its own wake times, every 1 ms or every 0.1 ms gives the same answer to 1e-4 — the network solve's own nanoamp tolerance already moves a 10 kΩ node by 1e-5 V). |
| **C** | Qualitatively right on most cases; 10–50 % errors, or an answer that depends on tick spacing.                                                                                                                                                                                                        |
| **D** | Qualitatively wrong on a common circuit of the area.                                                                                                                                                                                                                                                 |
| **F** | Not modelled, or a defect that stops the circuit working.                                                                                                                                                                                                                                            |

**Qualitatively identical** means the same logic reading on every input, oscillates/doesn't,
saturated/active/off, lit/dark/overdriven/burnt, and the same warnings.

There are two references, because there are two questions:

- **Same-model reference.** ngspice running Spice Lite's OWN piecewise-linear models (as
  behavioural sources). It grades the ENGINE: is the solve right, given the models?
- **Device reference.** ngspice running standard device models: the published vendor
  `.model` cards (2N3904, 2N2222, 1N4148, …), or a model fitted to the same datasheet points
  Spice Lite cites where no card exists (the Kingbright LEDs, the B-series CMOS output, a
  2N7000 / IRLZ44N level-1 fit). It grades the MODELS. Under Jason's "one common figure set
  per family/device type", a device area is graded against the REPRESENTATIVE part the
  common set is drawn from. The spread across other parts is reported, not graded.

---

## Where Spice Lite stands (measured 2026-10-08, `main` at `4023dda`)

Every number below was produced this session by building the circuit with the test
fixtures (`tests/timing-fixtures.js` `bench()`/`runner()`, engine `spice`) and the same
circuit in ngspice 42. Phase 0 turned those scripts into committed tests
(`spice-golden.test.js`), which now grade every row they cover mechanically; where that
differs from the first hand grade, the row says so.

### Scorecard

| Area                                                  | Evidence (Spice Lite vs reference)                                                                                                                                                                                             | Now               | Target | Phase |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | ------ | ----- |
| Engine numerics, single-storage clusters              | Same-model: 555 periods, Schmitt period, CMOS→1 µF ramp all within **0.01 %**                                                                                                                                                  | **A**             | A      | —     |
| Resistive DC (dividers, pots, chains)                 | Exact linear solve                                                                                                                                                                                                             | **A**             | A      | —     |
| Single-capacitor RC, Schmitt relaxation oscillators   | 81.558 vs 81.560 ms; 84.482 vs 84.480 ms                                                                                                                                                                                       | **A**             | A      | —     |
| Multi-capacitor RC networks (ladders, filters)        | Ladder output **−31 % at 80 ms** ticked at wakes only, −0.9 % at 1 ms ticks: **tick-dependent**. High-pass output **0 V** (ref. peaks 1.33 V). After Phase 2: both within 0.01 %, at every spacing                             | ~~D~~ **A**       | A      | 2     |
| Capacitor-coupled gate oscillators (two-gate astable) | **Never starts** (ref.: 1.64·RC; 2.17·RC with Rs). After Phase 1a: runs, −2.5 % / −2.0 % (Rs), behind Rs tick-dependent. After Phase 2: −0.4 % / −0.1 %, steady                                                                | ~~F~~ ~~C~~ **A** | A      | 1, 2  |
| NE555 timing                                          | Within 0.2 % up to ~20 kΩ; **+54 % at RA = RB = 1 MΩ** (3.207 s vs 2.080 s) — past the rubric's 50 %, so D (first graded C by hand). After Phase 1b: +0.09 %, every case within 0.4 %                                          | ~~D~~ **A**       | A      | 1     |
| LEDs                                                  | 330 Ω: 0 %; 1 kΩ: −2.2 %; 100 Ω: −0.9 %; 10 kΩ: **−8.5 %**. After Phase 4: every colour within 0.25 % at 100 Ω–10 kΩ                                                                                                           | ~~B+~~ **A**      | A      | 4     |
| Silicon diodes                                        | Diode + LED + 330 Ω: +4.0 %; drop 0.62 V vs 1N4148's ~0.73 V at 7 mA. After Phase 4: +0.17 %                                                                                                                                   | ~~B~~ **A**       | A−     | 4     |
| CMOS output stage dynamics                            | CMOS output → 1 µF vs level-1 MOSFET fit: +5 % at 0.8 ms, +6 % at 1.0 ms                                                                                                                                                       | **B+**            | B+     | (4)   |
| 74LS input / output stages                            | Unmeasured; the input stage is a straight line where the part is near-constant-current (reasoned, below). After Phase 4: input two segments as drawn; output B against SDLS025 (VOH +4 % at −0.4 mA, VOL and IOS on the sheet) | ~~(B−)~~ **B**    | B      | 0, 4  |
| BJT as a saturated switch                             | VCE(sat) 0.20 V vs 0.04–0.08 V. After Phase 4: every grade within 1.3 % of its card or fit                                                                                                                                     | ~~B−~~ **A**      | B      | 4     |
| BJT in its active region                              | Rb = 1 MΩ: Ic **−22 % / −33 %** vs 2N3904 / 2N2222; Rb = 100 kΩ: active (0.65 V) where both parts saturate (0.11–0.17 V) — qualitatively wrong, so D (first graded C). After Phase 4: every grade within 0.5 %                 | ~~D~~ **A**       | B      | 4     |
| MOSFET fully on                                       | Vgs = 5 V, 100 Ω load: 49.5 mV vs 79 mV (2N7000 fit); vs 1.3 mV (IRLZ44N fit). Vgs = 4 V: −52 %, so C (first graded B). After Phase 4: every grade within 0.1 %                                                                | ~~C / D~~ **A**   | B      | 4     |
| MOSFET near threshold                                 | Vgs = 2.5 V: **0.19 V vs 1.96 V** (no saturation region: Spice Lite's MOSFET is a variable resistor). After Phase 4: every grade within 0.1 %                                                                                  | ~~F~~ **A**       | B      | 4     |
| Inductors                                             | A wire. After Phase 3: RL step, relay coil with and without its flyback diode, series RLC ringing — every value within 0.06 %                                                                                                  | ~~F~~ **A**       | B      | 3     |

**Overall today: C.** The solver is excellent. Dynamics with more than one storage element,
inductors and transistors in anything but hard switching are not yet modelled well.

### Defects found

**D1 — The two-gate RC oscillator never starts.** CD4069UB 1Y → 2A, R (100 kΩ) from 1Y to
X, C (1 µF) from 2Y to X, X → 1A (with or without Rs). It fails the same way built from
CD40106B, 74LS04 or 74LS14 gates.

- **Symptom.** X and 2Y flip between 0 V and 5 V together every 250 ns (two gate delays).
  After `MAX_ANALOG_EVENTS` (32) the tick reports `oscillation`. Every following tick
  repeats it, at 30–120 ms of CPU a tick, asking to wake every 0.5 ms (`ANALOG_FRAME_S`).
  In the app that is a transport that cannot keep up, not just a stuck circuit.
- **Root cause (instrumented).** Inverter 2's input is a LISTENER on 1Y's net (that net is
  a resistor away from node X). Its affine statement (`volt.affine` in
  `engine.js#restate`) reads `{c0: 0, terms: {}}` when X = 0 V, i.e. 1Y at 0 V, although 1Y
  is then driving HIGH. So the listener for pin 3 always reads what pin 1 reads, the second
  inverter copies X instead of inverting it, the capacitor pair carries 2Y back onto X, and
  the loop flips every two quanta. The output stage driving a watched net is missing (or
  stale) in the statement of that net.
- **Not the pair path alone.** With the pair path disabled (`pairsOf` empty), the CD4069UB
  version chatters at its 2.5 V threshold instead, because a far side that moves SMOOTHLY
  carries nothing across a capacitor. That is the D3 limitation.

**D2 — The NE555's comparator currents are drawn for the whole cycle.** `ne555Silicon`
draws THRES 30 nA and TRIG 0.5 µA into their pins at every voltage. SLFS022 quotes TRIG
current only "TRIG at 0 V" and gives no direction, and its note (1), the
RA + RB ≈ 3.4 MΩ limit, belongs to THRES current alone. On the bipolar die these are
comparator input bias currents. They flow while that comparator's input side conducts,
i.e. near and past its trip point, not across the whole swing. Constant, they aim the
capacitor 1.06 V short of VCC at RA + RB = 2 MΩ. HIGH stretches 90 %, the period 54 %. A
real NE555 at those values should run near the formula (electrolytic leakage aside). That
expectation is unverified until Phase 1b measures it against a transistor-level 555.

**D3 — Coupled storage is an approximation, and its answer depends on tick spacing.** Each
capacitor node runs along its own curve, linearized with every OTHER node frozen where it
stood (`linearize` → `curveFrom`). It is re-linearized only at settles, corners and display
frames. So a network with two coupled storage elements is integrated explicitly, at
whatever step the ticks happen to take.

| RC ladder (10 k/1 µF/10 k/1 µF from a CMOS output), output node | 10 ms   | 20 ms   | 50 ms   | 80 ms   |
| --------------------------------------------------------------- | ------- | ------- | ------- | ------- |
| Ticked at its own wake times only                               | 0.000 V | 1.331 V | 2.349 V | 3.257 V |
| Ticked every 1 ms                                               | 0.949   | 2.123   | 4.006   | 4.657   |
| Ticked every 0.1 ms                                             | 1.027   | 2.216   | 4.080   | 4.696   |
| ngspice (same models)                                           | 1.036   | 2.227   | 4.088   | 4.700   |

The same cause makes a capacitor whose far side moves smoothly carry nothing ("A far side
moving SMOOTHLY carries only its steps (stated)"). A CMOS output through 10 kΩ onto 1 µF,
then 1 µF in series to 10 kΩ to GND (a high-pass), leaves the output node at **0.000 V**
throughout. ngspice shows a pulse peaking at 1.33 V near 10 ms.

### Other measurements behind the scorecard

| Device reference, DC                                           | Spice Lite                       | Reference                                                                             |
| -------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| Red LED from 5 V through 10 k / 1 k / 330 / 100 Ω              | 0.320 / 3.168 / 9.412 / 29.09 mA | 0.349 / 3.240 / 9.416 / 29.35 mA (exponential fit to the WP7113ID points)             |
| NPN, 5 V via Rb, 1 kΩ collector: Vc at Rb = 1 M / 100 k / 10 k | 4.565 / 0.650 / 0.205 V          | 2N3904: 4.441 / 0.171 / 0.084; 2N2222: 4.354 / 0.112 / 0.036                          |
| NMOS, gate at Vg, 100 Ω to 5 V: Vd at Vg = 2.5 / 3 / 4 / 5 V   | 0.192 / 0.098 / 0.050 / 0.050    | 2N7000 fit: 1.960 / 0.187 / 0.103 / 0.079; IRLZ44N fit: 0.004 / 0.003 / 0.002 / 0.001 |
| + → silicon diode → red LED → 330 Ω                            | 7.60 mA                          | 7.31 mA (1N4148 card)                                                                 |

### Missing components

Under Spice Lite every catalog part has an electrical model **except the inductor**
(`internalBridges [[1,2]]`: a wire in both engines; `sag.js` notes it). Missing as
_behaviours_ of parts that do have a model:

- a MOSFET's **body diode** (an inductive load freewheels through it);
- **avalanche/breakdown** on BJTs and MOSFETs (where an unclamped inductive kick goes);
- the **rail diodes on CMOS outputs** (the same).

All three only matter once inductors exist, so they ride Phase 3/4. Parts NOT in the
catalog that inductors would make possible (relay, buzzer, small DC motor, crystal,
op-amp/comparator, linear regulator) are out of this plan's scope (question 11).

---

## Phase 0 — Golden references and the scorecard test

Everything else is graded by this, so it lands first.

- **`scripts/spice-deck.mjs`** (test-only, plain Node): turns a `bench()`-built document
  into an ngspice deck, in either flavour. Passives, LEDs, diodes, transistors, PSUs and
  signal flags map one to one. Chips map to a small library of behavioural subcircuits
  (inverter, Schmitt inverter, NE555 with the silicon block's internals), stating the stage
  and threshold the family table states. Generated rather than hand-written because writing
  each circuit twice, in JS and in SPICE, cost this session four deck bugs.
- **`src/web/scripts/tests/spice-golden/`**: one JSON per area. Each entry is the circuit
  (by fixture name), what is read (node volts at times, a branch current, a period, edge
  times) and the reference values. **Committed**, so `make test` needs no ngspice.
- **`make spice-golden`** regenerates the references with ngspice (skips with a message
  when it is absent), outside `make test`, like `make datasheet-urls`. Pins the ngspice
  version in the JSON.
- **`tests/spice-golden.test.js`** holds each area to the tolerance of its TARGET grade and
  prints the scorecard. An area below target is a `todo` until its phase lands, then a
  failure. Every case also runs the **tick-spacing invariance** check.
- The cases: everything in "Where Spice Lite stands" (all of D1–D3 included), plus per-area
  additions as each phase lands. That includes an RLC tank, a relay driver with and
  without a flyback diode, a two-gate CD4069UB astable, a 74LS input on 1 k / 2.2 k / 4.7 k
  / 10 k pull-downs, a 74LS output into 0.4–16 mA loads, and the CD4000 RC timers against
  their sheets' formulas.
- The **NE555 device reference**: LTspice's transistor-level NE555 (the educational
  example), converted for ngspice once and kept as a fixture. Licence checked before it is
  committed. If it can't be committed, it stays a local check, with its numbers recorded
  in the JSON.

**Size:** M. **Gate:** the scorecard reproduces this document's numbers.

**Landed (2026-10-08).** `scripts/spice-deck.mjs` reads the circuit through the engine's
own readers (the netlist, `lampTopology`'s resistors and junctions, `capacitorNets`, each
part's pins), so a deck cannot wire anything the engine does not. Three flavours: `same`,
`device`, and `ideal` (the same models less the comparators' input bias currents — what
the 555's formula assumes, and the NE555 area's reference until Phase 1b brings the
transistor-level check, which stays local while its licence is unread). Behavioural blocks
cover the gate units (INV … XNOR, Schmitt inputs) and the NE555's silicon; a part with no
block throws rather than half-simulating. `spice-golden-cases.js` holds 28 cases in 12
areas, each with a FLOOR (its grade now — the test fails below it, a ratchet) and a
TARGET (a `todo` until its phase is in `LANDED`, a failure after); the whole scorecard
runs in ~13 s. Three decisions on the way:

- **The tick-spacing bar is 1e-4, not 1e-6.** The network solve stops within a nanoamp,
  which through 10 kΩ is 1e-5 V, and where its Newton steps start moves with the spacing:
  the single-RC ramp differed by 7e-6 between spacings for that reason alone. 1e-4 still
  separates the real thing (the ladder moves by 1e-1).
- **No 74LS two-gate golden case.** ngspice's step control collapses on the deck — one-way
  stages switching into a 1 kΩ / 100 µF loop — with a smooth comparator or a hard one.
  `spice-engine.test.js` still holds the 74LS04/74LS14 versions to running.
- **The 74LS stage, RLC, relay and CD4000-timer cases** come with the phases that need
  them (3 and 4); the generator gains a block per part as they do.

## Phase 1 — The two defects

### 1a. D1, the two-gate oscillator

- Fix the watched-net statement. A net in a node's network that an output stage drives is
  stated with that stage's CURRENT drive (and its saturation piece), read from the same pass
  the settle used. The instrumented repro above becomes the regression test (four gate
  types × Rs present / absent).
- **Back off when capped.** A node marked `oscillating` must not keep asking for
  `ANALOG_FRAME_S` frames at full cost. Hold the last state and wake on the next input or
  clock event. A stuck circuit must cost what a quiet one does.
- **Acceptance.** It oscillates in all eight variants. The CD4069UB period is within 10 % of
  the same-model reference (1.67·RC / 2.20·RC with Rs = 2.2 R) once Phase 2 lands. Before
  Phase 2, within whatever the D3 approximation allows, recorded rather than asserted.
- **Landed (2026-10-08).** Two causes, not one. (1) An input's listener on a net an output
  drives kept the reading of the last crossing: `engine.js` now re-reads it from the
  solved voltage at the settle (`rereadListener`), unless the curve the crossing search
  states still agrees with it to `DRIVER_EPS`. (2) A CMOS stage was one-way, so a LOW
  let the capacitor's far plate fall 2.5 V below ground: CD4000 and family-less MOS
  stages are now `channel` stages that conduct both ways up to their limit (the 555's,
  the 4511's bipolar side and the 4047's RC pull-up stay one-way). A capped tick backs
  off (`chatter`: doubling from `MIN_SHOWN_S` to `MAX_CAPPED_BACKOFF_S`, remembered for
  `CHATTER_MEMORY_S`), ~5 ms a tick where it was 30–120. All eight variants run; the CD4069UB's
  periods are within 5 % (measured ~2 %) of ngspice's same-model 0.1672 s (1.67·RC) and,
  behind Rs, 0.2203 s (2.20·RC).
  Left for Phase 2: the CD4069UB-behind-Rs variant still caps its very first crossing
  once (the `todo` in `spice-engine.test.js`; input capacitance fixes it).

### 1b. D2, the 555's pin currents

- Gate each comparator's input current by its comparator's state: TRIG's flows only while
  TRIG is below the lower tap, THRES's only around and past the upper. Take each current's
  DIRECTION from the transistor-level reference (Phase 0). The die suggests TRIG (a PNP
  input) flows OUT of the pin. Don't assume it; measure it.
- **Acceptance.** RA = RB = 1 MΩ, C = 1 µF within 3 % of the transistor-level reference.
  Every existing 10 kΩ test unchanged within 0.5 %. The bias-current tests rewritten to the
  gated model.

- **Landed (2026-10-08).** Each bias current is a stage that ramps on across its trip
  point (`thresInput`/`trigInput` in `sim/timer-555.js`): THRES's into the pin (an NPN
  Darlington), none below ⅔ VCC − 0.1 V, half at it, all 30 nA past it; TRIG's OUT of
  the pin (the trigger comparator senses down to 0 V, so its inputs are PNPs), all
  0.5 µA below ⅓ VCC − 0.05 V, none above it + 0.05 V. SLFS022K's revision K draws only
  a simplified schematic, so the directions are the die's physics, not a measurement:
  the transistor-level check stays open (local, licence unread). Against the formula
  (the `ideal` reference): RA = RB = 1 MΩ +0.09 % (was +54 %); 10 kΩ/10 kΩ moved −0.22 %
  and 10 kΩ/1 kΩ −0.23 %, both now closer to it. **Kept simple on purpose:** the ramps
  sit at the divider's own taps, so a voltage forced onto CONT moves the trip points
  but not where the currents turn on — a 0.5 µA difference at most. A stage stated
  against another net's voltage is what Phase 2's cluster elements make natural.

**Size:** S each. **Gates:** `make test`, parity, bench.

## Phase 2 — Exact cluster dynamics

The core. It replaces the per-node curves (`curveFrom`/`linearize` for nodes), capacitor
pairs (`pairsOf`/`runPair`/`pairStand`/`pairCurves`) and coupling steps (`couplingSteps`)
with one exact solution per **dynamic cluster** per linear piece.

- **Dynamic cluster.** Union-find over the voltage clusters `voltageTopology` already forms,
  joined by every capacitor (and, Phase 3, inductor) that does not sit on a rail. A rail is
  never a union point (a capacitor to a rail is a capacitor to a fixed voltage). A capacitor
  straight across two fixed nets is no state (it only books supply current, as decoupling
  does now).
- **State.** One voltage per capacitor in a spanning forest of the capacitor graph, plus one
  current per inductor. A capacitor loop (or inductor cut-set) is degenerate. Its redundant
  member is dropped from the state and its current derived. No invented series resistance.
- **The linear piece.** Every element is fixed on its current piece, exactly the `pieces`
  signature `network.js` already computes: stages Norton, junctions on their segment,
  devices as their numeric Jacobian stamp. Then `x' = A·x + b`. Build `A` the
  circuit-theory way: n + 1 solves of the RESISTIVE network with capacitors as voltage
  sources and inductors as current sources (one per unit state, one for the sources). Each
  solve gives a column of capacitor currents / inductor voltages, and the node voltages as
  an AFFINE function of `x`. Those are exactly what listeners and corners need, with no
  "nudged toward its heading" approximation.
- **The solution.** `x(t0 + h) = Φ(h)·x0 + Γ(h)` from the exponential of the augmented
  matrix `[[A, b], [0, 0]]` (scaling-and-squaring Padé 13, Higham 2005: pure, small, n ≤ a
  dozen in practice). The augmented form covers a singular `A` (a ramp: a capacitor charged
  by a saturated output) with no special case. It is **exact** within the piece, so the
  answer no longer depends on when the ticks fall.
- **Events.** A listener's crossing and an element's corner are both `g(t) = c + dᵀ·x(t)`
  reaching a level. Locate the first one by stepping `Φ(h)` with a step bounded by the
  piece's eigenvalues (fast real modes: grow `h` geometrically once they have decayed;
  oscillatory modes: `h ≤ π / (2·|Im λ|max)`), then refine with Illinois / Newton
  (`g' = dᵀ(A·x + b)`). Eigenvalues come from a small Hessenberg QR, cached per piece
  signature, as are the `Φ(h)` for the steps used.
- **Input capacitance.** A chip input inside a dynamic cluster carries its sheet's CIN
  (B-series 5 pF typ; 74LS's from its sheet) as a capacitor to its ground. Phase 1a
  found why it is needed: as a two-gate oscillator's first gate falls, the junction dips
  20 mV through the second gate's 400 Ω, and an input behind Rs read that dip as a
  crossing back (its first crossing is capped once; the `todo` in
  `spice-engine.test.js`). On a bench, and in ngspice with 10 pF there, an input behind
  220 kΩ never sees a dip that brief. Exact pieces make the extra states cheap.
- **What stays.** The digital settle loop, gate-delay quanta, listeners' contract
  (`comp#pin` keys, window senses), catch-up, the cycle detector (its signature gains `x`),
  the silicon blocks (their stages and senses are just elements), reports and currents,
  charge carried tick to tick (now as `x`).
- **What goes.** The scalar curve per node, pairs and coupling steps. A step on a driver now
  simply leaves `x` continuous while the algebraic nodes jump, which is coupling, for free.
  `rc-curve.js` survives only if the one-state fast path is kept (decided by `make bench`:
  the general path at n = 1 must agree to 1e-12 either way).
- **Acceptance.**
  - The ladder and high-pass cases within 1 % of the same-model reference, at every tick
    spacing.
  - D1's eight variants at their reference periods within 2 %.
  - Every existing spice test green, each changed expectation justified in the commit.
    Expect changes only where the old answer was the approximation.
  - Parity green; bench within the gate below.
- **Risks.**
  - Event location over sums of exponentials must never MISS a crossing. The step bound is
    the guard, and the golden suite adds adversarial cases (a crossing that grazes a
    threshold; two modes with nearly equal rates).
  - n + 1 network solves per piece: a desk with many independent single-capacitor clusters
    must not get slower. Measure on the busy fixture, and add a capacitor-heavy one.

**Size:** L — the biggest item in this plan.

**Landed (2026-10-08).** `spice/dynamics.js` and `engine.js` `runGroup`, as designed, with
these differences:

- **Node voltages, not capacitor voltages, are the variables**, and C's own eigenvectors
  split them: the range is the charges, the null space a lone capacitor's common voltage
  (algebraic). It needs no spanning forest and handles a capacitor loop, a floating pair
  and a node with no capacitor to a rail alike. Symmetric Y gives real modes in CLOSED
  FORM (`modal`: a·e^(kt) + r·t·φ(kt), φ = expm1(x)/x so a ramp needs no special case);
  only an unsymmetric device stamp falls back to e^A (Padé 13). Eigenvalues come from
  Jacobi on the symmetrized matrix, not a Hessenberg QR.
- **One free node keeps the old single curve** (`curveFrom`): the rest of its group is
  held, so it is exact, and every single-capacitor answer is unchanged to the bit.
- **The common mode is balanced on the true networks** (`balance`: bracketed, then
  Illinois on `volt.currentsAt`) before the piece is linearized. Balanced on a linear
  piece, a pair's plates jumped past a clamp, back past a saturating stage, and never
  agreed.
- **Corners are found in time, from the pieces** (`piecesAt` carries every net along the
  solve's affine map), not as per-element boundary functionals: one mechanism for stages,
  junctions and devices alike.
- **Unseen nodes start together** (`chargedNets`): one at a time, a plate started where
  its partner's network held it with the capacitor open — the high-pass began at 5 V.
- **No input capacitance.** The Rs variant's first-crossing chatter was not the 20 mV dip
  (Phase 1a's guess): `rereadListener` read a listener from the LAST settle's voltages at
  the first pass of a settle and undid the crossing it was called for. It now waits for
  the settle's first solve (`solvedYet`), and the todo test is a test. CIN stays unbuilt:
  nothing here needs it, and every chip input in a network would become a node.
- **The deck's ideal comparator is hard, with ±2 mV of hysteresis** (`EDGE_V`): a smooth
  one (tanh) is an amplifier, and an RC round it biased it into its linear region for 2 ms
  an edge; 0.5 mV was inside the algebraic dip a pair's plate takes at its own crossing.
- **Gates.** Ladder and high-pass within 0.01 % at every tick spacing; the CD4069UB pair
  −0.37 % (−0.11 % behind Rs), the CD40106B pair 0.01 %, all steady to 1e-6. `make
bench` 4.1 ms/tick under Spice Lite (baseline 5.06); a coupled oscillator 3–5 ms/tick.

## Spice-only properties (Phases 3 and 4)

Jason's answer to questions 3 and 5 (2026-10-08): the figures a part simulates with are
chosen on its Properties card, from a short list, and **only while Spice Lite is enabled**.
The digital engine has no use for them, so it never shows them.

- **One mechanism, both fields.** A catalog field may carry `spiceOnly: true`.
  `DeskController#propertyFieldsFor` drops such a field unless `settings.spiceLite.enabled`
  is true. The dialog stays a pure renderer over the list it is handed.
- **Stored only when it differs from its default** (the omit-when-default convention), so
  every existing document round-trips byte-identical. No schema bump.
- **Kept while hidden.** Switching Spice Lite off hides the field but leaves the stored
  value, which is used again when Spice Lite comes back on.
- **Ignored elsewhere.** The digital engine, the BOM, the build guide and the exports
  ignore it. It chooses figures; it is not printed on the part.
- **Live while running.** An edit applies live (no pin moves, so nothing is greyed out),
  as one undo step, like a pot's Position.

### Transistor grade (question 3)

A second selector on every transistor's card: **Grade**. ("Type" is taken: it is the
NPN/PNP/N-MOSFET/P-MOSFET part swap.) Jason allowed more grades than the two he named,
where a category simulates differently, as long as every grade keeps a default
(2026-10-08).

- **Each grade is one representative part's whole figure set**: its base or gate, its
  collector or channel, its ratings. Phase 4 reads them off that part's sheet and cites it.

  | Type     | Grades (representative part)                                                                             |
  | -------- | -------------------------------------------------------------------------------------------------------- |
  | NPN      | **Small signal** (2N3904) · **General purpose** (2N2222A) · **Darlington** (TIP120) · **Power** (TIP31C) |
  | PNP      | **Small signal** (2N3906) · **General purpose** (2N2907A) · **Darlington** (TIP125) · **Power** (TIP32C) |
  | N-MOSFET | **Logic level** (2N7000) · **Logic-level power** (IRLZ44N) · **Power** (IRF540N)                         |
  | P-MOSFET | **Logic level** (BS250) · **Power** (IRF9540N)                                                           |

  Why these, and not fewer:
  - A Darlington is not a strong BJT. Its β is in the thousands, it needs ~1.4 V on its
    base and it never saturates below ~1 V, so a single BJT figure set gets it wrong on
    all three counts. It is also the commonest breadboard load driver.
  - A logic-level power MOSFET (on fully from a 5 V output) and a standard power one
    (rated at a 10 V gate, barely on at 5 V) are the difference between a circuit that
    works and one that doesn't.
  - The P-channel row has no logic-level power grade. No common part fills it, and an
    invented figure set would be worse than none.

- **The default follows the package**, as Jason set it: TO-92 → the first grade (Small
  signal / Logic level), TO-220 → Power. A grade the user never set is re-derived when the
  package changes; one set to a non-default value is stored (`params.grade`) and kept.
- **BJTs gain the TO-220 package** (`cases: ["TO-92", "TO-220"]`; the MOSFETs' TO-220
  drawing, box and footprint are reused), so a TIP120 or TIP31C can be drawn as itself.
  The default package stays TO-92.
- **A listed part number brings its grade.** Picking TIP120 from the list sets
  Darlington, as a Zener pick brings its voltage; a TYPED part number leaves the grade
  alone. The part lists (`TRANSISTOR_PARTS`) gain each representative not already on them
  (TIP120, TIP31C, TIP125, TIP32C, IRLZ44N).

### Inductor winding (question 5)

A second selector on the inductor's card, **Winding**, with four options. There are three
SETS of options for each style, one per size, so six bodies in all: the drum
(`style: "can"`, the inductor) and the toroid (`style: "coil"`, the choke), each over 1, 2
or 3 holes. (The 1-hole size landed on 2026-10-08, beside the 2- and 3-hole ones; the
default stays 2.)

- **What an option is.** A winding grade (lowest resistance, typical, higher, highest).
  Its DC resistance SCALES with the inductance, R = k·L, with k per body and grade. That way
  the resistance stays right when the Inductance is edited; fixed ohms would go stale.
- **Where k comes from.** Phase 3 fits each body's k from one maker's series for that body
  and size (a radial-drum series per can size, a toroid series per coil size), cited at the
  definition.
- **What the user sees.** Each option's label states the resulting ohms for the part's
  current value (e.g. "Typical — 1.2 Ω"). The default is Typical. Stored as
  `params.winding` only when it is not.
- **Blank Inductance.** The part is a wire, and the field is hidden even under Spice Lite.

## Phase 3 — Inductors

Needs Phase 2. The inductor is the capacitor's dual: its state is a current, continuous
across every event.

- **The netlist.** Under Spice Lite the inductor must NOT join its two nets (the voltage
  across it is the point). The digital engine keeps it a wire, so digital results and every
  export stay byte-identical. Spice Lite asks `NetlistCache` for a variant with inductors as
  branches (`{inductors: "branch"}`), SimController picks it at Run. No shipped example has
  an inductor, so parity is untouched (asserted).
- **The model.** L in henries (the existing optional Inductance), in series with the DC
  resistance its Winding gives ("Spice-only properties"). Blank Inductance: still a wire,
  in both engines, and the guide says so.
- **The Winding field** (`spiceOnly`): its four grades for each of the six bodies, their
  fitted k, and `properties.*` keys in all seven locales.
- **Where the current goes when its path opens.** Through whatever conducts: a flyback
  diode, a MOSFET's body diode, a CMOS output's rail diodes. Failing all of those, the
  opening device's BREAKDOWN (BJT VCEO, MOSFET V(BR)DSS, common figures per class).
  - These are new branches: body diode on every MOSFET; output rail diodes on CD4000 and
    `MOS_STAGE` outputs; a breakdown clamp on every transistor. Each is inert until reached.
  - Reaching breakdown is an `inductive-kick` WARNING naming the part, the peak voltage and
    the energy dumped. It stays a warning, like `transistor-overload`, since a passive part
    has no status to latch.
- **What the user sees.** The probe reads the inductor's current and the voltage on each
  side. The analyzer draws the flyback spike (capped like every fast thing, its peak kept
  in the readout).
- **Acceptance (same-model references).** RL step: τ = L/R within 1 %. Relay driver
  (2N3904, 100 mH / 100 Ω coil) with a 1N4148 flyback: current decay within 2 %. The same
  without the diode: the warning, peak at the clamp. Series RLC: ringing frequency within
  1 %, decay within 2 %.
- **Not modelled (stated in the guide).** Core saturation, core loss, mutual inductance,
  self-resonance.

**Size:** M.

**Landed (2026-10-08).** `spice/inductors.js` (the desk's inductors as branches),
`network.js`'s `"l"` branch (a current source of the coil's current), `engine.js`'s coils
beside its nodes in `runGroup`, and the Winding field. The `inductors` golden area is A
(every value within 0.06 % of ngspice), past its B target. Differences from the design:

- **A winding's resistance is a power of its inductance, not R = k·L.** A maker's series
  does not hold R/L constant (the bigger values are wound with finer wire), so a fixed
  ohms-per-henry was wrong by a factor of several across one series. Each body's fit is
  R = R(1 mH)·(L / 1 mH)^p to its TYPICAL winding — the can over 1 hole to Bourns
  RLB0914, over 2 and 3 to RLB1314; the coil over 3 holes to Bourns' 2100 toroids, over 2
  and 1 scaled by size — and the four grades are factors on it (0.6, 1, 1.6, 2.5) spanning
  each series' spread. Cited at `INDUCTOR_WINDING_FITS`.
- **An inductor makes the group's system UNSYMMETRIC** (its KCL and KVL stamps are each
  other's negatives), so the unsymmetric path is no longer e^A alone: `complexModal`
  finds the eigenvalues (Hessenberg QR), each mode's vector and the modes' inverse in
  complex arithmetic, and states each node and coil current in closed form, ringing
  included. e^A (Padé 13) is kept for modes too close to tell apart (`MODAL_COND`, a
  Jordan block).
- **The output rail diodes are added only in a cluster with an inductor.** Anywhere else
  a CMOS output's clamp never conducts (the output already sits between its rails), and
  adding two branches to every output on every desk would cost every solve something for
  nothing.
- **The Winding row is greyed, not hidden, while the Inductance is blank.** The card
  never removes a row while open (the rows under it would move under the pointer); the
  plan's "hidden" stands for Spice Lite off.
- **The probe reads at the POINT** (`SimOverlay.levelAt`/`voltsAt`): the app's shared
  conducting netlist joins an inductor's leads as a wire, so a net id from it named only
  one side.
- **A circuit carrying a coil's current is never drawn as a fast cycle**: the cycle
  signature does not carry coil currents, so the engine records no moment for `cycles.js`
  while any coil is part of the analog side, rather than recognise a repeat it cannot see.
  An oscillation through an inductor runs crossing by crossing, under the event cap.
- **The analyzer draws the spike the ticks capture**: the kick's peak is at the moment
  the coil is switched off, which is a tick of its own; the `inductive-kick` warning
  states it.

## Phase 4 — Device curves to B

### Shape

Replace the remaining hand-placed straight lines with **smooth device curves plus
validity-bounded linearization**. Newton already reads device slopes numerically, so a
Shockley diode or a square-law MOSFET is no harder for the DC solve, given SPICE-style
junction limiting in the step. For Phase 2's exact pieces, a smooth device is linearized at
the piece's start, and its CORNER is where its linearization's error reaches a tolerance
(current off by 1 %). One mechanism then serves the diode, the LED's toe, the BJT's VBE
and the MOSFET's triode/saturation boundary. Finer piecewise-linear tables are the
fallback if convergence proves fragile (question 4).

### Parts

- **Diode.** Shockley + series resistance, fitted to the common figures. Today's
  0.6 V + 2 Ω line reads 0.60 V at 1 mA and 0.62 V at 10 mA; the 1N4148 card reads 0.61 V
  and 0.72 V. **Target A−** vs the 1N4148 card from 0.1–50 mA.
- **LED.** The same, fitted to each colour's Kingbright points (the 10 kΩ case's −8.5 %
  goes). Dark/lit threshold unchanged. **Target A.**
- **The Grade field** (`spiceOnly`; "Spice-only properties"): its grades per type, its
  default from the package, the part lists' new representatives, the BJT's TO-220
  package, and `properties.*` keys in all seven locales.
- **BJT.**
  - VBE from the junction curve.
  - β, VBE and VCE(sat) per grade (a Darlington's two junctions included); today's β of
    100 is the 2N3904's MINIMUM.
  - VCE(sat) from the sheet's Ic/Ib = 10 points instead of 0.2 V + 1 Ω.
  - VCEO breakdown (Phase 3's clamp).
  - **Target B** vs each grade's representative: the 2N3904 and 2N2222 vendor cards
    across the Rb sweep (Ic in the active region, Vc in saturation within 50 mV), and the
    Darlington and Power grades against their sheets' points.
- **MOSFET.**
  - A saturation region: square law, K fitted so RDS(on) at the grade's rated gate drive is
    the package's.
  - The body diode.
  - V(BR)DSS.
  - Figures per grade, from the table in "Spice-only properties". No per-part figures.
  - **Target B** vs each grade's representative across Vgs 2–5 V (2–10 V for Power).
- **74LS input.**
  - Two segments, as the input's structure suggests (a resistor from VCC behind the input
    diode): near-constant IIL (~0.25 mA) up to ~0.9 V, then to zero by ~1.3 V. These
    figures are this plan's reading of the schematic, to be confirmed against Phase 0's
    transistor-level gate and SDLS025's tabulated IIL before they are used.
  - Today's single line understates a 4.7 kΩ / 10 kΩ pull-down's voltage. It reads LOW
    where the bench reads marginal.
  - **Target B** against the sheet's tabulated points and a transistor-level LS gate built
    from its schematic (Phase 0).
- **74LS output.** Light-load VOH (the Darlington's two VBE are not 1.4 V at microamps):
  one more segment. **Target B** against VOH at −0.4 mA, VOL at 4/8 mA and the IOS range.
- **CMOS output.** Square-law shaped from the existing saturation-current/on-resistance
  pairs. Optional: it is already B+.

**Size:** M (the shared curve mechanism) + S per part.

**Progress (2026-10-08).**

- **Junctions landed** (`spice/junction-table.js`). Question 4 is answered by the
  fallback: a junction is its exponential as a piecewise-LINEAR TABLE (samples a factor
  of 2 apart in current, 1 µA–4 A), not a smooth curve with error-bounded corners. It
  keeps every piece exact and Newton unchanged, and each sample is simply a corner; the
  line strays from the curve by ≤ 0.06·n·Vt (a few millivolts). The diode is the 1N4148
  card's DC curve (Is, n, Rs and its IKF knee). Each LED colour is fitted by least squares
  to its own Kingbright figure (7–11 points read off it): red n 2.8, yellow and green
  n 1.5 (ngspice will not take the saturation current a straighter fit needs), blue and
  white n ≈ 3.9. LEDs and diodes grade A against the curves; the bench is unchanged
  (3.9 ms per Spice Lite tick).
- **Transistor grades landed** (`spice/transistors.js`, the catalog's Grade field). A BJT
  is the DC Gummel–Poon subset on junction tables (the vendor card's numbers for the
  2N3904, 2N2222A, 2N3906 and 2N2907A; a fit to the onsemi sheet's typical curves for the
  TIP31C/TIP32C), RB folded into the base–emitter table's voltage axis and RC solved
  inside the device; a Darlington is the TIP120/TIP125 sheet's two transistors and two
  resistors, the node between them solved inside. A MOSFET is level 1 (the 2N7000 and
  IRLZ44N fits; the IRF540N, IRF9540N and BS250 fitted to their sheets' transfer figures
  and on-resistance), re-linearized every 10 % of its overdrive — the one piece of the
  model that is not piecewise linear. BJTs gained the TO-220 package (stored only when
  chosen, so old documents read as they did). Every transistor area grades A — against
  the vendor cards where the grade has one, else against its own fit (the deck states
  the fit as a card, `gradeCard`), and the fits against their sheets' points in
  `spice-transistors.test.js` (within 10–20 %). Breakdown, body diode and limits are per
  grade; a package's power limit stays the package's.
- **74LS input landed as planned**: 200 µA out of the pin (half the sheet's IIL, what
  its 20 kΩ drives), flat to a 0.9 V knee, then down to nothing at 1.3 V — a limited
  stage (`TTL_INPUT`). A 4.7 kΩ pull-down now sits at 0.91 V (undefined) where the
  single line held it at a clean 0.66 V. The transistor-level LS gate of Phase 0 was not
  built (no 74LS deck ran), so the figures rest on SDLS025 and the schematic. **The 74LS
  output is left as it is**: against the sheet it is already B — VOH 3.55 V against 3.4 V
  typical at −0.4 mA, VOL 0.25/0.35 V at 4/8 mA on the sheet's typicals, IOS 30 mA inside
  its −20…−100 mA — and the plan's light-load segment would raise VOH, away from the
  sheet's 3.4 V. The CMOS output (optional) stays B as well.
- **Newton reads a device's slopes both ways**: a step built on slopes read upward that
  gains nothing is retried on slopes read downward. A transistor left a hair under its
  knee (a relay's base when its drive went LOW) read ON upward, and the solve never
  converged.

## Phase 5 — Scope boundaries, said out loud

Where a B is not feasible or not wanted, the guide's "What Spice Lite doesn't do" says so,
and the engine says something specific instead of something misleading:

- **A gate's linear region.** An unbuffered inverter biased by its own feedback resistor
  (a CD4069UB amplifier, a crystal oscillator) has no logic answer. Today it reads X, or
  chatters to `oscillation`. Instead it gets a specific `linear-bias` warning naming the
  gate. Decided out of scope (question 10). Modelling the UB parts as the MOSFET pairs they
  are (as the CD4007UB already is) becomes possible after Phase 4's MOSFET and stays a
  stretch item.
- **Below a gate delay.** Edge rates, parasitic capacitance and ringing on wires stay
  unmodelled. Pass quanta are the time resolution.
- **Per-part transistor accuracy.** Under one figure set per grade, a part far from its
  grade's representative is graded C or worse. Reported in the scorecard, not
  hidden.
- **Two unrelated fast oscillators** (stated today) stay as they are.

## Phase 6 — Docs, locales, rules, roadmap

- User guide `spice-lite.md`: the scorecard summary, inductors, the new warnings,
  "What Spice Lite doesn't do".
- Every new warning translated in all seven locales.
- `.claude/rules/spice-lite.md` rewritten where Phase 2 replaced the curves/pairs/coupling
  text.
- `ROADMAP.md`.
- This plan moves to `features/done/` with a "Results" section: the final scorecard.

---

## Order and gates

| Step | Phase                                  | Depends on            |
| ---- | -------------------------------------- | --------------------- |
| 1    | 0 — golden references + scorecard test | —                     |
| 2    | 1a, 1b — the two defects               | 0                     |
| 3    | 2 — exact cluster dynamics             | 0                     |
| 4    | 3 — inductors                          | 2                     |
| 5    | 4 — device curves                      | 0 (and 2 for corners) |
| 6    | 5, 6 — boundaries, docs                | all                   |

Gates after every step:

- `make test` green.
- The digital engine byte-identical.
- `tests/engine-parity.test.js` green, with only reasoned exemptions.
- The scorecard no worse in any area.
- **Performance.** `make bench` Spice Lite within **1.25×** of its baseline on the busy
  fixture, measured on the same machine before and after. On the cloud container that
  measured this plan, the baseline is 5.06 ms/tick incremental (13.7 ms "full"), with
  6.3 clusters solved per tick. A capacitor-heavy fixture joins the bench in Phase 2, with
  its own baseline taken before the change.

## Is a B feasible?

**Yes, for everything Spice Lite claims to model**, with three stated exceptions:

- per-part transistor accuracy under one figure set per grade (B for each grade's
  representative only);
- a gate's linear region (out of scope, question 10);
- anything faster than a gate delay.

The biggest single lever is Phase 2. It moves multi-capacitor networks from D to A, removes
the tick-spacing dependence, finishes D1, and is the foundation inductors need. After
Phases 0–4 the expected scorecard is A for the engine, resistive, RC (single and coupled)
and LED areas, and B for diodes, BJTs, MOSFETs, 74LS stages, the 555 and inductors.

## Open questions for Jason (defaults given)

1. **References.** ngspice 42 (pinned), published vendor `.model` cards, and fits to the
   cited datasheet points where no card exists. Outputs committed; `make spice-golden`
   regenerates outside `make test`. _Default: yes._
2. **The rubric's thresholds** (A 2 %, B 10 % + qualitative + tick-invariant). _Default:
   yes._
3. **Transistor figures.** _Decided (Jason, 2026-10-08):_ a **Grade** selector on every
   transistor's card, shown only under Spice Lite, defaulting by package (TO-92 → the
   first grade, TO-220 → Power). More grades are allowed where a category simulates
   differently. Designed in "Spice-only properties": four BJT grades, three N-MOSFET and
   two P-MOSFET, plus the TO-220 package for BJTs. Still to confirm: that grade list.
4. **Smooth curves with bounded linearization** rather than finer piecewise-linear tables.
   _Default: smooth, tables as the fallback._
5. **Inductor DC resistance.** _Decided (Jason, 2026-10-08):_ the same pattern as 3. A
   **Winding** selector, shown only under Spice Lite, with four options and three sets of
   them per style, one per size (1, 2 or 3 holes; the 1-hole size landed the same day).
   Designed in "Spice-only properties". Still to confirm: options that scale with the
   inductance rather than fixed ohms.
6. **Inductors as branches under Spice Lite only** (the digital engine and every export keep
   the wire). _Default: yes._
7. **Unclamped inductive kicks** go to the opening device's breakdown clamp with an
   `inductive-kick` warning, never smoke, and no invented parasitic node capacitance.
   _Default: yes._
8. **The 555's comparator currents** gated by comparator state, their direction taken from
   the transistor-level reference. _Default: yes._
9. **D1 in two steps.** The listener fix and the back-off land in Phase 1. Exact timing
   lands with Phase 2. _Default: yes._
10. **A gate's linear region.** _Decided (Jason, 2026-10-08): out of scope_, with a
    specific `linear-bias` warning. Modelling CD4069UB-style parts as MOSFET pairs stays a
    stretch item after Phase 4.
11. **New parts inductors enable** (relay, buzzer, motor). Not in this plan; a separate
    plan if wanted. _Default: separate._

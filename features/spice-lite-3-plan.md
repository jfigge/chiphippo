# Spice Lite 3 — fidelity plan

**Status (2026-10-08): proposed, not started.** Measured against `main` at `4023dda`
("Spice (#5)"). Nothing in this plan has been implemented.

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

| Grade | Means                                                                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | Every golden case within **2 %** of the reference (or 20 mV for a voltage under 1 V), and qualitatively identical.                                                                                                  |
| **B** | Every case within **10 %** (or 50 mV), qualitatively identical, and **independent of tick spacing** (the same circuit ticked only at its own wake times, every 1 ms or every 0.1 ms gives the same answer to 1e-6). |
| **C** | Qualitatively right on most cases; 10–50 % errors, or an answer that depends on tick spacing.                                                                                                                       |
| **D** | Qualitatively wrong on a common circuit of the area.                                                                                                                                                                |
| **F** | Not modelled, or a defect that stops the circuit working.                                                                                                                                                           |

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
circuit in ngspice 42. Phase 0 turns those scripts into committed tests.

### Scorecard

| Area                                                  | Evidence (Spice Lite vs reference)                                                                                                            | Now           | Target | Phase |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------ | ----- |
| Engine numerics, single-storage clusters              | Same-model: 555 periods, Schmitt period, CMOS→1 µF ramp all within **0.01 %**                                                                 | **A**         | A      | —     |
| Resistive DC (dividers, pots, chains)                 | Exact linear solve                                                                                                                            | **A**         | A      | —     |
| Single-capacitor RC, Schmitt relaxation oscillators   | 81.558 vs 81.560 ms; 84.482 vs 84.480 ms                                                                                                      | **A**         | A      | —     |
| Multi-capacitor RC networks (ladders, filters)        | Ladder output **−31 % at 80 ms** ticked at wakes only, −0.9 % at 1 ms ticks: **tick-dependent**. High-pass output **0 V** (ref. peaks 1.33 V) | **D**         | A      | 2     |
| Capacitor-coupled gate oscillators (two-gate astable) | **Never starts** (ref.: 1.67·RC; 2.20·RC with Rs)                                                                                             | **F**         | A      | 1, 2  |
| NE555 timing                                          | Within 0.2 % up to ~20 kΩ; **+54 % at RA = RB = 1 MΩ** (3.207 s vs 2.080 s)                                                                   | **C**         | A      | 1     |
| LEDs                                                  | 330 Ω: 0 %; 1 kΩ: −2.2 %; 100 Ω: −0.9 %; 10 kΩ: **−8.5 %**                                                                                    | **B+**        | A      | 4     |
| Silicon diodes                                        | Diode + LED + 330 Ω: +4.0 %; drop 0.62 V vs 1N4148's ~0.73 V at 7 mA                                                                          | **B**         | A−     | 4     |
| CMOS output stage dynamics                            | CMOS output → 1 µF vs level-1 MOSFET fit: +5 % at 0.8 ms, +6 % at 1.0 ms                                                                      | **B+**        | B+     | (4)   |
| 74LS input / output stages                            | Unmeasured; the input stage is a straight line where the part is near-constant-current (reasoned, below)                                      | (B−)          | B      | 0, 4  |
| BJT as a saturated switch                             | VCE(sat) 0.20 V vs 0.04–0.08 V                                                                                                                | **B−**        | B      | 4     |
| BJT in its active region                              | Rb = 1 MΩ: Ic **−22 % / −33 %** vs 2N3904 / 2N2222; Rb = 100 kΩ: active (0.65 V) where both parts saturate (0.11–0.17 V)                      | **C**         | B      | 4     |
| MOSFET fully on                                       | Vgs = 5 V, 100 Ω load: 49.5 mV vs 79 mV (2N7000 fit); vs 1.3 mV (IRLZ44N fit)                                                                 | **B** / **D** | B      | 4     |
| MOSFET near threshold                                 | Vgs = 2.5 V: **0.19 V vs 1.96 V** (no saturation region: Spice Lite's MOSFET is a variable resistor)                                          | **F**         | B      | 4     |
| Inductors                                             | A wire                                                                                                                                        | **F**         | B      | 3     |

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

### 1b. D2, the 555's pin currents

- Gate each comparator's input current by its comparator's state: TRIG's flows only while
  TRIG is below the lower tap, THRES's only around and past the upper. Take each current's
  DIRECTION from the transistor-level reference (Phase 0). The die suggests TRIG (a PNP
  input) flows OUT of the pin. Don't assume it; measure it.
- **Acceptance.** RA = RB = 1 MΩ, C = 1 µF within 3 % of the transistor-level reference.
  Every existing 10 kΩ test unchanged within 0.5 %. The bias-current tests rewritten to the
  gated model.

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

## Phase 3 — Inductors

Needs Phase 2. The inductor is the capacitor's dual: its state is a current, continuous
across every event.

- **The netlist.** Under Spice Lite the inductor must NOT join its two nets (the voltage
  across it is the point). The digital engine keeps it a wire, so digital results and every
  export stay byte-identical. Spice Lite asks `NetlistCache` for a variant with inductors as
  branches (`{inductors: "branch"}`), SimController picks it at Run. No shipped example has
  an inductor, so parity is untouched (asserted).
- **The model.** L in henries (the existing optional Inductance), in series with a DC
  resistance (question 5). Blank Inductance: still a wire, in both engines, and the guide
  says so.
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
- **BJT.**
  - VBE from the junction curve.
  - β the representative part's typical (question 3; 100 is the 2N3904's MINIMUM).
  - VCE(sat) from the sheet's Ic/Ib = 10 points instead of 0.2 V + 1 Ω.
  - VCEO breakdown (Phase 3's clamp).
  - **Target B** vs 2N3904 across the Rb sweep (Ic in the active region, Vc in saturation
    within 50 mV).
- **MOSFET.**
  - A saturation region: square law, K fitted so RDS(on) at the class's rated gate drive
    is the class's.
  - The body diode.
  - V(BR)DSS.
  - **Per-CLASS figures by `case`** (question 3): TO-92 is the small-signal class
    (2N7000/BS170), TO-220 the power class. `case` is already a user-visible parameter,
    so no new field is needed, and no per-part figures. The catalog's TO-220 part is the
    IRF540N, which is NOT logic-level (rated at Vgs = 10 V, barely on at 5 V), so which
    part the class represents is part of question 3.
  - **Target B** vs each class's representative across Vgs 2–5 V.
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

## Phase 5 — Scope boundaries, said out loud

Where a B is not feasible or not wanted, the guide's "What Spice Lite doesn't do" says so,
and the engine says something specific instead of something misleading:

- **A gate's linear region.** An unbuffered inverter biased by its own feedback resistor
  (a CD4069UB amplifier, a crystal oscillator) has no logic answer. Today it reads X, or
  chatters to `oscillation`. Instead it gets a specific `linear-bias` warning naming the
  gate. Modelling the UB parts as the MOSFET pairs they are (as the CD4007UB already is)
  becomes possible after Phase 4's MOSFET and is a stretch item (question 10).
- **Below a gate delay.** Edge rates, parasitic capacitance and ringing on wires stay
  unmodelled. Pass quanta are the time resolution.
- **Per-part transistor accuracy.** Under one common set per class, a part far from its
  class's representative is graded C or worse. Reported in the scorecard, not hidden.
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

- per-part transistor accuracy under the one-common-set rule (B for each class's
  representative only);
- a gate's linear region (out of scope unless question 10 says otherwise);
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
3. **Transistor figures.** MOSFETs get two classes by `case` (TO-92 small-signal, TO-220
   power), since one set cannot be B for both: RDS(on) differs by ~80× between a 2N7000 and
   a logic-level IRLZ44N. The TO-220 class needs a representative. The catalog lists the
   IRF540N, which a 5 V logic output barely turns on; a logic-level part (IRLZ44N) matches
   what a breadboard user expects. BJTs keep one set with β raised to the representative's
   typical. Part numbers stay labels. _Default: two classes, TO-220 represented by a
   logic-level part, and IRLZ44N added to the TO-220 list._ (The alternative, figures per
   listed part number, reverses the one-common-set rule.)
4. **Smooth curves with bounded linearization** rather than finer piecewise-linear tables.
   _Default: smooth, tables as the fallback._
5. **Inductor DC resistance.** An optional "DC resistance" field. Blank means ideal (0 Ω),
   stated in the guide. No invented default. _Default: yes._
6. **Inductors as branches under Spice Lite only** (the digital engine and every export keep
   the wire). _Default: yes._
7. **Unclamped inductive kicks** go to the opening device's breakdown clamp with an
   `inductive-kick` warning, never smoke, and no invented parasitic node capacitance.
   _Default: yes._
8. **The 555's comparator currents** gated by comparator state, their direction taken from
   the transistor-level reference. _Default: yes._
9. **D1 in two steps.** The listener fix and the back-off land in Phase 1. Exact timing
   lands with Phase 2. _Default: yes._
10. **A gate's linear region.** Out of scope, with a specific `linear-bias` warning.
    Modelling CD4069UB-style parts as MOSFET pairs stays a stretch item after Phase 4.
    _Default: out of scope._
11. **New parts inductors enable** (relay, buzzer, motor). Not in this plan; a separate
    plan if wanted. _Default: separate._

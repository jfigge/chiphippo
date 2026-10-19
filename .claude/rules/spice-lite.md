---
paths:
  - "src/web/scripts/sim/spice/**"
  - "src/web/scripts/sim/engines.js"
  - "src/web/scripts/components/settings-spice-panel.js"
  - "src/web/scripts/components/speaker-audio.js"
  - "src/web/scripts/catalog/speaker.js"
  - "src/web/scripts/catalog/ac-parts.js"
  - "src/web/scripts/model/ac-wiring.js"
  - "src/web/scripts/components/ac-wiring-monitor.js"
  - "src/web/scripts/components/ac-view.js"
  - "src/web/scripts/components/transformer-view.js"
  - "src/web/scripts/components/scope-view.js"
  - "src/web/scripts/model/scope-recorder.js"
  - "src/web/docs/spice-lite.md"
  - "src/web/scripts/tests/spice-*.test.js"
  - "src/web/scripts/tests/engine-parity.test.js"
  - "src/web/scripts/tests/scope-*.test.js"
  - "src/web/scripts/tests/spice-golden*"
  - "scripts/spice-*.mjs"
---

## Spice Lite — the second engine

**A more electrical simulation behind one setting, never conditionals in the digital
engine** (plan `features/done/spice-lite.md`, user guide `spice-lite.md`; the audit that
made every net a voltage, `features/done/spice-lite-audit.md`, 2026-10-07). It is NOT SPICE: no
circuit-wide matrix, no manufacturer models — Ohm's law, closed-form curves, a per-family
table from TI's sheets (user-editable) and ONE common figure set for the diodes and the
transistors (`spice/params.js`; Jason: one common set per family, never per part or
maker). The one matrix is a small Newton solve per CLUSTER of nets (below).

- **Every net is a voltage** (`spice/voltages.js` + `spice/network.js`). Each PASS, once
  the digital engine has resolved its levels, the `levels` hook re-solves the CLUSTERS
  something moved in — union-find (per netlist, `voltageTopology`) over resistors,
  junctions, analog-switch channels, transistor devices and off-rail chip loads, rails
  never a join point. Dirty = a driver's output changed (`outputs` hook), a channel
  switched, a bench source or RC node moved, a MOSFET gate moved, or the chips' power
  changed (signature → every cluster). A lone net (drivers + inputs only) is one bracketed
  scalar Newton (`solveDrivers`). FIXED: rails at delivered volts, clocks/flags driving
  (`sourceVolts`), RC nodes at their curve. DRIVERS: output stages (`output-stage.js`),
  each powered input's own stages (`inputStages`: a 74LS input's bias, the swept gate's
  input TABLE — `TTL_INPUT`, 227 µA out of the pin at 0 V falling ~125 µA/V to 109 µA
  at 1.08 V, then to none by 1.1 V, every point +49.6 µA per volt of VCC above 5; a
  CD4000 input's two protection diodes, `CMOS_CLAMP`). BRANCHES:
  resistors, LEDs/segments/diodes/Zeners (`"j"`, a burnt one open), switch channels (rON,
  control read off its OWN reading), transistors as devices (`"q"`/`"m"`), off-rail chip
  loads (ICC at 5 V as a resistor).
  - A net is HELD when a resistive path (resistors, channels, conducting transistors —
    never a junction) reaches a fixed net or an active output; only a held net has a
    voltage (`nodeVolts`) and READINGS: every input/io pin of an OK chip reads it through
    `inputThresholds` — H ≥ VIH, L ≤ VIL, X between; a Schmitt input keeps its reading
    inside its hysteresis. The `input` hook answers the reading (RC nodes: the crossing
    view, unchanged); an unheld net is left to the digital level and the family reader
    (floating 74LS reads H). A digital X (a fight, a divider) is overridden too: a 74LS LOW
    beats a HIGH at ~0.75 V and its readers read L (the `conflict` warning stays).
  - **An analog switch's control is read through `input` on BOTH sides** — the digital
    engine's channel joins (`channelGroups(…, hooks.input)`, and the published
    `channels`) and the solve's own channel states (`pass`'s `read`) — never off the
    net's SHOWN level. The shown level is X wherever two readers disagree (a 74LS input
    and a CMOS control on one divider; a switch off the rails, reading against its lifted
    ground), and a join read off it moved levels on a network the solve never saw move:
    the carried `disagree` went stale and the incremental settle parted from the full one
    (2026-10-07). Its controls carry the CMOS clamp stages, off the rails included.
  - SHOWN level = the readers' agreement (X if they differ), else the digital level;
    `pass` returns `next` or a copy with the disagreeing nets overridden. A reading that
    changed with no level change: `busy` keeps the settle going and the new `reread` hook
    (incremental.js) re-evaluates those chips. On a desk whose voltages agree with its
    levels this is the digital engine pass for pass — `tests/engine-parity.test.js` stays
    green, which is why the CD4000 benches light their LEDs through 1 kΩ
    (`ledSeriesOhms`): through 330 Ω a 5 V CMOS output sags to 3.2 V, under its own VIH.
  - Carried tick to tick in `analog.voltages` (volts, readings, outputs used, channel
    states, owned readers, the report caches) — a tick's first pass reads what its warm
    start says and re-solves only what moved since, like any later pass (2026-10-07: it
    used to start with `all = true`, every cluster every tick — 431 solves a tick on the
    busy fixture, now ~6). A new netlist or config starts fresh. `mode: "full"` keeps the
    old whole-desk solve at each tick's start as the REFERENCE, and
    `engine-incremental.test.js` holds the carried path to it EXACTLY (deepStrictEqual,
    voltages and the snapshot included) — which needs `loose`: an UNHELD net's last
    solved voltage, kept as its next guess, so re-solving an unchanged network takes no
    Newton step instead of landing on fresh noise (a floating segment anode is solver
    noise to ~1 V). A MOSFET gate going held ↔ floating re-solves its users even at the
    same voltage (its report's `held` changes). Wire drops / PSU droop moving by
    ≤ `DROOP_EPS` keep their old value — replaced each tick, a microvolt change altered
    every chip's vcc, hence the plan signature, hence a whole-desk re-solve.
  - `report()` at the tick's end: each cluster's currents (cached per cluster until
    re-solved; `solvedAs` reuses the pass's own network): every lead's current
    (`currents`, the probe), each junction's current and voltage (the LED/diode verdicts
    — burning opens it and re-solves, `setBurnt` + `resolve`), each supply's DRAWS (out
    of a + rail through a branch or device, out of a sourcing output stage from its chip's
    supply; paired with the cluster's biggest return), each output's load against
    `outputLimits` (74LS 20 mA warn / 100 mA smoke; CD4000 50 / 100 mW in the output
    transistor; a def with its own `outputStage` exempt), input stress (74LS > 7 V smokes,
    CD4000 clamp current warns and smokes past 10 mA) and the CMOS band current (0.5 mA per
    CD4000 input between VIL and VIH, booked to its own supply). Rail-to-rail branches,
    outputs and inputs ON a rail are `railFlows`. `atSet` books only the DRAWS, each
    cluster solved at the supplies' SET volts (underpowered chips still driving what
    they last drove) and cached like the plain report (`setReported`/`setStale`, while
    the set-volts plan signature holds) — used while something droops, sags or is
    underpowered, i.e. every tick on any desk whose wires drop over 1 mV. A report
    entry's junction/output/draw objects are built once per entry (`shareOf`).
    At SET a clock brick's HIGH is its supply's SET too (`makePlan`'s `clockPsu`): booked
    at the drooped HIGH, a clock into an LED on a 10 mA supply flipped it between 1.73 V
    and 5 V every tick. Fixed 2026-10-14 in the report: a branch between two UNHELD nets
    (reached through junctions alone — the middle LED of a series string, a resistor
    between two) is reported where its cluster balanced and it carries more than
    `BOOK_FLOOR_A` (it read dark beside its lit neighbours, never judged for overdrive or
    burning); an input pin's lead carries its own stages' current (a 74LS input's bias,
    a CMOS clamp; an off-rail chip's input "s" branch books its pin AND its supply pin) —
    still no draw, inside ICC; a display's bridged commons (`internalBridges`, the
    7-segment's 3 and 8) book their segments' current on whichever the BUILD wired
    (`lamps.js` `commonLeads` — a board node holding anything else), not always pin 3;
    and a chip's supply-wire drop (`sag.js`) sums each wire ONCE over all its draws (its
    ICC and its CMOS band draws counted each wire's whole current once per draw).
  - Transistors (`spice/network.js` `deviceCurrents`, numeric slopes) are each their
    GRADE's part (`spice/transistors.js`, 2026-10-08, plan Phase 4; the catalog's
    `TRANSISTOR_GRADES` + `transistorGrade`, a `spiceOnly` select whose default follows
    the package: TO-92 the type's first, TO-220 Power — only while NO grade is stored;
    one picked is stored even when it is the package's default (2026-10-08: dropping it
    let a package change and back silently swap an explicit pick, and left the card
    showing a grade the part no longer ran as); a listed part number brings its grade
    and package, `TRANSISTOR_PART_FACTS`). Jason's "one set per kind" became one
    per GRADE, each one representative part's figures: NPN 2N3904 · 2N2222A · TIP120 ·
    TIP31C, PNP 2N3906 · 2N2907A · TIP125 · TIP32C, N-MOSFET 2N7000 · IRLZ44N · IRF540N,
    P-MOSFET BS250 · IRF9540N. **Grade ▸ Custom…** (2026-10-08,
    `features/done/component-value-entry-spec.md` §5 — the spec's fallback presets were NOT
    added, the grades ARE the range): the Grade field is `type: "preset"`
    (`components/preset-field.js`), its last entry opening the grade's FIGURES
    (`spice/transistor-figures.js` `FIGURE_FIELDS`: BJT hFE · VBE(on) — both at VCE 5 V and
    a tenth of the BASE grade's rated current — · VCEO · IC max; MOSFET VGS(th) · RDS(on) at
    VGS 10 V · V(BR)DSS · ID max; magnitudes). `gradeFigures` MEASURES a grade's off its
    model (3 figures); `customModel` is the base grade's model with each put back exactly
    (gain: BF up and ISE down by k, a Darlington √k per transistor; turn-on: IS/ISE by s,
    stepped in turn; RDS(on): RD and 1/KP scaled together; limits keep the smoke ratio),
    cached. Stored as `grade: "custom"` + `custom: {from, …figures}`; normalizeParams
    COLLAPSES a set equal to its base's figures to that grade, so a card never names a
    preset over other figures nor Custom… over a preset's. `transistorModelFor(type,
    grade, custom)` is the one read (voltages.js, spice-deck.mjs — a custom grade is a
    fit there, never its base's vendor card). VCE(sat) is not a field: BR, RC and the
    drive make it, no one knob. A BJT is the DC Gummel–Poon subset (IS, BF, ISE/NE, IKF,
    VAF, BR, RB folded into the base–emitter table's voltage axis, RC solved inside the
    device — `solveRising`) on junction TABLES over a nanoamp to 64 A, the vendor card's
    numbers where one exists and a fit to the sheet where not; a DARLINGTON is its
    sheet's two transistors with 8 kΩ / 120 Ω across their base–emitter junctions, the
    node between solved inside. A MOSFET is level 1 (VTO, KP, RD in closed form) with
    pieces on a geometric overdrive grid (every 10 %) and tenths of its linear region —
    a square law is not straight. Breakdown per grade (`vceoV`/`vbrV`). A device
    CONDUCTS (holds a net) past `CONDUCTS_A` of transport current, or a gate past VTO.
    A MOSFET's gate is fixed from wherever its net is solved and KEEPS its voltage
    when floating (`settleNet`, `gates`) — `held`. Discrete ones report
    `transistors` (`{on, held, amps}`), which SimController's `#shownChannels` puts in
    place of the digital `channels` it publishes (the result's own `channels` stay
    digital — parity). The CD4007UB's six are `"m"` devices. EVERY discrete one (`topo.
    selfControlled`, 2026-10-14) has its base or gate answered by the `input` hook from
    whether the solve has it conducting (`volt.selfControl`; re-read when a solve turns
    it, as a reading is), never at its net's digital level: read there, one feeding its
    own base (diode-connected, a mirror's reference, the second of a Darlington of two
    discretes) turned itself off by turning on, and a flip-flop of two switched each other,
    every pass to the iteration cap — X and `oscillation` every tick. A desk whose voltages
    agree with its levels reads the same either way (engine-parity holds). **A balance
    the nets would fall OFF** (`newtonSolve` → `unstable`/`fallOff`, spice/network.js):
    Newton finds a balance, not a stable one, and a symmetric flip-flop from a symmetric
    guess lands on its knife-edge (both transistors half on, both collectors at a volt,
    both read LOW). In a network with two or more transistors a balanced solve checks the
    Jacobian's determinant sign — with a unit capacitance per net a stable balance has the
    sign (−1)ⁿ, the other sign is an odd number of runaway modes — and falls off along the
    runaway mode (`runawayMode`: backward Euler's step `g(gI − J)⁻¹` squared forty times),
    by backward-Euler steps kept short while they run away and lengthened once clear, then
    Newton from where they rest. Nudged first-net-DOWN (then up), the first net in
    `ctx.netIds` order, as the logic engine's tie-break counts — so a cold flip-flop comes
    up the same way in both engines. Kept only if it lands on a stable balance. The
    memo of a BJT's answers (`bjtCurrents`) is bounded by ANSWERS (4096 a model), not by
    VBE: one held off at one VBE with its collector on a capacitor's curve grew one VBE's
    map 0.8 MB a simulated second.
  - Chip power: a chip NOT straight across the rails (`railFed` false) gets its status
    from the new `chipVolts` hook — V(VCC) − V(GND) from the last solve (`fedStatus`); the
    resettle loop runs again when that moved. Rail-fed chips are the digital rule exactly.
  - Retired under Spice Lite (filtered, `RETIRED`): `ls-fanout`, `marginal-high`,
    `mixed-supply`. `ctx.limitsLed`'s LED rule is still computed (strongLevels are a parity
    field) though nothing under Spice Lite reads it.

- **Clock waves** (2026-10-09, `spice/waves.js`, no plan): a clock brick's `wave` param
  (`CLOCK_WAVES`: square · pwm · triangle · trapezoid · ramp-up · ramp-down · sine,
  stored only off square; `waveOf` is square for a manual clock). **`LEVEL_WAVES`**
  (square, pwm) are LEVELS in BOTH engines — a PWM is the square with unequal halves
  (`duty`, 1–99 %, stored only on a pwm off 50; `dutyOf`; the schedule's halves,
  `.claude/rules/simulation.md` → "Batched ticks") and never a node here (`analyze`
  skips it). The Wave select is no longer `spiceOnly`; its OPTIONS are, bar the levels
  (`#propertyFieldsFor` drops a `spiceOnly` option outside Spice Lite unless it is the
  value held), and the Pulse width row is greyed (`disabledWhen`) off a free-running
  pwm. Every other wave swings 0 V → its supply, Spice Lite only. A **trapezoid**
  (`TRAPEZOID_RAMP` 0.2: flat 30 %, up 20 % to the L→H edge, flat 30 %, down 20 %) has
  corners INSIDE a half: its generator's `end` is the foot of the ramp for the flat
  piece, and the engine, ending a wave's piece at `limit` = `gen.end`, re-asks there
  (`CORNER_EPS` makes a piece starting on the corner the ramp, not a flat of no length).
  The SQUARE still runs it: SimController flips its level every half as before and hands
  Spice Lite `clockTimes` (id → `{half, since}` — the last edge — or `{half, frac}` for one
  held by its own pause), so the wave's phase is the level's half plus the time since the
  edge (`cyclePhase`) and Step/pause/re-rate/overdue edges mean the same for both. Only a
  wave clock keeps its place across a resume (`#keepsPhase` → `EdgeSchedule.set`'s
  `elapsed`); a square's half restarts, as before. In the engine its out net is a
  CANDIDATE node (`analyze`'s `waves`, `cand.wave`): `fixedOf` holds a wave net at its node
  value (so `linearizeGroup` can nudge it), and a running wave is a STATE of its dynamic
  group — `runGroup` replaces its rows with its generator (a straight piece v' = slope; a
  sine two states in quadrature, v' = ω·u, u' = −ω(v − mid), modes ±iω), carries a
  capacitor from a node to it as C·(the wave's rate) into the node, and ends the piece at
  the wave's next edge (`limit`, also capping `groupCorner`'s search — a sine's slow scale
  is infinite; `byWave` keeps that end from reading as a stuck corner). A wave alone in its
  network still runs through `runGroup` (its network's corners end it). A held wave is a
  `driven` node. Its only JUMP is at the tick's own moment (before → own inputs at
  `target`, `refreshWaves`/`jumped`), carried through capacitors by `couplingSteps`; its
  steady motion never is. A SHAPE changed mid-run jumps too: `analog.waveKinds` carries
  each wave net's shape, and "before" is read with the OLD one (2026-10-10 — read with
  the new shape on both sides, the jump was zero). Frames: `period / WAVE_FRAMES` (16), between `WAVE_FRAME_MIN_S`
  (2 ms) and `ANALOG_FRAME_S` — only while the analyzer has channels (`spice.waveFrames`,
  SimController; else `ANALOG_FRAME_S`) — DISPLAY frames, no wakes since 2026-10-09
  (below, "Display frames"). The stages ON a running wave are no corner
  (`linearizeGroup`'s `sources`: what it delivers is read by nothing) — a triangle into
  four 74LS clock inputs woke the desk three times a period at their knees, ~1.6× the
  ticks for nothing — and a group whose networks have no pieces at all (`linear`, an RC
  on a wave) skips `groupCorner`'s search (it was half a tick). Booked as push-pull (`returnAt`: sources from its supply,
  sinks to its ground). The lamp (`#shownClockLevels`) and the brick's glyph
  (`ClockView.setSpiceLite`) follow the wave only under Spice Lite. A running wave is
  in its OWN island's signature only (a wave island is never drawn — its period spans
  ticks), so a fast oscillator elsewhere is drawn beside it (islands, 2026-10-09; it used to
  run edge by edge, 10× slower for a 68 kHz 555 beside a triangle).
  `tests/spice-waves.test.js` holds it to the closed forms (an RC on a triangle and a sine,
  a sawtooth through a high-pass, a 40106 at VT±).
  - **Amplitude / Offset** (2026-10-13, Spice-only `valueField`s on the clock, optional,
    `CLOCK_SWING_RANGE` 0.01–30 V, stored only on a non-level wave): `waveSwing(params,
    supply)` → `{lo, hi, floor: 0, ceil: supply}` (unset: 0…supply, so every old desk is
    bit-identical — `waveVolts`/`waveGenerator` still take a bare number as that). Past a
    rail the wave is CLIPPED: `clipLine` / `clipSine` end the piece where it meets the
    rail and hand back a `"flat"` piece (slope 0, not a quadrature state) until its line or
    angle comes back (`nextAngle`); `endBy` ignores a crossing a hair before the edge (a
    full swing meets its rail AT the edge). The engine's wave map carries
    `amplitude`/`offset`, `waveKinds` holds `{wave, amplitude, offset}` so a mid-run edit
    jumps from the old swing; the lamp is lit above the swing's (clipped) centre. The deck
    writes the swing into PWL/SIN and wraps a clipping one in a `max/min` B-source. Golden:
    four `-…vpp-at-…v` cases (two clipped), exact.
- **The bench parts** (regulators, op-amp, optocouplers, ULN2003A, relay, load) are
  devices of the same solve — `.claude/rules/bench-parts.md`, which also records the
  solver changes they forced (Gauss–Seidel fallback, Brent, the sliding run-on).
- **The seam** (`sim/engines.js`): `ENGINES.digital` IS `engine.js`'s `tick`/`settle`;
  `ENGINES.spice` takes the same options plus `spice: {config, analog}` and returns the
  same result plus `analog` (carried by SimController like `state`), `nodeVolts`,
  `supplies`, `loads`, `sag`. **Only SimController chooses** (at Run); the AI verifier,
  the desk review, `make demos`, the exports import `engine.js` directly, so they are
  digital by construction — exports stay byte-identical, demos validate unchanged.
- **Spice Lite DRIVES the digital engine through `hooks`** (`engine.js`'s header):
  `context`, `logicOf`, `stepEnv`, `input`, `outputs`, `levels` (told `{start, state}`),
  `reread`, `busy`, `pass`, `maxIterations`, `psuVolts`, `chipDrop`, `chipVolts`. Absent =
  today's engine byte for byte. It never re-implements a settle; a Spice Lite tick is
  several digital ticks with the analog side between.
- **The oracle**: `tests/engine-parity.test.js` runs every shipped example desktop through
  both engines, 24 ticks, every shared result field deep-equal. An example Spice Lite is
  MEANT to run differently is exempted WITH its reason (today: the three NE555 desktops —
  `SILICON`); on a desk with a silicon part, THAT part's `state`/`pinLevels` and the
  desk's `iterations` are not compared (its state is its silicon's).
  **One ALLOWED disagreement off the examples — a wired-AND with an unknown output**
  (Jason, 2026-10-10: the digital engine cannot properly support open collectors, and is
  not grown a driver tier for it). An open-collector X beside an open-collector LOW is X +
  `conflict` in the digital engine (it has no strength for "sinking or let go"); Spice
  Lite drops that conflict and SHOWS the net LOW (`wiredLow` in spice/engine.js: every
  output on the net open-collector, one L, the rest X, no bench source, no diode FEEDING
  the net (its cathode there, or a Zener's anode — a plain diode's anode only sinks; the
  digital context's diodes carry `zener`) and no channel onto it that might be on — a joined group's fight is said on ONE
  member net, and a HIGH through a diode is no output — AND the solve holding the net
  under the 74LS VIL; a pull-up the LOW cannot hold is still a fight). Only where the net
  would otherwise SHOW the digital X (nobody reads it) is it set L — a read net already
  shows what its readers read. Pinned by the parity file's `WIRED_AND` test and the
  stand-aside test beside it (channel, diode, a 10 Ω pull-up; 2026-10-10).
- **Time**: a pass is one QUANTUM, the shortest gate delay on the desk
  (`spice/params.js`; CD4000 scaled along SCHS015C's 5/10/15 V points); a slower chip
  HOLDS its outputs `round(delay/quantum)` passes, inertially. One family → every hold
  is 1 → pass for pass the digital engine. The cap is `MAX_ITERATIONS × maxHold`, and the
  slowest gate is at most `MAX_HOLD` (64) quanta — past it the quantum grows — so a
  delay edited absurdly short cannot turn a tick into minutes. **Per island**
  (2026-10-09, `features/13-per-island-quantum.md`): "the desk" is the islands the tick
  is FOR (`pace()` in spice/engine.js, over `analyze`'s `delays`) — a CD4000 island
  ticked on its own runs at 125 ns with holds of 1, not cut into a 74LS board's 10 ns
  (and a chip driving straight through at a hold of 1 keeps NO commitment — `holdOutputs`
  deletes it — or the next co-tick's hold drove a stale map for its count, 2026-10-14).
  An island whose chips have no gate delay (a lone 555) counts at the 74LS fallback
  (`quantumOf`'s `bare`), as it would alone — leaving it out let a co-tick with a
  CD4000 island run the 555 at 125 ns. Holds are in the TICK's quantum, so a chip's
  delay is the same nanoseconds whoever shares its tick. A single-family desk (and a
  desk not yet sorted into islands) is exactly `analyze`'s.
- **Analog nodes are CLOSED-FORM, never stepped** (`spice/rc-curve.js`): EVERY net with a
  capacitor whose far lead reaches something (`trace.connected`) is a node — a timing
  part's own included (it is its silicon, below) — following V∞ + (V0 − V∞)e^(−t/τ) from
  its cluster solved with its capacitors open and LINEARIZED where it stands
  (`voltages.js` `linearize`: the current in at V0 and its slope, read a millivolt apart
  toward where it is heading) — or a straight RAMP (`rate`) where nothing gives way (an
  output saturated at its limit). Each curve ends at its next CORNER (`until`: a stage's
  open-circuit level or saturation corner, a junction's knee against a fixed far side, or
  one further off in its network — `farCorner` bisects the network's `pieces` signature
  along the node's path), where it is re-linearized with NO settle (`MAX_CORNERS`); a
  corner past the window is a `wakeAt`. Driven outright (`driven`) only by a bench source
  or a 0-Ω union. Each capacitor's CHARGE (`analog.caps`) is carried tick to tick; a node
  not yet seen starts where its charge puts it (`chargedTo`), and every listener is PRIMED
  from the voltages before the first settle (`primeListeners` — read off the digital level
  of a node net, a 555 chased its own discharge round the step loop). A late tick catches
  up in order on the PRIOR tick's inputs (`analog.inputs`, `volt.sources`) on its own
  budget (`MAX_CATCHUP_EVENTS`); `MAX_ANALOG_EVENTS` caps the live settles and reports
  `oscillation`. Every node still on its way — listened to or not: the frames are for the
  probe and the analyzer, and crossings are timed exactly regardless — asks for display
  frames (`ANALOG_FRAME_S`, the result's `frameAt` — NOT a wake, "Display frames" below)
  until the gap setting says arrived — and a step under
  `ARRIVED_STEP_V` (1 nV; a coil's under `ARRIVED_STEP_A`, 1 fA) has arrived: a coupled
  group re-anchored at every settle keeps a step of rounding, and judged against 1 % of
  that it asked for frames forever. The settles inside one tick read the memory images with
  the earlier settles' writes to a volatile chip applied.
  - **Display frames are no wakes** (2026-10-09, `features/01-display-wakes.md`,
    `spice/sample.js`). Only what has an electrical or digital consequence wakes the
    engine (`wakeAt`: crossings, corners, timers, relays, a regulator cooling, the
    chatter back-off; SimController adds clock edges and inputs). A node still moving,
    a running wave, a coil still moving are REDRAWN: `nextDisplayFrame` (the old frame
    rule, one implementation) is the result's `frameAt`, and `sampleAnalog(analog, t)`
    reads every node / wave / coil off the carried curves (a drawn cycle off its
    schedule, as `applySeg` stands it) with the engine's own evaluators — exact until
    the next wake, since every corner and crossing is one. SimController publishes at
    most every `PUBLISH_MS` (40, 25 fps), a moving desk's board SAMPLED at the sim
    clock (`#sampled`/`#shownAt`, clamped to the next wake; a pause shows the paused
    moment) and re-armed every `PUBLISH_MS` while `#frameAt` stands though no event is
    due; while the analyzer records, the frames between two ticks go out as sim-ticks
    of their own (`#emitFrames`), so its columns are where the frame ticks put them.
    Not sampled (they need a solve): a non-node net in a moving cluster, an LED's
    current off a moving node — they move at the next wake. `analog.inputs` is a COPY
    of the tick's clocks/signals: SimController flips its maps in place, and the next
    tick's history replay (`before`) read the NEW phase — a square clock into an RC
    charged it from the previous tick on (worse without frames: from the last edge).
    The golden harness keeps `frameAt` in its tick grid (so the scorecard measures what
    it did) and adds a run without it to the tick-spacing check
    (`tests/spice-sample.test.js` holds the sampler to a forced tick).
  - **Coupling** (`spice/coupling.js`): a capacitor's far side STEPPING between two
    settles steps the node by its share (`couplingSteps` — every node's charge conserved
    through one small linear system, an attofarad to ground for nodes joined by capacitors
    alone; `capFar` keeps each far side as last seen).
  - **Nodes that move TOGETHER are solved exactly** (`spice/dynamics.js`, 2026-10-08,
    `features/done/spice-lite-3-plan.md` Phase 2). A DYNAMIC GROUP (`dynamicGroups`, per
    topology) is the RC nodes in one voltage cluster plus those a capacitor joins (a rail
    never joins). Two or more of a group free (`volt.heldAt` null) move as ONE linear
    system (`runGroup`): `volt.linearizeNodes` reads i = i0 − Y·v off the solve (each node
    nudged the way it heads), C is the nodes' capacitance matrix, and `rcSystem` splits
    C by its eigenvectors — the RANGE is the charges (states), the NULL space a lone
    capacitor's plates' common voltage, ALGEBRAIC. Symmetric Y (every two-terminal
    element) gives real modes: each node a closed-form sum of exponentials (`kind:
"modal"`, a·e^(kt) + r·t·φ(kt)); an unsymmetric one (a device's stamp, an
    inductor's) through complex modes (`complexModal`, still closed form), and e^A
    (`kind: "system"`, Padé 13) only where modes cannot be told apart (`MODAL_COND`). A coupled curve ends at its group's CORNER IN TIME
    (`tEnd`: `piecesAt` — every net carried along the solve's affine map — sampled over
    the time constants and bisected); `rc-curve.js` reads both kinds (`isCoupled`,
    `heading(curve, t)` — at a corner, the way it was going), `firstCrossing` samples
    them (`sampleTimes`, `searchEnd`) — a ringing one (`scale.osc`) every eighth of a
    period for its first `RING_PERIODS` 50, and `firstRoot` looks at the crest between
    three samples that rise and fall short of the level (the parabola through them):
    a grid a radian or two apart missed one crossing in six near a Q-50 ring's crest
    (2026-10-14). A common mode is balanced on the TRUE networks
    first (`balance`: bracketed then Illinois on `volt.currentsAt`) — balanced on a
    linear piece it jumped past a clamp or a saturating stage and back, forever. Two or
    more modes are balanced TOGETHER first (`balanceTogether`, 2026-10-14: Newton on the
    modes' residuals, slopes read `BALANCE_SLOPE_V` apart, steps halved until they gain),
    the one-at-a-time sweeps only where that fails: a two-transistor FLASHER's two
    capacitors are two modes coupled through both transistors, and swept in turn the
    bracket jumped to the far root (a flip every 1.5 ms) or the linear model's algebraic
    modes extrapolated (a base at −43 V, flips every 30 ms). A joint balance the plates
    would fall OFF — the flasher powered up even, both transistors half on, which stood
    0.2 s and flipped wherever the ticks' noise tipped it — is moved onto a stable one by
    `fallOffBalance` (spice/network.js, `fallOff`'s fall for a residual over the mode
    coordinates), first coordinate down, so it comes up the same way at every tick rate:
    first flip at 55 ms (an empty capacitor), then ln 2 · RC (0.33 s) a half, −4.2…5 V.
    Nodes
    not yet seen start TOGETHER (`chargedNets`, one charge system): one at a time, a plate
    started where its partner's network held it, capacitor open. One free node in a group
    is still a single curve (`curveFrom`), exact because the rest of its group is held.
    The pair path (`pairsOf`/`runPair`/`pairStand`/`pairCurves`) is gone.
  - **Inductors are branches with a current for state** (`spice/inductors.js`,
    2026-10-08, `features/done/spice-lite-3-plan.md` Phase 3). Only on Spice Lite's netlist:
    `buildNetlist(…, {inductors: "branch"})` (`isInductorBranch` — a def with `inductor`
    AND an inductance) leaves its bridge out, `NetlistCache.get({inductors: "branch"})`
    caches that variant (the same object when no inductor qualifies), and SimController
    asks for it only on the spice engine — so the digital engine, the exports and the
    schematic still see a wire, and a bare inductor is a wire in both. In the solve it is
    `"l"`, a current source of its present current (`analog.coils`, `coilAmps`, carried
    tick to tick like a capacitor's charge); between events it moves with its group,
    L·di/dt = V(1) − V(2) − R·i (`runGroup`'s E is blockdiag(C, L), coil ids keyed
    `coil:<id>`), so its group's system is UNSYMMETRIC and runs through
    `complexModal` (closed form, ringing included; e^A for a near-Jordan block,
    `MODAL_COND`). R is the Winding's (`inductorOhms`: a power law of L per body, × the
    grade's factor — catalog/discretes.js). Where its current goes when a switch opens:
    a flyback diode; a MOSFET's BODY diode (`BODY_DIODE`, `bodyAmps` in network.js — every
    MOSFET, inert until reverse-biased); a CMOS output's rail clamps (`outputClamps`,
    added ONLY in a cluster with an inductor — elsewhere they never conduct); else the
    switching transistor's BREAKDOWN (`BREAKDOWN`: BJT 40 V, MOSFET 60 V, behind 1 Ω).
    Reaching breakdown in a coil's cluster is an `inductive-kick` WARNING (`kicksNow`:
    `{comp, volts, joules}` — ½LI² of the coils feeding it; SimController's toast keyed
    `kick:<comp>`). A desk holding a coil never records a cycle (its signature carries no
    coil current). A coil the wiring takes OUT of the network (a switch shorting it, a
    lead off — no branch, `inductorTopology`) is carried in `analog.coilsAway`: shorted
    (`shortedInductors`) its current dies round the loop with its own L/R (`coilTau`),
    opened it is gone (`awayAmps`); back in, it starts from what is left (2026-10-08 — it
    used to come back at full current, kick and all, seconds later). A cluster with a
    coil is solved to `COIL_TOLERANCE_A` (1e-14 A since 2026-10-09; it was 1 pA): a net only
    a coil holds (a relay's collector, its transistor off) answers its current through
    leakage, where a nanoamp is volts. A coil's slope is read a hair off its current (`LINEARIZE_I` 1 pA, or
    1e-6 of it) — a microamp nudge read a relay's sub-µA tail across junction pieces
    and froze it at −0.43 V, corners picoseconds apart. A GROUP still stuck on a corner
    (re-linearized there, the same pieces again, or one of its last `RECENT_PIECES` —
    `runGroup`) runs on along the piece twice as long each time (from `STUCK_MIN_S`,
    capped at its SLOWEST time constant since 2026-10-09, and never carrying a coil's
    current through zero — bench-parts.md).
    The tick re-solves what its last corners moved before it reads `nodeVolts`. In
    `rcSystem`, only the CAPACITANCE rows (`nc`) can be a null mode, judged against the
    largest capacitance — 1 pF beside 10 H was counted as none. The probe reads an inductor's two sides at the POINT
    (`SimOverlay.levelAt`/`voltsAt`, through the engine's own netlist).
  - **Listeners** (`spice/listeners.js`): every pin that READS a node's network (an input,
    a silicon `sense` pin — a resistor away included, or one whose REFERENCE net the node
    moves) is keyed `comp#pin`, owned by the engine (`volt.setOwned`: the steady solve
    skips it), and read by its CROSSINGS: its difference (net less reference) is stated as
    a constant plus node curves (`volt.affine`, each node nudged the way it is heading so a
    node ON a corner is stated by the piece it enters) — one curve inverted exactly
    (`crossingTime`), a sum sampled and bisected (`firstCrossing`) up to the nearest
    corner. A WINDOW sense (`window: true`, a monostable's RX CX) is two listeners, the
    lower under `windowKey` — H above both, L below both, X between (`windowLevel`). The
    view (`viewNets`) is their agreement; a quiet node no one reads whose digital level is
    Z is not overridden (a CONT only the divider holds).
  - **A listener that is no node is re-read IN the settle when a DRIVER moved it** — and
    never before the settle's first solve (`solvedYet`): until then a net's voltage is the
    LAST settle's, nodes and all, and read at a crossing it undid that crossing (the
    two-gate oscillator behind Rs, capped at its first crossing, was this — not the 20 mV
    dip Phase 1a blamed)
    (`engine.js` `rereadListener`, from the `input` hook; 2026-10-08,
    `features/done/spice-lite-3-plan.md` D1). Its crossings say what the NODES do between
    settles, but a pin on a net a chip output drives (the second gate of a two-gate RC
    oscillator, on the first gate's output, a resistor from the junction) must see that
    output switch within the same settle — read only by crossings, it saw it an event
    late, and the oscillator flipped every two quanta and never ran. It is re-read from
    the voltage the pass just solved, through its own hysteresis, only when that voltage
    stands more than `DRIVER_EPS` (1 mV) from its statement (`diffs`): at the moment of a
    crossing the solve sits ON the trip point and a re-read there undid it. A pin ON a
    node is never re-read (within a settle a node stands still).
  - **Chatter backs off** (`chatter` in `analog`: `{at, backoff}`). A CAPPED tick (its
    whole `MAX_ANALOG_EVENTS` budget spent at one moment, no cycle found) waits
    `MIN_SHOWN_S` before the next, doubling to `MAX_CAPPED_BACKOFF_S` (1 s) while capped
    ticks recur within `CHATTER_MEMORY_S` (1 s); while remembered, NO wake is sooner (not
    the settle's, not a timer's elsewhere on the desk), no display frames are asked
    for, and no history is replayed. A stuck chatter cost 30–120 ms a tick every 0.5 ms.
    Inputs and clock edges still tick it at once.
  - **Silicon** (`spice/silicon.js`, `features/done/spice-lite-2-plan.md`): a timing part with a
    `silicon` block (NE555, CD4047B, CD4098B/4528B/4538B, CD4060B, CD4541B — the ratchet in
    `spice-silicon.test.js`) is evaluated AS it under Spice Lite (`logicOf: siliconOf`; the
    settle index is rebuilt when any def is swapped). The block is the sequential contract
    plus `sense` (comparators; `ref` a pin or an internal net), `drives`, `stages`
    (`openDrain` — DISCH, RX CX), `inputs` (a comparator's bias, or none — the 4047's RC
    COMMON has no clamp), `internals` (the 555's 3 × 5 kΩ divider, the 4098/4538's CX tied
    to VSS), `overRail` (a pin the sheet's network drives past a rail through Rs: its clamp
    current is booked and smokes past 10 mA, but is no warning), `iccMa`, `limits`,
    `readout`. Nothing computes a period; the readout is MEASURED (`spice/measure.js`:
    `noteLevel` at each settle, `measuredTiming` overlays the digital analysis's sections,
    only its STRUCTURAL problems — `notConnected`, `notGrounded`, raised as a `timing`
    warning; recognition ones (`noResistor`, `ne555Unrecognised`, …) are dropped). The Properties card's Timing row still
    reads the catalog def. Derived figures, flagged at their defs: the monostables'
    references (lower 5 % VDD, upper VDD·(1 − 0.95e^(−K)) for T = K·RC) and discharge
    resistance (CD4098B Fig. 10 → ≈83/50/33 Ω); the 4047's VTR ½ VDD and its idle pull-up
    (the family's HIGH stage a diode drop down); the CD4528B's least Rx (5 kΩ, its smallest
    test condition — the sheet states none).
  - **RX CX's rating** (`limits[rxcx] = {sustained, rxMinOhms, smokeMw}`, monostable.js):
    the discharge transistor is held to what it SUSTAINS, never the instant it dumps Cx
    (60/200/450 mA through ≈83/50/33 Ω at every trigger — the sheets bound that by Cx ≤ 100 µF,
    `cxTooLarge`, a STRUCTURAL timing problem in both engines). On an RC node the node is FIXED
    at its curve, so `stageFlow` never sees it: `sustainedFlow` books it at the node's V∞
    (`headingOf`: Newton along the network with the node free, capacitors open); off a node
    `stageFlow` books it and the instant is the sustained figure. `params.js limitsAt` turns
    `rxMinOhms` into `warnMa = (VDD − V) / (Rx_min + R_on)` at the chip's supply — the transistor's
    own on-resistance in series, so Rx AT the minimum is silent and 1 Ω under warns (`rx-current`
    warning; the compare forgives a few ulps); past
    the family's 100 mW in it, `output-current` smoke (OVERLOADED). Rx_min: CD4098B 5 kΩ
    (SCHS065C), CD4538B 4 kΩ (SCHS093C), CD4528B 5 kΩ (derived).
  - **Supply current**: every CD4000 timer's quiescent IDD (0.02–0.04 µA typ, 5 nA the 4528) IS
    the family's `supplyMa`, so only the CD4541B states `iccMa` — its quiescent plus SCHS085E
    Note 2's AUTO RESET drain (7/30/80 µA at 5/10/15 V) when pin 5 is on a − rail. `iccMa(vcc,
tiedLow)`: `supplyMaOf` hands a silicon block a `tiedLow(pin)` read off the wiring
    (supply.js / voltages.js, `minusNets`).
  - **Fast oscillations** (`spice/cycles.js`): after each settle the analog side's
    SIGNATURE (every node's voltage and curve, every reading, what the chips on the nodes'
    networks drive and read, the supplies) is recorded; one repeating an earlier moment
    within TIMING_CAP_HZ's period — a reading changed in between, some node swinging ≥ 1 %
    of the supply (an RC round an ordinary inverter chatters at one point: still
    `oscillation`) — is a CYCLE, drawn from then by its SCHEDULE at the cap with its duty
    kept: each tick walks the segments the shown wave began since the last (`done`,
    at most one cycle), each settled at its moment, each checked to still drive what it
    recorded (else the nodes run on from there). Time is not slowed: `stepEnv` tells a
    counting part's pins `{id, cycles, period}`, the true cycles since the schedule began
    (the 4060/4541 count on from their `base`). Ends on a new netlist or document, a moved
    supply, or a drive mismatch. The DRIVE signature (`driveSig`) holds every bench
    source (clock or flag) on the nodes' networks at its level (`benchIn`, the inputs the
    last settle ran on): a flag through a diode or resistor into a 555's timing capacitor
    moves the curves as a chip's output does, and without it a schedule drew the old
    frequency on past the change (2026-10-10).
    **One per ISLAND** (2026-10-09, `features/04-island-analog-bookkeeping.md`,
    `spice/islands.js`): an island is what can see itself — union-find over the voltage
    clusters, both plates of every capacitor and every pin of every chip, rails never a
    join point — ANALOG when a node, a wave or a coil is on it. Each analog island has its
    own timeline (only ITS moments — `touched`), signature, cycle (`analog.cycles`),
    `MAX_ANALOG_EVENTS`/`MAX_CATCHUP_EVENTS` budgets (one capped stops crossing, the tick
    goes on for the rest) and chatter (`analog.chatters`, matched next tick by name or a
    shared net; holds back only its own wakes and frames — the whole-desk clamp when
    every island chatters). Several drawn islands walk their segments merged in time
    (`runCycles`); one drawn beside stepped islands has each segment as an event
    (`nextSeg`/`pendingSeg`, at its own moment, before any settle past it), and a drawn
    island's nodes are left alone by `updateNodes`. A one-island desk runs exactly the
    old code (`oneIsland()` keeps the maps whole) — golden bit-identical. Each tick's
    quantum is its islands' own ("Time", above — features/13).
    **Ticked apart** (2026-10-09, `features/12-island-scheduling.md`, the scoped form):
    each analog island carries its own next event (`analog.islandNext`; `globalNext` for
    timers, regulators, unfinished settles) and a tick is FOR the islands due by now, those
    a bench source on them moved, and every island sharing a supply with one
    (`islands.js` `groupOf`/`members`, ACTIVE islands only) — `dueIslands()`; null (every
    island, the old path) for one supply group, a tick for nothing in particular, a timer
    due, a coil anywhere, `SPICE_UNSCOPED`/`spice.scoped: false`. An island not due stands
    on its curves: not live, not updated or restated, its nodes told to the voltage side
    where they were last solved (`rcOf`, `nodeVoltUsed`), its chips not stepped
    (`sim/engine.js tick`'s `scope`), its readouts as at its own last tick. The end of the
    tick stays whole-desk (exact supply coupling). Shared-supply desks are tick-for-tick
    identical to unscheduled (`spice-islands.test.js`).
    **Replayed from its record** (2026-10-09, `features/02-cycle-replay.md`): at
    `enterCycle` the cycle's SCOPE is taken (`cycleScope`: its chips — those on the
    nodes' networks, the drive signature's set — and their nets, rails aside); it has
    none (every segment settled, as before) with a memory chip on the desk or a
    CONSUMER — any other chip with an input on one of those nets or anywhere in a
    voltage cluster they are in. Each segment settled records what it did to that scope
    (`settleSeg`: nets' levels, chips' state/read pins/driven/held outputs before and
    after, its drive, its settle's spike peak); a later segment whose scope stands
    exactly at a record's "before" is PUT BACK from it (`replaySeg`, never before the
    tick's first settle — the context is the settle's to build — and never while a
    scope chip still HOLDS an output change in `pending`; a record is likewise taken only
    with no scope chip holding at either end), its drive checked as a
    settle's is (else settled), its readouts noted and spikes booked. The tick's own
    moment is always settled. A whole cycle of segments replayed (or settled to exactly
    their record) is STEADY: with nothing recording (`spice.waveFrames === false`) it is
    woken a display frame at a time (`max(next segment, target + ANALOG_FRAME_S)`),
    each tick walking at least TWO cycles of segments from the one after the last shown
    (so a readout always times a rise from the one before it — one cycle and a bit read
    a frame-long period in two phases of three, fixed 2026-10-09). A counting part's state changes
    every cycle, so its cycle never goes steady (woken as before). The record rides
    each island's `analog.cycles` entry (`memo`/`steady`), carried only after a `quiet` tick (settled, not
    capped, nothing left to resettle). `spice.replay: false` is the reference
    (`tests/spice-cycle-replay.test.js`).
  - **The LCD modules** (catalog `LCD_BACKLIGHT`, `contrastPin`): the backlight is a
    junction of the solve (`backlightSpec`: the colour's LED plus the board's 100 Ω — an
    assumption, the common 1602A R8 — never overdriven or burnt), and SimOverlay's
    `#lcdPanel` hands LcdView `setPanel({backlight, contrast})`: contrast = (VDD − V0) /
    3.0 V (the HD44780U's minimum VLCD), a V0 with no voltage blank. Digital: cosmetic.
    `nodeVolts` reaches the probe's readout, the logic analyzer and the LCD panel.
- **Current — ONE model, the voltage solve** (2026-10-07; the old I_IH/I_IL-against-a-
  budget fan-out, with smoke at 2×, contradicted the solve and is gone — no `drive`,
  `outputDrive`, `MOS_INPUT_UA`, `OVERLOAD_RATIO`). Every input draws what its stages say
  (`inputStages`: a 74LS input's bias; CD4000 and family-less MOS inputs their two clamp
  diodes; a CMOS leak only when the user sets `inputLowUa` past `LEAK_FLOOR_UA`).
  **Fan-out** is then a `brownout` WARNING, never smoke (`voltages.js` `loadCheck` →
  `spice/loads.js` `outputLoads(report)`): a net whose drivers all drive one way, held
  where an input on it misreads that level although it would read it at the drivers'
  UNLOADED voltage (so a level mismatch — a 74LS HIGH into a 12 V CMOS input — is not
  one). A DRIVER is a pin the chip drives H/L right now, so a tri-state output switched
  off is none. It replaces the digital engine's `ls-fanout` (filtered out of a Spice
  Lite result). **Smoke** is current through a pin, measured: `output-current`
  (`outputLimits` — 74LS 20/100 mA, CD4000 50/100 mW; family-less parts the 74LS pair;
  a def's own `outputStage` is NOT exempt any more — the CD4049UB/CD4050B/CD4511B take
  the family's 100 mW), `switch-current` (an analog switch channel, `SWITCH_LIMITS`
  10 mA warn / 25 mA smoke, the chip OVERLOADED), `input-clamp` (CD4000 AND family-less
  MOS inputs, analog-switch controls, CD4007UB gates; smoke past 10 mA),
  `input-overvoltage` (74LS > 7 V), and `transistor-overload` (its CURRENT against its grade's
  part's rating, `limits` in spice/transistors.js; its POWER against its package's,
  `TRANSISTOR_LIMITS`: a TO-92 BJT 312/625 mW, a TO-92 MOSFET 200/400 mW, a TO-220
  1/2 W — a WARNING even at "smoke": a passive part has no status to latch). The
  CD4007UB's gate draws no `CMOS_BAND_MA` (its pair's current is the device's own).
  **Advanced fields are all real**: `sourceMa`/`sinkMa` are the family output stage's
  STRENGTH (`stageStrength` — user/default, scaling the stage like a def's `scale`);
  `inputLowUa` scales the 74LS bias's currents (its table's volts stay put). `inputHighUa` was
  removed: a 74LS IIH is a reverse leakage the solve never drew, and a field that moves
  nothing is a lie. A **family-less** part's outputs are the common `MOS_STAGE` (rail to
  rail behind 100 Ω, an assumption bracketed by SN74HCT00), never 74LS's curved HIGH.
  A **chip across two rails** that are not a supply's +/− (`offRail` `split`) drives "s"
  branches from its own pins in each of its pins' clusters (its rail-pinned pins in its
  `home` cluster), its ICC a `load` rail branch. A **PSU shorted** (+ on a − net) books
  `set / SHORT_OHMS` (0.1 Ω) — on its limit, drooped to ~0. A **short `via`** a
  transistor or switch stands only past `SHORT_AMPS` (0.1 A) measured, or with its
  supply limited, or unmeasurable (`viaShortMeter`); one with no `via` always stands.
  Supply demand (`spice/supply.js` `measureSupplies`) is every RAIL-FED
  chip's ICC (powered or not — droop must not flicker) plus the voltage solve's DRAWS
  (`report`, above; at SET volts while anything droops). Past `currentLimit` (a PSU
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
- **LEDs carry real current** (Jason asked, 2026-10-07; `features/done/spice-lite-leds.md`).
  `spice/leds.js`: one 5 mm part per colour — Kingbright WP7113ID/YD/GD/QBC-D/QWC-D, every
  number off its own sheet — as its forward-current figure's curve (Shockley + Rs, least
  squares over 7–11 points read off it: `isA`/`n`/`rsOhm`; 2026-10-08, plan Phase 4)
  solved as a JUNCTION TABLE (below), dark under `LIT_MIN_A` (50 µA), `level` = cube root
  of I over the sheet's normalising current, OVERDRIVEN past its DC rating (warning),
  BURNT once Ta + RthJA·V·I passes Tj max (red 72 mA, blue 39 mA — instant, the
  package's warm-up is not
  modelled), reverse past VR 5 V (warning). Segments and bars are their colour's LED.
  `spice/output-stage.js`: a chip output as the stage it is — 74LS a TABLE (2026-10-13,
  `table(vcc)` on the family's sides → `stage.corners`, [d, amps] from the open level;
  see "74LS stages and mixed circuits" below), each ONE-WAY (the
  Darlington cannot sink, the saturated pull-down cannot source); CD4000 a MOSFET
  saturating at 4.2/16/28 mA (5/10/15 V, CD4029B figs) behind 400/190/200 Ω — and
  between the two the SQUARE LAW those figures set (2026-10-08: `curve` on the
  family's sides; `vov = 2·R·limit`, I = limit·(2x − x²), x = d/vov — R its slope
  at the rail, so the sheet's IOL test point reads 0.93 mA, not 1). Drawn as chords
  between `CURVE_CORNERS` (tenths of vov, the first tenth halved three more times,
  the first chord on the TANGENT so a light load sees R exactly), every chord end a
  kink and a piece (`stageKinks`, `stagePiece` — output-stage.js is the ONE reader
  of a stage's shape; network.js and voltages.js call it). A `scale`/strength
  keeps the curve (same vov, current scaled); a side stating its own ohms or
  limit (CD4511B HIGH, NE555) stays two lines; below ~2 V no curve. The two lines
  met 1.7 V from the rail where the channel gives 3.1 mA of 4.2 — the old B. A
  CHANNEL (`channel: true`, 2026-10-08) that conducts either way up to its limit each
  way — one-way, a CMOS LOW let a capacitor's far plate fall 2.5 V below ground; the
  common `MOS_STAGE` likewise; a bipolar or diode-fed side says `channel: false` (the
  NE555's both sides, the CD4511B's NPN-follower HIGH, the 4047's RC COMMON pull-up);
  a def's own
  `outputStage` (`volts`, `ohms`, `limitMa` table, or a `scale` on the family's) for the
  NE555, CD4511B, CD4049UB/CD4050B; family-less parts take `MOS_STAGE`. The LEDs are junction
  branches of the ONE voltage solve (`spice/lamps.js` only reads them off the desk,
  `lampTopology`, and `sourceVolts`); their verdicts come from `report()`'s junction
  currents at delivered volts (so droop dims), and burning opens the LED and re-solves
  until nothing more burns; the set rides `analog.burnt` (run-volatile, NOT the document
  — Stop's `analog = null` restores it). The diode/Zener junction is `spice/diodes.js`'s
  common silicon one (the 1N4148 vendor card's DC curve — Is, n, Rs, IKF — as a table;
  a Zener backwards at its `zenerVolts`), burning the same way (`diode-burnt`) —
  SimOverlay's `#updateDiodes` reads it. A 1 GΩ leak per junction and GMIN keep a
  floating net defined.
  - **A junction is a TABLE** (`spice/junction-table.js`, 2026-10-08, plan Phase 4):
    its exponential sampled at currents a factor 2 apart from 1 µA to 4 A, joined by
    straight lines, running to zero along its first chord below and on along its last
    above — still monotone and piecewise linear, so Newton and the corner machinery are
    unchanged, and every sample is a CORNER (`junctionPiece` in `pieces`: one letter
    per segment; a junction against a fixed far side kinks at far ± every sample).
    The line strays from the curve by ≤ 0.06·n·Vt (a few mV). Both decks express it:
    "same" as ngspice's `pwl()` (which also runs on along its end segments), "device"
    as the curve itself (`D(IS N RS)` per LED colour, the 1N4148 card). A device's
    fragment in `pieces` ends in `|`, so a variable-length one never reads as another.
    `newtonSolve` reads device slopes a microvolt UP, and when that step gains nothing
    tries them read DOWN (`deviceSlope`'s `side`): a transistor parked a hair under its
    knee read upward is ON, and the step that asks for only made things worse (a relay
    coil switched off, its base stuck at 0.65 V, never converged). Result `lamps` (key `c4` / `c5#a`,
  `junctionKey`) rides
  `chiphippo:sim-state` (NULL on the digital engine); SimOverlay's `#verdict` uses it
  over the junction rule and hands views `setLevel`/`setSegmentLevel` (`--led-level`,
  rounded to 0.05; the 3D view reads it too — `lampLook`, see "3D view"). Warnings `led-burnt` (once),
  `led-overdriven`, `led-reverse`, toasts keyed `led:<comp>`. **No part shows a current
  of its own — only a PSU brick its draw; the PROBE reads current** (Jason, 2026-10-07):
  the solve's `currents` (hole address → amps through the lead in it, summed signed so a
  shared lead — a display's K, an rnet9's COM — is right) rides sim-state;
  `SimOverlay.currentAt(address)` (a PSU terminal answers its supply's amps) and the
  probe's readout adds `currentText` (µA/mA/A, `probe.microamps|milliamps|amps`) for the
  hole it is on. Decided: the burn stays INSTANT at Tj max; the LED numbers are NOT
  user-editable; an LED never damages the chip driving it (the output's own limits do —
  `output-current`). Not modelled: LS sink saturation past IOL.
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
  to two places. The Δ-ms readout is each column's own simulated moment
  (`ScopeRecorder` keeps the sim-tick's `at`; `atOf`), so frames and wakes cost it
  nothing (2026-10-10 — it was ticks × the fastest clock's half-period).
- **Analyzer x axis — Timing | Transitions** (2026-10-13, no feature number; the
  shelved oscilloscope stash was dropped and NOT reused). The tick-index axis
  (`PX_PER_TICK`) is gone; `model/scope-axis.js` (pure) places the same recorder
  columns two ways, chosen by the header's `buildSegmented` picker and kept in
  `settings.scopeAxis` (default `"timing"`, `normalizeAxisMode`). The analyzer samples
  on the ENGINE's events only (sim-ticks: edges, inputs, wakes, and the display frames
  `#emitFrames` sends while the analyzer records) — it has no clock of its own and
  cannot have one (the curves live in the Worker). So:
  - **Timing**: x = `at` (`columnTimes`, monotonic), `PX_PER_DIV` 100 at a 1-2-5
    `SEC_PER_DIV` ladder (100 ns – 5000 s); `#secPerDiv` null = Fit (`fitSecPerDiv`,
    the default, session-only once zoomed), floored by `minSecPerDiv` so the track
    stays under `MAX_TRACK_PX` (16 M px). −/+/Fit and ⌘/Ctrl+wheel (anchored at the
    pointer, `#anchor`). The right edge is `#now`: SimController's sim-state now
    carries `at` (`#shownAt()`, null when stopped/replaying). A voltage is joined
    straight to the next sample only when it is ≤ `JOIN_S` (1.5 frames) away
    (`joined`); otherwise held and STEPPED there — frames stop once every node is
    within the gap, so a longer silence means it had arrived (a switch thrown after a
    quiet second was a 1 s ramp under a plain straight join).
  - **Transitions**: a column where any DRAWN channel moved gets `SLICE_PX`; a
    volts change is judged against the value last SHOWN (not the previous sample) by
    `gapPercent` of the full scale (`setSpiceLite`, live from Settings), so a creep
    under the threshold adds up and still shows; levels/bus words by identity. Runs of
    unchanged columns fold to 0 px; only a fold longer than `MARK_STEPS` (4) × the
    median sample step keeps a `BREAK_PX` titled break (`.scope-break`, `scope.folded`)
    — marking every fold combed the lanes on a creeping RC.
  - **Drawing is windowed**: `.scope-track` carries the full width; the svg is the
    visible stretch ± one viewport (`#win`, its viewBox at the window's x), redrawn on
    a scroll past it; off-window x is clamped (`#xOf`) so each lane stays one path.
    Export is the whole track up to `EXPORT_MAX_PX` (16 000), else the stretch on
    screen.
  - Found while verifying, FIXED 2026-10-13 (SimController, not the engine): a switch
    thrown after a quiet stretch (no ticks since Run) jumped an RC node as if it had
    charged since the previous tick — cap-electrolytic's Timer: flip at 2.98 s read
    4.75 V at once (= 5(1−e^−2.98)), the Schmitt tripped immediately. The engine
    catches a late tick up on the board it is HANDED, and an edit handed it the
    edited one. `#onDocChanged`/`#onPartState` now call `#runOnTo()` after
    `#catchUp()`: under Spice Lite the OLD board (still `#base`) ticks at the edit's
    moment, owed not published (its sim-tick still goes out), before
    `#forgetDocument`; `#partStateVersion` is bumped after it so the bounce does not
    read the old board as a contact move. Held by `sim-controller-timing.test.js`
    ("a switch thrown after a quiet stretch"); `lamp-average-bounce.test.js`'s
    `afterEdit` skips that run-on tick.
- **A gate biased into its linear region** (`spice/linear-bias.js`, 2026-10-08, plan
  Phase 5): an inverting, non-Schmitt gate unit (INV/NAND/NOR) whose output a RESISTOR
  ties straight to one of its own inputs (`selfBiasedGates`, per netlist) is an amplifier
  on a bench, half way up its transfer curve — out of scope (Jason, question 10). When
  its input is left X or Z at a tick's end it is said as `linear-bias` (`{chip, pin}`,
  its output; SimController's toast keyed `bias:<chip>`), and the `oscillation` on its own
  nets / the `floating-input` on its own input pin that its loop raised are dropped
  (`linearBiasWarnings`). A Schmitt part's loop is an oscillator, and is left alone.
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
- **Switch bounce** (2026-10-13, `sim/bounce.js`; `spiceLite.bounce`, Spice Lite only,
  read at Run): a def with `contactBounce` (sw-slide, sw-push, sw-toggle, the DIP banks)
  whose contacts CLOSE bounces — `ContactBounce.watch` compares each switch's
  `internalBridges(params, partState)` with the last seen (only when the snapshot or a
  part-state changed: `#contactsSeen`, `#partStateVersion`), a first sighting only
  remembered; an opening is clean. `bounceIntervals(compId#moves)` (seeded: the same
  press bounces the same way) gives the open gaps from t0: a 0.15–0.4 ms travel, then 3–6
  touches, all inside `BOUNCE_MAX_S` 3 ms. In a gap the switch keeps only the contacts both
  positions share (`gapContacts` — a slide switch's old throw never re-makes), via a
  partState `{contacts}` that `buildNetlist`'s partition honours in place of
  `internalBridges`; `#bounceNetlist` builds one per set of gaps, and `#nextEvent` adds
  each make/break as an unclamped wake (no `MIN_SHOWN_S`). `#base` is the snapshot's own
  netlist (what `#circuit` used to double as); `#forgetDocument` drops `#base`,
  `#bounceNets`, `#contactsSeen` and `#lampJunctions` (a test's fakeDoc returns ONE
  object, so identity alone is no key). A bounce tick's board carries `ownNetlist: true`
  on sim-tick and sim-state, and the Worker host forwards that netlist instead of nulling
  it (sim-host only substitutes its version's netlist when `!ownNetlist`) — split nets have
  ids the main thread's netlist doesn't. Not exported across a Worker hand-over (a bounce
  in flight just ends). Tests: `lamp-average-bounce.test.js`.
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
- **The speaker** (2026-10-13, no plan; `catalog/speaker.js`, `spice/speakers.js`,
  `spice/measure.js` `noteTone`/`toneOf`, `components/speaker-audio.js`). A discrete
  (`def.speaker`, COMPONENTS ▸ Audio, footprint [0, 3], `impedance` 8/16/32 Ω +
  `volume` % + `rot`). **R turns it a quarter lap about its + leg** (`def.turns`,
  Jason 2026-10-14: its 0.3-in legs are the channel's width, so on end it straddles the
  trench e↔f): `rot` 90/180/270 stored only when set; occupancy.js `partPinHoles` gives
  pin 2 as `rotateOffset({dx: 3, dy: 0}, rot)`; seating.js seats it as a can is seated
  (`rigidSeat`, the span turned — `turnedSpan`); `rotateComponent` steps to the next
  quarter it can take, pin 1 fixed; the drawing places the body's centre turned and every
  word upright (`buildSpeaker`, `turnedBox`), and so does 3D that is a RESISTOR of its impedance to the solve (`weakBridges` third
  element — the param is `impedance`, not `ohms`, because `properties.field.ohms` reads
  "Resistance"). Inductance left out. `noteReadouts` (every settle and replayed
  segment) samples `voltsAt(a) − voltsAt(b)` per speaker into `analog.tones` with the
  readout's drawn-cycle `scale` — and `noteSpeakersBetween` (2026-10-14) samples it
  BETWEEN settles too, along the curves its nodes ran on since the last one (`ranFrom`,
  kept as that settle left them; the last tick's at first): every eighth of the fastest
  ringing, ≥ `SPEAKER_SAMPLES` 16, ≤ 256 — read at settles alone a sine through a
  coupling capacitor was read at its clock's edges, its slope's zeros, and played nothing
  at 440 Hz; HIGH/LOW past the middle of the swing ± `TONE_BAND`
  (20 %), the swing = last whole cycle's extremes (widened as it goes; re-measured from
  scratch once `STALE_PERIODS` pass with no rise, so a quieter tone is heard again).
  Sampling at settles catches every driver edge, even where an RC node's jump lands
  after the settle (the alternation is what counts). `clearMarks` clears tones with the
  island's marks — only the speakers ON that island (2026-10-14: one on a logic island of
  its own fell silent for two periods whenever another island's cycle started or ended);
  on a desk of one analog island it still clears every tone, as it clears every mark. Result `tones`: id → `{hz, vpp, watts = (vpp/2)²/Z, volume}`; an
  out-of-scope island's speaker carries `analog.sounding` from its last tick.
  SimController publishes `tones` only while RUNNING (not stalled/deciding);
  `app.js`'s `SpeakerAudio` plays a square OscillatorNode per speaker at hz × the
  run's speed, gain `speakerLoudness` (√(W / 25 mW) × Volume) × `MASTER_GAIN` 0.2,
  20 Hz–20 kHz only, a missing tone held `HOLD_MS` 150 then faded, the context
  suspended when nothing plays. The cone shows the pitch (`.part-speaker-hz`, the
  circuit's Hz, not × speed, blank while silent), the hover says "Playing N Hz", the
  ring lights (`part-discrete--playing`). Matches the 555's own measured readout exactly at
  456 Hz (stepped), 4.6 kHz and 20 kHz (drawn). Pre-existing, not the speaker's: a
  555 at ~45 kHz into an RC-coupled load warns `oscillation` (never becomes a cycle).
- **`spiceOnly` PARTS** (2026-10-13): a def flagged `spiceOnly: true` (the speaker,
  the electronic load, the AC supply, the transformer) is left out of the palette while Spice Lite is off
  (`palette-panel.js` `#engineShown`, re-rendered by `setSpiceLite`); a filter that
  matches one says to turn Spice Lite on (`palette.spiceOnlyHint`). One already on a
  desk stays. Tests: `spice-speaker.test.js`, `speaker-audio.test.js`.
- **The AC supply and the transformer** (2026-10-18, no feature number, branch
  `ac-timebase`; `catalog/ac-parts.js`, both `spiceOnly` bricks in COMPONENTS ▸ Power,
  ids `ac<n>` / `xfmr<n>`, their counters `nextAcId`/`nextTransformerId` stored only
  once used, like the load's). To the logic engine each is NOTHING (no net driven or
  grounded, a brick's terminals never bridged) — so engine-parity exempts the four
  example desktops (`AC`), and `tests/spice-ac-examples.test.js` is their proof.
  - **The AC supply**: L is a sine about N. `params` `{hz, peak, trough}` — Output
    preset 12/24/120/230 V~ (RMS; `acPeakOf` = √2·RMS to 12 figures) or Custom… peaks
    (`AC_PEAK_RANGE` above 0, `AC_TROUGH_RANGE` below — the value parser reads a SIGNED
    field when its range is below zero: `-`, `−` or `–`, and an unsigned entry in a
    below-zero range is read as negative; `formatComponentValue` prints `−`), Frequency
    50/60 or Custom… in the clock's range. `acBadge`: "12 V~" / "±1 V~" / "+5/−3 V~".
    N is a − rail under Spice Lite ONLY (`sim/engine.js buildContext` adds it to
    `supplyMinus` when `hooks`; `sim/rc-trace.js` counts it a − rail too), which is why the
    settle index has a third variant: `fixed.groundedIndex` (`indexOf`'s `acGrounded`),
    since the index records which nets are rails and the logic engine's context (a
    `prepareCircuit` base) has no AC ground — sharing it parted the incremental settle
    from the full one on the Zero crossing desk (found and fixed 2026-10-18). L is a
    WAVE node (`analyze`'s `waves`, `ac: true`, `acSwing`: never clipped, floor/ceil
    ±∞) whose generator is `acGenerator(swing, hz, t)` — a function of simulated time
    ALONE, no square, no `clockTimes`, so nothing ticks the desk at its half-cycles;
    each piece ends at the next `AC_PIECE_S` (¼ s) boundary. `waveKinds` carries
    `{swing, hz, ac, shift}` so a mid-run Output edit jumps from the old sine; a
    FREQUENCY edit does not (2026-10-18): `acShift` (turns, `acShiftAt`) is set at
    the edit's tick so the phase carries on where it stood — hz·t from Run jumped it
    up to 2× peak, through every coupling capacitor. With N UNWIRED (`acSupplies`:
    a terminal alone on its net is null) L drives nothing, as a clock with no ground.
    An AC wave's display frames take its own period (`sample.js`, `waveKinds`), not
    a clock's square.
  - **The 74LS input's clamp diode** (`TTL_CLAMP`, `TTL_CLAMP_STAGE` in params.js — a
    junction table sourcing into the pin from its ground; 18 mA warns, 50 mA smokes, an
    assumption: the sheets give the clamp no rating). Reported as `input-clamp` with
    `max` the clamp's figure (SimController's toast comment covers 74LS now; its locale
    wording "outside its supply" holds for a pin below ground).
  - **Wire-time warning** (`model/ac-wiring.js` `acIntoLogicInputs`,
    `components/ac-wiring-monitor.js`, wired in `app.js`): a net an AC supply's L or a
    transformer terminal is on (not a rail) holding a logic chip's input/io/clock pin —
    not an op-amp's, a regulator's, an opto's, or an analog switch's channel — is a
    `desk.acInput` warning toast keyed `ac-input:<source>:<chip>:<pin>`, said once while
    it stands and again when made anew. A load baselines quietly — at the
    `doc-changed` AFTER `desk-loaded` (`#quietNext`), since the shared NetlistCache
    still holds the replaced desk at `desk-loaded` (a tab switch toasted every
    standing connection, 2026-10-18) — and so does the constructor (the launch desk
    fires no `desk-loaded`). An undo that puts one back says it again. The toast
    names a brick by `partTitle`. Through a resistor/diode/capacitor is not
    followed.
  - **The transformer** (`params` = `TRANSFORMER_FIGURES`: turns, primaryHenries,
    primaryOhms, secondaryOhms, coupling 0.5–0.999 — never 1, a singular L matrix;
    Rating presets 120→12/9/5, 230→12/5, ~12 VA, coupling 0.99, assumptions).
    `spice/inductors.js`: TWO coil branches `<id>p`/`<id>s` (`transformerWindings`: L2 =
    L1/n², M = k·√(L1·L2)), each carrying `couple: {id, henries: M}` only while both are
    wired; `runGroup`'s E puts M off the diagonal (symmetric), both windings forced into
    ONE dynamic group (`#coil<id>` union), the coils' energy ½·iᵀLi. Each winding is
    shunted by `TRANSFORMER_SHUNT_OHMS` (10 MΩ — an open winding otherwise made the system
    so stiff its magnetising mode was lost to rounding) and P2–S2 by
    `TRANSFORMER_INSULATION_OHMS` (1 GΩ, so a floating secondary has a voltage)
    (`transformerResistors`, solved as resistors in voltages.js). A winding whose two
    ends share a net (S1 jumpered to S2) is STILL a branch, coupled (`inductorTopology`;
    `shortedInductors` skips transformers): dropped, a shorted secondary left the
    primary drawing only its magnetising current (2026-10-18). An `inductive-kick`'s
    joules count a winding's partner wherever it is solved (P2 on a rail parts the
    two clusters). Matches the phasor
    answer to ~0.002 % (`spice-transformer.test.js`). A lone brick terminal has no
    `nodeVolts` — probe a board hole.
  - **Exports**: KiCad draws the AC supply as a 2-pin `AC IN` header (J, like the
    PSU; its pins PASSIVE) and the transformer as a 4-pin `generic` header (T, like
    the relay) — left out, `dropLoneNets` NC-flagged every lead wired only to them,
    and the AC supply's J designator left a gap on the sheet (2026-10-18). Only the
    load is `KICAD_LEFT_OUT`. Digital leaves both out. `kicad.js` `dropLoneNets`
    re-applies the "a pin alone on its net is a no-connect" rule to the sheet's own
    parts, or a resistor whose other lead met only a left-out part carried a dangling
    label (ERC `label_dangling`).
  - **BOM**: both are `power` lines (they were missing from the BOM entirely until
    2026-10-18), keyed and titled by `acBadge`/`transformerBadge` with `exact: true` —
    every figure, so two Custom… supplies a hertz apart, or two transformers of one
    ratio, are two lines; the desk's badge keeps three figures.
  - **The analyzer below 0 V**: `ScopeRecorder` keeps each channel's `rangeOf` (lo/hi,
    widened only, reset on Run); `laneSpan(fullScale, range)` widens a lane at a 1-2-5
    step (`niceCeil`) below 0 or above the full scale, never narrows; ScopeView draws a
    dashed `.scope-volts-zero` line in a lane reaching below 0 V.
  - **A regenerative corner is settled like a crossing** (spice/engine.js, the corner
    loop in the event loop): a corner at which a Schmitt-wired op-amp swings to its other
    rail calls `detectFlips(t)`; a listener it flipped is `touched` and the loop restarts
    (`continue outer`) — without it a pin reading the op-amp's output saw the flip only
    at the next event, and the 74LS90 counted some Schmitt flips half a cycle late.
    Such a flip spends its island's event budget as a crossing does (`bump`, `capped`,
    the catch-up budget), so a Schmitt chattering at a corner is capped and backs off. An
    op-amp's INPUTS are no listeners (`spice/listeners.js` skips `def.opAmps`): a
    crossing of a logic threshold there is no event, and listening woke an AC comparator
    twice a cycle for nothing.
  - **Known, not fixed**: a bridge rectifier on the transformer runs ~8 s per simulated
    second (every diode-table corner wakes a tick), so no rectifier example ships; four
    bridge diodes burning at once leave the winding current in its shunt for a moment (a
    megavolt spike in that tick's readout). And a STRESS LIMIT is no corner: an input
    past 7 V or a clamp past its rating between two ticks is only seen at a tick —
    found when the Clipping example's Zener shipped with no `zenerVolts` (a plain diode,
    17 V on a 74LS14 input, and no tick in the positive half ever said so; fixed in the
    demo, 2026-10-18, and its test reads the clip at the peak).


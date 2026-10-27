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
  - "src/web/scripts/components/adapter-view.js"
  - "src/web/scripts/components/scope-ground-marker.js"
  - "src/web/scripts/sim/floating-grounds.js"
  - "src/web/scripts/tests/ac-adapter.test.js"
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

Spice Lite's notes are FIVE rule files: this one (the engine — every net a voltage,
clock waves, the seam and hooks, time, closed-form nodes and groups, inductors,
listeners, silicon, cycles, current, LEDs, spikes, switch bounce); `spice-reviews.md`
("Spice Lite reviews & appraisals" — the 2026-10-21 review and appraisal, what each
changed in the group machinery and why); `spice-analyzer.md` ("Spice Lite and the
analyzer" — voltages in lanes, Analyzer x axis, curve samples, cycles drawn true);
`spice-grading.md` ("Graded against ngspice" — the golden suite, the deck, the 74LS
stage tables, the graded areas); `spice-ac.md` ("The speaker, the AC supply and the
transformer" — the speaker, mains, the adapter, the transformer, the bridge rectifier,
floating grounds, the op-amp in time). Split 2026-10-23 at ~149k characters; a new
note goes in whichever file its topic is in.

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
  - A net is HELD when a resistive path (resistors, channels, conducting transistors,
    and a junction only while it conducts past `CONDUCTS_A` — 2026-10-19: before, never
    a junction, so a rectifier's output had no voltage at all) reaches a fixed net or
    an active output; only a held net has a
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
    an op-amp's or comparator's INPUT (`def.opAmps` units' inp/inn, a reader marked
    `analog`) is read for its own logic but has no say in it (2026-10-26: on ±5 V an
    LM358's input on ground read H beside a 74LS input's L — ground showed X), so a net
    only such inputs read shows its digital level;
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
    busy fixture, now ~6). A new netlist or config starts fresh — **guessed from where
    the last side left each net** (`seeds`, after `warm` and `loose`; the fourth regrade,
    2026-10-22): from mid-supply, a capless op-amp Schmitt held HIGH in its band fell LOW
    at any edit, however unrelated. `mode: "full"` keeps the
    old whole-desk solve at each tick's start as the REFERENCE, and
    `engine-incremental.test.js` holds the carried path to it EXACTLY (deepStrictEqual,
    voltages and the snapshot included) — which needs `loose`: an UNHELD net's last
    solved voltage, kept as its next guess, so re-solving an unchanged network takes no
    Newton step instead of landing on fresh noise (a floating segment anode is solver
    noise to ~1 V). A MOSFET gate going held ↔ floating re-solves its users even at the
    same voltage (its report's `held` changes). Wire drops / PSU droop moving by
    ≤ `DROOP_EPS` keep their old value — replaced each tick, a microvolt change altered
    every chip's vcc, hence the plan signature, hence a whole-desk re-solve. While a cycle
    is DRAWN, a value already read during it is no move either (`swingOf`, `analog.swing`,
    `SWING_KEPT` 8; the regrade, 2026-10-22): a tick ends in whichever phase it lands on,
    and a 555 drawing 120 mA in one phase read its wire drop 1.17 mV / none at alternate
    ticks, each ending the schedule. **Only while nothing OUTSIDE the drawn islands moved**
    (`outsideMoved`: a net on no drawn island read off `warmStart` against this tick's
    levels) — a load switched on beside a drawn 555 and off again took the supply back to
    a value the swing had seen, and the move was hidden.
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
    (Since 2026-10-27 a chip in its MARGIN — under its range, over `supplyFloor` — is
    `ok` with `margin`, so it is evaluated and its stages and inputs solved like any
    working chip, not held: a clocked 74LS04 fed through 100 Ω at 4.6 V follows its
    input. Under the floor the held-stage rule above stands — simulation.md "the margin";
    an OFF-RAIL chip held there keeps its input stages in the solve (`makePlan`'s
    `inputsOn`): a 74LS input is R1 and a diode from its own VCC, a CMOS input its
    protection diodes, passive whatever the logic does — dropped, a 74LS04 lifted to 4.497 V
    by 100 Ω in its ground read that ground +17 % against ngspice, round 2B, 2026-10-27.)
    At SET a clock brick's HIGH is its supply's SET too (`makePlan`'s `clockPsu`): booked
    at the drooped HIGH, a clock into an LED on a 10 mA supply flipped it between 1.73 V
    and 5 V every tick. Fixed 2026-10-14 in the report: a branch between two UNHELD nets
    (reached through junctions alone — the middle LED of a series string, a resistor
    between two) is reported where its cluster balanced and it carries more than
    `BOOK_FLOOR_A` (it read dark beside its lit neighbours, never judged for overdrive or
    burning); an input pin's lead carries its own stages' current (a 74LS input's bias,
    a CMOS clamp; an off-rail chip's input "s" branch books its pin AND its ground pin —
    a 74LS bias drawn from its ground since phase 7c, 2026-10-27, so an off-rail chip's
    supply pin carries ICC and its outputs' current as a rail-fed one's booking does;
    its upper clamp still from VCC) — still no draw, inside ICC; a display's bridged commons (`internalBridges`, the
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
    pieces on a geometric overdrive grid (every 30 % since the grade, 2026-10-23 — it was
    10 %: a gate on a wave crosses every piece twice a period, each a re-linearization;
    10 kHz sine 160 → 100 s per simulated s, a gate charging through 1 MΩ switching 0.5 %
    late against ngspice, 0.3 % at 10 %) and tenths of its linear region — a square law
    is not straight. Breakdown per grade (`vceoV`/`vbrV`). A device
    CONDUCTS (holds a net) past `CONDUCTS_A` of transport current, or a gate past VTO
    by more than `CONDUCTS_OV` (1 mV, phase 7 2026-10-27: a MOSFET wired as a diode with
    nothing to feed it was solved at VTO + 40 µV and held there read 2.1 V, ngspice 0 —
    now it holds nothing).
    A MOSFET's gate is fixed from wherever its net is solved and KEEPS its voltage
    when floating (`settleNet`, `gates`) — `held`. **A gate on a network that MOVES
    between events is JOINED to its channel's network** (`voltageTopology`, the grade,
    2026-10-23 — as an op-amp joins its inputs): a net with a capacitor on it, an
    inductor's, a clock brick's out (every clock — a param edit may not rebuild the
    netlist), an AC source's, to closure (a drain that now moves moves the gates it
    drives). Told its gate only at a settle, a gate charging through 1 MΩ into 1 µF never
    switched (nothing woke the desk), and a 10 kHz trapezoid/triangle/sine on one ran
    its channel as a square — a boost converter at 63 % efficiency for ngspice's 83 %.
    Joined, the gate is a net of the group the moving network runs as: the channel's
    pieces are its corners, its drain is read by crossings (`spice-grade-fixes.test.js`:
    0.588 s for ngspice's 0.586, the waves within 0.3 %). A gate a chip's output drives
    stays a voltage it is told (`gateUsers`), as before. Cost: a gate on a wave pays a
    corner per piece — 10 kHz ~100 s per simulated s, 1 kHz ~6; no shipped example has
    a discrete MOSFET. Discrete ones report
    `transistors` (`{on, held, amps}`), which SimController's `#shownChannels` puts in
    place of the digital `channels` it publishes (the result's own `channels` stay
    digital — parity). The CD4007UB's six are `"m"` devices. EVERY discrete one (`topo.
    selfControlled`, 2026-10-14) has its base or gate answered by the `input` hook from
    whether the solve has it conducting (`volt.selfControl`; OFF where the solve left a
    net of it holding nothing — solved, unheld, `loose` — phase 7: read there as unknown it
    fell back to the net's digital reading, switched its channel in the logic engine and
    moved the plan back, held/unheld every pass to the cap, an NPN/PNP latch on a 5 kHz
    triangle; re-read when a solve turns
    it, as a reading is) — its CHANNEL alone (`deviceConducts(dev, vAt, true)`, the
    regrade, 2026-10-23: read with its body diode, a half-bridge's off low side
    freewheeling a coil joined the rails through the on high side, a short and a
    conflict ngspice never shows) — never at its net's digital level: read there, one feeding its
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
    up the same way in both engines. Kept only if it lands on a stable balance. (With an
    op-amp in it, its outputs are first held at their swing's edges — the one each came in
    at, then the one the mode heads for: `heldFall`/`swingFall`, "The swing in the solve"
    below.) The
    memo of a BJT's answers (`bjtCurrents`) is bounded by ANSWERS (4096 a model), not by
    VBE: one held off at one VBE with its collector on a capacitor's curve grew one VBE's
    map 0.8 MB a simulated second.
  - Chip power: a chip NOT straight across the rails (`railFed` false) gets its status
    from the new `chipVolts` hook — V(VCC) − V(GND) from the last solve (`fedStatus`); the
    resettle loop runs again when that moved. Rail-fed chips are the digital rule exactly.
    **A supply pin nothing outside the chip reaches** (VCC, GND or a CD405x's VEE on a net
    with no rail, terminal, other part's lead, meter probe or flag — `voltageTopology`'s
    `offRail.floats`) reads 0 V across it, UNPOWERED as in the logic engine (round 2,
    2026-10-27: solved, a CD4069UB's protection diodes lifted its floating ground to
    0.5 V under VCC, "underpowered at 0.50 V"). **An off-rail chip's OPEN inputs** — a
    node nothing touches but its own input stages — are left out of the network with
    their stages (`openInputs`), as an open input of a chip across the rails has no
    voltage: kept, a 74LS04 whose ground a 100 Ω lead lifted, input 1 on the supply's −,
    stranded five of them under that ground, unbalanced, 10.4 % low against ngspice
    (golden `*-minus-ls04-input-below`, `spice-offrail-round2.test.js`).
  - Retired under Spice Lite (filtered, `RETIRED`): `ls-fanout`, `marginal-high`,
    `mixed-supply`. `ctx.limitsLed`'s LED rule is still computed (strongLevels are a parity
    field) though nothing under Spice Lite reads it.

- **Clock waves** (2026-10-09, `spice/waves.js`, no plan): a clock brick's `wave` param
  (`CLOCK_WAVES`: square · pwm · triangle · trapezoid · ramp-up · ramp-down · sine,
  stored only off square; `waveOf` is square for a manual clock). **`LEVEL_WAVES`**
  (square, pwm) are LEVELS in BOTH engines — a PWM is the square with unequal halves
  (`duty`, 1–99 %, stored only on a pwm off 50; `dutyOf`; the schedule's halves,
  `.claude/rules/simulation.md` → "Batched ticks") and never a node here (`analyze`
  skips it). **A level clock DRIVES its net behind `CLOCK_OHMS` (50 Ω, a bench function
  generator's — wave 2b, 2026-10-27, Jason)**, a stage (spice/output-stage.js
  `clockStage`, a channel both ways): voltages.js `clockStagesOf` adds it to a network's
  drivers and a lone net's stages, `fixedOf` holds a net outright only for a FLAG or a
  wave (`sourceLevel(list, true)`, `sourced`), and `clockFlow` books its current to the
  supply on its `vcc` (sinking, through its `gnd`). Ideal, its edge through 10 µF drove
  6 A into a 1N4148 clamp and burnt it; now 0.1 A. The deck writes the same (`VK` on an
  inner node, `RK` 50 Ω). A WAVE is still an ideal source. Moved: 17 examples' clock
  nets by 11–23 mV (a 74LS input's current through 50 Ω), no level or warning; the golden
  `coupled-stages` and `waves` square cases regenerated. The Wave select is no longer `spiceOnly`; its OPTIONS are, bar the levels
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
  SimController); else **walking its phases** (`walkingFrame`, sample.js, the regrade,
  2026-10-23): an ODD number of sixteenths of its period, at least `WALK_FRAME_MIN_S`
  (4 ms), at most `ANALOG_FRAME_S`, on a lattice from the run's start (a wake between
  two — a corner of what it drives, once a period — leaves them walking). Framed every
  `ANALOG_FRAME_S`, two periods of 60 Hz, an LED on a 60 Hz adapter was read at the zero
  crossing every tick: dark, cool, never warned; 50 Hz three fixed phases. Now every
  sixteenth in 16 frames, five or six a display frame for `LampAverage`: a 1 kΩ LED on
  12 V~ glows 0.43 (0.44 read every 50 µs), and 47 Ω overdrives and burns it. 60 Hz is
  5/16 (5.2 ms, ~190 ticks/s for an island nothing else wakes) — DISPLAY frames, no
  wakes since 2026-10-09 (below, "Display frames"). The stages ON a running wave are no corner
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
  `reread`, `busy`, `pass`, `maxIterations`, `psuVolts`, `chipDrop`, `chipVolts` (and
  `clockVolts`, answered for a clock brick off the rails — read once sim/engine.js does).
  Absent = today's engine byte for byte. It never re-implements a settle; a Spice Lite
  tick is several digital ticks with the analog side between, on the desk's own document
  (phase 7c, 2026-10-27: no stand-in supply for a meter in a supply's lead any more — its
  shunt is a resistor of the solve, the rail past it a HUB, meter.md).
- **The oracle**: `tests/engine-parity.test.js` runs every shipped example desktop through
  both engines, 24 ticks, every shared result field deep-equal. An example Spice Lite is
  MEANT to run differently is exempted WITH its reason (today: the three NE555 desktops —
  `SILICON`); on a desk with a silicon part, THAT part's `state`/`pinLevels` and the
  desk's `iterations` are not compared (its state is its silicon's).
  **A wired-AND with an unknown output** — once the one ALLOWED disagreement (Jason,
  2026-10-10); since 2026-10-22 (Jason: "I want the right outcome") the logic engine
  reads it LOW too, through a may-sink driver level (`OC_X`, sim/levels.js; chip-eval.js
  `driverLevel`, logic engine only — `maybeSinks` false under hooks). Under Spice Lite
  the digital solve still makes it X + `conflict`, and Spice
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
  until the settle gap (`GAP_PERCENT`, fixed at 1 % since 2026-10-23) says arrived — and a step under
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
    due. The frames are the desk's REDRAWS, not the analyzer's sample rate (since
    2026-10-23 — "Analyzer x axis" → curve samples): `#emitFrames` steps through them
    and reads the analyzer's curve up to each.
    **A desk come to rest is shown where it rests** (2026-10-22, the fourth regrade):
    frames stop once the settle gap says every node has arrived (1 % of its step), so
    the last one stood for good — 1 kΩ charging 1000 µF from 5 V read 4.95 V from 4.6 s
    on. A batch in which `#frameAt` went null owes one more publish, and `#publish`
    with `#frameAt` null (and no chatter) samples with `{arrived: GAP_PERCENT}`: each
    arrived node and coil reads its `finalValue` (rc-curve.js — the asymptote or its
    corner, a coupled group's final value; a ramp has none). The analyzer's frames are
    never read so. A HELD supply (`analog.free`) reads its + node less its − in every
    sampled publish — read at its last tick, its readout trailed the rail it held and
    stood short of it at rest.
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
    inductor's) through complex modes (`complexPrepare`, still closed form), and e^A
    (`kind: "system"`, Padé 13) only where modes cannot be told apart (`MODAL_COND`). A coupled curve ends at its group's CORNER IN TIME
    (`tEnd`: `piecesAt` — every net carried along the solve's affine map — sampled over
    the time constants and bisected); `rc-curve.js` reads both kinds (`isCoupled`,
    `heading(curve, t)` — at a corner, the way it was going), `firstCrossing` samples
    them (`sampleTimes`, `searchEnd`) — a ringing one (`scale.osc`) every eighth of a
    period for its first `RING_SAMPLES` (256 periods; 50 until 2026-10-21), and `firstRoot` looks at the crest between
    three samples that rise and fall short of the level (the parabola through them):
    a grid a radian or two apart missed one crossing in six near a Q-50 ring's crest
    (2026-10-14). A common mode is balanced on the TRUE networks
    first (`balance`: bracketed then Illinois on `volt.currentsAt`) — balanced on a
    linear piece it jumped past a clamp or a saturating stage and back, forever. Two or
    more modes are balanced TOGETHER first (`balanceTogether`, 2026-10-14: Newton on the
    modes' residuals, slopes read `BALANCE_SLOPE_V` apart, steps halved until they gain —
    at most `BALANCE_HALVINGS`, 10, since the regrade of 2026-10-23: at a fold the
    Jacobian is near singular and 30 halvings of a step that never gains were most of a
    regenerative MOSFET pair's run, 88 s a simulated second, now ~9; the residuals read
    through `volt.currentsReader`, one `networkShape` a cluster kept for the balance),
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
    **A group's columns are read in ONE piece** (2026-10-19, `linearizeGroup`'s
    `entered`): each state is nudged the way it heads, but where its own nudge lands in a
    piece further from the one the states enter TOGETHER (all nudged at once, each in
    proportion to its rate — `runGroup`'s `rates`, rc-curve.js `rateOf`) than the other
    way does (`sharedPieces`, place by place), it is read the other way. Read alone, a
    7805's OUT tracking its target within microvolts read the regulator OFF while its
    rising IN read it ON — OUT driven by IN with nothing to stop it, a corner the pieces
    never showed, OUT at kilovolts. A lone state's nudge IS the joint one. **A run-on**
    (the stuck-corner run, below) never carries any RC node more than `RUN_ON_V` (1 mV)
    from where it starts (`movesPast`): a regulator re-entering its limit after 15 µs out
    of it, or a bridge's diodes cutting off, counted as "stuck" and ran on hundreds of
    volts past where the true network stops. (Tried and dropped: requiring the last piece
    to be under 1 ns, and ending a run-on at a piece not among the recent ones — each
    broke the AC examples' op-amps or the coil-on-a-wave test.)
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
    `complexPrepare` (closed form, ringing included; e^A for a near-Jordan block,
    `MODAL_COND`). R is the Winding's (`inductorOhms`: a power law of L per body, × the
    grade's factor — catalog/discretes.js). Where its current goes when a switch opens:
    a flyback diode; a MOSFET's BODY diode (its grade's `body`: each N grade its card's
    own since phase 7, 2026-10-27 — diodes.js `MOSFET_BODIES`, 2N7000 Zetex DIODE1,
    IRLZ44N/IRF540N Infineon MD, on the bridge's simpler fit; the P grades, no card
    found, `BODY_SPEC` — the bridge's 1 A
    rectifier table, one for every grade; `bodyAmps`/`bodyPiece` in network.js, every
    MOSFET, inert until reverse-biased; until the grade of 2026-10-23 a hard 0.6 V knee
    behind 2 Ω, so a net only it held read exactly 0.600 V and amps came out volts off); a CMOS output's rail clamps (`outputClamps`,
    added ONLY in a cluster with an inductor — elsewhere they never conduct); else the
    switching transistor's BREAKDOWN (`BREAKDOWN`: BJT 40 V, MOSFET 60 V, behind 1 Ω).
    Reaching breakdown in a coil's cluster is an `inductive-kick` WARNING (`kicksNow`:
    `{comp, volts, joules}` — ½LI² of the coils feeding it; SimController's toast keyed
    `kick:<comp>`), said ONCE a turn-off: a transistor the last tick left in breakdown
    (`analog.kicking`) is not said again by the next, which starts still in it — read
    a hair lower ("0.0901 mJ", then "0.09 mJ") it was two toasts every turn-off (the
    fourth regrade, 2026-10-22). **A kick is judged by its ENERGY** (Jason, the same
    day: "judge the kick by energy"): past its package's `KICK_LIMITS` (params.js,
    assumptions — a TO-92 0.5 mJ warns / 5 mJ smokes, a TO-220 30 / 150) the kick's
    warning carries `limit`/`smoke` (`kickWarning`; "…more than the … mJ its package is
    made to take in one kick", danger past smoke), and a transistor in a kick is not
    held to its POWER that tick (`outputLoads(rep, kicksNow)`: 40 V × the coil's
    current against the 625 mW steady rating called a 0.13 mJ relay kick a failed
    part). A coil kicked over and over heating the part by its mean power is not
    modelled. A desk holding a coil never records a cycle (its signature carries no
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
    current through zero — bench-parts.md). **Never past a wave's turn** (the grade,
    2026-10-23): a group one of whose waves TURNED during its last piece (its heading at
    the piece's start ≠ at its end — a sine's crest) or whose last piece a wave's edge
    ended (`byWave` — a triangle's apex) starts its `recent` afresh: the network comes
    back through the pieces it rose by, and taken for stuck, a MOSFET on a 10 kHz wave
    ran on along the wrong piece at every turn (sine 3 %, triangle up to 12 % short).
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
  - **A crossing behind a MOSFET channel** (2026-10-26, the fix round's phase 5b; a
    listener whose cluster holds an `"m"` device, `channeled` in `listenFor`) is taken
    past the tick's moment only within `FAST_WINDOW_S` of something that MOVED a level
    in the tick (`windowAt`: a settle of more than one pass, a crossing, a reading
    flipped at a corner) — never chained from corners nor a quiet tick's moment; left,
    it is the next wake. A ring of three 2N7000s ran its gates corner to corner 58 µs
    past the tick and showed the reader's crossing there (the HIGH half −3.6 %). And a
    corner its group comes out of GROWING, though still settled, spends the corner
    budget only (`grew`), not the island's `MAX_ANALOG_EVENTS` — the same ring grows
    at every channel piece, capped at its 32nd and backed off as a chatter (14.5 ms a
    period for 3.07). Other listeners keep the old window: their examples and goldens
    are bit-identical.
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
    frequency on past the change (2026-10-10). An op-amp whose inputs both stand on the
    nodes' networks is part of the cycle, not a drive of it: its output pins are left out
    of `driveSig` (read as a level at its swing it came out H at one settle, X at the next,
    and the schedule ended every other frame). **An UNHEARD island** — no pin listens to
    it: an op-amp relaxation oscillator, a transistor astable — has no crossings, only
    corners: `record` takes each corner as its moment (`crossing` true) with
    `headings` (which way each node heads) as the reads, and `comeRound` checks it after
    the corner as after a crossing (the regrade, 2026-10-22: never recorded, a 1 nF LM358
    oscillator was stepped edge by edge at 2.4 s a frame; now drawn at its true 14.2 µs).
    **An unheard island slower than the cap is drawn at its OWN rate** (the fourth
    regrade, 2026-10-22, Jason: "do the full cycle replay work for the LM358"):
    `cycleStart(…, slow)` looks back as far as `SLOW_CYCLE_S` (1/25 s — past 25 Hz lamps
    are shown by their mean, as a drawn cycle's are) for an island no pin listens to, and
    `scheduleOf`'s `shown` is the larger of the cap's period and the cycle's own, so its
    `scale` is 1 — time and drawing alike true. Its segment records match on the chips'
    own state and read pins alone (`sameStart`, `cycle.unheard`): the logic levels its
    nets stand at as a segment begins are no reading of anything, and at a swing's corner
    came in X or H as the last settle left them — matched on them it never went steady.
    Steady, it is ticked a display frame at a time: a 706 Hz LM358 relaxation oscillator
    1.4 → 0.1 s a simulated second (with an LED and a speaker on it, 0.14 — the LED by the
    cycle's mean, the speaker at the true pitch). **Only while nothing records**
    (`slowDrawn`: `spice.waveFrames === false`): the analyzer's lanes are drawn from the
    ticks, and a drawn cycle's land no finer than MIN_SHOWN_S apart (its edges read 1023 µs
    a period of 1417), so recording, one drawn so is ended (`tooSlow` → `endCycle`, its
    nodes run on) and stepped as before; drawn again once the recording stops. A
    HEARD island (a 555, a pin on the node) keeps the cap's window — drawing those at
    their own rate snapped readouts, speaker pitch and the timers to MIN_SHOWN_S. A
    **transistor astable** is one too: its period is a hundred-odd corners of the
    junction tables (~150 with an LED in each collector, ~180 near 25 Hz with the
    half-millisecond ticks among them), and an island's timeline kept 96 moments — it
    never came round, stepped corner by corner at 5.8 s a simulated second at 150 Hz and
    111 at 1.9 kHz with LEDs. A timeline now keeps up to MAX_TIMELINE 512 and drops what
    is further back than `cycleStart` looks (`pushMoment`: a heard island keeps a
    millisecond's worth): 150 Hz 0.15 s/s, with LEDs 0.25; the drawn period the stepped
    one to 0.1 µs. Below 25 Hz (an LED flasher on 1 µF, ~19 Hz) it is stepped still,
    0.65–1.3 s/s; the usual 10 µF one 0.06–0.13.
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
    CONSUMER. Since the regrade (2026-10-22) a consumer — any other chip with an input
    on one of those nets or anywhere in a voltage cluster they are in — is taken INTO
    the scope with its nets, to closure (a 555 into a MOSFET's gate was never replayed,
    every segment a wake); a memory chip still ends it, and a counter's state, new every
    cycle, never matches a record. Each segment settled records what it did to that scope
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
  `set / SHORT_OHMS` (0.1 Ω) — on its limit, drooped to ~0 — unless it is **STACKED**
  (2026-10-26, `sim/floating-grounds.js` `stackedSupplies`, per netlist + ground lead):
  a supply sharing a terminal with another and whose − no other − shares floats on it
  (a ± rail: its + on the other's −; or on top: its − on the other's +), each stack
  nothing grounds grounded at the ground lead's / a − rail strip's / its first supply's
  −, the rest walked from there; one whose ends the walk reaches at voltages its set does
  not join (wired across another backwards) stays a short. `supplyTopology` carries
  `stacked`, `liftedMinus` (a top stack's − — no ground, no short, out of `minusNets`)
  and `stackRails`. Both engines read it from `buildContext` (sim/engine.js): the shared
  end is left to the other supply, the own end a + rail at the stack's volts or a −
  (`belowGround` — a chip's ground on it runs on the whole span, an LM358 on ±5 V at
  10 V), the delivered volts in `ctx.stackedVolts` (supply.js `stackedVolts`); rc-trace's
  `rail()` the same. Spice Lite puts the own end at its stack's volts (makePlan, analyze),
  takes a chip across a stack rail off-rail (`railFed` false, no ICC booked by
  `measureSupplies`), books a − rail's supply every draw returning into it and a top
  stack's demand to the supply under it too. The deck (`spice-deck.mjs`) writes a stacked
  supply across its own nets: a ± LM358 reads ngspice's "same" deck exactly. A
  **short `via`** a
  transistor or switch stands only past `SHORT_AMPS` (0.1 A) measured, or with its
  supply limited, or unmeasurable (`viaShortMeter`); one with no `via` always stands.
  Supply demand (`spice/supply.js` `measureSupplies`) is every RAIL-FED
  chip's ICC (powered or not — droop must not flicker) plus the voltage solve's DRAWS
  (`report`, above; at SET volts while anything droops). Past `currentLimit` (a PSU
  PARAM, 1 A default omitted — no schema bump) V = Vset · Ilimit / Idemand, fed back
  through `psuVolts` — or, for a supply nothing logic-powered hangs off, its + held by
  the solve as a constant-current source (bench-parts.md → "A supply ON ITS LIMIT"). Wire sag (`spice/sag.js`): 24 AWG at `wireCutMm`, draws routed on
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
  GRADE's (2026-10-19, `DIODE_GRADE_SPECS`, catalog `DIODE_GRADES` — a plain diode's
  spiceOnly Grade select, stored only off the default): **small-signal** (the default,
  every diode before grades — the 1N4148 vendor card's DC curve, Is, n, Rs, IKF, as a
  table; rthJA 300 °C/W, so it burns past ~0.33 A held — by HEAT since the regrade of
  2026-10-22: two stages to the air DERIVED from its sheet's two surge ratings, the die's
  `rthFast` read at the instant (2 A for 1 µs reaches Tj max — and since phase 7,
  2026-10-27, timed: the diode's voltage reaching where its die burns, `burnVolts` at the
  package's temperature, is a CROSSING, `burnWatch`/`burnDiffs` in engine.js, stated off
  its group's read once it is on its table's last stretch below and burnt there, `burnAt`,
  whatever the ticks — read at a tick's instant, a 1N4148 charging 470 µF from 12 V~ (2.27 A
  crest) burnt on a 0.5 ms grid and never at the adapter's own wakes; now at 1.2 ms every
  way) and the package's lagged
  `heatTauS` (~5 s: 1 A for 1 s reaches it), carried in `analog.ledHeats` with the LEDs'
  (engine.js `heated`, `rthSlow`, `slowTemp`; a Zener too) — an instant burn past a
  third of an amp took a 1N4148 charging 100 µF at a supply's 1 A for a millisecond),
  **rectifier** (the 1N4007 card on its
  full table — the die a bridge holds, `RECTIFIER_SPEC`), **power** (a least-squares fit to Vishay's 1N5400 Fig. 3, with IKF) and
  **schottky** (a fit to Vishay's 1N5817 Fig. 3) — the last three `surgeRated`: rthJA
  set so the junction reaches Tj max at the sheet's IFSM (30 / 200 / 25 A), the bridge's
  reasoning. A Zener is always small-signal (no Grade), backwards at its `zenerVolts`.
  Burning the same way (`diode-burnt`) —
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
    coil switched off, its base stuck at 0.65 V, never converged). (Round 2, 2026-10-27, spice-reviews.md: a line search cut to a sliver is taken whole and its thrown nets re-balanced — `balancedStep`; a device read once a Jacobian; a residual within its rounding floor is balanced.) **Three Newton fixes
    for a sine into an NPN switch** (2026-10-23, 57 → 15 s per simulated s at 1 kHz,
    6.4 → 1.5 at 100 Hz; parity and golden unchanged): (1) a slope read that crosses
    onto another of the device's pieces where the other way stays on its own is read
    the other way (`deviceSlope` + `slopePiece`, a BJT's piece as a number) — a group's
    corner IS a device on a piece's edge, so every solve at one stood a microvolt from
    it, the blended slope made Newton linear (×0.85 a step) and sixty steps ran out
    unbalanced; (2) a step under `MIN_STEP_V` is still TAKEN when it balances the nets
    (both Newton loops) — refused, a solve a picovolt from its answer went to a
    Gauss–Seidel sweep; (3) `linearizeGroup`'s base solve starts where that cluster's
    last linearization this tick stood (`linearizedAt`, keyed by the cluster object,
    never cleared within the side so the full and carried settles agree; not for a
    cluster with an op-amp, whose solve reads the edge it CAME in at) — from the
    tick's start, the switch climbed OFF → saturated afresh at every corner. Left:
    ~35 corners a half-cycle (the tables' segments), each a linearization; a
    wave-driven network with no state of its own is the same every cycle and could
    be replayed. **Not searched at all since phase 7** (2026-10-27, `cornerless`): a
    group of waves alone (no RC node, no coil) runs on its generators whatever its
    networks do, so where nothing reads the island (no listener, relay, op-amp), no
    diode on it is watched for its burn, the analyzer reads none of its nets and its
    networks hold at most one transistor (two can latch — a fold is a corner), no
    corner is searched and each tick solves the networks it reads (`tEnd` = the
    waves' own limit): 1 kHz sine into an NPN 17 → 1.3 s a simulated second,
    readings within 1.3e-9 V. Result `lamps` (key `c4` / `c5#a`,
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
  hole it is on. **The burn is by HEAT, not the instant's current** (Jason, 2026-10-22:
  "LEDs should tolerate a small amount of over current … use that [heat] to control when
  they burn" — replacing the 2026-10-07 instant burn): the junction follows its steady
  Ta + RthJA·V·I through one lag, `LED_HEAT_TAU_S` 1 s (an assumption — no sheet gives
  one), carried per junction in `analog.ledHeats` `{tj, steady, at}`, booked at the
  PREVIOUS tick's steady (exact for a square/PWM drive, whose edges tick) and starting
  at ambient, so nothing burns on the tick it is switched on. **A tick that spans many
  cycles books their MEAN, not the phase it ends in** (the regrade, 2026-10-22: through
  4.7 Ω an LED near 111 °C at every rate burnt in 2 s on a drawn 2 kHz 555, and one
  straight on a 68 kHz output — not drawn, its ticks ending nearly all HIGH — burnt in
  a third of a slow one's time): on a DRAWN cycle each segment's power is read off its
  settle (`noteLedPower`, `st.ledPower`, carried in `analog.cycles`) and `drawnSteady`
  is the period's mean; any other LED once HOT (a tick's steady past half way from
  ambient to Tj max, `HOT_LED_SHARE`; held `HOT_LED_HOLD_S` 1 s, `hotUntil` in its
  `ledHeats` entry) has its power read at EVERY settle (`noteLedHeat`, left-hold, into
  `analog.ledEnergy` `{from, t, w, e, read}`), and `heatNow` heads for the stretch's
  mean. The entry a tick leaves holds `steady`'s power, so a drawn cycle that stops
  being drawn books its mean up to the first settle, not its last phase. Its LAMP is the
  cycle's mean too (`drawnLamps`: each segment's `ledAmps`, carried beside `ledPower`, to a
  duration-weighted `ledVerdict` level) — read at the phase a frame lands on, a dimmed LED
  behind a 6.8 kHz 555 showed 1.11, 1.03, 0.08 by turns. Now 0 Ω burns
  at 1.15–1.37 s from 7 Hz to 68 kHz and 4.7 Ω never. `ledVerdict`'s optional
  `tj` is that lagged one; `burns` = tj ≥ Tj max. One heading past its maximum wakes the
  board at `ledBurnIn` or `LED_HEAT_STEP_S` 0.1 s, whichever is first (`burnWakeAt`,
  both `later` and `globalLater`). Red across 5 V (410 mA) burns at 0.09 s, through 10 Ω
  at 0.38 s, 100 mA at 1.1 s; below the burn figure (72 mA red) never; the sheet's
  160 mA × 0.1 ms × 1/10 train holds ~53 °C. `led-burnt`'s `tj` is the STEADY one ("would
  heat its junction to"). `led-overdriven` stays an instant-current warning. Diodes keep
  their own surge rule. Decided too: the LED numbers are NOT user-editable; an LED never damages the chip driving it (the output's own limits do —
  `output-current`). Not modelled: LS sink saturation past IOL.
- **Spikes & decoupling**: a switching output charges its sheet's test load (`loadPf`:
  15 / 50 pF) in its own delay, for one pass, booked to its supply; the worst pass is the
  supply's `peak`. A capacitor from the chip's VCC net straight to a − rail decouples it.
  A peak past the limit is a `supply-spike` WARNING — the logic is not glitched — but
  not for a supply its steady draw already holds on its limit (`sup.limited`): any
  spike passes it, and a 100 nF is no answer to a load too big for it.
- **UI stays thin** (rendering work was going on in parallel): `nodeVolts` →
  `SimOverlay.voltsOfNet` → the probe readout; `supplies` → `PsuView.setSupply` (a moving
  run's `amps` the MEAN over the frame — SimController `#supplyAmps`, a `LampAverage` of
  each tick's, the grade 2026-10-23: a boost converter's 5 A supply read 0–0.67 A by turns
  where it averaged 0.76; the limit itself is still judged per tick) (writes
  only when its text changes); brown smoke reuses the burn overlay in
  `--color-part-smoke-brown`. Nothing new is drawn per tick.
- **A gate biased into its linear region** (`spice/linear-bias.js`, 2026-10-08, plan
  Phase 5): an inverting, non-Schmitt gate unit (INV/NAND/NOR) whose output a RESISTOR
  ties straight to one of its own inputs (`selfBiasedGates`, per netlist) is an amplifier
  on a bench, half way up its transfer curve — out of scope (Jason, question 10). When
  its input is left X or Z at a tick's end it is said as `linear-bias` (`{chip, pin}`,
  its output; SimController's toast keyed `bias:<chip>`), and the `oscillation` on its own
  nets / the `floating-input` on its own input pin that its loop raised are dropped
  (`linearBiasWarnings`). A Schmitt part's loop is an oscillator, and is left alone.
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
- **`spiceOnly` PARTS** (2026-10-13): a def flagged `spiceOnly: true` (the speaker,
  the electronic load, mains, the AC adapter, the transformer) is left out of the palette while Spice Lite is off
  (`palette-panel.js` `#engineShown`, re-rendered by `setSpiceLite`); a filter that
  matches one says to turn Spice Lite on (`palette.spiceOnlyHint`). One already on a
  desk stays. Tests: `spice-speaker.test.js`, `speaker-audio.test.js`.

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
  each powered input's own stages (`inputStages`: a 74LS input's bias, 0.2 mA out of
  the pin to its 0.9 V knee, then falling to none at 1.3 V — a limited stage; a CD4000 input's two protection diodes, `CMOS_CLAMP`). BRANCHES:
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
  - Transistors (`spice/network.js` `deviceCurrents`, numeric slopes) are each their
    GRADE's part (`spice/transistors.js`, 2026-10-08, plan Phase 4; the catalog's
    `TRANSISTOR_GRADES` + `transistorGrade`, a `spiceOnly` select whose default follows
    the package: TO-92 the type's first, TO-220 Power; a listed part number brings its
    grade and package, `TRANSISTOR_PART_FACTS`). Jason's "one set per kind" became one
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
    digital — parity). The CD4007UB's six are `"m"` devices.
  - Chip power: a chip NOT straight across the rails (`railFed` false) gets its status
    from the new `chipVolts` hook — V(VCC) − V(GND) from the last solve (`fedStatus`); the
    resettle loop runs again when that moved. Rail-fed chips are the digital rule exactly.
  - Retired under Spice Lite (filtered, `RETIRED`): `ls-fanout`, `marginal-high`,
    `mixed-supply`. `ctx.limitsLed`'s LED rule is still computed (strongLevels are a parity
    field) though nothing under Spice Lite reads it.

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
- **Time**: a pass is one QUANTUM, the shortest gate delay on the desk
  (`spice/params.js`; CD4000 scaled along SCHS015C's 5/10/15 V points); a slower chip
  HOLDS its outputs `round(delay/quantum)` passes, inertially. One family → every hold
  is 1 → pass for pass the digital engine. The cap is `MAX_ITERATIONS × maxHold`, and the
  slowest gate is at most `MAX_HOLD` (64) quanta — past it the quantum grows — so a
  delay edited absurdly short cannot turn a tick into minutes.
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
  frames (`ANALOG_FRAME_S`) until the gap setting says arrived. The settles inside one tick read the memory images with
  the earlier settles' writes to a volatile chip applied.
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
    them (`sampleTimes`, `searchEnd`). A common mode is balanced on the TRUE networks
    first (`balance`: bracketed then Illinois on `volt.currentsAt`) — balanced on a
    linear piece it jumped past a clamp or a saturating stage and back, forever. Nodes
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
    coil current). The probe reads an inductor's two sides at the POINT
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
    kept: each tick walks the segments the shown wave began since the last (`cycleDone`,
    at most one cycle), each settled at its moment, each checked to still drive what it
    recorded (else the nodes run on from there). Time is not slowed: `stepEnv` tells a
    counting part's pins `{id, cycles, period}`, the true cycles since the schedule began
    (the 4060/4541 count on from their `base`). Ends on a new netlist or document, a moved
    supply, or a drive mismatch. The whole analog side is the cycle: two unrelated fast
    oscillators never repeat as a whole (stated).
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
  `inputLowUa` scales the 74LS bias (`TTL_INPUT.ohms` ÷ ratio). `inputHighUa` was
  removed: a 74LS IIH is a reverse leakage the solve never drew, and a field that moves
  nothing is a lie. A **family-less** part's outputs are the common `MOS_STAGE` (rail to
  rail behind 100 Ω, an assumption bracketed by SN74HCT00), never 74LS's 3.6 V HIGH.
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
  `spice/output-stage.js`: a chip output as the stage it is — 74LS HIGH VCC − 1.4 V
  behind 120 Ω (SDLS025B's schematic), LOW 0.15 V behind 25 Ω, each ONE-WAY (the
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
  to two places. The axis is still TICKS: the display frames (`ANALOG_FRAME_S`) are
  what space a moving curve evenly, and clock edges interleave their own columns —
  stated in the guide, not corrected. The Δ-ms readout (`tickMsFor`) assumes one
  tick per clock half-period, which display frames also break.
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
  (+0.3 %) and the CD40106B pair (0.03 %), measured on the unchanged deck — so on
  2026-10-08 only the CMOS-stage areas were regenerated (on 44.2) and `ne555.json`
  stays a 42 reference. Regenerate an area only when its model moved, and say so.
  A reading can be of a LATER moment than asked: a tick re-linearizes every corner within
  `FAST_WINDOW_S` (10 µs) of the last one past its own target, chained, so a node on a
  curve with close corners shows where it is a few µs on. The 10 V CMOS case's 1.3 % at
  0.4/0.5 ms is that, not the curve (every corner within 0.07 % of the exact square law).

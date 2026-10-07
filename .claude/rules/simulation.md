---
paths:
  - "src/web/scripts/sim/**"
  - "src/web/scripts/catalog/families.js"
  - "src/web/scripts/catalog/chips-*.js"
  - "src/web/scripts/catalog/pin-builders.js"
  - "src/web/scripts/components/sim-*.js"
  - "src/web/scripts/components/netlist-cache.js"
  - "src/web/scripts/components/probe-inspector.js"
  - "src/web/scripts/tests/engine*.test.js"
  - "src/web/scripts/tests/sim-*.test.js"
  - "src/web/scripts/tests/cd4000*.test.js"
  - "src/web/scripts/tests/chips-*.test.js"
  - "src/web/scripts/tests/netlist.test.js"
  - "src/web/scripts/tests/resolve.test.js"
  - "src/web/scripts/tests/levels.test.js"
  - "src/web/scripts/tests/chip-eval.test.js"
---

## Simulation

- **Netlist** (`sim/netlist.js`): a pure union-find partition of every point into nets,
  keyed by the lexicographically smallest member address (stable across rebuilds). Part
  state (switch position, button pressed) is an INPUT — a switch's `internalBridges`
  conduct; chip pins are net MEMBERS, never conduits (that is the simulator's job).
  Always a full rebuild, invalidated on `chiphippo:doc-changed` / `chiphippo:part-state`
  by `NetlistCache`.
- **Two partitions, and which question each answers.** The CONDUCTING one (default) is
  the live circuit — the engine solves it, and app.js's one shared `netlistCache` serves
  the sim, the analyzer, the AI review and the probe's level tint. The WIRING one
  (`{bridges: false}`: every switch and button an open contact) is what the BUILD
  connected — app.js's `wiringNetlistCache` serves the schematic, the build guide and the
  probe's highlight, readout and naming; the exports and the AI verifier's L4 build their
  own. **Net names (Feature 120) always resolve on the wiring partition** (Jason,
  2026-10-05): a name bound beside a slide switch used to ride its closed contact onto
  the + rail and every VCC pin on it, naming the other side read as a merge conflict, and
  renaming deleted the rail's own name as a "stale" binding. So `buildNetlist` returns
  `wiringNetOfPoint` + `wiringNames` beside `names`, conflicts are two names on one WIRED
  net, and a CONDUCTING net carries a name only when every wired net inside it carries
  that same name. Anything pointing at one place asks `NetlistCache.nameAt(address)` (the
  analyzer's channel labels), whichever partition it holds. The probe emits WIRING net
  ids on `chiphippo:net-probed`, which are the ids the schematic draws.
- **Levels** (`sim/levels.js`): H/L/Z/X, `asInput` = "floating reads HIGH" (TTL),
  `asCmosInput` = "floating reads X" (CMOS), ternary gate primitives. Which one a part
  reads through is its FAMILY's (`chip-eval.js`'s `readerFor`; see "Logic families").
- **Chip behaviour is DATA, never per-chip code.** Combinational chips carry a
  `logic.units` block the ONE generic `evaluate(def, pinLevels)` in `sim/chip-eval.js`
  walks — gate primitives (incl. `XNOR` and the non-inverting `BUF`), tri-state `BUF3`,
  and `COMB` units (a pure `compute` over fanning-out inputs: the decoder/mux
  vocabulary). Sequential chips carry `{ state0, step, outputs }` built by the pure
  family builders in `sim/sequential.js` (D-FF with active-low OR active-high async
  controls, JK-FF, transparent latch, sync + up/down counters, SIPO/PISO shift, and the
  CMOS `johnsonCounter`/`binaryCounter` and batch-2 MSI builders); analog switches carry
  `logic.channels` (`sim/analog-switch.js`, below);
  `step(state, inputs, prevInputs)` advances on detected edges + level-sensitive async
  overrides, `outputs(state, inputs)` drives the pins. **A new 74xx part is data** — if
  it can't be expressed, extend the vocabulary, never fork. Zero-delay and
  power-agnostic; the truth-table harness enumerates every gate unit exhaustively,
  MSI/sequential parts prove out in circuit fixtures.
- **The CPUs and the PROCESSOR group** (`catalog/chips-cpu.js` + `sim/w65c02.js` +
  `sim/z80.js` + `sim/z80-ops.js`) are the far end of "genuine per-part code behind the
  STANDARD sequential contract" — a whole instruction set behind
  `{state0, step, outputs}`. They live in their OWN group, which is why the W65C02 left
  `chips-io.js` (that file is the 65xx PERIPHERAL wave). The group is `PROGRAM_ONLY`
  (`scripts/demo-build.mjs`) so it gets no bench demo and no example button, and it is in
  `PROTOCOL_GROUPS` (`chips-tristate.test.js`) because a CPU floats pins on a bus
  PROTOCOL, not on any pin you can tie.
  - **They disagree about the clock, and that is the design difference.** A 6502 IS one
    bus access per PHI2 cycle, so `w65c02.js` collapses to that and loses nothing. A Z80
    is not (an opcode fetch is four T-states with a REFRESH cycle glued to its back half,
    a read is three, an I/O cycle four), so `z80.js` runs a real M-cycle/T-state machine
    — the only way `/M1`, `/RFSH` and `/WAIT` mean anything. It is affordable because the
    transport ticks the engine once per clock EDGE (`sim-controller.js`'s
    `1000 / (2 * hz * speed)`), i.e. HALF-T resolution — what the Z80's timing diagrams
    are drawn at — and because `outputs` may read the LIVE clock off its own input pins,
    so the state carries only WHICH T-state it is in. `SIGNALS` is the datasheet's timing
    diagram transcribed as DATA, not code.
  - **They latch the data byte from opposite places.** `w65c02.js` reads from `prev`
    because a 65xx peripheral gates its bus drivers on PHI2 — an INPUT already flipped by
    the falling-edge settle. `z80.js` reads from `ins`, because it enables the device
    with its OWN `/MREQ` + `/RD`, still asserted in the pre-settle picture. The corollary
    is the subtle one: the byte is taken on the edge ENTERING the sampling T-state
    (`t + 1 === sample`), since an M1 releases `/MREQ`//`/RD` and puts the REFRESH
    address up at T3's rising edge — sample a tick later and every fetch reads a
    deselected memory, i.e. `$FF`.
  - Both cores keep a small `log` of the bytes already returned for the current
    instruction and RE-RUN a clean interpreter from the committed registers each M-cycle,
    throwing at the first new access — plain data, no generators, so the engine's
    structural `sameState` still works. **`step` MUST be edge-gated and return its state
    VERBATIM off-edge**, or the tick's step fixpoint never settles and the circuit is
    reported as oscillating.
- **The engine** (`sim/resolve.js` + `sim/engine.js`) is pure and DOM-free. `resolveNet`
  picks a net's level by strength precedence (supply beats chip output; opposing supplies
  → `X` + short; disagreeing outputs → `X` + conflict; `Z`/undriven contributes nothing;
  a clock source drives its `out` net at output strength).
  **The fixed context is built once per document + netlist, not per tick**:
  `prepareCircuit(doc, netlist)` returns it, and `tick`/`settle` take it back as
  `context`, reusing it only while BOTH are the very same objects (`contextFor`) — so a
  caller editing a document in place must not pass one. SimController keeps one, and
  ONE document snapshot (`#document()`, shared by the clocks and signals too), both
  dropped on `doc-changed`, `part-state`, its own damage write, Run and Stop
  (`#forgetDocument`). The resistor relaxation re-resolves only the nets a pull can
  reach (`pullReach`: resistor ends, diode cathodes, and whatever a channel joins to
  them); every other net keeps its no-pulls resolution, which is exactly what it would
  resolve to. Together they halved a busy tick (`make bench`) with identical results.
  Under HOOKS a context is never reused (Spice Lite's `psuVolts`, `chipDrop` and
  `curves` are read while one is built, and change tick to tick) — only its `fixed`
  facts (`fixedFacts`: pin→net maps, resistors, diodes, the RC trace, and memos of each
  timed part's timing per def, the index per `logicOf` (a WeakMap — Spice Lite's
  silicon twins are stable objects) and the boundary warnings per chips' power). Re-reading
  every part's pins off the geometry each settle was a fifth of a Spice Lite tick.
- **The settle is INCREMENTAL, and bit-identical to the full loop**
  (`sim/incremental.js`, `features/event-driven-simulation.md`). The passes are the full
  loop's exactly — same count, same starting levels, same fixpoint test, same marking,
  same warnings in the same order, same observer record, same hook calls — but a pass
  evaluates only the chips whose READ nets changed (`settle-index.js` `readers`: unit
  inputs/enables, or a sequential/memory chip's input+io pins), whose state object the
  step replaced, or that the debugger WATCHES, and re-resolves only the nets whose drivers
  or channel joins changed, with everything they are coupled to. The coupling is STATIC
  (`settle-index.js`): union-find over every resistor, diode and channel that COULD
  conduct, rails never a union point (a rail resolves to its supply whatever reaches it);
  a component is resolved by `resolveAll` with a `scope` that keeps the desk's FLAGS and
  CAPS (the relaxation's pass cap decides where a pull loop that never settles ends —
  VCC–R–A–R–B–R–GND alternates, so its result depends on the desk's resistor+diode count's
  parity; kept, not fixed), a net in no component (a LONE net) from its own drivers, and a
  component no driver can reach (`fixed`) once per context. What is cached is the CERTAIN
  channels' narrow resolution; a pass falls back to `resolveReadings` (the full loop's
  code) when the channels have more than that one reading or a diode's anode is unknown
  (the wide reading is the whole desk's). Every chip still goes through Spice Lite's
  `outputs` hook every pass, in order (it counts holds per call). With an observer or a
  `levels` hook every pass gets fresh complete maps (the debugger keeps them by
  reference); otherwise one map is updated in place. One quirk is reproduced on purpose:
  with no resistor, diode or LED-limiting part a pass's strong map IS its level map, so
  the oscillation marking reaches both. The work is carried across one tick's re-solves
  (`carry`: `pending`, `stale`), NEVER across ticks — every tick starts cold (evaluates
  every chip, resolves every net once), which bounds the gain near the passes per tick
  (`make bench`: 3.8× per tick at 8 slices, 4.4× at 16; 1.4× under Spice Lite, whose
  hooks see every chip every pass). The cache is held by net INDEX (arrays cloned from
  `settle-index.js`'s `start`), not in Maps: cloning a string-keyed Map per tick cost
  more than the passes it saved. `opts.mode: "full"` runs the old loop
  (`solveFull`) — the reference `tests/engine-incremental.test.js` holds the default to,
  field by field, observer record and every Spice Lite field included; `opts.stats`
  counts passes, evaluations, resolutions and fallbacks. Tests and the bench only.
  `settle({document, netlist, warmStart})` gates each chip on its VCC net and EVERY
  ground-role pin's net (a CD405x's VEE beside its VSS; the AM27C1024's two VSS) against
  its FAMILY's supply range (`catalog/families.js` `supplyRange`: 74LS and every
  family-less part 4.75–5.25 V, CD4000 3–18 V; below → underpowered-inert, above →
  damaged; `chipStatus` entries are `{ status, volts }`), then loops resolve →
  `evaluate` → re-drive to a
  fixpoint or the 200-iteration cap (→ still-changing nets marked `X` + oscillation).
  **Warm-starting net levels by stable netId is exactly why cross-coupled NAND latches
  HOLD.** The engine is a pure function: it REPORTS `chipStatus` and returns
  run-volatile `state`/`pinLevels`, never mutating `params` and never touching a timer.
- **Analog switches JOIN nets; they drive none** (CD4066B, CD4051B/52B/53B — Phase 2b
  of Feature 410 — and the CD4007UB, whose six MOSFETs are six channels built by
  `mosfetChannels`: N on while its gate is HIGH, P while LOW, a floating gate X through
  the family reader, with no gate memory, unlike a discrete MOSFET's. Its pair 1 sits on
  the part's own VDD/VSS pins inside the package, so a supply pin may be a channel
  terminal on a def flagged `transistorArray`, which also makes a rail-to-rail join
  through it a short `via: "transistor"` — tagged per JOIN, not per net, since its
  terminals 14 and 7 sit on the rails and a net tag made every rail short on the desk a
  transistor's; a terminal whose channel runs to a rail is that gate's OUTPUT to the
  boundary warnings (`mixed-supply` at the `+` rail's volts, `ls-fanout` through an N to
  `−`); shelved under Inverter, its headline use; out of the AI builder, since which
  terminal is an output is decided by wiring the card cannot show). The NETLIST stays static (wiring + hand-set switch positions only),
  so the probe, schematic, warm-start ids and every netlist consumer are untouched; the
  join is the SOLVER's, per pass. A def states `logic.channels: [{a, b, inputs, on}]`
  (terminal pins, control pins, a pure `on(levels)` → H/L/X, built by
  `bilateralSwitches`/`muxSection`); `chip-eval.js`'s `channelStates` reads the controls
  through the family reader. `engine.js`'s `channelGroups` unions the nets of every ON
  channel of a POWERED switch (union-find), from the previous pass's levels exactly as a
  chip's outputs are, and `resolveAll` resolves each member net from every member's
  drivers and pulls — but a member RAIL only as its supply at OUTPUT strength, so a rail
  through a switch FIGHTS an output on the far side (conflict, said once per group)
  where the same rail wired straight on would win, and a group holding both rails warns
  `short` with `via: "switch"` (its own sentence everywhere). **A rail is never a union
  point** (`groupsOf`): it is stiff, so two nets each switched onto `+` are not joined to
  each other, and a fight on one does not turn the other X; it is a MEMBER of each group
  it touches (never a key — it resolves as itself), and a channel straight between two
  rails is a group of its own, reported as the short. **A floating control is read
  every way it could be** (`channelGroups`' `readings`, keyed by control NET): each
  assignment of the unknown controls is a real switch position, resolved on its own, and
  the pass keeps what every reading agrees on — a wide reading closing every
  maybe-channel at once joined a mux's channels to each other through COM, which no
  select value does. Past `MAX_UNKNOWN_CONTROLS` (4) it falls back to that one wide
  reading (more X, never less). Warnings come from the CERTAIN channels alone
  (`definite`). Levels that crossed a channel stay STRONG for every purpose but one:
  at ≤ 5 V a channel's on-resistance limits an LED's current, so the LED rule's
  `strongLevels` leave such a switch's joins out (each reading's `hardOn` — see "Logic
  families"); from 9 V an LED off a switch with no resistor burns, as off an output. Channel
  terminals are `io` pins the boundary warnings skip, KiCad exports as PASSIVE, and the
  AI card marks `~`.
- **`tick(...)`** adds the synchronous two-phase step on the same solver: ① pre-settle
  with the OLD per-component state (propagating the new `clockPhase` + input changes),
  ② sample each sequential chip's inputs and `step` it (edges from the pre-settle vs the
  last tick's `prevPinLevels`; async overrides win), ③ post-settle with the NEW state —
  so all edges are observed at once and then the combinational cloud settles.
- **`SimController`** (renderer) owns the **transport** (Run / Pause / Step / speed),
  drives each free-running clock's edges from a `setInterval` (handing `tick` each
  clock's level via `clockPhase`), re-ticks on every input event, routes warnings to the
  `NotificationStack`, and publishes `chiphippo:sim-state` (net levels + chip status +
  clock levels) that live views render from — **views never query the engine**.
  Sequential state and clock phases are run-volatile (reset on Run, never serialized).
  - **The timer's floor is DERIVED from the top of `CLOCK_HZ`**, never typed. Every edge
    is a full tick plus a `sim-state` publish, so there IS a ceiling on edge rate — and a
    hand-picked one is how a picker comes to offer a rate the app quietly runs slower
    than (at a flat 20 ms a "100 Hz" clock ticked at 25 and said nothing). Tying them
    together makes the ceiling equal the fastest rate on offer, so ×1 is always exact and
    only the SPEED multiplier can saturate. Offering a rate past ~100 Hz is a question
    about the tick budget (the heaviest shipped demo settles in ~0.6 ms), not about that
    constant.
  - **Over-voltage damage is run-volatile, and that took work to be true.** `#persistDamage`
    writes `params.damaged` into the DOCUMENT because that is what the pure engine reads
    (`powerStatus`) and a chip that let its smoke out at tick 5 must stay dead at tick 6
    — a timerless solver has nowhere else to remember it. But burning a chip is a WIRING
    mistake, not a property of the circuit, so `stop()` calls `#clearAllDamage()`
    **before** `#onTransportChange` (stopping re-baselines undo/redo against the live
    document via `#history.sync`, and a later clear would leave the baseline holding
    damage for ⌘Z to bring back), and `DeskDoc`'s load path drops the flag through
    `loadParams` (deliberately NOT `normalizeParams`, which `setComponentParams` shares
    and the latch needs) — covering a project ⌘S'd mid-run, older documents, every import
    and every paste. `SimController.replaceChip` is GONE: Stop recovers every damaged
    chip.

## Logic families (Features 400, 410)

**Two logic families, one catalog**: 74LS TTL (`chips-gates.js`, `chips-seq.js`,
`chips-74ls.js`) and CD4000 CMOS (`chips-cd4000.js`). `catalog/index.js` stamps
`family` per MODULE (`ofFamily`); memory, the 65xx peripherals and the CPUs are
deliberately FAMILY-LESS (they are not 74LS, and tagging them would hide a Z80 in
CD4000 mode). The family lives in the catalog ONLY — never in a document — so no
migration exists or is needed. **Everything that branches on a family asks
`catalog/families.js`** (`familyOf`, `supplyRange`, `supplyText`, `floatsUnknown`,
`lsFanoutOf`, `limitsLedCurrent`, `familiesShown`), never `def.family` by hand, and keys off
`family === "CD4000"`, never "is CMOS" (the W65C02 is CMOS and a Z80 test depends on
its floating bus reading `$FF`).

- **Every CD4000 pinout is from its TI datasheet**, cited at each def by literature
  number; most are Harris scans, read from rendered pages. Pin names are the sheet's
  (`A`–`M`, `0`–`9` on the 4017/4022/4028 — which, like the '148, need `#N` in an AI
  spec — VDD/VSS, VCC on the 4049/4050), less the bar on an active-LOW pin (the 4511's
  `LT`/`BL`, the counters' `CARRY IN`/`CARRY OUT`), as the 74LS names are. TI's CD4050B
  pin table wrongly says "Inverting output"; its function table is right.
- **A floating CMOS input reads `X`** (`asCmosInput`), at both input sites in
  `chip-eval.js`. The TTL sequential builders read X as a clean L and are untouched;
  the CMOS units (`dffUnit`/`jkUnit` with `unknown:true`, `johnsonCounter`,
  `binaryCounter`, `presetUpDownCounter`, `shiftStoreRegister`, `bcd7segLatch`,
  `bcdDecimalUnits`) carry an UNKNOWN state — X on an async control → unknown; X on the
  clock → "maybe clocked" (`merge` of held and clocked value); a clean reset recovers;
  power-up stays deterministic. Every rule is idempotent, so a stuck X still reaches the
  tick fixpoint. `overUnknowns(levels, fn)` tries each X both ways and keeps what every
  reading agrees on, so an unknown that cannot change an output does not spoil it (a 4028
  with D floating still holds outputs 2–7 LOW).
- **The batch-2 MSI parts' facts that are not obvious from a pinout**: a 4027 with SET
  and RESET both HIGH drives Q and Q̄ HIGH (as the 4013); the 4094's storage latches are
  TRANSPARENT while STROBE is HIGH and its OUTPUT ENABLE is active HIGH, QS/Q'S never
  floating; the 4511 is a latch BEFORE its decoder (LT/BL act on a held code) and BLANKS
  codes 10–15 (`CD4511_FONT`); the up/down counters' CARRY OUT is combinational and an
  async PRESET ENABLE holds the count while HIGH, the 4510/4516 RESET beating it. A
  decade count above 9 follows `bcdNext` — the CD4510B's logic-diagram gates for all 16
  states, which keep its sheet's "out of non-BCD states within two clocks up, four down";
  the CD4029B's sheet says nothing about it, so its decade mode reuses that logic (an
  assumption, flagged in the def). The CD4020B's Q2/Q3 count but have no pin
  (`binaryCounter`'s `q` takes `null`); the CD4024B is a 14-pin part.
- **A CD405x's VEE is a GROUND-ROLE pin** (`VEE` in `chips-cd4000.js`): the app has no
  negative supply, single-supply use ties it to VSS, and being a supply pin is what
  makes every consumer right with no special case — the engine powers the part only
  with it on the `−` net (else `unpowered`, and the build guide's unconnected-power-pin
  warning names VEE), the AI compiler and the demo bench wire EVERY supply pin (VCC
  first, then each ground, so single-ground parts lay out exactly as before), the spec
  may not list it (`POWER_PIN_LISTED`, which now names the pin), and `pin-resolve`'s
  role rung prefers the ground pin the token NAMES (`vss` is VSS, not the lower-numbered
  VEE). The catalog test allows exactly this second ground pin.
- **A CD4000 output at ≤ 5 V cannot burn an LED** (`ledLimit` 5 /
  `limitsLedCurrent(def, volts, level)` — the datasheet arithmetic is in its comment:
  ~4 mA typical at 5 V; at 9 V ~15 mA puts ~105 mW in the output transistor against
  its 100 mW absolute max; 12–15 V is 22–28 mA, past the LED too). So `strongLevels` —
  all `junctionState` ever reads, and why no consumer changed — is no longer the
  relaxation's `strong` map when a limiting part is on the desk (`ctx.limitsLed`): it
  is resolved AGAIN from the HARD drivers only (`driversFor`'s `hard`, which drops a
  limiting chip's output levels) across the HARD joins only (`channelGroups`'
  `hardOn` in each reading, which drops a ≤ 5 V switch's channels — rON 470 Ω, ~6 mA). The
  resistor relaxation's basis is untouched (a CD4000 output still pulls through a
  resistor), and a desk with no limiting part resolves nothing twice. A part whose
  output stage is not the small MOSFET names its hard side: `highCurrent: "sink"`
  (CD4049UB/CD4050B buffers, ~19.5 mA typical at 5 V — Fig. 5-3 levels off there, the
  LED's whole 20 mA rating with half the spread past it; a judgement call) or `"source"`
  (the CD4511B's bipolar segment drivers). The compiler still puts a resistor in every lamp leg on a
  rail — good practice, and the prompt's "not between two outputs" holds as advice.
- **Warnings no level expresses** (the engine has no net voltages), all STRUCTURAL and
  reported once per net/chip: `floating-input` (a powered CD4000 input on a net that
  resolved `Z`, spare gates INCLUDED — computed in `assemble`), and from
  `buildContext`'s `boundaryWarnings`: `marginal-high` (74LS output → CD4000 input with
  no resistor to a supply `+`; level stays H — LS VOH 3.4 V typ vs CMOS VIH 3.5 V),
  `ls-fanout` (a CD4000 output on more 74LS inputs than `lsFanoutOf`: 1, or the
  4049/4050's 8), `mixed-supply` (one net, chips on different supply volts — judged by
  `supplyClash`: outputs and ordinary inputs need the net at their own supply's level,
  while a level shifter's input, `def.inputsAboveSupply` on the 4049/4050, takes anything
  at or ABOVE its own; ground nets are skipped like supply `+` ones, since every supply
  shares one). Spice Lite MEASURES what these guess, and retires `marginal-high`,
  `ls-fanout` and `mixed-supply` from its results (spice-lite.md).
  `SimController.#report`, the desk review's `engineFinding` and the AI ladder's
  `describeWarning` each say them; the AI's L5 skips `floating-input` because L6's
  `INPUT_FLOATING` names the same pins better. A fault symbol's hover hint IS the
  Properties card's warning sentence (`part-symbols.js` `statusHint`, fed the volts
  from `chipStatus`) — it was a hand-kept English list that told a burnt chip to
  "replace this part" long after Stop learnt to restore it.
- **The tray shows a family, or both** (`settings.logicFamily`: `"74LS"` default |
  `"CD4000"` | `"combined"`; switched from Settings ▸ Data Sheets — app-wide, NOT per
  project, since a project flag is an unsaved change). Combined inserts a `74LS` and a
  `CD4000` folder under CHIPS; their groups' collapse keys are `74LS/NAND` etc., so the
  two NANDs never open together (`foldersOf` gives `#openOnly` the whole path). A family
  the open project uses is always shown (`noteProjectFamilies`, sticky until
  `resetProjectFamilies` from `ProjectWorkspace`'s `onProjectAdopted`), and a filter
  matching only a hidden family says where to switch it on. Every family lists its
  groups in the 74LS order (`CHIP_GROUP_RANK`: first appearance in the whole catalog,
  which 74LS leads), not its own part-number order — that would open CD4000 on NOR.
- **The AI builder knows both**: the card brackets each logic chip's family
  (`[DIP-14, CD4000]`), the prompt's family rule picks parts from the request (CMOS /
  CD4000 → CD4000; TTL / 74LS → 74LS; neither → 74LS; never mixed unless asked), and the
  compiler ties every input of an UNUSED CD4000 gate/section to GND (`spareCmosInputs`,
  `SPARE_INPUTS_TIED`, told to the repair round) — an input a USED section needs stays the
  spec's mistake for L6, whose message turns CMOS for a CMOS part. The section rule reads
  the CMOS sheets' TRAILING digit (`CLOCK1`) for CD4000 parts only — on a TTL part it
  would turn the '193's `D0`…`D3` into four sections.
- **The Digital export places six CD4000 parts** as their pin-for-pin twins in Digital
  v0.31's library (`DIGITAL_FILES`: CD4002B→744002, CD4017B→744017, CD4069UB→7404,
  CD4075B→744075, CD4077B→747266, CD40106B→7414); the other 40 are
  `noDigitalModel` (that library has no 4000-series folder), as is the NE555, and a
  capacitor is left out with its own reason (`capacitor` — it joins no net anyway). A floating CMOS input
  gets the TTL rule's PullUp — Digital refuses an open input and has no X — and the
  report says so (`cmosFloating`). `export-digital-cli.test.js` runs only with
  `DIGITAL_JAR` set and the release's `lib/` folder BESIDE the jar (a bare jar draws
  every chip as "7400.dig is missing", which the load check now fails on).

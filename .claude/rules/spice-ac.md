---
paths:
  - "src/web/scripts/catalog/speaker.js"
  - "src/web/scripts/sim/spice/speakers.js"
  - "src/web/scripts/components/speaker-audio.js"
  - "src/web/scripts/catalog/ac-parts.js"
  - "src/web/scripts/sim/spice/ac-supplies.js"
  - "src/web/scripts/sim/spice/inductors.js"
  - "src/web/scripts/sim/spice/analog-devices.js"
  - "src/web/scripts/sim/spice/diodes.js"
  - "src/web/scripts/model/ac-wiring.js"
  - "src/web/scripts/components/ac-wiring-monitor.js"
  - "src/web/scripts/components/ac-view.js"
  - "src/web/scripts/components/transformer-view.js"
  - "src/web/scripts/components/adapter-view.js"
  - "src/web/scripts/components/scope-ground-marker.js"
  - "src/web/scripts/sim/floating-grounds.js"
  - "src/web/scripts/tests/ac-adapter.test.js"
  - "src/web/scripts/tests/spice-ac*.test.js"
  - "src/web/scripts/tests/spice-speaker.test.js"
  - "src/web/scripts/tests/spice-transformer.test.js"
  - "src/web/scripts/tests/bridge-rectifier.test.js"
---

## The speaker, the AC supply and the transformer

The speaker, mains and the AC adapter, the transformer, the bridge rectifier, a
floating circuit's ground, the analyzer's ground lead — and the op-amp in time, worked
out on the AC desks. Split out of `spice-lite.md` on 2026-10-23 (`spiceOnly` parts stay
there). Section names kept: "The speaker", "The AC supply and the transformer" (the AC
supply is now Mains), "The bridge rectifier".

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
  With no period yet (or lost), the swing is taken over at most `TONE_WINDOW_S` (0.1 s,
  `spanAt`; 2026-10-22, from the regrade): a 555 straight into 100 µF and 8 Ω put 2.5 V
  across the coil at Run while the capacitor charged, its middle set so high the ±0.4 V
  tone never crossed it — silent all run. Now heard ~0.1 s after Run.
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
  ring lights (`part-discrete--playing`). **Its coil HEATS** (Jason, 2026-10-22: "release
  smoke on a speaker over power by 200%"): `speakerWatts` — a live tone's
  (hi² + lo²)/2Z (a square's between its swing's ends, DC included), else the steady
  (Va − Vb)²/Z — followed by a lag of `SPEAKER_HEAT_TAU_S` 1 s (assumption), booked at
  the MEAN of the two ticks' watts, carried in `analog.speakerHeats` `{heat, watts, at}`
  for in-scope speakers only. `speaker-power` past `SPEAKER_RATED_W` 0.5 W (heat AND
  watts both over); at `SPEAKER_SMOKE_W` (2× rated) `speaker-burnt` and the coil burns
  OPEN: its `lampTopology` resistor key (`sp.key`, `resistorKey` of its two pin
  addresses) joins `analog.burnt`, which voltages.js skips in BOTH resistor sites (the
  cluster branches and `railFlows`' `railBranches`), from the next tick (`unsettled`
  brings it soon). A burnt one is out of `tones`, its `bench` reading `{burnt: true}`
  → SimOverlay `setBurnt` + `#burnt` (grey smoke, 3D too) + hover `desk.speaker.burnt`;
  toasts keyed `speaker:<comp>` (the burn replaces the warning, sticky danger). Wakes
  `speakerReadIn`: the burn, ≤ 0.1 s, and ≤ what would book a tenth of its burn at one
  read's power (`HEAT_GRAIN` — 12 V through 1000 µF is 18 W for a millisecond, and booked
  across a whole step it burnt a coil that never warmed). 5 V across 8 Ω burns at 0.39 s.
  Matches the 555's own measured readout exactly at
  456 Hz (stepped), 4.6 kHz and 20 kHz (drawn). Pre-existing, not the speaker's: a
  555 at ~45 kHz into an RC-coupled load warns `oscillation` (never becomes a cycle).
- **The bridge rectifier** (2026-10-19; parts.md has the part): its four diodes are
  junctions of the solve like any diode's, but on **`BRIDGE_SPEC`** (spice/diodes.js),
  the second common junction — a 1 A rectifier die's curve, the 1N4007 vendor card (Is
  7.028 nA, n 1.808, Rs 0.0342 Ω: 0.86 V at 0.5 A, under the DB10x sheet's 1.0 V max),
  one set for every bridge whatever its part number (`diodeSpec` answers it for
  `def.rectifier`). Its `rthJA` is DERIVED, flagged at the spec: the burn is instant, and
  at the package's real 40 °C/W a DB105 burned on the first charging pulse into a
  reservoir capacitor, so `rthJA` is the 30 A surge rating (`BRIDGE_SURGE_A`) restated —
  Tj max is reached at 30 A. Each junction has its own key, `<id>#d1…d4`
  (`lamps.js` `diodeKeys` — the ONE statement; a one-pair diode keeps its bare id), and
  `SimOverlay#updateDiodes` reads the part burnt if any is. The device deck writes them as
  `D1N4007` (`spec.device`). `tests/bridge-rectifier.test.js` holds it full-wave off the
  120 → 12 V transformer: + is |secondary| less two drops on both halves, never below −.
  **Its curve is SIMPLER** (Jason, 2026-10-20 — speed): `BRIDGE_FIT`, a
  `fittedTable` (junction-table.js) of the same die — each piece as long as keeps it
  within 20 mV of the curve, lifted 10 mV, so ±10 mV from 100 µA to 4 A: 7 pieces where
  the full table has 22. Every table sample is a corner, a corner is a re-linearization of
  the whole transformer/capacitor/regulator group, and a conducting bridge diode crosses
  every one twice a half-cycle — so the 5 V supply desk ran 2.2× faster (1551 → 623
  ticks per 0.5 s). Graded: the golden area `rectifier` (`bridgeSupply` — 120 V~ → the
  120 → 12 V transformer → a DB105 → C ∥ R, 10k/47µ, 100/470µ, 22/2.2m, `device` against
  the 1N4007 card, and 100/470µ `same`), all A, worst −0.47 % (the full table's own worst
  there was −1.08 %). The deck now writes an AC supply (`VAC…` SIN about N, N ground)
  and a transformer (its two coils, `K`, and `transformerResistors`). Tolerances tried:
  ±20 mV bought only 3 % more, ±5 mV cost 10 %. The rectifier diode GRADE keeps the
  full table (four of them as a bridge run the old speed).
- **The AC supply (now Mains) and the transformer** (2026-10-18, no feature number, branch
  `ac-timebase`; `catalog/ac-parts.js`, both `spiceOnly` bricks in COMPONENTS ▸ Power,
  ids `ac<n>` / `xfmr<n>`, their counters `nextAcId`/`nextTransformerId` stored only
  once used, like the load's). To the logic engine each is NOTHING (no net driven or
  grounded, a brick's terminals never bridged) — so engine-parity exempts the four
  example desktops (`AC`), and `tests/spice-ac-examples.test.js` is their proof.
  - **The AC supply** (Mains since 2026-10-21; its params changed 2026-10-22, below):
    L is a sine about N. It was `{hz, peak, trough}` with Custom… peaks and rate (the
    value parser still reads a SIGNED field — a range below zero takes `-`/`−`/`–` or
    none; across zero, as typed — and `formatComponentValue` prints `−`).
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
  - **Mains + the AC adapter** (2026-10-21, Jason: two bricks — mains, 120/240 by
    country, and an adapter with mains in on its primary and its secondary to the
    board; it REPLACED the 2026-10-20 Isolated switch on the AC supply, never
    released). The `ac` kind is now titled **Mains** (ids `ac<n>` unchanged): Output
    100/120/230/240 V~, always EARTHED — `normalizeParams` drops a stored `neutral`.
    **No Custom… since 2026-10-22** (Jason approved: "the adapter is the AC supply;
    mains + transformer the inside-a-linear-supply pair; the buzz its own brick"):
    params `{hz, rms}` — Output a SEGMENTED `rms` field (`labelKey: "output"`),
    Frequency `WALL_FREQUENCY_FIELD` (segmented `hz`, `labelKey: "frequency"`,
    shared with the adapter); a stored `{peak, trough}` (any pair, from before) reads
    as the NEAREST of the four, a stored rate as the nearer of 50/60; `mainsSineOf`
    gives `{hz, peak, trough}` for `acSupplies`, `acBadge` → "120 V~"/"60 Hz".
  - **The signal generator — REMOVED** (built 2026-10-22, `siggen`, ids `gen<n>`, an
    earthed sine of any rate/amplitude/offset; removed the same day, Jason: "Remove the
    signal-generator. I don't really see it's worth" — its 4 kHz–10 kHz tones aliased on
    the desk's tick cadence). Gone with it: `SIGNAL_DEF`, `signalSineOf`, `signalBadge`,
    `siggen-view.js`, the `fastSignal` advice and the combo field's `advise` hook in
    part-properties-dialog.js, the KiCad "SIGNAL IN" header, `nextSigGenId`. A desk
    holding one drops it on load as an unknown part. The Zero crossing/Schmitt examples
    lost their buzz; the tests that used it for a low-voltage earthed sine use a 60 Hz
    AC adapter with S2 on the supply's − (its 0.1·rms Ω behind it). `EARTHED_AC` is
    mains alone; `edgeAt` (below) stays, for mains and the adapter.
  - **An AC wave's crossing of a pin's threshold is an EDGE** (2026-10-22, Jason:
    "treat each point where the wave crosses a logic input's threshold as an exact
    tick"). The spice tick reports `edgeAt` beside `wakeAt`: `nextCrossing(t)` over the
    islands a running AC wave drives (`s.waves` with `ac`, `waveRuns`) that a listener
    (`heard.list`) listens on — not drawn, chattering or capped — its corners included
    (a crossing past a corner is timed only once it is reached). SimController keeps
    `#edgeAt` (reset with `#frameAt`, carried by `exportRun`/`importRun`) and
    `#nextEvent` takes it UNCLAMPED, as a clock edge, where every other wake waits
    `MIN_SHOWN_S`. A 555's own crossings (no AC wave) keep the clamp, so cycles.js
    still recognises fast oscillators. Measured at SimController's cadence: 74LS14
    output flips shown 800/800 at 4 kHz and 2000/2000 at 10 kHz (was 0), costing
    4.5× / 9.9× real time headless — slowed, as a 10 kHz clock is (measured on the
    signal generator, since removed). Tests: `spice-ac.test.js` (a 60 Hz adapter's
    edges at cadence, a ÷10 counting each cycle, `edgeAt` null for a 555 and for an
    AC wave nothing listens to), `sim-controller-timing.test.js` (two flips a
    cycle).
  - **The analyzer's flat voltage stretches** (2026-10-22, found running a 4 kHz buzz
    slowed to ×0.2). Two causes, both fixed. (1) `#runBatch` drew the frames up to
    the `target` it set out for even when the budget ran out — the sim clock had
    gone BACK to the last tick, so those frames read past events still unrun (every
    non-node net held at the last tick's value) and the next batch's ticks went back
    in time under them (58 reversals, up to 34 ms, in 4 s); now `#emitFrames(min(target,
    simNow()))`. `sim-controller-timing.test.js` "a batch out of budget…" (a wall
    clock costing 1 ms a read; its `fakeDoc` now has `scopeChannels`). (2) A frame
    (`sampleAnalog`) read only NODES off their curves; a net that is no node (an
    adapter's S1, an op-amp's output, a divider tap) stood at the last tick's value
    between ticks. SimController now passes `spice.frameNets` (the analyzer's net
    channels + ground lead, `#frameNets`, cached per snapshot) and, while anything
    moves (`frameAt` — until 2026-10-23 only when a frame came before the next tick;
    the analyzer's curve samples fall between any two), the engine states each such
    net in the nodes —
    `analog.statements`, net → `{c0, terms}` from `volt.affine` (exact until the
    next event; drawn islands skipped) — which `sampleAnalog` evaluates (`coil:`
    terms off the coils). `ac-adapter.test.js` holds a frame to a tick at that
    moment within 1 mV. A NEW one starts at the OS's
    country (`app:region` → `app.getLocaleCountryCode()`, `mainsForCountry` /
    `mainsParamsFor` / `adapterParamsFor`, seeded in app.js's palette pick; 120/60
    fallback). The **AC adapter** (`ADAPTER_DEF`, kind `adapter`, ids `adp<n>`,
    `nextAdapterId` optional) is its OUTPUT ALONE (Jason, 2026-10-22: "drop the
    input voltage and just focus on the output … this can be achieved with the
    transformer"): plugged into the wall, no L/N terminals, never wired to a mains
    brick. Terminals S1 S2; params `{hz, rms}` — Output preset 9/12/16/18/24 +
    Custom… 1–48 V, and Frequency (2026-10-22, Jason) a SEGMENTED 50/60 Hz, no
    Custom…, its param `hz` but labelled through `labelKey: "frequency"`
    (part-properties-dialog.js `fieldLabel` — `properties.field.hz` is the
    clock's "Rate"); seeded from the country (`adapterParamsFor`), shown on the
    brick; edited mid-run it carries on at its phase (`acShiftAt`, as mains). It is always an
    `isolated` entry of `acSupplies` whose params are `adapterSineOf` (its own
    sine, phase 0 at Run), on `internalNet(id, "sine")`, held by the "v" device
    (analog-devices.js) behind its OWN `ohms` (`adapterOhms` = 10 % of rms at a rated
    1 A, 1.2 Ω for 12 V; `sourceOhms(br)`, `AC_SOURCE_OHMS` the fallback) —
    assumptions, flagged. Model is an ideal source behind a resistance — no
    magnetising inductance, so it is as fast as the old isolated supply. (The first
    cut, 2026-10-21, had a plug wired to a mains brick, a rated Input that scaled
    the mains, and a 1 W idle resistor across the plug; all removed.)
  - **A floating circuit's ground** (`sim/floating-grounds.js`, Jason: "traverse to
    where it becomes DC"): GALVANIC islands (union-find over every part's pins by
    `conductingSides` — a capacitor's leads apart, a transformer's two sides
    apart, an opto's LED from its output, a relay's coil from its contacts,
    everything else one group); an adapter's output island with no PSU terminal,
    mains terminal, signal flag, Arduino Input tag or data-bus pin set 0/1 (one left Z
    holds nothing — 2026-10-22; nor is it a bench source to `wiredLow`) on it gets ONE ground: the
    analyzer's ground lead (`doc.scopeGround`) if on it → the first − rail strip net →
    a bridge's − (`def.rectifier`, pin named "-") → a fixed regulator's GND → S2.
    `floatingGrounds` (memo per netlist + lead) feeds `fixedFacts.floating` →
    `buildContext` adds each to `supplyMinus` (hooks only, after the no-ground rule),
    rc-trace counts them −, the deck names them "0". Held hard, not by
    `AC_REFERENCE_OHMS` (that tie stays as the fallback in `voltageTopology`): tied,
    every capacitor on the rail was a common mode `balance`d at every corner. Jason's
    Regulated 5V desk rebuilt on a 12 V~ adapter reads 5.000 V flat. Golden
    `bridge-adapter-100-470uF` (device and same), A. Grounding a bridge's − AND one of
    its ~ pins still shorts a diode, as on the bench.
  - **The analyzer's ground lead** (`doc.scopeGround`, a member address, stored only
    when set; `DeskDoc.scopeGround`/`setScopeGround`, the controller's
    `setScopeGround` — an undo step, allowed while running): the probe's right-click
    menu "Use as analyzer ground" / "Remove analyzer ground" (offered where there is
    an analyzer), the header chip `.scope-ground` (⏚, the net's name or address, ×),
    the desk marker `ScopeGroundMarker` (overlay, pointer-inert, re-placed on
    doc-changed/desk-loaded). ONE per desk, shared by every voltage lane:
    `readVoltsAgainst(ref, ground, detail)` = V(ref) − V(lead) (a lead with no voltage
    reads 0 V). Per-channel references were not built. The Worker's sim-tick cut keeps
    the lead's net beside the channels' (`sim-worker-host.js` `scopeNets`, the regrade,
    2026-10-22: cut off, every lane read against 0 V on the Worker — the default).
  - **Found by it, fixed** (2026-10-21, voltages.js `noteUsed`): `fixedUsed`/`coilUsed`
    — what a PAUSED island's node is told it still stands at (`nodeVoltUsed`) — were
    recorded by passes only, so a node a `prime`/`resolve` had re-solved since was told
    its older value: the carried settle saw no change, the full one re-solved, and the
    two parted (any wave island paused beside another supply group's corners —
    `engine-incremental.test.js` "a wave's island paused"). Now recorded after every
    solve.
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
    2026-10-18), keyed and titled by `acBadge`/`adapterBadge`/`transformerBadge`
    (`exact: true` where there are figures) — so two adapters a volt apart, or two
    transformers of one ratio, are two lines; the desk's badge keeps three figures.
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
    the catch-up budget), so a Schmitt chattering at a corner is capped and backs off.
    **So is a corner its group comes out of GROWING** (`scale.grow` finite on a node the
    corner names — the regrade, 2026-10-23): two CD4007UB inverters round an RC are a
    regenerative loop part-way through its pieces, its swing found only in a settle, and
    left to the next event — a wake held `MIN_SHOWN_S` past the last tick — the astable's
    period stood on that hold (2.000 ms held, 1.850 ticked every 50 µs; now 1.811 and
    1.819, `spice-grade-fixes.test.js`). An
    op-amp's INPUTS are no listeners (`spice/listeners.js` skips `def.opAmps`): a
    crossing of a logic threshold there is no event, and listening woke an AC comparator
    twice a cycle for nothing. **The op-amp in time** (the regrade, 2026-10-22, voltages.js
    `linearize`): a node read a millivolt ahead whose network puts an op-amp's output on
    the far side of its swing (`swungAcross`) stands at a Schmitt threshold — the cluster
    takes that side NOW (`adoptSwing`, the far balance solved where the node stands) and
    the node is read from there; read across it, the swing over a millivolt was a balance
    microseconds ahead the node sat on for good (an LM358 relaxation oscillator stopped
    after two crossings). And in a cluster with an op-amp a corner INSIDE the nudge is
    bisected (the linear region is µV wide; the search ahead started past the nudge), so
    a comparator on a capacitor reaches its rail at its crossing, not at the next event.
    `cornerWaits` never holds a corner on an island with an op-amp to its frame (a
    comparator on a 10 Hz triangle switched at 6 V/3 V for 4.5 V). A GROUP's swing is
    taken too (`adoptGroupSwing`, called from `runGroup`'s `linearized` on a cluster with
    an op-amp: the base solve already across from the stored volts, or a nudge on): the
    group's model was read across it, but nothing kept it, so a triangle generator's square
    output, solved at the frame from where it stood, sat LOW in its band at every frame.
    **The swing in the solve** (spice/network.js): balanced with an op-amp output across
    its swing from the edge it came in at (`swungFromEntry`), the edge it came from is
    tried first (`heldFall` → `holdEdges`: outputs held, the rest balanced, let go; kept if
    balanced and stable) — inside a Schmitt band both edges balance, and from a pinned
    guess Newton took whichever, a millivolt and a half early; and a knife-edge falls by
    holding each output at the edge its runaway mode heads for (`swingFall`) before the
    backward-Euler steps (sixty a fall, from steps as short as the output's
    transconductance). `farCorner` first tries the corner read STRAIGHT off the network's
    constraints from one more solve (`straightCorner`; network piecewise linear on its
    pieces) and the one this tick last found from the same pieces (`cornerMemo`), each
    verified a bisection's precision (`CORNER_V` 1e-7) either side, else bounding the
    bisection. LM358 relaxation oscillator, wall per simulated second: 100 nF 29 s → 1.3 s,
    1 µF 5.6 → 0.3 s; 10 nF and 1 nF drawn (0.2 s).
    **The LM358 performance pass** (Jason, 2026-10-22: "look at the performance of running
    the LM358"): a network with an op-amp takes `OPAMP_NEWTON` (6) of Newton's steps, then
    `swingRetry` (the edge it came in at first — `entrySide` — then the other, then the
    output stood where its gain puts it, for a comparator at its crossing), then the rest;
    a release from a held edge gets `OPAMP_NEWTON` steps too, and an edge `swingRetry` saw
    fail is not held again by `heldFall` (`failedEdges`). `opAmpStepCut` reads a current
    limit along the piece the op-amp STARTS on (`pieceOf` — read at the step's end, an
    output saturated HIGH whose input crossed was "at" its sink limit a twentieth of the
    way, and a comparator's input crawled to a sine's crest in sixty steps). `pinnedAt`
    memoizes its solves by voltage (`linearize` read v0 and v0 ± a millivolt three or four
    times). `adoptGroupSwing` only looks in a cluster whose op-amp output reaches its own
    + input (`fedBack`, cached per cluster; a follower or comparator never swings of
    itself). Cycles: an island's timeline is CARRIED to the next tick on the same desk,
    settled (`analog.timelines`; a 1–2 kHz cycle is longer than a tick and was never
    found), and dropped when its cycle is entered (a carried pre-draw moment matched
    1.6 periods on); an unheard island's cycle needs only `MIN_SWING_UNHEARD` (0.1 %) of
    swing (a Schmitt with 1 MΩ feedback swings its capacitor 37 mV). Now, wall per
    simulated second: 100 nF + LED 34 s → 1.4 s, 1.5 kHz 1.5 s → 0.04 s (drawn), 1 MΩ
    feedback 20–2400 s → 0.07–0.17 s (drawn), a comparator on a 1 kHz sine ~0.9 s.
    **A group whose linear piece will not start where its plates balanced** (runGroup,
    `disagree` after `GROUP_ROUNDS`; the regrade, 2026-10-22): an integrator's op-amp leaving
    saturation is read at its sink limit — a fixed current holding neither plate — and the
    common mode balanced 195 V away (OUT −188 V, then −560 V). Then the group is read with
    each plate's stray (`strayOnly`: as a floating one is, never marked `floating` for the
    next piece), the common mode a fast state, and its corner — back in its band — comes
    nanoseconds on.
  - **Known, not fixed**: a bridge rectifier on the transformer is slow — every
    diode-table corner is a re-linearization, and many wake a tick. Measured with four
    discrete diodes before the bridge part: ~8 s per simulated second in the app. On the
    5 V supply desk (2026-10-20, headless): 3.5 s per 0.5 s simulated, then 1.6 s after a
    bit-identical speed pass (`heldAt` reads the network's SHAPE instead of solving it;
    `piecesAt`/`nullVector` lost their per-call allocations), then 0.77 s on the bridge's
    simpler curve ("The bridge rectifier" above). So no rectifier example ships; four
    bridge diodes burning at once leave the winding current in its shunt for a moment (a
    megavolt spike in that tick's readout). And a STRESS LIMIT is no corner: an input
    past 7 V or a clamp past its rating between two ticks is only seen at a tick —
    found when the Clipping example's Zener shipped with no `zenerVolts` (a plain diode,
    17 V on a 74LS14 input, and no tick in the positive half ever said so; fixed in the
    demo, 2026-10-18, and its test reads the clip at the peak).



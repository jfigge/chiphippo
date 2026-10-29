---
paths:
  - "src/web/scripts/catalog/meter.js"
  - "src/web/scripts/model/meter-probes.js"
  - "src/web/scripts/model/meter-display.js"
  - "src/web/scripts/sim/meter-average.js"
  - "src/web/scripts/sim/meter-offline.js"
  - "src/web/scripts/sim/meter-fuse.js"
  - "src/web/scripts/components/meter-view.js"
  - "src/web/scripts/components/meter-probe-layer.js"
  - "src/web/scripts/components/meter-bench.js"
  - "src/web/scripts/tests/meter.test.js"
  - "src/web/scripts/tests/meter-sim.test.js"
  - "src/web/scripts/tests/meter-desk.test.js"
  - "src/web/scripts/tests/meter-fixes-1027.test.js"
  - "src/web/docs/multimeter.md"
  - "features/chiphippo-multimeter-prompt.md"
---

## The multimeter

Built 2026-10-25 from `features/chiphippo-multimeter-prompt.md` (Phase 1, then Phase 2 the
same day on Jason's go-ahead), modelled on a
real **Brymen BM235** (manual P/N 7M1C-1501-0000; the lygte-info.dk measured unit for
the figures the manual does not give). A Spice-Lite-only desk brick (`spiceOnly`, kind and
ref `meter`, ids `dmm<n>`, `nextMeterId`), true size 32×63 pitch, `terminals: []`.

- **Not in the tray** (Jason, 2026-10-26): the def is `trayless` (palette-panel.js filters
  it beside `retired`), and the toolbar's **Add Multimeter** segment (app.js, after
  Analyzer) calls `DeskController.addMeter()` — another meter out, up to `MAX_METERS` (3),
  at full size, at `meterSpot` (model/meter-probes.js: in the view,
  rightmost then topmost, stepping left a body and its probes' room past each meter already
  out, else right of everything). An action, not a toggle — no pressed state, no count
  badge (Jason: no badges); `syncMeter` disables it at the limit (doc-changed,
  desk-loaded), and it is hidden while Spice Lite is off. Each meter is put away from its
  OWN right-click menu (Properties… · Put Away → `putMeterAway`). One undo step each, both
  allowed while running.
- **It FLOATS over the desk** (Jason, 2026-10-26): its view is in its own `.layer-meters`
  (above annotations, below `.layer-signals`, so only its probes and leads lie on it);
  `DeskDoc.canPlaceBrick("meter")` is always true and `#brickRects` leaves meters out, so
  nothing is refused for lying under it. `#onPartPointerDown` hands a meter press to
  `#onMeterPointerDown`, which ALWAYS stops the event (a tool's click, a band, a pin pick
  reach nothing under it), works the front panel, else drags the body (`drag-brick`, no
  selection — stopped or running; a running drag commits). DeskSelection refuses it in
  `selectComponent`, `toggleComponentSelection` and `setMulti`; the hover readout and pin
  mode stand down over `.part-meter`. `meterSpot` puts a new one at the view's right
  (room kept for its resting probes), over whatever is there.
- **The needles are mid steel grey** (`--color-meter-probe-metal` #80868e, 2D and 3D) —
  Jason, 2026-10-26: no marker dot; the original #c8ccd2 vanished on the pale board and a
  near-black one against the black probe's body, so a middle ground.

- **Probes live in the meter's params**, never in occupancy: `{at: address}` on a hole or a
  brick terminal (a TAKEN hole too — a probe touches a lead, it holds nothing), or
  `{dx, dy}` lying loose relative to the meter. `DeskDoc.setMeterProbe`/`canProbeAt`
  (`isRealPoint`, less the holes under a part's BODY — a 600-mil chip's rows e–g, which no
  tip can reach and a wire end is refused too; the drag hoists `coveredAddresses()` once,
  2026-10-27); `#detachProbes` lays a probe down where it was when its board or
  part goes; **a probe is pushed out of its hole by what is pressed into it**
  (`DeskDoc.pressProbesOff`, run by DeskController `#emitDocChanged` before the history
  records, so it is one undo step with the edit; 2026-10-27): a body now over the hole (a
  600-mil chip seated across it), or a lead in a hole that held none when the last edit
  ended (`#probeHoles`, noted at load/restore/`setMeterProbe`) — it lies where its tip was.
  An edit that moves no lead skips the look (its whole-desk occupancy, +3 ms an edit on
  busy64): `SEAT_NEUTRAL_LABELS` (data pin, net names, analyzer, annotations, schematic,
  wire/board metadata), and a switch toggle or Properties change whose part's
  `DeskDoc.seatKey` (its pins' and body's addresses; a meter's probes) is unchanged — the
  `seatsKept` option of `#emitDocChanged` (2026-10-27).
  A probe put on a hole a lead is already in stays (it touches the lead); the loader lays
  one under a body down too; the loader resets an `at` that names nothing to resting. The red plug's jack
  is `params.jack` (COM is fixed for black). The drag is `drag-meter-probe`, HELD BY THE TOP OF THE
  PROBE'S BODY just behind the guard (Jason, 2026-10-26: so the hand doesn't hide what the
  tip touches) — the pointer is the grip, the tip `PROBE.grip` (2.9) back down the body
  (meter-probe-layer.js `tipFromGrip`, exact: the grip lies on the tip→jack axis), and the
  snap and its ring are the TIP's; allowed while
  RUNNING (a meter is used on a live circuit), Option/Alt passing through to the lead under
  it; the front panel (dial stops, SELECT/RANGE/HOLD, jacks) is a PRESS, not a drag.
- **The element between the probes is the dial's** (`meterSetup`): V/mV 10 MΩ · AutoV
  LoZ 2.1 kΩ · Ω 1.6 V behind 8 kΩ · diode 3.2 V behind 9.7 kΩ · shunts µA 100 Ω, mA
  1.9 Ω, A 0.04 Ω. The 10A jack's A shunt is wired whatever the dial says; a red lead in a
  current jack off the current positions is **InEr** (the Beep-Jack warning). F1 0.4 A
  (µA mA), F2 11 A (10A): run latches `fuseF1`/`fuseF2` in `RUN_LATCHES`, blowing past
  10 ms over or at once past 10×, a danger toast, mended at Stop like smoke. "At once" is
  past 10× for `FUSE_SURGE_S` (1 ms, sim-controller.js; 2026-10-26): since a supply starts
  at its set volts, its 470 µF empties through a 10A shunt at Run — 125 A for tens of µs,
  far under a fuse's I²t — and an instant rule blew F2 at the first tick.
  **"Over" is the fuse's HEAT** (the review's fix round, 2026-10-26): I² through one lag of
  `FUSE_TAU_S` (10 ms — an ASSUMPTION, no curve given), each tick's current held to the
  next and every between-tick sample (#sampleMeters) booked too (`#heatFuse`, carried in
  `#fuseOver` `{heat, mean, amps, at, over, surge, from, i2dt}`, exported with the run —
  the model is `sim/meter-fuse.js`, pure, since 2026-10-27); `FUSE_HOLD_S`
  counts from when the heat passed the rating², the surge rule stays on the instant's
  current. So a DC step blows a fraction of τ after 10 ms (1.25 A on F1: ~11 ms), and an
  AC current by its RMS (0.92 A RMS on F1 blows, 0.399 never) — the per-tick timer reset
  at every zero crossing, and an AC desk ticks only every ¼ s besides. **The timer stops
  only when the heat AND its mean are under the rating** (the regrade, 2026-10-27): the
  heat's 100/120 Hz ripple through τ is ±13 %, so 0.40–0.43 A RMS dipped under every half
  cycle and never blew while 0.41 A DC blew in 40 ms; `mean` is a second lag on the heat
  (`FUSE_MEAN_S` 50 ms, both exact for a held current), so AC and DC now part at the same
  RMS (0.401 A; DC timing unchanged, AC near the rating ~0.2 s). Samples between ticks are
  booked as RAMPS (`ramp`: I² of a straight line, (a²+ab+b²)/3) — held, a sine's few
  straight samples across its zero crossings booked their start's I² and 0.399 A RMS heated
  as 0.41. A sample that blows it stops the samples there and sets `#fuseAt` to that
  moment; the toast's amps is `fuseAmps`, the RMS over the overload — from where the
  current last stopped falling before it passed the rating (`dip`/`pre`: an AC current's
  zero crossing, a DC step's own moment; a record begun on a current already flowing
  — a cool fuse is forgotten — takes its first ramp back to zero, `fresh`), to its last
  low point (`closed`: whole half-cycles; between the first and last inside where there
  are two), a ramp through zero split at the crossing when the samples are signed — a
  DC current's own, an AC one's RMS within 1 % (0.6 A RMS read 0.653 when the window
  opened on the first instant past the rating, 2026-10-27), never a peak. The view hears the latch through
  `syncFuses` (DeskController's doc-changed listener; the run writes it straight into
  the document), and a view removed (Put Away, `#rebuildScene`) turns its beep off.
- **In Spice Lite it is analog device kind `"x"`** — a Thévenin `{pos, neg, volts, ohms,
  earthOhms}` (`analog-devices.js` `meterAmps`/`meterSlope`; `network.js` floors it with
  the sources), reading back `{kind: "meter", volts, amps}` on `result.bench`. The logic
  engine reads nothing and its netlist UNIONS a shunt's two probes (a current range is a
  wire). The Spice netlist keeps them apart ALWAYS (`partsDifferBranched` gives a shunt
  desk its own branched netlist; the wiring partition never joins probes). **A meter in a
  supply's lead is just its shunt there** (phase 7c, 2026-10-27 — Jason: "I like treating
  the meter as just a shunt resistor in the circuit to fix all issues at once"; the
  join — `meterSides`, the `<meter>~rail` stand-in supply handed to the logic engine,
  `meterBurden`/`analog.burden`/`BURDEN_SETTLES`, `meterSag`'s brown-out rule,
  `fedElsewhere`, `seriesAmps` — is GONE): what lies past it is fed through a resistor of
  the shunt's ohms, every chip there OFF THE RAILS (`chipVolts`: its status, stages and
  readings from its own pins), its reading the current through that resistor off the
  solve. Graded against ngspice (the deck writes the shunt as the resistor it is and a chip
  off the rails at the volts the reference itself puts across it — spice-grading.md):
  both leads metered, a − lead chip driving an LED from its lifted ground and sinking one,
  two meters chained, a limited supply judged with the shunt counted, 100 µF charging
  through the shunt (τ = R·C) — all A, 0.00–0.03 %. Same result as its resistor twin
  (`meter-fixes-1027.test.js`). `seriesReading` (model/meter-probes.js) is a stub that
  reads `result.bench`, left for SimController's import until it drops its `series` path.
  **What keeps it fast — the far rail is a HUB** (spice/voltages.js `meterHubs`): solved
  as one network a busy board past an mA meter was one cluster of every chip's nets, ×330
  a tick (104 ms on busy4; 2 slices ×130). The far net of a shunt in a supply's lead that
  a chip's VCC/GND pin is on (and a shunt's from such a net onward — chained), with no
  capacitor, coil or bench source on it, is put in `rails`: its chips are `split` off-rail
  chips (`offRail.hub`) whose stages are DRIVERS at the rail's volts (`hubStage` — the "s"
  branch with both ends fixed; a LOW a channel, as `offStageCurrent`'s `both`), so each net
  they drive is solved alone (`isLone`) as on a real rail. The rail's volts
  (`analog.voltages.hubVolts`, in `plan.railVolts` via `withHubs`, the plan's signature
  saying where) are found by `settleHubs` at the end of every `solveDirtyClusters`: KCL at
  the rail — each cluster's current into it (`noteHubFlows`: `currentInto` the rail's
  node plus its hub stages' and hub-fed clocks', stored per cluster in `hubFlows`'
  `hubSlots`) plus the parts straight on it (`hubRail`: shunts, loads, junctions, kept per
  plan where that is all — `hubsPlain`) — Newton with the rails' own slopes and the
  networks' read off the last move (`hubSlope`, a secant), each move re-solving the
  clusters on it (`hubClusters`). **Held within `HUB_EPS` (5 mV)**: every chip on it reads
  its supply off it, so a move is a new plan and a whole-desk solve; at DROOP_EPS a clock's
  LOW sinking four 74LS inputs' bias outside a − lead meter (0.9 mA, 1.7 mV) re-solved the
  busy board four times a tick. The SHUNT reads the balance all the same
  (`hubFeedVolts`: the rail moved by `settleHubs`' own Newton step, `hubStep` — the
  networks' secant included; round 2, 2026-10-27: moved over the shunts' conductance
  alone, a 74LS04 behind a µA meter in its − lead read 1.14 % over its own shunt's drop —
  used for its `result.bench` reading and its draw), and the net shows its balance (`volts`), while
  `chipVolts`/`voltOfNet` read the held value (`hubVolts` before a tick's first plan — read
  off `volts` there, the chips' volts flipped every tick and re-solved the desk). At SET a
  hub moves with the rail its shunt is on (`atSetPlan`). **A hub starts near its balance**
  (`seedHubs`, round 2, 2026-10-27): the rail its shunt is on less the shunt's drop at
  its chips' ICC (their loads' conductance as the first `hubSlope`), placed BEFORE a
  fresh side's first context (spice/engine.js → `volt.placeHubs`, from the caller's logic
  context via `hubTopology` — never cached as the netlist's topology) so its chips read
  powered there: from the supply's own rail, unpowered at the first context, busy4's
  first tick solved every cluster twice and moved the rail (501 cluster solves for the
  bare board's 223; now 223, and 942 → 662 over 41 ticks — the rest is the first edge's
  load change crossing `HUB_EPS`, one move). Perf (busy4, the clock on the
  supply, separate processes, medians of 7 against the joined meter): + lead mA +0.9 %,
  − lead mA +9.4 %, 10A −7 / −4 %, µA ±4 % (the board browns out either way); no meter
  +0.4 % (noise). A meter whose far net has a capacitor is no hub (its inrush is the
  solve's) — a big board behind a decoupled meter is the slow one-cluster solve.
  **A clock brick past a meter** is fed through the shunt: the logic engine powers no clock
  off the rails, so it is UNPOWERED until sim/engine.js reads `hooks.clockVolts` (Spice
  Lite answers it; the voltage side already names such a clock a source of its networks,
  `clockHub`, driving only once powered, and books its current to the hub). The 74LS
  input bias is INSIDE its chip's ICC off the rails too (voltages.js, the "s" input
  stage's `feed` is its ground — drawn from VCC, a busy board through a meter read 40 mA
  where the supply delivers 25).
- **A probe straight on a lone terminal is a lead there** (2026-10-26):
  `probedNets(doc, netlist)` (model/meter-probes.js — the nets a meter with BOTH probes
  down touches) counts as wired in `acSupplies` (adapter S1/S2, mains L/N) and
  `inductorTopology` (a transformer winding's ends). A terminal alone on its net is a
  net of one point, and a probe is no netlist point, so a voltmeter on an adapter's
  S1/S2, nothing else wired, read 0 V and an mA meter closing its loop at S2 read 0.
- **Readings are windows** (`SimController`): the probes' voltage booked every tick and
  sampled between ticks (`scopeSamples`), integrated by `MeterAverage` (trapezoids of v and
  v², `hold` before each tick so a step is a step, the window bounded by the next pending
  event), taken every 200 ms of wall time → sim-state `meters`. **DC over whole periods**
  (2026-10-26): once a Hz band has locked (`#frequencies` > 0), `take()`'s mean is the
  integral between rising crossings (`sums`, the counter's running integral booked at
  each rise beside `rises`) from the window's start on, or the last period where the
  window holds less than one (`#wholeMean`) — a 200 ms boxcar's ragged ends read a 12 V~
  as ±0.37 V DC and a 25 % PWM 1.216–1.275. The trigger's reference stays the window's
  own mean; RMS is unchanged. `#meterKeys` rides `exportRun`/`importRun` (else the first
  `#meterList` on the other thread forgot every imported window). A desk that comes to rest
  between windows is still owed the next one (`#meterOwed`, armed by `#arm` and published
  by `#runBatch` with nothing ticked) — else the display kept the window from Run for good.
  …and owed one more while the window shown began before the last tick (`#meterFrom` <
  `#tickAt`; 2026-10-27): the window taken AT an edge is the level before it, so a 1 Hz
  clock's display stood a half-cycle behind and a held signal read the old level until
  release; now the new level shows within one 200 ms update. DC is the mean; AC the
  AC-coupled RMS. `meterDisplay` turns a window into 6000 counts: auto-range up past the
  limit, down below 500; RANGE/HOLD live in the VIEW; OL; `----` for AutoV under 1 V;
  continuity under 161 Ω. The LCD's sign bar is a `-` before a digit only (`----` is
  dashes); HOLD never hides InEr (`setup.inErr`); REC books each reading object once —
  stopped, the bench's (`#offline`, or one frozen `OPEN`), not one per render.
- **Stopped, the bench runs IN TIME** (Phase 2, 2026-10-25 — Jason: yes): `MeterBench`
  (debounced 120 ms after any doc change, then pumped every 200 ms of wall time until it
  comes to rest) gives each meter on Ω/continuity/diode a `BenchRun` — started again ONLY
  where the change could move it (2026-10-26): `OffBench` is the desk with every source
  brick and EVERY meter gone, its `key` its JSON, and its netlist built once and shared
  (a test-function meter adds no point, so it is each bench's netlist too, handed to
  `BenchRun` as `{...netlist}` — the solve's caches are keyed by netlist identity and
  hold each desk's devices; a shunt meter, InEr, builds its own); `benchKey(meter)` is
  its setting plus every part the probes reach through any part's leads, each with its
  nets. Same desk key and params, or the same bench key: the bench runs on (a finished
  capacitance stays). Busy 8-slice desk: an unrelated edit 13 → 0.1 ms with one Ω meter,
  134 → 0.1 with three; one it reaches pays the keys, ~0.4 ms. The capacitance test is a
  generator (`capacitanceSteps`; `crossingSteps`/`advanceSteps`/`driveSteps`, yielding
  between ticks) run in `SLICE_MS` (8) slices, `----` meanwhile — no long task; an
  Ω/continuity/diode bench's FIRST tick is sliced the same way (`warm`, `advanceSteps(0)`,
  the slices from the task after `#start`; the display and LEDs stand meanwhile — three
  meters an edit reached were one 27–37 ms task, now ≤ ~14 ms each, 2026-10-27);
  `measureCapacitance` drains it. (sim/meter-offline.js —
  the desk with every source brick, other meter, signal and integration removed, ticked at
  the engine's own wakes and read between them off `sampleAnalog`, `arrived` = the 1 % gap):
  Ω climbs across a capacitor, volts/current read nothing. **Both probes on ONE net is a
  dead short, read as 0 V** (`BenchRun.shorted`; SimController's `#meterList` keeps such
  a meter too, its window 0 V — the solve still puts no "x" element there): it used to
  count as "touches nothing" and read OL, so a jumper across a resistor showed an open
  loop (Jason, 2026-10-26). Capacitance on a short reads nothing (no swing to time). **The LEDs it lights are DRAWN
  while stopped** (`onLamps` → `SimOverlay.setBenchLamps`, LEDs and segments, never burnt) —
  the one thing lit on a stopped desk; a red LED on the diode test is ~0.14 mA, level ≈ 0.25.
  A probe on a lone capacitor makes it an RC node: spice/engine.js `analyze`'s `reaches`
  counts a net an "x" device touches (without it a capacitor across the probes alone "went
  nowhere" and read open at once). `offlineMeterReading` (REST_S 30 s) stays for tests.
- **Capacitance** (diode position, SELECT): `measureCapacitance` TIMES it on that bench —
  from rest drive −1.6 V behind the range's R to −0.5 V, turn, time the swing to +0.5 V:
  C = Δt / (R·ln(2.1/1.1)) (`CAP_TEST`, `capOhms`: a range swings its full scale in 0.1 s,
  never under 2.9 kΩ — fitted to lygte's ~3 s for 1000 µF; all ASSUMPTIONS). A swing past
  `CAP_TIMEOUT` (1.2×) of its range's full-scale time moves up a range; past 10 mF, OL. The
  drive is `params.capDrive` on BenchRun's OWN copy of the desk (normalizeParams never keeps
  it), each turn a new netlist — and the bench is TICKED at the turn first, or the charges
  are the last tick's and the swing starts at the wrong voltage. Exact on a lone capacitor
  (±1 pF of the solve's floating stray), thrown off by anything across it. The display shows
  `----` until the wall time the measurement took (`seconds`). Running: OL.
- **Hz** (all positions with voltage or current; view state): `MeterAverage` runs a Schmitt
  trigger per `hzBands(setup)` band (half-widths in volts; V has four — the trigger ranges)
  round the last window's mean (AC-coupled), timing rising crossings by interpolation, and
  `take()` gives `hz` per band over the last `HZ_GATE_S` (1 s), 0 under `HZ_MIN` (2 Hz).
  Sensitivities are the manual's table in proportion, scaled to the measured unit's 0.1 V RMS
  on 6 V (the manual's are guarantees that a 5 V logic swing fails). **A meter on an island
  whose cycle is drawn slowed** (> 1 kHz) is read off one TRUE cycle — `cycleWindow` on the
  cycle's `cycleTemplates` (SimController `#cycleWindows`, memo per cycle): mean, RMS and Hz
  at the true rate. Before this a capped 555 read an ALIASED mean (ticks fall anywhere in a
  drawn cycle; the curves between ticks don't follow its schedule).
- **REC / Relative Zero / backlight** are the view's (meter-view.js), like RANGE/HOLD: every
  button acts on RELEASE, held ≥ `BUTTON_HOLD_MS` (1 s) its second job — SELECT backlight
  (out after 10 min), RANGE auto, REC exit, HOLD Δ. REC records each NEW reading object's
  `display.value` and chirps (`MeterBench.chirp`) on a new MAX/MIN. Not on AutoV; a dial
  turn clears them. The controller must `updateParams` the view on a dial/jack/SELECT
  change — `#emitDocChanged` re-renders no part view (a running dial turn changed the
  document and left the meter showing the old function).
- **Test equipment, left out**: schematic, BOM, build plan, AI briefs; KiCad/Digital
  exports leave it out and say `meterInSeries` when it was closing a gap. 3D draws the body
  and (Phase 2) each probe on its hole, held up towards its jack, its lead along the desk
  round the meter's near side and foot and up into the jack (`buildProbe`; the body as
  drawn, `meterSize` — compact or full).
- **Two looks** (Properties ▸ Look, `params.skin`: `volthippo` — the default, omitted —
  | `bm235`, labelled **VoltHippo** / **EEVBlog**; 2026-10-26 — the Classic body is GONE,
  and a stored `classic` reads as the Volt Hippo). Both are the BM235's body
  (`buildBody`), the band per look (`BANDS`: `bm235Band` — the EEVblog BM235's own band
  PRINT, `src/web/images/bm235-title.png` (Jason's "EEVblog BM235 overlay-r1.JPG", 685 ×
  118, the white round its arched black band cleared; tooling local in
  `.docs-build/bm235-drawing/`), 21 × 3.62 at (5.5, 3.8) standing on the band's foot,
  itself `data-meter-title`, the band's rect left clear under it (`.part-meter--bm235
  .part-meter-bm-band`) as the title's press — it replaced the drawn BRYMEN badge and
  "EEV"/"Blog"/BM235 texts, 2026-10-26 (a whole-face version from Brymen's line drawing
  was tried the same day and reverted: "restore the original design, just replace the
  title image"); `voltHippoBand` — the Chip Hippo icon, "VoltHippo" as two texts at one
  x, "Volt" `part-meter-bm-volt` silver and "Hippo" white, "True" over "RMS DMM"), the
  EF button only on the EEVBlog look (it does nothing — not modelled — so the Volt Hippo
  has none, Jason 2026-10-26), the boot per look (`--meter-boot` on `.part-meter`, blue under
  `part-meter--bm235`); the border round the face is the BM235 holster's in BOTH (Jason
  had the Volt Hippo's halved, then restored it to the EEVBlog's, 2026-10-26). The full body's boot
  and face NARROW like the real BM235's holster (Jason, 2026-10-26, from its photograph —
  "narrows in the middle and continues all the way down", not a waist that widens again):
  `METER_BODY` + `bodyOutline` (model/meter-probes.js) — full width round the LCD, each
  long side in by `waist` (boot 0.9, face 0.75) along a smoothstep from `from` 0.25 to `to`
  0.65 of the straight run, held to the foot, the bottom corners drawn in with it; the
  outline starts at the top edge's middle, which sees every point of it, so
  `mesh.extrude`'s fan from its first point fills it in 3D too. The
  compact body stays a plain rounded rect. The EEVBlog look is a MOCK-UP drawn to ask the maker whether the app may
  show it — **do not ship it as is without their permission**. The face/LCD/caps/knob
  colours are the `--color-meter-bm235-*` tokens; the CSS is ONE set of `.part-meter-*`
  rules (no `part-meter--tiered`), which is also what lets the backlight's fill win over
  the LCD's. `JACK_LAYOUTS` is `full` | `compact`, the same in both looks.
  **The look picked is the app's default** (settings `meterLook`, renderer-written):
  `#setComponentProperty` dispatches `chiphippo:settings-changed {meterLook}` for a meter's
  `skin`, app.js persists it and calls `setDefaultMeterLook`, and `addMeter` takes a meter
  out in it.
- **Size: Full | Compact** (Properties ▸ Size, a segmented field with the dialog's
  `note` under it; or a CLICK on the TITLE — the name band and the Volt Hippo's logo,
  both `data-meter-title`; Jason, 2026-10-26: a single click, not a double. A press there
  starts the ordinary body drag marked `title`, and a release that never travelled
  (`!d.active` in `#onPartPointerUp`) folds; one that travelled is a move). Either look
  folds. `params.size: "compact"`, kept only when compact; `isCompact` reads it.
  `buildCompact` keeps the band and a shorter LCD (`COMPACT_GLASS` 9 against 12) with the
  jacks in a row under it (no buttons, no dial). With no dial to turn, the leads can't be
  re-plugged either: only COM and the red lead's jack are drawn, each in its own place of
  the four, and neither carries `data-meter-jack`. A boot half the full one's width, drawn
  in the full body's frame through a viewBox from `METER_COMPACT.origin` (3, 2).
  `DeskController#foldMeter(id, compact)` (both roads; a no-op at that size already) moves
  the meter by that origin (back again opening out) so the screen stays where it was,
  shifts a loose probe's `{dx, dy}` the other way so it stays put, one undo step.
  `meterSize`, `meterRect`, `jacksOf` and the 3D model follow it; the desk's fit bounds
  still use the full `METER_SIZE`.
- **Its place and size are not in the FILE** (Jason, 2026-10-26: "Do not save the
  multimeter location or size in a project file"): `meterForFile(doc)`
  (model/meter-probes.js) drops each meter's `x`, `y` and `params.size` — a compact
  meter's loose probes put back into the full frame — and is applied in
  `projectForFile` (so save, recovery stash AND `projectSignature`: moving or folding a
  meter puts no •) and Export Desktop. The session keeps both (undo, tab switches — the
  in-memory tab docs are not stripped). `normalizeDocument` takes a meter with no x/y
  (any other brick is still dropped) and places it after the components at
  `meterSpotsBeside` — right of every board and brick (+4), level with the top board, one
  body + probe room apart.

**A hub chip's lone home cluster still books its rail pins** (2026-10-28,
`voltages.js` `homeRailPins`/`homeRailFlows`). A chip on a meter's far rail keeps its
rail-sitting pins in its HOME cluster (its first pin's); when pin 1 is a lone net — a
clock brick alone on it, or any other lone net — `noteLoneHubFlows` used to book only
that net's stages, so the 74LS bias of inputs tied to the supply's − left the hub's
balance and the − lead shunt read the whole ICC (1.55 mA where the resistor twin reads
0.45). The lone path now books those stages (inputs on the chip's own rails cancel, so
they are left out). A clock brick powered off the rails through an ordinary net is
never a source in the voltage solve — and by DESIGN its supply is a voltage REFERENCE,
not a draw (spice-lite.md → "Bench signals take their HIGH from the rail they are
given"), so a resistor-twin comparison for a chip-side-grounded clock is not a fair
reference; leave it.

**Accepted exception — a hub chip's input held LOW by a bench signal over-reads the −
lead meter** (Jason, 2026-10-28). A chip on a meter's far rail with an input held LOW by
a signal flag or a data bus books no reader stage for that input (`voltages.js`
`loneStages`, the `if (stages.length)` guard, reached from the lone-home path
`homeRailFlows`): its 74LS input current (~0.225 mA each) is counted through the − lead
shunt instead of into the signal: mA dial +4.6 % (5.1425 vs 4.9150 mA),
µA dial +3.8 %, the chip's volts 10–15 mV low; a wire to ground or a clock holding the
same input LOW reads exactly, and the + lead is exact. Repro
`/tmp/chh-regrade7/meter/adv.mjs` (`PIN1=flagL,dataL,p3flagL`, `DIAL=ua`; volatile).
ACCEPTED as not worth the risk on its own — do not report it as a finding. **But if a
more significant bug ever takes a change into `loneStages` / `homeRailFlows` /
`noteLoneHubFlows`, fold this fix in then** (book the flag- or data-held input's own
stage into the signal's side, per spice-lite.md → "Bench signals take their HIGH from
the rail they are given"), with a meter-vs-twin test for it.

**A hub's first guess is settled once, and the first edge re-solves only what moved**
(2026-10-28). The far rail is still PLACED at a guess before the first context (so the
Run tick costs what a bare board does — `spice-offrail-round2`'s guard), but it is now
carried as `hubGuess` and moved onto its balance by one Newton step at the first look of
a LATER tick that finds it at rest (the next edge's first pass, or a wake 10 ms after Run
or an edit) — never in the guess's own tick; only when it is > 0.25 mV off balance (the
10 A bench desk stays byte-identical); and on that move the hub chips' supply bypasses the
DROOP_EPS hold once (`atRest`). So a fresh run and an edited run settle on the same volts
(was 4.9970 vs 4.9991 V; now both = the twin's 4.99911 within µV), and the meter reads its
twin's shunt current. `offRailMoves`: when a new plan differs from the last ONLY in
off-rail chips' VCC (or a hub-fed clock's HIGH), only their clusters re-solve instead of
the whole desk — busy4's first edge 282 → 128 cluster solves (a bare board: 6). Getting
that to ~6 needs the guess balanced IN the Run tick (Run tick 223 → 345–412) or in an
extra wake right after Run (+5–8 % per run): neither applied.
A guess found at rest INSIDE `HUB_GUESS_EPS` (0.25 mV) is dropped (`settleHubs`, and at
tick end in `askHubWake` for a desk nothing else ticks), so it is held like any rail and
a later mid-run load change can never fire the at-rest move late; each rail keeps its own
threshold, and only rails that were guesses are marked `hubRested`. What remains after a
mid-run load change is the ordinary `HUB_EPS` (5 mV) hold: a held rail can sit ~2.6 mV
off balance (meter +0.011 %, an LED on that chip +0.08 % against the twin), exactly as
before the round — moving every hub rail at rest would cost ~128 cluster solves per edge.

**An open input on a chip whose ground is an RC-network node** (2026-10-28,
`spice/engine.js` `restate`): every input of such a chip is a LISTENER measured against
that ground, and an input whose net lost its driver by an edit (the clock wire removed)
has no voltage, so no crossing ever re-read it and `listen` kept the clock's last LOW (the
LED stayed lit). A listener with no diff, not on a node and with no solved voltage now
loses its `listen` entry, so it reads as it would from Run (HIGH for a 74LS input).
`tests/spice-open-input-listener.test.js`.

**A remount keeps the display's own state** (2026-10-28, `meter-view.js`). REC
MAX/MIN/AVG, HOLD, Relative Zero, Hz, a manual RANGE and the backlight live in the view,
and every undo that touches a board, a probe drag's ⌘Z and Properties ▸ Sound/Look
remount it — which used to wipe them (and flash OL). `remove()` PARKS that state by meter
id and a view built for the same id in the same task takes it back (cleared on the next
microtask, so a meter put away carries nothing); it is taken back only while the function
and scale match (an undone dial turn clears it, as a turn does); a different document
(`chiphippo:desk-loaded`) starts afresh. The (i) note relabels on `chiphippo:locale-changed`.
`meterSpot`'s no-room branch steps RIGHT of everything (it stepped left, over the circuit).

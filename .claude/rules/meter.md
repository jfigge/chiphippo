---
paths:
  - "src/web/scripts/catalog/meter.js"
  - "src/web/scripts/model/meter-probes.js"
  - "src/web/scripts/model/meter-display.js"
  - "src/web/scripts/sim/meter-average.js"
  - "src/web/scripts/sim/meter-offline.js"
  - "src/web/scripts/components/meter-view.js"
  - "src/web/scripts/components/meter-probe-layer.js"
  - "src/web/scripts/components/meter-bench.js"
  - "src/web/scripts/tests/meter.test.js"
  - "src/web/scripts/tests/meter-sim.test.js"
  - "src/web/scripts/tests/meter-desk.test.js"
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
  (`isRealPoint`); `#detachProbes` lays a probe down where it was when its board or
  part goes; the loader resets an `at` that names nothing to resting. The red plug's jack
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
  10 ms over or at once past 10×, a danger toast, mended at Stop like smoke.
- **In Spice Lite it is analog device kind `"x"`** — a Thévenin `{pos, neg, volts, ohms,
  earthOhms}` (`analog-devices.js` `meterAmps`/`meterSlope`; `network.js` floors it with
  the sources), reading back `{kind: "meter", volts, amps}` on `result.bench`. The logic
  engine reads nothing and its netlist UNIONS a shunt's two probes (a current range is a
  wire). The Spice netlist keeps them apart — EXCEPT a shunt in series with a PSU lead (one
  side holds exactly one supply terminal, the other none), which `partition` joins and
  records in `netlist.meterSides`, read off `result.draws` by `seriesReading`: an ammeter in
  the supply feed would otherwise leave every chip off its rails (752 ms/tick on the
  bench). So that meter has no burden. The wiring partition never joins probes;
  `partsDifferBranched` gives a shunt desk its own branched netlist.
- **Readings are windows** (`SimController`): the probes' voltage booked every tick and
  sampled between ticks (`scopeSamples`), integrated by `MeterAverage` (trapezoids of v and
  v², `hold` before each tick so a step is a step, the window bounded by the next pending
  event), taken every 200 ms of wall time → sim-state `meters`. DC is the mean; AC the
  AC-coupled RMS. `meterDisplay` turns a window into 6000 counts: auto-range up past the
  limit, down below 500; RANGE/HOLD live in the VIEW; OL; `----` for AutoV under 1 V;
  continuity under 161 Ω.
- **Stopped, the bench runs IN TIME** (Phase 2, 2026-10-25 — Jason: yes): `MeterBench`
  (debounced 120 ms after any doc change, then pumped every 200 ms of wall time until it
  comes to rest) gives each meter on Ω/continuity/diode a `BenchRun` (sim/meter-offline.js —
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
  round the meter's near side and foot and up into the jack (`buildProbe`).
- **Two looks** (Properties ▸ Look, `params.skin`: `volthippo` — the default, omitted —
  | `bm235`, labelled **VoltHippo** / **EEVBlog**; 2026-10-26 — the Classic body is GONE,
  and a stored `classic` reads as the Volt Hippo). Both are the BM235's body
  (`buildBody`), the band per look (`BANDS`: `bm235Band` — BRYMEN badge, "EEV"/"Blog",
  BM235 True RMS DMM; `voltHippoBand` — the Chip Hippo icon, "VoltHippo" as two texts at
  one x, "Volt" `part-meter-bm-volt` silver and "Hippo" white like "EEV"/"Blog", "True"
  over "RMS DMM"), the boot per look (`--meter-boot` on `.part-meter`, blue under
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

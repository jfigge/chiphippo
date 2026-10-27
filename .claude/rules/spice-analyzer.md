---
paths:
  - "src/web/scripts/components/scope-view.js"
  - "src/web/scripts/model/scope-*.js"
  - "src/web/scripts/sim/spice/sample.js"
  - "src/web/scripts/components/sim-controller.js"
  - "src/web/scripts/components/sim-worker-host.js"
  - "src/web/scripts/tests/scope-*.test.js"
  - "src/web/scripts/tests/spice-sample.test.js"
  - "src/web/scripts/tests/sim-controller-timing.test.js"
  - "src/web/docs/logic-analyzer.md"
---

## Spice Lite and the analyzer

What the logic analyzer draws under Spice Lite — voltages, the Timing | Transitions axis
("Analyzer x axis"), the curve samples between ticks and cycles drawn at their true
rate. Split out of `spice-lite.md` on 2026-10-23; the display frames the samples ride
are there ("Display frames are no wakes").

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
  on the ENGINE's events (sim-ticks: edges, inputs, wakes) plus Spice Lite's CURVE
  SAMPLES between them — it has no clock of its own (the curves live in the Worker).
  - **Curve samples** (2026-10-23, Jason: "do 1 and 2" — the analyzer review found a
    1 ms RC on a 10 Hz clock drawn as 33 ms ramps, 4.3 V off; a 500 Hz sine drawn as a
    triangle; 60 Hz crests wobbling 16.14–16.94 V): `spice/sample.js` `scopeSamples`
    reads the analyzer's nets (`#lastTick.nets` = the tick's `frameNets`) off the
    last tick's curves (`sampleAnalog`) between two moments, ADAPTIVELY: each stretch
    split while its ¼, ½ or ¾ point strays from the chord by more than
    `SCOPE_TOLERANCE` (0.2 %) of the lanes' scale (the highest supply set, or what the
    nets reach past it), first cut into eighths of the fastest oscillation on the desk
    (`guardStep`: a wave's period, a ringing group's `scale.osc(s)`, a drawn cycle's
    `shown`) so a whole period is never one flat chord — and along the fastest time
    constant of every node not yet arrived (`fastestStep`: from a quarter of it,
    doubling; the grade, 2026-10-23 — an edge through 1 nF into 10 nF humps to 2.2 V
    1.9 µs on and is gone, and every quarter point of the stretch lay on the chord, so
    it recorded 0 V); floor `SCOPE_MIN_STEP_S`
    (0.1 µs), at most `SCOPE_MAX_SAMPLES` (2048) a stretch; a stretch where nothing
    bent or moved past the tolerance adds NOTHING. SimController `#sampleScope(until)`
    runs it from `#scopeAt` (the last column's moment; the tick's own after each tick,
    carried by `exportRun`) to `until`, held short of `#wakeAt`/`#edgeAt` (the curves
    are exact only up to them), and announces each as a sim-tick with `sample: true`
    and a nodeVolts of the analyzer's nets alone. Called BEFORE every tick at its own
    moment (`#tickOnce`, on the old curves — the foot of whatever the tick moves) and
    at every display frame `#emitFrames` steps through — never at a batch's end: a
    sample point must not depend on where a batch stopped, or the Worker's 30 ms
    batches and the main thread's 8 ms ones record different columns
    (`sim-worker.test.js`). Measured (60 Hz adapter ~107 samples a period, 500 Hz sine
    ~42, a 1 ms RC ~50 an edge, worst chord 0.01 V): `SCOPE_CAPACITY` (8000) still
    holds ≥ 5 whole waves — Jason's condition for leaving it — held by
    `sim-controller-timing.test.js`. (A cycle drawn slowed is drawn TRUE — next.)
  - **A cycle drawn slowed is drawn at its TRUE rate** (2026-10-23, Jason: "do C,
    with the A label too"; a 4.8 kHz 555 read a 1.000 ms period between the cursors
    and its capacitor 1.72–3.23 V). Spice Lite records each analyzer net at every
    cycle MOMENT (spice/engine.js `probeOf` → a moment's `probe`: `{level, volts}`
    per `frameNets` net on the island), so a drawn cycle's `segs` carry them;
    `spice/sample.js` `cycleTemplates(cycle, nets, {tolerance})` turns one cycle into
    a TEMPLATE per net — `{u, cell, volts, curve}` at true offsets, a node on its
    segment's own curve (bisected like the curve samples), any other net stepping
    at each segment's start, ending at `u` = period. SimController `#scopeCycles`
    puts `cycles: [{id, start, shown, period, nets, templates}]` on every analyzer
    sim-tick for each cycle drawn SLOWED (`shown > period`; one drawn at its own
    rate needs nothing), nets by `analog.islands.islandOf`, templates built once per
    cycle and nets (`#templates`, a WeakMap). `model/scope-periodic.js`
    `PeriodicTracker` (ScopeView `#trackCycles`, every column) keeps per channel the
    STRETCHES where its recorded columns stand on the template at their SHOWN phase
    (`fits`: a level by identity, volts within `SAME_SHARE` 2 % of the scale; the
    points at a step's moment both count): `confirmed` after a whole shown cycle
    fits, ended at the first column that does not (re-looked-at from the next shown
    cycle) — observed, not assumed, because a counter's outputs ride the same island
    at their own pace; a FLAT template (a counter's slow stage between counts) is no
    stretch at all. Not with a ground lead set (a lane read against it is not its net's
    voltage). ScopeView draws a stretch in Timing as the template repeated every true
    period from the cycle's `start` over [from, to] (`#voltsPath`'s `drawSpan`; the
    slowed columns passed over), or a `.scope-cycle-band` between its extremes when a
    period is under `BAND_PERIOD_PX` (2) or the window would take over
    `MAX_TILE_POINTS` (20 000); in Transitions as ONE `.scope-cycle-block`
    (`transitionAxis`'s `periodic` option → `blocks`, `BLOCK_PX` 64, no fold marked
    inside) labelled with the true rate. The A label: `.scope-chan-rate` (amber, the
    true rate, titled `scope.trueRateTitle`) in the gutter while the cursor column is
    in a stretch, whose value there is the template's; the Δ readout appends
    `scope.truePeriod`. The cursors still land on columns.
  - **Joins are by column kind, not time** (`joined(columns, k)`: `col.curve`, the
    recorder's flag from the sim-tick's `sample`): a curve sample is joined straight to
    the column before; a TICK is held to from the column before and stepped at its
    moment. `JOIN_S` is gone.
  - **Timing**: x = `at` (`columnTimes`, monotonic), `PX_PER_DIV` 100 at a 1-2-5
    `SEC_PER_DIV` ladder (100 ns – 5000 s); `#secPerDiv` null = Fit (`fitSecPerDiv`,
    the default, session-only once zoomed), floored by `minSecPerDiv` so the track
    stays under `MAX_TRACK_PX` (16 M px). −/+/Fit and ⌘/Ctrl+wheel (anchored at the
    pointer, `#anchor`). The right edge is `#now`: SimController's sim-state now
    carries `at` (`#shownAt()`, null when stopped/replaying). Timing is the SCOPE
    view: the only one that draws voltages.
  - **Transitions is the LOGIC view** (2026-10-23, Jason): a column where any DRAWN
    channel's level or bus word changed gets `SLICE_PX` (identity only — the volts and
    the gap threshold are gone from `transitionAxis`); a Spice Lite net is drawn as its
    LEVEL (what its readers read, X hatched — `#netLane`'s `volts` is Timing-only), and
    the gutter reads the level too. Spaced by change, a curve's shape meant nothing,
    and a voltage that moves at every sample never folded. Runs of
    unchanged columns fold to 0 px; only a fold longer than `MARK_STEPS` (4) × the
    median sample step keeps a `BREAK_PX` titled break (`.scope-break`, `scope.folded`)
    — marking every fold combed the lanes on a creeping RC.
  - **Live drawing is once a desk frame, and thinned** (2026-10-23, Jason: "render at
    30 fps but record at full capacity … the full render if paused", then "match the
    desk's 25"): while sim-state says RUNNING (`#live`), a sim-tick only records and
    each running sim-state (`PUBLISH_MS`, 25 fps — the LEDs' frame) schedules the
    render, so trace and desk move together; `#voltsPath` keeps of the points in one pixel column only its first,
    lowest, highest and last (`thin`) — the same picture, 32 000 → ~6 800 points on a
    full 4-lane buffer. Paused or stopped (a sim-state that is not running schedules
    one), and in an export, every point is drawn. No toggle: thinned to the pixel there
    is nothing a full render shows that this does not; zoom in for the samples.
  - **Drawing is windowed**: `.scope-track` carries the full width; the svg is the
    visible stretch ± one viewport (`#win`, its viewBox at the window's x), redrawn on
    a scroll past it; off-window x is clamped (`#xOf`) so each lane stays one path.
    Export is the whole track up to `EXPORT_MAX_PX` (16 000), else the stretch on
    screen.
  - **The frame's cost** (runtime review R6, 2026-10-26; 9 lanes on busy8, main-thread
    JS 121–131 → 71–78 ms/s logic, 189–222 → 118–140 Spice, forced layout 13–15 → ~3):
    the gutter's rows are KEPT (`#rows`/`#rowFor`) and only what changed is written
    (`setIf`), the ↑/↓ acting on the row's current `index`; every layout figure (lanes'
    width, scroll, scrollbar, the gutter's scroll) is read ONCE at the top of `#render`
    (`#geom`) and the follow scroll is worked out, not read back — and set only when it
    moves; `#runsOf` encodes only the columns since the last frame (`#runCache`, dropped
    on Run/clear/`forget`) and remembers the last tick with volts (`#hasVolts`); only
    the runs and columns that reach `#win` are walked (`#runsInWindow`, `#colsInWindow`:
    the columns before it are one point at the clamped left edge, the walk stops once
    the path reaches the right one); a level lane's step path is thinned live too (the
    shared `Polyline`). Held by `tests/scope-view.test.js` (R6 block); an A/B against
    the old drawing over random recordings is pixel-column identical live and
    segment-identical paused/stopped.
  - **The columns arrive in BATCHES** (scope batch, 2026-10-26, Jason: the last cost
    left on the main thread was one window event per tick or curve sample, ~1.5 µs each
    — ~60 ms/s at 64k a second on his Regulated 5V). The window event is
    `chiphippo:sim-ticks` `{ticks: [sim-tick, …]}`, in order; there is NO per-tick
    `chiphippo:sim-tick` on the window any more (the name survives for one tick's detail
    and for the Worker's message entries). `SimHost#receive` tells each run of a
    message's sim-ticks as one event, before the next non-tick event in it is even
    looked at; on the main thread SimController queues them (`#ticksOut`) and tells
    them (`#tellTicks`) before any other event it tells (sim-state, mem-state,
    cpu-break, doc-changed), at a batch's end, and at once outside one — cut to the
    analyzer's nets first exactly as the Worker cuts them (`scopeNets`/`onlyNets`, now
    in `model/scope-recorder.js` and shared; nets read off the LIVE document's channels,
    re-read on every edit, `#scopeEpoch`), since the next tick may update a tick's
    level map in place. With NO channel the main thread tells each tick at once with
    its own maps, as before. ScopeView `#onTicks` reads the channels, the ground lead
    and each bus's member addresses and bits ONCE a batch (`#readChannels`; they were
    copied three times a tick). Recorder columns are IDENTICAL before/after — the old
    and new trees over the same fake-clock runs (rc555 Spice, busy logic + Spice with a
    bus channel, mid-run edits; main thread and Worker) logged every `sample` and
    `observe` call byte for byte the same — and the main thread's columns now equal the
    Worker's outright (`sim-worker.test.js` "…ONE sim-ticks event…"). Regulated 5V ×4
    with its 3 channels: main-thread JS 219–224 → 126–128 ms/s, window events 64k → 52 a
    second, Worker and speed unchanged (×2.5–2.6, Worker-bound); the main-thread engine
    (busy8 Spice, 9 lanes, Worker off) 579–591 → 560 ms/s; at 800 columns a second
    (busy8 9/16 lanes) within noise, the recording itself 2.6 → 1.7 µs a column (16
    lanes, headless); no channel unchanged.
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
- **A recording belongs to the CHANNEL, not just its id** (review 2026-10-26). An undo
  rewinds `nextScopeChannelId`, so a channel added after it can take an undone one's id
  (`sc1`) and inherited its recorded trace — another net's waveform under the new lane.
  `ScopeView#forgetReusedIds` (on every `chiphippo:doc-changed`) remembers what each id
  recorded (`kind|ref`) and drops that id's columns, ranges and periodic spans
  (`ScopeRecorder.forget`, `PeriodicTracker.forget`) when it comes back naming something
  else; a redo restoring the same channel finds its trace intact.

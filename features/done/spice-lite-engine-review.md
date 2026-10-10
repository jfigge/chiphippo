# Spice Lite — how a simulation runs, and how it could run faster

_Review, 2026-10-09. Written against the working tree (bench parts, clock waves
and the wave-frame fixes from the same day included, all uncommitted)._

This document has three jobs:

1. Explain, end to end, how Spice Lite turns a desk into a running simulation —
   from the Run button to the voltages the probe reads.
2. Explain how **connected** and **disconnected** components are treated at
   each layer: which parts of the engine already work only on what is
   electrically involved, and which parts still process the whole desk every
   time anything anywhere moves.
3. Review the alternatives, measure what the present design costs, and
   recommend a better structure.

---

## 1. Summary

- Spice Lite **is not a time-stepping simulator**. It is the digital engine,
  **driven** through hooks, with an analog layer that (a) solves every net's
  voltage cluster by cluster after each digital pass, and (b) carries
  capacitor and inductor voltages between events as **closed-form curves**,
  so a node changes nothing until it crosses an input's threshold, at a
  moment found analytically.
- **The electrical side is already well partitioned.** Voltages are solved per
  _cluster_ (nets that resistors, junctions, channels and devices could ever
  join, rails never a join), and only the clusters something moved in are
  re-solved. Capacitor nodes are grouped into _dynamic groups_ that are solved
  together only when they really see each other. Listeners exist only for
  pins that read an analog network.
- **Time and control flow are not partitioned.** There is one tick, one
  wake-up queue, one gate-delay quantum, one event budget, one chatter
  back-off and one cycle signature for the whole desk. Any event in any part
  of the desk — a 555 crossing its threshold on a board nothing else touches —
  runs a **whole-desk tick**: at least two digital settles of every chip, the
  per-tick analysis, the current report, supply droop, wire sag and every
  warning.
- **Measured cost of that coupling** (section 6): a busy logic board plus an
  _unconnected_ 555 costs **3.5× the 555 alone**, and two unconnected fast
  555s cost **10× one**, because the pair is never recognised as a cycle.
- **Recommendation:** keep the closed-form, event-driven model — it is the
  right model for a mostly digital desk — and partition the **scheduling** the
  way mixed-signal simulators do: independent **islands**, each with its own
  event queue, analog state, cycle detection and settle, sharing only the
  supplies. A staged plan is in section 8; several cheaper wins inside the
  current structure are listed in section 7.

---

## 2. The layers

```
SimController (renderer, components/sim-controller.js)
  │  transport: Run / Pause / Step, the edge schedule, batches, publishing
  │
  ├── ENGINES.spice.tick(opts)                       sim/spice/engine.js
  │     │  one call = everything that happens up to the moment `now`
  │     │
  │     ├── digitalTick(opts, hooks) × N             sim/engine.js
  │     │     the ordinary two-phase tick, settle by settle,
  │     │     pass by pass (incremental settle, sim/incremental.js)
  │     │       └── hooks: context, input, outputs, levels, reread,
  │     │                  busy, pass, psuVolts, chipDrop, chipVolts, …
  │     │
  │     ├── voltage solve, every pass                sim/spice/voltages.js
  │     │     dirty clusters → Newton per cluster    sim/spice/network.js
  │     │     every input reads its own pin's volts
  │     │
  │     ├── analog nodes between passes              rc-curve.js, dynamics.js,
  │     │     curves, corners, crossings, groups     listeners.js, coupling.js
  │     │
  │     ├── cycles (fast oscillators drawn by schedule)  cycles.js
  │     └── end of tick: current, droop, sag,        supply.js, sag.js, leds.js,
  │           LEDs, loads, warnings, wakeAt          loads.js, bench-warnings.js
  │
  └── publishes chiphippo:sim-tick (every tick) and chiphippo:sim-state
      (once per batch); views render only from those
```

The digital engine never learns what an analog node is. Everything Spice
Lite adds is said through the hooks; with no hooks the digital engine runs
exactly as it always has (`tests/engine-parity.test.js` holds every shipped
example to that).

---

## 3. One run, start to finish

### 3.1 At Run

SimController builds a **netlist** (`sim/netlist.js`: union-find over every
point; Spice Lite asks for the variant where an inductor is a branch rather
than a wire) and a **prepared context** (`prepareCircuit`: pin→net maps,
resistors, diodes, the RC trace, power status). Both are reused tick to tick
until the document changes.

Several pure, per-netlist structures are built lazily on the first tick and
cached in `WeakMap`s keyed by the netlist:

| Structure                       | Where               | What it is                                                                                                             |
| ------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `voltageTopology`               | voltages.js         | Every net's **cluster**, each cluster's branches, readers, drivers, bench sources, the gate-before-channel solve order |
| `supplyTopology`, `sagTopology` | supply.js, sag.js   | Which PSU feeds which net; every wire's resistance and the lowest-resistance paths                                     |
| `capacitorNets`, `lampTopology` | engine.js, lamps.js | Capacitor pins; every resistor, LED, diode as a branch                                                                 |
| `dynamicGroups`                 | engine.js           | RC nodes (and coils) that must be solved as one linear system                                                          |

### 3.2 The transport — when ticks happen

SimController owns **time**. Everything that can happen on its own is in one
queue in _simulated_ seconds:

- **Clock edges** — `sim/schedule.js` `EdgeSchedule`, counted from an origin
  (the n-th edge is at `origin + n·half`, never accumulated). Coincident edges
  are one event.
- **The engine's `wakeAt`** — the earliest moment the analog side next does
  something by itself: a crossing, a corner, a display frame, a timer, a
  drawn cycle's next segment. Never sooner than `MIN_SHOWN_S` (0.5 ms) after
  the last tick.

One timer runs a **batch**: every event that is due, each its own tick at its
own exact `now`, then one `sim-state` publish. A batch stops after
`BATCH_BUDGET_MS` (6 ms) of work; the debt is dropped and the run is reported
`behind`. So **the cost of a tick is directly the cost of real-time
running**: anything over 1000 ms of work per simulated second makes the run
fall behind.

User inputs (a switch, a signal key, an edit) first run whatever is due,
then tick at once.

### 3.3 One Spice Lite tick

`tick({spice: {config, analog, waveFrames}, ...digitalOpts})` advances from
where the last tick left off (`analog.time`) to `target = now`. In outline
(`sim/spice/engine.js`, from about line 705):

```
copy the carried analog state: node curves, listener readings, capacitor
  charges, coil currents, committed outputs, delivered supply volts, wire
  drops, burnt LEDs, the drawn cycle (if its netlist/document still stand)

t = prior.time   if there are analog nodes and the last tick was not
                 oscillating/chattering        (replay from where it stopped)
  = target       otherwise

loop:
  if a cycle is being drawn:
      runCycle()  — settle each segment of the schedule up to target;
                    stop drawing if the circuit no longer drives what it recorded
  else:
      settleAt(t)  — ONE FULL DIGITAL TICK at time t, through the hooks
  t += passes × quantum          (the settle took that long in gate delays)
  updateNodes(t)                 — re-linearize every RC node / group
  if a reading flipped:          — settle again (≤ MAX_ANALOG_EVENTS at target,
      continue                     ≤ MAX_CATCHUP_EVENTS while replaying history)
  record the signature; if it repeats an earlier moment → enterCycle
  next = nextCrossing(t)         — earliest corner or listener crossing
  while next is a corner within reach:  re-linearize there, no settle
  if next is a crossing within reach (≤ target or ≤ FAST_WINDOW_S beyond):
      flip that listener, t = next.at, continue
  if t < target:  t = target, continue   (the tick's own moment still settles)
  break

then, once:
  current: report() every cluster's currents; LEDs/diodes judged and burnt
  supplies: measureSupplies → droop; supplySag → per-chip drop
  if the supply moved: re-settle (≤ RESETTLE_ROUNDS = 3)
  warnings: brownouts, stress, spikes, bench parts, LEDs, kicks
  wakeAt = earliest of: drawn cycle's next segment | next crossing |
           display frame (ANALOG_FRAME_S = 1/30 s while a node is moving;
           a running wave's frames while the scope records) | coil frame |
           regulator cool-down | chatter back-off
```

Two consequences matter for performance:

- **A tick on a desk with any analog node does at least two digital
  settles**: one replaying from `prior.time` on the previous tick's inputs,
  and one at `target`. Between them the previous tick has usually already
  settled that exact state.
- **Each settle is the whole desk.** `settleAt` calls the digital `tick`,
  whose first pass is _cold_ (every chip evaluated, every net resolved), and
  under Spice Lite **every powered chip goes through the `outputs` hook on
  every pass** (it counts gate-delay holds and books switching spikes), and
  every pass gets fresh complete level maps because the `levels` hook takes
  and returns whole maps (incremental.js "copy mode").

### 3.4 One pass inside a settle

The digital engine's pass, with the hooks in the order they fire:

1. Every powered chip's outputs from the levels the pass began with
   (`logicOf` — a timing part is evaluated as its _silicon_). Each chip's
   reading of each input pin comes from the `input` hook: a listener's
   crossing state, else the shown level of an analog node, else **the
   voltage the solve last found for that pin, through that chip's own
   thresholds** (`volt.reading`), else the digital level.
2. `outputs` hook: holds an output for `round(delay / quantum)` passes
   (inertial delay), books a switching spike, tells the voltage side what is
   now driven.
3. Nets resolved by strength (incremental: only nets whose drivers changed,
   with everything statically coupled to them).
4. `levels` hook → `volt.pass()`:
   - recompute each analog switch's channel from its control's **voltage**;
   - mark dirty every cluster where a driver, a channel, a bench source, an
     RC node's voltage or a MOSFET gate moved (all clusters after a change of
     power);
   - `solveDirty()`: Newton per dirty cluster (a cluster of one net with only
     drivers on it is a scalar bracketed Newton), in gate-before-channel
     order, up to `GATE_ROUNDS` (8) rounds for gates driven through MOSFETs;
   - re-read every input on every solved net; the **shown** level of a net
     is its readers' agreement (X where they disagree), overriding the
     digital level where they differ.
5. `reread` hook: chips whose _reading_ changed though no _level_ did are
   evaluated again; `busy` keeps the settle going while holds are pending or
   readings moved.

### 3.5 Between passes — the analog nodes

- **What is a node.** Every net with a capacitor whose far lead _reaches
  something_ (`trace.rail(far) || trace.connected(far)`), plus every running
  clock wave. A capacitor in the air is not part of any node.
- **One node** follows `V∞ + (V0 − V∞)·e^(−t/τ)` from its cluster solved with
  its capacitors open and **linearized** where it stands (current in, and its
  slope a millivolt toward where it is heading), or a straight ramp where an
  output saturates. The curve ends at its next **corner** (a stage's knee, a
  junction-table sample, a corner further off in its network found by
  bisecting the network's `pieces` signature), where it is re-linearized with
  no settle.
- **A dynamic group** — RC nodes in one cluster, or joined by a capacitor,
  plus inductors in their networks — is one linear system
  `C·v' = i0 − Y·v` (`L·i'` for coils), solved in closed form by its modes
  (`dynamics.js`: real modes for symmetric Y, complex modes, or a Padé
  matrix exponential). Its corner _in time_ is found by sampling the
  networks' `pieces` along the curves and bisecting (`groupCorner`).
- **Listeners** — every pin that reads a node's network (on it, a resistor
  away, or against a reference the node moves). Each one's voltage is stated
  as a constant plus node curves (`volt.affine`), and its next crossing is
  found exactly for one curve or by sampled root-finding for a sum. A
  crossing flips that pin's reading and costs one settle.
- **Coupling** — a capacitor's far side stepping between settles steps the
  node by its share, conserving charge (`coupling.js`).
- **Cycles** — after each settle the _whole analog side's_ signature is
  recorded; if it repeats a moment within `1/TIMING_CAP_HZ`, it is a cycle,
  drawn from then on by its schedule at 1 kHz with its duty kept, true cycles
  counted for parts that count it.

### 3.6 End of the tick

`report()` books every cluster's currents (cached per cluster until that
cluster is re-solved): lead currents for the probe, every LED and diode's
current (and burning, which opens it and re-solves), supply draws, output
loads, input stress. Then supply demand and **droop** past a current limit,
**wire sag** per chip, and a re-settle when either moved. The result carries
`nodeVolts`, `currents`, `lamps`, `supplies`, `loads`, `sag`, `bench`,
warnings, and `analog` (the state the next tick starts from) — and `wakeAt`.

---

## 4. Connected and disconnected components

"Connected" means different things at different layers. The table below is
the core of how a component's electrical involvement is assessed.

| Layer                                    | What joins two things                                                                                                                                         | What a component on its own gets                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Netlist** (`netlist.js`)               | Wires, board strips, rails, a closed switch's contacts                                                                                                        | Each unwired pin is a net of its own (a _lone_ net)                                                                                                                                         |
| **Power** (`engine.js` power check)      | A chip's VCC on a PSU `+` net and every ground pin on its `−`, in its family's range                                                                          | **Unpowered** → inert: drives nothing, its inputs draw nothing, it is out of the quantum and the spikes                                                                                     |
| **Digital levels** (`resolve.js`)        | Drivers by strength; channel joins; diodes one way                                                                                                            | A net no one drives is **Z**; a floating 74LS input reads H, a CMOS one X (`floating-input` warning)                                                                                        |
| **Static coupling** (`settle-index.js`)  | Union-find over every resistor, diode and channel that _could_ conduct; rails never a union point                                                             | Its own component — re-resolved only when its own drivers change                                                                                                                            |
| **Voltage clusters** (`voltageTopology`) | Resistors, junctions, switch channels, transistor devices, off-rail chip loads, inductors, bench devices, a part's internal resistors; **rails never a join** | Its own cluster. Re-solved only when something in it moves. A cluster with nothing that _holds_ it has **no voltage** (`nodeVolts` omits it) and its readers fall back to the digital level |
| **Held / authoritative** (`network()`)   | A resistive path (resistors, conducting transistors — never a junction) to a fixed net or an active output                                                    | Not held → no voltage, no readings                                                                                                                                                          |
| **Analog nodes** (`analyze`)             | A capacitor whose far lead reaches a rail or a connected net                                                                                                  | A capacitor in the air is ignored                                                                                                                                                           |
| **Dynamic groups** (`dynamicGroups`)     | RC nodes in one cluster, or joined by a capacitor (never through a rail); coils in their cluster                                                              | One free node = one scalar curve, solved alone                                                                                                                                              |
| **Listeners** (`listenersOf`)            | A powered chip's input/sense pin on, or reading through, a node's cluster                                                                                     | Pins not reading any node are read once per pass from the steady solve                                                                                                                      |
| **Supply** (`supply.js`, `sag.js`)       | Sharing a PSU (demand → droop) and sharing wire paths (sag)                                                                                                   | Coupled to every other load on that PSU when it is current-limited or the wires drop > 1 mV                                                                                                 |

### 4.1 A component that is wholly disconnected

A part sitting on the desk with no wires, or wired to nothing that powers it:

- Its pins are lone nets. A chip with no power is **unpowered**: never
  evaluated for outputs, not a driver, no input stages, no quantum
  contribution, no spike. Its lone nets have no driver and no fixed voltage,
  so each is a one-net cluster with nothing that holds it: Newton is never
  run (`holds.size` is 0), the net has **no voltage**, and its readers are
  left to the digital level.
- A capacitor whose far lead goes nowhere never becomes a node.
- A resistor or LED floating in the air is a branch of a cluster with no
  fixed net: unheld, no voltage, no current.

**Cost:** small but not zero. The part still sits in `ctx.chips` and
`ctx.netIds`, so every per-tick whole-desk loop (`analyze`, the cold first
pass's chip walk, `outputs`-hook bookkeeping only for powered chips,
`relaysOf`, timing readouts, report bookkeeping) walks past it on every tick.
Its clusters are solved once (the first, all-clusters pass) and then never
again, because nothing in them moves.

### 4.2 Powered but electrically independent sub-circuits ("islands")

This is the case that matters: two sub-circuits on one desk, each powered,
sharing only the supply rails — for example a counter board and a separate
555 blinker, or two oscillators.

**What is already independent:**

- **Voltage solving.** Rails are never a join, so each sub-circuit is its own
  set of clusters. A pass re-solves only dirty clusters; the 555's clusters
  are not re-solved when the counter moves, and vice versa.
- **The report.** Cached per cluster until that cluster is re-solved.
- **RC dynamics.** Dynamic groups never span islands (they cannot cross a
  rail), so each group's linear system is only as large as its own island's.
- **The digital settle's work per pass** (after the cold first pass): only
  chips whose read nets changed are evaluated, only nets whose drivers
  changed are resolved, within static coupling components.

**What is shared by the whole desk (the coupling that costs):**

| Shared thing                                 | Where                                                                                                                    | Effect on an independent island                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The tick itself**                          | SimController's one queue; `tick` advances the whole desk                                                                | Every wake anywhere ticks everything                                                                                                                                                             |
| **Two settles per tick**                     | the replay from `prior.time` + the settle at `target`                                                                    | Every 555 crossing runs the counter board's settle twice                                                                                                                                         |
| **Cold first pass**                          | incremental.js — nothing cached across ticks                                                                             | Every chip on the desk evaluated, every net resolved, on every tick                                                                                                                              |
| **`outputs` hook for every chip every pass** | incremental.js, Spice Lite only                                                                                          | Linear in the desk's chip count, per pass                                                                                                                                                        |
| **Copy-mode level maps**                     | the `levels` hook takes/returns whole maps                                                                               | A fresh map of every net, per pass                                                                                                                                                               |
| **The quantum**                              | `analyze`: the shortest gate delay on the desk                                                                           | A CD4000 island's passes are cut at a 74LS island's 10 ns; `maxIterations` is lifted by the slowest hold anywhere                                                                                |
| **The cycle signature**                      | cycles.js: _every_ node, listener and drive                                                                              | Two unrelated oscillators never repeat as a whole → no cycle → run edge by edge into the event cap and chatter back-off. A running clock wave blocks every other oscillator's cycle the same way |
| **The drawn cycle's replay**                 | `runCycle`: one full settle per segment                                                                                  | A drawn 555 cycle re-settles the whole counter board at every segment                                                                                                                            |
| **Event budgets**                            | `MAX_ANALOG_EVENTS` (32), `MAX_CATCHUP_EVENTS` (256)                                                                     | One busy island can spend the budget and get the whole desk marked oscillating/chattering                                                                                                        |
| **Chatter back-off**                         | `analog.chatter`                                                                                                         | While one island chatters, no wake anywhere is sooner than its back-off — a healthy island's timer is starved                                                                                    |
| **History replay**                           | `t = prior.time`                                                                                                         | Each tick replays from the last tick for the whole desk                                                                                                                                          |
| **Per-tick whole-desk analysis**             | `analyze` (every net's capacitors, every chip's delay and spike), `relaysOf`, `listenersOf` per context, timing readouts | O(desk) work on every tick, though it only changes with the netlist, the config or chip power                                                                                                    |
| **Supply droop & sag**                       | supply.js, sag.js                                                                                                        | Genuine coupling (see 4.3), but evaluated for the whole desk every tick                                                                                                                          |

### 4.3 The supply — the one legitimate coupling

Islands that share a PSU _are_ electrically coupled, through two physical
effects the engine models:

- **Droop**: past a PSU's current limit, its voltage is `Vset·Ilimit/Idemand`
  — every load on that supply sees it.
- **Sag**: a chip's draw through shared wires drops the voltage its
  neighbours on the same path see.

Both are computed at the end of the tick and fed back (`psuVolts`,
`chipDrop`), with a re-settle when they moved by more than `DROOP_EPS`. On a
desk where no supply is limited and no wire drops more than a millivolt, the
rails are effectively ideal and the islands are independent. Any partitioned
design has to keep this coupling — but it is _slow_ (one value per supply per
tick) and _rare_ (most desks never droop), so it can be handled as a boundary
condition rather than a reason to tick everything together.

---

## 5. Where the time goes

Profiles taken with `node --cpu-prof` on headless runs that drive `tick`
exactly as SimController does (each tick handed the clock level, `clockTimes`
and the previous analog state; the next tick at `min(next edge, wakeAt)`, the
wake floored at 0.5 ms).

**Busy fixture (4 slices, 28 chips) on a 100 Hz triangle wave** — after the
wave fixes: 64 % of the run in `tick`, of which more than half is the digital
settle (`settleAt` → `solveIncremental`), then `updateNodes`/`runGroup`
(~11 %), `nextCrossing` (~8 %), the report and lamps (~4 %).

**Busy fixture beside an unconnected fast 555** — 53 % of the run inside
`runCycle`, i.e. the drawn 555 cycle re-settling the **whole desk** (counter
board included) at every segment. `analyze`, `listenersOf`, `makePlan` and
`buildContext` together are another ~10 %, all whole-desk, all per tick.

**A wave into an RC (before the fixes)** — 37 % in `groupCorner` sampling a
network that had no corners at all (fixed this session: the `linear` fast
path).

---

## 6. Measurements: what independence costs today

Milliseconds of real (wall-clock) work per simulated second (lower is better; over
1000 means the run cannot keep up and reports `behind`). Apple Silicon, Node,
the working tree as of this review.

| Desk                                           | ms per sim-second | Ticks / sim-s | Notes                                                                                                                                         |
| ---------------------------------------------- | ----------------: | ------------: | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Busy logic board alone, 100 Hz square clock    |               192 |           200 | One settle per tick (no analog node)                                                                                                          |
| 555 astable alone, ~69 Hz, own board and PSU   |               249 |           342 |                                                                                                                                               |
| **Both on one desk, not connected**            |           **818** |           528 | **1.9× the sum of the two**                                                                                                                   |
| Fast 555 alone, ~6.9 kHz (drawn as a cycle)    |              1194 |          2000 | Cycle recognised; one tick per 0.5 ms                                                                                                         |
| **Two fast 555s, not connected**               |        **12 392** |          2000 | **10× one** — never one cycle as a whole                                                                                                      |
| **Busy board + one fast 555, not connected**   |          **4143** |          2000 | **3.5× the 555 alone** — every drawn segment re-settles the counter                                                                           |
| 555 ~68 kHz + a 10 Hz triangle clock elsewhere |               333 |            26 | Looks cheap, but the 555 is **not running**: no cycle, so it falls into the chatter back-off (each capped tick ~13 ms, over the batch budget) |

For reference, the wave fixes made earlier on 2026-10-09:

| Desk                          | Before |                            After |
| ----------------------------- | -----: | -------------------------------: |
| Busy fixture, 100 Hz triangle |   1223 | 750 (552 with no scope channels) |
| RC on a 250 Hz sine           |    239 |                              121 |

The fast single 555 is worth noting on its own: even with its cycle
recognised it costs 1.2 s per simulated second, because the transport ticks it
every 0.5 ms and each tick replays the schedule's segments with a full settle
each.

---

## 7. Improvements inside the current structure

Ranked by expected gain against risk. None changes what the engine computes;
each removes repeated or whole-desk work.

| #   | Change                                                                                                                                                                                                                                          | Expected gain                                                                  | Risk                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1 | **Skip the replay settle** when the tick starts at `prior.time` on the previous tick's inputs and the previous tick ended settled (not capped, not resettling). It reproduces the previous tick's final digital state.                          | Up to ~2× on every desk with an analog node                                    | Medium: the `t += passes·quantum` offsets move by gate delays; `engine-incremental` (full vs incremental exactness) and the golden cases must stay green |
| 7.2 | **Replay a drawn cycle from its recording.** A segment's digital outcome is in the cycle (it is checked against `drive` already); apply the recorded levels and re-settle only when the drive check fails, or settle only the last segment due. | Large for any fast oscillator (the 1.2 s/s single 555; the 4.1 s/s busy + 555) | Medium: counting parts (`stepEnv`) and memory writes during replay must still be applied                                                                 |
| 7.3 | **Cache the per-tick analysis** (`analyze`'s candidates, waves, delays, quantum, holds, spikes; `relaysOf`; `listenersOf`) per netlist + config + chip-power signature, like the topology already is.                                           | ~5–10 % per tick on big desks                                                  | Low                                                                                                                                                      |
| 7.4 | **Only route chips with something to do through `outputs`** (a chip with a hold > 1, a spike to book, or one the voltage side must be told about), and let the voltage side read unchanged chips' outputs from the cache.                       | Proportional to idle chips per pass                                            | Medium: the hook's counting and spike booking are order-sensitive (incremental.js says why it was left this way)                                         |
| 7.5 | **Avoid copy mode under Spice Lite**: let the `levels` hook return a delta of overridden nets rather than a whole map.                                                                                                                          | O(nets) per pass                                                               | Medium: the observer/debugger paths still need full maps                                                                                                 |
| 7.6 | **Carry the incremental cache across ticks** (no cold first pass): a tick that only changes one clock re-evaluates only that clock's readers.                                                                                                   | Large on busy desks; it is the digital half of the island idea                 | Medium-high: the reason for starting cold (state objects replaced between ticks, memory images, signals) needs a precise invalidation rule               |
| 7.7 | **Cheaper `piecesAt`** in `linearizeGroup`: it builds two `Map`s per network per sample (~100 samples per corner search). Reuse scratch arrays.                                                                                                 | ~5 % of a tick with nonlinear groups                                           | Low                                                                                                                                                      |

---

## 8. Alternatives

### 8.1 A full SPICE-style engine (MNA + time-stepping)

One sparse modified-nodal-analysis matrix for the whole desk, integrated with
an adaptive timestep (trapezoidal/Gear), every chip a behavioural model.

- **For:** one general mechanism; any coupling, any topology; no corners,
  listeners or cycle detection; directly comparable to ngspice.
- **Against:** a mostly digital desk is the worst case for it. Every logic
  edge forces small timesteps across the _whole_ matrix; a 28-chip counter
  board at 100 Hz becomes hundreds of thousands of matrix solves per
  simulated second where Spice Lite does a few hundred settles. The digital
  engine, its exact parity tests, the incremental settle, the debugger, the
  CPUs (6502/Z80 as `step` functions) and the "every net a level" contract
  would all have to be bridged rather than reused. Speed would likely drop by
  one to two orders of magnitude on the desks people actually build.

**Not recommended.** Spice Lite's closed-form, event-driven approach is the
better model for this application; the problem is how it is _scheduled_, not
how it computes.

### 8.2 A partitioned mixed-signal engine (recommended)

This is how production mixed-signal simulators (XSPICE's event-driven
digital, Verilog-AMS, and FastSPICE-class tools) handle large circuits:
**partition the circuit into independent islands and only process the island
that has an event.**

**Islands.** Union-find over every element that can carry signal or current
between nets: a chip's pins (a chip couples all its pins), resistors, diodes
and LEDs, switch channels, transistors, capacitors (both plates), inductors,
bench devices, clock bricks and signal flags with the nets they drive. **Rails
are never a join**, exactly as in `voltageTopology`. Computed once per
netlist, alongside the topology. A 555 board and a counter board that share
only `+5 V` and `GND` are two islands.

**What each island owns:**

- its own **event queue** (crossings, corners, frames, timers, its clock
  edges — a clock brick belongs to the island its `out` net is in);
- its own **analog state** (`nodes`, `listen`, `capFar`, charges, coils),
  **cycle** and **cycle signature**, **event budget** and **chatter
  back-off**;
- its own **quantum** (the shortest gate delay among _its_ chips);
- its own **digital settle**, run on the island's chips and nets only
  (a scoped context: the settle index already partitions nets; this extends it
  to chips).

**What stays global:**

- **Supplies**: demand summed over islands per PSU; droop and sag computed at
  the end of each batch (or each tick that touched that PSU) and fed back as
  each island's boundary condition. When a supply moves by more than
  `DROOP_EPS`, the islands it feeds are re-settled — the existing
  `RESETTLE_ROUNDS` rule, scoped to those islands. On the common desk (no
  current limit hit, wires under 1 mV) this never fires and islands are fully
  independent.
- **The transport**: SimController keeps one batch, but each island reports
  its own `wakeAt`; a wake ticks only the islands due at that moment. Inputs
  (a switch, a key) tick the island the input's net is in.
- **Publishing**: `nodeVolts`, `lamps`, `currents` etc. are the union of each
  island's latest results — an island not ticked keeps its last values, which
  is exactly right because nothing in it changed.

**Expected gains** (from the measurements in section 6, assuming an island
costs about what it costs alone):

| Desk                                 |           Today |                       Partitioned (est.) |
| ------------------------------------ | --------------: | ---------------------------------------: |
| Busy board + slow 555, not connected |             818 |                         ~440 (≈ the sum) |
| Busy board + fast 555, not connected |            4143 |                                    ~1390 |
| Two fast 555s, not connected         |          12 392 | ~2400 — each recognised as its own cycle |
| 555 + clock wave elsewhere           | 555 not running |                   555 drawn by its cycle |

Combined with 7.2 (replay cycles from their recording) the fast-oscillator
rows drop much further, since an island drawn by its schedule needs almost no
settling at all.

**Risks and what must hold:**

- **Parity.** `tests/engine-parity.test.js` compares both engines on every
  example; a partitioned engine must produce the same per-net levels. Island
  scheduling changes _when_ an idle island is evaluated, not _what_ it
  computes, so the shared fields should still agree — but warnings are
  currently assembled in whole-desk order and would need a stable merge
  order.
- **Incremental exactness** (`engine-incremental.test.js`) must be re-stated
  per island.
- **The quantum per island** changes timing on mixed-family desks (a CD4000
  island no longer steps at a 74LS island's 10 ns). This is _more_ correct,
  but it will move numbers in tests that mix families on one desk.
- **Cross-island effects the engine models today** must stay global or be
  proven local: supply droop and sag (above), and the voltage-dependent
  `chipVolts` of an off-rail chip (local — its feed is in its island).
- **Debugger and analyzer** see `sim-tick` per tick; with islands, a tick
  carries only the islands that moved, so the analyzer must hold the last
  value of the rest (it already draws flat stretches as two points).

### 8.3 Suggested staging

1. **Measure:** add an islands fixture to `make bench` (busy board + an
   unconnected 555; two unconnected 555s) so every step has a number.
2. **Inside the current structure** (section 7): 7.3 (cache per-tick
   analysis) and 7.7 first — low risk. Then 7.1 (replay settle) and 7.2
   (cycle replay), each behind the existing exactness and golden tests.
3. **Islands, analog half first:** per-island cycle signature, event budget
   and chatter back-off, with the tick still whole-desk. This alone fixes the
   "two oscillators never cycle" and "wave blocks a 555" cases — the 10×
   rows — at moderate risk, because it changes no settle.
4. **Islands, scheduling:** per-island `wakeAt`, per-island ticks, scoped
   settles, supply as a boundary condition. This is the large change and the
   large gain on busy desks.
5. **Optional:** per-island quantum.

---

## Appendix A — constants referred to

| Constant                                   | Value                               | Where                                                       |
| ------------------------------------------ | ----------------------------------- | ----------------------------------------------------------- |
| `MIN_SHOWN_S`                              | 0.5 ms (½ of `TIMING_CAP_HZ` 1 kHz) | sim/timing.js — the wake floor                              |
| `BATCH_BUDGET_MS` / `FRAME_MS`             | 6 ms / 8 ms                         | components/sim-pacer.js                                     |
| `ANALOG_FRAME_S`                           | 1/30 s                              | spice/engine.js — display frames for a moving node          |
| `WAVE_FRAMES`, `WAVE_FRAME_MIN_S`          | 16 per period, ≥ 2 ms               | spice/engine.js — only while the scope has channels         |
| `FAST_WINDOW_S`                            | 10 µs                               | spice/engine.js — crossings/corners handled inside the tick |
| `MAX_ANALOG_EVENTS`                        | 32                                  | settles at the tick's own moment before `oscillation`       |
| `MAX_CATCHUP_EVENTS`                       | 256                                 | settles replaying a late tick's history                     |
| `MAX_CORNERS`                              | 256                                 | corners re-linearized in one tick                           |
| `MAX_CAPPED_BACKOFF_S`, `CHATTER_MEMORY_S` | 1 s, 1 s                            | chatter back-off                                            |
| `RESETTLE_ROUNDS`                          | 3                                   | re-settles after droop/sag                                  |
| `GATE_ROUNDS`                              | 8                                   | spice/voltages.js — MOSFET gate → channel rounds            |
| `MAX_HOLD`                                 | 64                                  | the slowest gate in quanta                                  |
| `MAX_ITERATIONS`                           | 200                                 | sim/engine.js pass cap (× the longest hold)                 |

## Appendix B — how the numbers were taken

Headless Node scripts importing the engine modules directly (no Electron),
driving `ENGINES.spice.tick` the way SimController does: the document and
netlist built once (`buildNetlist(…, {inductors: "branch"})`,
`prepareCircuit`), each tick handed the previous tick's `netLevels`, `state`,
`pinLevels` and `analog`, the next `now` the earlier of the next clock edge
and `max(wakeAt, now + 0.5 ms)`. Fixtures: `bench/busy-circuit.js`
(`busyDocument(4)`, 28 chips) and `tests/timing-fixtures.js` (`bench`,
`astable555`), the 555 moved onto its own board and its own PSU so it shares
nothing with the counter board. Times are wall-clock per simulated second on
one machine; they are for comparison, not absolutes.

## Appendix C — file map

| File                                                      | Role                                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `components/sim-controller.js`                            | Transport, edge schedule, batches, publishing                               |
| `sim/schedule.js`                                         | `EdgeSchedule` — clock edges in simulated seconds                           |
| `sim/engine.js`                                           | The digital tick and settle; the hooks seam                                 |
| `sim/incremental.js`, `settle-index.js`, `settle-pass.js` | The incremental settle and its static coupling                              |
| `sim/spice/engine.js`                                     | The Spice Lite tick: replay, settles, nodes, crossings, cycles, end-of-tick |
| `sim/spice/voltages.js`                                   | Topology (clusters), per-pass dirty solve, readings, report                 |
| `sim/spice/network.js`                                    | Newton solve of one cluster; branch kinds; `pieces`                         |
| `sim/spice/rc-curve.js`, `dynamics.js`                    | Closed-form node curves; coupled groups                                     |
| `sim/spice/listeners.js`, `coupling.js`                   | Crossings; capacitor coupling                                               |
| `sim/spice/cycles.js`                                     | Cycle signature and schedule                                                |
| `sim/spice/supply.js`, `sag.js`                           | Droop and wire sag                                                          |
| `sim/spice/waves.js`                                      | Clock waves                                                                 |

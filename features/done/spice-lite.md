# Spice Lite — implementation plan

**Status:** plan reviewed by Jason (2026-10-07). **Phases 1–6 landed** (the seam, the
setting, the parity oracle; time, analog nodes, crossings, the 555 on its
curve; the Settings tab; fan-out, brown smoke, PSU limit and droop; wire
resistance and sag; switching spikes and decoupling). Phase 7 (docs) landed too —
**done**. Requirements: the Spice Lite
spec from the 2026-10-06 conversation.

**Decided (2026-10-07):** the CD4000 delay SCALES WITH THE CHIP'S SUPPLY from
the datasheet's 5/10/15 V points (the Advanced field is "delay at 5 V");
brown smoke trips at **2×** the output budget; the settings are **app-wide**.
Still open: Q2 (trigger point vs. X band), Q4 (glitch vs. warn), Q5 (contact
resistance). Jason, 2026-10-07: UI rendering performance work is ongoing in
parallel — keep the views' changes minimal, and keep anything per-tick off
the render path (no new per-tick work in overlays; new sim-state fields are
read only by the views that need them).

## 0. The one idea the rest hangs on

**Analog voltages are CLOSED-FORM curves, never stepped.** An RC node's voltage
is `V(t) = V∞ + (V0 − V∞)·e^(−(t − t0)/τ)`, re-anchored (`t0`, `V0`) whenever
what drives it changes. So the time a node crosses a threshold is solved
directly: `t = t0 + τ·ln((V0 − V∞)/(Vth − V∞))`. That one fact answers risks
2, 4 and 5 in the spec together:

- **Cost is bounded by EVENTS, not by elapsed time.** A 10 s RC costs the same
  as a 1 µs one: one computed crossing. Nanosecond passes never get summed up
  into milliseconds one by one.
- **Intra-tick vs. the sim clock:** the tick loop is
  _digital settle → find the next analog crossing → if it falls within
  `FAST_WINDOW` (proposal: 10 µs of simulated time) jump straight to it and
  settle again → otherwise stop and report it as `wakeAt`_. Fast settling
  (a pull-up on a small cap) finishes inside one tick. Slow evolution
  (a 555's cap, a 1 s RC) carries across ticks through the `now`/`wakeAt`
  machinery that SimController already has. There is one wake mechanism, not
  two that compete.
- **Converging is not oscillating, by construction.** The digital pass cap only
  counts digital passes. An analog node never advances inside `solve`, so it
  cannot use up that cap and it cannot hide a real ring.

## 1. The seam (Phase 1)

`sim/engines.js` (new): `ENGINES = {digital, spice}`, each `{id, tick, settle}`
with the existing `tick`'s option/result shape. `digital` is today's
`engine.js` exports, untouched. `spice` takes one extra option, `spice`
(`{config, analog}`: family constants and the analog state carried from the
previous tick), and returns the digital result **plus** these optional fields:

| field       | contents                                                                          |
| ----------- | --------------------------------------------------------------------------------- |
| `analog`    | carried state: per node `{t0, v0, vInf, tau, armed}` (run-volatile, like `state`) |
| `nodeVolts` | net → volts, for the probe readout and the analyzer                               |
| `supplies`  | psuId → `{volts, amps, limited}` (the brick readout)                              |
| `loads`     | the fan-out budget per driving pin (Brownout)                                     |

**Only SimController chooses.** The AI verifier, the desk review, the
overlays, `make demos` and both exports keep importing `engine.js` directly.
That is how the spec's "exports byte-identical" and "demos validate with the
toggle off" become true by construction rather than by checking.

SimController reads `settings.spiceLite.enabled` **at Run**. A toggle flipped
mid-run applies at the next Run, and the (i) note says so. Switching engines
under a live state map would mix two incompatible state shapes.

**Small, inert hooks in `engine.js`** (each one is a pure refactor or an optional
argument whose absence leaves the code path exactly as today):

1. Lift `solve`'s loop body into an exported `evaluatePass(ctx, levels, …)`.
   `solve` calls it, so the behaviour is identical.
2. Export `buildContext`, `assemble` and `CHIP_STATUS`.
3. `driversFor` gets an optional `holdOutputs(compId, outputs) → outputs` hook.
   This is how inertial delay is implemented (§3).
4. `buildContext` gets an optional `railVolts: Map<net, volts>` that overrides the
   PSU's set volts in `powerStatus`. This is how droop feeds "underpowered" (§6)
   without a second power check.

`spice` in Phase 1 delegates to `digital.tick` and adds empty fields. The proof
for this phase is a new `engine-parity.test.js`: every circuit fixture in the
existing engine suites runs through BOTH engines and must give identical
`netLevels`/`chipStatus`/`warnings`.

## 2. Settings shape (app-wide, as `logicFamily` is)

```jsonc
spiceLite: { enabled: false, gapPercent: 1,
              families: { "74LS": { /* overrides only */ }, "CD4000": { } } }
```

Only overrides are stored. Reset deletes a family's object. Defaults live in
`sim/spice/params.js` with a datasheet citation beside each one. Main stores the
object unvalidated, as it does `ai`, and the renderer coerces it
(`normalizeSpiceConfig`). App-wide: decided.

## 3. Time and mixed families (Phase 2)

**Quantum = the smallest delay among the families of chips actually ON THE DESK.
A chip whose own delay is longer HOLDS its committed outputs for
`round(tpd/quantum)` passes (≥ 1). This is INERTIAL delay: if the output reverts
before the count runs out, the pending change is cancelled.**

- **Why this scheme:** it keeps races honest (a CD4000 gate racing a 74LS one
  loses, by about 6:1 or 12:1), stays integer and deterministic, and on a
  single-family desk every hold is 1. That last point is the regression anchor:
  a desk with no RC network relaxes pass for pass exactly like the digital
  engine, so the parity suite stays valid into Phase 2.
- **Family-less parts** (memory, CPUs, the 555, custom chips, discretes) take
  the quantum, so they are one pass, which is today's behaviour. This is stated
  in the code, not modelled.
- Intra-tick time = passes × quantum. It is added onto `now` for the analog
  crossings. It is reported but does not move SimController's clock (ns against
  a 100 Hz world).
- **The oscillation cap** becomes `MAX_ITERATIONS × maxHold` passes, so the
  same 200 _unit-delay rounds_ apply. A 3-inverter 74LS ring still reports
  `oscillation` (and the warning can carry its period, 6·tpd, as a bonus).

## 4. Analog nodes, listeners and quiescence (Phase 2)

New `sim/spice/analog-nodes.js`. It is built ONCE per context from `rcTrace`
plus the netlist, so no new wiring detection is written.

- **An analog node** is a net with a capacitor lead in it and NO strong driver
  on the net itself. It is reached only through resistors (the nets the digital
  engine resolves at PULL strength). Its target is the resistors' Thévenin
  equivalent: `V∞ = Σ(Vk/Rk)/Σ(1/Rk)` over the far nets' volts, and
  `τ = R_th·C_total`. As a side effect, a resistor divider gets a real voltage.
  The capacitor's far side is taken as fixed. For a cap to a rail that is exact;
  for a coupling cap between two signal nets it is an approximation, and I'll
  document it as such.
- **Inductors:** the LR current ramp `τ = L/R`, with the same closed form for
  current. Diodes get a fixed forward drop (`VF`, by type: 0.7 V silicon,
  LED by colour ~1.8–3.0 V) and cutoff below it. Potentiometers need no change.
- **Listeners** are every input pin on the node, plus timed-part pins. Each
  contributes its threshold for its family at that chip's ACTUAL supply (TTL
  absolute volts; CMOS a fraction of VDD).
- **The digital view of a node** is one trigger point per listener (default:
  the midpoint of VIL/VIH, editable in Advanced). The node's level as each
  listener reads it flips only on a CROSSING. That gives the one-shot: no event
  while it keeps climbing, re-armed only by crossing back. Different listeners
  on one node can read different levels mid-charge, which is the realistic
  case. The engine lets a chip read its own per-pin input this way through the
  same `samplePins`/drivers path, via a per-(net, chip) override map.
- **Quiescence (4.4):**
  - A node holds the tick open only while some listener's threshold lies
    BETWEEN its present voltage and its asymptote. It stops blocking once every
    such threshold is crossed.
  - A node whose asymptote is short of a threshold _will never cross it_. It is
    released at once, with no wake.
  - A threshold that moves (droop) is fine: crossings are recomputed from the
    curve every context.
  - A node nothing listens to never holds a tick. The 1% gap rule decides only
    how long it keeps asking for DISPLAY wakes (≤ 1 per `ANALOG_FRAME_S`) so
    the probe readout animates. It stops asking once the gap is under
    `gapPercent`. The node is never frozen; `V(t)` is always defined.
- **Analog runaway guard:** at most `MAX_ANALOG_EVENTS` (64) crossings jumped
  per tick, after which the tick ends and resumes at `wakeAt`. An RC relaxation
  oscillator faster than `TIMING_CAP_HZ` is drawn at the cap with its true rate
  reported, the same rule `timing.js` applies to timed parts.
- **The 555 and CD4000 timers sample the curve.** In Spice Lite each timed
  part's analysis also names its capacitor node and two threshold fractions,
  and its schedule segments become curve crossing times. For the 555 this is
  exact physics: ⅓→⅔ towards VCC is `ln 2 = 0.693`, and 0→⅔ is
  `ln 3 = 1.0986 ≈ 1.1`. For the CD4000 parts, whose constants (4.40, 2.48,
  2.2, ½, 0.2·ln(VDD−VSS)…) are empirical, the fractions are CALIBRATED so the
  crossing reproduces the datasheet formula, and a comment derives each one.
  Tests assert the timings equal today's to 1e-9. The capacitor's voltage is
  now visible on the probe.

## 5. Settings tab (Phase 3)

A **Spice Lite** panel (`settings-spice-panel.js`, so `settings-dialog.js`
doesn't grow further). Top: an On/Off segmented picker plus the gap percentage.
Then a `segmented-picker`-styled TTL | CMOS strip, filtered by `familiesShown(
logicFamily, projectFamilies)`. Each family has a disclosure "Advanced" with
delay, source/sink, I_IH/I_IL, ICC and VIL/VIH (+ trigger point), and **Reset**.
Notes go behind (i). All strings go into all 7 locales. Number fields parse
through `component-value.js`, so the units are typed the way a resistor value is.

The card height is measured against Appearance (§Settings in CLAUDE.md). This
panel will need to scroll with Advanced open, which is the same as Serial I/O.

## 6. Current, PSU and smoke (Phase 4)

- **Fan-out:** per driven net, Σ I_IH (H) or I_IL (L) over its listeners, by
  each listener's family, is compared with the driver's source/sink. Over 1× →
  a `brownout` warning. Over **2×** → **brown smoke**: a new
  `CHIP_STATUS.OVERLOADED`, `params.overloaded: true` with exactly the
  `damaged` lifecycle (`#persistDamage`, `#clearAllDamage`, dropped by
  `loadParams`), its own toast, badge and `statusHint` sentence. **Flagged:**
  the 2× trip point is my proposal. The check runs at the first tick of a Run
  (the preflight moment) and on every tick after, so wiring that makes the load
  worse is caught.
- **PSU:** a new `currentLimit` param (default 1 A, omitted when default, so the
  doc gets a pure `v14 → v15` bump in both `DOC_VERSION` and `migrations.js`)
  and a Properties combo. Demand = Σ ICC of powered chips + resistor currents
  (ΔV/R across nets of known volts, LEDs at their VF) + output load currents.
  Past the limit, `V = Vset · Ilimit / I` (proportional foldback). Because
  resistive loads fall with V, this is solved by fixed-point iteration (≤ 8
  rounds). The result feeds `railVolts` → the EXISTING underpowered check.
  `PsuView` shows the amps from `sim-state.supplies`, in amber while limited.
- KiCad and Digital exports don't read any of it, and a test pins them
  byte-identical on the demo corpus with the setting both ways.

## 7. Wire resistance (Phase 5)

24 AWG copper is **0.0842 Ω/m** (84.2 mΩ/m; 26.7 mΩ/ft, which I have
confirmed), × `wireRunMm`.

**Lumped model:** build a graph of the wiring partition (board nodes at 0 Ω,
wires at their R). Route each chip's ICC from its PSU terminal along the
SHORTEST resistive path to its VCC pin and back from GND. Sum the currents per
wire, and each chip's drop is Σ I·R over its path. Shared-wire sag (a long
daisy chain starving the last chip) comes out of this, which is the lesson it is
for.

**What it gives up:** current splitting over parallel paths (the result is an
overestimate there), resistance in the strips and contacts, and any feedback of
the sag on the currents.

**Honest flag:** at 84 mΩ/m a 10 cm jumper is 8 mΩ, i.e. 8 mV at 1 A. On
ordinary desks the effect will be close to invisible. Real breadboards lose far
more in contact resistance (tens of mΩ per contact). Do you want a per-contact
term, or keep it wire-only as specified?

## 8. Decoupling (Phase 5–6)

A capacitor counts as **decoupling** iff `rail()` puts one lead on a `+` net and
the other on a `−` net. A timing cap always has a lead on a non-rail net, so the
two can never be confused. "Same rail" = the chip's VCC pin is in that `+` net
(wiring partition). With Phase 5 in place, the plan prefers the cap whose path
to the chip is shortest.

A chip whose outputs changed in a pass adds `I_spike` (per family, Advanced)
for that one pass. If there is no cap, it adds to the PSU's instantaneous
total. If there is one, the cap supplies `Q = I_spike·quantum` (droop `Q/C`,
negligible), and the PSU sees a recharge tail `Q/τ` with `τ` from §7's path
resistance.

A pass whose peak trips the limit droops for THAT pass. A chip below its
minimum is underpowered for that pass, which can glitch it (the real-world
symptom), and a `supply-glitch` warning names the rail. **Flagged:** whether
the transient should actually glitch logic or only warn.

## 8½. Phase 1 as built

- `sim/engines.js` — `ENGINES` (`digital` IS `engine.js`'s `tick`/`settle`,
  not a wrapper) and `engineFor(config)`.
- `sim/spice/config.js` — `normalizeSpiceConfig`, the ONE reader of
  `settings.spiceLite` (`{enabled, gapPercent, families}`; overrides only).
- `sim/spice/engine.js` — delegates; adds `analog` (carried), `nodeVolts`,
  `supplies`, `loads`, all empty.
- `SimController` — `setSpiceLite(config)` (from app.js `applySettings`),
  the engine chosen in `#beginRun`, `engineId`, `#analog` carried tick to tick
  and cleared at Run and Stop. Nothing new is published yet.
- `settings-store.js` default; a **Spice Lite** tab in Settings (between
  Serial I/O and Data Sheets) holding only the On/Off row for now — Phase 3
  fills it. Seven locales.
- `engine.js` is UNTOUCHED: the four hooks in §1 land with the phase that first
  needs them (Phase 2), so Phase 1 cannot have moved the digital engine.
- Tests: `spice-config.test.js`, `engine-parity.test.js` (every shipped example
  desktop, 24 ticks, both engines, every shared result field deep-equal),
  a SimController test (the setting is read at Run, never mid-run), a Settings
  test (the toggle re-emits the whole object).

## 8¾. Phase 2 as built

- **Hooks in `engine.js`** (`hooks` on `tick`/`settle`; absent = byte-for-byte
  the digital engine): `context`, `curves`, `input`, `outputs`, `levels`,
  `busy`, `pass`, `maxIterations`. Not the `evaluatePass` lift §1 proposed —
  the hooks did it with less moved code. `rc-trace.js`'s `timingProbe` takes
  an `extra` (`{curves: true}`).
- **`sim/spice/params.js`** — the family table, every value cited (SN74LS00
  SDLS025D; CD4001B SCHS015C, read off the rendered Harris scan): 74LS 10 ns,
  0.4/8 mA, 20/400 µA, ICC 1.6 mA (mean of 0.8/2.4 typ), VIL/VIH 0.8/2 V;
  CD4000 125 ns at 5 V scaled along 5/10/15 V → 125/60/45 ns, ±1 mA,
  IIN 10⁻⁵ µA, IDD 0.01 µA, VIL/VIH 1.5/3.5 V at 5 V scaled with VDD.
  Family-less parts read at the 74LS thresholds and switch in one pass.
- **`sim/spice/rc-curve.js`** — `valueAt`, `timeToReach`, `hasArrived`.
- **`sim/spice/engine.js`** — the event loop (§0), quantum + inertial holds,
  per-listener readings, one-shot crossings with a 1 nV hysteresis, a node's
  published level (listeners agree → that; disagree → X; none → half the
  supply), late-tick catch-up, `MAX_ANALOG_EVENTS` (32) with an `oscillation`
  report and the `MIN_SHOWN_S` floor, display frames (`ANALOG_FRAME_S`,
  1/30 s) until the gap rule says arrived.
- **The 555** times by `CURVE_K` (ln 2, ln 2, ln 3) under `probe.curves`, with
  the long FIRST high from an empty capacitor as a lead segment, and reports
  its capacitor voltage (`logic.nodeVolts`). The digital 555 is untouched.
- `nodeVolts` rides `chiphippo:sim-state`; `SimOverlay` keeps it
  (`voltsOfNet`) and the probe's readout says it ("H · 1.4 V · …") — read only
  when the probe shows a net, nothing drawn per tick (the rendering work).
- **Decisions taken while building** (flag if wrong): Q2 went with ONE trigger
  point per listener (VIL/VIH midpoint); the gap rule is measured against the
  STEP a curve is taking, not the final value (a node discharging to 0 V has a
  final value of 0, which "1 % of" cannot measure) — identical when charging
  from 0.
- **Not yet** (each says so in code): the CD4000 RC timers keep their
  datasheet formulas and do not yet publish a capacitor voltage — their
  constants are empirical, so a curve calibrated to them reproduces the same
  numbers and would add only the probe reading; a far net's HIGH reads as the
  desk's supply (no output-stage VOH until Phase 4's current model); a
  resistor chain through an intermediate net is not followed; inductors and
  diodes are unchanged (they need the current model — moved to Phase 4).
- Tests: `spice-engine.test.js` (RC charge and flip, one-shot, two listeners
  at their own thresholds, a released node, late catch-up, discharge, ring
  oscillator on both engines, mixed-family hold, 555 curve and first cycle,
  the digital 555 untouched); the parity suite now exempts the two 555
  desktops, with the reason.

## 8⅞. Phase 3 as built

- `components/settings-spice-panel.js` (`buildSpicePanel`) — the tab's rows:
  On/Off, **Settle gap** (%, 0.1–10, empty → 1), a **TTL | CMOS** strip, and
  per family its source line (the cited sheet), **Reset to defaults**
  (disabled with nothing to reset) and a shut **Advanced** disclosure with the
  eight numbers (`SPICE_FIELDS`: delay, source/sink, IIH/IIL, ICC, VIL/VIH),
  each with its unit beside it.
- The panel edits its own normalized copy and emits the WHOLE `spiceLite`
  object; a value typed back to its default is dropped from the overrides.
  Fields apply on change/Enter, read either decimal mark, and mark a value
  that will not read (non-positive, junk, VIL ≥ VIH) `aria-invalid` without
  storing it — the combobox's rule.
- **Visibility**: `familiesShown(logicFamily, projectFamilies)` — the tray's
  own rule. `SettingsDialog.open` takes `projectFamilies` (app.js passes
  `palette.projectFamilies`, a new getter), kept across a language rebuild;
  the Data Sheets chip-family picker re-filters the strip live
  (`setFamilyMode`).
- `normalizeSpiceConfig` now keeps only `FAMILY_DEFAULTS`' keys holding a
  positive finite number.
- Strings in all seven locales (`settings.spice.*`); styles at the end of
  app.css (`.spice-*`), tokens only. The panel stays short with Advanced shut;
  open, it scrolls inside `.settings-panels` like Serial I/O.

## 8⁹⁄₁₀. Phase 4 as built

- **No doc schema bump.** `currentLimit` is a PSU PARAM, coerced by the def's
  `normalizeParams` and omitted at the 1 A default — the same footing as every
  part param added since v7 (a pot's position, an inductor's style), none of
  which bumped the version. A bump would have meant regenerating every
  shipped demo for a field that is absent from all of them. (§6 said v14 → v15;
  that was wrong.)
- `catalog/parts.js` — `PSU_CURRENT_LIMITS` (100 mA … 5 A), the Properties
  select (the dialog's `"select"` now honours a field `default` when the
  param is absent).
- `engine.js` — `CHIP_STATUS.OVERLOADED` (`params.overloaded`, beside
  `damaged` in `powerStatus`, an `overloaded` warning) and the `psuVolts`
  hook. `catalog/index.js` keeps the latch; `desk-doc.js` `loadParams` drops it.
- `sim/spice/loads.js` — INPUT loads only, as §4.5 states (I_IH while HIGH,
  I_IL while LOW, against the drivers' source/sink): `brownout` past 1×,
  `smoke` and OVERLOADED from `OVERLOAD_RATIO` (2). An LED on an output is
  supply demand, not fan-out — so a 74LS output lighting an LED through a
  resistor (source budget 0.4 mA) is not smoked.
- `sim/spice/supply.js` — demand at the SET voltage: ICC of every chip on the
  - net (powered or not, so droop cannot flicker chips), and every resistor's
    current booked to the supply behind its high end, with LEDs (`FORWARD_VOLTS`
    by colour) and diodes setting the voltage of the net beside them and
    blocking backwards. Droop V = Vset · Ilimit / Idemand.
- `sim/spice/engine.js` — measures after the event loop, carries the
  delivered voltage in `analog.supplies`, and settles ONCE more when it moved,
  so the chip it drops out of range is underpowered on the same tick.
- UI: brown smoke is the burn overlay in `--color-part-smoke-brown` (chip,
  schematic node, hover hint `properties.warning.overloaded`), toasts
  `sim.brownout` / `sim.brownSmoke`; the PSU brick's readout
  (`psu-view.js` `setSupply`/`supplyReadout`, amber at the limit), written
  only when its text changes; `supplies` rides `chiphippo:sim-state`.
- Moved again, honestly: an inductor's LR ramp (it is a WIRE in the netlist;
  its ramp only shapes an instantaneous current, which is Phase 6's
  decoupling question) and a CD4000 output's currents at supplies other than
  5 V. A chip output's VOH is still its supply.
- Tests: `spice-current.test.js` (budget, brownout, brown smoke, the latch on
  the digital engine, droop to underpowered, a slight droop, LED current both
  ways round, the param, the readout); `desk-doc.test.js` (the latch never
  loads); `sim-controller.test.js` (persist, toast, `supplies`, Stop clears).

## 8⁹⁹⁄₁₀₀. Phase 5 as built

- `sim/spice/sag.js` — `WIRE_OHMS_PER_M` 0.0842 (24 AWG copper, 20 °C),
  `wireOhms` (× `wireCutMm`: the run plus both stripped ends), and
  `supplySag(doc, draws)`: the wiring as a graph (board node / brick terminal
  vertices, wire edges), each draw routed along its LOWEST-RESISTANCE path
  (Dijkstra) from `<psu>.+` to where it enters and from where it returns to
  `<psu>.-`, currents summed per wire, a chip's drop = Σ I·R over its two
  paths. Gives up: parallel-path splitting (overstated there), contact and
  strip resistance, paths through anything but a wire, the drop's feedback.
- `sim/spice/supply.js` — now `measureSupplies` → `{supplies, draws}`
  (`supplyState` kept as its supplies): a chip's ICC enters at its VCC pin
  and returns at its ground pin; a resistor's current enters at its own lead
  on a + rail or at the VCC pin of the chip driving its high end, and returns
  at its lead on a − rail or the LED/diode cathode leading there; a limited
  supply's draws are scaled to what it delivers.
- `engine.js` — the `chipDrop` hook takes a chip's drop off the supply it sees
  (so `chipStatus.volts`, every sentence quoting it and the underpowered check
  all see the sagged voltage). `spice/engine.js` carries `analog.drops`,
  re-settles when one moved, and reports `sag` (chip → `{drop, volts}`).
  **A drop under 1 mV is not applied** — a bench meter would not show it, and
  it keeps ordinary desks (every shipped example) exactly on the digital
  engine's figures.
- **Q5 still open, and it matters here**: at 84 mΩ/m the drops are honest but
  small — the test chain needs 2.5 A to sag ~10 mV. A per-contact term (real
  breadboard springs are tens of mΩ each) would make sag visible on ordinary
  desks; it is one constant to add if you want it.
- Not published on `chiphippo:sim-state` (nothing draws it yet — the
  rendering work); the sagged voltage reaches the user through the
  underpowered hint and the Properties warning, which quote `chipStatus.volts`.
- Tests: `spice-sag.test.js` (the constant, the daisy chain's exact I·R at
  both chips and in `chipStatus`, the 1 mV floor, routing and an unwired
  draw); `parts-catalog.test.js` updated for the PSU's new field.

## 8⁹⁹⁹⁄₁₀₀₀. Phase 6 as built

- **The spike is DERIVED, not invented**: an output that switches charges
  the load its datasheet is timed into — `loadPf`, SN74LS00 §6.9 CL = 15 pF
  (RL 2 kΩ), CD4001B dynamic characteristics CL = 50 pF — so its spike is
  CL·V over the part's own delay, for the ONE pass it switches in: 7.5 mA a
  74LS output at 5 V, 2 mA a CD4000 one. That is a floor (it leaves out
  shoot-through), and `loadPf` is a new Advanced field ("Switching load
  (CL)", pF) the user can raise.
- `spice/engine.js` — the `outputs` hook (inertial hold now its own
  `holdOutputs`) compares what each chip DRIVES with what it drove the pass
  before (carried in `analog.driven`, so a tick's first pass compares with the
  last tick's), counts H↔L flips, and books `flips × spike` to the chip's
  supply for that pass; `pass` folds each pass into a per-supply PEAK. Each
  supply reports `peak` = its delivered current + the worst pass's spikes.
- **Decoupling** = a capacitor from the chip's own VCC net straight to a −
  rail (`rcTrace`). A decoupled chip's spikes never reach the supply (the
  capacitor supplies them); its recharge tail is not modelled (with a 100 nF
  cap and a few mA for a nanosecond it is nothing a 100 Hz desk could show).
  A timing capacitor always has a lead on a signal net, so it never counts —
  tested.
- **Q4, decided by default: WARN, don't glitch.** A peak past the limit is a
  `supply-spike` warning naming the supply, the peak and the limit, with the
  fix (a 100 nF capacitor across the rails by the chips); the logic is
  untouched. Glitching it is a few lines (fail the chips' power for the pass)
  if you want it.
- Power-up is itself a spike: the first tick, every output finding its level.
- Strings: `sim.supplySpike*`, `settings.spice.field.loadPf`, seven locales.
- Tests: `spice-decoupling.test.js` (the derivation, six outputs tripping an
  undecoupled 100 mA supply, the same circuit decoupled, a timing capacitor
  not counting, the digital engine untouched).

## Phase 7 as built

- User guide page `src/web/docs/spice-lite.md` (in `PAGES` after Running a
  Simulation), linked from the overview, Running a Simulation, Power & Clock
  Sources (the PSU's Current limit) and Settings (a Spice Lite section in tab
  order). `make docs` regenerated `website/docs/`. The PDF was NOT rebuilt:
  built here (Linux, under xvfb) it sets in Inter where the committed one,
  built on macOS, sets in SF — `make pdf` on the Mac picks the page up.
- `CLAUDE.md`: Status, source layout, the "no analog solver" rule scoped to
  the DIGITAL engine, `spiceLite` under Settings, and a "Spice Lite — the
  second engine" section. ROADMAP row. This plan moved to `features/done/`.
- `make demos`: nothing to do — the demo pipeline imports `engine.js`
  directly, so every example validates on the digital engine as before (and
  the parity suite holds all but the 555's two to Spice Lite too).

## Review fixes (after Phase 7)

A review of the finished engine found ten problems; all ten are fixed, each
with a test.

1. **Schmitt inputs had one threshold.** An RC relaxation oscillator round a
   74LS14 / CD40106B turned straight back and was reported as oscillating.
   `def.schmitt: {upV, downV}` (VT+/VT− at 5 V, CMOS scaled by supply) on the
   '14, the 40106 and the 4093; `inputThresholds` returns `{vil, vih, up,
down}` and a reading rises through `up`, falls through `down`
   (spice-engine: the oscillator's period, and the '04 version still an
   oscillation).
2. **A chip's wire drop read as a different supply** — `mixed-supply` between
   two chips on one PSU that sag by different amounts. The drop now reaches
   the power check only; `supplyVolts` (the boundary warnings') is the rail's
   (spice-sag).
3. **A capacitor forgot its charge** when its node merged into a rail and came
   back (a switch released): it restarted empty. Each capacitor's
   V(pin 1) − V(pin 2) is carried in `analog.caps`, and a new node starts from
   it, parallel capacitors sharing (spice-engine).
4. **Buffers and bus drivers were held to their family's budget** — a CD4050B
   driving five 74LS inputs let out brown smoke. `def.drive` (the 74LS bus
   drivers' 24 mA, the '595's weaker QH′, the CD4049UB/CD4050B's 3.3 mA) and
   `outputDrive` (spice-current).
5. **Brown smoke rode a copy or paste.** `catalog/run-latches.js` is the one
   list of run latches; the design clip, paste cluster, duplicate and load
   path all strip both (design-clip, paste-cluster, run-latches).
6. **The oscillator cans and LCD modules dropped `overloaded`** in their
   normalizers, so the latch never held; and the discrete view had no brown
   smoke. Both keep it now (parts-catalog).
7. **A late tick counted its catch-up against the oscillation cap**, so a
   slow oscillator behind a throttled timer was reported as oscillating.
   Catch-up has its own budget (`MAX_CATCHUP_EVENTS`, then a jump to `now`),
   flips count only at the tick's own moment, and after a real oscillation the
   next tick does not replay (spice-engine).
8. **Topology was re-derived every tick** (the supply's walk of every part's
   pins, the wiring graph and its Dijkstra paths). `supplyTopology`,
   `sagTopology` and `capacitorNets` are cached per NETLIST (spice-current,
   spice-sag, spice-engine).
9. **A capacitor with a lead to nowhere** counted in τ. A capacitor joins a
   node only when its far net reaches a rail or anything at all
   (spice-engine).
10. **Two near-duplicate listener loops** (family and family-less chips) are
    one.

## Review fixes, round 2

A second review — the engine, the supply model, the UI wiring, the latches
and the docs — found these; all are fixed, each with a test where it can
have one.

Engine (spice/engine.js):

1. **A node read every HIGH as the desk's highest supply** — a 5 V 74LS output
   charged an RC to 12 V and flipped a 12 V CMOS gate. A driven HIGH is now
   its driving chip's supply (`highOf`).
2. **A timed part owned every capacitor net on any of its pins**, so a
   power-on RC on a 555's RESET did nothing. It owns its `timing`-role pins'
   capacitors only (the CD4060B's/CD4541B's networks hang on clock pins that
   DRIVE them, so nothing changes there).
3. **The droop re-settle never re-read the nodes**, so a node a newly
   underpowered chip stopped driving kept charging (and asked for frames)
   until the next tick. It re-reads them, and settles again while that
   changes a reading (`RESETTLE_ROUNDS`).
4. **The settles inside one tick read stale memory**: a RAM write in one was
   invisible to the next. Each settle reads the images with the earlier
   settles' writes to a volatile chip applied.
5. **An edited gate delay could make a tick take minutes** (hold ratio
   unbounded). `MAX_HOLD` caps it.
6. **`ls-fanout` contradicted the budget** (two 74LS inputs on a CD4000:
   "fine" and "a fault" at once). The budget replaces it under Spice Lite.

Supply and loads (spice/supply.js, spice/loads.js):

7. **A ≤ 5 V CD4000 output added no load to its supply** — demand read
   `strongLevels`, which the LED rule strips of limited outputs. Demand and
   drivers now come from what each chip DROVE (`driven`).
8. **A supply its own chip's load pulled down flickered every tick**
   (underpowered → load gone → recovered → …). An underpowered chip keeps the
   outputs it last drove for the supply's reading, so the droop holds.
9. **`io` pins were never drivers** (the '245's 24 mA unused; memory data),
   and **a tri-state output switched off counted** toward its net's budget.
   Both follow from `driven`.
10. **High-side switched current was dropped** (a PNP, a P-MOSFET, a CD4066 to
    +). A channel ON to a rail now sources (or sinks) its far net, entering at
    the channel's rail terminal.
11. **Sunk current never returned through the sinking chip's GND pin**, and
    **current was booked to whichever chip came first on a net**, driving or
    not. Both follow from `driven`.
12. **Family-less inputs loaded a net as 74LS ones** (memories and CPUs are
    MOS). They draw `MOS_INPUT_UA`.
13. **The '595's QH′ sink was the SN54LS595's 8 mA**; the SN74LS595's
    recommended operating conditions give 16 mA (IOH −1 mA was right).
14. **A stored VIL ≥ VIH** passed `normalizeSpiceConfig`, and an emptied panel
    field skipped the band check. Both refuse it now.

UI and docs:

15. **The numbers applied mid-run** (only the toggle waited for Run): editing a
    budget could brown-smoke a chip. The whole setting is snapshotted at Run
    (`#runConfig`).
16. **The desk review called brown smoke 12 V damage** (no `overloaded` case).
17. **Settings could throw before the tray existed** (`palette?.` read a
    `const` in its temporal dead zone). A getter answers until the tray is
    built.
18. **A brownout that became brown smoke stayed amber** (a re-notified toast
    kept its colour), and two outputs of one chip raced for the wording. The
    toast's colour follows its variant; one warning per chip, its worst.
19. **The supply-spike toast named the PSU "psu (psu1)"** — now "Power supply
    (psu1)". **Its limited readout used the light theme's dark amber** on the
    dark brick — now `--color-psu-limited`. **The PSU loop copied the
    component list again every tick** — folded into the clock loop.
20. **Docs**: "over twice" → "twice or more" (the code is `>=`) in the guide
    and every locale; only the delay and thresholds scale with a CMOS supply;
    decoupling is per rail, any value; coupling through a capacitor is not
    modelled; the Spice Lite section on Running a Simulation sat below the
    page's closing rule.

## 9. Phases and proof

| #   | ships                                                                                                      | proof                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | seam, setting (no UI yet beyond the toggle), inert `spice` engine                                          | full suite green + `engine-parity.test.js`                                                                                                                                          |
| 2   | quantum/inertial delay, analog nodes, crossings, timers on curves, `nodeVolts` on the probe                | RC fixture charges and fires once; 3-inverter ring still `oscillation`; 555/4047/4060/4098/4528/4538/4541 timings equal today's; parity still holds for RC-free single-family desks |
| 3   | Settings tab                                                                                               | settings-dialog tests, i18n guards, type-scale                                                                                                                                      |
| 4   | fan-out, brown smoke, PSU limit/droop/readout, v15 migration                                               | fixtures: 11 LS loads on one LS output → brownout; 25 → overloaded, Stop clears; 1 A limit droops → underpowered                                                                    |
| 5   | wire resistance, decoupling                                                                                | daisy-chain fixture sags; cap vs. no-cap spike fixture                                                                                                                              |
| 6   | user-guide page, CLAUDE.md ("no analog solver" kept true of the DIGITAL engine), export byte-identity test | `make fmt && make lint && make test`                                                                                                                                                |

## 10. Defaults (to be verified against the sheets in Phase 3, cited in code)

|                   | 74LS (SN74LS00, SDLS025)                 | CD4000 (CD4001B, SCHS015)                           |
| ----------------- | ---------------------------------------- | --------------------------------------------------- |
| sink / source     | 8 mA / 0.4 mA                            | ~0.51 mA min, ~1 mA typ each, at 5 V (VO 0.4/4.6 V) |
| I_IH / I_IL       | 20 µA / 400 µA                           | ±0.1 µA (input leakage max) — effectively 0         |
| VIL / VIH         | 0.8 / 2.0 V                              | 0.3·VDD / 0.7·VDD (1.5 / 3.5 V at 5 V)              |
| ICC (per package) | ~1.6 mA (mean of ICCH 0.8, ICCL 2.4 typ) | quiescent µA, i.e. effectively 0                    |
| tpd               | 10 ns                                    | **see Q1**                                          |

These are from memory of those sheets. I'll re-read the actual tables before
writing them down, and I won't invent a value I can't find.

## 11. Questions for you

1. **CD4000 delay operating point.** Your table says ~60 ns (that's the 10 V
   figure). At 5 V, which most desks run, CD4001B is ~125 ns typ. Options:
   60 ns as written; 125 ns at 5 V; or scale with the chip's real supply from
   the sheet's 5/10/15 V points (my preference, since the supply is known per
   chip, but then the Advanced field becomes "delay at 5 V").
2. **Input threshold model.** Is one trigger point per listener (default
   VIL/VIH midpoint) with crossing re-arm OK? The alternative reads X between
   VIL and VIH, which is truer for non-Schmitt inputs but floods mid-charge
   nets with X.
3. Brown-smoke trip at **2×** the budget?
4. Should a decoupling-less spike that trips the PSU **glitch logic**, or only
   warn?
5. Wire-only resistance (as written) or add a per-contact term (§7)?
6. Settings **app-wide** (my default), as flagged in the spec?

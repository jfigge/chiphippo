# Chip Hippo — Multimeter (Phase 1)

## Goal
Add a **digital multimeter** to Chip Hippo as a teaching tool: a user probes a running
circuit and sees why wrong wiring misbehaves (floating pins, sagging rails, brownouts,
shorts). It **emulates a real meter, the Brymen BM235**, rather than an ideal one. It has
its dial, its jacks, its input impedance and its fuses, and it fails the way that meter
fails when it is used wrongly. Implement **Phase 1 only**. Phase 2 is listed so the design
leaves room for it. Do not build it.

The behaviour comes from the BM231/233/235 user's manual (Brymen P/N 7M1C-1501-0000;
welectron.com hosts a copy, `Brymen_BM230_Manual.pdf`). Where the manual is silent, it
comes from one unit measured at lygte-info.dk ("DMM Brymen BM235"). Cite both in the code
comments. Any figure from neither source is marked **(assumption)** below; say so in the
code too, the way Spice Lite does.

**No brand on the drawing.** The part is "Multimeter" (ref `meter`). It uses the BM235's
layout and behaviour, but no Brymen name, logo or model number appears on it.

## Before you write code
1. Read the rule files the meter touches. Their globs will not load them for you:
   - `.claude/rules/signals.md`: signal flags, the nearest single-point drag.
   - `.claude/rules/desk-editing.md`: the press rule, Option/Alt pin mode, single-point
     drags, what happens while running.
   - `.claude/rules/bench-parts.md`: the electronic load. It is the precedent for a
     `spiceOnly` bench instrument brick with its own `kind`, left out of the exports.
   - `.claude/rules/spice-lite.md` and `.claude/rules/spice-ac.md`: `nodeVolts`,
     `currents`, the AC adapter's isolated source, `sim/floating-grounds.js`.
   - `.claude/rules/simulation.md`: SimController, the Worker hand-over, `LampAverage`
     (the per-tick time-weighted booking this meter copies), run latches.
   - `.claude/rules/ui-chrome.md`: the Properties dialog, which is data-driven from the
     catalog.
   - `.claude/rules/i18n.md`.
2. Read the existing **Probe tool** (`components/probe-inspector.js`). It already shows a
   hole's volts and current under Spice Lite. The meter must agree with it.
3. Summarise your plan in a few bullets, then proceed. Ask only where something below
   conflicts with the code, and ask in plain text.

## Scope rules
- **Spice Lite only** for readings. The part is `spiceOnly`: the tray hides it while Spice
  Lite is off, as it hides the load and the speaker. A meter already on the desk under the
  logic engine shows a blank display with the red (i) (`buildInfoMark({variant:
  "danger"})`), explaining that it reads only under Spice Lite. Its current shunts still
  **conduct** there, as bridges, so the circuit it is in still runs.
- **The meter is NOT ideal.** Whatever the dial selects, it is an element between its two
  probes (table below), solved with the rest of the circuit. Loading, burden voltage and
  blown fuses therefore fall out of the solve, not out of special cases.
- **The meter is not part of the build.** It joins only the CONDUCTING netlist, never the
  WIRING one. The schematic, the build guide, the BOM, the wiring list, the AI builder's
  card and the AI desk review all leave it out. KiCad and Digital leave it out with a
  report reason, as the load is (`KICAD_LEFT_OUT`, `benchInstrument`). When a meter in a
  current function is closing a gap, the report names the two nets it joined, because the
  exported build has that gap open.
- Mark anything limited with the app's red (i). There is no asterisk/eye convention.
- No new dependencies.

## Phase 1 — Features

### The part
- A desk brick of its own `kind` (like the load), under **COMPONENTS ▸ Meters**, a new
  group appended to `COMPONENT_ORDER`.
- **True scale**: the BM235 is 161 × 80 mm in its holster, so 31.5 × 63.4 pitch,
  portrait. Its display, at ~6 pitch per digit, is readable at normal zoom.
- Any number of meters may share a desk (a bench often has one on volts and one on amps).

### Dial (rotary selector) — positions in order
Order as the lygte-info.dk review lists it (check it against a photo):
**AutoV LoZ · OFF · V · Ω · mV · diode · mA A · µA**. Turn the dial by clicking a
position's legend. **SELECT** cycles each position's sub-functions, and each position
remembers its last one. That memory is stored in `params`, as the manual's "last
selection will be saved as power up default" says.

| Position | SELECT cycles | Red lead jack | Phase 1 |
|---|---|---|---|
| AutoV LoZ | — (picks DC or AC itself) | VΩ | yes |
| OFF | — | — | yes (blank) |
| V | AC ↔ DC (VFD left out) | VΩ | yes |
| Ω | Ω ↔ continuity | VΩ | yes |
| mV | DC ↔ AC (temperature left out) | VΩ | yes |
| diode | diode (capacitance in Phase 2) | VΩ | yes |
| mA A | DC ↔ AC | µA mA → mA ranges; 10A → A ranges | yes |
| µA | DC ↔ AC | µA mA | yes |

**Jacks**: `10A`, `µA mA`, `COM`, `VΩ`. The black lead is always in COM. The red lead's
plug is dragged between the three other jacks. That drag is a single-point drag onto the
jack targets, under the same rules as every other point drag.

**Buttons in Phase 1**:
- SELECT: press.
- RANGE: a press goes to manual ranging, and the next press steps to the next range; a
  1 s hold returns to auto. Not in AutoV.
- HOLD: a press freezes the display.
- Turning the dial cancels manual ranging and HOLD, as on the real meter.
- Every other button is Phase 2.

### What sits between the probes (the electrical model)

| Dial / red lead | Spice Lite element, red ↔ black | Logic engine |
|---|---|---|
| Red in **10A**, any dial position | **0.04 Ω** (0.04 V/A burden), fuse F2 11 A. Hard-wired: the A shunt is in circuit whatever the dial says (assumption, as on practically every DMM) | bridge |
| V, mV | **10 MΩ** | open |
| AutoV | **2.1 kΩ** (LoZ) up to 50 V. Above 50 V, per the manual: 12 kΩ @ 100 V, 100 kΩ @ 300 V, 240 kΩ @ 600 V, interpolated (the review measured something different; follow the manual) | open |
| Ω, continuity | a **floating 1.6 V source behind 8 kΩ** (8 kΩ assumed from the manual's 0.2 µA into 8 MΩ on the 6 MΩ range scaled down, and the measured 0.16 mA short-circuit current) | open |
| diode | a **floating 3.2 V source behind 9.7 kΩ** (3.2 V ÷ 0.33 mA measured short-circuit current; 0.27 mA at 0.6 V, against the manual's 0.3 mA typical) | open |
| µA, red in µA mA | **100 Ω** (0.1 mV/µA), fuse F1 0.4 A | bridge |
| mA A, red in µA mA | **1.9 Ω** (1.9 mV/mA), fuse F1 0.4 A | bridge |
| any other dial with red in µA mA | open (assumption) + **InEr** | open |
| a current position with red in VΩ | open (reads 0) | open |
| OFF, red in VΩ | open | open |

- The test sources are FLOATING, so the meter is battery-powered. Reuse the AC adapter's
  isolated-source machinery, not a ground-referenced supply.
- A single 8 kΩ reference serves every Ω range. For a linear network the reading is the
  equivalent resistance whatever the reference. Only a nonlinear part reading above 6 kΩ
  differs from the real meter's higher-range test currents, and that is flagged.
- **A probe move, a dial turn or a jack change is a topology edit.** It goes through the
  edit path a slide-switch flip takes (`doc-changed`/`part-state`, `#runOnTo`), and the
  caches are invalidated the way an edit invalidates them, never patched.

### Reading and display
- **Sampling** happens in SimController, so in the Worker. Each tick, each meter books its
  quantity time-weighted: the probes' voltage difference, or the current through its
  shunt. Copy `sim/lamp-average.js`. Use the analyzer's between-tick curve samples where
  Spice Lite has them.
  - DC = the mean.
  - AC = the true RMS of (x − mean), AC-coupled (assumption).
  - AutoV shows DC or AC, whichever is larger in peak magnitude.
  
  Book min and max as well, which Phase 2's REC needs. Every **200 ms of wall time** (the
  manual's 5 updates/s), each meter's raw SI reading rides `sim-state`. The accumulators
  ride `exportRun`/`importRun`, as `LampAverage` does.
- **Formatting is a pure module** (`model/meter-display.js`, with tests): function →
  range → 6000 counts (3⅚ digits, 5999 max) → digits and legends.
  - Auto-range goes up past 5999 counts and down below 500 counts (assumption; it cannot
    hunt, since 500 < 600).
  - **OL** shows beyond the top range, or when a resistance computes negative or past
    60 MΩ.
  - **- - - -** shows in AutoV below its 1 V threshold.
  - Minus sign; annunciators AUTO, HOLD, AC/DC, LoZ, the continuity and diode symbols, the
    units.
- **Ranges** (manual):

  | Function | Ranges |
  |---|---|
  | DCV/ACV | 6.000 · 60.00 · 600.0 · 1000 V |
  | mV | 60.00 · 600.0 mV (OL past 600.0 mV; no up-range into V) |
  | AutoV | 600.0 · 1000 V |
  | Ω | 600.0 Ω · 6.000 k · 60.00 k · 600.0 k · 6.000 M · 60.00 MΩ |
  | Diode | 3.000 V, OL above |
  | µA | 600.0 · 6000 µA |
  | mA | 60.00 · 600.0 mA |
  | A | 6.000 · 10.00 A |
- **Continuity (BeepLit)** reads on the 600.0 Ω range. It beeps, and flashes the display's
  backlight, below **161 Ω**: the measured unit's figure, inside the manual's "between 30
  and 480 Ω" band. Response is within 15 ms. The threshold is fixed, because the real
  meter's is. The flash always shows; the sound is off by default (a Properties field) and
  plays through the speaker's Web Audio path.
- **Beep-Jack**: with the red lead in µA mA or 10A and the dial not on a current
  position, the display shows **InEr** and beeps. The A shunt is still live, which is the
  trap it warns about: measuring a supply's "volts" with the lead in 10A shorts it.
- **Readings are exact.** The ±(0.3 % + 2 d) accuracy is not modelled.
- **Transport**:
  - **Stopped is the bench switched off.** V, mV and A read 0, and AutoV reads - - - -.
    Ω, continuity and diode read from one Spice Lite settle of the desk with every source
    removed (PSUs, mains, adapters, clocks, signals, integrations) and the meter's own
    test source as the only one. It is recomputed after edits without blocking the UI.
  - **Running**: Ω, continuity and diode stay in the live solve, so on a powered circuit
    they give the false readings a real meter gives. The red (i) beside the display says
    so, quoting the manual's caution ("using resistance and continuity function in a live
    circuit will produce false results and may damage the instrument").
  - **Paused** freezes the display. **Step** updates it from the step's span.

### Fuses
- F1 0.4 A (the µA mA input) and F2 11 A (10A). A fuse blows when |I| exceeds its rating
  for 10 ms of simulated time, or at once past 10× its rating (assumption; both are fast
  "F" fuses).
- A blown fuse **opens** its shunt, so the meter reads 0 and the circuit it was in goes
  dead, as on the bench. It raises a danger toast keyed `meter:<id>:<fuse>`, and the body
  shows the red (i) ("F1 (0.4 A) blown — the µA mA input is open until Stop").
- The blown fuse is a **run latch** (`catalog/run-latches.js`): kept by every normalizer,
  cleared at Stop like chip damage, never saved.
- Under the logic engine nothing blows; a shunt across a supply is the logic engine's
  ordinary `short`.

### Probes and leads
- **Two probes, red and black**, each on a drawn **lead**: a sagging cable from its jack
  to the probe (the wire sag in `desk/wire-path.js`). Leads draw above wires and parts and
  are pointer-inert; only the probe body and the plug take a press.
- **A probe goes on ANY hole, free or occupied, or on a brick terminal** (`psu1.+`,
  `clk1.out`). It is a probe tip touching a lead, not a lead itself. So it claims nothing
  in occupancy, `normalizeDocument` never drops one for sharing a hole, and both probes
  may share one hole (which reads 0).
- The drag follows the single-point rule: `nearestLegalPoint`, accepting every real point,
  with the shared ring on the target and the drop on the target the last move showed.
  Released over bare desk, the probe **lies on the desk where it was dropped**, unplugged.
  A new meter arrives with both probes lying beside it.
- **Hit priority**: a probe is the top-most target at its tip. An **Option/Alt** press
  there goes THROUGH to the lead beneath it (pin mode), so a lead under a probe can still
  be moved.
- A planted probe rides its board's moves for free (it is an address). When its board is
  deleted, it unplugs where its hole was. Unplugged probes ride a drag of the meter body;
  planted ones stay put and their leads stretch. Probes are never in the selection.
  Deleting the meter takes them; a pasted meter's probes arrive unplugged.
- **Mid-run**: probe drags, plug moves, dial turns and buttons all work while running.
  This is a deliberate exception to "a drag that spans Run reverts", as the analyzer's
  channels already are. State the exception in the code and in `desk-editing.md`. Probe,
  plug and dial changes are undo steps by the analyzer-channel precedent. HOLD, RANGE and
  the fuse latches are run-volatile and never undo steps.

### Properties
The standard data-driven Properties dialog: Name, Description, then **Sound** (default
off). The function lives on the dial and the continuity threshold is fixed, so neither is
a field. The catalog `description` teaches the meter: series current, jacks and InEr,
loading, fuses.

### Persistence and export
- The meter's position, dial, sub-functions, plug jack and probe positions save with the
  project. On load, a probe address that is not a real point becomes an unplugged probe at
  its saved desk position. Say what an older Chip Hippo does with a project holding a
  meter.
- KiCad and Digital: left out with a report reason, plus the gap line above. Projects
  without meters, and every example, are unchanged byte for byte.
- One example desktop from the tray's example button. It should show:
  - 5 V across a 10 k/10 k and a 1 M/1 M divider;
  - a 330 Ω + red LED with the meter in series on mA.

## Acceptance checklist
The figures come from the table above, computed for nominal values. Assert each one in an
engine fixture under Spice Lite.
- [ ] 5 V rail, V/DC: **5.000 V** on the 6 V range, agreeing with the Probe tool's
      readout at the red probe's hole.
- [ ] 10 k/10 k divider off 5 V: **2.499 V** (2.49875 with the 10 MΩ load). 1 M/1 M:
      **2.381 V**, not 2.500. The Probe tool shows the same loaded value, since it reads
      the same solve.
- [ ] AutoV on the 10 k/10 k divider: **- - - -** (LoZ drags it to 0.739 V, under the
      1 V threshold). AutoV on the rail: **5.0 V** on the 600.0 V range.
- [ ] A floating net, V/DC: **0.000** (the 10 MΩ ties it to the black probe). Note it in
      the guide: a meter says 0 V where a TTL input reads HIGH.
- [ ] A sagging rail (PSU on its current limit) reads its sagged volts.
- [ ] Mains/adapter, V/AC: the RMS of the sine, on the 600.0 V or 60.00 V range.
- [ ] Ω, stopped, on a lone 1 kΩ: **1.000 kΩ**. Open gap: **OL**. A silicon diode reads
      a few kΩ forward and OL reversed. Diode test: ~0.6 V on a 1N4148, ~1.8 V on a red
      LED, OL reversed.
- [ ] Ω while running across a powered rail: a false reading or OL, with the
      live-circuit (i).
- [ ] Continuity: a wire and a 100 Ω beep and flash; 220 Ω and an open gap do not.
- [ ] mA in series with 330 Ω + red LED: ~**9.3 mA**, matching the Probe tool's lead
      current within the 1.9 Ω burden (~18 mV). Probes on one unbroken net read **0**.
- [ ] mA straight across a 5 V PSU (1 A limit): demand 2.63 A, the PSU limits at 1 A, and
      **F1 blows**, with a toast; the reading goes to 0 and the meter opens. The 10A jack
      across it: **~1.000 A**, the PSU's limit, and F2 survives. µA across it:
      **OL** (50 mA into a 600 µA range), and F1 survives.
- [ ] InEr shows with the plug in µA mA or 10A while the dial is on V; with the plug in
      10A, touching the rails shorts them through the shunt.
- [ ] The logic engine: the tray hides the part; a placed meter shows blank with the
      (i); the shunts bridge so the circuit runs; nothing blows.
- [ ] Probes drag, snap and drop under the single-point rule onto free and occupied holes
      alike, including mid-run. Option goes through a probe to the lead beneath it.
- [ ] Save/load round-trips; a dangling probe address loads unplugged; KiCad/Digital
      report the meter and its gap.
- [ ] **Benchmark**:
  - `make bench` before and after, unchanged (it has no meter).
  - Add a meter variant to `scripts/bench/engine.bench.js`: two meters, one on V/DC
    across the busy fixture's clock net and one on mA in series with its supply. Report
    ms/tick in both settle modes and under Spice Lite, with and without the meters.
  - In the app at 1 kHz, report the busy fixture's achieved speed (the `RunMeter`) with
    and without the two meters.
  - Pass means within run-to-run noise; state what the noise is.
- [ ] Every string through `t()` in every locale, with `make test-i18n` passing; a
      user-guide page; `make test` (the full run) green.

## Phase 2 — built 2026-10-25
Jason's answers (2026-10-25): a stopped circuit runs in time while a meter's test source
drives it, and LEDs it lights are drawn (yes); capacitance is timed like the real meter's,
in-circuit errors and all (yes); Hz reads a capped oscillator's TRUE rate (yes); the
backlight toggle stays (yes). Deviation: Hz's sensitivities and lowest frequency follow
the measured unit (0.1 V RMS on 6 V, 2 Hz) — the manual's table is its guarantee, and a
5 V logic swing fails it on every range. See `.claude/rules/meter.md`.

- **Hz** button, using the manual's sensitivity table per range; **REC** MAX/MIN/AVG,
  with a beep on each new max or min; **Δ** relative, on a 1 s hold of HOLD; a backlight
  toggle on a 1 s hold of SELECT.
- **Capacitance** on the diode position (20.00 nF … 10.00 mF). It needs a charge-time
  measurement design, and so does Ω's charging ramp across a capacitor.
- The diode test lighting an LED faintly; the meter and its leads in the 3D view.
- **Never**: VFD, temperature (no thermocouple), EF/NCV, auto power-off, accuracy error.
- The logic analyzer (Feature 210) and an oscilloscope are not part of this work.
  Sampling stays meter-shaped and reuses the analyzer's per-tick path rather than
  inventing another.

## Output
When done, give a short summary: what was added, the benchmark numbers, every
**(assumption)** that made it into the code, and anything that deviated from this brief.
Keep it brief. Do not do an exhaustive review, and do not refactor unrelated code.
